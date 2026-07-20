import { z } from "zod";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  ProviderPricingProofSchema,
  type ProviderPricingProof,
  verifyProviderPricingProofStructure,
} from "./provider-pricing-proof";
import type { ServerRealtimeProvider } from "../realtime/client/types";
import {
  PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256,
  PAID_PREFLIGHT_TAMPER_TESTS,
} from "./paid-preflight-emulator-manifest";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

const CommandEvidenceSchema = z.object({
  id: IdentifierSchema,
  cwd: z.string().min(1).max(4096),
  argv: z.array(z.string().max(4096)).min(1).max(64),
  exit_code: z.number().int().min(0).max(255),
  stdout_sha256: HashSchema,
  stderr_sha256: HashSchema,
  combined_log_sha256: HashSchema,
  raw_logs: z.literal("restricted_local_0600"),
  provider_environment_removed: z.literal(true),
  duration_ms: z.number().int().nonnegative(),
}).strict();

const CheckSchema = z.object({
  id: IdentifierSchema,
  status: z.enum(["pass", "fail", "blocked"]),
  required_for: z.array(z.enum(["gate_0", "gate_1", "c3", "c4", "c5"])).min(1),
  command_ids: z.array(IdentifierSchema).max(16),
  evidence_sha256: HashSchema,
  reason_codes: z.array(IdentifierSchema).max(32),
  observed: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
}).strict();

const PacketBodySchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("hacc_pre_canary_no_spend_proof"),
  generated_at: z.string().datetime(),
  source: z.object({
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    tree: z.string().regex(/^[a-f0-9]{40,64}$/),
    clean: z.boolean(),
    status_sha256: HashSchema,
    publishable_file_manifest_sha256: HashSchema.nullable(),
  }).strict(),
  provider_boundary: z.object({
    offline_entrypoint: z.literal("web/scripts/voice-benchmark-offline.ts"),
    runtime_import_closure_sha256: HashSchema,
    runtime_input_count: z.number().int().positive(),
    packet_entrypoint: z.literal("web/scripts/pre-canary-proof.ts"),
    packet_runtime_import_closure_sha256: HashSchema,
    packet_runtime_input_count: z.number().int().positive(),
    forbidden_runtime_inputs: z.array(z.string()).max(64),
    external_socket_imports: z.array(z.string()).max(64),
    provider_client_construction_reachable: z.boolean(),
    paid_executor_supplied: z.literal(false),
    packet_provider_sessions_opened: z.literal(0),
    validation_contract_constructs_idle_clients: z.boolean(),
  }).strict(),
  budget: z.object({
    ledger_verified: z.boolean(),
    ledger_id: z.string().min(1).max(256).nullable(),
    ledger_head_sha256: HashSchema.nullable(),
    state: z.enum(["missing", "invalid", "paused", "open", "closed"]),
    paused: z.boolean(),
    active_reservations_micro_usd: z.number().int().nonnegative(),
    conservative_settled_micro_usd: z.number().int().nonnegative(),
    scheduling_exposure_micro_usd: z.number().int().nonnegative(),
    provider_spend_usd: z.literal("0"),
  }).strict(),
  freeze: z.object({
    verified: z.boolean(),
    freeze_lock_sha256: HashSchema.nullable(),
    evidence_class: z.enum(["missing", "canary", "pilot", "confirmatory"]),
    source_commit_matches: z.boolean(),
  }).strict(),
  pricing: z.object({
    gate_1_reservation_micro_usd_per_provider: z.literal(5_000_000),
    executable_proof_count: z.number().int().min(0).max(3),
    all_provider_proofs_verified: z.boolean(),
    provider_proof_sha256: z.object({
      openai: HashSchema.nullable(),
      xai: HashSchema.nullable(),
      gemini: HashSchema.nullable(),
    }).strict(),
    provider_proofs: z.object({
      openai: ProviderPricingProofSchema.refine((proof) => proof.snapshot.provider === "openai").nullable(),
      xai: ProviderPricingProofSchema.refine((proof) => proof.snapshot.provider === "xai").nullable(),
      gemini: ProviderPricingProofSchema.refine((proof) => proof.snapshot.provider === "gemini").nullable(),
    }).strict(),
  }).strict(),
  determinism: z.object({
    run_id: IdentifierSchema,
    historical_minimum_file_count: z.literal(49),
    observed_file_count_a: z.number().int().nonnegative(),
    observed_file_count_b: z.number().int().nonnegative(),
    exact_path_set_match: z.boolean(),
    exact_byte_match: z.boolean(),
    tree_sha256_a: HashSchema.nullable(),
    tree_sha256_b: HashSchema.nullable(),
    network_calls: z.literal(0),
    spend_usd: z.literal("0"),
  }).strict(),
  commands: z.array(CommandEvidenceSchema).max(64),
  checks: z.array(CheckSchema).max(128),
  artifacts: z.array(z.object({
    id: IdentifierSchema,
    path: z.string().min(1).max(4096),
    sha256: HashSchema,
    byte_length: z.number().int().nonnegative(),
    classification: z.enum(["public", "restricted_local"]),
  }).strict()).max(256),
  decision: z.object({
    gate_0_evidence_complete: z.boolean(),
    gate_1_ready_for_manual_release: z.boolean(),
    gate_1_release_authorized: z.literal(false),
    paid_execution_authorized: z.literal(false),
    c3_transport_ready: z.literal(false),
    c4_effectiveness_ready: z.literal(false),
    c5_confirmatory_ready: z.literal(false),
    blocking_check_ids: z.array(IdentifierSchema).readonly(),
  }).strict(),
}).strict();

