import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  assertProviderQualificationArtifactIntegrity,
  providerQualificationMatrixSha256,
  qualifyProviders,
  XAI_SERVER_VAD_CONDITIONAL_POLICY_SHA256,
  XAI_SERVER_VAD_SETTING_SHA256,
  type ProviderQualificationArtifact,
  type ProviderQualificationTarget,
} from "./provider-qualification";
import {
  LC4_S2S_COMPACT_CONTROL,
  LC4_S2S_COMPACT_CONTROL_SHA256,
  LC4_S2S_PACKETIZER_SHA256,
  LC4_S2S_TOOL,
  LC4_S2S_TOOL_SCHEMA_SHA256,
  LC4_S2S_VOICE_SHA256,
  assertLc4S2sRoundtripExecution,
  executeLc4S2sToolRoundtrip,
  lc4S2sControlSizeDiagnostic,
  loadLc4S2sPcm,
  materializeLc4S2sAudioFixture,
  type Lc4S2sAudioFixtureArtifact,
  type Lc4S2sAudioRenderer,
  type Lc4S2sRoundtripExecution,
} from "./provider-s2s-tool-roundtrip";
import {
  createProductionRealtimeClient,
  productionOpenAiCompatibleSessionUpdate,
  productionSessionPayloadParitySha256,
} from "./production-realtime-provider";
import { parseBenchmarkEnvironmentFile } from "./environment";
import {
  LIVE_STS_PROVIDER_SPECS,
  type LiveStsProvider,
} from "./live-sts-development-experiment";
import {
  DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
  trialAudioDeliveryProfileHash,
  type TrialSessionConfiguration,
} from "./orchestrator";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  assertLc4ProviderProfileManifest,
} from "./lc4-provider-profiles";
import type { NormalizedRealtimeClient, RealtimeWireObservation } from "../realtime/client/types";
import {
  withXaiServerVadPcmSession,
  xaiServerVadTransportParitySha256,
} from "../realtime/client/openai-compatible";
import { verifyRealtimeWireObservationChain } from "../realtime/client/wire-evidence";
import {
  replayProviderToolRoundtrip,
  type RoundtripSanitizedUsage,
} from "./provider-roundtrip-replay";
import {
  createLc4QualificationPayloadManifestV5,
  createSignedLc4QualificationPackageEnvelopeV5,
  readLc4QualificationPackageDirectoryV5,
  verifySignedLc4QualificationPackageEnvelopeV5,
  type Lc4QualificationPackageBindingsV5,
  type Lc4QualificationPackageFile,
  type Lc4QualificationTerminalClaimsV5,
} from "./lc4-qualification-package-envelope";
import {
  assertLc4QualificationBudgetEvidence,
  finalizeLc4QualificationBudget,
  reserveLc4QualificationBudget,
  type Lc4QualificationBudgetBinding,
  type Lc4QualificationBudgetEvidence,
} from "./lc4-qualification-budget";

export const LC4_QUALIFICATION_V3_RUNNER_VERSION = "HACC-LC4-QUALIFICATION-RUNNER-v5" as const;
export const LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION = "HACC-LC4-QUALIFICATION-AUTHORIZATION-v4" as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD = 3_000_000 as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS = 6 as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS = 3 as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES = 6 as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS = 3 as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_AUTHORIZATION_TTL_MS = 3_600_000 as const;
export const LC4_QUALIFICATION_V3_PROVIDER_ORDER = Object.freeze(["openai", "gemini", "xai"] as const);
export const LC4_XAI_SERVER_VAD_SETTING_SHA256 = XAI_SERVER_VAD_SETTING_SHA256;

const PLAN_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan/v4\n";
const PLAN_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan-artifact/v4\n";
const AUTHORIZATION_DOMAIN = "harshas-amazing-call-center/lc4-qualification-authorization/v4\n";
const AUTHORIZATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-authorization-artifact/v4\n";
const TERMINAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal/v6\n";
const TERMINAL_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal-artifact/v6\n";
const REPLAY_AGGREGATE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-replay-aggregate/v1\n";
const CREDENTIAL_DOMAIN = "harshas-amazing-call-center/provider-credential/v1\n";
const CREDENTIAL_SET_DOMAIN = "harshas-amazing-call-center/provider-credential-set/v1\n";
const SOURCE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-git-tree/v1\n";
const INVOCATION_DOMAIN = "harshas-amazing-call-center/lc4-qualification-invocation/v4\n";
const INVOCATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-invocation-artifact/v4\n";
const REFUSAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-refusal/v4\n";
const REFUSAL_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-refusal-artifact/v4\n";
const REFUSAL_PACKAGE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-refusal-package/v4\n";
const REFUSAL_ERROR_DOMAIN = "harshas-amazing-call-center/lc4-qualification-refusal-error/v4\n";
const XAI_SERVER_VAD_GATE_A_RISK_DOMAIN = "harshas-amazing-call-center/xai-server-vad-gate-a-risk/v2\n";
const XAI_SERVER_VAD_GATE_B_BINDING_DOMAIN = "harshas-amazing-call-center/xai-server-vad-gate-b-binding/v1\n";
const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const MAXIMUM_CREDENTIAL_ENV_BYTES = 1024 * 1024;
const MAXIMUM_PRIVATE_KEY_BYTES = 64 * 1024;
const MAXIMUM_AUTHORIZATION_JSON_BYTES = 16 * 1024 * 1024;

export type Lc4QualificationV3GitSource = Readonly<{
  source_commit: string;
  source_tree_oid: string;
  source_tree_sha256: string;
  worktree_clean: true;
}>;

export type Lc4QualificationV3CredentialFiles = Readonly<{
  providerEnvFile: string;
  repoEnvFile: string;
}>;

export type Lc4QualificationV3BoundaryStage =
  | "cli"
  | "plan"
  | "authorization"
  | "terminal_key"
  | "invocation"
  | "source"
  | "credentials";

export type Lc4QualificationV3BoundaryCode =
  | "cli_input_invalid"
  | "plan_validation_failed"
  | "authorization_validation_failed"
  | "terminal_key_validation_failed"
  | "authorization_already_invoked"
  | "invocation_retention_failed"
  | "source_inspection_failed"
  | "source_mismatch"
  | "credential_source_invalid"
  | "credential_missing"
  | "credential_set_mismatch"
  | "refusal_retention_failed"
  | "unexpected_failure";

export class Lc4QualificationV3BoundaryError extends Error {
  readonly stage: Lc4QualificationV3BoundaryStage;
  readonly code: Lc4QualificationV3BoundaryCode;

  constructor(stage: Lc4QualificationV3BoundaryStage, code: Lc4QualificationV3BoundaryCode) {
    super(`LC4 qualification v3 boundary refusal: ${stage}:${code}`);
    this.name = "Lc4QualificationV3BoundaryError";
    this.stage = stage;
    this.code = code;
  }
}

export type Lc4QualificationV3PlanBody = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_QUALIFICATION_V3_RUNNER_VERSION;
  protocol_id: "HACC-LC4-v1";
  plan_id: string;
  prepared_at: string;
  source: Lc4QualificationV3GitSource;
  provider_profile_manifest_sha256: string;
  setup_configuration_matrix_sha256: string;
  credential_set_sha256: string;
  credential_identities: readonly Readonly<{ provider: LiveStsProvider; credential_sha256: string }>[];
  audio_fixture: Lc4S2sAudioFixtureArtifact;
  control_size_diagnostic: ReturnType<typeof lc4S2sControlSizeDiagnostic>;
  targets: readonly Readonly<{
    provider: LiveStsProvider;
    model: string;
    sample_rate_hz: 16_000 | 24_000;
    caller_audio_bytes: number;
    caller_audio_sha256: string;
    caller_audio_cas_sha256: string;
    caller_audio_duration_ms: number;
    gateway_schema_sha256: typeof LC4_S2S_TOOL_SCHEMA_SHA256;
    voice_sha256: typeof LC4_S2S_VOICE_SHA256;
    compact_control_sha256: typeof LC4_S2S_COMPACT_CONTROL_SHA256;
    packetizer_sha256: typeof LC4_S2S_PACKETIZER_SHA256;
    audio_delivery_profile_sha256: string;
    production_session_payload_sha256: string | null;
    xai_transport_parity_sha256: string | null;
    setup_sessions: 1;
    paid_sessions: 1;
    generation_phases: 2;
    tool_roundtrips: 1;
  }>[];
  execution_scope: "gate_a_setup_acceptance_then_gate_b_spoken_tool_roundtrip_gate_c_diagnostic_only";
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD;
  maximum_provider_sessions: typeof LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS;
  maximum_paid_sessions: typeof LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS;
  maximum_generation_phases: typeof LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES;
  maximum_tool_roundtrips: typeof LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS;
  paid_retry_allowed: false;
  provider_calls_authorized: false;
  plan_sha256: string;
}>;

type SignedArtifact<Body> = Readonly<{
  body: Body;
  authority_public_key_spki_base64: string;
  authority_public_key_fingerprint_sha256: string;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  artifact_sha256: string;
}>;

export type Lc4QualificationV3PlanArtifact = SignedArtifact<Lc4QualificationV3PlanBody>;

export type Lc4QualificationV3AuthorizationBody = Readonly<{
  schema_version: 1;
  authorization_version: typeof LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION;
  authorization_id: string;
  authorization_nonce_sha256: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  credential_set_sha256: string;
  terminal_public_key_spki_base64: string;
  terminal_public_key_fingerprint_sha256: string;
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD;
  maximum_provider_sessions: typeof LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS;
  maximum_paid_sessions: typeof LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS;
  maximum_generation_phases: typeof LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES;
  maximum_tool_roundtrips: typeof LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS;
  paid_retry_allowed: false;
  not_before: string;
  expires_at: string;
}>;

export type Lc4QualificationV3AuthorizationArtifact = SignedArtifact<Lc4QualificationV3AuthorizationBody>;

export type Lc4QualificationV3InvocationBody = Readonly<{
  schema_version: 1;
  invocation_version: "HACC-LC4-QUALIFICATION-INVOCATION-v4";
  attempt_id: string;
  invoked_at: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  authorization_artifact_sha256: string;
  authorization_nonce_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  credential_set_sha256: string;
  terminal_public_key_fingerprint_sha256: string;
  trust_root_fingerprint_sha256: string;
  authorization_consumed: true;
}>;

export type Lc4QualificationV3InvocationArtifact = SignedArtifact<Lc4QualificationV3InvocationBody>;

export type Lc4QualificationV3RefusalBody = Readonly<{
  schema_version: 1;
  refusal_version: "HACC-LC4-QUALIFICATION-REFUSAL-v4";
  attempt_id: string;
  refused_at: string;
  stage: "source" | "credentials";
  code:
    | "source_inspection_failed"
    | "source_mismatch"
    | "credential_source_invalid"
    | "credential_missing"
    | "credential_set_mismatch";
  error_sha256: string;
  invocation_artifact_sha256: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  authorization_artifact_sha256: string;
  planned_source_tree_sha256: string;
  observed_source_tree_sha256: string | null;
  planned_credential_set_sha256: string;
  observed_credential_set_sha256: string | null;
  budget_reservation_created: false;
  budget_ledger_mutated: false;
  provider_clients_constructed: 0;
  provider_calls_made: 0;
}>;

export type Lc4QualificationV3RefusalPackage = Readonly<{
  schema_version: 1;
  package_version: "HACC-LC4-QUALIFICATION-REFUSAL-PACKAGE-v4";
  authorization: Lc4QualificationV3AuthorizationArtifact;
  refusal: SignedArtifact<Lc4QualificationV3RefusalBody>;
  package_sha256: string;
}>;

export type Lc4QualificationV3TerminalBody = Readonly<{
  schema_version: 3;
  terminal_version: "HACC-LC4-QUALIFICATION-TERMINAL-v6";
  runner_version: typeof LC4_QUALIFICATION_V3_RUNNER_VERSION;
  attempt_id: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  authorization_artifact_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  attempted_at: string;
  completed_at: string;
  status: "passed" | "failed";
  primary_failure_class: string | null;
  setup_qualification_artifact_sha256: string;
  control_size_diagnostic_sha256: string;
  roundtrip_evidence_sha256: readonly string[];
  roundtrip_public_execution_sha256: readonly string[];
  roundtrip_replay_sha256: readonly string[];
  payload_root_sha256: string;
  package_bindings: Lc4QualificationPackageBindingsV5;
  budget_evidence_sha256: string;
  budget_final_head_sha256: string;
  provider_sessions_opened: number;
  paid_sessions_opened: number;
  generation_phases_attempted: number;
  tool_roundtrips_attempted: number;
  caller_audio_bytes: number;
  paid_retries_attempted: 0;
  server_vad_qualification: Readonly<{
    provider: "xai";
    requested_setting_sha256: string;
    production_session_payload_sha256: string;
    gate_a_classification: "verified_by_provider_echo" | "acknowledged_unverifiable_server_vad" | "failed";
    retained_risk: "none" | "provider_omitted_turn_detection_fields";
    gate_b_required: boolean;
    gate_b_status: "behaviorally_verified" | "failed" | "not_run";
    gate_b_evidence_sha256: string | null;
    gate_b_binding_sha256: string | null;
    gate_a_risk_sha256: string;
    gate_a_connection_epoch: number | null;
    gate_b_connection_epoch: number | null;
    exact_setting_verified: boolean;
    operational_vad_verified: boolean;
    claims: Readonly<{
      operational_gateway: "verified" | "not_verified";
      operational_server_vad: "verified" | "not_verified";
      exact_gateway_name_and_arguments: "verified" | "not_verified";
      matching_gateway_result: "verified" | "not_verified";
      sole_post_tool_continuation_terminal_usage: "verified" | "not_verified";
      full_gateway_schema: "verified_by_provider_echo" | "unverifiable";
      gateway_description: "verified_by_provider_echo" | "unverifiable";
      post_update_voice: "verified_by_provider_echo" | "unverifiable";
      input_transcription: "not_requested" | "verified_by_provider_echo" | "unverifiable";
      idle_timeout: "documented_default_not_independently_verified" | "verified_by_provider_echo";
      exact_vad_parameters: "verified_by_provider_echo" | "unverifiable";
      created_to_updated_session_identity: "verified" | "unverifiable";
      dynamic_update_configuration: "behaviorally_verified_not_provider_echoed" | "verified_by_provider_echo" | "not_verified";
    }>;
    benchmark_ready: boolean;
  }>;
  results: readonly Readonly<{
    provider: LiveStsProvider;
    model: string;
    status: "passed" | "failed";
    failure_class: string;
    caller_audio_bytes: number;
    wire_observation_count: number;
    usage_event_count: number;
    evidence_sha256: string;
  }>[];
  terminal_sha256: string;
}>;

export type Lc4QualificationV3TerminalArtifact = SignedArtifact<Lc4QualificationV3TerminalBody>;

export type Lc4XaiServerVadGateARiskArtifact = Readonly<{
  schema_version: 2;
  provider: "xai";
  model: string;
  source_commit: string;
  plan_sha256: string;
  configuration_matrix_sha256: string;
  provider_profile_manifest_sha256: string;
  requested_configuration_sha256: string;
  requested_setting_sha256: string;
  production_session_payload_sha256: string;
  acknowledgement_sha256: string | null;
  policy_sha256: typeof XAI_SERVER_VAD_CONDITIONAL_POLICY_SHA256;
  field_evidence: ProviderQualificationArtifact["results"][number]["configurationEvidence"] | null;
  omitted_paths: readonly string[];
  mismatched_paths: readonly string[];
  field_status_inventory: readonly Readonly<{
    field: string;
    status: string;
    acknowledged_by: "session.created" | "session.updated" | null;
    omitted_paths: readonly string[];
    mismatched_paths: readonly string[];
  }>[];
  setup_wire_evidence: NonNullable<ProviderQualificationArtifact["results"][number]["setupWireEvidence"]> | null;
  setup_failure_evidence: NonNullable<ProviderQualificationArtifact["results"][number]["setupFailureEvidence"]> | null;
  transcription_policy: Readonly<{
    requested: false;
    host_consumed: false;
    verification: "not_requested";
  }>;
  idle_timeout_policy: Readonly<{
    requested: false;
    effective_basis: "documented_default";
    exact_setting_verified: false;
  }>;
  initial_snapshot_disposition: "provider_default_snapshot_only_not_update_echo";
  created_to_updated_session_identity: "verified" | "unverifiable";
  matched_arm_payload_policy: "same_profile_and_payload_hash_required";
  retained_risk: "none" | "provider_did_not_echo_exact_server_vad_parameters";
  claim_boundary: "gate_b_proves_operational_server_vad_lifecycle_not_exact_numeric_vad_parameters";
  risk_sha256: string;
}>;

