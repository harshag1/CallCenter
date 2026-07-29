import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { open } from "node:fs/promises";

import { canonicalJson, sha256Hex } from "./artifacts";
import {
  LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
  LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY,
} from "./lc4-production-provider-contract";
import {
  assertLc4XaiManualTurnCausality,
  type Lc4SanitizedWireObservation,
  type Lc4XaiManualTurnCausalityEvidence,
} from "./lc4-xai-manual-turn-causality";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "./lc4-provider-profiles";

export const LC4_XAI_FINITE_MANUAL_GATE_D_VERSION =
  "HACC-LC4-PROVIDER-XAI/FINITE-MANUAL-GATE-D-v4" as const;
export const LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD = 1_000_000 as const;
export const LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_PROVIDER_SESSIONS = 1 as const;
export const LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_PCM_BYTES = 480_000 as const;
export const LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_EXECUTION_EVIDENCE_BYTES =
  512 * 1024;
export const LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_WIRE_OBSERVATIONS = 512;

const PLAN_SIGNING_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-plan/v2\n";
const PLAN_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-plan-artifact/v2\n";
const AUTHORIZATION_SIGNING_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-authorization/v2\n";
const AUTHORIZATION_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-authorization-artifact/v2\n";
const INVOCATION_CLAIM_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-invocation-claim/v2\n";
const INVOCATION_MARKER_CLAIM_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-invocation-marker-claim/v2\n";
const ADAPTER_CONSTRUCTION_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-adapter-construction/v2\n";
const EXECUTION_REPLAY_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-execution-replay/v2\n";
const TERMINAL_SIGNING_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-terminal/v2\n";
const TERMINAL_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-terminal-artifact/v2\n";
const PACKAGE_MANIFEST_SIGNING_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-package-manifest/v2\n";
const PACKAGE_MANIFEST_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-package-manifest-artifact/v2\n";
const RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-receipt/v2\n";
const PRODUCTION_BINDING_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-production-binding/v1\n";
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SAFE_WIRE_TYPE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export const LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER = Object.freeze([
  "caller_pcm_delivery_started",
  "caller_pcm_delivery_completed",
  "caller_pcm_committed",
  "caller_pcm_commit_acknowledged",
  "response_generation_requested",
  "response_generation_started",
  "initial_assistant_pcm_observed",
  "capability_gateway_tool_call_observed",
  "capability_gateway_tool_result_submitted",
  "post_tool_continuation_requested",
  "post_tool_continuation_started",
  "post_tool_assistant_pcm_observed",
  "post_tool_response_completed",
] as const);

export const LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING = Object.freeze({
  schema_version: 1 as const,
  adapter_module: "lc4-production-provider-adapter" as const,
  adapter_version: LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
  client_factory: "createProductionRealtimeClient" as const,
  provider: "xai" as const,
  model: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.model,
  voice: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.voice,
  input_sample_rate_hz: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.input_sample_rate_hz,
  transport_purpose: "finite_prerecorded_efficacy" as const,
  transport_mode: "manual_commit" as const,
  transport_profile_sha256:
    LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
  turn_boundary: "explicit_commit_ack_then_response_create" as const,
  provider_speech_activity_events:
    "telemetry_only_never_commit_or_response_authority" as const,
  assistant_audio_delta_wire_types:
    LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE
      .assistant_audio_delta_wire_types,
  tool_gateway: "capability_gateway" as const,
});

export const LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256 = sha256Hex(
  `${PRODUCTION_BINDING_DOMAIN}${canonicalJson(
    LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING,
  )}`,
);

type SignedArtifact<Body> = Readonly<{
  body: Body;
  public_key_spki_base64: string;
  public_key_fingerprint_sha256: string;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  artifact_sha256: string;
}>;

export type Lc4XaiFiniteManualGateDSigner = Readonly<{
  private_key: KeyObject;
  public_key_spki_der: Buffer;
  public_key_fingerprint_sha256: string;
}>;

export type Lc4XaiFiniteManualGateDPlanBody = Readonly<{
  schema_version: 2;
  gate_version: typeof LC4_XAI_FINITE_MANUAL_GATE_D_VERSION;
  gate_id: string;
  prepared_at: string;
  source_commit: string;
  source_tree_sha256: string;
  provider_profile_manifest_sha256: string;
  provider: "xai";
  model: string;
  voice: string;
  transport_purpose: "finite_prerecorded_efficacy";
  transport_mode: "manual_commit";
  transport_profile_sha256: string;
  production_adapter_binding_sha256: string;
  harmless_clip: Readonly<{
    pcm_sha256: string;
    pcm_byte_length: number;
    sample_rate_hz: 24_000;
    channels: 1;
    encoding: "pcm16";
    content_class: "harmless_pcm_transport_probe_no_audibility_claim";
    retained_raw_audio: false;
    sample_count: number;
  }>;
  maximum_total_micro_usd: typeof LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD;
  maximum_provider_sessions: 1;
  maximum_generation_phases: 2;
  maximum_tool_roundtrips: 1;
  retry_allowed: false;
  reconnect_allowed: false;
  fallback_allowed: false;
  efficacy_scoring_allowed: false;
  provider_calls_authorized: false;
  plan_sha256: string;
}>;

export type Lc4XaiFiniteManualGateDPlanArtifact =
  SignedArtifact<Lc4XaiFiniteManualGateDPlanBody>;

export type Lc4XaiFiniteManualGateDAuthorizationBody = Readonly<{
  schema_version: 2;
  gate_version: typeof LC4_XAI_FINITE_MANUAL_GATE_D_VERSION;
  authorization_id: string;
  authorization_nonce_sha256: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  provider_profile_manifest_sha256: string;
  transport_profile_sha256: string;
  production_adapter_binding_sha256: string;
  credential_identity_sha256: string;
  terminal_public_key_spki_base64: string;
  terminal_public_key_fingerprint_sha256: string;
  maximum_total_micro_usd: typeof LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD;
  maximum_provider_sessions: 1;
  maximum_generation_phases: 2;
  maximum_tool_roundtrips: 1;
  one_shot: true;
  retry_allowed: false;
  reconnect_allowed: false;
  fallback_allowed: false;
  efficacy_scoring_allowed: false;
  not_before: string;
  expires_at: string;
}>;

export type Lc4XaiFiniteManualGateDAuthorizationArtifact =
  SignedArtifact<Lc4XaiFiniteManualGateDAuthorizationBody>;

export type Lc4XaiFiniteManualGateDExecutionEvidence = Readonly<{
  schema_version: 2;
  provider: "xai";
  model: string;
  voice: string;
  transport_purpose: "finite_prerecorded_efficacy";
  transport_mode: "manual_commit";
  transport_profile_sha256: string;
  production_adapter_binding_sha256: string;
  caller_pcm_sha256: string;
  caller_pcm_byte_length: number;
  caller_pcm_appended_sha256: string;
  caller_pcm_appended_byte_length: number;
  provider_sessions_opened: 1;
  generation_phases: 2;
  capability_gateway_tool_roundtrips: 1;
  retries: 0;
  reconnects: 0;
  fallbacks: 0;
  operation_order: typeof LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER;
  manual_turn_causality: Lc4XaiManualTurnCausalityEvidence;
  wire_observations: readonly Lc4SanitizedWireObservation[];
  initial_assistant_pcm_sha256: string;
  initial_assistant_pcm_byte_length: number;
  initial_assistant_pcm_observation_sha256: string;
  capability_gateway_tool_call_sha256: string;
  capability_gateway_tool_call_observation_sha256: string;
  capability_gateway_tool_result_sha256: string;
  capability_gateway_tool_result_observation_sha256: string;
  post_tool_continuation_sha256: string;
  post_tool_continuation_observation_sha256: string;
  post_tool_response_start_observation_sha256: string;
  post_tool_assistant_pcm_sha256: string;
  post_tool_assistant_pcm_byte_length: number;
  post_tool_assistant_pcm_observation_sha256: string;
  capability_gateway_call_id_sha256: string;
  post_tool_continuation_origin_response_id_sha256: string;
  post_tool_response_id_sha256: string;
  terminal_observation_sha256: string;
  replay_sha256: string;
}>;

export type Lc4XaiFiniteManualGateDInvocationClaim = Readonly<{
  schema_version: 2;
  gate_version: typeof LC4_XAI_FINITE_MANUAL_GATE_D_VERSION;
  plan_artifact_sha256: string;
  authorization_artifact_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  claimed_at: string;
  claim_sequence: 1;
  state: "claimed_before_provider_adapter_construction";
  raw_audio_retained: false;
  credentials_retained: false;
  marker_claim_sha256: string;
  marker_file_sha256: string;
  marker_device: number;
  marker_inode: number;
  marker_nlink: 1;
  marker_permission_mode: 0o400;
  claim_sha256: string;
}>;

export type Lc4XaiFiniteManualGateDAdapterConstruction = Readonly<{
  schema_version: 2;
  gate_version: typeof LC4_XAI_FINITE_MANUAL_GATE_D_VERSION;
  invocation_claim_sha256: string;
  construction_sequence: 2;
  adapter_kind: "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1";
  production_adapter_binding_sha256: string;
  construction_sha256: string;
}>;

