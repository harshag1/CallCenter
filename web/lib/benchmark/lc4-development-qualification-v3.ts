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
  assertLc4QualificationV3PlanArtifact,
  createLc4QualificationV3Targets,
  reportLc4QualificationV3,
  type Lc4QualificationV3AuthorizationArtifact,
  type Lc4QualificationV3PlanArtifact,
  type Lc4QualificationV3TerminalArtifact,
  type Lc4XaiServerVadGateBBindingArtifact,
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
} from "./provider-qualification";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "./lc4-provider-profiles";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type { RealtimeWireObservation } from "../realtime/client/types";
import { verifyRealtimeWireObservationChain } from "../realtime/client/wire-evidence";
import {
  replayProviderToolRoundtrip,
  type RoundtripSanitizedUsage,
} from "./provider-roundtrip-replay";
import {
  readLc4QualificationPackageDirectoryV5,
  verifySignedLc4QualificationPackageEnvelopeV5,
  type Lc4QualificationTerminalClaimsV5,
  type SignedLc4QualificationPackageEnvelopeV5,
} from "./lc4-qualification-package-envelope";

const PLAN_SIGNING_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan/v4\n";
const PLAN_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan-artifact/v4\n";
const TERMINAL_SIGNING_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal/v6\n";
const TERMINAL_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal-artifact/v6\n";
const AUTHORIZATION_SIGNING_DOMAIN = "harshas-amazing-call-center/lc4-qualification-authorization/v4\n";
const AUTHORIZATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-authorization-artifact/v4\n";
const RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-retained-qualification-v3/v2\n";
const REPORT_DOMAIN = "harshas-amazing-call-center/lc4-dev-qualification-v3-report/v1\n";
const XAI_GATE_B_BINDING_DOMAIN = "harshas-amazing-call-center/xai-server-vad-gate-b-binding/v1\n";
const HASH = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_JSONL_BYTES = 256 * 1024 * 1024;

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

type RetainedRoundtripSummary = Omit<Lc4S2sRoundtripExecution, "wire_observations" | "usage" | "sanitized_usage"> & Readonly<{
  wire_observation_count: number;
  usage_event_count: number;
}>;

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

export type Lc4DevRetainedQualificationReceipt = Readonly<{
  schema_version: 3;
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

function assertProviderOrder(values: readonly Readonly<{ provider: LiveStsProvider; model: string }>[], label: string): void {
  if (canonicalJson(values.map(({ provider }) => provider)) !== canonicalJson(LC4_QUALIFICATION_V3_PROVIDER_ORDER)) {
    throw new Error(`${label} is not in exact OpenAI, Gemini, xAI order`);
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
  usage: readonly Readonly<Record<string, unknown>>[],
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
  if (!usageOnWire || usage.length === 0) throw new Error(`LC4-DEV qualification v3 ${provider} retained evidence lacks post-tool usage`);
  const prematureSpeech = wire.slice(0, call).some((entry) => {
    if (entry.direction !== "inbound" || typeof entry.projection !== "object" || entry.projection === null) return false;
    const projection = entry.projection as Record<string, unknown>;
    return projection.audio !== undefined || projection.text !== undefined;
  });
  if (prematureSpeech) throw new Error(`LC4-DEV qualification v3 ${provider} spoke before its required tool call`);
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

export function createLc4DevRetainedQualificationReceipt(input: ReceiptInput): Lc4DevRetainedQualificationReceipt {
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
  assertProviderOrder(input.setup_qualification.results, "LC4-DEV qualification v3 Gate A results");
  assertProviderOrder(input.spoken_gate_evidence, "LC4-DEV qualification v3 Gate B results");
  const credentialSetFromPlan = sha256Hex(`harshas-amazing-call-center/provider-credential-set/v1\n${canonicalJson(plan.credential_identities)}`);

  if (plan.protocol_id !== "HACC-LC4-v1"
    || plan.provider_profile_manifest_sha256 !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256
    || credentialSetFromPlan !== plan.credential_set_sha256
    || plan.setup_configuration_matrix_sha256 !== providerQualificationMatrixSha256(expectedTargets)
    || input.setup_qualification.planSha256 !== plan.plan_sha256
    || input.setup_qualification.sourceCommit !== plan.source.source_commit
    || input.setup_qualification.configurationMatrixSha256 !== plan.setup_configuration_matrix_sha256
    || input.setup_qualification.credentialSetSha256 !== plan.credential_set_sha256
    || input.setup_qualification.artifactSha256 !== terminal.setup_qualification_artifact_sha256
    || input.setup_qualification.results.length !== 3
    || input.setup_qualification.results.some((result) => result.status !== "passed")
    || input.report.plan_artifact_sha256 !== input.plan.artifact_sha256
    || input.report.source_commit !== plan.source.source_commit
    || canonicalJson(input.report.latest) !== canonicalJson(terminal)
    || terminal.plan_artifact_sha256 !== input.plan.artifact_sha256
    || terminal.plan_sha256 !== plan.plan_sha256
    || terminal.authorization_artifact_sha256 !== input.authorization.artifact_sha256
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
    const setup = input.setup_qualification.results[index]!;
    const spoken = input.spoken_gate_evidence[index]!;
    const result = terminal.results[index]!;
    if (target.provider !== provider
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
  const xaiSetup = input.setup_qualification.results[2]!;
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
    spoken_gate_evidence: input.spoken_gate_evidence,
  });
  const retainedArtifactSha256 = sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(retainedBody)}`);
  const body = freeze({
    schema_version: 3 as const,
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

export function assertLc4DevRetainedQualificationReceipt(receipt: Lc4DevRetainedQualificationReceipt): void {
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
}>): Promise<Lc4DevRetainedQualificationReceipt> {
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
    if (wire_observation_count !== wire.length || usage_event_count !== usage.length) {
      throw new Error(`LC4-DEV qualification v3 ${provider} retained Gate B counts differ from their logs`);
    }
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
    assertClosedLoopWire(provider, wire, usage);
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
