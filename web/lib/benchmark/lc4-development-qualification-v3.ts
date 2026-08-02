import { createPublicKey, verify } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
  LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
  LC4_QUALIFICATION_V3_PROVIDER_ORDER,
  LC4_QUALIFICATION_V3_RUNNER_VERSION,
  LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
  LC4_XAI_SERVER_VAD_SETTING_SHA256,
  assertLc4QualificationV3Authorization,
  assertLc4QualificationV3PlanArtifact,
  createLc4QualificationV3PaidTargets,
  createLc4QualificationV3Targets,
  reportLc4QualificationV3,
  type Lc4QualificationV3AuthorizationArtifact,
  type Lc4QualificationV3PlanArtifact,
  type Lc4QualificationV3TerminalArtifact,
  type Lc4XaiServerVadGateBBindingArtifact,
  assertXaiServerVadGateARiskArtifact,
  type Lc4XaiServerVadGateARiskArtifact,
} from "./lc4-qualification-v3-runner";
import {
  assertLc4QualificationBudgetEvidence,
  type Lc4QualificationBudgetEvidence,
} from "./lc4-qualification-budget";
import type { Lc4S2sRoundtripExecution } from "./provider-s2s-tool-roundtrip";
import {
  PROVIDER_QUALIFICATION_MAX_AGE_MS,
  assertProviderQualificationArtifactIntegrity,
  providerQualificationMatrixSha256,
  type ProviderQualificationArtifact,
  type ProviderQualificationTarget,
} from "./provider-qualification";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "./lc4-provider-profiles";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type { RealtimeWireObservation } from "../realtime/client/types";
import { verifyRealtimeWireObservationChain } from "../realtime/client/wire-evidence";
import {
  projectRoundtripPreToolOutputQuarantineEvidence,
  replayProviderToolRoundtrip,
  type RoundtripPreToolOutputQuarantineEvidence,
  type RoundtripSanitizedUsage,
} from "./provider-roundtrip-replay";
import {
  assertSignedLc4QualificationPackageEnvelopeV5Identity,
  readLc4QualificationPackageDirectoryV5,
  verifySignedLc4QualificationPackageEnvelopeV5,
  type Lc4QualificationTerminalClaimsV5,
  type SignedLc4QualificationPackageEnvelopeV5,
} from "./lc4-qualification-package-envelope";
import {
  assertLc4QualificationV4TerminalArtifact,
  verifySignedLc4QualificationV4Package,
  type Lc4QualificationV4TerminalArtifact,
} from "./lc4-qualification-v4-package";
import {
  LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
  type Lc4QualificationV4PhaseTerminal,
} from "./lc4-qualification-v4-shards";
import { lc4QualificationBudgetBindingSha256, type Lc4QualificationBudgetBinding } from "./lc4-qualification-budget";

const PLAN_SIGNING_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan/v6\n";
const PLAN_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan-artifact/v6\n";
const TERMINAL_SIGNING_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal/v7\n";
const TERMINAL_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal-artifact/v7\n";
const AUTHORIZATION_SIGNING_DOMAIN = "harshas-amazing-call-center/lc4-qualification-authorization/v5\n";
const AUTHORIZATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-authorization-artifact/v5\n";
const RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-retained-qualification-v3/v3\n";
const REPORT_DOMAIN = "harshas-amazing-call-center/lc4-dev-qualification-v3-report/v2\n";
const XAI_GATE_B_BINDING_DOMAIN = "harshas-amazing-call-center/xai-server-vad-gate-b-binding/v1\n";
const TRANSPORT_SCOPE_DOMAIN = "harshas-amazing-call-center/lc4-dev-retained-qualification-transport-scope/v1\n";
const V4_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-retained-qualification-v4/v1\n";
const V4_INVOCATION_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-shard-invocation/v1\n";
const V4_SETUP_AGGREGATE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-setup-aggregate/v1\n";
const V4_REPLAY_AGGREGATE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-replay-aggregate/v1\n";
const HASH = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_JSONL_BYTES = 256 * 1024 * 1024;

/**
 * Exact transport scope exercised by the retained three-provider Gate B.
 * The development efficacy matrix uses finite prerecorded clips; its xAI
 * manual-commit transport is deliberately excluded because Gate B exercises
 * xAI's provider-native server-VAD lifecycle instead.
 */
export const LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE = Object.freeze({
  schema_version: 1 as const,
  qualified_transports: Object.freeze([
    Object.freeze({ provider: "openai" as const, turn_boundary: "manual_commit" as const }),
    Object.freeze({ provider: "gemini" as const, turn_boundary: "provider_activity_markers" as const }),
    Object.freeze({ provider: "xai" as const, turn_boundary: "provider_native_server_vad" as const }),
  ]),
  excluded_episode_transports: Object.freeze([
    Object.freeze({
      provider: "xai" as const,
      turn_boundary: "manual_commit" as const,
      purpose: "finite_prerecorded_efficacy" as const,
      reason: "not_exercised_by_retained_server_vad_gate_b" as const,
    }),
  ]),
  claim_boundary: "transport_qualification_applies_only_to_listed_gate_b_transports_not_every_development_episode_transport" as const,
});

export const LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256 = sha256Hex(
  `${TRANSPORT_SCOPE_DOMAIN}${canonicalJson(LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE)}`,
);

type QualificationReport = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_QUALIFICATION_V3_RUNNER_VERSION;
  plan_artifact_sha256: string;
  source_commit: string;
  invoked_attempts: number;
  refused_attempts: number;
  stranded_invocations: number;
  complete_attempts: number;
  partial_attempts: number;
  gate_c_qualification_gate: false;
  maximum_total_usd: 3;
  maximum_provider_sessions: number;
  maximum_paid_sessions: number;
  maximum_generation_phases: number;
  paid_retry_allowed: false;
  latest: Lc4QualificationV3TerminalArtifact["body"];
}>;

type PackageManifest = SignedLc4QualificationPackageEnvelopeV5;

export type Lc4DevRetainedRoundtripSummary = Omit<Lc4S2sRoundtripExecution, "wire_observations" | "usage" | "sanitized_usage"> & Readonly<{
  wire_observation_count: number;
  usage_event_count: number;
}>;
type RetainedRoundtripSummary = Lc4DevRetainedRoundtripSummary;

export function assertLc4DevRetainedRoundtripLogCardinality(input: Readonly<{
  provider: LiveStsProvider;
  summary_wire_observation_count: number;
  summary_raw_usage_event_count: number;
  retained_wire_observation_count: number;
  retained_sanitized_usage_event_count: number;
}>): void {
  if (!Number.isSafeInteger(input.summary_raw_usage_event_count)
    || input.summary_raw_usage_event_count < 1) {
    throw new Error(`LC4-DEV qualification v3 ${input.provider} retained Gate B raw usage count is invalid`);
  }
  if (input.summary_wire_observation_count !== input.retained_wire_observation_count) {
    throw new Error(`LC4-DEV qualification v3 ${input.provider} retained Gate B wire count differs from its log`);
  }
  // `usage_event_count` commits the raw normalized provider/client events.
  // The retained JSONL is a distinct replay projection: one sanitized,
  // terminal-bound usage record per passing provider roundtrip.
  if (input.retained_sanitized_usage_event_count !== 1) {
    throw new Error(`LC4-DEV qualification v3 ${input.provider} retained Gate B sanitized usage log must contain exactly one event`);
  }
}

export function lc4DevProjectionContainsAssistantOutput(
  projection: unknown,
  wireType = "unknown",
): boolean {
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return false;
  const projected = projection as Readonly<Record<string, unknown>>;
  if (projected.audio !== undefined) return true;
  if (projected.text === undefined) return false;
  // Provider-native history hydration deliberately replays caller-heard user
  // and assistant messages before the first live turn. Those acknowledgements
  // carry both a typed `conversationHistoryItem` commitment and the ordinary
  // redacted text projection. Exclude only the exact, hash/byte-matched history
  // shape; malformed, mixed, or altered projections remain possible live
  // assistant output and therefore fail closed below.
  if (lc4DevProjectionIsExactConversationHistoryMessage(projected)) return false;
  // Gemini and OpenAI-compatible transports encode caller transcription with
  // different redacted kinds. Exempt only their exact caller-side shapes;
  // mixed, malformed, and unknown text remains possible assistant output.
  return !Array.isArray(projected.text)
    || projected.text.length === 0
    || !projected.text.every((entry) => (
      entry !== null
      && typeof entry === "object"
      && !Array.isArray(entry)
      && ((entry as Readonly<Record<string, unknown>>).kind === "input_transcript"
        || (wireType.startsWith("conversation.item.input_audio_transcription.")
          && (entry as Readonly<Record<string, unknown>>).kind === "transcript"))
    ));
}

function lc4DevProjectionIsExactConversationHistoryMessage(
  projected: Readonly<Record<string, unknown>>,
): boolean {
  const history = projected.conversationHistoryItem;
  if (!history || typeof history !== "object" || Array.isArray(history)) return false;
  const item = history as Readonly<Record<string, unknown>>;
  const expected = item.kind === "user_message"
    && item.role === "user"
    && item.contentType === "input_text"
    ? "input_text"
    : item.kind === "assistant_message"
      && item.role === "assistant"
      && item.contentType === "output_text"
      ? "output_text"
      : null;
  if (expected === null
    || typeof item.contentSha256 !== "string"
    || !HASH.test(item.contentSha256)
    || !Number.isSafeInteger(item.contentBytes)
    || (item.contentBytes as number) < 0
    || !Array.isArray(projected.text)
    || projected.text.length !== 1) {
    return false;
  }
  const text = projected.text[0];
  return text !== null
    && typeof text === "object"
    && !Array.isArray(text)
    && (text as Readonly<Record<string, unknown>>).kind === expected
    && (text as Readonly<Record<string, unknown>>).sha256 === item.contentSha256
    && (text as Readonly<Record<string, unknown>>).byteLength === item.contentBytes;
}

export function lc4DevPreToolOutputIsExactlyQuarantined(input: Readonly<{
  provider: LiveStsProvider;
  pre_call_output_observation_sha256s: readonly string[];
  retained_quarantine: RoundtripPreToolOutputQuarantineEvidence | null;
  replayed_quarantine: RoundtripPreToolOutputQuarantineEvidence | null;
}>): boolean {
  if (input.pre_call_output_observation_sha256s.length === 0) return true;
  const retained = input.retained_quarantine;
  const replayed = input.replayed_quarantine;
  return (input.provider === "xai" || input.provider === "gemini")
    && retained !== null
    && replayed !== null
    && retained.disposition === "suppressed_never_caller_playable"
    && retained.released_audio_bytes === 0
    && canonicalJson(input.pre_call_output_observation_sha256s)
      === canonicalJson(retained.observation_sha256s)
    && canonicalJson(replayed) === canonicalJson(retained);
}

export function lc4DevRetainedUsageMatchesProviderBoundary(input: Readonly<{
  provider: LiveStsProvider;
  usage: readonly Readonly<{
    source: string;
    terminal_observation_sha256: string;
    provider_usage_observation_sha256: string | null;
  }>[];
  terminal_observation_sha256: string;
  provider_usage_observed_on_wire: boolean;
}>): boolean {
  if (input.usage.length !== 1) return false;
  const usage = input.usage[0]!;
  if (usage.terminal_observation_sha256 !== input.terminal_observation_sha256) return false;
  if (usage.source === "provider_reported") {
    return input.provider_usage_observed_on_wire
      && usage.provider_usage_observation_sha256 !== null;
  }
  if (usage.source === "client_measured_wire_pcm") {
    return input.provider === "xai"
      && !input.provider_usage_observed_on_wire
      && usage.provider_usage_observation_sha256 === null;
  }
  return false;
}

export type Lc4DevQualificationV3SpokenEvidence = Readonly<{
  provider: LiveStsProvider;
  model: string;
  evidence_sha256: string;
  public_execution_sha256: string;
  replay_sha256: string;
  summary_file_sha256: string;
  wire_file_sha256: string;
  usage_file_sha256: string;
  wire_observation_count: number;
  usage_event_count: number;
  caller_audio_bytes: number;
  caller_audio_sha256: string;
  delivery_profile_sha256: string;
  input_audio_evidence: NonNullable<Lc4S2sRoundtripExecution["input_audio_evidence"]>;
  output_audio_evidence: NonNullable<Lc4S2sRoundtripExecution["output_audio_evidence"]>;
  turn_boundary_mode: Lc4S2sRoundtripExecution["turn_boundary_mode"];
  server_vad_setting_sha256: string | null;
  transport_parity_sha256: string | null;
  tool_frontier_sha256: string;
  per_turn_session_update_observation_sha256: string | null;
  per_turn_session_ack_observation_sha256: string | null;
  server_vad_speech_start_observation_sha256: string | null;
  server_vad_speech_stop_observation_sha256: string | null;
  server_vad_auto_commit_observation_sha256: string | null;
  server_vad_auto_response_observation_sha256: string | null;
  provider_tool_call_evidence_sha256: string;
  tool_result_evidence_sha256: string;
  tool_call_observed: true;
  tool_result_wire_observed: true;
  post_tool_terminal_observed: true;
  post_tool_usage_observed: true;
}>;

