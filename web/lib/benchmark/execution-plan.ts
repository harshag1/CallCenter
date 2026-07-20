import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  costEnvelopeMaximumMicroUsd,
  type BudgetCostEnvelope,
} from "./filesystem-budget-ledger";
import { BENCHMARK_CONDITION_IDS, type BenchmarkConditionId } from "./condition-compiler";
import type { ServerRealtimeProvider } from "../realtime/client/types";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0)[A-Za-z0-9._/@+-]+$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PLAN_DOMAIN = "hacc/benchmark-plan/v1\n";
const FREEZE_DOMAIN = "hacc/benchmark-freeze-lock/v1\n";
const PAIR_INVARIANTS_DOMAIN = "hacc/benchmark-pair-invariants/v1\n";
const RUNNER_CONFIG_DOMAIN = "hacc/benchmark-runner-config/v1\n";

/** Parsed plans are immutable trust inputs even when Zod infers mutable arrays. */
type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly unknown[]
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

const HashSchema = z.string().regex(SHA256);
const IdentifierSchema = z.string().min(1).max(256).regex(SAFE_ID);
const TimestampSchema = z.string().regex(TIMESTAMP).refine((value) => Number.isFinite(Date.parse(value)));
const RelativePathSchema = z.string().min(1).max(1024).regex(SAFE_RELATIVE_PATH);
const RegistryKeySchema = z.string().min(1).max(2048).regex(
  /^[^@\s#]+@[^#\s]+#sha256:[a-f0-9]{64}$/,
  "registry key must bind an encoded id, version, and SHA-256 content hash"
);
const MicroUsdSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const AttestationKeyIdSchema = z.string().min(1).max(256).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/,
  "kernel attestation key ID contains unsupported characters"
);

function canonicalEd25519PublicKey(input: unknown): Readonly<{
  pem: string;
  fingerprintSha256: string;
}> | null {
  if (typeof input !== "string" || !input.trim() || input.length > 64 * 1024 || input.includes("\0")) {
    return null;
  }
  try {
    const key = createPublicKey(input);
    if (key.asymmetricKeyType !== "ed25519") return null;
    const pem = key.export({ type: "spki", format: "pem" }).toString();
    if (pem !== input) return null;
    const der = key.export({ type: "spki", format: "der" });
    return Object.freeze({ pem, fingerprintSha256: sha256Hex(new Uint8Array(der)) });
  } catch {
    return null;
  }
}

const KernelAttestationPinSchema = z.object({
  algorithm: z.literal("ed25519"),
  key_id: AttestationKeyIdSchema,
  public_key_pem: z.string().min(1).max(64 * 1024),
  public_key_fingerprint_sha256: HashSchema,
}).strict().superRefine((pin, context) => {
  const publicKey = canonicalEd25519PublicKey(pin.public_key_pem);
  if (!publicKey) {
    context.addIssue({
      code: "custom",
      path: ["public_key_pem"],
      message: "kernel attestation public key must be canonical Ed25519 SPKI PEM",
    });
    return;
  }
  if (pin.public_key_fingerprint_sha256 !== publicKey.fingerprintSha256) {
    context.addIssue({
      code: "custom",
      path: ["public_key_fingerprint_sha256"],
      message: "kernel attestation public-key fingerprint mismatch",
    });
  }
});

const FrozenFileSchema = z.object({
  path: RelativePathSchema,
  sha256: HashSchema,
}).strict();

const ProviderPinSchema = z.object({
  provider: z.enum(["openai", "xai", "gemini"]),
  model: IdentifierSchema.refine((model) => !/(?:^|[-_.])latest$/i.test(model), "mutable latest aliases are forbidden"),
  voice: IdentifierSchema,
  adapter_sha256: HashSchema,
  session_settings_sha256: HashSchema,
  pricing_snapshot_sha256: HashSchema,
  pricing_formula_sha256: HashSchema,
  provider_hard_session_caps_sha256: HashSchema,
}).strict();

const RegistrationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("exploratory") }).strict(),
  z.object({
    status: z.literal("frozen"),
    freeze_tag: IdentifierSchema,
    freeze_tag_object_id: z.string().regex(GIT_OBJECT_ID),
    target_commit: z.string().regex(GIT_OBJECT_ID),
  }).strict(),
]);

export const BenchmarkFreezeLockSchema = z.object({
  schema_version: z.literal(1),
  protocol_id: IdentifierSchema,
  evidence_class: z.enum(["canary", "pilot", "confirmatory"]),
  created_at: TimestampSchema,
  source_commit: z.string().regex(GIT_OBJECT_ID),
  source_tree: z.string().regex(GIT_OBJECT_ID),
  dependency_lock_sha256: HashSchema,
  protocol_sha256: HashSchema,
  preregistration_sha256: HashSchema,
  condition_compiler_sha256: HashSchema,
  gateway_sha256: HashSchema,
  evaluator_sha256: HashSchema,
  artifact_schema_sha256: HashSchema,
  audio_delivery_profile_sha256: HashSchema,
  scenario_source_registry_sha256: HashSchema,
  fixture_manifest_sha256: HashSchema,
  caller_sequence_sha256: HashSchema,
  randomization_sha256: HashSchema,
  /** Freeze the final-state proof trust root before any paid execution plan exists. */
  kernel_attestation: KernelAttestationPinSchema,
  bundle: z.array(FrozenFileSchema).min(1).max(1024),
  provider_pins: z.array(ProviderPinSchema).min(1).max(16),
  registration: RegistrationSchema,
}).strict().superRefine((lock, context) => {
  if (lock.evidence_class === "confirmatory" && lock.registration.status !== "frozen") {
    context.addIssue({ code: "custom", path: ["registration"], message: "confirmatory freeze requires an annotated frozen registration" });
  }
  const paths = new Set<string>();
  for (const [index, file] of lock.bundle.entries()) {
    if (paths.has(file.path)) context.addIssue({ code: "custom", path: ["bundle", index, "path"], message: "duplicate frozen bundle path" });
    paths.add(file.path);
  }
  const cells = new Set<string>();
  for (const [index, pin] of lock.provider_pins.entries()) {
    const key = `${pin.provider}\0${pin.model}\0${pin.voice}`;
    if (cells.has(key)) context.addIssue({ code: "custom", path: ["provider_pins", index], message: "duplicate provider pin" });
    cells.add(key);
  }
});

export type BenchmarkFreezeLock = DeepReadonly<z.infer<typeof BenchmarkFreezeLockSchema>>;

const CostEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("hacc_provider_gate1_cost_envelope"),
  pricing_snapshot_sha256: HashSchema,
  provider_hard_session_caps_sha256: HashSchema,
  runner_config_sha256: HashSchema,
  formula_sha256: HashSchema,
  components: z.array(z.object({
    name: IdentifierSchema,
    upper_bound_micro_usd: MicroUsdSchema.min(1),
  }).strict()).min(1).max(128),
  safety_margin_micro_usd: MicroUsdSchema,
}).strict();

const TrialLimitsSchema = z.object({
  maxTurns: z.number().int().min(1).max(10_000),
  maxSessionMs: z.number().int().min(1).max(24 * 60 * 60 * 1_000),
  maxInputAudioBytes: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  maxOutputAudioBytes: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  maxToolCalls: z.number().int().min(0).max(100_000),
  sessionReadyTimeoutMs: z.number().int().min(1).max(5 * 60 * 1_000),
  responseTimeoutMs: z.number().int().min(1).max(30 * 60 * 1_000),
}).strict();

const AudioDeliverySchema = z.object({
  schemaVersion: z.literal(1),
  chunkMs: z.number().int().min(20).max(100),
  pace: z.literal("realtime"),
  profile_sha256: HashSchema,
}).strict();