export const PreCanaryProofPacketSchema = PacketBodySchema.extend({
  packet_sha256: HashSchema,
}).strict();

export type PreCanaryProofPacketBody = z.infer<typeof PacketBodySchema>;
export type PreCanaryProofPacket = z.infer<typeof PreCanaryProofPacketSchema>;
export type PreCanaryProofCheck = z.infer<typeof CheckSchema>;
export type PreCanaryProofCommand = z.infer<typeof CommandEvidenceSchema>;

const GATE_0_REQUIRED_CHECK_IDS = Object.freeze([
  "source.clean",
  "source.public_history",
  "source.working_tree_secrets",
  "provider.offline_import_boundary",
  "provider.paid_preflight_emulator",
  "budget.paused_zero",
  "freeze.verified",
  "web.tests",
  "web.lint",
  "web.typecheck",
  "web.build",
  "bridge.syntax",
  "bridge.tests",
  "database.isolation",
  "manifest.long_horizon",
  "transcript.signed_replay",
  "offline.determinism",
] as const);

const GATE_1_REQUIRED_CHECK_IDS = Object.freeze([
  "pricing.gate1_executable_proofs",
] as const);

export const PRE_CANARY_GATE_0_REQUIRED_CHECK_IDS = GATE_0_REQUIRED_CHECK_IDS;
export const PRE_CANARY_GATE_1_REQUIRED_CHECK_IDS = GATE_1_REQUIRED_CHECK_IDS;

const CANONICAL_MIGRATION_FILENAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

export type PreCanaryMigrationSequence = Readonly<{
  canonical_files: readonly string[];
  migration_count: number;
  first_id: number | null;
  latest_id: number | null;
  invalid_sql_filename_count: number;
  duplicate_id_count: number;
  contiguous_from_001_to_latest: boolean;
}>;

/**
 * Proves the complete SQL migration directory is canonical and gap-free
 * without embedding a release-specific latest migration number.
 */
export function analyzePreCanaryMigrationSequence(
  directoryEntries: readonly string[],
): PreCanaryMigrationSequence {
  const sqlFiles = directoryEntries
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const canonicalFiles = sqlFiles.filter((name) =>
    CANONICAL_MIGRATION_FILENAME.test(name)
  );
  const ids = canonicalFiles.map((name) => {
    const match = CANONICAL_MIGRATION_FILENAME.exec(name);
    return match ? Number.parseInt(match[1], 10) : Number.NaN;
  });
  const duplicateIdCount = ids.length - new Set(ids).size;
  const invalidSqlFilenameCount = sqlFiles.length - canonicalFiles.length;
  return Object.freeze({
    canonical_files: Object.freeze(canonicalFiles),
    migration_count: canonicalFiles.length,
    first_id: ids.at(0) ?? null,
    latest_id: ids.at(-1) ?? null,
    invalid_sql_filename_count: invalidSqlFilenameCount,
    duplicate_id_count: duplicateIdCount,
    contiguous_from_001_to_latest: ids.length > 0
      && invalidSqlFilenameCount === 0
      && duplicateIdCount === 0
      && ids.every((id, index) => id === index + 1),
  });
}

export function preCanaryWebTestsComplete(input: Readonly<{
  exit_code: number;
  success: boolean;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  pending_tests: number;
  expected_conditional_pending_tests: number;
}>): boolean {
  return input.exit_code === 0
    && input.success
    && input.total_tests > 0
    && input.failed_tests === 0
    && input.pending_tests === input.expected_conditional_pending_tests
    && input.passed_tests + input.pending_tests === input.total_tests;
}