export type Lc4DevRetainedQualificationV3Receipt = Readonly<{
  schema_version: 4;
  protocol_id: "HACC-LC4-DEV-v1";
  qualification_protocol_id: "HACC-LC4-v1";
  qualification_runner_version: typeof LC4_QUALIFICATION_V3_RUNNER_VERSION;
  status: "passed";
  providers: readonly ["openai", "gemini", "xai"];
  source_commit: string;
  source_tree_sha256: string;
  credential_set_sha256: string;
  provider_profile_manifest_sha256: string;
  setup_configuration_matrix_sha256: string;
  qualification_trust_root_sha256: string;
  plan_sha256: string;
  plan_artifact_sha256: string;
  terminal_sha256: string;
  terminal_artifact_sha256: string;
  terminal_root_sha256: string;
  report_sha256: string;
  package_sha256: string;
  setup_qualification_artifact_sha256: string;
  budget_evidence_sha256: string;
  budget_final_head_sha256: string;
  retained_artifact_sha256: string;
  transport_qualification_scope: typeof LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE;
  transport_qualification_scope_sha256: typeof LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256;
  xai_server_vad_gate_b_binding_sha256: string;
  xai_server_vad_gate_b_binding_file_sha256: string;
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  terminal: Lc4QualificationV3TerminalArtifact;
  report: QualificationReport;
  setup_qualification: ProviderQualificationArtifact;
  package_manifest: PackageManifest;
  budget_evidence: Lc4QualificationBudgetEvidence;
  spoken_gate_evidence: readonly Lc4DevQualificationV3SpokenEvidence[];
  xai_server_vad_gate_b_binding: Lc4XaiServerVadGateBBindingArtifact;
  xai_server_vad_claims: Lc4QualificationV3TerminalArtifact["body"]["server_vad_qualification"]["claims"];
  xai_server_vad_claim_boundary: "operational_server_vad_and_exact_gateway_roundtrip_verified_exact_numeric_vad_parameters_only_when_provider_echoed";
  receipt_sha256: string;
}>;

export type Lc4DevRetainedQualificationV4Receipt = Readonly<{
  schema_version: 4;
  protocol_id: "HACC-LC4-DEV-v1";
  qualification_protocol_id: "HACC-LC4-v1";
  qualification_runner_version: typeof LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION;
  status: "passed";
  providers: readonly ["openai", "gemini", "xai"];
  source_commit: string;
  source_tree_sha256: string;
  credential_set_sha256: string;
  provider_profile_manifest_sha256: string;
  setup_configuration_matrix_sha256: string;
  qualification_trust_root_sha256: string;
  plan_sha256: string;
  plan_artifact_sha256: string;
  terminal_sha256: string;
  terminal_artifact_sha256: string;
  terminal_root_sha256: string;
  report_sha256: string;
  package_sha256: string;
  setup_qualification_artifact_sha256: string;
  budget_evidence_sha256: string;
  budget_final_head_sha256: string;
  retained_artifact_sha256: string;
  transport_qualification_scope: typeof LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE;
  transport_qualification_scope_sha256: typeof LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256;
  xai_server_vad_gate_b_binding_sha256: string;
  xai_server_vad_gate_b_binding_file_sha256: string;
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  terminal: Lc4QualificationV4TerminalArtifact;
  invocation: Readonly<{
    schema_version: 1;
    runner_version: typeof LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION;
    attempt_id: string;
    authorization_artifact_sha256: string;
    invoked_at: string;
    invocation_sha256: string;
  }>;
  package_manifest: PackageManifest;
  budget_evidence: Lc4QualificationBudgetEvidence;
  setup_qualifications: readonly ProviderQualificationArtifact[];
  spoken_gate_summaries: readonly Lc4DevRetainedRoundtripSummary[];
  spoken_gate_evidence: readonly Lc4DevQualificationV3SpokenEvidence[];
  xai_server_vad_gate_a_risk: Lc4XaiServerVadGateARiskArtifact;
  xai_server_vad_gate_b_binding: Lc4XaiServerVadGateBBindingArtifact;
  xai_server_vad_claims: Lc4QualificationV3TerminalArtifact["body"]["server_vad_qualification"]["claims"];
  xai_server_vad_claim_boundary: "operational_server_vad_and_exact_gateway_roundtrip_verified_exact_numeric_vad_parameters_only_when_provider_echoed";
  receipt_sha256: string;
}>;

export type Lc4DevRetainedQualificationReceipt = Lc4DevRetainedQualificationV3Receipt;

export type Lc4DevQualificationAdmissionReceipt =
  | Lc4DevRetainedQualificationV3Receipt
  | Lc4DevRetainedQualificationV4Receipt;