export type Lc4XaiServerVadGateBBindingArtifact = Readonly<{
  schema_version: 1;
  provider: "xai";
  model: string;
  source_commit: string;
  plan_sha256: string;
  provider_profile_manifest_sha256: string;
  gate_a_risk_sha256: string;
  production_session_payload_sha256: string;
  gate_b_execution_sha256: string;
  connection_epoch: number;
  per_turn_session_update_observation_sha256: string;
  per_turn_session_ack_observation_sha256: string;
  transport_parity_sha256: string;
  tool_frontier_sha256: string;
  exact_gateway_call_evidence_sha256: string;
  matching_gateway_result_evidence_sha256: string;
  public_execution_sha256: string;
  replay_sha256: string;
  dynamic_update_provider_echo: "unverifiable" | "verified";
  ordered_vad_verified: true;
  exact_gateway_call_verified: true;
  matching_gateway_result_verified: true;
  sole_continuation_terminal_usage_verified: true;
  binding_sha256: string;
}>;

type Dependencies = Readonly<{
  inspectGitSource(repositoryRoot: string): Promise<Lc4QualificationV3GitSource>;
  loadCredentials(repositoryRoot: string): Promise<Readonly<Record<LiveStsProvider, string>>>;
  createClient(provider: LiveStsProvider, configuration: TrialSessionConfiguration, apiKey: string): NormalizedRealtimeClient;
  materializeAudio(input: Readonly<{ root: string; renderer?: Lc4S2sAudioRenderer }>): Promise<Lc4S2sAudioFixtureArtifact>;
  executeRoundtrip(input: Parameters<typeof executeLc4S2sToolRoundtrip>[0]): Promise<Lc4S2sRoundtripExecution>;
}>;

const defaultDependencies: Dependencies = Object.freeze({
  inspectGitSource: inspectLc4QualificationV3GitSource,
  loadCredentials: async () => {
    throw new Lc4QualificationV3BoundaryError("credentials", "credential_source_invalid");
  },
  createClient: createProductionRealtimeClient,
  materializeAudio: materializeLc4S2sAudioFixture,
  executeRoundtrip: executeLc4S2sToolRoundtrip,
});

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function boundaryError(
  stage: Lc4QualificationV3BoundaryStage,
  code: Lc4QualificationV3BoundaryCode,
): Lc4QualificationV3BoundaryError {
  return new Lc4QualificationV3BoundaryError(stage, code);
}