export function benchmarkRunnerConfigSha256(input: Readonly<{
  limits: z.infer<typeof TrialLimitsSchema>;
  audio_delivery: z.infer<typeof AudioDeliverySchema>;
}>): string {
  return sha256Hex(`${RUNNER_CONFIG_DOMAIN}${canonicalJson({
    limits: TrialLimitsSchema.parse(input.limits),
    audio_delivery: AudioDeliverySchema.parse(input.audio_delivery),
  })}`);
}

const SessionContinuitySchema = z.object({
  schema_version: z.literal(1),
  /** Primary paired evidence never reconnects behind the harness's back. */
  application_reconnect: z.literal("disabled"),
  /** Provider-native replay/resumption is a separate exploratory factor. */
  provider_native_resumption: z.literal("disabled"),
}).strict();

const LongHorizonExecutionAuthorizationSchema = z.object({
  schema_version: z.literal(1),
  authorization_sha256: HashSchema,
  purpose: z.enum(["development", "confirmatory"]),
  scenario_id: IdentifierSchema,
  scenario_version: IdentifierSchema,
  execution_eligibility: z.enum(["development-provider-eligible", "confirmatory-provider-eligible"]),
  verified_audio_binding_sha256: HashSchema,
  sample_rate_hz: z.number().int().min(1).max(384_000),
  caller_audio_byte_length: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  caller_audio_duration_ms: z.number().finite().positive().max(24 * 60 * 60 * 1_000),
  minimum_response_ms_per_turn: z.number().int().positive().max(30 * 60 * 1_000),
  setup_and_teardown_reserve_ms: z.number().int().min(0).max(60 * 60 * 1_000),
  required_session_ms: z.number().int().positive().max(24 * 60 * 60 * 1_000),
  max_session_ms: z.number().int().positive().max(24 * 60 * 60 * 1_000),
  preregistration_sha256: HashSchema,
  condition_suite_sha256: HashSchema,
  runner_config_sha256: HashSchema,
}).strict();

export type BenchmarkPairInvariantSource = Readonly<{
  freeze_lock_sha256: string;
  source_commit: string;
  release_gate?: unknown;
  scenario: unknown;
  fixture: unknown;
  cell: Readonly<{
    pair_id: string;
    provider: string;
    model: string;
    voice: string;
  }>;
  limits: unknown;
  audio_delivery: unknown;
  session_continuity?: unknown;
  long_horizon_authorization?: unknown;
}>;

export function benchmarkPairInvariantsSha256(input: BenchmarkPairInvariantSource): string {
  return sha256Hex(`${PAIR_INVARIANTS_DOMAIN}${canonicalJson({
    schema_version: 1,
    freeze_lock_sha256: input.freeze_lock_sha256,
    source_commit: input.source_commit,
    release_gate: input.release_gate ?? null,
    scenario: input.scenario,
    fixture: input.fixture,
    pair_id: input.cell.pair_id,
    provider: input.cell.provider,
    model: input.cell.model,
    voice: input.cell.voice,
    limits: input.limits,
    audio_delivery: input.audio_delivery,
    // Keep the hashing primitive total for pre-schema callers: absent values
    // are represented as explicit JSON null and will then be rejected by the
    // required plan schema where appropriate. Never hash JavaScript undefined.
    session_continuity: input.session_continuity ?? null,
    long_horizon_authorization: input.long_horizon_authorization ?? null,
  })}`);
}