type ReceiptInput = Readonly<{
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  terminal: Lc4QualificationV3TerminalArtifact;
  report: QualificationReport;
  package_manifest: PackageManifest;
  setup_qualification: ProviderQualificationArtifact;
  budget_evidence: Lc4QualificationBudgetEvidence;
  spoken_gate_evidence: readonly Lc4DevQualificationV3SpokenEvidence[];
  xai_server_vad_gate_b_binding: Lc4XaiServerVadGateBBindingArtifact;
  qualification_trust_root_sha256: string;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function assertSignedArtifact<Body>(input: Readonly<{
  artifact: Readonly<{
    body: Body;
    authority_public_key_spki_base64: string;
    authority_public_key_fingerprint_sha256: string;
    signature_algorithm: "Ed25519";
    signature_base64: string;
    artifact_sha256: string;
  }>;
  expected_fingerprint: string;
  signing_domain: string;
  artifact_domain: string;
}>): void {
  const { artifact_sha256, ...unsigned } = input.artifact;
  if (sha256Hex(`${input.artifact_domain}${canonicalJson(unsigned)}`) !== artifact_sha256) {
    throw new Error("LC4-DEV qualification signed artifact hash mismatch");
  }
  const keyBytes = Buffer.from(input.artifact.authority_public_key_spki_base64, "base64");
  if (sha256Hex(keyBytes) !== input.artifact.authority_public_key_fingerprint_sha256
    || input.artifact.authority_public_key_fingerprint_sha256 !== input.expected_fingerprint) {
    throw new Error("LC4-DEV qualification signed artifact trust root mismatch");
  }
  let key;
  try {
    key = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    throw new Error("LC4-DEV qualification signed artifact public key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519"
    || input.artifact.signature_algorithm !== "Ed25519"
    || !verify(null, Buffer.from(`${input.signing_domain}${canonicalJson(input.artifact.body)}`), key, Buffer.from(input.artifact.signature_base64, "base64"))) {
    throw new Error("LC4-DEV qualification signed artifact signature is invalid");
  }
}

function assertReport(value: unknown): asserts value is QualificationReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LC4-DEV qualification v3 report is invalid");
  const report = value as Partial<QualificationReport>;
  if (report.schema_version !== 1
    || report.runner_version !== LC4_QUALIFICATION_V3_RUNNER_VERSION
    || report.invoked_attempts !== 1
    || report.refused_attempts !== 0
    || report.stranded_invocations !== 0
    || report.complete_attempts !== 1
    || report.partial_attempts !== 0
    || report.gate_c_qualification_gate !== false
    || report.maximum_total_usd !== 3
    || report.maximum_provider_sessions !== LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS
    || report.maximum_paid_sessions !== LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS
    || report.maximum_generation_phases !== LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES
    || report.paid_retry_allowed !== false
    || report.latest?.status !== "passed") {
    throw new Error("LC4-DEV qualification v3 report is not one completed passing no-retry attempt");
  }
}

function assertProviderOrder(
  values: readonly Readonly<{ provider: LiveStsProvider; model: string }>[],
  label: string,
  expectedOrder: readonly LiveStsProvider[] = LC4_QUALIFICATION_V3_PROVIDER_ORDER,
): void {
  if (canonicalJson(values.map(({ provider }) => provider)) !== canonicalJson(expectedOrder)) {
    throw new Error(`${label} is not in its exact producer order`);
  }
  for (const value of values) {
    if (value.model !== LC4_PROVIDER_PROFILE_MANIFEST.providers[value.provider].model) {
      throw new Error(`${label} contains a stale provider model`);
    }
  }
}

function requestedConfigurationSha256(target: ReturnType<typeof createLc4QualificationV3Targets>[number]): string {
  return sha256Hex(`harshas-amazing-call-center/provider-session-configuration/v1\n${canonicalJson({
    provider: target.provider,
    model: target.model,
    configuration: target.configuration,
  })}`);
}

function assertClosedLoopWire(
  provider: LiveStsProvider,
  wire: readonly RealtimeWireObservation[],
  usage: readonly RoundtripSanitizedUsage[],
  preToolOutputQuarantine: RoundtripPreToolOutputQuarantineEvidence | null,
): void {
  const call = wire.findIndex((entry) => entry.direction === "inbound"
    && entry.identities.callIdSha256 !== undefined
    && ["toolCall", "response.function_call_arguments.done", "response.done"].includes(entry.wireType));
  if (call < 0) throw new Error(`LC4-DEV qualification v3 ${provider} retained wire lacks a provider-authored tool call`);
  const callIdentity = wire[call]!.identities.callIdSha256;
  const result = wire.findIndex((entry, index) => index > call
    && entry.direction === "outbound"
    && entry.identities.callIdSha256 === callIdentity
    && ["toolResponse", "conversation.item.create"].includes(entry.wireType));
  if (result < 0) throw new Error(`LC4-DEV qualification v3 ${provider} retained wire lacks the matching tool result`);
  const continuation = provider === "gemini"
    ? wire.findIndex((entry, index) => index > result && entry.direction === "inbound" && entry.wireType === "serverContent")
    : wire.findIndex((entry, index) => index > result && entry.direction === "outbound" && entry.wireType === "response.create");
  if (continuation < 0) throw new Error(`LC4-DEV qualification v3 ${provider} retained wire lacks post-tool continuation`);
  const terminal = wire.findIndex((entry, index) => index > continuation
    && entry.direction === "inbound"
    && typeof entry.projection === "object"
    && entry.projection !== null
    && "terminal" in entry.projection);
  if (terminal < 0) throw new Error(`LC4-DEV qualification v3 ${provider} retained wire lacks a post-tool terminal`);
  const usageOnWire = wire.slice(terminal).some((entry) => typeof entry.projection === "object"
    && entry.projection !== null
    && "usage" in entry.projection);
  if (!lc4DevRetainedUsageMatchesProviderBoundary({
    provider,
    usage,
    terminal_observation_sha256: wire[terminal]!.observationSha256,
    provider_usage_observed_on_wire: usageOnWire,
  })) throw new Error(`LC4-DEV qualification v3 ${provider} retained evidence lacks provider-valid post-tool usage`);
  const preCallOutputObservationSha256s = wire.slice(0, call)
    .filter((entry) => entry.direction === "inbound"
      && lc4DevProjectionContainsAssistantOutput(entry.projection, entry.wireType))
    .map((entry) => entry.observationSha256);
  const replayedQuarantine = preToolOutputQuarantine === null ? null
    : projectRoundtripPreToolOutputQuarantineEvidence({
        provider,
        wire,
        response_started_observation_sha256: preToolOutputQuarantine.response_started_observation_sha256,
        terminal_observation_sha256: preToolOutputQuarantine.terminal_observation_sha256,
        response_id_sha256: preToolOutputQuarantine.response_id_sha256,
      });
  if (!lc4DevPreToolOutputIsExactlyQuarantined({
    provider,
    pre_call_output_observation_sha256s: preCallOutputObservationSha256s,
    retained_quarantine: preToolOutputQuarantine,
    replayed_quarantine: replayedQuarantine,
  })) throw new Error(`LC4-DEV qualification v3 ${provider} emitted unquarantined output before its required tool call`);
}

function expectedXaiGateAClassification(
  setup: ProviderQualificationArtifact["results"][number],
): Lc4QualificationV3TerminalArtifact["body"]["server_vad_qualification"]["gate_a_classification"] {
  if (setup.turnBoundaryVerification === "verified_by_provider_echo") return "verified_by_provider_echo";
  if (setup.code === "acknowledged_unverifiable_server_vad" || setup.code === "initial_snapshot_exact_only") {
    return "acknowledged_unverifiable_server_vad";
  }
  return "failed";
}

function expectedXaiClaims(input: Readonly<{
  setup: ProviderQualificationArtifact["results"][number];
  binding: Lc4XaiServerVadGateBBindingArtifact;
  gateAClassification: Lc4QualificationV3TerminalArtifact["body"]["server_vad_qualification"]["gate_a_classification"];
}>): Lc4QualificationV3TerminalArtifact["body"]["server_vad_qualification"]["claims"] {
  const toolEchoed = input.setup.toolSchemaVerification === "verified_by_provider_echo"
    && input.setup.configurationEvidence?.fields.tools.status === "verified";
  return freeze({
    operational_gateway: "verified" as const,
    operational_server_vad: "verified" as const,
    exact_gateway_name_and_arguments: "verified" as const,
    matching_gateway_result: "verified" as const,
    sole_post_tool_continuation_terminal_usage: "verified" as const,
    full_gateway_schema: toolEchoed ? "verified_by_provider_echo" as const : "unverifiable" as const,
    gateway_description: toolEchoed ? "verified_by_provider_echo" as const : "unverifiable" as const,
    post_update_voice: input.setup.configurationEvidence?.fields.voice.status === "verified"
      ? "verified_by_provider_echo" as const
      : "unverifiable" as const,
    input_transcription: "not_requested" as const,
    idle_timeout: "documented_default_not_independently_verified" as const,
    exact_vad_parameters: input.gateAClassification === "verified_by_provider_echo"
      ? "verified_by_provider_echo" as const
      : "unverifiable" as const,
    created_to_updated_session_identity: input.setup.setupWireEvidence?.sessionIdentity?.status ?? "unverifiable" as const,
    dynamic_update_configuration: input.binding.dynamic_update_provider_echo === "verified"
      ? "verified_by_provider_echo" as const
      : "behaviorally_verified_not_provider_echoed" as const,
  });
}

function assertXaiAdmissionBinding(input: Readonly<{
  plan: Lc4QualificationV3PlanArtifact["body"];
  terminal: Lc4QualificationV3TerminalArtifact["body"];
  setup: ProviderQualificationArtifact["results"][number];
  spoken: Lc4DevQualificationV3SpokenEvidence;
  binding: Lc4XaiServerVadGateBBindingArtifact;
}>): void {
  const { binding_sha256, ...bindingBody } = input.binding;
  const serverVad = input.terminal.server_vad_qualification;
  const target = input.plan.targets.find((candidate) => candidate.provider === "xai");
  const gateAClassification = expectedXaiGateAClassification(input.setup);
  const claims = expectedXaiClaims({ setup: input.setup, binding: input.binding, gateAClassification });
  const operationalObservationHashes = [
    input.spoken.per_turn_session_update_observation_sha256,
    input.spoken.per_turn_session_ack_observation_sha256,
    input.spoken.server_vad_speech_start_observation_sha256,
    input.spoken.server_vad_speech_stop_observation_sha256,
    input.spoken.server_vad_auto_commit_observation_sha256,
    input.spoken.server_vad_auto_response_observation_sha256,
  ];
  if (target === undefined
    || input.setup.provider !== "xai"
    || input.spoken.provider !== "xai"
    || binding_sha256 !== sha256Hex(`${XAI_GATE_B_BINDING_DOMAIN}${canonicalJson(bindingBody)}`)
    || serverVad.gate_b_binding_sha256 !== binding_sha256
    || input.binding.provider !== "xai"
    || input.binding.model !== target.model
    || input.binding.source_commit !== input.plan.source.source_commit
    || input.binding.plan_sha256 !== input.plan.plan_sha256
    || input.binding.provider_profile_manifest_sha256 !== input.plan.provider_profile_manifest_sha256
    || input.binding.production_session_payload_sha256 !== target.production_session_payload_sha256
    || input.binding.gate_b_execution_sha256 !== input.spoken.evidence_sha256
    || input.binding.transport_parity_sha256 !== target.xai_transport_parity_sha256
    || input.binding.transport_parity_sha256 !== input.spoken.transport_parity_sha256
    || input.binding.tool_frontier_sha256 !== input.spoken.tool_frontier_sha256
    || input.binding.per_turn_session_update_observation_sha256 !== input.spoken.per_turn_session_update_observation_sha256
    || input.binding.per_turn_session_ack_observation_sha256 !== input.spoken.per_turn_session_ack_observation_sha256
    || input.binding.exact_gateway_call_evidence_sha256 !== input.spoken.provider_tool_call_evidence_sha256
    || input.binding.matching_gateway_result_evidence_sha256 !== input.spoken.tool_result_evidence_sha256
    || input.binding.public_execution_sha256 !== input.spoken.public_execution_sha256
    || input.binding.replay_sha256 !== input.spoken.replay_sha256
    || input.binding.connection_epoch !== serverVad.gate_b_connection_epoch
    || input.binding.ordered_vad_verified !== true
    || input.binding.exact_gateway_call_verified !== true
    || input.binding.matching_gateway_result_verified !== true
    || input.binding.sole_continuation_terminal_usage_verified !== true
    || input.spoken.turn_boundary_mode !== "provider_native_server_vad"
    || input.spoken.server_vad_setting_sha256 !== LC4_XAI_SERVER_VAD_SETTING_SHA256
    || input.spoken.caller_audio_sha256 !== target.caller_audio_sha256
    || input.spoken.delivery_profile_sha256 !== target.audio_delivery_profile_sha256
    || input.spoken.input_audio_evidence.audio_sha256 !== target.caller_audio_sha256
    || input.spoken.input_audio_evidence.delivery_profile_sha256 !== target.audio_delivery_profile_sha256
    || input.spoken.input_audio_evidence.audio_bytes !== target.caller_audio_bytes
    || input.spoken.input_audio_evidence.observation_sha256s.length === 0
    || input.spoken.output_audio_evidence.audio_bytes <= 0
    || input.spoken.output_audio_evidence.observation_sha256s.length === 0
    || operationalObservationHashes.some((digest) => digest === null || !HASH.test(digest))
    || new Set(operationalObservationHashes).size !== operationalObservationHashes.length
    || gateAClassification === "failed"
    || serverVad.gate_a_classification !== gateAClassification
    || serverVad.gate_b_status !== "behaviorally_verified"
    || serverVad.gate_b_evidence_sha256 !== input.spoken.evidence_sha256
    || serverVad.operational_vad_verified !== true
    || serverVad.exact_setting_verified !== (gateAClassification === "verified_by_provider_echo")
    || serverVad.benchmark_ready !== true
    || canonicalJson(serverVad.claims) !== canonicalJson(claims)) {
    throw new Error("LC4-DEV qualification v3 xAI Gate B binding or machine claim boundary failed integrity");
  }
}

export function createLc4DevRetainedQualificationReceipt(input: ReceiptInput): Lc4DevRetainedQualificationV3Receipt {
  requireHash(input.qualification_trust_root_sha256, "LC4-DEV qualification trust root");
  assertLc4QualificationV3PlanArtifact(input.plan, input.qualification_trust_root_sha256);
  assertSignedArtifact({
    artifact: input.plan,
    expected_fingerprint: input.qualification_trust_root_sha256,
    signing_domain: PLAN_SIGNING_DOMAIN,
    artifact_domain: PLAN_ARTIFACT_DOMAIN,
  });
  assertSignedArtifact({
    artifact: input.authorization,
    expected_fingerprint: input.qualification_trust_root_sha256,
    signing_domain: AUTHORIZATION_SIGNING_DOMAIN,
    artifact_domain: AUTHORIZATION_ARTIFACT_DOMAIN,
  });
  assertSignedArtifact({
    artifact: input.terminal,
    expected_fingerprint: input.authorization.body.terminal_public_key_fingerprint_sha256,
    signing_domain: TERMINAL_SIGNING_DOMAIN,
    artifact_domain: TERMINAL_ARTIFACT_DOMAIN,
  });
  assertReport(input.report);
  assertProviderQualificationArtifactIntegrity(input.setup_qualification);
  assertLc4QualificationBudgetEvidence(input.budget_evidence);

  const plan = input.plan.body;
  const terminal = input.terminal.body;
  const expectedTargets = createLc4QualificationV3Targets();
  assertProviderOrder(plan.targets, "LC4-DEV qualification v3 plan targets");
  assertProviderOrder(terminal.results, "LC4-DEV qualification v3 terminal results");
  // The setup qualification artifact has its own deterministic lexical
  // provider ordering; the qv3 plan/terminal/spoken artifacts use execution
  // order. Preserve both producer contracts instead of conflating them.
  assertProviderOrder(
    input.setup_qualification.results,
    "LC4-DEV qualification v3 Gate A results",
    Object.freeze([...LC4_QUALIFICATION_V3_PROVIDER_ORDER].sort()),
  );
  assertProviderOrder(input.spoken_gate_evidence, "LC4-DEV qualification v3 Gate B results");
  const credentialSetFromPlan = sha256Hex(`harshas-amazing-call-center/provider-credential-set/v1\n${canonicalJson(plan.credential_identities)}`);
  const setupCredentialSetFromPlan = sha256Hex(`harshas-amazing-call-center/provider-credential-set/v1\n${canonicalJson(
    plan.credential_identities.map(({ provider, credential_sha256 }) => ({
      provider,
      credentialSha256: credential_sha256,
    })),
  )}`);

  if (plan.protocol_id !== "HACC-LC4-v1"
    || plan.provider_profile_manifest_sha256 !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256
    || credentialSetFromPlan !== plan.credential_set_sha256
    || plan.setup_configuration_matrix_sha256 !== providerQualificationMatrixSha256(expectedTargets)
    || input.setup_qualification.planSha256 !== plan.plan_sha256
    || input.setup_qualification.sourceCommit !== plan.source.source_commit
    || input.setup_qualification.configurationMatrixSha256 !== plan.setup_configuration_matrix_sha256
    // The setup qualifier commits the same per-provider credential digests
    // using its camelCase producer schema. Recompute that exact schema from
    // the signed plan instead of comparing two differently shaped set hashes.
    || input.setup_qualification.credentialSetSha256 !== setupCredentialSetFromPlan
    || input.setup_qualification.artifactSha256 !== terminal.setup_qualification_artifact_sha256
    || input.setup_qualification.results.length !== 3
    || input.setup_qualification.results.some((result) => result.status !== "passed")
    || input.report.plan_artifact_sha256 !== input.plan.artifact_sha256
    || input.report.source_commit !== plan.source.source_commit
    || canonicalJson(input.report.latest) !== canonicalJson(terminal)
    || terminal.plan_artifact_sha256 !== input.plan.artifact_sha256
    || terminal.plan_sha256 !== plan.plan_sha256
    || terminal.authorization_artifact_sha256 !== input.authorization.artifact_sha256
    || input.authorization.body.schema_version !== 1
    || input.authorization.body.authorization_version !== LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION
    || input.authorization.body.plan_artifact_sha256 !== input.plan.artifact_sha256
    || input.authorization.body.plan_sha256 !== plan.plan_sha256
    || input.authorization.body.source_commit !== plan.source.source_commit
    || input.authorization.body.source_tree_sha256 !== plan.source.source_tree_sha256
    || input.authorization.body.credential_set_sha256 !== plan.credential_set_sha256
    || sha256Hex(Buffer.from(input.authorization.body.terminal_public_key_spki_base64, "base64")) !== input.authorization.body.terminal_public_key_fingerprint_sha256
    || input.authorization.body.maximum_provider_sessions !== LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS
    || input.authorization.body.maximum_total_micro_usd !== plan.maximum_total_micro_usd
    || input.authorization.body.maximum_paid_sessions !== LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS
    || input.authorization.body.maximum_generation_phases !== LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES
    || input.authorization.body.maximum_tool_roundtrips !== LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS
    || input.authorization.body.paid_retry_allowed !== false
    || terminal.source_commit !== plan.source.source_commit
    || terminal.source_tree_sha256 !== plan.source.source_tree_sha256
    || terminal.primary_failure_class !== null
    || terminal.provider_sessions_opened !== LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS
    || terminal.paid_sessions_opened !== LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS
    || terminal.generation_phases_attempted !== LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES
    || terminal.tool_roundtrips_attempted !== LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS
    || terminal.caller_audio_bytes !== plan.targets.reduce((total, target) => total + target.caller_audio_bytes, 0)
    || terminal.paid_retries_attempted !== 0
    || terminal.results.length !== 3
    || terminal.results.some((result) => result.status !== "passed" || result.failure_class !== "none")
    || terminal.roundtrip_evidence_sha256.length !== 3
    || input.spoken_gate_evidence.length !== 3
    || input.budget_evidence.terminal_outcome !== "completed"
    || input.budget_evidence.evidence_sha256 !== terminal.budget_evidence_sha256
    || input.budget_evidence.final_head_sha256 !== terminal.budget_final_head_sha256
    || input.package_manifest.body.bindings.plan_artifact_sha256 !== input.plan.artifact_sha256
    || input.package_manifest.body.bindings.authorization_artifact_sha256 !== input.authorization.artifact_sha256
    || input.package_manifest.body.terminal_artifact_sha256 !== input.terminal.artifact_sha256
    || input.package_manifest.body.bindings.budget_evidence_sha256 !== input.budget_evidence.evidence_sha256
    || input.package_manifest.body.payload_root_sha256 !== terminal.payload_root_sha256
    || canonicalJson(input.package_manifest.body.bindings) !== canonicalJson(terminal.package_bindings)) {
    throw new Error("LC4-DEV qualification v3 plan, Gate A, Gate B, budget, report, and terminal bindings are not exact");
  }
  if (input.package_manifest.body.schema_version !== 1
    || input.package_manifest.body.envelope_version !== "HACC-LC4-QUALIFICATION-PACKAGE-ENVELOPE-v5"
    || input.package_manifest.body.self_excluded !== true
    || !HASH.test(input.package_manifest.artifact_sha256)
    || input.package_manifest.body.entries.some((entry) => entry.path.includes("/") || !HASH.test(entry.sha256))) {
    throw new Error("LC4-DEV qualification v3 retained package manifest is invalid");
  }
  const entries = new Map(input.package_manifest.body.entries.map((entry) => [entry.path, entry]));
  for (const evidence of input.spoken_gate_evidence) {
    for (const [path, digest] of [
      [`${evidence.provider}-spoken-roundtrip.json`, evidence.summary_file_sha256],
      [`${evidence.provider}-spoken-roundtrip-wire.jsonl`, evidence.wire_file_sha256],
      [`${evidence.provider}-spoken-roundtrip-usage.jsonl`, evidence.usage_file_sha256],
    ] as const) {
      if (entries.get(path)?.sha256 !== digest) {
        throw new Error(`LC4-DEV qualification v3 ${evidence.provider} retained Gate B file is not package-bound`);
      }
    }
  }
  if (entries.get("setup-acceptance.json")?.sha256 !== sha256Hex(`${canonicalJson(input.setup_qualification)}\n`)
    || entries.get("budget-settlement.json")?.sha256 !== sha256Hex(`${canonicalJson(input.budget_evidence)}\n`)
    || entries.get("terminal.json")?.sha256 !== sha256Hex(`${canonicalJson(input.terminal)}\n`)
    || entries.get("authorization.json")?.sha256 !== sha256Hex(`${canonicalJson(input.authorization)}\n`)
    || entries.get("xai-server-vad-gate-b-binding.json")?.sha256 !== sha256Hex(
      `${canonicalJson(input.xai_server_vad_gate_b_binding)}\n`,
    )) {
    throw new Error("LC4-DEV qualification v3 package omits a required admission artifact");
  }

  for (const [index, provider] of LC4_QUALIFICATION_V3_PROVIDER_ORDER.entries()) {
    const target = plan.targets[index]!;
    const expected = expectedTargets[index]!;
    const setup = input.setup_qualification.results.find((candidate) => candidate.provider === provider);
    const spoken = input.spoken_gate_evidence[index]!;
    const result = terminal.results[index]!;
    if (setup === undefined
      || target.provider !== provider
      || target.model !== expected.model
      || target.sample_rate_hz !== expected.configuration.inputAudioFormat.sampleRateHz
      || setup.provider !== provider
      || setup.model !== target.model
      || setup.requestedConfigurationSha256 !== requestedConfigurationSha256(expected)
      || spoken.provider !== provider
      || spoken.model !== target.model
      || spoken.evidence_sha256 !== terminal.roundtrip_evidence_sha256[index]
      || spoken.public_execution_sha256 !== terminal.roundtrip_public_execution_sha256[index]
      || spoken.replay_sha256 !== terminal.roundtrip_replay_sha256[index]
      || spoken.evidence_sha256 !== result.evidence_sha256
      || spoken.caller_audio_bytes !== target.caller_audio_bytes
      || spoken.caller_audio_sha256 !== target.caller_audio_sha256
      || spoken.delivery_profile_sha256 !== target.audio_delivery_profile_sha256
      || spoken.turn_boundary_mode !== target.qualification_turn_boundary
      || spoken.input_audio_evidence.audio_sha256 !== target.caller_audio_sha256
      || spoken.output_audio_evidence.audio_bytes <= 0
      || result.caller_audio_bytes !== target.caller_audio_bytes
      || result.wire_observation_count !== spoken.wire_observation_count
      || result.usage_event_count !== spoken.usage_event_count
      || !spoken.tool_call_observed
      || !spoken.tool_result_wire_observed
      || !spoken.post_tool_terminal_observed
      || !spoken.post_tool_usage_observed) {
      throw new Error(`LC4-DEV qualification v3 ${provider} Gate A/Gate B evidence differs from its plan`);
    }
  }

  const xai = terminal.server_vad_qualification;
  const xaiResult = terminal.results[2]!;
  const xaiSetup = input.setup_qualification.results.find((result) => result.provider === "xai");
  if (xaiSetup === undefined) throw new Error("LC4-DEV qualification v3 lacks xAI Gate A evidence");
  const expectedXaiGateA = expectedXaiGateAClassification(xaiSetup);
  if (xai.provider !== "xai"
    || xai.requested_setting_sha256 !== LC4_XAI_SERVER_VAD_SETTING_SHA256
    || xai.gate_a_classification === "failed"
    || xai.gate_a_classification !== expectedXaiGateA
    || xai.gate_b_required !== true
    || xai.gate_b_status !== "behaviorally_verified"
    || xai.gate_b_evidence_sha256 !== xaiResult.evidence_sha256
    || xai.benchmark_ready !== true) {
    throw new Error("LC4-DEV qualification v3 lacks promoted xAI server-VAD Gate A/Gate B evidence");
  }
  assertXaiAdmissionBinding({
    plan,
    terminal,
    setup: xaiSetup,
    spoken: input.spoken_gate_evidence[2]!,
    binding: input.xai_server_vad_gate_b_binding,
  });

  const reportSha256 = sha256Hex(`${REPORT_DOMAIN}${canonicalJson(input.report)}`);
  const xaiBindingFileSha256 = sha256Hex(`${canonicalJson(input.xai_server_vad_gate_b_binding)}\n`);
  const retainedBody = freeze({
    plan_artifact_sha256: input.plan.artifact_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    terminal_artifact_sha256: input.terminal.artifact_sha256,
    report_sha256: reportSha256,
    package_sha256: input.package_manifest.artifact_sha256,
    setup_qualification_artifact_sha256: input.setup_qualification.artifactSha256,
    budget_evidence_sha256: input.budget_evidence.evidence_sha256,
    xai_server_vad_gate_b_binding_sha256: input.xai_server_vad_gate_b_binding.binding_sha256,
    xai_server_vad_gate_b_binding_file_sha256: xaiBindingFileSha256,
    transport_qualification_scope: LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE,
    transport_qualification_scope_sha256: LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
    spoken_gate_evidence: input.spoken_gate_evidence,
  });
  const retainedArtifactSha256 = sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(retainedBody)}`);
  const body = freeze({
    schema_version: 4 as const,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    qualification_protocol_id: "HACC-LC4-v1" as const,
    qualification_runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    status: "passed" as const,
    providers: LC4_QUALIFICATION_V3_PROVIDER_ORDER,
    source_commit: plan.source.source_commit,
    source_tree_sha256: plan.source.source_tree_sha256,
    credential_set_sha256: plan.credential_set_sha256,
    provider_profile_manifest_sha256: plan.provider_profile_manifest_sha256,
    setup_configuration_matrix_sha256: plan.setup_configuration_matrix_sha256,
    qualification_trust_root_sha256: input.qualification_trust_root_sha256,
    plan_sha256: plan.plan_sha256,
    plan_artifact_sha256: input.plan.artifact_sha256,
    terminal_sha256: terminal.terminal_sha256,
    terminal_artifact_sha256: input.terminal.artifact_sha256,
    terminal_root_sha256: input.terminal.artifact_sha256,
    report_sha256: reportSha256,
    package_sha256: input.package_manifest.artifact_sha256,
    setup_qualification_artifact_sha256: input.setup_qualification.artifactSha256,
    budget_evidence_sha256: input.budget_evidence.evidence_sha256,
    budget_final_head_sha256: input.budget_evidence.final_head_sha256,
    retained_artifact_sha256: retainedArtifactSha256,
    transport_qualification_scope: LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE,
    transport_qualification_scope_sha256: LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
    xai_server_vad_gate_b_binding_sha256: input.xai_server_vad_gate_b_binding.binding_sha256,
    xai_server_vad_gate_b_binding_file_sha256: xaiBindingFileSha256,
    plan: input.plan,
    authorization: input.authorization,
    terminal: input.terminal,
    report: input.report,
    setup_qualification: input.setup_qualification,
    package_manifest: input.package_manifest,
    budget_evidence: input.budget_evidence,
    spoken_gate_evidence: freeze([...input.spoken_gate_evidence]),
    xai_server_vad_gate_b_binding: input.xai_server_vad_gate_b_binding,
    xai_server_vad_claims: terminal.server_vad_qualification.claims,
    xai_server_vad_claim_boundary: "operational_server_vad_and_exact_gateway_roundtrip_verified_exact_numeric_vad_parameters_only_when_provider_echoed" as const,
  });
  return freeze({ ...body, receipt_sha256: sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(body)}`) });
}

