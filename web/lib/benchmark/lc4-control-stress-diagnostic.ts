import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  createLc4DevReplayEvidenceStore,
  verifyLc4DevReplayLedger,
  type Lc4DevReplayArtifactReference,
  type Lc4DevReplayCasPort,
  type Lc4DevReplayLedgerEvent,
} from "./lc4-development-evidence-retention";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import { assertHaccResponsePlan, renderHaccResponsePlan, type HaccResponsePlan } from "./response-plan";
import type { RealtimeWireObservation } from "../realtime/client/types";
import { verifyRealtimeWireObservationChain } from "../realtime/client/wire-evidence";

export const LC4_CONTROL_STRESS_DIAGNOSTIC_VERSION = "HACC-LC4-CONTROL-STRESS-v1" as const;
export const LC4_CONTROL_STRESS_CLAIM_BOUNDARY =
  "diagnostic_only_provider_specific_control_acceptance_and_observed_outcomes_not_transport_qualification_not_model_quality_not_cross_provider_parity" as const;

const CONTROL_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-control-receipt/v1\n";
const PLAN_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-plan/v1\n";
const RESULT_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-result/v1\n";
const REQUEST_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-request/v1\n";
const WIRE_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-wire/v1\n";
const USAGE_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-usage/v1\n";
const TOOL_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-tools/v1\n";
const SPEECH_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-speech/v1\n";
const BUDGET_CONSUMPTION_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-budget-consumption/v1\n";
const BUDGET_CLAIM_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-budget-claim/v1\n";
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const TARGETS = Object.freeze([
  Object.freeze({ rung: "compact_semantic_baseline" as const, minimumBytes: 1 }),
  Object.freeze({ rung: "meaningful_2k" as const, minimumBytes: 2 * 1024 }),
  Object.freeze({ rung: "meaningful_8k" as const, minimumBytes: 8 * 1024 }),
]);

type Arm = "native" | "hacc";
type RungName = "compact_semantic_baseline" | "meaningful_2k" | "meaningful_8k" | "actual_current_max";

export type Lc4ControlStressCasReference = Readonly<{
  artifact_sha256: string;
  byte_length: number;
  media_type: "application/json" | "application/octet-stream" | "audio/pcm";
}>;

export type Lc4ControlStressSource = Readonly<{
  provider: LiveStsProvider;
  model: string;
  arm: Arm;
  episode_id: string;
  opportunity_index: number;
  control_authority: Lc4DevReplayArtifactReference;
}>;

export type Lc4ControlStressProbe = Readonly<{
  probe_id: string;
  caller_pcm: Lc4ControlStressCasReference;
  expected_tool_name: string;
  expected_tool_arguments_sha256: string;
  speech_oracle_sha256: string;
}>;

export type Lc4ControlStressPlanCell = Readonly<{
  cell_id: string;
  provider: LiveStsProvider;
  model: string;
  arm: Arm;
  rung: RungName;
  minimum_target_bytes: number | null;
  disposition: "scheduled" | "not_applicable";
  not_applicable_reason: "insufficient_meaningful_content" | "duplicate_request" | null;
  source_control_receipt_sha256s: readonly string[];
  source_rendered_control_sha256s: readonly string[];
  request_artifact: Lc4ControlStressCasReference | null;
  current_checkpoint_control_receipt_sha256: string | null;
  alias_of_cell_id: string | null;
}>;

export type Lc4ControlStressPlan = Readonly<{
  schema_version: 1;
  diagnostic_version: typeof LC4_CONTROL_STRESS_DIAGNOSTIC_VERSION;
  claim_boundary: typeof LC4_CONTROL_STRESS_CLAIM_BOUNDARY;
  run_id: string;
  created_at: string;
  source_commit: string;
  source_tree_oid: string;
  source_tree_sha256: string;
  source_manifest_sha256: string;
  source_inventory: readonly Lc4ControlStressSource[];
  source_ledger: Lc4ControlStressCasReference;
  source_ledger_head_sha256: string;
  source_ledger_replay_sha256: string;
  probe: Lc4ControlStressProbe;
  budget: Readonly<{
    ledger_id: string;
    reservation_id: string;
    reservation_binding_sha256: string;
    initial_ledger_head_sha256: string;
    maximum_micro_usd: number;
    maximum_paid_sessions: number;
  }>;
  execution_policy: Readonly<{
    paid_retry_allowed: false;
    maximum_attempts_per_cell: 1;
    maximum_response_generations_per_cell: 1;
    basic_transport_qualification_impact: "none";
    provider_parity_claim_allowed: false;
  }>;
  cells: readonly Lc4ControlStressPlanCell[];
  plan_sha256: string;
}>;

type ResolvedControl = Readonly<{
  source: Lc4ControlStressSource;
  rendered: string;
  rendered_sha256: string;
  rendered_byte_length: number;
  control_receipt_sha256: string;
  opportunity_id: string;
}>;

export type Lc4ControlStressAcceptanceSignal = Readonly<{
  kind: "exact_control_hash_acknowledged" | "request_processed_without_exact_ack" | "explicit_control_rejection";
  acknowledged_control_sha256: string | null;
  rejection_code_sha256: string | null;
}>;

export type Lc4ControlStressBudgetConsumption = Readonly<{
  schema_version: 1;
  plan_sha256: string;
  reservation_binding_sha256: string;
  cell_id: string;
  attempt_ordinal: 1;
  pre_open_claim_sha256: string;
  usage_evidence_sha256: string;
  settled_micro_usd: number;
  cumulative_settled_micro_usd: number;
  final_ledger_head_sha256: string;
  consumption_sha256: string;
}>;

export type Lc4ControlStressPreOpenClaim = Readonly<{
  schema_version: 1;
  plan_sha256: string;
  reservation_binding_sha256: string;
  cell_id: string;
  attempt_ordinal: 1;
  claimed_ledger_head_sha256: string;
  claim_sha256: string;
}>;

export function lc4ControlStressPreOpenClaimSha256(
  body: Omit<Lc4ControlStressPreOpenClaim, "claim_sha256">,
): string {
  return sha256Hex(`${BUDGET_CLAIM_DOMAIN}${canonicalJson(body)}`);
}

export type Lc4ControlStressOneShotAuthority = Readonly<{
  /** Called before credentials, socket construction, or any paid provider action. */
  claimBeforeOpen(input: Readonly<{
    plan_sha256: string;
    reservation_binding_sha256: string;
    cell_id: string;
    attempt_ordinal: 1;
  }>): Promise<Lc4ControlStressPreOpenClaim>;
  /** Called once after terminal usage evidence is retained. */
  settleAfterUsage(input: Readonly<{
    claim: Lc4ControlStressPreOpenClaim;
    usage_evidence_sha256: string;
    settled_micro_usd: number;
    maximum_total_micro_usd: number;
  }>): Promise<Lc4ControlStressBudgetConsumption>;
}>;

export type Lc4ControlStressSpeechEvaluation = Readonly<{
  schema_version: 1;
  speech_oracle_sha256: string;
  evaluator_manifest_sha256: string;
  ordered_output_audio_sha256: string;
  wire_chain_head_sha256: string;
  outcome: "satisfied" | "violated" | "unverifiable";
}>;

export type Lc4ControlStressSpeechEvaluator = Readonly<{
  evaluator_manifest_sha256: string;
  evaluate(input: Readonly<{
    speech_oracle_sha256: string;
    ordered_output_audio: readonly Readonly<{ sha256: string; byteLength: number }>[];
    wire_chain_head_sha256: string;
  }>): Promise<Lc4ControlStressCasReference>;
}>;

export function lc4ControlStressBudgetConsumptionSha256(
  body: Omit<Lc4ControlStressBudgetConsumption, "consumption_sha256">,
): string {
  return sha256Hex(`${BUDGET_CONSUMPTION_DOMAIN}${canonicalJson(body)}`);
}