export type Lc4XaiFiniteManualGateDTerminalBody = Readonly<{
  schema_version: 2;
  gate_version: typeof LC4_XAI_FINITE_MANUAL_GATE_D_VERSION;
  status: "passed";
  completed_at: string;
  plan_artifact_sha256: string;
  authorization_artifact_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  provider_profile_manifest_sha256: string;
  transport_profile_sha256: string;
  production_adapter_binding_sha256: string;
  invocation_claim_sha256: string;
  invocation_marker_file_sha256: string;
  adapter_construction_sha256: string;
  execution_replay_sha256: string;
  provider_sessions_opened: 1;
  generation_phases: 2;
  capability_gateway_tool_roundtrips: 1;
  retries: 0;
  reconnects: 0;
  fallbacks: 0;
  budget: Readonly<{
    reserved_micro_usd: typeof LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD;
    conservatively_settled_micro_usd: typeof LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD;
    active_micro_usd: 0;
  }>;
  raw_audio_retained: false;
  credentials_retained: false;
  efficacy_scored: false;
  claim_boundary: "transport_qualification_only_not_efficacy_evidence";
}>;

export type Lc4XaiFiniteManualGateDTerminalArtifact =
  SignedArtifact<Lc4XaiFiniteManualGateDTerminalBody>;

export type Lc4XaiFiniteManualGateDPackageManifestBody = Readonly<{
  schema_version: 2;
  gate_version: typeof LC4_XAI_FINITE_MANUAL_GATE_D_VERSION;
  status: "passed";
  plan_artifact_sha256: string;
  authorization_artifact_sha256: string;
  invocation_claim_sha256: string;
  invocation_marker_file_sha256: string;
  adapter_construction_sha256: string;
  execution_replay_sha256: string;
  terminal_artifact_sha256: string;
  plan_authority_trust_root_sha256: string;
  terminal_authority_trust_root_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  provider_profile_manifest_sha256: string;
  transport_profile_sha256: string;
  production_adapter_binding_sha256: string;
  lifecycle: Readonly<{
    invocation_claim_sequence: 1;
    adapter_construction_sequence: 2;
    provider_execution_sequence: 3;
    terminal_sequence: 4;
    package_manifest_sequence: 5;
  }>;
  budget: Lc4XaiFiniteManualGateDTerminalBody["budget"];
  raw_audio_retained: false;
  credentials_retained: false;
  efficacy_scored: false;
  claim_boundary: "transport_qualification_only_not_efficacy_evidence";
}>;

export type Lc4XaiFiniteManualGateDPackageManifestArtifact =
  SignedArtifact<Lc4XaiFiniteManualGateDPackageManifestBody>;

export type Lc4XaiFiniteManualGateDReceipt = Readonly<{
  schema_version: 2;
  gate_version: typeof LC4_XAI_FINITE_MANUAL_GATE_D_VERSION;
  status: "passed";
  source_commit: string;
  source_tree_sha256: string;
  provider_profile_manifest_sha256: string;
  transport_purpose: "finite_prerecorded_efficacy";
  transport_mode: "manual_commit";
  transport_profile_sha256: string;
  production_adapter_binding_sha256: string;
  plan_authority_trust_root_sha256: string;
  plan: Lc4XaiFiniteManualGateDPlanArtifact;
  authorization: Lc4XaiFiniteManualGateDAuthorizationArtifact;
  invocation_claim: Lc4XaiFiniteManualGateDInvocationClaim;
  adapter_construction: Lc4XaiFiniteManualGateDAdapterConstruction;
  execution_evidence: Lc4XaiFiniteManualGateDExecutionEvidence;
  terminal: Lc4XaiFiniteManualGateDTerminalArtifact;
  package_manifest: Lc4XaiFiniteManualGateDPackageManifestArtifact;
  execution_replay_sha256: string;
  provider_sessions_opened: 1;
  retries: 0;
  reconnects: 0;
  fallbacks: 0;
  efficacy_scored: false;
  claim_boundary: "transport_qualification_only_not_efficacy_evidence";
  receipt_sha256: string;
}>;

/**
 * Narrow paid-capable seam implemented by the production provider adapter.
 * Gate D never accepts a naked callback: the adapter must identify and bind
 * the exact frozen production path before the one-shot claim is consumed.
 */
export type Lc4XaiFiniteManualGateDProductionAdapter = Readonly<{
  [LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY]: true;
  kind: "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1";
  production_adapter_binding_sha256:
    typeof LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256;
  execute(input: Readonly<{
    caller_pcm: Uint8Array;
    plan: Lc4XaiFiniteManualGateDPlanArtifact;
    authorization: Lc4XaiFiniteManualGateDAuthorizationArtifact;
  }>): Promise<Lc4XaiFiniteManualGateDExecutionEvidence>;
}>;