function assertLc4DevRetainedQualificationV3Receipt(receipt: Lc4DevRetainedQualificationV3Receipt): void {
  if (receipt.schema_version !== 4
    || receipt.qualification_runner_version !== LC4_QUALIFICATION_V3_RUNNER_VERSION) {
    throw new Error("LC4-DEV retained qualification v3 receipt uses a stale schema");
  }
  const { receipt_sha256, ...body } = receipt;
  if (sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(body)}`) !== receipt_sha256) {
    throw new Error("LC4-DEV retained qualification v3 receipt hash mismatch");
  }
  const rebuilt = createLc4DevRetainedQualificationReceipt({
    plan: receipt.plan,
    authorization: receipt.authorization,
    terminal: receipt.terminal,
    report: receipt.report,
    package_manifest: receipt.package_manifest,
    setup_qualification: receipt.setup_qualification,
    budget_evidence: receipt.budget_evidence,
    spoken_gate_evidence: receipt.spoken_gate_evidence,
    xai_server_vad_gate_b_binding: receipt.xai_server_vad_gate_b_binding,
    qualification_trust_root_sha256: receipt.qualification_trust_root_sha256,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(receipt)) {
    throw new Error("LC4-DEV retained qualification v3 receipt is not canonical");
  }
}

async function readBoundedJson<T>(path: string, maximum = MAX_JSON_BYTES): Promise<T> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 2 || metadata.size > maximum) {
    throw new Error("LC4-DEV qualification v3 retained JSON is not a bounded regular file");
  }
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function loadLc4DevXaiServerVadGateBBinding(input: Readonly<{
  path: string;
  expected_binding_sha256: string;
}>): Promise<Lc4XaiServerVadGateBBindingArtifact> {
  requireHash(input.expected_binding_sha256, "LC4-DEV xAI Gate B binding");
  const artifact = await readBoundedJson<Lc4XaiServerVadGateBBindingArtifact>(resolve(input.path));
  const { binding_sha256, ...body } = artifact;
  if (artifact.schema_version !== 1
    || artifact.provider !== "xai"
    || binding_sha256 !== input.expected_binding_sha256
    || binding_sha256 !== sha256Hex(`${XAI_GATE_B_BINDING_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("LC4-DEV xAI Gate B binding artifact hash mismatch");
  }
  return freeze(artifact);
}

async function readJsonLines<T>(path: string): Promise<readonly T[]> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_JSONL_BYTES) {
    throw new Error("LC4-DEV qualification v3 retained JSONL is not a bounded regular file");
  }
  const text = await readFile(path, "utf8");
  if (text && !text.endsWith("\n")) throw new Error("LC4-DEV qualification v3 retained JSONL is not newline terminated");
  return freeze(text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T));
}