const PlanBodySchema = z.object({
  schema_version: z.literal(1),
  plan_id: IdentifierSchema,
  mode: z.enum(["offline", "canary", "pilot", "confirmatory"]),
  created_at: TimestampSchema,
  expires_at: TimestampSchema,
  freeze_lock_sha256: HashSchema,
  source_commit: z.string().regex(GIT_OBJECT_ID),
  release_gate: z.object({
    pre_canary_packet_sha256: HashSchema,
    provider_pricing_proof_sha256: HashSchema,
    provider_hard_session_caps_sha256: HashSchema,
    pricing_snapshot_sha256: HashSchema,
    pricing_formula_sha256: HashSchema,
    reservation_micro_usd: z.literal(5_000_000),
    conservative_liability_micro_usd: MicroUsdSchema.min(1).max(5_000_000),
  }).strict(),
  scenario: z.object({
    path: RelativePathSchema,
    id: IdentifierSchema,
    version: IdentifierSchema,
    canonical_sha256: HashSchema,
    registry_key: RegistryKeySchema,
    registry_entry_sha256: HashSchema,
    registry_catalog_sha256: HashSchema,
  }).strict(),
  fixture: z.object({
    manifest_sha256: HashSchema,
    caller_sequence_sha256: HashSchema,
    rendition: z.enum(["pcm16le_mono_16000", "pcm16le_mono_24000"]),
  }).strict(),
  cell: z.object({
    run_id: IdentifierSchema,
    reservation_id: IdentifierSchema,
    pair_id: IdentifierSchema,
    provider: z.enum(["openai", "xai", "gemini"]),
    model: IdentifierSchema.refine((model) => !/(?:^|[-_.])latest$/i.test(model), "mutable latest aliases are forbidden"),
    voice: IdentifierSchema,
    condition: z.enum(BENCHMARK_CONDITION_IDS),
  }).strict(),
  /** Derived from condition-independent fields and equal across paired arms. */
  pair_invariants_sha256: HashSchema,
  /** Shared preregistered study plan, not this cell-specific plan_sha256. */
  study_plan_sha256: HashSchema,
  condition_hash: HashSchema,
  prompt_hash: HashSchema,
  provider_tools_hash: HashSchema,
  /**
   * Self-contained trust root for the treatment-kernel final-state proof.
   * The private key is never placed in the plan; the paid command must present
   * the matching private key after this plan has been explicitly confirmed.
   */
  kernel_attestation: KernelAttestationPinSchema,
  session_continuity: SessionContinuitySchema,
  /** Null for non-long-horizon sources; otherwise derived from exact frozen PCM. */
  long_horizon_authorization: LongHorizonExecutionAuthorizationSchema.nullable(),
  limits: TrialLimitsSchema,
  audio_delivery: AudioDeliverySchema,
  cost_envelope: CostEnvelopeSchema,
  maximum_micro_usd: MicroUsdSchema.min(1),
  reservation_expires_at: TimestampSchema,
  ledger_id: IdentifierSchema,
  reservation_authority: z.object({
    /** Exact signed open head observed after the operator's explicit resume. */
    ledger_open_head_sha256: HashSchema,
    /** One-shot local consumption identity, independently persisted before reservation. */
    consumption_id: IdentifierSchema,
  }).strict(),
  output_root: RelativePathSchema,
  artifact_schema_sha256: HashSchema,
}).strict().superRefine((plan, context) => {
  if (Date.parse(plan.expires_at) <= Date.parse(plan.created_at)) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "plan expiry must be after creation" });
  }
  if (Date.parse(plan.reservation_expires_at) <= Date.parse(plan.created_at)) {
    context.addIssue({ code: "custom", path: ["reservation_expires_at"], message: "reservation expiry must be after plan creation" });
  }
  const maximum = costEnvelopeMaximumMicroUsd(plan.cost_envelope);
  if (maximum !== plan.maximum_micro_usd) {
    context.addIssue({ code: "custom", path: ["maximum_micro_usd"], message: "maximum does not equal the frozen cost envelope" });
  }
  if (
    plan.maximum_micro_usd !== plan.release_gate.reservation_micro_usd
    || plan.release_gate.conservative_liability_micro_usd
      > plan.release_gate.reservation_micro_usd
  ) {
    context.addIssue({
      code: "custom",
      path: ["release_gate", "reservation_micro_usd"],
      message: "paid plan maximum must equal the exact Gate 1 provider reservation",
    });
  }
  if (
    plan.cost_envelope.pricing_snapshot_sha256
      !== plan.release_gate.pricing_snapshot_sha256
    || plan.cost_envelope.formula_sha256
      !== plan.release_gate.pricing_formula_sha256
    || plan.cost_envelope.provider_hard_session_caps_sha256
      !== plan.release_gate.provider_hard_session_caps_sha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["release_gate"],
      message: "paid cost envelope differs from the Gate 1 provider pricing proof",
    });
  }
  if (plan.cost_envelope.runner_config_sha256 !== benchmarkRunnerConfigSha256(plan)) {
    context.addIssue({
      code: "custom",
      path: ["cost_envelope", "runner_config_sha256"],
      message: "paid cost envelope runner configuration hash differs from the exact plan limits and audio delivery",
    });
  }
  const expectedPairInvariants = benchmarkPairInvariantsSha256(plan);
  if (plan.pair_invariants_sha256 !== expectedPairInvariants) {
    context.addIssue({
      code: "custom",
      path: ["pair_invariants_sha256"],
      message: "pair invariants hash does not match the condition-independent execution inputs",
    });
  }
});