export type Lc4XaiFiniteManualGateDExecution = Readonly<{
  plan: Lc4XaiFiniteManualGateDPlanArtifact;
  authorization: Lc4XaiFiniteManualGateDAuthorizationArtifact;
  terminal_signer: Lc4XaiFiniteManualGateDSigner;
  credential_identity_sha256: string;
  caller_pcm: Uint8Array;
  inspected_source: Readonly<{
    source_commit: string;
    source_tree_sha256: string;
    worktree_clean: true;
  }>;
  now: Date;
  completion_clock(): Date;
  expected_plan_trust_root_sha256: string;
  invocation_marker_path: string;
  construct_production_adapter():
    | Lc4XaiFiniteManualGateDProductionAdapter
    | Promise<Lc4XaiFiniteManualGateDProductionAdapter>;
}>;

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function requireIso(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

function requireExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

const SIGNED_ARTIFACT_KEYS = Object.freeze([
  "body",
  "public_key_spki_base64",
  "public_key_fingerprint_sha256",
  "signature_algorithm",
  "signature_base64",
  "artifact_sha256",
] as const);

const INVOCATION_CLAIM_BODY_KEYS = Object.freeze([
  "schema_version",
  "gate_version",
  "plan_artifact_sha256",
  "authorization_artifact_sha256",
  "source_commit",
  "source_tree_sha256",
  "claimed_at",
  "claim_sequence",
  "state",
  "raw_audio_retained",
  "credentials_retained",
] as const);

const INVOCATION_CLAIM_KEYS = Object.freeze([
  ...INVOCATION_CLAIM_BODY_KEYS,
  "marker_claim_sha256",
  "marker_file_sha256",
  "marker_device",
  "marker_inode",
  "marker_nlink",
  "marker_permission_mode",
  "claim_sha256",
] as const);

const ADAPTER_CONSTRUCTION_BODY_KEYS = Object.freeze([
  "schema_version",
  "gate_version",
  "invocation_claim_sha256",
  "construction_sequence",
  "adapter_kind",
  "production_adapter_binding_sha256",
] as const);

const ADAPTER_CONSTRUCTION_KEYS = Object.freeze([
  ...ADAPTER_CONSTRUCTION_BODY_KEYS,
  "construction_sha256",
] as const);

const EXECUTION_EVIDENCE_KEYS = Object.freeze([
  "schema_version",
  "provider",
  "model",
  "voice",
  "transport_purpose",
  "transport_mode",
  "transport_profile_sha256",
  "production_adapter_binding_sha256",
  "caller_pcm_sha256",
  "caller_pcm_byte_length",
  "caller_pcm_appended_sha256",
  "caller_pcm_appended_byte_length",
  "provider_sessions_opened",
  "generation_phases",
  "capability_gateway_tool_roundtrips",
  "retries",
  "reconnects",
  "fallbacks",
  "operation_order",
  "manual_turn_causality",
  "wire_observations",
  "initial_assistant_pcm_sha256",
  "initial_assistant_pcm_byte_length",
  "initial_assistant_pcm_observation_sha256",
  "capability_gateway_tool_call_sha256",
  "capability_gateway_tool_call_observation_sha256",
  "capability_gateway_tool_result_sha256",
  "capability_gateway_tool_result_observation_sha256",
  "post_tool_continuation_sha256",
  "post_tool_continuation_observation_sha256",
  "post_tool_response_start_observation_sha256",
  "post_tool_assistant_pcm_sha256",
  "post_tool_assistant_pcm_byte_length",
  "post_tool_assistant_pcm_observation_sha256",
  "capability_gateway_call_id_sha256",
  "post_tool_continuation_origin_response_id_sha256",
  "post_tool_response_id_sha256",
  "terminal_observation_sha256",
  "replay_sha256",
] as const);

const SANITIZED_WIRE_OBSERVATION_KEYS = Object.freeze([
  "provider",
  "direction",
  "connection_epoch",
  "sequence",
  "wire_type",
  "payload_sha256",
  "payload_bytes",
  "projection_sha256",
  "observation_sha256",
  "previous_observation_sha256",
  "identity_hashes",
] as const);

const WIRE_IDENTITY_KEYS = new Set([
  "eventIdSha256",
  "sessionIdSha256",
  "responseIdSha256",
  "itemIdSha256",
  "callIdSha256",
]);

const PLAN_BODY_KEYS = Object.freeze([
  "schema_version",
  "gate_version",
  "gate_id",
  "prepared_at",
  "source_commit",
  "source_tree_sha256",
  "provider_profile_manifest_sha256",
  "provider",
  "model",
  "voice",
  "transport_purpose",
  "transport_mode",
  "transport_profile_sha256",
  "production_adapter_binding_sha256",
  "harmless_clip",
  "maximum_total_micro_usd",
  "maximum_provider_sessions",
  "maximum_generation_phases",
  "maximum_tool_roundtrips",
  "retry_allowed",
  "reconnect_allowed",
  "fallback_allowed",
  "efficacy_scoring_allowed",
  "provider_calls_authorized",
  "plan_sha256",
] as const);

const AUTHORIZATION_BODY_KEYS = Object.freeze([
  "schema_version",
  "gate_version",
  "authorization_id",
  "authorization_nonce_sha256",
  "plan_artifact_sha256",
  "plan_sha256",
  "source_commit",
  "source_tree_sha256",
  "provider_profile_manifest_sha256",
  "transport_profile_sha256",
  "production_adapter_binding_sha256",
  "credential_identity_sha256",
  "terminal_public_key_spki_base64",
  "terminal_public_key_fingerprint_sha256",
  "maximum_total_micro_usd",
  "maximum_provider_sessions",
  "maximum_generation_phases",
  "maximum_tool_roundtrips",
  "one_shot",
  "retry_allowed",
  "reconnect_allowed",
  "fallback_allowed",
  "efficacy_scoring_allowed",
  "not_before",
  "expires_at",
] as const);

const TERMINAL_BODY_KEYS = Object.freeze([
  "schema_version",
  "gate_version",
  "status",
  "completed_at",
  "plan_artifact_sha256",
  "authorization_artifact_sha256",
  "source_commit",
  "source_tree_sha256",
  "provider_profile_manifest_sha256",
  "transport_profile_sha256",
  "production_adapter_binding_sha256",
  "invocation_claim_sha256",
  "invocation_marker_file_sha256",
  "adapter_construction_sha256",
  "execution_replay_sha256",
  "provider_sessions_opened",
  "generation_phases",
  "capability_gateway_tool_roundtrips",
  "retries",
  "reconnects",
  "fallbacks",
  "budget",
  "raw_audio_retained",
  "credentials_retained",
  "efficacy_scored",
  "claim_boundary",
] as const);

const PACKAGE_MANIFEST_BODY_KEYS = Object.freeze([
  "schema_version",
  "gate_version",
  "status",
  "plan_artifact_sha256",
  "authorization_artifact_sha256",
  "invocation_claim_sha256",
  "invocation_marker_file_sha256",
  "adapter_construction_sha256",
  "execution_replay_sha256",
  "terminal_artifact_sha256",
  "plan_authority_trust_root_sha256",
  "terminal_authority_trust_root_sha256",
  "source_commit",
  "source_tree_sha256",
  "provider_profile_manifest_sha256",
  "transport_profile_sha256",
  "production_adapter_binding_sha256",
  "lifecycle",
  "budget",
  "raw_audio_retained",
  "credentials_retained",
  "efficacy_scored",
  "claim_boundary",
] as const);

const RECEIPT_KEYS = Object.freeze([
  "schema_version",
  "gate_version",
  "status",
  "source_commit",
  "source_tree_sha256",
  "provider_profile_manifest_sha256",
  "transport_purpose",
  "transport_mode",
  "transport_profile_sha256",
  "production_adapter_binding_sha256",
  "plan_authority_trust_root_sha256",
  "plan",
  "authorization",
  "invocation_claim",
  "adapter_construction",
  "execution_evidence",
  "terminal",
  "package_manifest",
  "execution_replay_sha256",
  "provider_sessions_opened",
  "retries",
  "reconnects",
  "fallbacks",
  "efficacy_scored",
  "claim_boundary",
  "receipt_sha256",
] as const);

function signingBytes(domain: string, body: unknown): Uint8Array {
  return Buffer.from(`${domain}${canonicalJson(body)}`, "utf8");
}

function artifactHash<Body>(
  domain: string,
  artifact: Omit<SignedArtifact<Body>, "artifact_sha256">,
): string {
  return sha256Hex(`${domain}${canonicalJson(artifact)}`);
}

function signArtifact<Body>(
  body: Body,
  signer: Lc4XaiFiniteManualGateDSigner,
  signingDomain: string,
  artifactDomain: string,
): SignedArtifact<Body> {
  if (signer.private_key.asymmetricKeyType !== "ed25519") {
    throw new Error("Gate D signer must be Ed25519");
  }
  if (sha256Hex(signer.public_key_spki_der)
    !== signer.public_key_fingerprint_sha256) {
    throw new Error("Gate D signer fingerprint mismatch");
  }
  const withoutHash = Object.freeze({
    body,
    public_key_spki_base64: signer.public_key_spki_der.toString("base64"),
    public_key_fingerprint_sha256: signer.public_key_fingerprint_sha256,
    signature_algorithm: "Ed25519" as const,
    signature_base64: sign(
      null,
      signingBytes(signingDomain, body),
      signer.private_key,
    ).toString("base64"),
  });
  return Object.freeze({
    ...withoutHash,
    artifact_sha256: artifactHash(artifactDomain, withoutHash),
  });
}

function verifyArtifact<Body>(input: Readonly<{
  artifact: SignedArtifact<Body>;
  expected_fingerprint: string;
  signing_domain: string;
  artifact_domain: string;
  label: string;
}>): void {
  requireExactKeys(input.artifact, SIGNED_ARTIFACT_KEYS, input.label);
  requireHash(input.expected_fingerprint, `${input.label} trust root`);
  const { artifact_sha256: claimed, ...withoutHash } = input.artifact;
  if (claimed !== artifactHash(input.artifact_domain, withoutHash)) {
    throw new Error(`${input.label} artifact hash mismatch`);
  }
  const publicKeyDer = Buffer.from(input.artifact.public_key_spki_base64, "base64");
  if (sha256Hex(publicKeyDer) !== input.artifact.public_key_fingerprint_sha256
    || input.artifact.public_key_fingerprint_sha256 !== input.expected_fingerprint) {
    throw new Error(`${input.label} trust root mismatch`);
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  } catch {
    throw new Error(`${input.label} public key is invalid`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519"
    || input.artifact.signature_algorithm !== "Ed25519"
    || !verify(
      null,
      signingBytes(input.signing_domain, input.artifact.body),
      publicKey,
      Buffer.from(input.artifact.signature_base64, "base64"),
    )) {
    throw new Error(`${input.label} signature is invalid`);
  }
}

export function createLc4XaiFiniteManualGateDSigner(
  privateKeyPem: string,
): Lc4XaiFiniteManualGateDSigner {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ format: "der", type: "spki" });
  return Object.freeze({
    private_key: privateKey,
    public_key_spki_der: Buffer.from(der),
    public_key_fingerprint_sha256: sha256Hex(der),
  });
}

export function createLc4XaiFiniteManualGateDPlan(input: Readonly<{
  gate_id: string;
  prepared_at: string;
  source_commit: string;
  source_tree_sha256: string;
  harmless_clip_pcm: Uint8Array;
  signer: Lc4XaiFiniteManualGateDSigner;
}>): Lc4XaiFiniteManualGateDPlanArtifact {
  if (!SAFE_ID.test(input.gate_id)) throw new Error("Gate D ID is invalid");
  requireIso(input.prepared_at, "Gate D prepare time");
  if (!COMMIT.test(input.source_commit)) throw new Error("Gate D source commit is invalid");
  requireHash(input.source_tree_sha256, "Gate D source tree");
  if (input.harmless_clip_pcm.byteLength < 2
    || input.harmless_clip_pcm.byteLength % 2 !== 0
    || input.harmless_clip_pcm.byteLength
      > LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_PCM_BYTES) {
    throw new Error("Gate D harmless clip must be non-empty PCM16 no longer than ten seconds");
  }
  const base = {
    schema_version: 2 as const,
    gate_version: LC4_XAI_FINITE_MANUAL_GATE_D_VERSION,
    gate_id: input.gate_id,
    prepared_at: input.prepared_at,
    source_commit: input.source_commit,
    source_tree_sha256: input.source_tree_sha256,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    provider: "xai" as const,
    model: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.model,
    voice: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.voice,
    transport_purpose: "finite_prerecorded_efficacy" as const,
    transport_mode: "manual_commit" as const,
    transport_profile_sha256:
      LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
    production_adapter_binding_sha256:
      LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    harmless_clip: Object.freeze({
      pcm_sha256: sha256Hex(input.harmless_clip_pcm),
      pcm_byte_length: input.harmless_clip_pcm.byteLength,
      sample_rate_hz: 24_000 as const,
      channels: 1 as const,
      encoding: "pcm16" as const,
      content_class:
        "harmless_pcm_transport_probe_no_audibility_claim" as const,
      retained_raw_audio: false as const,
      sample_count: input.harmless_clip_pcm.byteLength / 2,
    }),
    maximum_total_micro_usd: LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD,
    maximum_provider_sessions: 1 as const,
    maximum_generation_phases: 2 as const,
    maximum_tool_roundtrips: 1 as const,
    retry_allowed: false as const,
    reconnect_allowed: false as const,
    fallback_allowed: false as const,
    efficacy_scoring_allowed: false as const,
    provider_calls_authorized: false as const,
  };
  const body = Object.freeze({
    ...base,
    plan_sha256: sha256Hex(`${PLAN_SIGNING_DOMAIN}${canonicalJson(base)}`),
  });
  return signArtifact(body, input.signer, PLAN_SIGNING_DOMAIN, PLAN_ARTIFACT_DOMAIN);
}