export function preCanaryConditionalDatabaseTestsComplete(input: Readonly<{
  inventory_sha256: string;
  expected_inventory_sha256: string;
  test_file_count: number;
  expected_test_file_count: number;
  total_tests: number;
  expected_total_tests: number;
  passed_tests: number;
  failed_tests: number;
  pending_tests: number;
  provider_sessions_opened: number;
  spend_usd: number;
}>): boolean {
  return HashSchema.safeParse(input.inventory_sha256).success
    && input.inventory_sha256 === input.expected_inventory_sha256
    && input.test_file_count === input.expected_test_file_count
    && input.total_tests === input.expected_total_tests
    && input.passed_tests === input.expected_total_tests
    && input.failed_tests === 0
    && input.pending_tests === 0
    && input.provider_sessions_opened === 0
    && input.spend_usd === 0;
}

export function preCanarySourceSnapshotStable(input: Readonly<{
  opening_head_sha256: string;
  closing_head_sha256: string;
  opening_tree_sha256: string;
  closing_tree_sha256: string;
  opening_status_sha256: string;
  closing_status_sha256: string;
  opening_reachable_history_sha256: string;
  closing_reachable_history_sha256: string;
}>): boolean {
  return input.opening_head_sha256 === input.closing_head_sha256
    && input.opening_tree_sha256 === input.closing_tree_sha256
    && input.opening_status_sha256 === input.closing_status_sha256
    && input.opening_reachable_history_sha256 === input.closing_reachable_history_sha256;
}

export function preCanaryProofCheckEvidenceSha256(
  input: Omit<PreCanaryProofCheck, "evidence_sha256">
): string {
  return sha256Hex(`hacc/pre-canary-check/v1\n${canonicalJson(input)}`);
}

export function createPreCanaryProofCheck(
  input: Omit<PreCanaryProofCheck, "evidence_sha256">
): PreCanaryProofCheck {
  return CheckSchema.parse({ ...input, evidence_sha256: preCanaryProofCheckEvidenceSha256(input) });
}

export function preCanaryProofPacketSha256(body: PreCanaryProofPacketBody): string {
  return sha256Hex(`hacc/pre-canary-proof/v1\n${canonicalJson(PacketBodySchema.parse(body))}`);
}

function derivedDecision(
  checks: readonly PreCanaryProofCheck[],
  pricing: PreCanaryProofPacketBody["pricing"],
  generatedAt: string
): PreCanaryProofPacketBody["decision"] {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const blockingCheckIds = GATE_0_REQUIRED_CHECK_IDS
    .filter((id) => byId.get(id)?.status !== "pass")
    .sort();
  const gate0Complete = blockingCheckIds.length === 0;
  const gate1Ready = gate0Complete
    && pricingProofsCoherent(pricing, generatedAt)
    && GATE_1_REQUIRED_CHECK_IDS.every((id) => byId.get(id)?.status === "pass");
  return Object.freeze({
    gate_0_evidence_complete: gate0Complete,
    gate_1_ready_for_manual_release: gate1Ready,
    gate_1_release_authorized: false as const,
    paid_execution_authorized: false as const,
    c3_transport_ready: false as const,
    c4_effectiveness_ready: false as const,
    c5_confirmatory_ready: false as const,
    blocking_check_ids: Object.freeze(blockingCheckIds),
  });
}

function pricingProofsCoherent(
  pricing: PreCanaryProofPacketBody["pricing"],
  generatedAt: string
): boolean {
  if (!pricing.all_provider_proofs_verified || pricing.executable_proof_count !== 3) return false;
  const now = new Date(generatedAt);
  if (!Number.isFinite(now.getTime())) return false;
  for (const provider of ["openai", "xai", "gemini"] as const) {
    const proof = pricing.provider_proofs[provider];
    if (
      !proof
      || proof.snapshot.provider !== provider
      || pricing.provider_proof_sha256[provider] !== proof.proof_sha256
      || !verifyProviderPricingProofStructure({ proof, now }).valid
    ) return false;
  }
  return true;
}

export function createPreCanaryProofPacket(
  input: Omit<PreCanaryProofPacketBody, "decision">
): PreCanaryProofPacket {
  const checks = Object.freeze(input.checks.map((check) => CheckSchema.parse(check)));
  const body = PacketBodySchema.parse({
    ...input,
    checks,
    decision: derivedDecision(checks, input.pricing, input.generated_at),
  });
  return PreCanaryProofPacketSchema.parse({ ...body, packet_sha256: preCanaryProofPacketSha256(body) });
}