export const BenchmarkExecutionPlanSchema = PlanBodySchema.extend({
  plan_sha256: HashSchema,
}).strict();

export type BenchmarkExecutionPlanBody = DeepReadonly<z.infer<typeof PlanBodySchema>>;
export type BenchmarkExecutionPlan = DeepReadonly<z.infer<typeof BenchmarkExecutionPlanSchema>>;

export class BenchmarkPlanError extends Error {
  readonly code: "invalid_json" | "noncanonical" | "schema" | "hash_mismatch" | "freeze_mismatch" | "expired" | "ineligible";

  constructor(code: BenchmarkPlanError["code"], message: string) {
    super(message);
    this.name = "BenchmarkPlanError";
    this.code = code;
  }
}

function parseCanonicalObject(bytes: string | Uint8Array, label: string): unknown {
  const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r") || text.includes("\0")) {
    throw new BenchmarkPlanError("noncanonical", `${label} must be one canonical JSON object followed by one newline`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BenchmarkPlanError("invalid_json", `${label} is not valid JSON`);
  }
  if (`${canonicalJson(value)}\n` !== text) {
    throw new BenchmarkPlanError("noncanonical", `${label} contains duplicate keys, unstable ordering, or noncanonical JSON`);
  }
  return value;
}

export function benchmarkFreezeLockSha256(lock: BenchmarkFreezeLock): string {
  return sha256Hex(`${FREEZE_DOMAIN}${canonicalJson(BenchmarkFreezeLockSchema.parse(lock))}`);
}