export async function loadLc4DevRetainedQualificationV3(input: Readonly<{
  root: string;
  qualification_trust_root_sha256: string;
  now?: Date;
}>): Promise<Lc4DevRetainedQualificationV3Receipt> {
  const root = resolve(input.root);
  requireHash(input.qualification_trust_root_sha256, "LC4-DEV qualification trust root");
  const names = await readdir(root);
  if (!names.includes("lc4-qualification-v3-plan.json")) {
    if (names.includes("lc4-qualification-plan.json")) {
      throw new Error("LC4-DEV refuses legacy qualification v2; current server-VAD admission requires qualification v3");
    }
    throw new Error("LC4-DEV qualification v3 plan is missing");
  }
  const plan = await readBoundedJson<Lc4QualificationV3PlanArtifact>(resolve(root, "lc4-qualification-v3-plan.json"));
  assertLc4QualificationV3PlanArtifact(plan, input.qualification_trust_root_sha256);
  const reportValue = await reportLc4QualificationV3({ root, trustRootFingerprint: input.qualification_trust_root_sha256 });
  assertReport(reportValue);
  const now = input.now ?? new Date();
  const completedAt = Date.parse(reportValue.latest.completed_at);
  if (!Number.isFinite(completedAt)
    || completedAt > now.getTime() + 120_000
    || now.getTime() - completedAt > PROVIDER_QUALIFICATION_MAX_AGE_MS) {
    throw new Error("LC4-DEV qualification v3 passing terminal is stale or future-dated");
  }
  const attemptsRoot = resolve(root, "attempts");
  const complete = (await readdir(attemptsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".complete"));
  if (complete.length !== 1) throw new Error("LC4-DEV qualification v3 must retain exactly one completed attempt");
  const directory = resolve(attemptsRoot, complete[0]!.name);
  const [authorization, terminal, retainedPackage, setup, budget] = await Promise.all([
    readBoundedJson<Lc4QualificationV3AuthorizationArtifact>(resolve(directory, "authorization.json")),
    readBoundedJson<Lc4QualificationV3TerminalArtifact>(resolve(directory, "terminal.json")),
    readLc4QualificationPackageDirectoryV5({
      directory,
      envelopePath: "qualification-package-envelope.json",
    }),
    readBoundedJson<ProviderQualificationArtifact>(resolve(directory, "setup-acceptance.json")),
    readBoundedJson<Lc4QualificationBudgetEvidence>(resolve(directory, "budget-settlement.json")),
  ]);
  if (terminal.body.server_vad_qualification.gate_b_binding_sha256 === null) {
    throw new Error("LC4-DEV qualification v3 terminal omits the xAI Gate B binding");
  }
  const xaiGateBBinding = await loadLc4DevXaiServerVadGateBBinding({
    path: resolve(directory, "xai-server-vad-gate-b-binding.json"),
    expected_binding_sha256: terminal.body.server_vad_qualification.gate_b_binding_sha256,
  });
  const manifest = await verifySignedLc4QualificationPackageEnvelopeV5({
    envelope: retainedPackage.envelope,
    files: retainedPackage.files,
    expectedAuthorityFingerprintSha256: authorization.body.terminal_public_key_fingerprint_sha256,
    verifyTerminal: (bytes): Lc4QualificationTerminalClaimsV5 => {
      const retained = JSON.parse(Buffer.from(bytes).toString("utf8")) as Lc4QualificationV3TerminalArtifact;
      assertSignedArtifact({
        artifact: retained,
        expected_fingerprint: authorization.body.terminal_public_key_fingerprint_sha256,
        signing_domain: TERMINAL_SIGNING_DOMAIN,
        artifact_domain: TERMINAL_ARTIFACT_DOMAIN,
      });
      if (canonicalJson(retained) !== canonicalJson(terminal)) {
        throw new Error("LC4-DEV qualification package terminal differs from retained terminal");
      }
      return freeze({
        terminal_artifact_sha256: retained.artifact_sha256,
        payload_root_sha256: retained.body.payload_root_sha256,
        bindings: retained.body.package_bindings,
      });
    },
  });
  const spoken: Lc4DevQualificationV3SpokenEvidence[] = [];
  const retainedUsage: RoundtripSanitizedUsage[] = [];
  for (const provider of LC4_QUALIFICATION_V3_PROVIDER_ORDER) {
    const summaryPath = resolve(directory, `${provider}-spoken-roundtrip.json`);
    const wirePath = resolve(directory, `${provider}-spoken-roundtrip-wire.jsonl`);
    const usagePath = resolve(directory, `${provider}-spoken-roundtrip-usage.jsonl`);
    const [summaryBytes, wireBytes, usageBytes, summary, wire, usage] = await Promise.all([
      readFile(summaryPath), readFile(wirePath), readFile(usagePath),
      readBoundedJson<RetainedRoundtripSummary>(summaryPath),
      readJsonLines<RealtimeWireObservation>(wirePath),
      readJsonLines<RoundtripSanitizedUsage>(usagePath),
    ]);
    const { wire_observation_count, usage_event_count } = summary;
    assertLc4DevRetainedRoundtripLogCardinality({
      provider,
      summary_wire_observation_count: wire_observation_count,
      summary_raw_usage_event_count: usage_event_count,
      retained_wire_observation_count: wire.length,
      retained_sanitized_usage_event_count: usage.length,
    });
    if (summary.provider !== provider
      || summary.status !== "passed"
      || summary.failure_class !== "none"
      || summary.delivery === null
      || !summary.tool_call_observed
      || !summary.tool_result_submitted
      || !summary.tool_result_event_observed
      || !summary.tool_result_wire_observed
      || !summary.post_tool_continuation_requested
      || !summary.post_tool_continuation_observed
      || !summary.post_tool_terminal_observed
      || !summary.post_tool_usage_observed
      || summary.provider_tool_call_evidence_sha256 === null
      || summary.tool_result_evidence_sha256 === null
      || summary.input_audio_evidence === null
      || summary.output_audio_evidence === null
      || !verifyRealtimeWireObservationChain(wire).valid) {
      throw new Error(`LC4-DEV qualification v3 ${provider} spoken Gate B did not pass`);
    }
    assertClosedLoopWire(provider, wire, usage, summary.pre_tool_output_quarantine);
    if (summary.replay_summary === null || summary.replay_causal_binding === null) {
      throw new Error(`LC4-DEV qualification v3 ${provider} lacks replay-complete causal evidence`);
    }
    const replay = replayProviderToolRoundtrip({
      expected: { provider, model: summary.model },
      summary: summary.replay_summary,
      wire_observations: wire,
      sanitized_usage: usage,
      causal_binding: summary.replay_causal_binding,
    });
    if (!replay.valid
      || replay.public_execution_sha256 !== summary.public_execution_sha256
      || replay.replay_sha256 !== summary.replay_sha256) {
      throw new Error(`LC4-DEV qualification v3 ${provider} retained replay failed integrity`);
    }
    retainedUsage.push(...usage);
    spoken.push(freeze({
      provider,
      model: summary.model,
      evidence_sha256: summary.evidence_sha256,
      public_execution_sha256: summary.public_execution_sha256!,
      replay_sha256: summary.replay_sha256!,
      summary_file_sha256: sha256Hex(summaryBytes),
      wire_file_sha256: sha256Hex(wireBytes),
      usage_file_sha256: sha256Hex(usageBytes),
      wire_observation_count,
      usage_event_count,
      caller_audio_bytes: summary.delivery.audio_bytes,
      caller_audio_sha256: summary.delivery.audio_sha256,
      delivery_profile_sha256: summary.delivery.delivery_profile_sha256,
      input_audio_evidence: summary.input_audio_evidence,
      output_audio_evidence: summary.output_audio_evidence,
      turn_boundary_mode: summary.turn_boundary_mode,
      server_vad_setting_sha256: summary.server_vad_setting_sha256,
      transport_parity_sha256: summary.transport_parity_sha256,
      tool_frontier_sha256: summary.tool_frontier_sha256,
      per_turn_session_update_observation_sha256: summary.per_turn_session_update_observation_sha256,
      per_turn_session_ack_observation_sha256: summary.per_turn_session_ack_observation_sha256,
      server_vad_speech_start_observation_sha256: summary.server_vad_speech_start_observation_sha256,
      server_vad_speech_stop_observation_sha256: summary.server_vad_speech_stop_observation_sha256,
      server_vad_auto_commit_observation_sha256: summary.server_vad_auto_commit_observation_sha256,
      server_vad_auto_response_observation_sha256: summary.server_vad_auto_response_observation_sha256,
      provider_tool_call_evidence_sha256: summary.provider_tool_call_evidence_sha256,
      tool_result_evidence_sha256: summary.tool_result_evidence_sha256,
      tool_call_observed: true,
      tool_result_wire_observed: true,
      post_tool_terminal_observed: true,
      post_tool_usage_observed: true,
    }));
  }
  if (budget.usage_event_count !== retainedUsage.length
    || budget.usage_evidence_sha256 !== sha256Hex(canonicalJson(retainedUsage))) {
    throw new Error("LC4-DEV qualification v3 retained usage differs from budget settlement");
  }
  return createLc4DevRetainedQualificationReceipt({
    plan,
    authorization,
    terminal,
    report: reportValue,
    package_manifest: manifest,
    setup_qualification: setup,
    budget_evidence: budget,
    spoken_gate_evidence: spoken,
    xai_server_vad_gate_b_binding: xaiGateBBinding,
    qualification_trust_root_sha256: input.qualification_trust_root_sha256,
  });
}

function v4BudgetBinding(
  plan: Lc4QualificationV3PlanArtifact,
  authorization: Lc4QualificationV3AuthorizationArtifact,
): Lc4QualificationBudgetBinding {
  return freeze({
    attemptId: authorization.body.authorization_id,
    authorizationId: authorization.body.authorization_id,
    authorizationArtifactSha256: authorization.artifact_sha256,
    planSha256: plan.body.plan_sha256,
    sourceCommit: plan.body.source.source_commit,
    sourceTreeSha256: plan.body.source.source_tree_sha256,
    credentialSetSha256: plan.body.credential_set_sha256,
    providerProfileManifestSha256: plan.body.provider_profile_manifest_sha256,
    configurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
    devConfigurationMatrixSha256: plan.body.paid_configuration_matrix_sha256,
    providersModels: freeze(Object.fromEntries(plan.body.targets.map((target) => [target.provider, target.model])) as Record<LiveStsProvider, string>),
    expiresAt: authorization.body.expires_at,
  });
}

function v4ConfigurationSha256(target: ProviderQualificationTarget): string {
  return sha256Hex(`harshas-amazing-call-center/provider-session-configuration/v1\n${canonicalJson({
    provider: target.provider,
    model: target.model,
    configuration: target.configuration,
  })}`);
}

function packageFilesByPath(files: readonly { path: string; bytes: Uint8Array }[]) {
  return new Map(files.map((file) => [file.path, file]));
}

function parsePackageJson<T>(files: Map<string, { path: string; bytes: Uint8Array }>, path: string): T {
  const file = files.get(path);
  if (!file) throw new Error(`LC4-DEV qualification v4 package is missing ${path}`);
  return JSON.parse(Buffer.from(file.bytes).toString("utf8")) as T;
}

function expectedV4PackagePaths(): readonly string[] {
  const paths = [
    "plan.json", "authorization.json", "budget-settlement.json", "v4-manifest.json",
    "v4-aggregate.json", "v4-invocation.json", "terminal.json",
    "xai-server-vad-gate-a-risk.json", "xai-server-vad-gate-b-binding.json",
  ];
  for (const [index, provider] of LC4_QUALIFICATION_V3_PROVIDER_ORDER.entries()) {
    const prefix = `${String(index).padStart(2, "0")}-${provider}`;
    paths.push(
      `${prefix}-reservation.json`, `${prefix}-setup-admission.json`, `${prefix}-setup-terminal.json`,
      `${prefix}-paid-admission.json`, `${prefix}-paid-terminal.json`, `${prefix}-shard-terminal.json`,
      `${prefix}-setup-qualification.json`, `${prefix}-spoken-roundtrip.json`,
      `${prefix}-spoken-roundtrip-wire.jsonl`, `${prefix}-spoken-roundtrip-usage.jsonl`,
    );
  }
  return freeze(paths.sort());
}