function passIsCoherent(packet: PreCanaryProofPacket, check: PreCanaryProofCheck): boolean {
  if (check.status !== "pass") return true;
  switch (check.id) {
    case "source.clean":
      return packet.source.clean
        && check.observed.clean === true
        && check.observed.stable_snapshot === true
        && check.observed.reachable_history_stable === true
        && check.observed.opening_status_bytes === 0
        && check.observed.closing_status_bytes === 0;
    case "source.public_history":
      return check.observed.finding_count === 0
        && typeof check.observed.reachable_commit_count === "number"
        && check.observed.reachable_commit_count > 0;
    case "source.working_tree_secrets":
      return packet.source.publishable_file_manifest_sha256 !== null
        && check.observed.finding_count === 0;
    case "provider.offline_import_boundary":
      return !packet.provider_boundary.provider_client_construction_reachable
        && packet.provider_boundary.forbidden_runtime_inputs.length === 0
        && packet.provider_boundary.external_socket_imports.length === 0
        && packet.provider_boundary.packet_runtime_import_closure_sha256 !== "0".repeat(64)
        && packet.provider_boundary.packet_runtime_input_count > 0
        && !packet.provider_boundary.paid_executor_supplied
        && packet.provider_boundary.packet_provider_sessions_opened === 0;
    case "provider.paid_preflight_emulator":
      return check.observed.tamper_credential_reads === 0
        && check.observed.tamper_client_constructions === 0
        && check.observed.tamper_reservations_consumed === 0
        && check.observed.tamper_cases_passed === check.observed.tamper_cases_total
        && check.observed.tamper_cases_total === PAID_PREFLIGHT_TAMPER_TESTS.length
        && check.observed.happy_path_passed === true
        && check.observed.manifest_sha256 === PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256;
    case "budget.paused_zero":
      return packet.budget.ledger_verified
        && packet.budget.ledger_id !== null
        && packet.budget.ledger_head_sha256 !== null
        && packet.budget.state === "paused"
        && packet.budget.paused
        && packet.budget.active_reservations_micro_usd === 0
        && packet.budget.conservative_settled_micro_usd === 0
        && packet.budget.scheduling_exposure_micro_usd === 0;
    case "freeze.verified":
      return packet.freeze.verified
        && packet.freeze.freeze_lock_sha256 !== null
        && packet.freeze.evidence_class !== "missing"
        && packet.freeze.source_commit_matches;
    case "offline.determinism":
      return packet.determinism.observed_file_count_a >= packet.determinism.historical_minimum_file_count
        && packet.determinism.observed_file_count_b >= packet.determinism.historical_minimum_file_count
        && packet.determinism.exact_path_set_match
        && packet.determinism.exact_byte_match
        && packet.determinism.tree_sha256_a !== null
        && packet.determinism.tree_sha256_a === packet.determinism.tree_sha256_b;
    case "pricing.gate1_executable_proofs":
      return pricingProofsCoherent(packet.pricing, packet.generated_at);
    default:
      return check.command_ids.length > 0;
  }
}

export function verifyPreCanaryProofPacket(input: unknown): Readonly<{
  valid: boolean;
  errors: readonly string[];
  packet: PreCanaryProofPacket | null;
}> {
  const parsed = PreCanaryProofPacketSchema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({ valid: false, errors: Object.freeze(["packet_schema_invalid"]), packet: null });
  }
  const packet = parsed.data;
  const { packet_sha256: _packetSha256, ...body } = packet;
  void _packetSha256;
  const errors: string[] = [];
  if (preCanaryProofPacketSha256(body) !== packet.packet_sha256) errors.push("packet_hash_mismatch");
  if (canonicalJson(packet.decision) !== canonicalJson(derivedDecision(
    packet.checks,
    packet.pricing,
    packet.generated_at
  ))) {
    errors.push("decision_not_derived_from_checks");
  }
  const commandIds = new Set<string>();
  for (const command of packet.commands) {
    if (commandIds.has(command.id)) errors.push("duplicate_command_id");
    commandIds.add(command.id);
  }
  const checkIds = new Set<string>();
  for (const check of packet.checks) {
    if (checkIds.has(check.id)) errors.push("duplicate_check_id");
    checkIds.add(check.id);
    const { evidence_sha256: _evidenceSha256, ...evidenceBody } = check;
    void _evidenceSha256;
    if (preCanaryProofCheckEvidenceSha256(evidenceBody) !== check.evidence_sha256) {
      errors.push("check_evidence_hash_mismatch");
    }
    if (check.command_ids.some((commandId) => !commandIds.has(commandId))) {
      errors.push("check_command_missing");
    }
    if (!passIsCoherent(packet, check)) errors.push("pass_status_incoherent");
  }
  if (new Set(packet.artifacts.map((artifact) => artifact.id)).size !== packet.artifacts.length) {
    errors.push("duplicate_artifact_id");
  }
  if (new Set(packet.artifacts.map((artifact) => artifact.path)).size !== packet.artifacts.length) {
    errors.push("duplicate_artifact_path");
  }
  if (packet.provider_boundary.provider_client_construction_reachable) errors.push("provider_client_reachable");
  if (packet.provider_boundary.forbidden_runtime_inputs.length > 0) errors.push("forbidden_runtime_input");
  if (packet.provider_boundary.external_socket_imports.length > 0) errors.push("external_socket_import");
  if (packet.budget.provider_spend_usd !== "0") errors.push("nonzero_provider_spend");
  if (packet.pricing.all_provider_proofs_verified && !pricingProofsCoherent(packet.pricing, packet.generated_at)) {
    errors.push("pricing_proof_claim_invalid");
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze([...new Set(errors)].sort()), packet });
}