export function assertLc4XaiFiniteManualGateDPlan(
  artifact: Lc4XaiFiniteManualGateDPlanArtifact,
  expectedTrustRootSha256: string,
): void {
  verifyArtifact({
    artifact,
    expected_fingerprint: expectedTrustRootSha256,
    signing_domain: PLAN_SIGNING_DOMAIN,
    artifact_domain: PLAN_ARTIFACT_DOMAIN,
    label: "Gate D plan",
  });
  requireExactKeys(artifact.body, PLAN_BODY_KEYS, "Gate D plan body");
  requireExactKeys(artifact.body.harmless_clip, [
    "pcm_sha256",
    "pcm_byte_length",
    "sample_rate_hz",
    "channels",
    "encoding",
    "content_class",
    "retained_raw_audio",
    "sample_count",
  ], "Gate D harmless clip");
  const { plan_sha256: claimed, ...base } = artifact.body;
  if (claimed !== sha256Hex(`${PLAN_SIGNING_DOMAIN}${canonicalJson(base)}`)) {
    throw new Error("Gate D plan body hash mismatch");
  }
  if (artifact.body.schema_version !== 2
    || artifact.body.gate_version !== LC4_XAI_FINITE_MANUAL_GATE_D_VERSION
    || artifact.body.provider !== "xai"
    || artifact.body.model !== LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.model
    || artifact.body.voice !== LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.voice
    || artifact.body.provider_profile_manifest_sha256
      !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256
    || artifact.body.transport_purpose !== "finite_prerecorded_efficacy"
    || artifact.body.transport_mode !== "manual_commit"
    || artifact.body.transport_profile_sha256
      !== LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256
    || artifact.body.production_adapter_binding_sha256
      !== LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256
    || artifact.body.harmless_clip.sample_rate_hz !== 24_000
    || artifact.body.harmless_clip.channels !== 1
    || artifact.body.harmless_clip.encoding !== "pcm16"
    || artifact.body.harmless_clip.content_class
      !== "harmless_pcm_transport_probe_no_audibility_claim"
    || artifact.body.harmless_clip.retained_raw_audio !== false
    || artifact.body.harmless_clip.sample_count
      !== artifact.body.harmless_clip.pcm_byte_length / 2
    || artifact.body.maximum_total_micro_usd
      !== LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD
    || artifact.body.maximum_provider_sessions !== 1
    || artifact.body.maximum_generation_phases !== 2
    || artifact.body.maximum_tool_roundtrips !== 1
    || artifact.body.retry_allowed !== false
    || artifact.body.reconnect_allowed !== false
    || artifact.body.fallback_allowed !== false
    || artifact.body.efficacy_scoring_allowed !== false
    || artifact.body.provider_calls_authorized !== false) {
    throw new Error("Gate D plan differs from the frozen finite-manual profile");
  }
  if (!COMMIT.test(artifact.body.source_commit)) {
    throw new Error("Gate D plan source commit is invalid");
  }
  requireHash(artifact.body.source_tree_sha256, "Gate D plan source tree");
  requireHash(artifact.body.harmless_clip.pcm_sha256, "Gate D harmless clip");
  if (!Number.isSafeInteger(artifact.body.harmless_clip.pcm_byte_length)
    || artifact.body.harmless_clip.pcm_byte_length < 2
    || artifact.body.harmless_clip.pcm_byte_length % 2 !== 0
    || artifact.body.harmless_clip.pcm_byte_length
      > LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_PCM_BYTES) {
    throw new Error("Gate D harmless clip length is invalid");
  }
}

export function createLc4XaiFiniteManualGateDAuthorization(input: Readonly<{
  plan: Lc4XaiFiniteManualGateDPlanArtifact;
  plan_trust_root_sha256: string;
  authorization_id: string;
  authorization_nonce_sha256: string;
  credential_identity_sha256: string;
  terminal_signer: Lc4XaiFiniteManualGateDSigner;
  not_before: string;
  expires_at: string;
  authority_signer: Lc4XaiFiniteManualGateDSigner;
}>): Lc4XaiFiniteManualGateDAuthorizationArtifact {
  assertLc4XaiFiniteManualGateDPlan(input.plan, input.plan_trust_root_sha256);
  if (input.authority_signer.public_key_fingerprint_sha256
    !== input.plan_trust_root_sha256) {
    throw new Error("Gate D authorization signer differs from plan authority");
  }
  if (input.terminal_signer.public_key_fingerprint_sha256
    === input.plan_trust_root_sha256) {
    throw new Error("Gate D terminal signer must be distinct from plan authority");
  }
  if (!SAFE_ID.test(input.authorization_id)) {
    throw new Error("Gate D authorization ID is invalid");
  }
  requireHash(input.authorization_nonce_sha256, "Gate D authorization nonce");
  requireHash(input.credential_identity_sha256, "Gate D credential identity");
  requireIso(input.not_before, "Gate D authorization start");
  requireIso(input.expires_at, "Gate D authorization expiry");
  if (Date.parse(input.expires_at) <= Date.parse(input.not_before)
    || Date.parse(input.expires_at) - Date.parse(input.not_before) > 60 * 60_000) {
    throw new Error("Gate D authorization must expire within one hour");
  }
  const body = Object.freeze({
    schema_version: 2 as const,
    gate_version: LC4_XAI_FINITE_MANUAL_GATE_D_VERSION,
    authorization_id: input.authorization_id,
    authorization_nonce_sha256: input.authorization_nonce_sha256,
    plan_artifact_sha256: input.plan.artifact_sha256,
    plan_sha256: input.plan.body.plan_sha256,
    source_commit: input.plan.body.source_commit,
    source_tree_sha256: input.plan.body.source_tree_sha256,
    provider_profile_manifest_sha256:
      input.plan.body.provider_profile_manifest_sha256,
    transport_profile_sha256: input.plan.body.transport_profile_sha256,
    production_adapter_binding_sha256:
      input.plan.body.production_adapter_binding_sha256,
    credential_identity_sha256: input.credential_identity_sha256,
    terminal_public_key_spki_base64:
      input.terminal_signer.public_key_spki_der.toString("base64"),
    terminal_public_key_fingerprint_sha256:
      input.terminal_signer.public_key_fingerprint_sha256,
    maximum_total_micro_usd: LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD,
    maximum_provider_sessions: 1 as const,
    maximum_generation_phases: 2 as const,
    maximum_tool_roundtrips: 1 as const,
    one_shot: true as const,
    retry_allowed: false as const,
    reconnect_allowed: false as const,
    fallback_allowed: false as const,
    efficacy_scoring_allowed: false as const,
    not_before: input.not_before,
    expires_at: input.expires_at,
  });
  return signArtifact(
    body,
    input.authority_signer,
    AUTHORIZATION_SIGNING_DOMAIN,
    AUTHORIZATION_ARTIFACT_DOMAIN,
  );
}

function assertAuthorization(input: Readonly<{
  authorization: Lc4XaiFiniteManualGateDAuthorizationArtifact;
  plan: Lc4XaiFiniteManualGateDPlanArtifact;
  expected_plan_trust_root_sha256: string;
  now?: Date;
}>): void {
  verifyArtifact({
    artifact: input.authorization,
    expected_fingerprint: input.expected_plan_trust_root_sha256,
    signing_domain: AUTHORIZATION_SIGNING_DOMAIN,
    artifact_domain: AUTHORIZATION_ARTIFACT_DOMAIN,
    label: "Gate D authorization",
  });
  const body = input.authorization.body;
  requireExactKeys(body, AUTHORIZATION_BODY_KEYS, "Gate D authorization body");
  if (body.schema_version !== 2
    || body.gate_version !== LC4_XAI_FINITE_MANUAL_GATE_D_VERSION
    || body.plan_artifact_sha256 !== input.plan.artifact_sha256
    || body.plan_sha256 !== input.plan.body.plan_sha256
    || body.source_commit !== input.plan.body.source_commit
    || body.source_tree_sha256 !== input.plan.body.source_tree_sha256
    || body.provider_profile_manifest_sha256
      !== input.plan.body.provider_profile_manifest_sha256
    || body.transport_profile_sha256 !== input.plan.body.transport_profile_sha256
    || body.production_adapter_binding_sha256
      !== input.plan.body.production_adapter_binding_sha256
    || body.maximum_total_micro_usd
      !== LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD
    || body.maximum_provider_sessions !== 1
    || body.maximum_generation_phases !== 2
    || body.maximum_tool_roundtrips !== 1
    || body.one_shot !== true
    || body.retry_allowed !== false
    || body.reconnect_allowed !== false
    || body.fallback_allowed !== false
    || body.efficacy_scoring_allowed !== false) {
    throw new Error("Gate D authorization differs from its frozen plan");
  }
  requireHash(body.credential_identity_sha256, "Gate D credential identity");
  requireHash(
    body.terminal_public_key_fingerprint_sha256,
    "Gate D terminal trust root",
  );
  const terminalKey = Buffer.from(body.terminal_public_key_spki_base64, "base64");
  if (sha256Hex(terminalKey) !== body.terminal_public_key_fingerprint_sha256) {
    throw new Error("Gate D terminal public key fingerprint mismatch");
  }
  if (body.terminal_public_key_fingerprint_sha256
    === input.expected_plan_trust_root_sha256) {
    throw new Error("Gate D terminal authority must be distinct from plan authority");
  }
  try {
    if (createPublicKey({ key: terminalKey, format: "der", type: "spki" })
      .asymmetricKeyType !== "ed25519") {
      throw new Error("not Ed25519");
    }
  } catch {
    throw new Error("Gate D terminal public key is not a valid Ed25519 key");
  }
  requireIso(body.not_before, "Gate D authorization start");
  requireIso(body.expires_at, "Gate D authorization expiry");
  if (input.now
    && (input.now.getTime() < Date.parse(body.not_before)
      || input.now.getTime() >= Date.parse(body.expires_at))) {
    throw new Error("Gate D authorization is not active");
  }
}