function assertV4GateBBinding(input: Readonly<{
  binding: Lc4XaiServerVadGateBBindingArtifact;
  risk: Lc4XaiServerVadGateARiskArtifact;
  spoken: Lc4DevQualificationV3SpokenEvidence;
  plan: Lc4QualificationV3PlanArtifact;
}>): void {
  const { binding_sha256, ...body } = input.binding;
  if (binding_sha256 !== sha256Hex(`${XAI_GATE_B_BINDING_DOMAIN}${canonicalJson(body)}`)
    || input.binding.provider !== "xai"
    || input.binding.model !== input.spoken.model
    || input.binding.source_commit !== input.plan.body.source.source_commit
    || input.binding.plan_sha256 !== input.plan.body.plan_sha256
    || input.binding.provider_profile_manifest_sha256 !== input.plan.body.provider_profile_manifest_sha256
    || input.binding.gate_a_risk_sha256 !== input.risk.risk_sha256
    || input.binding.production_session_payload_sha256 !== input.risk.production_session_payload_sha256
    || input.binding.gate_b_execution_sha256 !== input.spoken.evidence_sha256
    || input.binding.public_execution_sha256 !== input.spoken.public_execution_sha256
    || input.binding.replay_sha256 !== input.spoken.replay_sha256
    || input.binding.tool_frontier_sha256 !== input.spoken.tool_frontier_sha256
    || input.binding.per_turn_session_update_observation_sha256 !== input.spoken.per_turn_session_update_observation_sha256
    || input.binding.per_turn_session_ack_observation_sha256 !== input.spoken.per_turn_session_ack_observation_sha256
    || input.binding.transport_parity_sha256 !== input.spoken.transport_parity_sha256
    || input.binding.exact_gateway_call_evidence_sha256 !== input.spoken.provider_tool_call_evidence_sha256
    || input.binding.matching_gateway_result_evidence_sha256 !== input.spoken.tool_result_evidence_sha256
    || input.binding.caller_audio_sha256 !== input.spoken.caller_audio_sha256
    || input.binding.caller_audio_bytes !== input.spoken.caller_audio_bytes
    || input.binding.server_vad_silence_tail_policy_sha256
      !== input.spoken.input_audio_evidence.transport_suffix?.policy_sha256
    || input.binding.server_vad_silence_tail_pcm_sha256
      !== input.spoken.input_audio_evidence.transport_suffix?.pcm_sha256
    || input.binding.server_vad_silence_tail_bytes
      !== input.spoken.input_audio_evidence.transport_suffix?.audio_bytes
    || input.binding.ordered_vad_verified !== true
    || input.binding.exact_gateway_call_verified !== true
    || input.binding.matching_gateway_result_verified !== true
    || input.binding.sole_continuation_terminal_usage_verified !== true) {
    throw new Error("LC4-DEV qualification v4 xAI Gate B binding differs from retained replay");
  }
}

function v4XaiServerVadClaims(
  xaiSetup: ProviderQualificationArtifact["results"][number],
  gateARisk: Lc4XaiServerVadGateARiskArtifact,
  gateB: Lc4XaiServerVadGateBBindingArtifact,
): Lc4DevRetainedQualificationV4Receipt["xai_server_vad_claims"] {
  return freeze({
    operational_gateway: "verified", operational_server_vad: "verified",
    exact_gateway_name_and_arguments: "verified", matching_gateway_result: "verified",
    sole_post_tool_continuation_terminal_usage: "verified",
    full_gateway_schema: xaiSetup.toolSchemaVerification === "verified_by_provider_echo" ? "verified_by_provider_echo" : "unverifiable",
    gateway_description: xaiSetup.toolSchemaVerification === "verified_by_provider_echo" ? "verified_by_provider_echo" : "unverifiable",
    post_update_voice: xaiSetup.configurationEvidence?.fields.voice.status === "verified" ? "verified_by_provider_echo" : "unverifiable",
    input_transcription: "not_requested", idle_timeout: "documented_default_not_independently_verified",
    exact_vad_parameters: xaiSetup.turnBoundaryVerification === "verified_by_provider_echo" ? "verified_by_provider_echo" : "unverifiable",
    created_to_updated_session_identity: gateARisk.created_to_updated_session_identity,
    dynamic_update_configuration: gateB.dynamic_update_provider_echo === "verified" ? "verified_by_provider_echo" : "behaviorally_verified_not_provider_echoed",
  });
}

function v4SpokenEvidence(
  summary: Lc4DevRetainedRoundtripSummary,
  summaryFileSha256: string,
  wireFileSha256: string,
  usageFileSha256: string,
): Lc4DevQualificationV3SpokenEvidence {
  if (summary.delivery === null
    || summary.input_audio_evidence === null
    || summary.output_audio_evidence === null
    || summary.public_execution_sha256 === null
    || summary.replay_sha256 === null
    || summary.provider_tool_call_evidence_sha256 === null
    || summary.tool_result_evidence_sha256 === null) {
    throw new Error("LC4-DEV qualification v4 passing summary lacks required spoken evidence");
  }
  return freeze({
    provider: summary.provider, model: summary.model, evidence_sha256: summary.evidence_sha256,
    public_execution_sha256: summary.public_execution_sha256, replay_sha256: summary.replay_sha256,
    summary_file_sha256: summaryFileSha256, wire_file_sha256: wireFileSha256,
    usage_file_sha256: usageFileSha256, wire_observation_count: summary.wire_observation_count,
    usage_event_count: summary.usage_event_count, caller_audio_bytes: summary.delivery.audio_bytes,
    caller_audio_sha256: summary.delivery.audio_sha256, delivery_profile_sha256: summary.delivery.delivery_profile_sha256,
    input_audio_evidence: summary.input_audio_evidence, output_audio_evidence: summary.output_audio_evidence,
    turn_boundary_mode: summary.turn_boundary_mode, server_vad_setting_sha256: summary.server_vad_setting_sha256,
    transport_parity_sha256: summary.transport_parity_sha256, tool_frontier_sha256: summary.tool_frontier_sha256,
    per_turn_session_update_observation_sha256: summary.per_turn_session_update_observation_sha256,
    per_turn_session_ack_observation_sha256: summary.per_turn_session_ack_observation_sha256,
    server_vad_speech_start_observation_sha256: summary.server_vad_speech_start_observation_sha256,
    server_vad_speech_stop_observation_sha256: summary.server_vad_speech_stop_observation_sha256,
    server_vad_auto_commit_observation_sha256: summary.server_vad_auto_commit_observation_sha256,
    server_vad_auto_response_observation_sha256: summary.server_vad_auto_response_observation_sha256,
    provider_tool_call_evidence_sha256: summary.provider_tool_call_evidence_sha256,
    tool_result_evidence_sha256: summary.tool_result_evidence_sha256,
    tool_call_observed: true, tool_result_wire_observed: true,
    post_tool_terminal_observed: true, post_tool_usage_observed: true,
  });
}