export type PaidReleaseGateExpectation = Readonly<{
  provider: ServerRealtimeProvider;
  model: string;
  evidenceClass: "canary" | "pilot" | "confirmatory";
  sourceCommit: string;
  sourceTree: string;
  freezeLockSha256: string;
  ledgerId: string;
  now?: Date;
}>;

export type VerifiedPaidReleaseGate = Readonly<{
  packet: PreCanaryProofPacket;
  providerPricingProof: ProviderPricingProof;
}>;

/**
 * Re-verifies the exact no-spend packet at every paid boundary.
 *
 * A packet being structurally valid is deliberately insufficient: its derived
 * Gate 0/Gate 1 decisions, source checkout, freeze, zero-spend ledger identity,
 * selected provider/model proof, and proof freshness must all match the paid
 * execution inputs. This function does not authorize spend by itself; the
 * plan-hash and exact-maximum confirmations remain separate operator actions.
 */
export function verifyPaidReleaseGate(
  input: unknown,
  expected: PaidReleaseGateExpectation,
): Readonly<{
  valid: boolean;
  errors: readonly string[];
  value: VerifiedPaidReleaseGate | null;
}> {
  const verification = verifyPreCanaryProofPacket(input);
  if (!verification.valid || !verification.packet) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze([
        "pre_canary_packet_invalid",
        ...verification.errors,
      ].sort()),
      value: null,
    });
  }
  const packet = verification.packet;
  const errors: string[] = [];
  if (!packet.decision.gate_0_evidence_complete) errors.push("gate_0_incomplete");
  if (!packet.decision.gate_1_ready_for_manual_release) errors.push("gate_1_not_ready");
  if (!packet.source.clean) errors.push("source_not_clean");
  if (packet.source.commit !== expected.sourceCommit) errors.push("source_commit_mismatch");
  if (packet.source.tree !== expected.sourceTree) errors.push("source_tree_mismatch");
  if (
    !packet.freeze.verified
    || packet.freeze.freeze_lock_sha256 !== expected.freezeLockSha256
    || packet.freeze.evidence_class !== expected.evidenceClass
    || !packet.freeze.source_commit_matches
  ) errors.push("freeze_mismatch");
  if (
    !packet.budget.ledger_verified
    || packet.budget.ledger_id !== expected.ledgerId
    || packet.budget.state !== "paused"
    || !packet.budget.paused
    || packet.budget.active_reservations_micro_usd !== 0
    || packet.budget.conservative_settled_micro_usd !== 0
    || packet.budget.scheduling_exposure_micro_usd !== 0
    || packet.budget.provider_spend_usd !== "0"
  ) errors.push("gate_0_budget_mismatch");

  const proof = packet.pricing.provider_proofs[expected.provider];
  const proofHash = packet.pricing.provider_proof_sha256[expected.provider];
  if (
    !proof
    || proofHash !== proof.proof_sha256
    || proof.snapshot.provider !== expected.provider
    || proof.snapshot.model !== expected.model
  ) {
    errors.push("provider_pricing_proof_mismatch");
  } else {
    const proofVerification = verifyProviderPricingProofStructure({
      proof,
      now: expected.now ?? new Date(),
    });
    if (!proofVerification.valid) errors.push("provider_pricing_proof_stale_or_invalid");
  }

  const uniqueErrors = Object.freeze([...new Set(errors)].sort());
  return Object.freeze({
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
    value: uniqueErrors.length === 0 && proof
      ? Object.freeze({ packet, providerPricingProof: proof })
      : null,
  });
}