function requireSha(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function requireId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is not a safe opaque identifier`);
}

function requireIso(value: string, label: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new Error(`${label} must be a canonical ISO time`);
  return epoch;
}

function absoluteNormalized(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

function isOutside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === ".." || relation.startsWith(`..${sep}`);
}

async function readStablePrivateFile(path: string, label: string, maximumBytes: number): Promise<Buffer> {
  const target = absoluteNormalized(path, label);
  const before = await lstat(target);
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || (before.mode & 0o077) !== 0
    || before.size <= 0
    || before.size > maximumBytes) {
    throw new Error(`${label} must be one bounded private regular non-linked file`);
  }
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.nlink !== 1
      || (opened.mode & 0o077) !== 0
      || opened.size !== before.size) {
      throw new Error(`${label} changed while it was opened`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.nlink !== 1
      || (after.mode & 0o077) !== 0
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function loadLc4QualificationV3PrivateKeyFile(path: string, label: string): Promise<string> {
  const bytes = await readStablePrivateFile(path, label, MAXIMUM_PRIVATE_KEY_BYTES);
  const pem = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  keyIdentity(pem);
  return pem;
}

export async function loadLc4QualificationV3AuthorizationFile(
  path: string,
): Promise<Lc4QualificationV3AuthorizationArtifact> {
  const bytes = await readStablePrivateFile(
    path,
    "LC4 qualification v3 authorization",
    MAXIMUM_AUTHORIZATION_JSON_BYTES,
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Lc4QualificationV3AuthorizationArtifact;
  } catch {
    throw new Error("LC4 qualification v3 authorization must be valid UTF-8 JSON");
  }
}

async function initializeLc4QualificationV3EvidenceRoot(rootPath: string, repositoryPath: string): Promise<string> {
  const root = absoluteNormalized(rootPath, "LC4 qualification v3 evidence root");
  const repositoryRoot = absoluteNormalized(repositoryPath, "LC4 qualification v3 repository root");
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const parent = dirname(root);
  const physicalParent = await realpath(parent);
  const physicalCandidate = resolve(physicalParent, basename(root));
  if (!isOutside(physicalRepositoryRoot, physicalCandidate)) {
    throw new Error("LC4 qualification v3 evidence root must be outside the repository");
  }

  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { mode: 0o700 });
    before = await lstat(root);
  }
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o7777) !== 0o700) {
    throw new Error("LC4 qualification v3 evidence root must be one private 0700 regular directory");
  }
  if ((await readdir(root)).length !== 0) {
    throw new Error("LC4 qualification v3 evidence root must be fresh and empty");
  }
  const after = await lstat(root);
  const physicalRoot = await realpath(root);
  if (!after.isDirectory()
    || after.isSymbolicLink()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || (after.mode & 0o7777) !== 0o700
    || physicalRoot !== physicalCandidate
    || !isOutside(physicalRepositoryRoot, physicalRoot)
    || (await readdir(root)).length !== 0) {
    throw new Error("LC4 qualification v3 evidence root changed during validation");
  }
  return root;
}

async function validateLc4QualificationV3ExistingRoot(
  rootPath: string,
  repositoryPath?: string,
): Promise<Readonly<{
  path: string;
  physical_path: string;
  device: number;
  inode: number;
  physical_repository_path: string | null;
}>> {
  const root = absoluteNormalized(rootPath, "LC4 qualification v3 evidence root");
  const before = await lstat(root);
  const physicalRoot = await realpath(root);
  if (!before.isDirectory()
    || before.isSymbolicLink()
    || (before.mode & 0o7777) !== 0o700) {
    throw new Error("LC4 qualification v3 evidence root is not a physical private 0700 directory");
  }
  let physicalRepositoryRoot: string | null = null;
  if (repositoryPath !== undefined) {
    const repositoryRoot = absoluteNormalized(repositoryPath, "LC4 qualification v3 repository root");
    physicalRepositoryRoot = await realpath(repositoryRoot);
    if (!isOutside(physicalRepositoryRoot, physicalRoot)) {
      throw new Error("LC4 qualification v3 evidence root is not physically outside the repository");
    }
  }
  const after = await lstat(root);
  if (!after.isDirectory()
    || after.isSymbolicLink()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || (after.mode & 0o7777) !== 0o700
    || await realpath(root) !== physicalRoot) {
    throw new Error("LC4 qualification v3 evidence root changed during validation");
  }
  return freeze({
    path: root,
    physical_path: physicalRoot,
    device: before.dev,
    inode: before.ino,
    physical_repository_path: physicalRepositoryRoot,
  });
}

async function reassertLc4QualificationV3ExistingRoot(root: Awaited<ReturnType<
  typeof validateLc4QualificationV3ExistingRoot
>>): Promise<void> {
  const metadata = await lstat(root.path);
  const physicalRoot = await realpath(root.path);
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.dev !== root.device
    || metadata.ino !== root.inode
    || (metadata.mode & 0o7777) !== 0o700
    || physicalRoot !== root.physical_path
    || (root.physical_repository_path !== null
      && !isOutside(root.physical_repository_path, physicalRoot))) {
    throw new Error("LC4 qualification v3 evidence root identity changed after validation");
  }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o400 });
  try {
    await link(temporary, path);
    await chmod(path, 0o400);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonLines<T>(path: string): Promise<readonly T[]> {
  const text = await readFile(path, "utf8");
  if (text.length > 0 && !text.endsWith("\n")) throw new Error("LC4 qualification JSONL is not newline terminated");
  return freeze(text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T));
}

type RetainedRoundtripSummary = Omit<Lc4S2sRoundtripExecution, "wire_observations" | "usage" | "sanitized_usage"> & Readonly<{
  wire_observation_count: number;
  usage_event_count: number;
}>;

function createXaiServerVadGateARiskArtifact(input: Readonly<{
  setup: ProviderQualificationArtifact["results"][number];
  sourceCommit: string;
  planSha256: string;
  configurationMatrixSha256: string;
  providerProfileManifestSha256: string;
  productionSessionPayloadSha256: string;
}>): Lc4XaiServerVadGateARiskArtifact {
  if (input.setup.provider !== "xai") throw new Error("xAI Gate A risk requires the xAI setup result");
  const proofs = input.setup.configurationEvidence === undefined
    ? []
    : [input.setup.configurationEvidence.session, ...Object.values(input.setup.configurationEvidence.fields)]
      .filter((proof): proof is NonNullable<typeof proof> => proof !== undefined);
  const omittedPaths = [...new Set(proofs.flatMap((proof) => proof.omission?.paths ?? []))].sort();
  const mismatchedPaths = [...new Set(proofs.flatMap((proof) => proof.contradiction?.paths ?? []))].sort();
  const fieldStatusInventory = input.setup.configurationEvidence === undefined
    ? []
    : Object.entries(input.setup.configurationEvidence.fields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, proof]) => freeze({
        field,
        status: proof.status,
        acknowledged_by: proof.acknowledgedBy ?? null,
        omitted_paths: freeze([...(proof.omission?.paths ?? [])].sort()),
        mismatched_paths: freeze([...(proof.contradiction?.paths ?? [])].sort()),
      }));
  const createdObservation = input.setup.setupWireEvidence?.observations.find((observation) => (
    observation.direction === "inbound" && observation.wireType === "session.created"
  ));
  const updatedObservation = input.setup.setupWireEvidence?.observations.find((observation) => (
    observation.observationSha256 === input.setup.setupWireEvidence?.acknowledgementObservationSha256
  ));
  const createdSessionId = createdObservation?.identities.sessionIdSha256;
  const updatedSessionId = updatedObservation?.identities.sessionIdSha256;
  if (createdSessionId !== undefined && updatedSessionId !== undefined && createdSessionId !== updatedSessionId) {
    throw new Error("xAI Gate A session identity changed from created to updated");
  }
  const withoutHash = freeze({
    schema_version: 2 as const,
    provider: "xai" as const,
    model: input.setup.model,
    source_commit: input.sourceCommit,
    plan_sha256: input.planSha256,
    configuration_matrix_sha256: input.configurationMatrixSha256,
    provider_profile_manifest_sha256: input.providerProfileManifestSha256,
    requested_configuration_sha256: input.setup.requestedConfigurationSha256,
    requested_setting_sha256: LC4_XAI_SERVER_VAD_SETTING_SHA256,
    production_session_payload_sha256: input.productionSessionPayloadSha256,
    acknowledgement_sha256: input.setup.acknowledgementSha256,
    policy_sha256: XAI_SERVER_VAD_CONDITIONAL_POLICY_SHA256,
    field_evidence: input.setup.configurationEvidence ?? null,
    omitted_paths: freeze(omittedPaths),
    mismatched_paths: freeze(mismatchedPaths),
    field_status_inventory: freeze(fieldStatusInventory),
    setup_wire_evidence: input.setup.setupWireEvidence ?? null,
    setup_failure_evidence: input.setup.setupFailureEvidence ?? null,
    transcription_policy: freeze({
      requested: false as const,
      host_consumed: false as const,
      verification: "not_requested" as const,
    }),
    idle_timeout_policy: freeze({
      requested: false as const,
      effective_basis: "documented_default" as const,
      exact_setting_verified: false as const,
    }),
    initial_snapshot_disposition: "provider_default_snapshot_only_not_update_echo" as const,
    created_to_updated_session_identity: createdSessionId !== undefined && updatedSessionId !== undefined
      ? "verified" as const
      : "unverifiable" as const,
    matched_arm_payload_policy: "same_profile_and_payload_hash_required" as const,
    retained_risk: (input.setup.code === "acknowledged_unverifiable_server_vad"
      || input.setup.code === "initial_snapshot_exact_only")
      ? "provider_did_not_echo_exact_server_vad_parameters" as const
      : "none" as const,
    claim_boundary: "gate_b_proves_operational_server_vad_lifecycle_not_exact_numeric_vad_parameters" as const,
  });
  return freeze({
    ...withoutHash,
    risk_sha256: sha256Hex(`${XAI_SERVER_VAD_GATE_A_RISK_DOMAIN}${canonicalJson(withoutHash)}`),
  });
}

function assertXaiServerVadGateARiskArtifact(artifact: Lc4XaiServerVadGateARiskArtifact): void {
  const { risk_sha256, ...body } = artifact;
  const setupWire = artifact.setup_wire_evidence;
  const setupFailure = artifact.setup_failure_evidence;
  const inbound = setupWire?.observations.find((observation) => (
    observation.observationSha256 === setupWire.acknowledgementObservationSha256
  ));
  const projectedFieldEvidence = inbound === undefined
    ? undefined
    : (inbound.projection.session as { configurationEvidence?: unknown } | undefined)?.configurationEvidence;
  if (artifact.provider !== "xai"
    || artifact.schema_version !== 2
    || artifact.policy_sha256 !== XAI_SERVER_VAD_CONDITIONAL_POLICY_SHA256
    || artifact.requested_setting_sha256 !== LC4_XAI_SERVER_VAD_SETTING_SHA256
    || !SHA256.test(artifact.production_session_payload_sha256)
    || artifact.provider_profile_manifest_sha256 !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256
    || canonicalJson(artifact.transcription_policy) !== canonicalJson({ requested: false, host_consumed: false, verification: "not_requested" })
    || canonicalJson(artifact.idle_timeout_policy) !== canonicalJson({ requested: false, effective_basis: "documented_default", exact_setting_verified: false })
    || artifact.initial_snapshot_disposition !== "provider_default_snapshot_only_not_update_echo"
    || (artifact.created_to_updated_session_identity !== "verified"
      && artifact.created_to_updated_session_identity !== "unverifiable")
    || artifact.matched_arm_payload_policy !== "same_profile_and_payload_hash_required"
    || risk_sha256 !== sha256Hex(`${XAI_SERVER_VAD_GATE_A_RISK_DOMAIN}${canonicalJson(body)}`)
    || canonicalJson(artifact.omitted_paths) !== canonicalJson([...artifact.omitted_paths].sort())
    || canonicalJson(artifact.mismatched_paths) !== canonicalJson([...artifact.mismatched_paths].sort())
    || artifact.field_status_inventory.some((entry, index, entries) => (
      !/^[a-z][a-z0-9_]*$/u.test(entry.field)
      || (index > 0 && entries[index - 1]!.field.localeCompare(entry.field) >= 0)
      || canonicalJson(entry.omitted_paths) !== canonicalJson([...entry.omitted_paths].sort())
      || canonicalJson(entry.mismatched_paths) !== canonicalJson([...entry.mismatched_paths].sort())
      || [...entry.omitted_paths, ...entry.mismatched_paths].some((path) => !/^[a-z][a-z0-9_.\[\]-]*$/u.test(path))
    ))
    || (artifact.field_evidence !== null && (
      setupWire === null
      || !verifyRealtimeWireObservationChain(setupWire.observations).valid
      || inbound?.connectionEpoch !== setupWire.connectionEpoch
      || canonicalJson(projectedFieldEvidence) !== canonicalJson(artifact.field_evidence)
    ))
    || (setupFailure !== null && (
      setupWire !== null
      || setupFailure.provider !== "xai"
      || setupFailure.observationCount !== setupFailure.observations.length
      || (setupFailure.observations.length > 0
        && !verifyRealtimeWireObservationChain(setupFailure.observations).valid)
    ))) {
    throw new Error("LC4 xAI server-VAD Gate A risk artifact failed integrity");
  }
}

function createXaiServerVadGateBBindingArtifact(input: Readonly<{
  risk: Lc4XaiServerVadGateARiskArtifact;
  execution: Lc4S2sRoundtripExecution;
  sourceCommit: string;
  planSha256: string;
  providerProfileManifestSha256: string;
  expectedTransportParitySha256: string;
}>): Lc4XaiServerVadGateBBindingArtifact {
  assertXaiServerVadGateARiskArtifact(input.risk);
  assertLc4S2sRoundtripExecution(input.execution);
  const execution = input.execution;
  if (execution.provider !== "xai" || execution.status !== "passed") {
    throw new Error("xAI Gate B binding requires a passing xAI execution");
  }
  const update = execution.wire_observations.find((observation) => (
    observation.observationSha256 === execution.per_turn_session_update_observation_sha256
  ));
  const acknowledgement = execution.wire_observations.find((observation) => (
    observation.observationSha256 === execution.per_turn_session_ack_observation_sha256
  ));
  const configuration = (acknowledgement?.projection.session as {
    configurationEvidence?: ProviderQualificationArtifact["results"][number]["configurationEvidence"];
  } | undefined)?.configurationEvidence;
  const dynamicProofs = configuration === undefined
    ? []
    : [configuration.fields.instructions, configuration.fields.tools, configuration.fields.tool_choice];
  const dynamicUpdateProviderEcho = dynamicProofs.length === 3
    && dynamicProofs.every((proof) => proof.status === "verified")
    ? "verified" as const
    : "unverifiable" as const;
  const dynamicControl = update?.projection.dynamicControl !== null
    && typeof update?.projection.dynamicControl === "object"
    && !Array.isArray(update.projection.dynamicControl)
    ? update.projection.dynamicControl as Record<string, unknown>
    : null;
  if (!update || !acknowledgement
    || update.direction !== "outbound" || update.wireType !== "session.update"
    || acknowledgement.direction !== "inbound" || acknowledgement.wireType !== "session.updated"
    || update.connectionEpoch !== acknowledgement.connectionEpoch
    || update.sequence >= acknowledgement.sequence
    || dynamicControl?.sha256 !== LC4_S2S_COMPACT_CONTROL_SHA256
    || dynamicControl.byteLength !== Buffer.byteLength(LC4_S2S_COMPACT_CONTROL, "utf8")
    || dynamicControl.authority !== "advisory_only_gateway_and_speech_gate_enforced"
    || dynamicControl.toolFrontierSha256 !== execution.tool_frontier_sha256
    || dynamicControl.transportParitySha256 !== input.expectedTransportParitySha256
    || dynamicControl.delivery !== "session.update_before_audio"
    || execution.transport_parity_sha256 !== input.expectedTransportParitySha256
    || execution.provider_tool_call_evidence_sha256 === null
    || execution.tool_result_evidence_sha256 === null
    || execution.public_execution_sha256 === null
    || execution.replay_sha256 === null) {
    throw new Error("xAI Gate B binding lacks same-epoch payload and roundtrip evidence");
  }
  const withoutHash = freeze({
    schema_version: 1 as const,
    provider: "xai" as const,
    model: execution.model,
    source_commit: input.sourceCommit,
    plan_sha256: input.planSha256,
    provider_profile_manifest_sha256: input.providerProfileManifestSha256,
    gate_a_risk_sha256: input.risk.risk_sha256,
    production_session_payload_sha256: input.risk.production_session_payload_sha256,
    gate_b_execution_sha256: execution.evidence_sha256,
    connection_epoch: update.connectionEpoch,
    per_turn_session_update_observation_sha256: update.observationSha256,
    per_turn_session_ack_observation_sha256: acknowledgement.observationSha256,
    transport_parity_sha256: execution.transport_parity_sha256,
    tool_frontier_sha256: execution.tool_frontier_sha256,
    exact_gateway_call_evidence_sha256: execution.provider_tool_call_evidence_sha256,
    matching_gateway_result_evidence_sha256: execution.tool_result_evidence_sha256,
    public_execution_sha256: execution.public_execution_sha256,
    replay_sha256: execution.replay_sha256,
    dynamic_update_provider_echo: dynamicUpdateProviderEcho,
    ordered_vad_verified: true as const,
    exact_gateway_call_verified: true as const,
    matching_gateway_result_verified: true as const,
    sole_continuation_terminal_usage_verified: true as const,
  });
  return freeze({
    ...withoutHash,
    binding_sha256: sha256Hex(`${XAI_SERVER_VAD_GATE_B_BINDING_DOMAIN}${canonicalJson(withoutHash)}`),
  });
}

function assertXaiServerVadGateBBindingArtifact(input: Readonly<{
  artifact: Lc4XaiServerVadGateBBindingArtifact;
  risk: Lc4XaiServerVadGateARiskArtifact;
  execution: Lc4S2sRoundtripExecution;
  expectedTransportParitySha256: string;
}>): void {
  const { binding_sha256, ...body } = input.artifact;
  assertXaiServerVadGateARiskArtifact(input.risk);
  assertLc4S2sRoundtripExecution(input.execution);
  if (binding_sha256 !== sha256Hex(`${XAI_SERVER_VAD_GATE_B_BINDING_DOMAIN}${canonicalJson(body)}`)
    || input.artifact.gate_a_risk_sha256 !== input.risk.risk_sha256
    || input.artifact.production_session_payload_sha256 !== input.risk.production_session_payload_sha256
    || input.artifact.provider_profile_manifest_sha256 !== input.risk.provider_profile_manifest_sha256
    || input.artifact.gate_b_execution_sha256 !== input.execution.evidence_sha256
    || input.artifact.transport_parity_sha256 !== input.expectedTransportParitySha256
    || input.artifact.per_turn_session_update_observation_sha256 !== input.execution.per_turn_session_update_observation_sha256
    || input.artifact.per_turn_session_ack_observation_sha256 !== input.execution.per_turn_session_ack_observation_sha256
    || input.artifact.exact_gateway_call_evidence_sha256 !== input.execution.provider_tool_call_evidence_sha256
    || input.artifact.matching_gateway_result_evidence_sha256 !== input.execution.tool_result_evidence_sha256
    || input.artifact.public_execution_sha256 !== input.execution.public_execution_sha256
    || input.artifact.replay_sha256 !== input.execution.replay_sha256
    || input.artifact.ordered_vad_verified !== true
    || input.artifact.exact_gateway_call_verified !== true
    || input.artifact.matching_gateway_result_verified !== true
    || input.artifact.sole_continuation_terminal_usage_verified !== true) {
    throw new Error("LC4 xAI server-VAD Gate B binding failed integrity");
  }
}

function assertRetainedXaiServerVadEvidence(input: Readonly<{
  summary: RetainedRoundtripSummary;
  wire: readonly RealtimeWireObservation[];
  usage: readonly RoundtripSanitizedUsage[];
  terminalResult: Lc4QualificationV3TerminalBody["results"][number];
  gateEvidenceSha256: string | null;
}>): void {
  const { summary, wire, usage, terminalResult } = input;
  if (summary.provider !== "xai"
    || summary.status !== "passed"
    || summary.failure_class !== "none"
    || summary.evidence_sha256 !== terminalResult.evidence_sha256
    || summary.evidence_sha256 !== input.gateEvidenceSha256
    || summary.wire_observation_count !== wire.length
    || summary.wire_observation_count !== terminalResult.wire_observation_count
    || !verifyRealtimeWireObservationChain(wire).valid) {
    throw new Error("LC4 qualification retained xAI roundtrip binding failed integrity");
  }
  const index = (digest: string | null) => wire.findIndex((observation) => observation.observationSha256 === digest);
  const ordered = [
    summary.per_turn_session_update_observation_sha256,
    summary.per_turn_session_ack_observation_sha256,
    wire.find((observation) => observation.direction === "outbound"
      && observation.wireType === "input_audio_buffer.append")?.observationSha256 ?? null,
    summary.server_vad_speech_start_observation_sha256,
    summary.server_vad_speech_stop_observation_sha256,
    summary.server_vad_auto_commit_observation_sha256,
    summary.server_vad_auto_response_observation_sha256,
  ].map(index);
  const forbiddenCommit = wire.some((observation) => observation.direction === "outbound"
    && observation.wireType === "input_audio_buffer.commit");
  const responseCreates = wire.filter((observation) => observation.direction === "outbound"
    && observation.wireType === "response.create");
  if (summary.turn_boundary_mode !== "provider_native_server_vad"
    || summary.server_vad_setting_sha256 !== LC4_XAI_SERVER_VAD_SETTING_SHA256
    || ordered.some((position) => position < 0)
    || ordered.some((position, index_) => index_ > 0 && position <= ordered[index_ - 1]!)
    || forbiddenCommit
    || responseCreates.length !== 1) {
    throw new Error("LC4 qualification retained xAI server-VAD order failed integrity");
  }
  if (summary.replay_summary === null || summary.replay_causal_binding === null) {
    throw new Error("LC4 qualification retained xAI replay evidence is missing");
  }
  const replay = replayProviderToolRoundtrip({
    expected: { provider: "xai", model: summary.model },
    summary: summary.replay_summary,
    wire_observations: wire,
    sanitized_usage: usage,
    causal_binding: summary.replay_causal_binding,
  });
  if (!replay.valid
    || replay.public_execution_sha256 !== summary.public_execution_sha256
    || replay.replay_sha256 !== summary.replay_sha256) {
    throw new Error("LC4 qualification retained xAI replay failed integrity");
  }
}

function assertRetainedProviderReplayEvidence(input: Readonly<{
  provider: LiveStsProvider;
  summary: RetainedRoundtripSummary;
  wire: readonly RealtimeWireObservation[];
  usage: readonly RoundtripSanitizedUsage[];
  terminalResult: Lc4QualificationV3TerminalBody["results"][number];
  terminalPublicExecutionSha256: string;
  terminalReplaySha256: string;
}>): void {
  const { summary, wire, usage, terminalResult } = input;
  if (summary.provider !== input.provider
    || summary.model !== terminalResult.model
    || summary.status !== "passed"
    || summary.failure_class !== "none"
    || summary.replay_summary === null
    || summary.replay_causal_binding === null
    || summary.wire_observation_count !== wire.length
    || summary.usage_event_count !== usage.length
    || terminalResult.wire_observation_count !== wire.length
    || terminalResult.usage_event_count !== usage.length) {
    throw new Error(`LC4 qualification retained ${input.provider} replay inputs differ from terminal`);
  }
  const replay = replayProviderToolRoundtrip({
    expected: { provider: input.provider, model: summary.model },
    summary: summary.replay_summary,
    wire_observations: wire,
    sanitized_usage: usage,
    causal_binding: summary.replay_causal_binding,
  });
  if (!replay.valid
    || replay.public_execution_sha256 !== summary.public_execution_sha256
    || replay.replay_sha256 !== summary.replay_sha256
    || replay.public_execution_sha256 !== input.terminalPublicExecutionSha256
    || replay.replay_sha256 !== input.terminalReplaySha256) {
    throw new Error(`LC4 qualification retained ${input.provider} replay failed integrity`);
  }
}

function keyIdentity(privateKeyPem: string): Readonly<{
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKeySpki: Buffer;
  publicKeySpkiBase64: string;
  fingerprint: string;
}> {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("LC4 qualification signer must be Ed25519");
  const publicKeySpki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return freeze({
    privateKey,
    publicKeySpki,
    publicKeySpkiBase64: publicKeySpki.toString("base64"),
    fingerprint: sha256Hex(publicKeySpki),
  });
}

function signedArtifact<Body>(input: Readonly<{
  body: Body;
  privateKeyPem: string;
  signingDomain: string;
  artifactDomain: string;
}>): SignedArtifact<Body> {
  const key = keyIdentity(input.privateKeyPem);
  const unsigned = freeze({
    body: input.body,
    authority_public_key_spki_base64: key.publicKeySpkiBase64,
    authority_public_key_fingerprint_sha256: key.fingerprint,
    signature_algorithm: "Ed25519" as const,
    signature_base64: sign(null, Buffer.from(`${input.signingDomain}${canonicalJson(input.body)}`), key.privateKey).toString("base64"),
  });
  return freeze({ ...unsigned, artifact_sha256: sha256Hex(`${input.artifactDomain}${canonicalJson(unsigned)}`) });
}

function assertSignedArtifact<Body>(input: Readonly<{
  artifact: SignedArtifact<Body>;
  expectedFingerprint: string;
  signingDomain: string;
  artifactDomain: string;
}>): void {
  const { artifact_sha256, ...unsigned } = input.artifact;
  if (sha256Hex(`${input.artifactDomain}${canonicalJson(unsigned)}`) !== artifact_sha256) throw new Error("LC4 signed artifact hash mismatch");
  const keyBytes = Buffer.from(input.artifact.authority_public_key_spki_base64, "base64");
  if (sha256Hex(keyBytes) !== input.artifact.authority_public_key_fingerprint_sha256
    || input.artifact.authority_public_key_fingerprint_sha256 !== input.expectedFingerprint) throw new Error("LC4 signed artifact trust root mismatch");
  const publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519"
    || !verify(null, Buffer.from(`${input.signingDomain}${canonicalJson(input.artifact.body)}`), publicKey, Buffer.from(input.artifact.signature_base64, "base64"))) {
    throw new Error("LC4 signed artifact signature is invalid");
  }
}

function credentialIdentity(provider: LiveStsProvider, credential: string) {
  if (credential.length < 12) throw new Error(`missing ${provider} credential`);
  return freeze({ provider, credential_sha256: sha256Hex(`${CREDENTIAL_DOMAIN}${credential}`) });
}

function credentialSetSha256(credentials: Readonly<Record<LiveStsProvider, string>>): string {
  return sha256Hex(`${CREDENTIAL_SET_DOMAIN}${canonicalJson(LC4_QUALIFICATION_V3_PROVIDER_ORDER.map((provider) => credentialIdentity(provider, credentials[provider])))}`);
}

const CREDENTIAL_ENV_NAMES = Object.freeze({
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
} as const);

async function readExplicitCredentialEnvironment(path: string): Promise<Readonly<{
  device: number;
  inode: number;
  values: NodeJS.Dict<string>;
}>> {
  if (!isAbsolute(path) || resolve(path) !== path) throw boundaryError("credentials", "credential_source_invalid");
  const normalized = resolve(path);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(normalized);
  } catch {
    throw boundaryError("credentials", "credential_source_invalid");
  }
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || (before.mode & 0o077) !== 0) {
    throw boundaryError("credentials", "credential_source_invalid");
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(normalized, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.nlink !== 1
      || (opened.mode & 0o077) !== 0
      || opened.size <= 0
      || opened.size > MAXIMUM_CREDENTIAL_ENV_BYTES) {
      throw boundaryError("credentials", "credential_source_invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.nlink !== 1
      || (after.mode & 0o077) !== 0
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw boundaryError("credentials", "credential_source_invalid");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = parseBenchmarkEnvironmentFile(text);
    const values: NodeJS.Dict<string> = Object.create(null);
    for (const name of Object.values(CREDENTIAL_ENV_NAMES)) {
      if (Object.hasOwn(parsed, name)) values[name] = parsed[name];
    }
    return freeze({
      device: opened.dev,
      inode: opened.ino,
      values,
    });
  } catch (error) {
    if (error instanceof Lc4QualificationV3BoundaryError) throw error;
    throw boundaryError("credentials", "credential_source_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Load only the two operator-selected files. The repository file is applied
 * last, matching the frozen LC4 operator command, while ambient process state
 * and checkout-local dotenv files are deliberately ignored.
 */
export async function loadLc4QualificationV3ExplicitCredentials(
  files: Lc4QualificationV3CredentialFiles,
): Promise<Readonly<Record<LiveStsProvider, string>>> {
  if (!isAbsolute(files.providerEnvFile)
    || resolve(files.providerEnvFile) !== files.providerEnvFile
    || !isAbsolute(files.repoEnvFile)
    || resolve(files.repoEnvFile) !== files.repoEnvFile) {
    throw boundaryError("credentials", "credential_source_invalid");
  }
  const providerPath = files.providerEnvFile;
  const repoPath = files.repoEnvFile;
  if (providerPath === repoPath) throw boundaryError("credentials", "credential_source_invalid");
  const [providerSource, repoSource] = await Promise.all([
    readExplicitCredentialEnvironment(providerPath),
    readExplicitCredentialEnvironment(repoPath),
  ]);
  if (providerSource.device === repoSource.device && providerSource.inode === repoSource.inode) {
    throw boundaryError("credentials", "credential_source_invalid");
  }
  const merged = Object.assign(Object.create(null) as Record<string, string | undefined>, providerSource.values, repoSource.values);
  const credentials = {} as Record<LiveStsProvider, string>;
  for (const provider of LC4_QUALIFICATION_V3_PROVIDER_ORDER) {
    const value = merged[CREDENTIAL_ENV_NAMES[provider]];
    if (typeof value !== "string"
      || value.length < 12
      || value !== value.trim()
      || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw boundaryError("credentials", "credential_missing");
    }
    credentials[provider] = value;
  }
  return freeze(credentials);
}

function setupConfiguration(provider: LiveStsProvider): TrialSessionConfiguration {
  const spec = LIVE_STS_PROVIDER_SPECS[provider];
  const instructions = [
    "This is a development-only realtime voice transport qualification.",
    "Use only the exact closed semantic capability gateway when the caller requests it.",
    "Never speak before a required tool call and never claim an action without its tool result.",
  ].join(" ");
  const renderedCapabilitySnapshot = "<qualification_gateway semantic_intent=\"complete_current_stage\" arguments=\"{}\" />";
  return freeze({
    provider,
    model: spec.model,
    conditionId: "host-managed-harness" as const,
    instructions,
    initialPrompt: instructions,
    renderedCapabilitySnapshot,
    providerTools: freeze([LC4_S2S_TOOL]),
    conditionHash: sha256Hex(`harshas-amazing-call-center/lc4-qualification-v3-condition/v1\n${provider}\n${instructions}`),
    inputAudioFormat: freeze({ encoding: "pcm16" as const, sampleRateHz: spec.sampleRateHz, channels: 1 as const }),
    audioDeliveryProfile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
    audioDeliveryProfileHash: trialAudioDeliveryProfileHash(DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE),
  });
}

export function createLc4QualificationV3Targets(): readonly ProviderQualificationTarget[] {
  assertLc4ProviderProfileManifest(LC4_PROVIDER_PROFILE_MANIFEST);
  return freeze(LC4_QUALIFICATION_V3_PROVIDER_ORDER.map((provider) => {
    const configuration = setupConfiguration(provider);
    const profile = LC4_PROVIDER_PROFILE_MANIFEST.providers[provider];
    if (configuration.model !== profile.model || configuration.inputAudioFormat.sampleRateHz !== profile.input_sample_rate_hz) {
      throw new Error(`LC4 qualification v3 ${provider} differs from frozen provider profile`);
    }
    return freeze({ provider, model: configuration.model, configuration });
  }));
}

export async function inspectLc4QualificationV3GitSource(repositoryRoot: string): Promise<Lc4QualificationV3GitSource> {
  const [{ stdout: status }, { stdout: commit }, { stdout: tree }] = await Promise.all([
    execFileAsync("git", ["-C", resolve(repositoryRoot), "status", "--porcelain=v1", "--untracked-files=all"]),
    execFileAsync("git", ["-C", resolve(repositoryRoot), "rev-parse", "HEAD"]),
    execFileAsync("git", ["-C", resolve(repositoryRoot), "rev-parse", "HEAD^{tree}"]),
  ]);
  if (status.trim()) throw new Error("LC4 qualification v3 requires an exactly clean worktree");
  const sourceCommit = commit.trim();
  const sourceTreeOid = tree.trim();
  if (!SHA1.test(sourceCommit) || !SHA1.test(sourceTreeOid)) throw new Error("LC4 qualification v3 Git identity is invalid");
  return freeze({
    source_commit: sourceCommit,
    source_tree_oid: sourceTreeOid,
    source_tree_sha256: sha256Hex(`${SOURCE_DOMAIN}${canonicalJson({ source_commit: sourceCommit, source_tree_oid: sourceTreeOid })}`),
    worktree_clean: true as const,
  });
}

function planBodySha256(body: Omit<Lc4QualificationV3PlanBody, "plan_sha256">): string {
  return sha256Hex(`${PLAN_DOMAIN}${canonicalJson(body)}`);
}

function expectedXaiTransportParitySha256(configuration: TrialSessionConfiguration): string {
  if (configuration.provider !== "xai") throw new Error("xAI transport parity requires xAI configuration");
  const compiled = withXaiServerVadPcmSession(
    productionOpenAiCompatibleSessionUpdate("xai", configuration),
  );
  return xaiServerVadTransportParitySha256(compiled, configuration.model);
}

export function assertLc4QualificationV3PlanArtifact(artifact: Lc4QualificationV3PlanArtifact, trustRootFingerprint: string): void {
  assertSignedArtifact({ artifact, expectedFingerprint: trustRootFingerprint, signingDomain: PLAN_DOMAIN, artifactDomain: PLAN_ARTIFACT_DOMAIN });
  const { plan_sha256, ...body } = artifact.body;
  if (planBodySha256(body) !== plan_sha256) throw new Error("LC4 qualification v3 plan body hash mismatch");
  if (artifact.body.runner_version !== LC4_QUALIFICATION_V3_RUNNER_VERSION
    || artifact.body.maximum_total_micro_usd !== LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD
    || artifact.body.maximum_provider_sessions !== LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS
    || artifact.body.maximum_paid_sessions !== LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS
    || artifact.body.maximum_generation_phases !== LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES
    || artifact.body.maximum_tool_roundtrips !== LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS
    || artifact.body.paid_retry_allowed !== false
    || artifact.body.provider_calls_authorized !== false
    || artifact.body.control_size_diagnostic.qualification_gate !== false
    || artifact.body.targets.length !== 3
    || artifact.body.targets.some((target) => target.gateway_schema_sha256 !== LC4_S2S_TOOL_SCHEMA_SHA256)) {
    throw new Error("LC4 qualification v3 plan weakened a frozen boundary");
  }
  const expectedTargets = createLc4QualificationV3Targets();
  for (const [index, target] of artifact.body.targets.entries()) {
    const expected = expectedTargets[index]!;
    const expectedPayloadSha256 = target.provider === "gemini"
      ? null
      : productionSessionPayloadParitySha256(target.provider, expected.configuration);
    const expectedTransportParitySha256 = target.provider === "xai"
      ? expectedXaiTransportParitySha256(expected.configuration)
      : null;
    if (target.provider !== expected.provider
      || target.model !== expected.model
      || target.production_session_payload_sha256 !== expectedPayloadSha256
      || target.xai_transport_parity_sha256 !== expectedTransportParitySha256) {
      throw new Error("LC4 qualification v3 plan session payload parity differs from production");
    }
  }
}

export async function prepareLc4QualificationV3(input: Readonly<{
  root: string;
  repositoryRoot: string;
  credentialFiles?: Lc4QualificationV3CredentialFiles;
  authorityPrivateKeyPem: string;
  trustRootFingerprint: string;
  now?: () => Date;
  planId?: string;
  audioRenderer?: Lc4S2sAudioRenderer;
  dependencies?: Pick<Dependencies, "inspectGitSource" | "loadCredentials" | "materializeAudio">;
}>): Promise<Lc4QualificationV3PlanArtifact> {
  const repositoryRoot = absoluteNormalized(input.repositoryRoot, "LC4 qualification v3 repository root");
  const root = await initializeLc4QualificationV3EvidenceRoot(input.root, repositoryRoot);
  const dependencies = input.dependencies ?? defaultDependencies;
  const [source, credentials] = await Promise.all([
    dependencies.inspectGitSource(repositoryRoot),
    input.credentialFiles
      ? loadLc4QualificationV3ExplicitCredentials(input.credentialFiles)
      : dependencies.loadCredentials(repositoryRoot),
  ]);
  const fixture = await dependencies.materializeAudio({ root, renderer: input.audioRenderer });
  const targets = createLc4QualificationV3Targets();
  const planId = input.planId ?? randomUUID();
  requireId(planId, "LC4 qualification v3 plan ID");
  const unsignedBody = freeze({
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    protocol_id: "HACC-LC4-v1" as const,
    plan_id: planId,
    prepared_at: (input.now ?? (() => new Date()))().toISOString(),
    source,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    setup_configuration_matrix_sha256: providerQualificationMatrixSha256(targets),
    credential_set_sha256: credentialSetSha256(credentials),
    credential_identities: freeze(LC4_QUALIFICATION_V3_PROVIDER_ORDER.map((provider) => credentialIdentity(provider, credentials[provider]))),
    audio_fixture: fixture,
    control_size_diagnostic: lc4S2sControlSizeDiagnostic(),
    targets: freeze(LC4_QUALIFICATION_V3_PROVIDER_ORDER.map((provider) => {
      const object = fixture.provider_renditions[provider];
      const configuration = targets.find((target) => target.provider === provider)!.configuration;
      return freeze({
        provider,
        model: LIVE_STS_PROVIDER_SPECS[provider].model,
        sample_rate_hz: object.sample_rate_hz,
        caller_audio_bytes: object.byte_length,
        caller_audio_sha256: object.sha256,
        caller_audio_cas_sha256: object.cas_sha256,
        caller_audio_duration_ms: object.duration_ms,
        gateway_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
        voice_sha256: LC4_S2S_VOICE_SHA256,
        compact_control_sha256: LC4_S2S_COMPACT_CONTROL_SHA256,
        packetizer_sha256: LC4_S2S_PACKETIZER_SHA256,
        audio_delivery_profile_sha256: trialAudioDeliveryProfileHash(DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE),
        production_session_payload_sha256: provider === "gemini"
          ? null
          : productionSessionPayloadParitySha256(provider, configuration),
        xai_transport_parity_sha256: provider === "xai"
          ? expectedXaiTransportParitySha256(configuration)
          : null,
        setup_sessions: 1 as const,
        paid_sessions: 1 as const,
        generation_phases: 2 as const,
        tool_roundtrips: 1 as const,
      });
    })),
    execution_scope: "gate_a_setup_acceptance_then_gate_b_spoken_tool_roundtrip_gate_c_diagnostic_only" as const,
    maximum_total_micro_usd: LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
    maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
    maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
    maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
    maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
    paid_retry_allowed: false as const,
    provider_calls_authorized: false as const,
  });
  const body = freeze({ ...unsignedBody, plan_sha256: planBodySha256(unsignedBody) });
  const artifact = signedArtifact({ body, privateKeyPem: input.authorityPrivateKeyPem, signingDomain: PLAN_DOMAIN, artifactDomain: PLAN_ARTIFACT_DOMAIN });
  assertLc4QualificationV3PlanArtifact(artifact, input.trustRootFingerprint);
  await writeImmutableJson(resolve(root, "lc4-qualification-v3-plan.json"), artifact);
  return artifact;
}

export function lc4QualificationV3AuthorizationSigningBytes(body: Lc4QualificationV3AuthorizationBody): Uint8Array {
  return Buffer.from(`${AUTHORIZATION_DOMAIN}${canonicalJson(body)}`);
}

export function createLc4QualificationV3AuthorizationArtifact(input: Readonly<{
  body: Lc4QualificationV3AuthorizationBody;
  authorityPrivateKeyPem: string;
}>): Lc4QualificationV3AuthorizationArtifact {
  return signedArtifact({ body: input.body, privateKeyPem: input.authorityPrivateKeyPem, signingDomain: AUTHORIZATION_DOMAIN, artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN });
}

export function assertLc4QualificationV3Authorization(input: Readonly<{
  artifact: Lc4QualificationV3AuthorizationArtifact;
  plan: Lc4QualificationV3PlanArtifact;
  trustRootFingerprint: string;
  now: Date;
}>): void {
  assertSignedArtifact({ artifact: input.artifact, expectedFingerprint: input.trustRootFingerprint, signingDomain: AUTHORIZATION_DOMAIN, artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN });
  const body = input.artifact.body;
  const plan = input.plan.body;
  if (body.authorization_version !== LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION
    || body.plan_artifact_sha256 !== input.plan.artifact_sha256
    || body.plan_sha256 !== plan.plan_sha256
    || body.source_commit !== plan.source.source_commit
    || body.source_tree_sha256 !== plan.source.source_tree_sha256
    || body.credential_set_sha256 !== plan.credential_set_sha256
    || body.maximum_total_micro_usd !== plan.maximum_total_micro_usd
    || body.maximum_provider_sessions !== plan.maximum_provider_sessions
    || body.maximum_paid_sessions !== plan.maximum_paid_sessions
    || body.maximum_generation_phases !== plan.maximum_generation_phases
    || body.maximum_tool_roundtrips !== plan.maximum_tool_roundtrips
    || body.paid_retry_allowed !== false) throw new Error("LC4 qualification v3 authorization differs from its signed plan");
  requireId(body.authorization_id, "LC4 qualification v3 authorization ID");
  requireSha(body.authorization_nonce_sha256, "LC4 qualification v3 nonce");
  requireSha(body.terminal_public_key_fingerprint_sha256, "LC4 qualification v3 terminal key fingerprint");
  if (sha256Hex(Buffer.from(body.terminal_public_key_spki_base64, "base64")) !== body.terminal_public_key_fingerprint_sha256) {
    throw new Error("LC4 qualification v3 terminal key identity is invalid");
  }
  const start = requireIso(body.not_before, "authorization start");
  const end = requireIso(body.expires_at, "authorization expiry");
  if (end <= start
    || end - start > LC4_QUALIFICATION_V3_MAXIMUM_AUTHORIZATION_TTL_MS
    || input.now.getTime() < start
    || input.now.getTime() >= end) {
    throw new Error("LC4 qualification v3 authorization is inactive or exceeds its maximum TTL");
  }
}

function assertLc4QualificationV3ProviderAdmission(
  signedExpiresAt: number,
  at: Date,
): void {
  if (!Number.isFinite(at.getTime()) || at.getTime() >= signedExpiresAt) {
    throw new Error("LC4 qualification v3 authorization expired before provider admission");
  }
}

async function retainRoundtrip(partial: string, execution: Lc4S2sRoundtripExecution): Promise<void> {
  assertLc4S2sRoundtripExecution(execution);
  const { wire_observations, usage, sanitized_usage, ...summary } = execution;
  await Promise.all([
    writeImmutableJson(resolve(partial, `${execution.provider}-spoken-roundtrip.json`), freeze({ ...summary, wire_observation_count: wire_observations.length, usage_event_count: usage.length })),
    writeFile(resolve(partial, `${execution.provider}-spoken-roundtrip-wire.jsonl`), wire_observations.map((entry) => canonicalJson(entry)).join("\n") + (wire_observations.length ? "\n" : ""), { flag: "wx", mode: 0o400 }),
    writeFile(resolve(partial, `${execution.provider}-spoken-roundtrip-usage.jsonl`), sanitized_usage.map((entry) => canonicalJson(entry)).join("\n") + (sanitized_usage.length ? "\n" : ""), { flag: "wx", mode: 0o400 }),
  ]);
}

async function retainedPackageFiles(partial: string): Promise<readonly Lc4QualificationPackageFile[]> {
  const forbidden = /(?:^|\/)(?:qualification-package-envelope\.json|.*\.pem|.*\.env|budget.*signing-key)(?:$|\/)/u;
  const names = (await readdir(partial)).sort();
  if (names.some((name) => name.includes("/") || forbidden.test(name))) throw new Error("LC4 qualification v3 package contains a forbidden path");
  const files: Lc4QualificationPackageFile[] = [];
  for (const name of names) {
    const path = resolve(partial, name);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("LC4 qualification v3 package accepts only regular files");
    const bytes = await readFile(path);
    files.push(freeze({ path: name, bytes }));
  }
  return freeze(files);
}

function createInvocationArtifact(input: Readonly<{
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  trustRootFingerprint: string;
  terminalPrivateKeyPem: string;
  invokedAt: string;
}>): Lc4QualificationV3InvocationArtifact {
  const body: Lc4QualificationV3InvocationBody = freeze({
    schema_version: 1 as const,
    invocation_version: "HACC-LC4-QUALIFICATION-INVOCATION-v4" as const,
    attempt_id: input.authorization.body.authorization_id,
    invoked_at: input.invokedAt,
    plan_artifact_sha256: input.plan.artifact_sha256,
    plan_sha256: input.plan.body.plan_sha256,
    authorization: input.authorization,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    authorization_nonce_sha256: input.authorization.body.authorization_nonce_sha256,
    source_commit: input.plan.body.source.source_commit,
    source_tree_sha256: input.plan.body.source.source_tree_sha256,
    credential_set_sha256: input.plan.body.credential_set_sha256,
    terminal_public_key_fingerprint_sha256: input.authorization.body.terminal_public_key_fingerprint_sha256,
    trust_root_fingerprint_sha256: input.trustRootFingerprint,
    authorization_consumed: true as const,
  });
  return signedArtifact({
    body,
    privateKeyPem: input.terminalPrivateKeyPem,
    signingDomain: INVOCATION_DOMAIN,
    artifactDomain: INVOCATION_ARTIFACT_DOMAIN,
  });
}

function assertInvocationArtifact(
  artifact: Lc4QualificationV3InvocationArtifact,
  plan: Lc4QualificationV3PlanArtifact,
  authorization: Lc4QualificationV3AuthorizationArtifact,
  trustRootFingerprint: string,
): void {
  assertSignedArtifact({
    artifact,
    expectedFingerprint: authorization.body.terminal_public_key_fingerprint_sha256,
    signingDomain: INVOCATION_DOMAIN,
    artifactDomain: INVOCATION_ARTIFACT_DOMAIN,
  });
  const body = artifact.body;
  if (body.schema_version !== 1
    || body.invocation_version !== "HACC-LC4-QUALIFICATION-INVOCATION-v4"
    || body.authorization_consumed !== true
    || body.attempt_id !== authorization.body.authorization_id
    || body.plan_artifact_sha256 !== plan.artifact_sha256
    || body.plan_sha256 !== plan.body.plan_sha256
    || canonicalJson(body.authorization) !== canonicalJson(authorization)
    || body.authorization_artifact_sha256 !== authorization.artifact_sha256
    || body.authorization_nonce_sha256 !== authorization.body.authorization_nonce_sha256
    || body.source_commit !== plan.body.source.source_commit
    || body.source_tree_sha256 !== plan.body.source.source_tree_sha256
    || body.credential_set_sha256 !== plan.body.credential_set_sha256
    || body.terminal_public_key_fingerprint_sha256 !== authorization.body.terminal_public_key_fingerprint_sha256
    || body.trust_root_fingerprint_sha256 !== trustRootFingerprint) {
    throw boundaryError("invocation", "authorization_already_invoked");
  }
  requireIso(body.invoked_at, "LC4 qualification v3 invocation time");
}

async function writeInvocationTombstone(
  attemptsRoot: string,
  artifact: Lc4QualificationV3InvocationArtifact,
): Promise<void> {
  try {
    const rootMetadata = await lstat(dirname(attemptsRoot));
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("unsafe evidence root");
    try {
      await mkdir(attemptsRoot, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(attemptsRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("unsafe attempts root");
    await writeImmutableJson(resolve(attemptsRoot, `${artifact.body.attempt_id}.invoked.json`), artifact);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw boundaryError("invocation", "authorization_already_invoked");
    }
    throw boundaryError("invocation", "invocation_retention_failed");
  }
}

function refusalErrorSha256(
  authorization: Lc4QualificationV3AuthorizationArtifact,
  stage: "source" | "credentials",
  code: Lc4QualificationV3RefusalBody["code"],
): string {
  return sha256Hex(`${REFUSAL_ERROR_DOMAIN}${canonicalJson({
    authorization_nonce_sha256: authorization.body.authorization_nonce_sha256,
    stage,
    code,
  })}`);
}

async function retainPreProviderRefusal(input: Readonly<{
  attemptsRoot: string;
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  terminalPrivateKeyPem: string;
  invocation: Lc4QualificationV3InvocationArtifact;
  stage: "source" | "credentials";
  code: Lc4QualificationV3RefusalBody["code"];
  refusedAt: string;
  observedSourceTreeSha256: string | null;
  observedCredentialSetSha256: string | null;
}>): Promise<Lc4QualificationV3RefusalPackage> {
  const body: Lc4QualificationV3RefusalBody = freeze({
    schema_version: 1,
    refusal_version: "HACC-LC4-QUALIFICATION-REFUSAL-v4",
    attempt_id: input.authorization.body.authorization_id,
    refused_at: input.refusedAt,
    stage: input.stage,
    code: input.code,
    error_sha256: refusalErrorSha256(input.authorization, input.stage, input.code),
    invocation_artifact_sha256: input.invocation.artifact_sha256,
    plan_artifact_sha256: input.plan.artifact_sha256,
    plan_sha256: input.plan.body.plan_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    planned_source_tree_sha256: input.plan.body.source.source_tree_sha256,
    observed_source_tree_sha256: input.observedSourceTreeSha256,
    planned_credential_set_sha256: input.plan.body.credential_set_sha256,
    observed_credential_set_sha256: input.observedCredentialSetSha256,
    budget_reservation_created: false,
    budget_ledger_mutated: false,
    provider_clients_constructed: 0,
    provider_calls_made: 0,
  });
  const refusal = signedArtifact({
    body,
    privateKeyPem: input.terminalPrivateKeyPem,
    signingDomain: REFUSAL_DOMAIN,
    artifactDomain: REFUSAL_ARTIFACT_DOMAIN,
  });
  const packageBody = freeze({
    schema_version: 1 as const,
    package_version: "HACC-LC4-QUALIFICATION-REFUSAL-PACKAGE-v4" as const,
    authorization: input.authorization,
    refusal,
  });
  const artifact = freeze({
    ...packageBody,
    package_sha256: sha256Hex(`${REFUSAL_PACKAGE_DOMAIN}${canonicalJson(packageBody)}`),
  });
  try {
    await writeImmutableJson(resolve(input.attemptsRoot, `${body.attempt_id}.refusal.json`), artifact);
  } catch {
    throw boundaryError(input.stage, "refusal_retention_failed");
  }
  return artifact;
}

function assertRefusalPackage(input: Readonly<{
  artifact: Lc4QualificationV3RefusalPackage;
  invocation: Lc4QualificationV3InvocationArtifact;
  plan: Lc4QualificationV3PlanArtifact;
  trustRootFingerprint: string;
}>): void {
  const { package_sha256, ...packageBody } = input.artifact;
  if (input.artifact.schema_version !== 1
    || input.artifact.package_version !== "HACC-LC4-QUALIFICATION-REFUSAL-PACKAGE-v4"
    || package_sha256 !== sha256Hex(`${REFUSAL_PACKAGE_DOMAIN}${canonicalJson(packageBody)}`)) {
    throw new Error("LC4 qualification v3 refusal package failed integrity");
  }
  assertSignedArtifact({
    artifact: input.artifact.authorization,
    expectedFingerprint: input.trustRootFingerprint,
    signingDomain: AUTHORIZATION_DOMAIN,
    artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN,
  });
  const authorization = input.artifact.authorization;
  assertInvocationArtifact(input.invocation, input.plan, authorization, input.trustRootFingerprint);
  assertSignedArtifact({
    artifact: input.artifact.refusal,
    expectedFingerprint: authorization.body.terminal_public_key_fingerprint_sha256,
    signingDomain: REFUSAL_DOMAIN,
    artifactDomain: REFUSAL_ARTIFACT_DOMAIN,
  });
  const body = input.artifact.refusal.body;
  if (authorization.body.plan_artifact_sha256 !== input.plan.artifact_sha256
    || authorization.body.plan_sha256 !== input.plan.body.plan_sha256
    || body.attempt_id !== authorization.body.authorization_id
    || body.invocation_artifact_sha256 !== input.invocation.artifact_sha256
    || body.plan_artifact_sha256 !== input.plan.artifact_sha256
    || body.plan_sha256 !== input.plan.body.plan_sha256
    || body.authorization_artifact_sha256 !== authorization.artifact_sha256
    || body.planned_source_tree_sha256 !== input.plan.body.source.source_tree_sha256
    || body.planned_credential_set_sha256 !== input.plan.body.credential_set_sha256
    || body.error_sha256 !== refusalErrorSha256(authorization, body.stage, body.code)
    || body.budget_reservation_created !== false
    || body.budget_ledger_mutated !== false
    || body.provider_clients_constructed !== 0
    || body.provider_calls_made !== 0) {
    throw new Error("LC4 qualification v3 refusal binding failed integrity");
  }
  requireIso(body.refused_at, "LC4 qualification v3 refusal time");
}

export async function runLc4QualificationV3(input: Readonly<{
  root: string;
  repositoryRoot: string;
  credentialFiles?: Lc4QualificationV3CredentialFiles;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  trustRootFingerprint: string;
  terminalPrivateKeyPem: string;
  now?: () => Date;
  dependencies?: Dependencies;
}>): Promise<Lc4QualificationV3TerminalArtifact> {
  let root: string;
  let rootIdentity: Awaited<ReturnType<typeof validateLc4QualificationV3ExistingRoot>>;
  let repositoryRoot: string;
  let plan: Lc4QualificationV3PlanArtifact;
  try {
    repositoryRoot = absoluteNormalized(input.repositoryRoot, "LC4 qualification v3 repository root");
    rootIdentity = await validateLc4QualificationV3ExistingRoot(input.root, repositoryRoot);
    root = rootIdentity.path;
    plan = await readJson<Lc4QualificationV3PlanArtifact>(resolve(root, "lc4-qualification-v3-plan.json"));
    assertLc4QualificationV3PlanArtifact(plan, input.trustRootFingerprint);
  } catch {
    throw boundaryError("plan", "plan_validation_failed");
  }
  const now = input.now ?? (() => new Date());
  const validatedAt = now();
  try {
    assertLc4QualificationV3Authorization({
      artifact: input.authorization,
      plan,
      trustRootFingerprint: input.trustRootFingerprint,
      now: validatedAt,
    });
  } catch {
    throw boundaryError("authorization", "authorization_validation_failed");
  }
  freeze(input.authorization);
  const signedAuthorizationExpiresAt = requireIso(
    input.authorization.body.expires_at,
    "authorization expiry",
  );
  try {
    const terminalKey = keyIdentity(input.terminalPrivateKeyPem);
    if (terminalKey.fingerprint !== input.authorization.body.terminal_public_key_fingerprint_sha256) {
      throw new Error("terminal key differs from authorization");
    }
  } catch {
    throw boundaryError("terminal_key", "terminal_key_validation_failed");
  }
  const attemptId = input.authorization.body.authorization_id;
  const attemptsRoot = resolve(root, "attempts");
  const partial = resolve(attemptsRoot, `${attemptId}.partial`);
  const complete = resolve(attemptsRoot, `${attemptId}.complete`);
  const invocation = createInvocationArtifact({
    plan,
    authorization: input.authorization,
    trustRootFingerprint: input.trustRootFingerprint,
    terminalPrivateKeyPem: input.terminalPrivateKeyPem,
    invokedAt: validatedAt.toISOString(),
  });
  await reassertLc4QualificationV3ExistingRoot(rootIdentity);
  await writeInvocationTombstone(attemptsRoot, invocation);
  await reassertLc4QualificationV3ExistingRoot(rootIdentity);

  const dependencies = input.dependencies ?? defaultDependencies;
  let source: Lc4QualificationV3GitSource;
  try {
    source = await dependencies.inspectGitSource(repositoryRoot);
  } catch {
    await reassertLc4QualificationV3ExistingRoot(rootIdentity).catch(() => {
      throw boundaryError("plan", "plan_validation_failed");
    });
    const refusal = boundaryError("source", "source_inspection_failed");
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "source",
      code: "source_inspection_failed",
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: null,
      observedCredentialSetSha256: null,
    });
    throw refusal;
  }
  await reassertLc4QualificationV3ExistingRoot(rootIdentity).catch(() => {
    throw boundaryError("plan", "plan_validation_failed");
  });
  if (canonicalJson(source) !== canonicalJson(plan.body.source)) {
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "source",
      code: "source_mismatch",
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: source.source_tree_sha256,
      observedCredentialSetSha256: null,
    });
    throw boundaryError("source", "source_mismatch");
  }

  let credentials: Readonly<Record<LiveStsProvider, string>>;
  try {
    credentials = input.credentialFiles
      ? await loadLc4QualificationV3ExplicitCredentials(input.credentialFiles)
      : await dependencies.loadCredentials(repositoryRoot);
  } catch (error) {
    await reassertLc4QualificationV3ExistingRoot(rootIdentity).catch(() => {
      throw boundaryError("plan", "plan_validation_failed");
    });
    const code = error instanceof Lc4QualificationV3BoundaryError
      && (error.code === "credential_missing" || error.code === "credential_source_invalid")
      ? error.code
      : "credential_source_invalid";
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "credentials",
      code,
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: source.source_tree_sha256,
      observedCredentialSetSha256: null,
    });
    throw boundaryError("credentials", code);
  }
  await reassertLc4QualificationV3ExistingRoot(rootIdentity).catch(() => {
    throw boundaryError("plan", "plan_validation_failed");
  });
  let observedCredentialSetSha256: string;
  try {
    observedCredentialSetSha256 = credentialSetSha256(credentials);
  } catch {
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "credentials",
      code: "credential_missing",
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: source.source_tree_sha256,
      observedCredentialSetSha256: null,
    });
    throw boundaryError("credentials", "credential_missing");
  }
  if (observedCredentialSetSha256 !== plan.body.credential_set_sha256) {
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "credentials",
      code: "credential_set_mismatch",
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: source.source_tree_sha256,
      observedCredentialSetSha256,
    });
    throw boundaryError("credentials", "credential_set_mismatch");
  }
  await reassertLc4QualificationV3ExistingRoot(rootIdentity);
  await mkdir(partial, { mode: 0o700 });
  const attemptedAt = now().toISOString();
  const targets = createLc4QualificationV3Targets();
  const budgetBinding: Lc4QualificationBudgetBinding = freeze({
    attemptId,
    authorizationId: attemptId,
    authorizationArtifactSha256: input.authorization.artifact_sha256,
    planSha256: plan.body.plan_sha256,
    sourceCommit: plan.body.source.source_commit,
    sourceTreeSha256: plan.body.source.source_tree_sha256,
    credentialSetSha256: plan.body.credential_set_sha256,
    providerProfileManifestSha256: plan.body.provider_profile_manifest_sha256,
    configurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
    devConfigurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
    providersModels: freeze(Object.fromEntries(plan.body.targets.map((target) => [target.provider, target.model])) as Record<LiveStsProvider, string>),
    expiresAt: input.authorization.body.expires_at,
  });
  await reassertLc4QualificationV3ExistingRoot(rootIdentity);
  const budgetReservation = await reserveLc4QualificationBudget({ root, binding: budgetBinding, now });
  let setupArtifact: ProviderQualificationArtifact;
  let providerSessionsOpened = 0;
  let paidSessionsOpened = 0;
  let generationPhasesAttempted = 0;
  let toolRoundtripsAttempted = 0;
  let callerAudioBytes = 0;
  let primaryFailure: string | null = null;
  const executions: Lc4S2sRoundtripExecution[] = [];
  let budgetEvidence: Lc4QualificationBudgetEvidence | null = null;
  let xaiGateARisk: Lc4XaiServerVadGateARiskArtifact | null = null;
  try {
    await writeImmutableJson(resolve(partial, "intent.json"), freeze({
      schema_version: 1,
      plan_artifact_sha256: plan.artifact_sha256,
      authorization_artifact_sha256: input.authorization.artifact_sha256,
      attempt_id: attemptId,
      attempted_at: attemptedAt,
      provider_order: LC4_QUALIFICATION_V3_PROVIDER_ORDER,
      paid_retry_allowed: false,
    }));
    await writeImmutableJson(resolve(partial, "authorization.json"), input.authorization);
    await writeImmutableJson(resolve(partial, "control-size-diagnostic.json"), plan.body.control_size_diagnostic);
    setupArtifact = await qualifyProviders({
      root,
      protocolId: plan.body.protocol_id,
      planSha256: plan.body.plan_sha256,
      sourceCommit: plan.body.source.source_commit,
      targets,
      credentials,
      createClient: async (target, apiKey) => {
        await reassertLc4QualificationV3ExistingRoot(rootIdentity);
        assertLc4QualificationV3ProviderAdmission(signedAuthorizationExpiresAt, now());
        providerSessionsOpened += 1;
        return dependencies.createClient(target.provider, target.configuration, apiKey);
      },
      now,
      qualificationId: attemptId,
    });
    assertProviderQualificationArtifactIntegrity(setupArtifact);
    await writeImmutableJson(resolve(partial, "setup-acceptance.json"), setupArtifact);
    const xaiSetup = setupArtifact.results.find((result) => result.provider === "xai");
    if (!xaiSetup) throw new Error("LC4 qualification v3 setup lacks xAI evidence");
    xaiGateARisk = createXaiServerVadGateARiskArtifact({
      setup: xaiSetup,
      sourceCommit: plan.body.source.source_commit,
      planSha256: plan.body.plan_sha256,
      configurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
      providerProfileManifestSha256: plan.body.provider_profile_manifest_sha256,
      productionSessionPayloadSha256: plan.body.targets.find((target) => target.provider === "xai")!
        .production_session_payload_sha256!,
    });
    assertXaiServerVadGateARiskArtifact(xaiGateARisk);
    await writeImmutableJson(resolve(partial, "xai-server-vad-gate-a-risk.json"), xaiGateARisk);
    if (setupArtifact.status === "failed") primaryFailure = "setup_acceptance_failed";
    if (primaryFailure === null) {
      for (const provider of LC4_QUALIFICATION_V3_PROVIDER_ORDER) {
        const target = targets.find((entry) => entry.provider === provider)!;
        const planned = plan.body.targets.find((entry) => entry.provider === provider)!;
        const audio = await loadLc4S2sPcm({ root, artifact: plan.body.audio_fixture, provider });
        await reassertLc4QualificationV3ExistingRoot(rootIdentity);
        assertLc4QualificationV3ProviderAdmission(signedAuthorizationExpiresAt, now());
        paidSessionsOpened += 1;
        providerSessionsOpened += 1;
        generationPhasesAttempted += 2;
        toolRoundtripsAttempted += 1;
        const execution = await dependencies.executeRoundtrip({
          provider,
          model: target.model,
          client: dependencies.createClient(provider, target.configuration, credentials[provider]),
          audio,
          audioObject: plan.body.audio_fixture.provider_renditions[provider],
          profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
          timeoutMs: 45_000,
          now,
        });
        await reassertLc4QualificationV3ExistingRoot(rootIdentity);
        if (execution.audio.sha256 !== planned.caller_audio_sha256
          || execution.audio.byte_length !== planned.caller_audio_bytes
          || execution.tool_schema_sha256 !== planned.gateway_schema_sha256) throw new Error(`LC4 qualification v3 ${provider} execution differs from plan`);
        assertLc4S2sRoundtripExecution(execution);
        await retainRoundtrip(partial, execution);
        executions.push(execution);
        callerAudioBytes += execution.delivery?.audio_bytes ?? 0;
        if (execution.status === "failed" && primaryFailure === null) primaryFailure = `${provider}:${execution.failure_class}`;
      }
    }
  } catch (error) {
    primaryFailure ??= error instanceof Error ? `runner_exception:${sha256Hex(error.message)}` : "runner_exception";
    setupArtifact ??= freeze({
      schemaVersion: 3,
      qualificationId: attemptId,
      protocolId: plan.body.protocol_id,
      planSha256: plan.body.plan_sha256,
      sourceCommit: plan.body.source.source_commit,
      configurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
      credentialSetSha256: plan.body.credential_set_sha256,
      probeScope: "session_handshake_and_configuration_acknowledgement_no_audio_no_generation",
      attemptedAt,
      completedAt: now().toISOString(),
      status: "failed",
      results: freeze([]),
      artifactSha256: sha256Hex(`runner-exception:${attemptId}`),
    });
  } finally {
    await reassertLc4QualificationV3ExistingRoot(rootIdentity);
    const usageProjection = executions.flatMap((execution) => execution.sanitized_usage);
    budgetEvidence = await finalizeLc4QualificationBudget({
      reservation: budgetReservation,
      attemptId,
      usageEventCount: usageProjection.length,
      usageEvidenceSha256: sha256Hex(canonicalJson(usageProjection)),
      outcome: primaryFailure === null ? "completed" : "failed",
      now,
    });
    assertLc4QualificationBudgetEvidence(budgetEvidence);
    await writeImmutableJson(resolve(partial, "budget-settlement.json"), budgetEvidence);
  }
  if (providerSessionsOpened > plan.body.maximum_provider_sessions
    || paidSessionsOpened > plan.body.maximum_paid_sessions
    || generationPhasesAttempted > plan.body.maximum_generation_phases
    || toolRoundtripsAttempted > plan.body.maximum_tool_roundtrips) {
    primaryFailure ??= "planned_counter_ceiling_exceeded";
  }
  const xaiSetup = setupArtifact!.results.find((result) => result.provider === "xai");
  const xaiExecution = executions.find((execution) => execution.provider === "xai");
  const xaiGateAClassification = xaiSetup?.turnBoundaryVerification === "verified_by_provider_echo"
    ? "verified_by_provider_echo" as const
    : (xaiSetup?.code === "acknowledged_unverifiable_server_vad"
      || xaiSetup?.code === "initial_snapshot_exact_only")
      ? "acknowledged_unverifiable_server_vad" as const
      : "failed" as const;
  const xaiGateBStatus = xaiExecution === undefined
    ? "not_run" as const
    : xaiExecution.status === "passed"
      ? "behaviorally_verified" as const
      : "failed" as const;
  if (xaiGateARisk === null) {
    const fallbackXaiSetup = setupArtifact!.results.find((result) => result.provider === "xai");
    if (!fallbackXaiSetup) throw new Error("LC4 qualification v3 cannot retain xAI Gate A risk");
    xaiGateARisk = createXaiServerVadGateARiskArtifact({
      setup: fallbackXaiSetup,
      sourceCommit: plan.body.source.source_commit,
      planSha256: plan.body.plan_sha256,
      configurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
      providerProfileManifestSha256: plan.body.provider_profile_manifest_sha256,
      productionSessionPayloadSha256: plan.body.targets.find((target) => target.provider === "xai")!
        .production_session_payload_sha256!,
    });
    await writeImmutableJson(resolve(partial, "xai-server-vad-gate-a-risk.json"), xaiGateARisk);
  }
  assertXaiServerVadGateARiskArtifact(xaiGateARisk);
  const expectedXaiTransportParity = plan.body.targets.find((target) => target.provider === "xai")!
    .xai_transport_parity_sha256!;
  const xaiGateBBinding = xaiExecution?.status === "passed"
    ? createXaiServerVadGateBBindingArtifact({
        risk: xaiGateARisk,
        execution: xaiExecution,
        sourceCommit: plan.body.source.source_commit,
        planSha256: plan.body.plan_sha256,
        providerProfileManifestSha256: plan.body.provider_profile_manifest_sha256,
        expectedTransportParitySha256: expectedXaiTransportParity,
      })
    : null;
  if (xaiGateBBinding !== null) {
    assertXaiServerVadGateBBindingArtifact({
      artifact: xaiGateBBinding,
      risk: xaiGateARisk,
      execution: xaiExecution!,
      expectedTransportParitySha256: expectedXaiTransportParity,
    });
    await writeImmutableJson(resolve(partial, "xai-server-vad-gate-b-binding.json"), xaiGateBBinding);
  }
  const gateBConnectionEpoch = xaiExecution?.wire_observations.find((observation) => (
    observation.direction === "outbound" && observation.wireType === "session.update"
  ))?.connectionEpoch ?? null;
  const gateAConnectionEpoch = xaiGateARisk.setup_wire_evidence?.connectionEpoch
    ?? xaiGateARisk.setup_failure_evidence?.connectionEpoch
    ?? null;
  const serverVadQualification = freeze({
    provider: "xai" as const,
    requested_setting_sha256: LC4_XAI_SERVER_VAD_SETTING_SHA256,
    production_session_payload_sha256: xaiGateARisk.production_session_payload_sha256,
    gate_a_classification: xaiGateAClassification,
    retained_risk: xaiGateAClassification === "acknowledged_unverifiable_server_vad"
      ? "provider_omitted_turn_detection_fields" as const
      : "none" as const,
    gate_b_required: true as const,
    gate_b_status: xaiGateBStatus,
    gate_b_evidence_sha256: xaiExecution?.evidence_sha256 ?? null,
    gate_b_binding_sha256: xaiGateBBinding?.binding_sha256 ?? null,
    gate_a_risk_sha256: xaiGateARisk.risk_sha256,
    gate_a_connection_epoch: gateAConnectionEpoch,
    gate_b_connection_epoch: gateBConnectionEpoch,
    exact_setting_verified: xaiGateAClassification === "verified_by_provider_echo",
    operational_vad_verified: xaiGateBStatus === "behaviorally_verified",
    claims: freeze({
      operational_gateway: xaiGateBBinding === null ? "not_verified" as const : "verified" as const,
      operational_server_vad: xaiGateBBinding === null ? "not_verified" as const : "verified" as const,
      exact_gateway_name_and_arguments: xaiGateBBinding === null ? "not_verified" as const : "verified" as const,
      matching_gateway_result: xaiGateBBinding === null ? "not_verified" as const : "verified" as const,
      sole_post_tool_continuation_terminal_usage: xaiGateBBinding === null ? "not_verified" as const : "verified" as const,
      full_gateway_schema: xaiSetup?.toolSchemaVerification === "verified_by_provider_echo"
        && xaiSetup.configurationEvidence?.fields.tools.status === "verified"
        ? "verified_by_provider_echo" as const
        : "unverifiable" as const,
      gateway_description: xaiSetup?.toolSchemaVerification === "verified_by_provider_echo"
        && xaiSetup.configurationEvidence?.fields.tools.status === "verified"
        ? "verified_by_provider_echo" as const
        : "unverifiable" as const,
      post_update_voice: xaiSetup?.configurationEvidence?.fields.voice.status === "verified"
        ? "verified_by_provider_echo" as const
        : "unverifiable" as const,
      input_transcription: "not_requested" as const,
      idle_timeout: "documented_default_not_independently_verified" as const,
      exact_vad_parameters: xaiGateAClassification === "verified_by_provider_echo"
        ? "verified_by_provider_echo" as const
        : "unverifiable" as const,
      created_to_updated_session_identity: xaiGateARisk.created_to_updated_session_identity,
      dynamic_update_configuration: xaiGateBBinding === null
        ? "not_verified" as const
        : xaiGateBBinding.dynamic_update_provider_echo === "verified"
          ? "verified_by_provider_echo" as const
          : "behaviorally_verified_not_provider_echoed" as const,
    }),
    benchmark_ready: xaiGateAClassification !== "failed"
      && xaiGateBStatus === "behaviorally_verified"
      && xaiGateBBinding !== null
      && gateAConnectionEpoch !== null
      && gateBConnectionEpoch !== null,
  });
  if (xaiGateAClassification === "acknowledged_unverifiable_server_vad"
    && xaiGateBStatus !== "behaviorally_verified") {
    primaryFailure ??= `xai:server_vad_behavioral_verification_${xaiGateBStatus}`;
  }
  const setupWire = LC4_QUALIFICATION_V3_PROVIDER_ORDER.flatMap((provider) => {
    const result = setupArtifact!.results.find((candidate) => candidate.provider === provider);
    if (result?.setupWireEvidence !== undefined) return [result.setupWireEvidence];
    if (result?.setupFailureEvidence !== undefined) return [{ observations: result.setupFailureEvidence.observations }];
    return [];
  });
  const replayHeads = [
    ...setupWire.flatMap((evidence) => {
      const head = evidence.observations.at(-1)?.observationSha256;
      return head === undefined ? [] : [head];
    }),
    ...executions.map((execution) => execution.wire_observations.at(-1)?.observationSha256 ?? null),
  ];
  const reconnectCount = [
    ...setupWire.flatMap((evidence) => evidence.observations),
    ...executions.flatMap((execution) => execution.wire_observations),
  ].filter((observation) => observation.connectionEpoch !== 1).length;
  const replaySha256s = executions.flatMap((execution) => execution.replay_sha256 === null ? [] : [execution.replay_sha256]);
  const replayArtifactSha256 = sha256Hex(`${REPLAY_AGGREGATE_DOMAIN}${canonicalJson(replaySha256s)}`);
  const replayChainHeadSha256 = replayHeads.length === 0 || replayHeads.some((head) => head === null)
    ? null
    : sha256Hex(`${REPLAY_AGGREGATE_DOMAIN}${canonicalJson(replayHeads)}`);
  const packageBindings = freeze({
    attempt_id: attemptId,
    source_commit: plan.body.source.source_commit,
    source_tree_oid: plan.body.source.source_tree_oid,
    source_tree_sha256: plan.body.source.source_tree_sha256,
    plan_artifact_sha256: plan.artifact_sha256,
    plan_sha256: plan.body.plan_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    setup_qualification_artifact_sha256: setupArtifact!.artifactSha256,
    budget_evidence_sha256: budgetEvidence!.evidence_sha256,
    budget_final_head_sha256: budgetEvidence!.final_head_sha256,
    provider_session_count: providerSessionsOpened,
    paid_session_count: executions.length,
    generation_phase_count: executions.length * 2,
    tool_roundtrip_count: executions.length,
    retry_count: 0,
    reconnect_count: reconnectCount,
    replay_artifact_sha256: replayArtifactSha256,
    replay_event_count: setupWire.reduce((total, evidence) => total + evidence.observations.length, 0)
      + executions.reduce((total, execution) => total + execution.wire_observations.length, 0),
    replay_chain_head_sha256: replayChainHeadSha256,
  }) satisfies Lc4QualificationPackageBindingsV5;
  if (primaryFailure === null && (
    setupWire.length !== 3
    || executions.length !== 3
    || reconnectCount !== 0
    || replaySha256s.length !== 3
    || replayChainHeadSha256 === null
    || packageBindings.provider_session_count !== providerSessionsOpened
    || packageBindings.paid_session_count !== paidSessionsOpened
    || packageBindings.generation_phase_count !== generationPhasesAttempted
    || packageBindings.tool_roundtrip_count !== toolRoundtripsAttempted
  )) primaryFailure = "replay_derived_session_or_counter_mismatch";
  const preTerminalFiles = await retainedPackageFiles(partial);
  const payloadManifest = createLc4QualificationPayloadManifestV5({
    files: freeze([...preTerminalFiles, freeze({ path: "terminal.json", bytes: Buffer.from("pending") })]),
    terminalPath: "terminal.json",
    envelopePath: "qualification-package-envelope.json",
  });
  const terminalWithoutHash = freeze({
    schema_version: 3 as const,
    terminal_version: "HACC-LC4-QUALIFICATION-TERMINAL-v6" as const,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    attempt_id: attemptId,
    plan_artifact_sha256: plan.artifact_sha256,
    plan_sha256: plan.body.plan_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    source_commit: plan.body.source.source_commit,
    source_tree_sha256: plan.body.source.source_tree_sha256,
    attempted_at: attemptedAt,
    completed_at: now().toISOString(),
    status: primaryFailure === null && executions.length === 3 && executions.every((execution) => execution.status === "passed") ? "passed" as const : "failed" as const,
    primary_failure_class: primaryFailure,
    setup_qualification_artifact_sha256: setupArtifact!.artifactSha256,
    control_size_diagnostic_sha256: plan.body.control_size_diagnostic.diagnostic_sha256,
    roundtrip_evidence_sha256: freeze(executions.map((execution) => execution.evidence_sha256)),
    roundtrip_public_execution_sha256: freeze(executions.map((execution) => execution.public_execution_sha256!)),
    roundtrip_replay_sha256: freeze(executions.map((execution) => execution.replay_sha256!)),
    payload_root_sha256: payloadManifest.payload_root_sha256,
    package_bindings: packageBindings,
    budget_evidence_sha256: budgetEvidence!.evidence_sha256,
    budget_final_head_sha256: budgetEvidence!.final_head_sha256,
    provider_sessions_opened: providerSessionsOpened,
    paid_sessions_opened: paidSessionsOpened,
    generation_phases_attempted: generationPhasesAttempted,
    tool_roundtrips_attempted: toolRoundtripsAttempted,
    caller_audio_bytes: callerAudioBytes,
    paid_retries_attempted: 0 as const,
    server_vad_qualification: serverVadQualification,
    results: freeze(executions.map((execution) => freeze({
      provider: execution.provider,
      model: execution.model,
      status: execution.status,
      failure_class: execution.failure_class,
      caller_audio_bytes: execution.delivery?.audio_bytes ?? 0,
      wire_observation_count: execution.wire_observations.length,
      usage_event_count: execution.usage.length,
      evidence_sha256: execution.evidence_sha256,
    }))),
  });
  const terminalBody = freeze({ ...terminalWithoutHash, terminal_sha256: sha256Hex(`${TERMINAL_DOMAIN}${canonicalJson(terminalWithoutHash)}`) });
  const terminal = signedArtifact({ body: terminalBody, privateKeyPem: input.terminalPrivateKeyPem, signingDomain: TERMINAL_DOMAIN, artifactDomain: TERMINAL_ARTIFACT_DOMAIN });
  await writeImmutableJson(resolve(partial, "terminal.json"), terminal);
  const packageFiles = await retainedPackageFiles(partial);
  const envelope = createSignedLc4QualificationPackageEnvelopeV5({
    files: packageFiles,
    terminalClaims: freeze({
      terminal_artifact_sha256: terminal.artifact_sha256,
      payload_root_sha256: terminal.body.payload_root_sha256,
      bindings: terminal.body.package_bindings,
    }),
    terminalPath: "terminal.json",
    envelopePath: "qualification-package-envelope.json",
    authorityPrivateKeyPem: input.terminalPrivateKeyPem,
  });
  await writeImmutableJson(resolve(partial, "qualification-package-envelope.json"), envelope);
  await reassertLc4QualificationV3ExistingRoot(rootIdentity);
  await rename(partial, complete);
  return terminal;
}

export async function reportLc4QualificationV3(input: Readonly<{
  root: string;
  trustRootFingerprint: string;
}>): Promise<Readonly<Record<string, unknown>>> {
  const root = (await validateLc4QualificationV3ExistingRoot(input.root)).path;
  const plan = await readJson<Lc4QualificationV3PlanArtifact>(resolve(root, "lc4-qualification-v3-plan.json"));
  assertLc4QualificationV3PlanArtifact(plan, input.trustRootFingerprint);
  const attemptsRoot = resolve(root, "attempts");
  const names = await readdir(attemptsRoot).catch(() => [] as string[]);
  const invocationNames = names.filter((name) => name.endsWith(".invoked.json")).sort();
  const refusalNames = names.filter((name) => name.endsWith(".refusal.json")).sort();
  const completeNames = names.filter((name) => name.endsWith(".complete")).sort();
  const partialNames = names.filter((name) => name.endsWith(".partial")).sort();
  const recognizedNames = new Set([...invocationNames, ...refusalNames, ...completeNames, ...partialNames]);
  if (recognizedNames.size !== names.length) throw new Error("LC4 qualification v3 attempts root contains an unknown entry");

  const invocations = new Map<string, Lc4QualificationV3InvocationArtifact>();
  for (const name of invocationNames) {
    const attemptId = name.slice(0, -".invoked.json".length);
    const invocation = await readJson<Lc4QualificationV3InvocationArtifact>(resolve(attemptsRoot, name));
    const authorization = invocation.body.authorization;
    assertSignedArtifact({
      artifact: authorization,
      expectedFingerprint: input.trustRootFingerprint,
      signingDomain: AUTHORIZATION_DOMAIN,
      artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN,
    });
    assertInvocationArtifact(invocation, plan, authorization, input.trustRootFingerprint);
    if (invocation.body.attempt_id !== attemptId || invocations.has(attemptId)) {
      throw new Error("LC4 qualification v3 invocation filename is not canonical");
    }
    invocations.set(attemptId, invocation);
  }

  const refusals = new Map<string, Lc4QualificationV3RefusalPackage>();
  for (const name of refusalNames) {
    const attemptId = name.slice(0, -".refusal.json".length);
    const invocation = invocations.get(attemptId);
    if (!invocation) throw new Error("LC4 qualification v3 refusal lacks an invocation tombstone");
    const refusal = await readJson<Lc4QualificationV3RefusalPackage>(resolve(attemptsRoot, name));
    assertRefusalPackage({
      artifact: refusal,
      invocation,
      plan,
      trustRootFingerprint: input.trustRootFingerprint,
    });
    if (refusal.refusal.body.attempt_id !== attemptId || refusals.has(attemptId)) {
      throw new Error("LC4 qualification v3 refusal filename is not canonical");
    }
    refusals.set(attemptId, refusal);
  }

  const verified: Lc4QualificationV3TerminalArtifact[] = [];
  let sealedPreRetentionRunnerExceptions = 0;
  const completeIds = new Set<string>();
  for (const name of completeNames) {
    const attemptId = name.slice(0, -".complete".length);
    const invocation = invocations.get(attemptId);
    if (!invocation || refusals.has(attemptId) || completeIds.has(attemptId)) {
      throw new Error("LC4 qualification v3 complete attempt has an invalid invocation state");
    }
    const directory = resolve(attemptsRoot, name);
    const [authorization, terminal, retainedPackage] = await Promise.all([
      readJson<Lc4QualificationV3AuthorizationArtifact>(resolve(directory, "authorization.json")),
      readJson<Lc4QualificationV3TerminalArtifact>(resolve(directory, "terminal.json")),
      readLc4QualificationPackageDirectoryV5({
        directory,
        envelopePath: "qualification-package-envelope.json",
      }),
    ]);
    assertSignedArtifact({
      artifact: authorization,
      expectedFingerprint: input.trustRootFingerprint,
      signingDomain: AUTHORIZATION_DOMAIN,
      artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN,
    });
    assertInvocationArtifact(invocation, plan, authorization, input.trustRootFingerprint);
    if (authorization.body.plan_artifact_sha256 !== plan.artifact_sha256
      || authorization.body.plan_sha256 !== plan.body.plan_sha256) throw new Error("LC4 qualification v3 retained authorization is cross-plan");
    assertSignedArtifact({
      artifact: terminal,
      expectedFingerprint: authorization.body.terminal_public_key_fingerprint_sha256,
      signingDomain: TERMINAL_DOMAIN,
      artifactDomain: TERMINAL_ARTIFACT_DOMAIN,
    });
    const { terminal_sha256, ...terminalBody } = terminal.body;
    if (terminal_sha256 !== sha256Hex(`${TERMINAL_DOMAIN}${canonicalJson(terminalBody)}`)
      || terminal.body.schema_version !== 3
      || terminal.body.terminal_version !== "HACC-LC4-QUALIFICATION-TERMINAL-v6"
      || terminal.body.plan_artifact_sha256 !== plan.artifact_sha256
      || terminal.body.authorization_artifact_sha256 !== authorization.artifact_sha256
      || terminal.body.source_commit !== plan.body.source.source_commit
      || terminal.body.source_tree_sha256 !== plan.body.source.source_tree_sha256) {
      throw new Error("LC4 qualification v3 terminal binding failed integrity");
    }
    await verifySignedLc4QualificationPackageEnvelopeV5({
      envelope: retainedPackage.envelope,
      files: retainedPackage.files,
      expectedAuthorityFingerprintSha256: authorization.body.terminal_public_key_fingerprint_sha256,
      verifyTerminal: (bytes): Lc4QualificationTerminalClaimsV5 => {
        const retained = JSON.parse(Buffer.from(bytes).toString("utf8")) as Lc4QualificationV3TerminalArtifact;
        assertSignedArtifact({
          artifact: retained,
          expectedFingerprint: authorization.body.terminal_public_key_fingerprint_sha256,
          signingDomain: TERMINAL_DOMAIN,
          artifactDomain: TERMINAL_ARTIFACT_DOMAIN,
        });
        if (canonicalJson(retained) !== canonicalJson(terminal)) {
          throw new Error("LC4 qualification envelope terminal differs from retained terminal");
        }
        return freeze({
          terminal_artifact_sha256: retained.artifact_sha256,
          payload_root_sha256: retained.body.payload_root_sha256,
          bindings: retained.body.package_bindings,
        });
      },
    });
    const packageBindings = terminal.body.package_bindings;
    if (packageBindings.attempt_id !== terminal.body.attempt_id
      || packageBindings.source_commit !== terminal.body.source_commit
      || packageBindings.source_tree_oid !== plan.body.source.source_tree_oid
      || packageBindings.source_tree_sha256 !== terminal.body.source_tree_sha256
      || packageBindings.plan_artifact_sha256 !== terminal.body.plan_artifact_sha256
      || packageBindings.plan_sha256 !== terminal.body.plan_sha256
      || packageBindings.authorization_artifact_sha256 !== terminal.body.authorization_artifact_sha256
      || packageBindings.setup_qualification_artifact_sha256 !== terminal.body.setup_qualification_artifact_sha256
      || packageBindings.budget_evidence_sha256 !== terminal.body.budget_evidence_sha256
      || packageBindings.budget_final_head_sha256 !== terminal.body.budget_final_head_sha256
      || packageBindings.provider_session_count !== terminal.body.provider_sessions_opened
      || packageBindings.paid_session_count !== terminal.body.paid_sessions_opened
      || packageBindings.generation_phase_count !== terminal.body.generation_phases_attempted
      || packageBindings.tool_roundtrip_count !== terminal.body.tool_roundtrips_attempted
      || packageBindings.retry_count !== terminal.body.paid_retries_attempted
      || packageBindings.reconnect_count !== 0
      || packageBindings.replay_artifact_sha256 !== sha256Hex(
        `${REPLAY_AGGREGATE_DOMAIN}${canonicalJson(terminal.body.roundtrip_replay_sha256)}`,
      )) {
      throw new Error("LC4 qualification signed package bindings differ from terminal authority");
    }
    const xaiResult = terminal.body.results.find((result) => result.provider === "xai");
    const serverVad = terminal.body.server_vad_qualification;
    const expectedServerVadReady = serverVad.gate_a_classification !== "failed"
      && serverVad.gate_b_status === "behaviorally_verified"
      && xaiResult?.status === "passed"
      && serverVad.gate_b_evidence_sha256 === xaiResult.evidence_sha256
      && typeof serverVad.gate_b_binding_sha256 === "string"
      && SHA256.test(serverVad.gate_b_binding_sha256)
      && serverVad.gate_a_connection_epoch !== null
      && serverVad.gate_b_connection_epoch !== null;
    if (serverVad.provider !== "xai"
      || serverVad.requested_setting_sha256 !== LC4_XAI_SERVER_VAD_SETTING_SHA256
      || serverVad.production_session_payload_sha256 !== plan.body.targets.find((target) => target.provider === "xai")
        ?.production_session_payload_sha256
      || serverVad.gate_b_required !== true
      || !SHA256.test(serverVad.gate_a_risk_sha256)
      || (serverVad.gate_b_binding_sha256 !== null && !SHA256.test(serverVad.gate_b_binding_sha256))
      || serverVad.retained_risk !== (serverVad.gate_a_classification === "acknowledged_unverifiable_server_vad"
        ? "provider_omitted_turn_detection_fields"
        : "none")
      || serverVad.benchmark_ready !== expectedServerVadReady
      || serverVad.claims.input_transcription !== "not_requested"
      || serverVad.claims.idle_timeout !== "documented_default_not_independently_verified"
      || (terminal.body.status === "passed" && !serverVad.benchmark_ready)) {
      throw new Error("LC4 qualification v3 server-VAD promotion binding failed integrity");
    }
    if (terminal.body.status === "passed" && (
      terminal.body.roundtrip_public_execution_sha256.length !== LC4_QUALIFICATION_V3_PROVIDER_ORDER.length
      || terminal.body.roundtrip_replay_sha256.length !== LC4_QUALIFICATION_V3_PROVIDER_ORDER.length
      || terminal.body.provider_sessions_opened !== LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS
      || terminal.body.paid_sessions_opened !== LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS
      || terminal.body.generation_phases_attempted !== LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES
      || terminal.body.tool_roundtrips_attempted !== LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS
      || terminal.body.paid_retries_attempted !== 0
    )) throw new Error("LC4 qualification terminal lacks three replay-derived roundtrip bindings");
    const paidReplayHeads: string[] = [];
    let paidReplayEventCount = 0;
    for (const [providerIndex, provider] of terminal.body.results.map((result, index) => (
      [index, result.provider] as const
    ))) {
      const [summary, retainedWire, retainedUsage] = await Promise.all([
        readJson<RetainedRoundtripSummary>(resolve(directory, `${provider}-spoken-roundtrip.json`)),
        readJsonLines<RealtimeWireObservation>(resolve(directory, `${provider}-spoken-roundtrip-wire.jsonl`)),
        readJsonLines<RoundtripSanitizedUsage>(resolve(directory, `${provider}-spoken-roundtrip-usage.jsonl`)),
      ]);
      const terminalResult = terminal.body.results[providerIndex];
      if (!terminalResult || terminalResult.provider !== provider) {
        throw new Error("LC4 qualification terminal provider order is not canonical");
      }
      assertRetainedProviderReplayEvidence({
        provider,
        summary,
        wire: retainedWire,
        usage: retainedUsage,
        terminalResult,
        terminalPublicExecutionSha256: terminal.body.roundtrip_public_execution_sha256[providerIndex]!,
        terminalReplaySha256: terminal.body.roundtrip_replay_sha256[providerIndex]!,
      });
      const paidHead = retainedWire.at(-1)?.observationSha256;
      if (!paidHead) throw new Error(`LC4 qualification ${provider} replay has no terminal chain head`);
      paidReplayHeads.push(paidHead);
      paidReplayEventCount += retainedWire.length;
    }
    const retainedPaths = new Set(retainedPackage.files.map((file) => file.path));
    const setupQualification = retainedPaths.has("setup-acceptance.json")
      ? await readJson<ProviderQualificationArtifact>(resolve(directory, "setup-acceptance.json"))
      : null;
    const gateARisk = await readJson<Lc4XaiServerVadGateARiskArtifact>(resolve(directory, "xai-server-vad-gate-a-risk.json"));
    const gateBBinding = serverVad.gate_b_binding_sha256 === null
      ? null
      : await readJson<Lc4XaiServerVadGateBBindingArtifact>(resolve(directory, "xai-server-vad-gate-b-binding.json"));
    assertXaiServerVadGateARiskArtifact(gateARisk);
    if (setupQualification === null) {
      const retainedGateAWire =
        gateARisk.setup_wire_evidence ?? gateARisk.setup_failure_evidence;
      if (
        terminal.body.status !== "failed" ||
        !/^runner_exception:[a-f0-9]{64}$/u.test(
          terminal.body.primary_failure_class ?? "",
        ) ||
        terminal.body.results.length !== 0 ||
        terminal.body.roundtrip_evidence_sha256.length !== 0 ||
        terminal.body.roundtrip_public_execution_sha256.length !== 0 ||
        terminal.body.roundtrip_replay_sha256.length !== 0 ||
        terminal.body.provider_sessions_opened !==
          LC4_QUALIFICATION_V3_PROVIDER_ORDER.length ||
        terminal.body.paid_sessions_opened !== 0 ||
        terminal.body.generation_phases_attempted !== 0 ||
        terminal.body.tool_roundtrips_attempted !== 0 ||
        terminal.body.caller_audio_bytes !== 0 ||
        terminal.body.paid_retries_attempted !== 0 ||
        serverVad.gate_b_status !== "not_run" ||
        serverVad.gate_b_evidence_sha256 !== null ||
        serverVad.gate_b_binding_sha256 !== null ||
        serverVad.gate_b_connection_epoch !== null ||
        serverVad.operational_vad_verified ||
        serverVad.benchmark_ready ||
        gateBBinding !== null ||
        retainedGateAWire === null ||
        retainedGateAWire.observations.length === 0 ||
        packageBindings.replay_event_count <
          retainedGateAWire.observations.length +
            (LC4_QUALIFICATION_V3_PROVIDER_ORDER.length - 1) * 2 ||
        packageBindings.replay_chain_head_sha256 === null ||
        packageBindings.reconnect_count !== 0
      ) {
        throw new Error(
          "LC4 qualification setup acceptance is missing outside the sealed pre-retention runner-exception boundary",
        );
      }
      if (
        gateARisk.risk_sha256 !== serverVad.gate_a_risk_sha256 ||
        gateARisk.source_commit !== plan.body.source.source_commit ||
        gateARisk.plan_sha256 !== plan.body.plan_sha256 ||
        gateARisk.configuration_matrix_sha256 !==
          plan.body.setup_configuration_matrix_sha256 ||
        gateARisk.provider_profile_manifest_sha256 !==
          plan.body.provider_profile_manifest_sha256 ||
        gateARisk.production_session_payload_sha256 !==
          serverVad.production_session_payload_sha256 ||
        retainedGateAWire.connectionEpoch !==
          serverVad.gate_a_connection_epoch ||
        serverVad.claims.operational_gateway !== "not_verified" ||
        serverVad.claims.operational_server_vad !== "not_verified" ||
        serverVad.claims.exact_gateway_name_and_arguments !== "not_verified" ||
        serverVad.claims.matching_gateway_result !== "not_verified" ||
        serverVad.claims.sole_post_tool_continuation_terminal_usage !==
          "not_verified" ||
        (serverVad.claims.full_gateway_schema === "verified_by_provider_echo" &&
          gateARisk.field_evidence?.fields.tools.status !== "verified") ||
        (serverVad.claims.gateway_description === "verified_by_provider_echo" &&
          gateARisk.field_evidence?.fields.tools.status !== "verified") ||
        (serverVad.claims.post_update_voice === "verified_by_provider_echo" &&
          gateARisk.field_evidence?.fields.voice.status !== "verified") ||
        serverVad.claims.exact_vad_parameters !==
          (serverVad.gate_a_classification === "verified_by_provider_echo"
            ? "verified_by_provider_echo"
            : "unverifiable") ||
        serverVad.claims.created_to_updated_session_identity !==
          gateARisk.created_to_updated_session_identity ||
        serverVad.claims.dynamic_update_configuration !== "not_verified"
      ) {
        throw new Error(
          "LC4 qualification sealed pre-retention runner-exception evidence failed integrity",
        );
      }
      sealedPreRetentionRunnerExceptions += 1;
    } else {
      assertProviderQualificationArtifactIntegrity(setupQualification);
      const setupByProvider = new Map(
        setupQualification.results.map((result) => [result.provider, result]),
      );
      if (setupByProvider.size !== setupQualification.results.length) {
        throw new Error(
          "LC4 qualification setup replay contains a duplicate provider result",
        );
      }
      const setupWireEvidence = LC4_QUALIFICATION_V3_PROVIDER_ORDER.flatMap(
        (expectedProvider) => {
          const result = setupByProvider.get(expectedProvider);
          if (!result)
            throw new Error(
              `LC4 qualification setup replay lacks ${expectedProvider}`,
            );
          const evidence = result.setupWireEvidence;
          if (
            terminal.body.status === "passed" &&
            (result.provider !== expectedProvider ||
              result.status !== "passed" ||
              evidence === undefined ||
              evidence.provider !== expectedProvider ||
              evidence.connectionEpoch !== 1 ||
              evidence.observations.length < 2 ||
              evidence.observations.some(
                (observation) => observation.connectionEpoch !== 1,
              ))
          )
            throw new Error(
              `LC4 qualification ${expectedProvider} setup replay is not one exact epoch-1 session: ${canonicalJson(
                {
                  actual_provider: result.provider,
                  status: result.status,
                  evidence_provider: evidence?.provider ?? null,
                  evidence_epoch: evidence?.connectionEpoch ?? null,
                  observation_count: evidence?.observations.length ?? 0,
                  observation_epochs:
                    evidence?.observations.map(
                      (observation) => observation.connectionEpoch,
                    ) ?? [],
                },
              )}`,
            );
          if (evidence !== undefined)
            return [
              {
                provider: evidence.provider,
                observations: evidence.observations,
              },
            ];
          if (result.setupFailureEvidence !== undefined) {
            return [
              {
                provider: result.setupFailureEvidence.provider,
                observations: result.setupFailureEvidence.observations,
              },
            ];
          }
          return [];
        },
      );
      {
        const setupReplayHeads = setupWireEvidence.flatMap((evidence) => {
          const head = evidence.observations.at(-1)?.observationSha256;
          return head === undefined ? [] : [head];
        });
        const replayHeads = [...setupReplayHeads, ...paidReplayHeads];
        const replayEventCount = setupWireEvidence.reduce(
          (total, evidence) => total + evidence.observations.length,
          paidReplayEventCount,
        );
        const replayChainHeadSha256 = replayHeads.some((head) => head === null)
          ? null
          : sha256Hex(
              `${REPLAY_AGGREGATE_DOMAIN}${canonicalJson(replayHeads)}`,
            );
        if (
          setupWireEvidence.length !==
            terminal.body.provider_sessions_opened -
              terminal.body.paid_sessions_opened ||
          paidReplayHeads.length !== terminal.body.paid_sessions_opened ||
          packageBindings.provider_session_count !==
            terminal.body.provider_sessions_opened ||
          packageBindings.replay_event_count !== replayEventCount ||
          packageBindings.replay_chain_head_sha256 !== replayChainHeadSha256
        ) {
          throw new Error(
            "LC4 qualification signed replay chain, session count, or event count differs from retained evidence",
          );
        }
      }
      const retainedXaiSetup = setupQualification.results.find(
        (result) => result.provider === "xai",
      );
      if (
        setupQualification.artifactSha256 !==
          terminal.body.setup_qualification_artifact_sha256 ||
        retainedXaiSetup === undefined ||
        setupQualification.planSha256 !== plan.body.plan_sha256 ||
        setupQualification.sourceCommit !== plan.body.source.source_commit ||
        setupQualification.configurationMatrixSha256 !==
          plan.body.setup_configuration_matrix_sha256 ||
        gateARisk.risk_sha256 !== serverVad.gate_a_risk_sha256 ||
        gateARisk.source_commit !== plan.body.source.source_commit ||
        gateARisk.plan_sha256 !== plan.body.plan_sha256 ||
        gateARisk.configuration_matrix_sha256 !==
          plan.body.setup_configuration_matrix_sha256 ||
        gateARisk.provider_profile_manifest_sha256 !==
          plan.body.provider_profile_manifest_sha256 ||
        gateARisk.production_session_payload_sha256 !==
          serverVad.production_session_payload_sha256 ||
        gateARisk.acknowledgement_sha256 !==
          retainedXaiSetup.acknowledgementSha256 ||
        (gateARisk.setup_wire_evidence?.connectionEpoch ??
          gateARisk.setup_failure_evidence?.connectionEpoch ??
          null) !== serverVad.gate_a_connection_epoch ||
        serverVad.exact_setting_verified !==
          (serverVad.gate_a_classification === "verified_by_provider_echo") ||
        serverVad.operational_vad_verified !==
          (serverVad.gate_b_status === "behaviorally_verified") ||
        serverVad.gate_a_classification !==
          (retainedXaiSetup.turnBoundaryVerification ===
          "verified_by_provider_echo"
            ? "verified_by_provider_echo"
            : retainedXaiSetup.code ===
                  "acknowledged_unverifiable_server_vad" ||
                retainedXaiSetup.code === "initial_snapshot_exact_only"
              ? "acknowledged_unverifiable_server_vad"
              : "failed")
      ) {
        throw new Error(
          "LC4 qualification retained xAI setup binding failed integrity",
        );
      }
      const expectedClaims = freeze({
        operational_gateway:
          gateBBinding === null
            ? ("not_verified" as const)
            : ("verified" as const),
        operational_server_vad:
          gateBBinding === null
            ? ("not_verified" as const)
            : ("verified" as const),
        exact_gateway_name_and_arguments:
          gateBBinding === null
            ? ("not_verified" as const)
            : ("verified" as const),
        matching_gateway_result:
          gateBBinding === null
            ? ("not_verified" as const)
            : ("verified" as const),
        sole_post_tool_continuation_terminal_usage:
          gateBBinding === null
            ? ("not_verified" as const)
            : ("verified" as const),
        full_gateway_schema:
          retainedXaiSetup.toolSchemaVerification ===
            "verified_by_provider_echo" &&
          retainedXaiSetup.configurationEvidence?.fields.tools.status ===
            "verified"
            ? ("verified_by_provider_echo" as const)
            : ("unverifiable" as const),
        gateway_description:
          retainedXaiSetup.toolSchemaVerification ===
            "verified_by_provider_echo" &&
          retainedXaiSetup.configurationEvidence?.fields.tools.status ===
            "verified"
            ? ("verified_by_provider_echo" as const)
            : ("unverifiable" as const),
        post_update_voice:
          retainedXaiSetup.configurationEvidence?.fields.voice.status ===
          "verified"
            ? ("verified_by_provider_echo" as const)
            : ("unverifiable" as const),
        input_transcription: "not_requested" as const,
        idle_timeout: "documented_default_not_independently_verified" as const,
        exact_vad_parameters:
          serverVad.gate_a_classification === "verified_by_provider_echo"
            ? ("verified_by_provider_echo" as const)
            : ("unverifiable" as const),
        created_to_updated_session_identity:
          gateARisk.created_to_updated_session_identity,
        dynamic_update_configuration:
          gateBBinding === null
            ? ("not_verified" as const)
            : gateBBinding.dynamic_update_provider_echo === "verified"
              ? ("verified_by_provider_echo" as const)
              : ("behaviorally_verified_not_provider_echoed" as const),
      });
      if (canonicalJson(serverVad.claims) !== canonicalJson(expectedClaims)) {
        throw new Error(
          "LC4 qualification xAI machine-readable claims exceed retained evidence",
        );
      }
      if (serverVad.benchmark_ready) {
        if (!xaiResult)
          throw new Error("LC4 qualification terminal lacks xAI result");
        const [xaiSummary, xaiWire, xaiUsage] = await Promise.all([
          readJson<RetainedRoundtripSummary>(
            resolve(directory, "xai-spoken-roundtrip.json"),
          ),
          readJsonLines<RealtimeWireObservation>(
            resolve(directory, "xai-spoken-roundtrip-wire.jsonl"),
          ),
          readJsonLines<RoundtripSanitizedUsage>(
            resolve(directory, "xai-spoken-roundtrip-usage.jsonl"),
          ),
        ]);
        assertRetainedXaiServerVadEvidence({
          summary: xaiSummary,
          wire: xaiWire,
          usage: xaiUsage,
          terminalResult: xaiResult,
          gateEvidenceSha256: serverVad.gate_b_evidence_sha256,
        });
        if (
          gateBBinding === null ||
          gateBBinding.binding_sha256 !== serverVad.gate_b_binding_sha256 ||
          gateBBinding.gate_a_risk_sha256 !== gateARisk.risk_sha256 ||
          gateBBinding.gate_b_execution_sha256 !== xaiSummary.evidence_sha256 ||
          gateBBinding.production_session_payload_sha256 !==
            serverVad.production_session_payload_sha256 ||
          gateBBinding.provider_profile_manifest_sha256 !==
            plan.body.provider_profile_manifest_sha256 ||
          gateBBinding.transport_parity_sha256 !==
            plan.body.targets.find((target) => target.provider === "xai")
              ?.xai_transport_parity_sha256 ||
          gateBBinding.per_turn_session_update_observation_sha256 !==
            xaiSummary.per_turn_session_update_observation_sha256 ||
          gateBBinding.per_turn_session_ack_observation_sha256 !==
            xaiSummary.per_turn_session_ack_observation_sha256 ||
          gateBBinding.exact_gateway_call_evidence_sha256 !==
            xaiSummary.provider_tool_call_evidence_sha256 ||
          gateBBinding.matching_gateway_result_evidence_sha256 !==
            xaiSummary.tool_result_evidence_sha256 ||
          gateBBinding.public_execution_sha256 !==
            xaiSummary.public_execution_sha256 ||
          gateBBinding.replay_sha256 !== xaiSummary.replay_sha256
        ) {
          throw new Error(
            "LC4 qualification xAI Gate B binding differs from retained roundtrip",
          );
        }
        const { binding_sha256, ...gateBBody } = gateBBinding;
        if (
          binding_sha256 !==
          sha256Hex(
            `${XAI_SERVER_VAD_GATE_B_BINDING_DOMAIN}${canonicalJson(gateBBody)}`,
          )
        ) {
          throw new Error(
            "LC4 qualification xAI Gate B binding hash failed integrity",
          );
        }
        const matchingGateBObservations = xaiWire.filter(
          (observation) =>
            observation.observationSha256 ===
            gateBBinding.per_turn_session_update_observation_sha256,
        );
        const firstGateBObservation = matchingGateBObservations[0];
        const retainedDynamicControl =
          firstGateBObservation?.projection.dynamicControl !== null &&
          typeof firstGateBObservation?.projection.dynamicControl ===
            "object" &&
          !Array.isArray(firstGateBObservation.projection.dynamicControl)
            ? (firstGateBObservation.projection.dynamicControl as Record<
                string,
                unknown
              >)
            : null;
        if (
          matchingGateBObservations.length !== 1 ||
          firstGateBObservation?.direction !== "outbound" ||
          firstGateBObservation.wireType !== "session.update" ||
          firstGateBObservation.connectionEpoch !==
            serverVad.gate_b_connection_epoch ||
          firstGateBObservation?.observationSha256 !==
            gateBBinding.per_turn_session_update_observation_sha256 ||
          retainedDynamicControl?.sha256 !== LC4_S2S_COMPACT_CONTROL_SHA256 ||
          retainedDynamicControl.byteLength !==
            Buffer.byteLength(LC4_S2S_COMPACT_CONTROL, "utf8") ||
          retainedDynamicControl.authority !==
            "advisory_only_gateway_and_speech_gate_enforced" ||
          retainedDynamicControl.toolFrontierSha256 !==
            gateBBinding.tool_frontier_sha256 ||
          retainedDynamicControl.transportParitySha256 !==
            gateBBinding.transport_parity_sha256 ||
          retainedDynamicControl.delivery !== "session.update_before_audio"
        ) {
          throw new Error(
            "LC4 qualification xAI Gate B epoch is not terminal-bound",
          );
        }
      }
    }
    const budgetEvidence = await readJson<Lc4QualificationBudgetEvidence>(
      resolve(directory, "budget-settlement.json"),
    );
    assertLc4QualificationBudgetEvidence(budgetEvidence);
    if (budgetEvidence.evidence_sha256 !== terminal.body.budget_evidence_sha256
      || budgetEvidence.final_head_sha256 !== terminal.body.budget_final_head_sha256
      || budgetEvidence.terminal_outcome !== (terminal.body.status === "passed" ? "completed" : "failed")) {
      throw new Error("LC4 qualification v3 terminal budget binding failed integrity");
    }
    completeIds.add(attemptId);
    verified.push(terminal);
  }
  const partialIds = new Set(partialNames.map((name) => name.slice(0, -".partial".length)));
  for (const attemptId of partialIds) {
    if (!invocations.has(attemptId) || refusals.has(attemptId) || completeIds.has(attemptId)) {
      throw new Error("LC4 qualification v3 partial attempt has an invalid invocation state");
    }
  }
  const strandedInvocationIds = [...invocations.keys()].filter((attemptId) =>
    !refusals.has(attemptId) && !completeIds.has(attemptId) && !partialIds.has(attemptId));
  return freeze({
    schema_version: 1,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    plan_artifact_sha256: plan.artifact_sha256,
    source_commit: plan.body.source.source_commit,
    invoked_attempts: invocations.size,
    refused_attempts: refusals.size,
    stranded_invocations: strandedInvocationIds.length,
    complete_attempts: verified.length,
    fully_replay_verified_complete_attempts: verified.length - sealedPreRetentionRunnerExceptions,
    sealed_pre_retention_runner_exceptions: sealedPreRetentionRunnerExceptions,
    partial_attempts: partialIds.size,
    gate_c_qualification_gate: false,
    maximum_total_usd: 3,
    maximum_provider_sessions: plan.body.maximum_provider_sessions,
    maximum_paid_sessions: plan.body.maximum_paid_sessions,
    maximum_generation_phases: plan.body.maximum_generation_phases,
    paid_retry_allowed: false,
    latest: verified.at(-1)?.body ?? null,
  });
}

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || result[key] !== undefined) throw new Error("LC4 qualification v3 requires unique --flag value pairs");
    result[key] = value;
  }
  return freeze(result);
}

function exactFlags(actual: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(actual).sort()) !== canonicalJson([...expected].sort())) throw new Error(`LC4 qualification v3 requires exactly ${[...expected].sort().join(", ")}`);
}

type Lc4QualificationV3CliIo = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
}>;

export async function runLc4QualificationV3Cli(
  args: readonly string[],
  io: Lc4QualificationV3CliIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
): Promise<number> {
  try {
    const command = args[0];
    const parsed = flags(args.slice(1));
    if (command === "status") {
      exactFlags(parsed, []);
      io.stdout(`${canonicalJson({
        runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
        execution_authorized_by_source: false,
        execution_requires: "authority_signed_plan_and_authorization_plus_pinned_terminal_key",
        gate_a: "setup_acceptance",
        gate_b: "spoken_tool_roundtrip",
        gate_c: "diagnostic_only_not_qualification",
        maximum_total_usd: 3,
        maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
        maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
        maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
        maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
        paid_retry_allowed: false,
      })}\n`);
      return 0;
    }
    if (command === "prepare") {
      exactFlags(parsed, [
        "--root",
        "--repository-root",
        "--authority-private-key",
        "--trust-root-fingerprint",
        "--provider-env-file",
        "--repo-env-file",
      ]);
      const artifact = await prepareLc4QualificationV3({
        root: parsed["--root"],
        repositoryRoot: parsed["--repository-root"],
        credentialFiles: {
          providerEnvFile: parsed["--provider-env-file"],
          repoEnvFile: parsed["--repo-env-file"],
        },
        authorityPrivateKeyPem: await loadLc4QualificationV3PrivateKeyFile(
          parsed["--authority-private-key"],
          "LC4 qualification v3 authority private key",
        ),
        trustRootFingerprint: parsed["--trust-root-fingerprint"],
      });
      io.stdout(`${canonicalJson({ action: "lc4-qualification-v3-prepared", plan_artifact_sha256: artifact.artifact_sha256, provider_calls_made: 0 })}\n`);
      return 0;
    }
    if (command === "report") {
      exactFlags(parsed, ["--root", "--trust-root-fingerprint"]);
      io.stdout(`${canonicalJson(await reportLc4QualificationV3({
        root: absoluteNormalized(parsed["--root"], "LC4 qualification v3 evidence root"),
        trustRootFingerprint: parsed["--trust-root-fingerprint"],
      }))}\n`);
      return 0;
    }
    if (command === "run") {
      exactFlags(parsed, [
        "--root",
        "--repository-root",
        "--authorization",
        "--trust-root-fingerprint",
        "--terminal-private-key",
        "--provider-env-file",
        "--repo-env-file",
      ]);
      const terminal = await runLc4QualificationV3({
        root: absoluteNormalized(parsed["--root"], "LC4 qualification v3 evidence root"),
        repositoryRoot: absoluteNormalized(parsed["--repository-root"], "LC4 qualification v3 repository root"),
        credentialFiles: {
          providerEnvFile: parsed["--provider-env-file"],
          repoEnvFile: parsed["--repo-env-file"],
        },
        authorization: await loadLc4QualificationV3AuthorizationFile(parsed["--authorization"]),
        trustRootFingerprint: parsed["--trust-root-fingerprint"],
        terminalPrivateKeyPem: await loadLc4QualificationV3PrivateKeyFile(
          parsed["--terminal-private-key"],
          "LC4 qualification v3 terminal private key",
        ),
      });
      io.stdout(`${canonicalJson({ action: "lc4-qualification-v3-retained", status: terminal.body.status, terminal_artifact_sha256: terminal.artifact_sha256 })}\n`);
      return terminal.body.status === "passed" ? 0 : 1;
    }
    throw new Error("usage: lc4-qualification-v3 <status|prepare|run|report>");
  } catch (error) {
    const boundary = error instanceof Lc4QualificationV3BoundaryError
      ? error
      : boundaryError("cli", "cli_input_invalid");
    io.stderr(`${canonicalJson({
      error: "lc4_qualification_v3_refused",
      stage: boundary.stage,
      code: boundary.code,
      secrets_retained: false,
    })}\n`);
    return 1;
  }
}