function executionReplayBody(
  value: Lc4XaiFiniteManualGateDExecutionEvidence,
): Omit<Lc4XaiFiniteManualGateDExecutionEvidence, "replay_sha256"> {
  const { replay_sha256: claimedReplaySha256, ...body } = value;
  void claimedReplaySha256;
  return body;
}

export function lc4XaiFiniteManualGateDExecutionReplaySha256(
  value: Omit<Lc4XaiFiniteManualGateDExecutionEvidence, "replay_sha256">,
): string {
  return sha256Hex(`${EXECUTION_REPLAY_DOMAIN}${canonicalJson(value)}`);
}

export function assertLc4XaiFiniteManualGateDExecutionEvidence(input: Readonly<{
  evidence: Lc4XaiFiniteManualGateDExecutionEvidence;
  plan: Lc4XaiFiniteManualGateDPlanArtifact;
}>): void {
  const { evidence, plan } = input;
  requireExactKeys(evidence, EXECUTION_EVIDENCE_KEYS, "Gate D execution evidence");
  requireExactKeys(evidence.manual_turn_causality, [
    "schema_version",
    "connection_epoch",
    "commit_observation_sha256",
    "commit_sequence",
    "commit_ack_observation_sha256",
    "commit_ack_sequence",
    "response_create_observation_sha256",
    "response_create_sequence",
    "response_start_observation_sha256",
    "response_start_sequence",
    "response_id_sha256",
    "causality_sha256",
  ], "Gate D manual-turn causality evidence");
  if (Buffer.byteLength(canonicalJson(evidence), "utf8")
    > LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_EXECUTION_EVIDENCE_BYTES) {
    throw new Error("Gate D execution evidence exceeds its bounded sanitized envelope");
  }
  if (!Array.isArray(evidence.wire_observations)
    || evidence.wire_observations.length < 11
    || evidence.wire_observations.length
      > LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_WIRE_OBSERVATIONS) {
    throw new Error("Gate D execution evidence has an invalid wire observation count");
  }
  for (const [index, observation] of evidence.wire_observations.entries()) {
    requireExactKeys(
      observation,
      SANITIZED_WIRE_OBSERVATION_KEYS,
      `Gate D wire observation ${index + 1}`,
    );
    requireExactKeys(
      observation.identity_hashes,
      Object.keys(observation.identity_hashes),
      `Gate D wire observation ${index + 1} identities`,
    );
    for (const [identity, digest] of Object.entries(observation.identity_hashes)) {
      if (!WIRE_IDENTITY_KEYS.has(identity)) {
        throw new Error("Gate D wire evidence contains an unsupported identity field");
      }
      if (typeof digest !== "string") {
        throw new Error("Gate D wire evidence contains a non-string identity");
      }
      requireHash(digest, `Gate D wire ${identity}`);
    }
    if (!SAFE_WIRE_TYPE.test(observation.wire_type)
      || !Number.isSafeInteger(observation.payload_bytes)
      || observation.payload_bytes < 0
      || observation.payload_bytes > 16 * 1024 * 1024) {
      throw new Error("Gate D wire evidence exceeds its sanitized field bounds");
    }
    requireHash(observation.payload_sha256, "Gate D wire payload");
    requireHash(observation.projection_sha256, "Gate D wire projection");
    requireHash(observation.observation_sha256, "Gate D wire observation");
    if (observation.provider !== "xai") {
      throw new Error("Gate D wire evidence contains a non-xAI observation");
    }
  }
  if (evidence.replay_sha256
    !== lc4XaiFiniteManualGateDExecutionReplaySha256(executionReplayBody(evidence))) {
    throw new Error("Gate D execution replay hash mismatch");
  }
  if (evidence.schema_version !== 2
    || evidence.provider !== "xai"
    || evidence.model !== plan.body.model
    || evidence.voice !== plan.body.voice
    || evidence.transport_purpose !== "finite_prerecorded_efficacy"
    || evidence.transport_mode !== "manual_commit"
    || evidence.transport_profile_sha256 !== plan.body.transport_profile_sha256
    || evidence.production_adapter_binding_sha256
      !== plan.body.production_adapter_binding_sha256
    || evidence.caller_pcm_sha256 !== plan.body.harmless_clip.pcm_sha256
    || evidence.caller_pcm_byte_length !== plan.body.harmless_clip.pcm_byte_length
    || evidence.caller_pcm_appended_sha256 !== evidence.caller_pcm_sha256
    || evidence.caller_pcm_appended_byte_length !== evidence.caller_pcm_byte_length
    || evidence.provider_sessions_opened !== 1
    || evidence.generation_phases !== 2
    || evidence.capability_gateway_tool_roundtrips !== 1
    || evidence.retries !== 0
    || evidence.reconnects !== 0
    || evidence.fallbacks !== 0
    || canonicalJson(evidence.operation_order)
      !== canonicalJson(LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER)) {
    throw new Error("Gate D execution differs from its one-shot manual transport plan");
  }
  [
    ["initial assistant PCM", evidence.initial_assistant_pcm_sha256],
    ["capability gateway tool call", evidence.capability_gateway_tool_call_sha256],
    ["capability gateway tool result", evidence.capability_gateway_tool_result_sha256],
    ["post-tool continuation", evidence.post_tool_continuation_sha256],
    ["post-tool assistant PCM", evidence.post_tool_assistant_pcm_sha256],
    ["capability gateway call identity", evidence.capability_gateway_call_id_sha256],
    [
      "post-tool continuation origin response identity",
      evidence.post_tool_continuation_origin_response_id_sha256,
    ],
    ["post-tool response identity", evidence.post_tool_response_id_sha256],
    ["terminal observation", evidence.terminal_observation_sha256],
  ].forEach(([label, digest]) => requireHash(digest!, `Gate D ${label}`));
  const orderedWireRoles = [
    {
      digest: evidence.manual_turn_causality.commit_observation_sha256,
      direction: "outbound",
      wireType: "input_audio_buffer.commit",
      label: "manual commit",
    },
    {
      digest: evidence.manual_turn_causality.commit_ack_observation_sha256,
      direction: "inbound",
      wireType: "input_audio_buffer.committed",
      label: "manual commit acknowledgement",
    },
    {
      digest: evidence.manual_turn_causality.response_create_observation_sha256,
      direction: "outbound",
      wireType: "response.create",
      label: "initial response request",
    },
    {
      digest: evidence.manual_turn_causality.response_start_observation_sha256,
      direction: "inbound",
      wireType: "response.created",
      label: "initial response start",
    },
    {
      digest: evidence.initial_assistant_pcm_observation_sha256,
      direction: "inbound",
      wireType:
        LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE
          .assistant_audio_delta_wire_types,
      label: "initial assistant PCM",
    },
    {
      digest: evidence.capability_gateway_tool_call_observation_sha256,
      direction: "inbound",
      wireType: "response.done",
      label: "capability gateway executable call batch",
    },
    {
      digest: evidence.capability_gateway_tool_result_observation_sha256,
      direction: "outbound",
      wireType: "conversation.item.create",
      label: "capability gateway tool result",
    },
    {
      digest: evidence.post_tool_continuation_observation_sha256,
      direction: "outbound",
      wireType: "response.create",
      label: "post-tool continuation request",
    },
    {
      digest: evidence.post_tool_response_start_observation_sha256,
      direction: "inbound",
      wireType: "response.created",
      label: "post-tool continuation start",
    },
    {
      digest: evidence.post_tool_assistant_pcm_observation_sha256,
      direction: "inbound",
      wireType:
        LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE
          .assistant_audio_delta_wire_types,
      label: "post-tool assistant PCM",
    },
    {
      digest: evidence.terminal_observation_sha256,
      direction: "inbound",
      wireType: "response.done",
      label: "post-tool terminal",
    },
  ] as const;
  const orderedObservations = orderedWireRoles.map((role) => {
    requireHash(role.digest, `Gate D ${role.label} observation`);
    const matches = evidence.wire_observations.filter((observation) => (
      observation.observation_sha256 === role.digest
    ));
    if (matches.length !== 1
      || matches[0]!.provider !== "xai"
      || matches[0]!.direction !== role.direction
      || !(Array.isArray(role.wireType)
        ? role.wireType.some((wireType) => (
            matches[0]!.wire_type === wireType
          ))
        : matches[0]!.wire_type === role.wireType)) {
      throw new Error(
        `Gate D ${role.label} must resolve to exactly one role-correct xAI wire observation`,
      );
    }
    return matches[0]!;
  });
  if (orderedObservations.some((observation) => (
    observation.connection_epoch
      !== evidence.manual_turn_causality.connection_epoch
  ))
    || orderedObservations.some((observation, index) => (
      index > 0 && observation.sequence <= orderedObservations[index - 1]!.sequence
    ))) {
    throw new Error(
      "Gate D wire evidence violates commit-to-audio-to-tool-to-continuation order",
    );
  }
  const [
    commit,
    commitAcknowledgement,
    initialResponseCreate,
    initialResponseStart,
    initialAssistantPcm,
    capabilityGatewayCall,
    capabilityGatewayResult,
    postToolContinuationCreate,
    postToolResponseStart,
    postToolAssistantPcm,
    postToolTerminal,
  ] = orderedObservations;
  const rootResponseIdSha256 =
    evidence.manual_turn_causality.response_id_sha256;
  if (initialResponseStart.identity_hashes.responseIdSha256
      !== rootResponseIdSha256
    || initialAssistantPcm.identity_hashes.responseIdSha256
      !== rootResponseIdSha256
    || capabilityGatewayCall.identity_hashes.responseIdSha256
      !== rootResponseIdSha256
    || capabilityGatewayCall.identity_hashes.callIdSha256
      !== evidence.capability_gateway_call_id_sha256
    || capabilityGatewayResult.identity_hashes.callIdSha256
      !== evidence.capability_gateway_call_id_sha256
    || capabilityGatewayResult.identity_hashes.responseIdSha256 !== undefined
    || evidence.post_tool_continuation_origin_response_id_sha256
      !== rootResponseIdSha256
    || evidence.post_tool_response_id_sha256 === rootResponseIdSha256
    || postToolResponseStart.identity_hashes.responseIdSha256
      !== evidence.post_tool_response_id_sha256
    || postToolAssistantPcm.identity_hashes.responseIdSha256
      !== evidence.post_tool_response_id_sha256
    || postToolTerminal.identity_hashes.responseIdSha256
      !== evidence.post_tool_response_id_sha256
    || commit.identity_hashes.responseIdSha256 !== undefined
    || commitAcknowledgement.identity_hashes.responseIdSha256 !== undefined
    || initialResponseCreate.identity_hashes.responseIdSha256 !== undefined
    || postToolContinuationCreate.identity_hashes.responseIdSha256
      !== undefined) {
    throw new Error(
      "Gate D response, call, result, continuation, audio, and terminal identities are not continuous",
    );
  }
  const exactRoleCounts = [
    ["outbound", "input_audio_buffer.commit", 1],
    ["inbound", "input_audio_buffer.committed", 1],
    ["outbound", "response.create", 2],
    ["inbound", "response.created", 2],
    ["inbound", "response.function_call_arguments.done", 1],
    ["inbound", "response.done", 2],
    ["outbound", "conversation.item.create", 1],
  ] as const;
  for (const [direction, wireType, count] of exactRoleCounts) {
    if (evidence.wire_observations.filter((observation) => (
      observation.direction === direction
      && observation.wire_type === wireType
    )).length !== count) {
      throw new Error(
        "Gate D wire evidence contains a missing, duplicate, or reordered lifecycle role",
      );
    }
  }
  if (!Number.isSafeInteger(evidence.initial_assistant_pcm_byte_length)
    || evidence.initial_assistant_pcm_byte_length < 2
    || evidence.initial_assistant_pcm_byte_length % 2 !== 0
    || evidence.initial_assistant_pcm_byte_length > 16 * 1024 * 1024
    || !Number.isSafeInteger(evidence.post_tool_assistant_pcm_byte_length)
    || evidence.post_tool_assistant_pcm_byte_length < 2
    || evidence.post_tool_assistant_pcm_byte_length % 2 !== 0
    || evidence.post_tool_assistant_pcm_byte_length > 16 * 1024 * 1024) {
    throw new Error("Gate D must observe non-empty initial and post-tool assistant PCM");
  }
  assertLc4XaiManualTurnCausality(
    evidence.manual_turn_causality,
    evidence.wire_observations,
  );
  if (evidence.post_tool_continuation_origin_response_id_sha256
      !== evidence.manual_turn_causality.response_id_sha256
    || evidence.post_tool_response_id_sha256
      === evidence.manual_turn_causality.response_id_sha256) {
    throw new Error(
      "Gate D post-tool continuation is not bound to a distinct causal response",
    );
  }
}