export async function loadLc4DevRetainedQualificationV4(input: Readonly<{
  root: string;
  qualification_trust_root_sha256: string;
  now?: Date;
}>): Promise<Lc4DevRetainedQualificationV4Receipt> {
  const root = resolve(input.root);
  requireHash(input.qualification_trust_root_sha256, "LC4-DEV qualification v4 trust root");
  const attemptsRoot = resolve(root, "attempts");
  const complete = (await readdir(attemptsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".v4-package.complete"));
  if (complete.length !== 1) throw new Error("LC4-DEV qualification v4 must retain exactly one signed package");
  const directory = resolve(attemptsRoot, complete[0]!.name);
  const retained = await readLc4QualificationPackageDirectoryV5({
    directory,
    envelopePath: "qualification-package-envelope.json",
  });
  const files = packageFilesByPath(retained.files);
  if (canonicalJson([...files.keys()].sort()) !== canonicalJson(expectedV4PackagePaths())) {
    throw new Error("LC4-DEV qualification v4 package has unknown, missing, or renamed evidence files");
  }
  const terminal = parsePackageJson<Lc4QualificationV4TerminalArtifact>(files, "terminal.json");
  const plan = parsePackageJson<Lc4QualificationV3PlanArtifact>(files, "plan.json");
  const authorization = parsePackageJson<Lc4QualificationV3AuthorizationArtifact>(files, "authorization.json");
  const budget = parsePackageJson<Lc4QualificationBudgetEvidence>(files, "budget-settlement.json");
  assertLc4QualificationV3PlanArtifact(plan, input.qualification_trust_root_sha256);
  const budgetBinding = v4BudgetBinding(plan, authorization);
  const verifiedPackage = await verifySignedLc4QualificationV4Package({
    envelope: retained.envelope,
    files: retained.files,
    expectedTrustRootFingerprintSha256: input.qualification_trust_root_sha256,
    expectedBinding: terminal.body.binding,
    budgetBinding,
  });
  const verifiedEnvelope = assertSignedLc4QualificationPackageEnvelopeV5Identity({
    envelope: retained.envelope,
    expectedAuthorityFingerprintSha256:
      authorization.body.terminal_public_key_fingerprint_sha256,
  });
  const now = input.now ?? new Date();
  const sealedAt = Date.parse(terminal.body.sealed_at);
  const invoked = parsePackageJson<Lc4DevRetainedQualificationV4Receipt["invocation"]>(files, "v4-invocation.json");
  const { invocation_sha256: invocationSha256, ...invocationBody } = invoked;
  const invokedAt = Date.parse(invoked.invoked_at);
  if (!Number.isFinite(sealedAt)
    || !Number.isFinite(invokedAt)
    || sealedAt > now.getTime() + 120_000
    || now.getTime() - sealedAt > PROVIDER_QUALIFICATION_MAX_AGE_MS
    || invoked.attempt_id !== terminal.body.binding.attempt_id
    || invoked.schema_version !== 1
    || invoked.runner_version !== LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION
    || invocationSha256 !== sha256Hex(`${V4_INVOCATION_DOMAIN}${canonicalJson(invocationBody)}`)
    || invoked.authorization_artifact_sha256 !== authorization.artifact_sha256
    || invokedAt < Date.parse(authorization.body.not_before)
    || invokedAt >= Date.parse(authorization.body.expires_at)
    || sealedAt < invokedAt
    || sealedAt >= Date.parse(authorization.body.expires_at)) {
    throw new Error("LC4-DEV qualification v4 invocation, expiry, or freshness is invalid");
  }
  const expectedTargets = createLc4QualificationV3Targets();
  const expectedPaidTargets = createLc4QualificationV3PaidTargets();
  const spoken: Lc4DevQualificationV3SpokenEvidence[] = [];
  const retainedSummaries: Lc4DevRetainedRoundtripSummary[] = [];
  const retainedUsage: RoundtripSanitizedUsage[] = [];
  const setupEvidenceSha: string[] = [];
  const setupQualifications: ProviderQualificationArtifact[] = [];
  let xaiSetup: ProviderQualificationArtifact["results"][number] | null = null;
  for (const [index, provider] of LC4_QUALIFICATION_V3_PROVIDER_ORDER.entries()) {
    const prefix = `${String(index).padStart(2, "0")}-${provider}`;
    const setup = parsePackageJson<ProviderQualificationArtifact>(files, `${prefix}-setup-qualification.json`);
    const setupPhase = parsePackageJson<Lc4QualificationV4PhaseTerminal>(files, `${prefix}-setup-terminal.json`);
    assertProviderQualificationArtifactIntegrity(setup);
    const setupResult = setup.results[0];
    const target = plan.body.targets[index]!;
    const expected = expectedTargets[index]!;
    const expectedPaid = expectedPaidTargets[index]!;
    const providerBinding = terminal.body.binding.providers[index];
    const credential = plan.body.credential_identities[index];
    if (setup.status === "failed"
      || setup.results.length !== 1
      || !setupResult
      || setupResult.status !== "passed"
      || setupResult.provider !== provider
      || setupResult.model !== target.model
      || setupResult.model !== expected.model
      || setupResult.requestedConfigurationSha256 !== requestedConfigurationSha256(expected)
      || setup.planSha256 !== plan.body.plan_sha256
      || setup.sourceCommit !== plan.body.source.source_commit
      || setup.configurationMatrixSha256 !== plan.body.setup_configuration_matrix_sha256
      || setup.credentialSetSha256 !== plan.body.credential_set_sha256
      || setupPhase.result.evidence_sha256 !== setup.artifactSha256
      || setupPhase.result.status !== "passed"
      || providerBinding?.provider !== provider
      || providerBinding.model !== target.model
      || providerBinding.setup_configuration_sha256 !== v4ConfigurationSha256(expected)
      || providerBinding.paid_configuration_sha256 !== v4ConfigurationSha256(expectedPaid)
      || credential?.provider !== provider
      || providerBinding.credential_sha256 !== credential.credential_sha256
      || providerBinding.caller_audio_sha256 !== target.caller_audio_sha256
      || providerBinding.caller_audio_bytes !== target.caller_audio_bytes
      || providerBinding.audio_delivery_profile_sha256 !== target.audio_delivery_profile_sha256) {
      throw new Error(`LC4-DEV qualification v4 ${provider} setup shard differs from plan or phase terminal`);
    }
    setupEvidenceSha.push(setup.artifactSha256);
    setupQualifications.push(setup);
    if (provider === "xai") xaiSetup = setupResult;

    const summaryFile = files.get(`${prefix}-spoken-roundtrip.json`)!;
    const wireFile = files.get(`${prefix}-spoken-roundtrip-wire.jsonl`)!;
    const usageFile = files.get(`${prefix}-spoken-roundtrip-usage.jsonl`)!;
    const summary = JSON.parse(Buffer.from(summaryFile.bytes).toString("utf8")) as RetainedRoundtripSummary;
    const wire = freeze(Buffer.from(wireFile.bytes).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RealtimeWireObservation));
    const usage = freeze(Buffer.from(usageFile.bytes).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RoundtripSanitizedUsage));
    const paidPhase = parsePackageJson<Lc4QualificationV4PhaseTerminal>(files, `${prefix}-paid-terminal.json`);
    assertLc4DevRetainedRoundtripLogCardinality({
      provider,
      summary_wire_observation_count: summary.wire_observation_count,
      summary_raw_usage_event_count: summary.usage_event_count,
      retained_wire_observation_count: wire.length,
      retained_sanitized_usage_event_count: usage.length,
    });
    if (summary.provider !== provider
      || summary.model !== target.model
      || summary.status !== "passed"
      || summary.failure_class !== "none"
      || summary.delivery === null
      || summary.delivery.audio_bytes !== target.caller_audio_bytes
      || summary.delivery.audio_sha256 !== target.caller_audio_sha256
      || summary.delivery.delivery_profile_sha256 !== target.audio_delivery_profile_sha256
      || !summary.tool_call_observed || !summary.tool_result_submitted || !summary.tool_result_wire_observed
      || !summary.post_tool_terminal_observed || !summary.post_tool_usage_observed
      || summary.provider_tool_call_evidence_sha256 === null || summary.tool_result_evidence_sha256 === null
      || summary.input_audio_evidence === null || summary.output_audio_evidence === null
      || summary.replay_summary === null || summary.replay_causal_binding === null
      || !verifyRealtimeWireObservationChain(wire).valid
      || paidPhase.result.status !== "passed"
      || paidPhase.result.evidence_sha256 !== summary.evidence_sha256
      || paidPhase.result.wire_observation_count !== wire.length
      || paidPhase.result.wire_head_sha256 !== wire.at(-1)?.observationSha256
      || paidPhase.result.usage_event_count !== usage.length
      || paidPhase.result.usage_evidence_sha256 !== sha256Hex(canonicalJson(usage))) {
      throw new Error(`LC4-DEV qualification v4 ${provider} paid evidence differs from plan, replay, or phase terminal`);
    }
    assertClosedLoopWire(provider, wire, usage, summary.pre_tool_output_quarantine);
    const replay = replayProviderToolRoundtrip({
      expected: { provider, model: summary.model },
      summary: summary.replay_summary,
      wire_observations: wire,
      sanitized_usage: usage,
      causal_binding: summary.replay_causal_binding,
    });
    if (!replay.valid
      || replay.public_execution_sha256 !== summary.public_execution_sha256
      || replay.replay_sha256 !== summary.replay_sha256) {
      throw new Error(`LC4-DEV qualification v4 ${provider} paid replay failed integrity`);
    }
    retainedUsage.push(...usage);
    retainedSummaries.push(summary);
    spoken.push(v4SpokenEvidence(
      summary,
      sha256Hex(summaryFile.bytes),
      sha256Hex(wireFile.bytes),
      sha256Hex(usageFile.bytes),
    ));
  }
  if (budget.usage_event_count !== retainedUsage.length
    || budget.usage_evidence_sha256 !== verifiedPackage.aggregate.usage_evidence_sha256
    || budget.binding_sha256 !== lc4QualificationBudgetBindingSha256(budgetBinding)
    || budget.terminal_outcome !== "completed") {
    throw new Error("LC4-DEV qualification v4 usage or budget binding differs from retained replay");
  }
  if (xaiSetup === null) throw new Error("LC4-DEV qualification v4 lacks xAI setup evidence");
  const gateARisk = parsePackageJson<Lc4XaiServerVadGateARiskArtifact>(files, "xai-server-vad-gate-a-risk.json");
  assertXaiServerVadGateARiskArtifact(gateARisk);
  if (gateARisk.requested_configuration_sha256 !== xaiSetup.requestedConfigurationSha256
    || gateARisk.model !== plan.body.targets[2]?.model
    || gateARisk.source_commit !== plan.body.source.source_commit
    || gateARisk.plan_sha256 !== plan.body.plan_sha256
    || gateARisk.configuration_matrix_sha256 !== plan.body.setup_configuration_matrix_sha256
    || gateARisk.provider_profile_manifest_sha256 !== plan.body.provider_profile_manifest_sha256
    || gateARisk.production_session_payload_sha256 !== plan.body.targets[2]?.production_session_payload_sha256) {
    throw new Error("LC4-DEV qualification v4 xAI Gate A risk differs from setup shard");
  }
  const gateB = parsePackageJson<Lc4XaiServerVadGateBBindingArtifact>(files, "xai-server-vad-gate-b-binding.json");
  assertV4GateBBinding({ binding: gateB, risk: gateARisk, spoken: spoken[2]!, plan });
  const gateBFile = files.get("xai-server-vad-gate-b-binding.json")!;
  const reportSha256 = sha256Hex(`${REPORT_DOMAIN}${canonicalJson({
    schema_version: 1, runner_version: LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
    terminal_artifact_sha256: terminal.artifact_sha256,
    aggregate_sha256: verifiedPackage.aggregate.aggregate_sha256,
    provider_sessions: 6, paid_sessions: 3, generation_phases: 6, tool_roundtrips: 3, retries: 0,
  })}`);
  const retainedBody = freeze({
    plan_artifact_sha256: plan.artifact_sha256,
    authorization_artifact_sha256: authorization.artifact_sha256,
    terminal_artifact_sha256: terminal.artifact_sha256,
    package_sha256: verifiedPackage.package_manifest_sha256,
    setup_qualification_artifact_sha256: terminal.body.package_bindings.setup_qualification_artifact_sha256,
    setup_shard_artifact_sha256: setupEvidenceSha,
    budget_evidence_sha256: budget.evidence_sha256,
    spoken_gate_evidence: spoken,
    xai_server_vad_gate_b_binding_sha256: gateB.binding_sha256,
  });
  const xaiServerVadClaims = v4XaiServerVadClaims(xaiSetup, gateARisk, gateB);
  const common = freeze({
    schema_version: 4 as const, protocol_id: "HACC-LC4-DEV-v1" as const,
    qualification_protocol_id: "HACC-LC4-v1" as const,
    qualification_runner_version: LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
    status: "passed" as const, providers: LC4_QUALIFICATION_V3_PROVIDER_ORDER,
    source_commit: plan.body.source.source_commit, source_tree_sha256: plan.body.source.source_tree_sha256,
    credential_set_sha256: plan.body.credential_set_sha256,
    provider_profile_manifest_sha256: plan.body.provider_profile_manifest_sha256,
    setup_configuration_matrix_sha256: plan.body.setup_configuration_matrix_sha256,
    qualification_trust_root_sha256: input.qualification_trust_root_sha256,
    plan_sha256: plan.body.plan_sha256, plan_artifact_sha256: plan.artifact_sha256,
    terminal_sha256: terminal.body.terminal_sha256, terminal_artifact_sha256: terminal.artifact_sha256,
    terminal_root_sha256: terminal.artifact_sha256, report_sha256: reportSha256,
    package_sha256: verifiedPackage.package_manifest_sha256,
    setup_qualification_artifact_sha256: terminal.body.package_bindings.setup_qualification_artifact_sha256,
    budget_evidence_sha256: budget.evidence_sha256, budget_final_head_sha256: budget.final_head_sha256,
    retained_artifact_sha256: sha256Hex(`${V4_RECEIPT_DOMAIN}${canonicalJson(retainedBody)}`),
    transport_qualification_scope: LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE,
    transport_qualification_scope_sha256: LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
    xai_server_vad_gate_b_binding_sha256: gateB.binding_sha256,
    xai_server_vad_gate_b_binding_file_sha256: sha256Hex(gateBFile.bytes),
    plan, authorization, terminal, invocation: invoked, package_manifest: verifiedEnvelope,
    budget_evidence: budget, setup_qualifications: freeze(setupQualifications),
    spoken_gate_summaries: freeze(retainedSummaries),
    spoken_gate_evidence: freeze(spoken), xai_server_vad_gate_b_binding: gateB,
    xai_server_vad_gate_a_risk: gateARisk,
    xai_server_vad_claims: xaiServerVadClaims,
    xai_server_vad_claim_boundary: "operational_server_vad_and_exact_gateway_roundtrip_verified_exact_numeric_vad_parameters_only_when_provider_echoed" as const,
  });
  const receipt = freeze({ ...common, receipt_sha256: sha256Hex(`${V4_RECEIPT_DOMAIN}${canonicalJson(common)}`) });
  assertLc4DevRetainedQualificationV4Receipt(receipt);
  return receipt;
}