export function parseCanonicalBenchmarkFreezeLock(bytes: string | Uint8Array): BenchmarkFreezeLock {
  const value = parseCanonicalObject(bytes, "benchmark freeze lock");
  const parsed = BenchmarkFreezeLockSchema.safeParse(value);
  if (!parsed.success) throw new BenchmarkPlanError("schema", `benchmark freeze lock failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return Object.freeze(parsed.data);
}

export function serializeBenchmarkFreezeLock(lock: BenchmarkFreezeLock): string {
  return `${canonicalJson(BenchmarkFreezeLockSchema.parse(lock))}\n`;
}

export function benchmarkExecutionPlanSha256(body: BenchmarkExecutionPlanBody): string {
  return sha256Hex(`${PLAN_DOMAIN}${canonicalJson(PlanBodySchema.parse(body))}`);
}

export function createBenchmarkExecutionPlan(bodyInput: BenchmarkExecutionPlanBody): BenchmarkExecutionPlan {
  const body = PlanBodySchema.parse(bodyInput);
  return Object.freeze({ ...body, plan_sha256: benchmarkExecutionPlanSha256(body) });
}

export function serializeBenchmarkExecutionPlan(plan: BenchmarkExecutionPlan): string {
  const parsed = BenchmarkExecutionPlanSchema.parse(plan);
  const { plan_sha256: _ignored, ...body } = parsed;
  void _ignored;
  if (benchmarkExecutionPlanSha256(body) !== parsed.plan_sha256) {
    throw new BenchmarkPlanError("hash_mismatch", "benchmark execution plan hash is invalid");
  }
  return `${canonicalJson(parsed)}\n`;
}

export function parseCanonicalBenchmarkExecutionPlan(bytes: string | Uint8Array): BenchmarkExecutionPlan {
  const value = parseCanonicalObject(bytes, "benchmark execution plan");
  const parsed = BenchmarkExecutionPlanSchema.safeParse(value);
  if (!parsed.success) throw new BenchmarkPlanError("schema", `benchmark execution plan failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const { plan_sha256: _ignored, ...body } = parsed.data;
  void _ignored;
  const expected = benchmarkExecutionPlanSha256(body);
  if (expected !== parsed.data.plan_sha256) throw new BenchmarkPlanError("hash_mismatch", "benchmark execution plan hash mismatch");
  return Object.freeze(parsed.data);
}

export function verifyExecutionPlanAgainstFreeze(input: Readonly<{
  plan: BenchmarkExecutionPlan;
  freeze: BenchmarkFreezeLock;
  now?: Date;
}>): void {
  const plan = BenchmarkExecutionPlanSchema.parse(input.plan);
  const freeze = BenchmarkFreezeLockSchema.parse(input.freeze);
  if (plan.freeze_lock_sha256 !== benchmarkFreezeLockSha256(freeze)) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan does not bind the supplied freeze lock");
  }
  if (plan.source_commit !== freeze.source_commit) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan source commit differs from the freeze lock");
  }
  if (plan.fixture.manifest_sha256 !== freeze.fixture_manifest_sha256
    || plan.fixture.caller_sequence_sha256 !== freeze.caller_sequence_sha256) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan fixture differs from the freeze lock");
  }
  if (plan.artifact_schema_sha256 !== freeze.artifact_schema_sha256) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan artifact schema differs from the freeze lock");
  }
  if (plan.audio_delivery.profile_sha256 !== freeze.audio_delivery_profile_sha256) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan audio delivery differs from the freeze lock");
  }
  if (plan.scenario.registry_catalog_sha256 !== freeze.scenario_source_registry_sha256) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan scenario registry differs from the freeze lock");
  }
  if (plan.study_plan_sha256 !== freeze.randomization_sha256) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan study-plan hash differs from the frozen randomization plan");
  }
  if (canonicalJson(plan.kernel_attestation) !== canonicalJson(freeze.kernel_attestation)) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan kernel attestation trust root differs from the freeze lock");
  }
  const pin = freeze.provider_pins.find((candidate) =>
    candidate.provider === plan.cell.provider
    && candidate.model === plan.cell.model
    && candidate.voice === plan.cell.voice
  );
  if (!pin) throw new BenchmarkPlanError("freeze_mismatch", "execution plan provider/model/voice is not frozen");
  if (pin.pricing_snapshot_sha256 !== plan.cost_envelope.pricing_snapshot_sha256) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan pricing snapshot differs from its provider pin");
  }
  if (pin.pricing_formula_sha256 !== plan.cost_envelope.formula_sha256) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan pricing formula differs from its provider pin");
  }
  if (
    pin.provider_hard_session_caps_sha256
      !== plan.release_gate.provider_hard_session_caps_sha256
    || pin.provider_hard_session_caps_sha256
      !== plan.cost_envelope.provider_hard_session_caps_sha256
  ) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan provider hard-session caps differ from its provider pin");
  }
  if (plan.mode !== "offline" && plan.mode !== freeze.evidence_class) {
    throw new BenchmarkPlanError("freeze_mismatch", "execution plan mode differs from the freeze evidence class");
  }
  if (plan.mode === "confirmatory" && freeze.registration.status !== "frozen") {
    throw new BenchmarkPlanError("ineligible", "confirmatory execution requires a frozen annotated registration");
  }
  const now = input.now ?? new Date();
  if (now.getTime() >= Date.parse(plan.expires_at)) throw new BenchmarkPlanError("expired", "benchmark execution plan has expired");
}

export function planCellIdentity(plan: BenchmarkExecutionPlan): Readonly<{
  provider: ServerRealtimeProvider;
  condition: BenchmarkConditionId;
}> {
  return Object.freeze({ provider: plan.cell.provider, condition: plan.cell.condition });
}

export type { BudgetCostEnvelope };