export async function claimLc4XaiFiniteManualGateDInvocation(
  input: Readonly<{
    marker_path: string;
    plan: Lc4XaiFiniteManualGateDPlanArtifact;
    authorization: Lc4XaiFiniteManualGateDAuthorizationArtifact;
    claimed_at: string;
  }>,
): Promise<Lc4XaiFiniteManualGateDInvocationClaim> {
  requireIso(input.claimed_at, "Gate D invocation claim time");
  const body = Object.freeze({
    schema_version: 2 as const,
    gate_version: LC4_XAI_FINITE_MANUAL_GATE_D_VERSION,
    plan_artifact_sha256: input.plan.artifact_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    source_commit: input.plan.body.source_commit,
    source_tree_sha256: input.plan.body.source_tree_sha256,
    claimed_at: input.claimed_at,
    claim_sequence: 1 as const,
    state: "claimed_before_provider_adapter_construction" as const,
    raw_audio_retained: false as const,
    credentials_retained: false as const,
  });
  const markerClaim = Object.freeze({
    ...body,
    marker_claim_sha256: sha256Hex(
      `${INVOCATION_MARKER_CLAIM_DOMAIN}${canonicalJson(body)}`,
    ),
  });
  const markerBytes = Buffer.from(`${canonicalJson(markerClaim)}\n`, "utf8");
  let file;
  let markerIdentity: Readonly<{
    device: number;
    inode: number;
    nlink: 1;
    permission_mode: 0o400;
  }> | null = null;
  try {
    file = await open(input.marker_path, "wx", 0o400);
    await file.writeFile(markerBytes);
    await file.sync();
    const metadata = await file.stat();
    if (!metadata.isFile()
      || metadata.nlink !== 1
      || !Number.isSafeInteger(metadata.dev)
      || metadata.dev < 0
      || !Number.isSafeInteger(metadata.ino)
      || metadata.ino < 1
      || (metadata.mode & 0o777) !== 0o400) {
      throw new Error("Gate D invocation marker lacks exact private file custody");
    }
    markerIdentity = Object.freeze({
      device: metadata.dev,
      inode: metadata.ino,
      nlink: 1 as const,
      permission_mode: 0o400 as const,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Gate D authorization was already invoked");
    }
    throw error;
  } finally {
    await file?.close();
  }
  if (markerIdentity === null) {
    throw new Error("Gate D invocation marker identity was not retained");
  }
  const claimBody = Object.freeze({
    ...markerClaim,
    marker_file_sha256: sha256Hex(markerBytes),
    marker_device: markerIdentity.device,
    marker_inode: markerIdentity.inode,
    marker_nlink: markerIdentity.nlink,
    marker_permission_mode: markerIdentity.permission_mode,
  });
  return Object.freeze({
    ...claimBody,
    claim_sha256: sha256Hex(
      `${INVOCATION_CLAIM_DOMAIN}${canonicalJson(claimBody)}`,
    ),
  });
}

export function lc4XaiFiniteManualGateDInvocationMarkerBytes(
  claim: Lc4XaiFiniteManualGateDInvocationClaim,
): Buffer {
  const {
    claim_sha256: omittedClaimHash,
    marker_file_sha256: omittedFileHash,
    marker_device: omittedDevice,
    marker_inode: omittedInode,
    marker_nlink: omittedNlink,
    marker_permission_mode: omittedMode,
    ...markerClaim
  } = claim;
  void omittedClaimHash;
  void omittedFileHash;
  void omittedDevice;
  void omittedInode;
  void omittedNlink;
  void omittedMode;
  return Buffer.from(`${canonicalJson(markerClaim)}\n`, "utf8");
}

function assertInvocationClaim(
  claim: Lc4XaiFiniteManualGateDInvocationClaim,
  plan: Lc4XaiFiniteManualGateDPlanArtifact,
  authorization: Lc4XaiFiniteManualGateDAuthorizationArtifact,
): void {
  requireExactKeys(claim, INVOCATION_CLAIM_KEYS, "Gate D invocation claim");
  const {
    claim_sha256: claimed,
    ...claimBody
  } = claim;
  if (claimed !== sha256Hex(
    `${INVOCATION_CLAIM_DOMAIN}${canonicalJson(claimBody)}`,
  )) {
    throw new Error("Gate D invocation claim hash mismatch");
  }
  const markerBytes = lc4XaiFiniteManualGateDInvocationMarkerBytes(claim);
  if (claim.marker_file_sha256 !== sha256Hex(markerBytes)) {
    throw new Error("Gate D invocation marker file hash mismatch");
  }
  const {
    marker_claim_sha256: claimedMarkerClaim,
    ...markerBody
  } = JSON.parse(markerBytes.toString("utf8")) as Record<string, unknown>;
  if (claimedMarkerClaim !== sha256Hex(
    `${INVOCATION_MARKER_CLAIM_DOMAIN}${canonicalJson(markerBody)}`,
  )) {
    throw new Error("Gate D invocation marker claim hash mismatch");
  }
  if (claim.schema_version !== 2
    || claim.gate_version !== LC4_XAI_FINITE_MANUAL_GATE_D_VERSION
    || claim.plan_artifact_sha256 !== plan.artifact_sha256
    || claim.authorization_artifact_sha256 !== authorization.artifact_sha256
    || claim.source_commit !== plan.body.source_commit
    || claim.source_tree_sha256 !== plan.body.source_tree_sha256
    || claim.claim_sequence !== 1
    || claim.state !== "claimed_before_provider_adapter_construction"
    || claim.raw_audio_retained !== false
    || claim.credentials_retained !== false
    || !Number.isSafeInteger(claim.marker_device)
    || claim.marker_device < 0
    || !Number.isSafeInteger(claim.marker_inode)
    || claim.marker_inode < 1
    || claim.marker_nlink !== 1
    || claim.marker_permission_mode !== 0o400) {
    throw new Error("Gate D invocation claim does not bind its authorized plan");
  }
  requireIso(claim.claimed_at, "Gate D invocation claim time");
}

function createAdapterConstruction(
  claim: Lc4XaiFiniteManualGateDInvocationClaim,
): Lc4XaiFiniteManualGateDAdapterConstruction {
  const body = Object.freeze({
    schema_version: 2 as const,
    gate_version: LC4_XAI_FINITE_MANUAL_GATE_D_VERSION,
    invocation_claim_sha256: claim.claim_sha256,
    construction_sequence: 2 as const,
    adapter_kind:
      "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1" as const,
    production_adapter_binding_sha256:
      LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
  });
  return Object.freeze({
    ...body,
    construction_sha256:
      sha256Hex(`${ADAPTER_CONSTRUCTION_DOMAIN}${canonicalJson(body)}`),
  });
}

function assertAdapterConstruction(
  construction: Lc4XaiFiniteManualGateDAdapterConstruction,
  claim: Lc4XaiFiniteManualGateDInvocationClaim,
): void {
  requireExactKeys(
    construction,
    ADAPTER_CONSTRUCTION_KEYS,
    "Gate D adapter construction",
  );
  const { construction_sha256: claimed, ...body } = construction;
  if (claimed !== sha256Hex(
    `${ADAPTER_CONSTRUCTION_DOMAIN}${canonicalJson(body)}`,
  )) {
    throw new Error("Gate D adapter construction hash mismatch");
  }
  if (construction.schema_version !== 2
    || construction.gate_version !== LC4_XAI_FINITE_MANUAL_GATE_D_VERSION
    || construction.invocation_claim_sha256 !== claim.claim_sha256
    || construction.construction_sequence !== 2
    || construction.adapter_kind
      !== "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1"
    || construction.production_adapter_binding_sha256
      !== LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256) {
    throw new Error("Gate D adapter construction is not post-claim and profile-bound");
  }
}

export async function executeLc4XaiFiniteManualGateD(
  input: Lc4XaiFiniteManualGateDExecution,
): Promise<Lc4XaiFiniteManualGateDReceipt> {
  const planTrust = input.expected_plan_trust_root_sha256;
  assertLc4XaiFiniteManualGateDPlan(input.plan, planTrust);
  assertAuthorization({
    authorization: input.authorization,
    plan: input.plan,
    expected_plan_trust_root_sha256: planTrust,
    now: input.now,
  });
  if (input.credential_identity_sha256
    !== input.authorization.body.credential_identity_sha256) {
    throw new Error("Gate D credential identity differs from authorization");
  }
  if (input.inspected_source.worktree_clean !== true
    || input.inspected_source.source_commit !== input.plan.body.source_commit
    || input.inspected_source.source_tree_sha256 !== input.plan.body.source_tree_sha256) {
    throw new Error("Gate D source is stale or dirty");
  }
  if (sha256Hex(input.caller_pcm) !== input.plan.body.harmless_clip.pcm_sha256
    || input.caller_pcm.byteLength !== input.plan.body.harmless_clip.pcm_byte_length) {
    throw new Error("Gate D caller PCM differs from its byte-exact plan");
  }
  if (input.terminal_signer.public_key_fingerprint_sha256
    !== input.authorization.body.terminal_public_key_fingerprint_sha256) {
    throw new Error("Gate D terminal signer differs from authorization");
  }
  const invocationClaim = await claimLc4XaiFiniteManualGateDInvocation({
    marker_path: input.invocation_marker_path,
    plan: input.plan,
    authorization: input.authorization,
    claimed_at: input.now.toISOString(),
  });
  assertInvocationClaim(invocationClaim, input.plan, input.authorization);
  const productionAdapter = await input.construct_production_adapter();
  if (productionAdapter[LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY] !== true
    || productionAdapter.kind
    !== "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1"
    || productionAdapter.production_adapter_binding_sha256
      !== LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256) {
    throw new Error(
      "Gate D paid executor is not the exact frozen production provider adapter path",
    );
  }
  const adapterConstruction = createAdapterConstruction(invocationClaim);
  assertAdapterConstruction(adapterConstruction, invocationClaim);
  const evidence = await productionAdapter.execute({
    caller_pcm: input.caller_pcm,
    plan: input.plan,
    authorization: input.authorization,
  });
  assertLc4XaiFiniteManualGateDExecutionEvidence({ evidence, plan: input.plan });
  const completedAt = input.completion_clock();
  if (completedAt.getTime() < input.now.getTime()) {
    throw new Error("Gate D completion clock precedes its invocation claim");
  }
  const terminalBody = Object.freeze({
    schema_version: 2 as const,
    gate_version: LC4_XAI_FINITE_MANUAL_GATE_D_VERSION,
    status: "passed" as const,
    completed_at: completedAt.toISOString(),
    plan_artifact_sha256: input.plan.artifact_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    source_commit: input.plan.body.source_commit,
    source_tree_sha256: input.plan.body.source_tree_sha256,
    provider_profile_manifest_sha256:
      input.plan.body.provider_profile_manifest_sha256,
    transport_profile_sha256: input.plan.body.transport_profile_sha256,
    production_adapter_binding_sha256:
      input.plan.body.production_adapter_binding_sha256,
    invocation_claim_sha256: invocationClaim.claim_sha256,
    invocation_marker_file_sha256: invocationClaim.marker_file_sha256,
    adapter_construction_sha256: adapterConstruction.construction_sha256,
    execution_replay_sha256: evidence.replay_sha256,
    provider_sessions_opened: 1 as const,
    generation_phases: 2 as const,
    capability_gateway_tool_roundtrips: 1 as const,
    retries: 0 as const,
    reconnects: 0 as const,
    fallbacks: 0 as const,
    budget: Object.freeze({
      reserved_micro_usd: LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD,
      conservatively_settled_micro_usd:
        LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD,
      active_micro_usd: 0 as const,
    }),
    raw_audio_retained: false as const,
    credentials_retained: false as const,
    efficacy_scored: false as const,
    claim_boundary: "transport_qualification_only_not_efficacy_evidence" as const,
  });
  const terminal = signArtifact(
    terminalBody,
    input.terminal_signer,
    TERMINAL_SIGNING_DOMAIN,
    TERMINAL_ARTIFACT_DOMAIN,
  );
  const packageManifestBody = Object.freeze({
    schema_version: 2 as const,
    gate_version: LC4_XAI_FINITE_MANUAL_GATE_D_VERSION,
    status: "passed" as const,
    plan_artifact_sha256: input.plan.artifact_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    invocation_claim_sha256: invocationClaim.claim_sha256,
    invocation_marker_file_sha256: invocationClaim.marker_file_sha256,
    adapter_construction_sha256: adapterConstruction.construction_sha256,
    execution_replay_sha256: evidence.replay_sha256,
    terminal_artifact_sha256: terminal.artifact_sha256,
    plan_authority_trust_root_sha256: planTrust,
    terminal_authority_trust_root_sha256:
      input.terminal_signer.public_key_fingerprint_sha256,
    source_commit: input.plan.body.source_commit,
    source_tree_sha256: input.plan.body.source_tree_sha256,
    provider_profile_manifest_sha256:
      input.plan.body.provider_profile_manifest_sha256,
    transport_profile_sha256: input.plan.body.transport_profile_sha256,
    production_adapter_binding_sha256:
      input.plan.body.production_adapter_binding_sha256,
    lifecycle: Object.freeze({
      invocation_claim_sequence: 1 as const,
      adapter_construction_sequence: 2 as const,
      provider_execution_sequence: 3 as const,
      terminal_sequence: 4 as const,
      package_manifest_sequence: 5 as const,
    }),
    budget: terminalBody.budget,
    raw_audio_retained: false as const,
    credentials_retained: false as const,
    efficacy_scored: false as const,
    claim_boundary: "transport_qualification_only_not_efficacy_evidence" as const,
  });
  const packageManifest = signArtifact(
    packageManifestBody,
    input.terminal_signer,
    PACKAGE_MANIFEST_SIGNING_DOMAIN,
    PACKAGE_MANIFEST_ARTIFACT_DOMAIN,
  );
  const receiptBody = Object.freeze({
    schema_version: 2 as const,
    gate_version: LC4_XAI_FINITE_MANUAL_GATE_D_VERSION,
    status: "passed" as const,
    source_commit: input.plan.body.source_commit,
    source_tree_sha256: input.plan.body.source_tree_sha256,
    provider_profile_manifest_sha256:
      input.plan.body.provider_profile_manifest_sha256,
    transport_purpose: "finite_prerecorded_efficacy" as const,
    transport_mode: "manual_commit" as const,
    transport_profile_sha256: input.plan.body.transport_profile_sha256,
    production_adapter_binding_sha256:
      input.plan.body.production_adapter_binding_sha256,
    plan_authority_trust_root_sha256: planTrust,
    plan: input.plan,
    authorization: input.authorization,
    invocation_claim: invocationClaim,
    adapter_construction: adapterConstruction,
    execution_evidence: evidence,
    terminal,
    package_manifest: packageManifest,
    execution_replay_sha256: evidence.replay_sha256,
    provider_sessions_opened: 1 as const,
    retries: 0 as const,
    reconnects: 0 as const,
    fallbacks: 0 as const,
    efficacy_scored: false as const,
    claim_boundary: "transport_qualification_only_not_efficacy_evidence" as const,
  });
  const receipt = Object.freeze({
    ...receiptBody,
    receipt_sha256: sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(receiptBody)}`),
  });
  assertLc4XaiFiniteManualGateDReceipt(receipt, {
    expected_plan_trust_root_sha256: planTrust,
    expected_source_commit: input.plan.body.source_commit,
    expected_source_tree_sha256: input.plan.body.source_tree_sha256,
    expected_provider_profile_manifest_sha256:
      LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
  });
  return receipt;
}

export function assertLc4XaiFiniteManualGateDReceipt(
  receipt: Lc4XaiFiniteManualGateDReceipt,
  expected: Readonly<{
    expected_plan_trust_root_sha256: string;
    expected_source_commit: string;
    expected_source_tree_sha256: string;
    expected_provider_profile_manifest_sha256: string;
  }>,
): void {
  requireExactKeys(receipt, RECEIPT_KEYS, "Gate D receipt");
  const { receipt_sha256: claimedReceipt, ...receiptBody } = receipt;
  if (claimedReceipt !== sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(receiptBody)}`)) {
    throw new Error("Gate D receipt hash mismatch");
  }
  assertLc4XaiFiniteManualGateDPlan(
    receipt.plan,
    expected.expected_plan_trust_root_sha256,
  );
  assertAuthorization({
    authorization: receipt.authorization,
    plan: receipt.plan,
    expected_plan_trust_root_sha256: expected.expected_plan_trust_root_sha256,
  });
  assertInvocationClaim(receipt.invocation_claim, receipt.plan, receipt.authorization);
  assertAdapterConstruction(
    receipt.adapter_construction,
    receipt.invocation_claim,
  );
  assertLc4XaiFiniteManualGateDExecutionEvidence({
    evidence: receipt.execution_evidence,
    plan: receipt.plan,
  });
  verifyArtifact({
    artifact: receipt.terminal,
    expected_fingerprint:
      receipt.authorization.body.terminal_public_key_fingerprint_sha256,
    signing_domain: TERMINAL_SIGNING_DOMAIN,
    artifact_domain: TERMINAL_ARTIFACT_DOMAIN,
    label: "Gate D terminal",
  });
  verifyArtifact({
    artifact: receipt.package_manifest,
    expected_fingerprint:
      receipt.authorization.body.terminal_public_key_fingerprint_sha256,
    signing_domain: PACKAGE_MANIFEST_SIGNING_DOMAIN,
    artifact_domain: PACKAGE_MANIFEST_ARTIFACT_DOMAIN,
    label: "Gate D package manifest",
  });
  requireExactKeys(
    receipt.terminal.body,
    TERMINAL_BODY_KEYS,
    "Gate D terminal body",
  );
  requireExactKeys(
    receipt.package_manifest.body,
    PACKAGE_MANIFEST_BODY_KEYS,
    "Gate D package manifest body",
  );
  requireExactKeys(receipt.terminal.body.budget, [
    "reserved_micro_usd",
    "conservatively_settled_micro_usd",
    "active_micro_usd",
  ], "Gate D terminal budget");
  requireExactKeys(receipt.package_manifest.body.budget, [
    "reserved_micro_usd",
    "conservatively_settled_micro_usd",
    "active_micro_usd",
  ], "Gate D package budget");
  requireExactKeys(receipt.package_manifest.body.lifecycle, [
    "invocation_claim_sequence",
    "adapter_construction_sequence",
    "provider_execution_sequence",
    "terminal_sequence",
    "package_manifest_sequence",
  ], "Gate D package lifecycle");
  const terminal = receipt.terminal.body;
  const packageManifest = receipt.package_manifest.body;
  requireIso(terminal.completed_at, "Gate D completion time");
  if (Date.parse(terminal.completed_at)
    < Date.parse(receipt.invocation_claim.claimed_at)) {
    throw new Error("Gate D terminal predates its invocation claim");
  }
  if (receipt.schema_version !== 2
    || receipt.gate_version !== LC4_XAI_FINITE_MANUAL_GATE_D_VERSION
    || receipt.status !== "passed"
    || receipt.source_commit !== expected.expected_source_commit
    || receipt.source_tree_sha256 !== expected.expected_source_tree_sha256
    || receipt.provider_profile_manifest_sha256
      !== expected.expected_provider_profile_manifest_sha256
    || receipt.provider_profile_manifest_sha256
      !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256
    || receipt.transport_purpose !== "finite_prerecorded_efficacy"
    || receipt.transport_mode !== "manual_commit"
    || receipt.transport_profile_sha256
      !== LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256
    || receipt.production_adapter_binding_sha256
      !== LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256
    || receipt.plan_authority_trust_root_sha256
      !== expected.expected_plan_trust_root_sha256
    || receipt.plan.public_key_fingerprint_sha256
      !== expected.expected_plan_trust_root_sha256
    || receipt.authorization.public_key_fingerprint_sha256
      !== expected.expected_plan_trust_root_sha256
    || receipt.authorization.body.terminal_public_key_fingerprint_sha256
      === expected.expected_plan_trust_root_sha256
    || receipt.execution_replay_sha256 !== terminal.execution_replay_sha256
    || receipt.execution_replay_sha256
      !== receipt.execution_evidence.replay_sha256
    || receipt.provider_sessions_opened !== 1
    || receipt.retries !== 0
    || receipt.reconnects !== 0
    || receipt.fallbacks !== 0
    || receipt.efficacy_scored !== false
    || receipt.claim_boundary
      !== "transport_qualification_only_not_efficacy_evidence"
    || terminal.status !== "passed"
    || terminal.plan_artifact_sha256 !== receipt.plan.artifact_sha256
    || terminal.authorization_artifact_sha256
      !== receipt.authorization.artifact_sha256
    || terminal.source_commit !== receipt.source_commit
    || terminal.source_tree_sha256 !== receipt.source_tree_sha256
    || terminal.provider_profile_manifest_sha256
      !== receipt.provider_profile_manifest_sha256
    || terminal.transport_profile_sha256 !== receipt.transport_profile_sha256
    || terminal.production_adapter_binding_sha256
      !== receipt.production_adapter_binding_sha256
    || terminal.invocation_claim_sha256
      !== receipt.invocation_claim.claim_sha256
    || terminal.invocation_marker_file_sha256
      !== receipt.invocation_claim.marker_file_sha256
    || terminal.adapter_construction_sha256
      !== receipt.adapter_construction.construction_sha256
    || terminal.provider_sessions_opened !== 1
    || terminal.generation_phases !== 2
    || terminal.capability_gateway_tool_roundtrips !== 1
    || terminal.retries !== 0
    || terminal.reconnects !== 0
    || terminal.fallbacks !== 0
    || terminal.budget.reserved_micro_usd
      !== LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD
    || terminal.budget.conservatively_settled_micro_usd
      !== LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD
    || terminal.budget.active_micro_usd !== 0
    || terminal.raw_audio_retained !== false
    || terminal.credentials_retained !== false
    || terminal.efficacy_scored !== false
    || terminal.claim_boundary
      !== "transport_qualification_only_not_efficacy_evidence"
    || packageManifest.schema_version !== 2
    || packageManifest.gate_version !== LC4_XAI_FINITE_MANUAL_GATE_D_VERSION
    || packageManifest.status !== "passed"
    || packageManifest.plan_artifact_sha256 !== receipt.plan.artifact_sha256
    || packageManifest.authorization_artifact_sha256
      !== receipt.authorization.artifact_sha256
    || packageManifest.invocation_claim_sha256
      !== receipt.invocation_claim.claim_sha256
    || packageManifest.invocation_marker_file_sha256
      !== receipt.invocation_claim.marker_file_sha256
    || packageManifest.adapter_construction_sha256
      !== receipt.adapter_construction.construction_sha256
    || packageManifest.execution_replay_sha256
      !== receipt.execution_evidence.replay_sha256
    || packageManifest.terminal_artifact_sha256
      !== receipt.terminal.artifact_sha256
    || packageManifest.plan_authority_trust_root_sha256
      !== expected.expected_plan_trust_root_sha256
    || packageManifest.terminal_authority_trust_root_sha256
      !== receipt.authorization.body.terminal_public_key_fingerprint_sha256
    || packageManifest.terminal_authority_trust_root_sha256
      !== receipt.package_manifest.public_key_fingerprint_sha256
    || packageManifest.source_commit !== receipt.source_commit
    || packageManifest.source_tree_sha256 !== receipt.source_tree_sha256
    || packageManifest.provider_profile_manifest_sha256
      !== receipt.provider_profile_manifest_sha256
    || packageManifest.transport_profile_sha256
      !== receipt.transport_profile_sha256
    || packageManifest.production_adapter_binding_sha256
      !== receipt.production_adapter_binding_sha256
    || packageManifest.lifecycle.invocation_claim_sequence !== 1
    || packageManifest.lifecycle.adapter_construction_sequence !== 2
    || packageManifest.lifecycle.provider_execution_sequence !== 3
    || packageManifest.lifecycle.terminal_sequence !== 4
    || packageManifest.lifecycle.package_manifest_sequence !== 5
    || canonicalJson(packageManifest.budget) !== canonicalJson(terminal.budget)
    || packageManifest.raw_audio_retained !== false
    || packageManifest.credentials_retained !== false
    || packageManifest.efficacy_scored !== false
    || packageManifest.claim_boundary
      !== "transport_qualification_only_not_efficacy_evidence") {
    throw new Error("Gate D receipt is not an exact finite-manual transport pass");
  }
}