export function assertLc4DevRetainedQualificationV4Receipt(receipt: Lc4DevRetainedQualificationV4Receipt): void {
  const { receipt_sha256, ...body } = receipt;
  assertLc4QualificationV3PlanArtifact(receipt.plan, receipt.qualification_trust_root_sha256);
  assertLc4QualificationV3Authorization({
    artifact: receipt.authorization,
    plan: receipt.plan,
    trustRootFingerprint: receipt.qualification_trust_root_sha256,
    now: new Date(receipt.terminal.body.sealed_at),
  });
  assertLc4QualificationV4TerminalArtifact(
    receipt.terminal,
    receipt.authorization.body.terminal_public_key_fingerprint_sha256,
  );
  assertSignedLc4QualificationPackageEnvelopeV5Identity({
    envelope: receipt.package_manifest,
    expectedAuthorityFingerprintSha256:
      receipt.authorization.body.terminal_public_key_fingerprint_sha256,
  });
  assertLc4QualificationBudgetEvidence(receipt.budget_evidence);
  const binding = receipt.terminal.body.binding;
  const envelope = receipt.package_manifest;
  const entries = new Map(envelope.body.entries.map((entry) => [entry.path, entry]));
  const { invocation_sha256: invocationSha256, ...invocationBody } = receipt.invocation;
  const invokedAt = Date.parse(receipt.invocation.invoked_at);
  const sealedAt = Date.parse(receipt.terminal.body.sealed_at);
  const expectedSetupTargets = createLc4QualificationV3Targets();
  const expectedPaidTargets = createLc4QualificationV3PaidTargets();
  const setupArtifactSha256 = receipt.setup_qualifications.map((artifact, index) => {
    assertProviderQualificationArtifactIntegrity(artifact);
    const provider = LC4_QUALIFICATION_V3_PROVIDER_ORDER[index];
    const target = receipt.plan.body.targets[index];
    const result = artifact.results[0];
    const expected = expectedSetupTargets[index];
    const expectedPaid = expectedPaidTargets[index];
    const providerBinding = binding.providers[index];
    const credential = receipt.plan.body.credential_identities[index];
    const entry = entries.get(`${String(index).padStart(2, "0")}-${provider}-setup-qualification.json`);
    if (artifact.results.length !== 1 || artifact.status === "failed" || result?.status !== "passed"
      || result.provider !== provider || result.model !== target?.model || result.model !== expected?.model
      || result.requestedConfigurationSha256 !== (expected && requestedConfigurationSha256(expected))
      || artifact.planSha256 !== receipt.plan_sha256
      || artifact.sourceCommit !== receipt.source_commit
      || artifact.configurationMatrixSha256 !== receipt.setup_configuration_matrix_sha256
      || artifact.credentialSetSha256 !== receipt.credential_set_sha256
      || providerBinding?.provider !== provider
      || providerBinding.model !== target?.model
      || providerBinding.setup_configuration_sha256 !== (expected && v4ConfigurationSha256(expected))
      || providerBinding.paid_configuration_sha256 !== (expectedPaid && v4ConfigurationSha256(expectedPaid))
      || credential?.provider !== provider
      || providerBinding.credential_sha256 !== credential.credential_sha256
      || providerBinding.caller_audio_sha256 !== target?.caller_audio_sha256
      || providerBinding.caller_audio_bytes !== target?.caller_audio_bytes
      || providerBinding.audio_delivery_profile_sha256 !== target?.audio_delivery_profile_sha256
      || entry?.sha256 !== sha256Hex(Buffer.from(`${canonicalJson(artifact)}\n`, "utf8"))) {
      throw new Error("LC4-DEV retained qualification v4 setup projection differs from its signed package");
    }
    return artifact.artifactSha256;
  });
  const spokenByProvider = new Map(receipt.spoken_gate_evidence.map((entry) => [entry.provider, entry]));
  const summaryByProvider = new Map(receipt.spoken_gate_summaries.map((entry) => [entry.provider, entry]));
  for (const [index, provider] of LC4_QUALIFICATION_V3_PROVIDER_ORDER.entries()) {
    const prefix = `${String(index).padStart(2, "0")}-${provider}`;
    const spoken = spokenByProvider.get(provider);
    const summary = summaryByProvider.get(provider);
    const target = receipt.plan.body.targets[index];
    if (!spoken || !summary || spoken.model !== target?.model
      || summary.model !== target?.model
      || canonicalJson(spoken) !== canonicalJson(v4SpokenEvidence(
        summary,
        spoken.summary_file_sha256,
        spoken.wire_file_sha256,
        spoken.usage_file_sha256,
      ))
      || entries.get(`${prefix}-spoken-roundtrip.json`)?.sha256
        !== sha256Hex(Buffer.from(`${canonicalJson(summary)}\n`, "utf8"))
      || entries.get(`${prefix}-spoken-roundtrip.json`)?.sha256 !== spoken.summary_file_sha256
      || entries.get(`${prefix}-spoken-roundtrip-wire.jsonl`)?.sha256 !== spoken.wire_file_sha256
      || entries.get(`${prefix}-spoken-roundtrip-usage.jsonl`)?.sha256 !== spoken.usage_file_sha256) {
      throw new Error("LC4-DEV retained qualification v4 spoken projection differs from its signed package");
    }
  }
  const gateAEntry = entries.get("xai-server-vad-gate-a-risk.json");
  const gateBEntry = entries.get("xai-server-vad-gate-b-binding.json");
  const xaiSetup = receipt.setup_qualifications[2]?.results[0];
  if (!xaiSetup) throw new Error("LC4-DEV retained qualification v4 lacks xAI setup projection");
  assertXaiServerVadGateARiskArtifact(receipt.xai_server_vad_gate_a_risk);
  assertV4GateBBinding({
    binding: receipt.xai_server_vad_gate_b_binding,
    risk: receipt.xai_server_vad_gate_a_risk,
    spoken: spokenByProvider.get("xai")!,
    plan: receipt.plan,
  });
  const budgetBinding = v4BudgetBinding(receipt.plan, receipt.authorization);
  const expectedRetainedBody = freeze({
    plan_artifact_sha256: receipt.plan.artifact_sha256,
    authorization_artifact_sha256: receipt.authorization.artifact_sha256,
    terminal_artifact_sha256: receipt.terminal.artifact_sha256,
    package_sha256: envelope.artifact_sha256,
    setup_qualification_artifact_sha256: receipt.terminal.body.package_bindings.setup_qualification_artifact_sha256,
    setup_shard_artifact_sha256: setupArtifactSha256,
    budget_evidence_sha256: receipt.budget_evidence.evidence_sha256,
    spoken_gate_evidence: receipt.spoken_gate_evidence,
    xai_server_vad_gate_b_binding_sha256: receipt.xai_server_vad_gate_b_binding.binding_sha256,
  });
  const expectedReportSha256 = sha256Hex(`${REPORT_DOMAIN}${canonicalJson({
    schema_version: 1, runner_version: LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
    terminal_artifact_sha256: receipt.terminal.artifact_sha256,
    aggregate_sha256: receipt.terminal.body.aggregate_sha256,
    provider_sessions: 6, paid_sessions: 3, generation_phases: 6, tool_roundtrips: 3, retries: 0,
  })}`);
  if (receipt.qualification_runner_version !== LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION
    || receipt.schema_version !== 4
    || receipt.status !== "passed"
    || receipt.terminal.body.status !== "passed"
    || canonicalJson(receipt.providers) !== canonicalJson(LC4_QUALIFICATION_V3_PROVIDER_ORDER)
    || receipt.setup_qualifications.length !== 3
    || receipt.spoken_gate_summaries.length !== 3
    || receipt.spoken_gate_evidence.length !== 3
    || canonicalJson([...entries.keys()].sort()) !== canonicalJson(expectedV4PackagePaths())
    || receipt.invocation.schema_version !== 1
    || receipt.invocation.runner_version !== LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION
    || receipt.invocation.attempt_id !== binding.attempt_id
    || receipt.invocation.authorization_artifact_sha256 !== receipt.authorization.artifact_sha256
    || invocationSha256 !== sha256Hex(`${V4_INVOCATION_DOMAIN}${canonicalJson(invocationBody)}`)
    || !Number.isFinite(invokedAt)
    || invokedAt < Date.parse(receipt.authorization.body.not_before)
    || invokedAt >= Date.parse(receipt.authorization.body.expires_at)
    || !Number.isFinite(sealedAt)
    || sealedAt < invokedAt
    || sealedAt >= Date.parse(receipt.authorization.body.expires_at)
    || entries.get("v4-invocation.json")?.sha256
      !== sha256Hex(Buffer.from(`${canonicalJson(receipt.invocation)}\n`, "utf8"))
    || receipt.terminal_root_sha256 !== receipt.terminal_artifact_sha256
    || receipt.terminal.artifact_sha256 !== receipt.terminal_artifact_sha256
    || receipt.terminal.body.terminal_sha256 !== receipt.terminal_sha256
    || receipt.source_commit !== receipt.plan.body.source.source_commit
    || receipt.source_tree_sha256 !== receipt.plan.body.source.source_tree_sha256
    || receipt.credential_set_sha256 !== receipt.plan.body.credential_set_sha256
    || receipt.provider_profile_manifest_sha256 !== receipt.plan.body.provider_profile_manifest_sha256
    || receipt.setup_configuration_matrix_sha256 !== receipt.plan.body.setup_configuration_matrix_sha256
    || binding.attempt_id !== receipt.authorization.body.authorization_id
    || binding.authorization_artifact_sha256 !== receipt.authorization.artifact_sha256
    || binding.plan_artifact_sha256 !== receipt.plan.artifact_sha256
    || binding.plan_sha256 !== receipt.plan.body.plan_sha256
    || binding.source_commit !== receipt.source_commit
    || binding.source_tree_sha256 !== receipt.source_tree_sha256
    || binding.credential_set_sha256 !== receipt.credential_set_sha256
    || binding.provider_profile_manifest_sha256 !== receipt.provider_profile_manifest_sha256
    || binding.setup_configuration_matrix_sha256 !== receipt.setup_configuration_matrix_sha256
    || binding.paid_configuration_matrix_sha256 !== receipt.plan.body.paid_configuration_matrix_sha256
    || envelope.body.terminal_artifact_sha256 !== receipt.terminal_artifact_sha256
    || envelope.body.payload_root_sha256 !== receipt.terminal.body.payload_root_sha256
    || canonicalJson(envelope.body.bindings) !== canonicalJson(receipt.terminal.body.package_bindings)
    || envelope.body.bindings.provider_session_count !== 6
    || envelope.body.bindings.paid_session_count !== 3
    || envelope.body.bindings.generation_phase_count !== 6
    || envelope.body.bindings.tool_roundtrip_count !== 3
    || envelope.body.bindings.retry_count !== 0
    || envelope.body.bindings.reconnect_count !== 0
    || envelope.body.bindings.setup_qualification_artifact_sha256
      !== sha256Hex(`${V4_SETUP_AGGREGATE_DOMAIN}${canonicalJson(setupArtifactSha256)}`)
    || envelope.body.bindings.replay_artifact_sha256
      !== sha256Hex(`${V4_REPLAY_AGGREGATE_DOMAIN}${canonicalJson(receipt.spoken_gate_evidence.map((evidence) => evidence.evidence_sha256))}`)
    || receipt.package_sha256 !== envelope.artifact_sha256
    || receipt.setup_qualification_artifact_sha256 !== envelope.body.bindings.setup_qualification_artifact_sha256
    || receipt.budget_evidence_sha256 !== receipt.budget_evidence.evidence_sha256
    || receipt.budget_final_head_sha256 !== receipt.budget_evidence.final_head_sha256
    || receipt.budget_evidence.binding_sha256 !== lc4QualificationBudgetBindingSha256(budgetBinding)
    || receipt.budget_evidence.terminal_outcome !== "completed"
    || receipt.budget_evidence_sha256 !== receipt.terminal.body.budget_evidence_sha256
    || receipt.budget_evidence.binding_sha256 !== receipt.terminal.body.budget_binding_sha256
    || receipt.report_sha256 !== expectedReportSha256
    || receipt.retained_artifact_sha256 !== sha256Hex(`${V4_RECEIPT_DOMAIN}${canonicalJson(expectedRetainedBody)}`)
    || canonicalJson(receipt.transport_qualification_scope) !== canonicalJson(LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE)
    || receipt.transport_qualification_scope_sha256 !== LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256
    || receipt.xai_server_vad_gate_b_binding_sha256 !== receipt.xai_server_vad_gate_b_binding.binding_sha256
    || receipt.xai_server_vad_gate_a_risk.requested_configuration_sha256 !== xaiSetup.requestedConfigurationSha256
    || receipt.xai_server_vad_gate_a_risk.model !== receipt.plan.body.targets[2]?.model
    || receipt.xai_server_vad_gate_a_risk.source_commit !== receipt.source_commit
    || receipt.xai_server_vad_gate_a_risk.plan_sha256 !== receipt.plan_sha256
    || receipt.xai_server_vad_gate_a_risk.configuration_matrix_sha256 !== receipt.setup_configuration_matrix_sha256
    || receipt.xai_server_vad_gate_a_risk.provider_profile_manifest_sha256 !== receipt.provider_profile_manifest_sha256
    || receipt.xai_server_vad_gate_a_risk.production_session_payload_sha256
      !== receipt.plan.body.targets[2]?.production_session_payload_sha256
    || canonicalJson(receipt.xai_server_vad_claims)
      !== canonicalJson(v4XaiServerVadClaims(xaiSetup, receipt.xai_server_vad_gate_a_risk, receipt.xai_server_vad_gate_b_binding))
    || receipt.xai_server_vad_claim_boundary
      !== "operational_server_vad_and_exact_gateway_roundtrip_verified_exact_numeric_vad_parameters_only_when_provider_echoed"
    || receipt.xai_server_vad_gate_b_binding_file_sha256 !== gateBEntry?.sha256
    || gateAEntry?.sha256 !== sha256Hex(Buffer.from(`${canonicalJson(receipt.xai_server_vad_gate_a_risk)}\n`, "utf8"))
    || gateBEntry?.sha256 !== sha256Hex(Buffer.from(`${canonicalJson(receipt.xai_server_vad_gate_b_binding)}\n`, "utf8"))
    || sha256Hex(`${V4_RECEIPT_DOMAIN}${canonicalJson(body)}`) !== receipt_sha256) {
    throw new Error("LC4-DEV retained qualification v4 receipt failed canonical admission integrity");
  }
}

export function assertLc4DevRetainedQualificationReceipt(receipt: Lc4DevRetainedQualificationReceipt): void {
  assertLc4DevRetainedQualificationV3Receipt(receipt);
}

export function assertLc4DevQualificationAdmissionReceipt(receipt: Lc4DevQualificationAdmissionReceipt): void {
  const hasV4Discriminator = Object.prototype.hasOwnProperty.call(
    receipt,
    "setup_qualifications",
  );
  if (receipt.qualification_runner_version === LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION) {
    if (!hasV4Discriminator) {
      throw new Error("LC4-DEV qualification admission discriminator mismatch");
    }
    assertLc4DevRetainedQualificationV4Receipt(
      receipt as Lc4DevRetainedQualificationV4Receipt,
    );
  } else if (receipt.qualification_runner_version === LC4_QUALIFICATION_V3_RUNNER_VERSION) {
    if (hasV4Discriminator) {
      throw new Error("LC4-DEV qualification admission discriminator mismatch");
    }
    assertLc4DevRetainedQualificationV3Receipt(
      receipt as Lc4DevRetainedQualificationV3Receipt,
    );
  } else {
    throw new Error("LC4-DEV qualification admission runner version is unsupported");
  }
  if (receipt.provider_profile_manifest_sha256
    !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256) {
    throw new Error("LC4-DEV qualification admission provider profile is stale");
  }
}