export type Lc4ControlStressResult = Readonly<{
  schema_version: 1;
  diagnostic_version: typeof LC4_CONTROL_STRESS_DIAGNOSTIC_VERSION;
  claim_boundary: typeof LC4_CONTROL_STRESS_CLAIM_BOUNDARY;
  run_id: string;
  plan_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  budget_reservation_binding_sha256: string;
  cell_id: string;
  provider: LiveStsProvider;
  model: string;
  arm: Arm;
  rung: RungName;
  attempt_ordinal: 1;
  paid_retry_count: 0;
  observed_at: string;
  control_acceptance: "accepted" | "unverifiable" | "rejected";
  acceptance_signal: Lc4ControlStressAcceptanceSignal;
  response_terminal_status: "completed" | "failed" | "cancelled" | "incomplete" | "interrupted";
  tool_call_outcome: "expected_tool_observed" | "other_tool_observed" | "no_tool_observed";
  expected_tool_call_count: number;
  other_tool_call_count: number;
  speech_outcome: "speech_observed" | "no_speech_observed" | "speech_unverifiable";
  speech_semantic_outcome: "satisfied" | "violated" | "unverifiable";
  latency_ms: Readonly<{
    control_submit_to_response_started: number | null;
    control_submit_to_first_audio: number | null;
    control_submit_to_terminal: number;
  }>;
  usage_totals: Readonly<{
    input_text_tokens: number | null;
    input_audio_tokens: number | null;
    output_text_tokens: number | null;
    output_audio_tokens: number | null;
    total_tokens: number | null;
    usage_event_count: number;
  }>;
  cost: Readonly<{
    micro_usd: number | null;
    source: "pricing_snapshot_computed" | "conservative_reserved_ceiling";
    pricing_snapshot_sha256: string | null;
    formula_sha256: string | null;
  }>;
  budget_consumption: Lc4ControlStressBudgetConsumption;
  evidence: Readonly<{
    request_artifact: Lc4ControlStressCasReference;
    wire: Lc4ControlStressCasReference;
    usage: Lc4ControlStressCasReference;
    tool_calls: Lc4ControlStressCasReference;
    speech: Lc4ControlStressCasReference;
  }>;
  basic_transport_qualification_impact: "none";
  provider_parity_claim_allowed: false;
  result_sha256: string;
}>;

function requireHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
}

function requireIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be canonical UTC time`);
}

function assertCasReference(value: Lc4ControlStressCasReference, label: string): void {
  requireHash(value.artifact_sha256, `${label} hash`);
  if (!Number.isSafeInteger(value.byte_length) || value.byte_length < 1) throw new Error(`${label} byte length is invalid`);
  if (!["application/json", "application/octet-stream", "audio/pcm"].includes(value.media_type)) {
    throw new Error(`${label} media type is invalid`);
  }
}

async function assertCasBytes(
  cas: Pick<Lc4DevReplayCasPort, "get">,
  reference: Lc4ControlStressCasReference,
  label: string,
): Promise<Uint8Array> {
  assertCasReference(reference, label);
  const bytes = await cas.get(reference.artifact_sha256);
  if (bytes.byteLength !== reference.byte_length || sha256Hex(bytes) !== reference.artifact_sha256) {
    throw new Error(`${label} is missing, truncated, or tampered in CAS`);
  }
  return bytes;
}

async function putCas(
  cas: Lc4DevReplayCasPort,
  bytes: Uint8Array,
  mediaType: Lc4ControlStressCasReference["media_type"],
): Promise<Lc4ControlStressCasReference> {
  if (bytes.byteLength < 1) throw new Error("control-stress evidence cannot be empty");
  const receipt = await cas.put(bytes, mediaType);
  if (receipt.artifact_sha256 !== sha256Hex(bytes) || receipt.byte_length !== bytes.byteLength) {
    throw new Error("control-stress CAS receipt differs from retained bytes");
  }
  const reference = Object.freeze({
    artifact_sha256: receipt.artifact_sha256,
    byte_length: receipt.byte_length,
    media_type: mediaType,
  });
  await assertCasBytes(cas, reference, "new control-stress evidence");
  return reference;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertReference(reference: Lc4DevReplayArtifactReference): void {
  if (reference.schema_version !== 1
    || reference.retention_version !== "lc4-dev-replay-evidence-v1"
    || reference.kind !== "control_authority"
    || reference.content_encoding !== "domain-prefixed-canonical-json"
    || reference.domain_prefix !== CONTROL_RECEIPT_DOMAIN) {
    throw new Error("control-stress source is not an LC4 production control-authority CAS reference");
  }
  requireHash(reference.evidence_sha256, "control-stress source evidence");
  if (!Number.isSafeInteger(reference.byte_length) || reference.byte_length < CONTROL_RECEIPT_DOMAIN.length + 2) {
    throw new Error("control-stress source control receipt is empty");
  }
}

async function resolveControl(
  cas: Pick<Lc4DevReplayCasPort, "get">,
  source: Lc4ControlStressSource,
): Promise<ResolvedControl> {
  requireId(source.episode_id, "control-stress source episode ID");
  if (!Number.isSafeInteger(source.opportunity_index) || source.opportunity_index < 1 || source.opportunity_index > 60) {
    throw new Error("control-stress source opportunity index is invalid");
  }
  if (!source.model.trim() || source.model.length > 256) throw new Error("control-stress source model is invalid");
  assertReference(source.control_authority);
  const bytes = await cas.get(source.control_authority.evidence_sha256);
  if (bytes.byteLength !== source.control_authority.byte_length || sha256Hex(bytes) !== source.control_authority.evidence_sha256) {
    throw new Error("control-stress source control authority is missing, truncated, or tampered in CAS");
  }
  const encoded = Buffer.from(bytes).toString("utf8");
  if (!encoded.startsWith(CONTROL_RECEIPT_DOMAIN)) throw new Error("control-stress source domain prefix is invalid");
  const json = encoded.slice(CONTROL_RECEIPT_DOMAIN.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("control-stress source control authority is not JSON");
  }
  if (canonicalJson(parsed) !== json) throw new Error("control-stress source control authority is not canonical JSON");
  const body = record(parsed, "control-stress source control authority");
  const expectedBodyKeys = [
    "arm", "episode_id", "flow_state_sha256", "gateway_transcript_head_sha256", "manifest_sha256",
    "native_continuity_state_sha256", "opportunity_id", "opportunity_index", "previous_exchange_sha256",
    "repair_state_sha256", "response_control", "schema_version", "tool_world_state_sha256", "worker_state_sha256",
  ].sort();
  if (canonicalJson(Object.keys(body).sort()) !== canonicalJson(expectedBodyKeys) || body.schema_version !== 1) {
    throw new Error("control-stress source is not a complete production control receipt body");
  }
  if (body.episode_id !== source.episode_id
    || body.arm !== source.arm
    || body.opportunity_index !== source.opportunity_index) {
    throw new Error("control-stress source identity differs from its retained control authority");
  }
  requireId(body.opportunity_id, "control-stress retained opportunity ID");
  for (const key of [
    "manifest_sha256", "flow_state_sha256", "gateway_transcript_head_sha256", "tool_world_state_sha256",
    "worker_state_sha256", "repair_state_sha256", "native_continuity_state_sha256",
  ] as const) requireHash(body[key], `control-stress retained ${key}`);
  if (body.previous_exchange_sha256 !== null) requireHash(body.previous_exchange_sha256, "control-stress retained previous exchange");
  const control = record(body.response_control, "control-stress retained response control");
  let rendered: string;
  if (source.arm === "native") {
    if (canonicalJson(Object.keys(control).sort()) !== canonicalJson(["instructions", "instructions_sha256", "kind"])) {
      throw new Error("control-stress Native source control shape is not production-exact");
    }
    if (control.kind !== "native_context" || typeof control.instructions !== "string" || !control.instructions.trim()) {
      throw new Error("control-stress Native source lacks production-rendered instructions");
    }
    requireHash(control.instructions_sha256, "control-stress Native instructions");
    if (sha256Hex(control.instructions) !== control.instructions_sha256) {
      throw new Error("control-stress Native rendered instructions differ from their retained hash");
    }
    rendered = control.instructions;
  } else {
    if (canonicalJson(Object.keys(control).sort()) !== canonicalJson(["kind", "plan"])) {
      throw new Error("control-stress HACC source control shape is not production-exact");
    }
    if (control.kind !== "hacc_response_plan") throw new Error("control-stress HACC source lacks a response plan");
    const plan = control.plan as HaccResponsePlan;
    assertHaccResponsePlan(plan);
    rendered = renderHaccResponsePlan(plan);
  }
  return Object.freeze({
    source,
    rendered,
    rendered_sha256: sha256Hex(rendered),
    rendered_byte_length: Buffer.byteLength(rendered, "utf8"),
    control_receipt_sha256: source.control_authority.evidence_sha256,
    opportunity_id: body.opportunity_id,
  });
}

function semanticRequest(controls: readonly ResolvedControl[]): Uint8Array {
  if (controls.length < 1) throw new Error("control-stress request needs at least one semantic checkpoint");
  const ordered = [...controls].sort((left, right) => left.source.opportunity_index - right.source.opportunity_index);
  const current = ordered.at(-1)!;
  const manifest = {
    schema_version: 1,
    request_domain_sha256: sha256Hex(REQUEST_DOMAIN),
    interpretation: "Earlier checkpoints are retained authoritative history. The greatest opportunity_index is the current control authority.",
    current_control_receipt_sha256: current.control_receipt_sha256,
    checkpoints: ordered.map((control) => ({
      opportunity_index: control.source.opportunity_index,
      control_receipt_sha256: control.control_receipt_sha256,
      rendered_control_sha256: control.rendered_sha256,
      rendered_control_byte_length: control.rendered_byte_length,
    })),
  };
  const sections = ordered.map((control) => [
    `<control_checkpoint opportunity_index="${control.source.opportunity_index}" control_receipt_sha256="${control.control_receipt_sha256}">`,
    control.rendered,
    "</control_checkpoint>",
  ].join("\n"));
  return Buffer.from([
    "<lc4_control_stress_material>",
    `<manifest>${canonicalJson(manifest)}</manifest>`,
    ...sections,
    "</lc4_control_stress_material>",
  ].join("\n"), "utf8");
}

export async function claimLc4ControlStressCellBeforeOpen(input: Readonly<{
  plan: Lc4ControlStressPlan;
  cell_id: string;
  authority: Lc4ControlStressOneShotAuthority;
}>): Promise<Lc4ControlStressPreOpenClaim> {
  const cell = input.plan.cells.find((candidate) => candidate.cell_id === input.cell_id);
  if (!cell || cell.disposition !== "scheduled") throw new Error("control-stress pre-open claim requires one scheduled cell");
  const claim = await input.authority.claimBeforeOpen({
    plan_sha256: input.plan.plan_sha256,
    reservation_binding_sha256: input.plan.budget.reservation_binding_sha256,
    cell_id: cell.cell_id,
    attempt_ordinal: 1,
  });
  const { claim_sha256: claimed, ...body } = claim;
  if (claim.schema_version !== 1
    || lc4ControlStressPreOpenClaimSha256(body) !== claimed
    || claim.plan_sha256 !== input.plan.plan_sha256
    || claim.reservation_binding_sha256 !== input.plan.budget.reservation_binding_sha256
    || claim.cell_id !== cell.cell_id
    || claim.attempt_ordinal !== 1) throw new Error("control-stress pre-open budget claim is invalid");
  requireHash(claim.claimed_ledger_head_sha256, "control-stress pre-open ledger head");
  return claim;
}

function sourceManifestSha256(sources: readonly ResolvedControl[]): string {
  return sha256Hex(canonicalJson(sources.map((control) => ({
    provider: control.source.provider,
    model: control.source.model,
    arm: control.source.arm,
    episode_id: control.source.episode_id,
    opportunity_index: control.source.opportunity_index,
    control_receipt_sha256: control.control_receipt_sha256,
    rendered_control_sha256: control.rendered_sha256,
    rendered_control_byte_length: control.rendered_byte_length,
  }))));
}

function assertSourceGrouping(controls: readonly ResolvedControl[]): void {
  const modelsByProviderArm = new Map<string, Set<string>>();
  const episodesByLadder = new Map<string, Set<string>>();
  for (const control of controls) {
    const providerArm = `${control.source.provider}:${control.source.arm}`;
    const models = modelsByProviderArm.get(providerArm) ?? new Set<string>();
    models.add(control.source.model);
    modelsByProviderArm.set(providerArm, models);
    const ladder = `${control.source.provider}:${control.source.model}:${control.source.arm}`;
    const episodes = episodesByLadder.get(ladder) ?? new Set<string>();
    episodes.add(control.source.episode_id);
    episodesByLadder.set(ladder, episodes);
  }
  if ([...modelsByProviderArm.values()].some((models) => models.size !== 1)) {
    throw new Error("control-stress requires exactly one frozen model per provider/arm ladder");
  }
  if ([...episodesByLadder.values()].some((episodes) => episodes.size !== 1)) {
    throw new Error("control-stress requires exactly one retained episode per provider/model/arm ladder");
  }
}

async function verifySourceLedgerBindings(
  cas: Lc4DevReplayCasPort,
  ledger: readonly Lc4DevReplayLedgerEvent[],
  controls: readonly ResolvedControl[],
): Promise<Readonly<{ ledger_head_sha256: string; replay_sha256: string }>> {
  const evidence = createLc4DevReplayEvidenceStore(cas);
  const replay = await verifyLc4DevReplayLedger(ledger, evidence);
  for (const control of controls) {
    const opened = ledger.filter((event) => event.event_type === "episode_opened"
      && event.episode_id === control.source.episode_id && event.opportunity_id === null);
    if (opened.length !== 1) throw new Error("control-stress source lacks one retained episode-opened ledger event");
    const episodePayload = record(await evidence.resolveJson(opened[0]!.payload_evidence), "control-stress episode-opened payload");
    if (canonicalJson(Object.keys(episodePayload).sort()) !== canonicalJson(["arm", "model", "provider"])
      || episodePayload.provider !== control.source.provider
      || episodePayload.model !== control.source.model
      || episodePayload.arm !== control.source.arm) {
      throw new Error("control-stress provider/model/arm labels differ from retained episode ledger evidence");
    }
    const submitted = ledger.filter((event) => event.event_type === "audio_submitted"
      && event.episode_id === control.source.episode_id
      && event.opportunity_id === control.opportunity_id);
    if (submitted.length !== 1) throw new Error("control-stress source lacks one retained audio-submitted ledger event");
    const submittedPayload = record(await evidence.resolveJson(submitted[0]!.payload_evidence), "control-stress audio-submitted payload");
    if (submittedPayload.control_receipt_sha256 !== control.control_receipt_sha256
      || !submitted[0]!.evidence_references.some((reference) =>
        reference.kind === "control_authority"
        && canonicalJson(reference) === canonicalJson(control.source.control_authority))) {
      throw new Error("control-stress control authority is not attached to its retained episode ledger event");
    }
  }
  return Object.freeze({ ledger_head_sha256: replay.ledger_head_sha256, replay_sha256: replay.replay_sha256 });
}

async function resolveSourceLedger(
  cas: Lc4DevReplayCasPort,
  reference: Lc4ControlStressCasReference,
): Promise<readonly Lc4DevReplayLedgerEvent[]> {
  if (reference.media_type !== "application/json") throw new Error("control-stress source ledger must be canonical JSON");
  const bytes = await assertCasBytes(cas, reference, "control-stress source ledger");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("control-stress source ledger is not JSON");
  }
  if (!Array.isArray(parsed) || canonicalJson(parsed) !== Buffer.from(bytes).toString("utf8")) {
    throw new Error("control-stress source ledger is not a canonical event array");
  }
  return immutableJson(parsed) as unknown as readonly Lc4DevReplayLedgerEvent[];
}

function cellId(provider: LiveStsProvider, arm: Arm, rung: RungName): string {
  return `${provider}.${arm}.${rung}`;
}

async function freezeLadder(
  cas: Lc4DevReplayCasPort,
  provider: LiveStsProvider,
  model: string,
  arm: Arm,
  controls: readonly ResolvedControl[],
): Promise<readonly Lc4ControlStressPlanCell[]> {
  // The latest authority is the controlled variable and must remain current at
  // every rung. When identical controls recur, preserve the latest receipt;
  // earlier duplicates add bytes but no information and are excluded.
  const latestFirst = [...controls].sort((left, right) => right.source.opportunity_index - left.source.opportunity_index);
  const unique = [...new Map(latestFirst.map((control) => [control.rendered_sha256, control])).values()];
  if (unique.length < 1) throw new Error(`control-stress ${provider}/${arm} has no distinct semantic controls`);
  const current = latestFirst[0]!;
  const historical = unique
    .filter((control) => control.rendered_sha256 !== current.rendered_sha256)
    .sort((left, right) => left.rendered_byte_length - right.rendered_byte_length
      || left.source.opportunity_index - right.source.opportunity_index);
  const selections: Array<Readonly<{ rung: RungName; minimumBytes: number | null; controls: readonly ResolvedControl[] | null }>> = [];
  selections.push({ rung: "compact_semantic_baseline", minimumBytes: 1, controls: Object.freeze([current]) });
  for (const target of TARGETS.slice(1)) {
    const selected: ResolvedControl[] = [current];
    let bytes = semanticRequest(selected).byteLength;
    for (const control of historical) {
      if (bytes >= target.minimumBytes) break;
      selected.push(control);
      bytes = semanticRequest(selected).byteLength;
    }
    selections.push({
      rung: target.rung,
      minimumBytes: target.minimumBytes,
      controls: bytes >= target.minimumBytes ? Object.freeze(selected) : null,
    });
  }
  selections.push({ rung: "actual_current_max", minimumBytes: null, controls: Object.freeze([current, ...historical]) });

  const priorRequests = new Map<string, string>();
  const cells: Lc4ControlStressPlanCell[] = [];
  for (const selection of selections) {
    const id = cellId(provider, arm, selection.rung);
    if (selection.controls === null) {
      cells.push(Object.freeze({
        cell_id: id,
        provider,
        model,
        arm,
        rung: selection.rung,
        minimum_target_bytes: selection.minimumBytes,
        disposition: "not_applicable",
        not_applicable_reason: "insufficient_meaningful_content",
        source_control_receipt_sha256s: Object.freeze([]),
        source_rendered_control_sha256s: Object.freeze([]),
        request_artifact: null,
        current_checkpoint_control_receipt_sha256: null,
        alias_of_cell_id: null,
      }));
      continue;
    }
    const request = semanticRequest(selection.controls);
    const requestSha256 = sha256Hex(request);
    const alias = priorRequests.get(requestSha256) ?? null;
    const ordered = [...selection.controls].sort((left, right) => left.source.opportunity_index - right.source.opportunity_index);
    const requestArtifact = await putCas(cas, request, "application/octet-stream");
    cells.push(Object.freeze({
      cell_id: id,
      provider,
      model,
      arm,
      rung: selection.rung,
      minimum_target_bytes: selection.minimumBytes,
      disposition: alias === null ? "scheduled" : "not_applicable",
      not_applicable_reason: alias === null ? null : "duplicate_request",
      source_control_receipt_sha256s: Object.freeze(ordered.map((control) => control.control_receipt_sha256)),
      source_rendered_control_sha256s: Object.freeze(ordered.map((control) => control.rendered_sha256)),
      request_artifact: requestArtifact,
      current_checkpoint_control_receipt_sha256: ordered.at(-1)!.control_receipt_sha256,
      alias_of_cell_id: alias,
    }));
    if (alias === null) priorRequests.set(requestSha256, id);
  }
  return Object.freeze(cells);
}

export async function freezeLc4ControlStressPlan(input: Readonly<{
  run_id: string;
  created_at: string;
  source_commit: string;
  source_tree_oid: string;
  source_tree_sha256: string;
  probe: Lc4ControlStressProbe;
  budget: Lc4ControlStressPlan["budget"];
  sources: readonly Lc4ControlStressSource[];
  source_ledger: readonly Lc4DevReplayLedgerEvent[];
  cas: Lc4DevReplayCasPort;
}>): Promise<Lc4ControlStressPlan> {
  requireId(input.run_id, "control-stress run ID");
  requireIso(input.created_at, "control-stress creation time");
  if (!GIT_COMMIT.test(input.source_commit)) throw new Error("control-stress source commit is invalid");
  if (!/^[a-f0-9]{40,64}$/u.test(input.source_tree_oid)) throw new Error("control-stress source tree OID is invalid");
  requireHash(input.source_tree_sha256, "control-stress source tree");
  requireId(input.probe.probe_id, "control-stress probe ID");
  assertCasReference(input.probe.caller_pcm, "control-stress caller PCM");
  if (input.probe.caller_pcm.media_type !== "audio/pcm") throw new Error("control-stress caller probe must be retained PCM");
  await assertCasBytes(input.cas, input.probe.caller_pcm, "control-stress caller PCM");
  requireId(input.probe.expected_tool_name, "control-stress expected tool name");
  requireHash(input.probe.expected_tool_arguments_sha256, "control-stress expected tool arguments");
  requireHash(input.probe.speech_oracle_sha256, "control-stress speech oracle");
  requireId(input.budget.ledger_id, "control-stress budget ledger ID");
  requireId(input.budget.reservation_id, "control-stress budget reservation ID");
  requireHash(input.budget.reservation_binding_sha256, "control-stress budget reservation binding");
  requireHash(input.budget.initial_ledger_head_sha256, "control-stress initial ledger head");
  if (!Number.isSafeInteger(input.budget.maximum_micro_usd) || input.budget.maximum_micro_usd < 1) {
    throw new Error("control-stress budget maximum is invalid");
  }
  if (input.sources.length < 1) throw new Error("control-stress plan has no retained production controls");
  const sourceKeys = input.sources.map((source) => `${source.provider}:${source.arm}:${source.episode_id}:${source.opportunity_index}`);
  if (new Set(sourceKeys).size !== sourceKeys.length) throw new Error("control-stress source controls contain duplicate identities");
  const resolved = await Promise.all(input.sources.map((source) => resolveControl(input.cas, source)));
  const sourceLedgerReplay = await verifySourceLedgerBindings(input.cas, input.source_ledger, resolved);
  const sourceLedger = await putCas(
    input.cas,
    Buffer.from(canonicalJson(input.source_ledger), "utf8"),
    "application/json",
  );
  assertSourceGrouping(resolved);
  const groups = new Map<string, ResolvedControl[]>();
  for (const control of resolved) {
    const key = `${control.source.provider}:${control.source.model}:${control.source.arm}`;
    const group = groups.get(key) ?? [];
    group.push(control);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort((left, right) => {
    const providerOrder = ["openai", "gemini", "xai"];
    const providerDelta = providerOrder.indexOf(left[0]!.source.provider) - providerOrder.indexOf(right[0]!.source.provider);
    return providerDelta || left[0]!.source.arm.localeCompare(right[0]!.source.arm);
  });
  const cells = Object.freeze((await Promise.all(orderedGroups.map((group) => freezeLadder(
    input.cas,
    group[0]!.source.provider,
    group[0]!.source.model,
    group[0]!.source.arm,
    group,
  )))).flat());
  if (new Set(cells.map((cell) => cell.cell_id)).size !== cells.length) {
    throw new Error("control-stress cell IDs are not unique");
  }
  const scheduled = cells.filter((cell) => cell.disposition === "scheduled").length;
  if (input.budget.maximum_paid_sessions !== scheduled) {
    throw new Error("control-stress budget must pre-authorize exactly one session per scheduled cell");
  }
  const body = immutableJson({
    schema_version: 1,
    diagnostic_version: LC4_CONTROL_STRESS_DIAGNOSTIC_VERSION,
    claim_boundary: LC4_CONTROL_STRESS_CLAIM_BOUNDARY,
    run_id: input.run_id,
    created_at: input.created_at,
    source_commit: input.source_commit,
    source_tree_oid: input.source_tree_oid,
    source_tree_sha256: input.source_tree_sha256,
    source_manifest_sha256: sourceManifestSha256(resolved),
    source_inventory: input.sources,
    source_ledger: sourceLedger,
    source_ledger_head_sha256: sourceLedgerReplay.ledger_head_sha256,
    source_ledger_replay_sha256: sourceLedgerReplay.replay_sha256,
    probe: input.probe,
    budget: input.budget,
    execution_policy: {
      paid_retry_allowed: false,
      maximum_attempts_per_cell: 1,
      maximum_response_generations_per_cell: 1,
      basic_transport_qualification_impact: "none",
      provider_parity_claim_allowed: false,
    },
    cells,
  }) as unknown as Omit<Lc4ControlStressPlan, "plan_sha256">;
  return immutableJson({ ...body, plan_sha256: sha256Hex(`${PLAN_DOMAIN}${canonicalJson(body)}`) }) as unknown as Lc4ControlStressPlan;
}

export async function verifyLc4ControlStressPlan(
  plan: Lc4ControlStressPlan,
  cas: Pick<Lc4DevReplayCasPort, "get">,
): Promise<void> {
  const { plan_sha256: claimed, ...body } = plan;
  requireHash(claimed, "control-stress plan");
  if (sha256Hex(`${PLAN_DOMAIN}${canonicalJson(body)}`) !== claimed) throw new Error("control-stress plan hash mismatch");
  if (plan.diagnostic_version !== LC4_CONTROL_STRESS_DIAGNOSTIC_VERSION
    || plan.schema_version !== 1
    || plan.claim_boundary !== LC4_CONTROL_STRESS_CLAIM_BOUNDARY
    || plan.execution_policy.paid_retry_allowed !== false
    || plan.execution_policy.maximum_attempts_per_cell !== 1
    || plan.execution_policy.maximum_response_generations_per_cell !== 1
    || plan.execution_policy.basic_transport_qualification_impact !== "none"
    || plan.execution_policy.provider_parity_claim_allowed !== false) {
    throw new Error("control-stress plan weakened its diagnostic-only no-retry boundary");
  }
  requireId(plan.run_id, "control-stress plan run ID");
  requireIso(plan.created_at, "control-stress plan creation time");
  if (!GIT_COMMIT.test(plan.source_commit) || !/^[a-f0-9]{40,64}$/u.test(plan.source_tree_oid)) {
    throw new Error("control-stress plan source identity is invalid");
  }
  for (const [label, digest] of [
    ["source tree", plan.source_tree_sha256],
    ["source manifest", plan.source_manifest_sha256],
    ["source ledger head", plan.source_ledger_head_sha256],
    ["source ledger replay", plan.source_ledger_replay_sha256],
    ["speech oracle", plan.probe.speech_oracle_sha256],
    ["expected tool arguments", plan.probe.expected_tool_arguments_sha256],
    ["budget binding", plan.budget.reservation_binding_sha256],
    ["budget head", plan.budget.initial_ledger_head_sha256],
  ] as const) requireHash(digest, `control-stress plan ${label}`);
  requireId(plan.probe.probe_id, "control-stress plan probe ID");
  requireId(plan.probe.expected_tool_name, "control-stress plan expected tool");
  requireId(plan.budget.ledger_id, "control-stress plan budget ledger ID");
  requireId(plan.budget.reservation_id, "control-stress plan budget reservation ID");
  if (!Number.isSafeInteger(plan.budget.maximum_micro_usd) || plan.budget.maximum_micro_usd < 1
    || !Number.isSafeInteger(plan.budget.maximum_paid_sessions) || plan.budget.maximum_paid_sessions < 1) {
    throw new Error("control-stress plan budget bounds are invalid");
  }
  assertCasReference(plan.source_ledger, "control-stress plan source ledger");
  await assertCasBytes(cas, plan.probe.caller_pcm, "control-stress plan caller PCM");
  const resolvedSources = await Promise.all(plan.source_inventory.map((source) => resolveControl(cas, source)));
  const sourceKeys = plan.source_inventory.map((source) => `${source.provider}:${source.arm}:${source.episode_id}:${source.opportunity_index}`);
  if (new Set(sourceKeys).size !== sourceKeys.length) throw new Error("control-stress plan source controls contain duplicate identities");
  assertSourceGrouping(resolvedSources);
  if (new Set(plan.cells.map((cell) => cell.cell_id)).size !== plan.cells.length) {
    throw new Error("control-stress plan cell IDs are not unique");
  }
  if (sourceManifestSha256(resolvedSources) !== plan.source_manifest_sha256) {
    throw new Error("control-stress plan source inventory differs from its retained production controls");
  }
  const verifyingCas: Lc4DevReplayCasPort = Object.freeze({
    get: (artifactSha256) => cas.get(artifactSha256),
    put: async (bytes) => {
      const artifactSha256 = sha256Hex(bytes);
      const retained = await cas.get(artifactSha256);
      if (retained.byteLength !== bytes.byteLength || sha256Hex(retained) !== artifactSha256) {
        throw new Error("control-stress derived request differs from its retained CAS bytes");
      }
      return Object.freeze({
        artifact_sha256: artifactSha256,
        byte_length: bytes.byteLength,
        receipt_sha256: sha256Hex(`control-stress-read-only-verification:${artifactSha256}`),
      });
    },
  });
  const sourceLedger = await resolveSourceLedger(verifyingCas, plan.source_ledger);
  const sourceLedgerReplay = await verifySourceLedgerBindings(verifyingCas, sourceLedger, resolvedSources);
  if (sourceLedgerReplay.ledger_head_sha256 !== plan.source_ledger_head_sha256
    || sourceLedgerReplay.replay_sha256 !== plan.source_ledger_replay_sha256) {
    throw new Error("control-stress source ledger replay differs from the plan");
  }
  const groups = new Map<string, ResolvedControl[]>();
  for (const control of resolvedSources) {
    const key = `${control.source.provider}:${control.source.model}:${control.source.arm}`;
    const group = groups.get(key) ?? [];
    group.push(control);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort((left, right) => {
    const providerOrder = ["openai", "gemini", "xai"];
    const providerDelta = providerOrder.indexOf(left[0]!.source.provider) - providerOrder.indexOf(right[0]!.source.provider);
    return providerDelta || left[0]!.source.arm.localeCompare(right[0]!.source.arm);
  });
  const derivedCells = (await Promise.all(orderedGroups.map((group) => freezeLadder(
    verifyingCas,
    group[0]!.source.provider,
    group[0]!.source.model,
    group[0]!.source.arm,
    group,
  )))).flat();
  if (canonicalJson(derivedCells) !== canonicalJson(plan.cells)) {
    throw new Error("control-stress plan cell matrix differs from its retained production controls");
  }
  const scheduled = plan.cells.filter((cell) => cell.disposition === "scheduled");
  if (scheduled.length !== plan.budget.maximum_paid_sessions) throw new Error("control-stress plan scheduled cells exceed budget sessions");
  for (const cell of plan.cells) {
    if (cell.request_artifact !== null) await assertCasBytes(cas, cell.request_artifact, `control-stress ${cell.cell_id} request`);
    if (cell.disposition === "scheduled" && cell.request_artifact === null) throw new Error("scheduled control-stress cell lacks request bytes");
    if (cell.disposition === "not_applicable" && cell.not_applicable_reason === null) throw new Error("non-applicable control-stress cell lacks a reason");
  }
}

function controlStressProjection(projectionInput: Readonly<Record<string, unknown>>, allowFlatOutputAudio = false): JsonValue {
  const projection = projectionRecord(projectionInput);
  const dynamic = projectionRecord(projection.dynamicControl);
  const acknowledgement = projectionRecord(projection.dynamicControlAcknowledgement);
  const rejection = projectionRecord(projection.dynamicControlRejection);
  const error = projectionRecord(projection.error);
  const terminal = projectionRecord(projection.terminal);
  const audio = projectionRecord(projection.audio);
  const chunks = projectionArray(audio.chunks).flatMap((chunk) =>
    chunk.validCanonicalBase64 === true
      && typeof chunk.sha256 === "string" && SHA256.test(chunk.sha256)
      && Number.isSafeInteger(chunk.byteLength) && Number(chunk.byteLength) > 0
      ? [{ validCanonicalBase64: true, sha256: chunk.sha256, byteLength: Number(chunk.byteLength) }]
      : []);
  const flatOutputChunk = allowFlatOutputAudio
    && audio.validCanonicalBase64 === true
    && typeof audio.sha256 === "string" && SHA256.test(audio.sha256)
    && Number.isSafeInteger(audio.byteLength) && Number(audio.byteLength) > 0
    ? [{ validCanonicalBase64: true, sha256: audio.sha256, byteLength: Number(audio.byteLength) }]
    : [];
  const gatewayCalls = projectionArray(projection.gatewayCalls).map((call) => ({
    gateway: typeof call.gateway === "string" ? call.gateway : "unknown",
    argumentsSha256: typeof call.argumentsSha256 === "string" && SHA256.test(call.argumentsSha256) ? call.argumentsSha256 : null,
    argumentsBytes: Number.isSafeInteger(call.argumentsBytes) && Number(call.argumentsBytes) >= 0 ? Number(call.argumentsBytes) : null,
    targetToolNameSha256: typeof call.targetToolNameSha256 === "string" && SHA256.test(call.targetToolNameSha256) ? call.targetToolNameSha256 : null,
    targetArgumentsSha256: typeof call.targetArgumentsSha256 === "string" && SHA256.test(call.targetArgumentsSha256) ? call.targetArgumentsSha256 : null,
  }));
  const usage = Object.fromEntries(Object.entries(projectionRecord(projection.usage))
    .filter(([, value]) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0));
  return immutableJson({
    dynamic_control: Object.keys(dynamic).length === 0 ? null : {
      sha256: typeof dynamic.sha256 === "string" && SHA256.test(dynamic.sha256) ? dynamic.sha256 : null,
      byte_length: Number.isSafeInteger(dynamic.byteLength) ? Number(dynamic.byteLength) : null,
      authority: dynamic.authority === "advisory_only_gateway_and_speech_gate_enforced" ? dynamic.authority : null,
    },
    dynamic_control_acknowledgement_sha256: typeof acknowledgement.sha256 === "string" && SHA256.test(acknowledgement.sha256)
      ? acknowledgement.sha256 : null,
    dynamic_control_rejection_sha256: Object.keys(rejection).length === 0 ? null : sha256Hex(canonicalJson(rejection)),
    error_sha256: Object.keys(error).length === 0 ? null : sha256Hex(canonicalJson(error)),
    terminal_status: typeof terminal.status === "string" ? terminal.status : null,
    output_audio_chunks: audio.direction === "output" ? chunks : flatOutputChunk,
    gateway_calls: gatewayCalls,
    usage,
  });
}

export function sanitizeLc4ControlStressWireObservation(observation: RealtimeWireObservation): JsonValue {
  return immutableJson({
    schema_version: 1,
    provider: observation.provider,
    direction: observation.direction,
    connection_epoch: observation.connectionEpoch,
    sequence: observation.sequence,
    observed_at_ms: observation.observedAtMs,
    observed_at_monotonic_ms: observation.observedAtMonotonicMs,
    wire_type: observation.wireType,
    payload_sha256: observation.payloadSha256,
    payload_bytes: observation.payloadBytes,
    projection_sha256: observation.projectionSha256,
    previous_observation_sha256: observation.previousObservationSha256,
    observation_sha256: observation.observationSha256,
    event_id_sha256: observation.identities.eventIdSha256 ?? null,
    session_id_sha256: observation.identities.sessionIdSha256 ?? null,
    response_id_sha256: observation.identities.responseIdSha256 ?? null,
    item_id_sha256: observation.identities.itemIdSha256 ?? null,
    call_id_sha256: observation.identities.callIdSha256 ?? null,
    evidence_projection: controlStressProjection(
      observation.projection,
      observation.direction === "inbound"
        && (observation.wireType === "response.output_audio.delta" || observation.wireType === "response.audio.delta"),
    ),
  });
}

function projectionRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function projectionArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(projectionRecord) : [];
}

function completeUsageSum(events: readonly Record<string, unknown>[], key: string): number | null {
  if (events.length === 0 || events.some((event) => typeof event[key] !== "number")) return null;
  const values = events.map((event) => Number(event[key]));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`control-stress usage ${key} contains an invalid counter`);
  }
  return values.reduce((sum, value) => sum + value, 0);
}

function terminalFromWire(observations: readonly RealtimeWireObservation[]): Readonly<{
  status: Lc4ControlStressResult["response_terminal_status"];
  observation: RealtimeWireObservation;
}> | null {
  for (const observation of [...observations].reverse()) {
    if (observation.direction !== "inbound") continue;
    const projection = projectionRecord(observation.projection);
    const terminal = projectionRecord(projection.terminal);
    if (["completed", "failed", "cancelled", "incomplete", "interrupted"].includes(String(terminal.status))) {
      return Object.freeze({
        status: terminal.status as Lc4ControlStressResult["response_terminal_status"],
        observation,
      });
    }
    if (Object.keys(projectionRecord(projection.error)).length > 0) {
      return Object.freeze({ status: "failed" as const, observation });
    }
  }
  return null;
}

export async function retainLc4ControlStressResult(input: Readonly<{
  plan: Lc4ControlStressPlan;
  cell_id: string;
  cas: Lc4DevReplayCasPort;
  observed_at: string;
  attempt_ordinal: 1;
  acceptance_signal: Lc4ControlStressAcceptanceSignal;
  wire_observations: readonly RealtimeWireObservation[];
  speech_evaluator: Lc4ControlStressSpeechEvaluator;
  pricing: null | Readonly<{
    pricing_snapshot_sha256: string;
    formula_sha256: string;
    computeMicroUsd(usage: Lc4ControlStressResult["usage_totals"]): number;
  }>;
  authority: Lc4ControlStressOneShotAuthority;
  pre_open_claim: Lc4ControlStressPreOpenClaim;
}>): Promise<Lc4ControlStressResult> {
  await verifyLc4ControlStressPlan(input.plan, input.cas);
  requireIso(input.observed_at, "control-stress result time");
  if (input.attempt_ordinal !== 1) throw new Error("control-stress paid retry policy permits only attempt ordinal 1");
  const cell = input.plan.cells.find((candidate) => candidate.cell_id === input.cell_id);
  if (!cell || cell.disposition !== "scheduled" || cell.request_artifact === null) {
    throw new Error("control-stress result must target one scheduled plan cell");
  }
  const { claim_sha256: preOpenClaimed, ...preOpenBody } = input.pre_open_claim;
  if (input.pre_open_claim.schema_version !== 1
    || lc4ControlStressPreOpenClaimSha256(preOpenBody) !== preOpenClaimed
    || input.pre_open_claim.plan_sha256 !== input.plan.plan_sha256
    || input.pre_open_claim.reservation_binding_sha256 !== input.plan.budget.reservation_binding_sha256
    || input.pre_open_claim.cell_id !== cell.cell_id
    || input.pre_open_claim.attempt_ordinal !== 1) {
    throw new Error("control-stress result lacks its exact pre-open one-shot claim");
  }
  const chain = verifyRealtimeWireObservationChain(input.wire_observations);
  if (!chain.valid || chain.eventCount < 2 || chain.chainHead === null) {
    throw new Error(`control-stress result requires a valid non-empty wire chain: ${chain.errors.join("; ")}`);
  }
  if (input.wire_observations.some((observation) => observation.provider !== cell.provider)) {
    throw new Error("control-stress wire provider differs from its frozen cell");
  }
  const submitted = input.wire_observations.find((observation) => {
    if (observation.direction !== "outbound") return false;
    const dynamic = projectionRecord(projectionRecord(observation.projection).dynamicControl);
    return dynamic.sha256 === cell.request_artifact!.artifact_sha256
      && dynamic.byteLength === cell.request_artifact!.byte_length
      && dynamic.authority === "advisory_only_gateway_and_speech_gate_enforced";
  });
  if (!submitted) throw new Error("control-stress wire chain does not prove delivery of the frozen request bytes");
  const terminal = terminalFromWire(input.wire_observations);
  if (!terminal || terminal.observation.sequence <= submitted.sequence
    || terminal.observation.connectionEpoch !== submitted.connectionEpoch) {
    throw new Error("control-stress wire chain lacks a post-submission terminal outcome");
  }
  const causalWindow = input.wire_observations.filter((observation) =>
    observation.connectionEpoch === submitted.connectionEpoch
    && observation.sequence > submitted.sequence
    && observation.sequence <= terminal.observation.sequence);
  const terminalResponseId = terminal.observation.identities.responseIdSha256;
  if (terminalResponseId && causalWindow.some((observation) => observation.direction === "inbound"
    && observation.identities.responseIdSha256 !== undefined
    && observation.identities.responseIdSha256 !== terminalResponseId)) {
    throw new Error("control-stress causal window contains another provider response identity");
  }
  const generationTriggers = cell.provider === "gemini"
    ? causalWindow.filter((observation) => observation.direction === "outbound"
      && observation.wireType === "realtimeInput.activityEnd").length
    : input.wire_observations.filter((observation) => observation.connectionEpoch === submitted.connectionEpoch
      && observation.direction === "outbound"
      && observation.wireType === "response.create"
      && observation.sequence >= submitted.sequence
      && observation.sequence <= terminal.observation.sequence).length;
  if (generationTriggers !== 1) throw new Error("control-stress cell requires exactly one provider generation trigger");
  const signal = input.acceptance_signal;
  const acknowledgement = causalWindow.find((observation) => {
    const ack = projectionRecord(projectionRecord(observation.projection).dynamicControlAcknowledgement);
    return observation.direction === "inbound" && ack.sha256 === cell.request_artifact!.artifact_sha256;
  });
  const rejection = causalWindow.map((observation) => {
    if (observation.direction !== "inbound") return false;
    const projection = projectionRecord(observation.projection);
    const explicit = projectionRecord(projection.dynamicControlRejection);
    const evidence = Object.keys(explicit).length > 0 ? explicit : null;
    return evidence === null ? null : Object.freeze({ observation, evidence });
  }).find((value): value is Exclude<typeof value, false | null> => Boolean(value));
  if (signal.kind === "exact_control_hash_acknowledged") {
    if (!acknowledgement
      || signal.acknowledged_control_sha256 !== cell.request_artifact.artifact_sha256
      || signal.rejection_code_sha256 !== null) {
      throw new Error("control-stress exact acknowledgement does not match frozen request bytes");
    }
  } else if (signal.kind === "request_processed_without_exact_ack") {
    if (acknowledgement || rejection
      || signal.acknowledged_control_sha256 !== null || signal.rejection_code_sha256 !== null) {
      throw new Error("control-stress unverifiable acceptance cannot claim acknowledgement or rejection");
    }
  } else {
    if (signal.acknowledged_control_sha256 !== null) throw new Error("control-stress rejection cannot also acknowledge control bytes");
    requireHash(signal.rejection_code_sha256, "control-stress rejection code");
    if (!rejection || signal.rejection_code_sha256 !== sha256Hex(canonicalJson(rejection.evidence))
      || terminal.status === "completed") {
      throw new Error("control-stress explicit rejection lacks matching provider-wire rejection evidence");
    }
  }
  const sanitizedWire = input.wire_observations.map(sanitizeLc4ControlStressWireObservation);
  const usageProjections = causalWindow.flatMap((observation) => {
    const usage = projectionRecord(projectionRecord(observation.projection).usage);
    return Object.keys(usage).length > 0 ? [usage] : [];
  });
  const gatewayCalls = causalWindow.flatMap((observation) =>
    projectionArray(projectionRecord(observation.projection).gatewayCalls));
  const outputAudio = causalWindow.flatMap((observation) => {
    const audio = projectionRecord(projectionRecord(observation.projection).audio);
    if (audio.direction === "output") return projectionArray(audio.chunks);
    // OpenAI/xAI emit one flat audio projection per output delta.
    return observation.direction === "inbound"
      && (observation.wireType === "response.output_audio.delta" || observation.wireType === "response.audio.delta")
      ? [audio]
      : [];
  }).filter((chunk) => chunk.validCanonicalBase64 === true
    && typeof chunk.sha256 === "string" && SHA256.test(chunk.sha256)
    && Number.isSafeInteger(chunk.byteLength) && Number(chunk.byteLength) > 0);
  const expectedToolCalls = gatewayCalls.filter((call) => call.gateway === input.plan.probe.expected_tool_name
    && call.argumentsSha256 === input.plan.probe.expected_tool_arguments_sha256).length;
  const otherToolCalls = gatewayCalls.length - expectedToolCalls;
  const usageTotals = Object.freeze({
    input_text_tokens: completeUsageSum(usageProjections, "inputTextTokens"),
    input_audio_tokens: completeUsageSum(usageProjections, "inputAudioTokens"),
    output_text_tokens: completeUsageSum(usageProjections, "outputTextTokens"),
    output_audio_tokens: completeUsageSum(usageProjections, "outputAudioTokens"),
    total_tokens: completeUsageSum(usageProjections, "totalTokens"),
    usage_event_count: usageProjections.length,
  });
  let cost: Lc4ControlStressResult["cost"];
  if (input.pricing === null) {
    cost = Object.freeze({
      micro_usd: input.plan.budget.maximum_micro_usd,
      source: "conservative_reserved_ceiling",
      pricing_snapshot_sha256: null,
      formula_sha256: null,
    });
  } else {
    requireHash(input.pricing.pricing_snapshot_sha256, "control-stress pricing snapshot");
    requireHash(input.pricing.formula_sha256, "control-stress pricing formula");
    const microUsd = input.pricing.computeMicroUsd(usageTotals);
    if (!Number.isSafeInteger(microUsd) || microUsd < 0 || microUsd > input.plan.budget.maximum_micro_usd) {
      throw new Error("control-stress computed cost is invalid or exceeds the frozen budget ceiling");
    }
    cost = Object.freeze({
      micro_usd: microUsd,
      source: "pricing_snapshot_computed",
      pricing_snapshot_sha256: input.pricing.pricing_snapshot_sha256,
      formula_sha256: input.pricing.formula_sha256,
    });
  }
  const speechOutcome = outputAudio.length > 0 ? "speech_observed" as const : "no_speech_observed" as const;
  requireHash(input.speech_evaluator.evaluator_manifest_sha256, "control-stress speech evaluator manifest");
  const orderedOutputAudio = Object.freeze(outputAudio.map((chunk) => Object.freeze({
    sha256: String(chunk.sha256),
    byteLength: Number(chunk.byteLength),
  })));
  const orderedOutputAudioSha256 = sha256Hex(canonicalJson(orderedOutputAudio));
  const evaluationReference = await input.speech_evaluator.evaluate({
    speech_oracle_sha256: input.plan.probe.speech_oracle_sha256,
    ordered_output_audio: orderedOutputAudio,
    wire_chain_head_sha256: chain.chainHead,
  });
  if (evaluationReference.media_type !== "application/json") {
    throw new Error("control-stress speech evaluator must retain canonical JSON evidence");
  }
  const evaluationBytes = await assertCasBytes(input.cas, evaluationReference, "control-stress speech evaluation");
  let evaluation: Lc4ControlStressSpeechEvaluation;
  try {
    evaluation = immutableJson(JSON.parse(Buffer.from(evaluationBytes).toString("utf8"))) as unknown as Lc4ControlStressSpeechEvaluation;
  } catch {
    throw new Error("control-stress speech evaluation is not canonical JSON");
  }
  if (canonicalJson(evaluation) !== Buffer.from(evaluationBytes).toString("utf8")
    || evaluation.schema_version !== 1
    || evaluation.speech_oracle_sha256 !== input.plan.probe.speech_oracle_sha256
    || evaluation.evaluator_manifest_sha256 !== input.speech_evaluator.evaluator_manifest_sha256
    || evaluation.ordered_output_audio_sha256 !== orderedOutputAudioSha256
    || evaluation.wire_chain_head_sha256 !== chain.chainHead
    || !["satisfied", "violated", "unverifiable"].includes(evaluation.outcome)) {
    throw new Error("control-stress speech evaluation differs from its exact oracle, audio, evaluator, or wire inputs");
  }
  if (evaluation.outcome === "satisfied" && outputAudio.length === 0) {
    throw new Error("control-stress speech semantics cannot pass without wire-observed output audio");
  }
  const speechBody = {
    capture: speechOutcome,
    output_audio_chunks: orderedOutputAudio,
    evaluation,
    evaluation_artifact: evaluationReference,
  };
  const usageBody = { wire_chain_head_sha256: chain.chainHead, projections: usageProjections, totals: usageTotals };
  const toolBody = { wire_chain_head_sha256: chain.chainHead, expected_arguments_sha256: input.plan.probe.expected_tool_arguments_sha256, calls: gatewayCalls };
  const [wireEvidence, usageEvidence, toolEvidence, speechEvidence] = await Promise.all([
    putCas(input.cas, Buffer.from(`${WIRE_DOMAIN}${canonicalJson(sanitizedWire)}`, "utf8"), "application/octet-stream"),
    putCas(input.cas, Buffer.from(`${USAGE_DOMAIN}${canonicalJson(usageBody)}`, "utf8"), "application/octet-stream"),
    putCas(input.cas, Buffer.from(`${TOOL_DOMAIN}${canonicalJson(toolBody)}`, "utf8"), "application/octet-stream"),
    putCas(input.cas, Buffer.from(`${SPEECH_DOMAIN}${canonicalJson(speechBody)}`, "utf8"), "application/octet-stream"),
  ]);
  const budgetConsumption = await input.authority.settleAfterUsage({
    claim: input.pre_open_claim,
    usage_evidence_sha256: usageEvidence.artifact_sha256,
    settled_micro_usd: cost.micro_usd ?? 0,
    maximum_total_micro_usd: input.plan.budget.maximum_micro_usd,
  });
  const { consumption_sha256: claimedConsumption, ...consumptionBody } = budgetConsumption;
  if (lc4ControlStressBudgetConsumptionSha256(consumptionBody) !== claimedConsumption
    || budgetConsumption.schema_version !== 1
    || budgetConsumption.plan_sha256 !== input.plan.plan_sha256
    || budgetConsumption.reservation_binding_sha256 !== input.plan.budget.reservation_binding_sha256
    || budgetConsumption.cell_id !== cell.cell_id
    || budgetConsumption.attempt_ordinal !== 1
    || budgetConsumption.pre_open_claim_sha256 !== input.pre_open_claim.claim_sha256
    || budgetConsumption.usage_evidence_sha256 !== usageEvidence.artifact_sha256
    || budgetConsumption.settled_micro_usd !== (cost.micro_usd ?? 0)
    || !Number.isSafeInteger(budgetConsumption.cumulative_settled_micro_usd)
    || budgetConsumption.cumulative_settled_micro_usd < budgetConsumption.settled_micro_usd
    || budgetConsumption.cumulative_settled_micro_usd > input.plan.budget.maximum_micro_usd) {
    throw new Error("control-stress one-shot budget consumption is invalid or not bound to this cell");
  }
  requireHash(budgetConsumption.final_ledger_head_sha256, "control-stress final budget ledger head");
  const toolOutcome = expectedToolCalls > 0
    ? "expected_tool_observed" as const
    : otherToolCalls > 0
      ? "other_tool_observed" as const
      : "no_tool_observed" as const;
  const acceptance = signal.kind === "exact_control_hash_acknowledged"
    ? "accepted" as const
    : signal.kind === "explicit_control_rejection"
      ? "rejected" as const
      : "unverifiable" as const;
  const responseStarted = causalWindow.find((observation) => observation.sequence > submitted.sequence
    && observation.direction === "inbound"
    && ["response.created", "response.started"].includes(observation.wireType));
  const firstAudio = causalWindow.find((observation) => {
    if (observation.sequence <= submitted.sequence) return false;
    const audio = projectionRecord(projectionRecord(observation.projection).audio);
    return audio.direction === "output"
      || (observation.direction === "inbound"
        && (observation.wireType === "response.output_audio.delta" || observation.wireType === "response.audio.delta")
        && audio.validCanonicalBase64 === true);
  });
  const latency = Object.freeze({
    control_submit_to_response_started: responseStarted
      ? Math.max(0, Math.round(responseStarted.observedAtMonotonicMs - submitted.observedAtMonotonicMs))
      : null,
    control_submit_to_first_audio: firstAudio
      ? Math.max(0, Math.round(firstAudio.observedAtMonotonicMs - submitted.observedAtMonotonicMs))
      : null,
    control_submit_to_terminal: Math.max(0, Math.round(terminal.observation.observedAtMonotonicMs - submitted.observedAtMonotonicMs)),
  });
  const body = immutableJson({
    schema_version: 1,
    diagnostic_version: LC4_CONTROL_STRESS_DIAGNOSTIC_VERSION,
    claim_boundary: LC4_CONTROL_STRESS_CLAIM_BOUNDARY,
    run_id: input.plan.run_id,
    plan_sha256: input.plan.plan_sha256,
    source_commit: input.plan.source_commit,
    source_tree_sha256: input.plan.source_tree_sha256,
    budget_reservation_binding_sha256: input.plan.budget.reservation_binding_sha256,
    cell_id: cell.cell_id,
    provider: cell.provider,
    model: cell.model,
    arm: cell.arm,
    rung: cell.rung,
    attempt_ordinal: 1,
    paid_retry_count: 0,
    observed_at: input.observed_at,
    control_acceptance: acceptance,
    acceptance_signal: signal,
    response_terminal_status: terminal.status,
    tool_call_outcome: toolOutcome,
    expected_tool_call_count: expectedToolCalls,
    other_tool_call_count: otherToolCalls,
    speech_outcome: speechOutcome,
    speech_semantic_outcome: evaluation.outcome,
    latency_ms: latency,
    usage_totals: usageTotals,
    cost,
    budget_consumption: budgetConsumption,
    evidence: {
      request_artifact: cell.request_artifact,
      wire: wireEvidence,
      usage: usageEvidence,
      tool_calls: toolEvidence,
      speech: speechEvidence,
    },
    basic_transport_qualification_impact: "none",
    provider_parity_claim_allowed: false,
  }) as unknown as Omit<Lc4ControlStressResult, "result_sha256">;
  return immutableJson({ ...body, result_sha256: sha256Hex(`${RESULT_DOMAIN}${canonicalJson(body)}`) }) as unknown as Lc4ControlStressResult;
}

export function assertLc4ControlStressResult(result: Lc4ControlStressResult, plan: Lc4ControlStressPlan): void {
  const { result_sha256: claimed, ...body } = result;
  requireHash(claimed, "control-stress result");
  if (sha256Hex(`${RESULT_DOMAIN}${canonicalJson(body)}`) !== claimed) throw new Error("control-stress result hash mismatch");
  if (result.plan_sha256 !== plan.plan_sha256
    || result.run_id !== plan.run_id
    || result.source_commit !== plan.source_commit
    || result.source_tree_sha256 !== plan.source_tree_sha256
    || result.budget_reservation_binding_sha256 !== plan.budget.reservation_binding_sha256
    || result.attempt_ordinal !== 1
    || result.paid_retry_count !== 0
    || result.basic_transport_qualification_impact !== "none"
    || result.provider_parity_claim_allowed !== false
    || result.claim_boundary !== LC4_CONTROL_STRESS_CLAIM_BOUNDARY) {
    throw new Error("control-stress result differs from its source, plan, budget, no-retry, or claim boundary");
  }
  if (result.cost.source === "conservative_reserved_ceiling") {
    if (result.cost.micro_usd !== plan.budget.maximum_micro_usd
      || result.cost.pricing_snapshot_sha256 !== null || result.cost.formula_sha256 !== null) {
      throw new Error("control-stress conservative cost differs from its full reserved ceiling");
    }
  } else {
    requireHash(result.cost.pricing_snapshot_sha256, "control-stress result pricing snapshot");
    requireHash(result.cost.formula_sha256, "control-stress result pricing formula");
    if (!Number.isSafeInteger(result.cost.micro_usd) || result.cost.micro_usd === null
      || result.cost.micro_usd < 0 || result.cost.micro_usd > plan.budget.maximum_micro_usd) {
      throw new Error("control-stress result cost exceeds its frozen budget");
    }
  }
  const { consumption_sha256: consumptionClaimed, ...consumptionBody } = result.budget_consumption;
  if (lc4ControlStressBudgetConsumptionSha256(consumptionBody) !== consumptionClaimed
    || result.budget_consumption.schema_version !== 1
    || result.budget_consumption.plan_sha256 !== plan.plan_sha256
    || result.budget_consumption.reservation_binding_sha256 !== plan.budget.reservation_binding_sha256
    || result.budget_consumption.cell_id !== result.cell_id
    || result.budget_consumption.attempt_ordinal !== 1
    || result.budget_consumption.usage_evidence_sha256 !== result.evidence.usage.artifact_sha256
    || result.budget_consumption.settled_micro_usd !== (result.cost.micro_usd ?? 0)
    || result.budget_consumption.cumulative_settled_micro_usd < result.budget_consumption.settled_micro_usd
    || result.budget_consumption.cumulative_settled_micro_usd > plan.budget.maximum_micro_usd) {
    throw new Error("control-stress result budget consumption is invalid");
  }
  const cell = plan.cells.find((candidate) => candidate.cell_id === result.cell_id);
  if (!cell || cell.disposition !== "scheduled" || cell.provider !== result.provider
    || cell.model !== result.model || cell.arm !== result.arm || cell.rung !== result.rung) {
    throw new Error("control-stress result differs from its frozen scheduled cell");
  }
}

function parseDomainEvidence(bytes: Uint8Array, domain: string, label: string): unknown {
  const retained = Buffer.from(bytes).toString("utf8");
  if (!retained.startsWith(domain)) throw new Error(`${label} has the wrong evidence domain`);
  const payload = retained.slice(domain.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`${label} is not canonical JSON`);
  }
  if (canonicalJson(parsed as JsonValue) !== payload) throw new Error(`${label} is not canonical JSON`);
  return parsed;
}

/** Reopens every result artifact and independently checks the derived counters and cross-artifact custody. */
export async function verifyLc4ControlStressResult(
  result: Lc4ControlStressResult,
  plan: Lc4ControlStressPlan,
  cas: Pick<Lc4DevReplayCasPort, "get">,
): Promise<void> {
  await verifyLc4ControlStressPlan(plan, cas);
  assertLc4ControlStressResult(result, plan);
  const cell = plan.cells.find((candidate) => candidate.cell_id === result.cell_id)!;
  if (cell.request_artifact === null
    || canonicalJson(result.evidence.request_artifact) !== canonicalJson(cell.request_artifact)) {
    throw new Error("control-stress result request evidence differs from its frozen cell");
  }
  const [wireBytes, usageBytes, toolBytes, speechBytes] = await Promise.all([
    assertCasBytes(cas, result.evidence.wire, "control-stress result wire evidence"),
    assertCasBytes(cas, result.evidence.usage, "control-stress result usage evidence"),
    assertCasBytes(cas, result.evidence.tool_calls, "control-stress result tool evidence"),
    assertCasBytes(cas, result.evidence.speech, "control-stress result speech evidence"),
  ]);
  const wire = parseDomainEvidence(wireBytes, WIRE_DOMAIN, "control-stress result wire evidence");
  if (!Array.isArray(wire) || wire.length < 2) throw new Error("control-stress result wire evidence is empty");
  const observations = wire.map((entry) => record(entry, "control-stress retained wire observation"));
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    requireHash(observation.observation_sha256, "control-stress retained wire observation");
    const expectedPrevious = index === 0 ? null : observations[index - 1]!.observation_sha256;
    if (observation.previous_observation_sha256 !== expectedPrevious) {
      throw new Error("control-stress retained wire evidence breaks its observation chain");
    }
  }
  const wireHead = observations.at(-1)!.observation_sha256;
  const usage = record(parseDomainEvidence(usageBytes, USAGE_DOMAIN, "control-stress result usage evidence"), "control-stress usage body");
  const tools = record(parseDomainEvidence(toolBytes, TOOL_DOMAIN, "control-stress result tool evidence"), "control-stress tool body");
  const speech = record(parseDomainEvidence(speechBytes, SPEECH_DOMAIN, "control-stress result speech evidence"), "control-stress speech body");
  if (usage.wire_chain_head_sha256 !== wireHead || tools.wire_chain_head_sha256 !== wireHead) {
    throw new Error("control-stress result evidence artifacts disagree on the wire-chain head");
  }
  if (canonicalJson(usage.totals as JsonValue) !== canonicalJson(result.usage_totals)) {
    throw new Error("control-stress result usage totals differ from retained usage evidence");
  }
  const calls = projectionArray(tools.calls);
  const expectedCalls = calls.filter((call) => call.gateway === plan.probe.expected_tool_name
    && call.argumentsSha256 === plan.probe.expected_tool_arguments_sha256).length;
  if (expectedCalls !== result.expected_tool_call_count
    || calls.length - expectedCalls !== result.other_tool_call_count
    || result.tool_call_outcome !== (expectedCalls > 0 ? "expected_tool_observed" : calls.length > 0 ? "other_tool_observed" : "no_tool_observed")) {
    throw new Error("control-stress result tool outcome differs from retained tool evidence");
  }
  const evaluation = record(speech.evaluation, "control-stress retained speech evaluation");
  const audio = projectionArray(speech.output_audio_chunks).map((chunk) => ({
    sha256: chunk.sha256,
    byteLength: chunk.byteLength,
  }));
  if (speech.capture !== result.speech_outcome
    || evaluation.outcome !== result.speech_semantic_outcome
    || evaluation.speech_oracle_sha256 !== plan.probe.speech_oracle_sha256
    || evaluation.wire_chain_head_sha256 !== wireHead
    || evaluation.ordered_output_audio_sha256 !== sha256Hex(canonicalJson(audio))) {
    throw new Error("control-stress result speech outcome differs from retained speech evidence");
  }
  const evaluationReference = speech.evaluation_artifact as Lc4ControlStressCasReference;
  const evaluationBytes = await assertCasBytes(cas, evaluationReference, "control-stress retained speech evaluation artifact");
  if (canonicalJson(JSON.parse(Buffer.from(evaluationBytes).toString("utf8")) as JsonValue) !== canonicalJson(evaluation as JsonValue)) {
    throw new Error("control-stress embedded speech evaluation differs from its retained artifact");
  }
}
