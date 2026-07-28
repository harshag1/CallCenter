import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import type { Lc4DevReplayArtifactReference } from "./lc4-development-evidence-retention";
import type { LiveStsProvider } from "./live-sts-development-experiment";

export const LC4_DEV_FAILURE_EVIDENCE_VERSION = "lc4-dev-failure-evidence-v2" as const;
export const LC4_DEV_FAILURE_EVIDENCE_DOMAIN = "harshas-amazing-call-center/lc4-dev-failure-evidence/v2\n";

export type Lc4DevFailureStage =
  | "pre_send_contract"
  | "audio_append"
  | "response_prepare"
  | "server_vad_control_ack"
  | "audio_commit"
  | "response_request"
  | "provider_wait"
  | "gateway_dispatch"
  | "response_validate"
  | "listener_handoff"
  | "exchange_evidence"
  | "segment_close";

export type Lc4DevFailureCode =
  | "invalid_contract"
  | "audio_delivery_failed"
  | "response_request_failed"
  | "server_vad_control_ack_failed"
  | "server_vad_protocol_failure"
  | "provider_fatal"
  | "provider_connection_closed"
  | "provider_terminal_failed"
  | "provider_response_timeout"
  | "gateway_fatal"
  | "missing_terminal_response"
  | "invalid_output_audio"
  | "missing_output_audio"
  | "listener_failed"
  | "evidence_assembly_failed"
  | "segment_close_failed"
  | "adapter_failure";

export type Lc4DevFailureClass =
  | "adapter_contract"
  | "audio_delivery"
  | "provider_external"
  | "timeout"
  | "gateway"
  | "listener"
  | "evidence_retention"
  | "cleanup"
  | "unknown";

export type Lc4DevTerminalWireType =
  | "none"
  | "response_terminal"
  | "provider_error"
  | "connection_closed"
  | "audio_append"
  | "audio_commit"
  | "response_request"
  | "tool_activity"
  | "other";

export type Lc4DevFailureOperation =
  | "response_plan_session_update_sent"
  | "response_plan_session_update_acknowledged"
  | "caller_pcm_delivery_started"
  | "caller_pcm_delivery_completed"
  | "response_plan_prepared"
  | "caller_pcm_committed"
  | "caller_pcm_commit_acknowledged"
  | "server_vad_speech_started"
  | "server_vad_speech_stopped"
  | "caller_pcm_auto_committed"
  | "response_generation_requested"
  | "response_generation_auto_started"
  | "response_generation_started"
  | "response_terminal_observed"
  | "assistant_pcm_captured"
  | "listener_evidence_handed_off";

export type Lc4DevFailureEvidenceBody = Readonly<{
  schema_version: 2;
  evidence_version: typeof LC4_DEV_FAILURE_EVIDENCE_VERSION;
  redaction: "strict_allowlist_no_provider_plaintext_credentials_or_raw_ids";
  failure_role: "primary_exchange" | "cleanup";
  failure_stage: Lc4DevFailureStage;
  failure_code: Lc4DevFailureCode;
  failure_class: Lc4DevFailureClass;
  episode_id: string;
  opportunity_id: string | null;
  provider: LiveStsProvider;
  model: string;
  playback_kind: "canonical" | "repair" | null;
  operation_order: readonly Lc4DevFailureOperation[];
  caller_pcm_sha256: string | null;
  caller_pcm_byte_length: number;
  caller_pcm_chunk_count: number;
  caller_pcm_appended_chunk_count: number;
  caller_pcm_appended_byte_length: number;
  response_generation_requested: boolean;
  response_generation_started: boolean;
  response_terminal_observed: boolean;
  response_completed: boolean;
  output_pcm_sha256: string | null;
  output_pcm_byte_length: number;
  output_pcm_chunk_count: number;
  wire_observation_count: number;
  terminal_wire_type: Lc4DevTerminalWireType;
  terminal_wire_type_sha256: string | null;
  terminal_wire_observation_sha256: string | null;
  gateway_batch_count: number;
  gateway_fatal_class: "none" | "parse" | "provenance" | "execution" | "delivery" | "unknown";
  secondary_failure_evidence_sha256: string | null;
}>;

export type Lc4DevFailureEvidence = Readonly<Lc4DevFailureEvidenceBody & {
  failure_evidence_sha256: string;
}>;

export function lc4DevFailureEvidenceBody(evidence: Lc4DevFailureEvidence): Lc4DevFailureEvidenceBody {
  const rebuilt = createLc4DevFailureEvidence(evidence);
  if (rebuilt.failure_evidence_sha256 !== evidence.failure_evidence_sha256) {
    throw new Error("LC4-DEV failure evidence hash is invalid");
  }
  const copy = { ...rebuilt } as Record<string, unknown>;
  delete copy.failure_evidence_sha256;
  return immutableJson(copy) as unknown as Lc4DevFailureEvidenceBody;
}

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const STAGES = new Set<Lc4DevFailureStage>([
  "pre_send_contract", "audio_append", "response_prepare", "server_vad_control_ack", "audio_commit",
  "response_request", "provider_wait", "gateway_dispatch", "response_validate",
  "listener_handoff", "exchange_evidence", "segment_close",
]);
const CODES = new Set<Lc4DevFailureCode>([
  "invalid_contract", "audio_delivery_failed", "response_request_failed", "server_vad_control_ack_failed",
  "server_vad_protocol_failure", "provider_fatal",
  "provider_connection_closed",
  "provider_terminal_failed", "provider_response_timeout", "gateway_fatal",
  "missing_terminal_response", "invalid_output_audio", "missing_output_audio",
  "listener_failed", "evidence_assembly_failed", "segment_close_failed", "adapter_failure",
]);
const CLASSES = new Set<Lc4DevFailureClass>([
  "adapter_contract", "audio_delivery", "provider_external", "timeout", "gateway",
  "listener", "evidence_retention", "cleanup", "unknown",
]);
const TERMINAL_WIRE_TYPES = new Set<Lc4DevTerminalWireType>([
  "none", "response_terminal", "provider_error", "connection_closed", "audio_append",
  "audio_commit", "response_request", "tool_activity", "other",
]);
const GATEWAY_FATAL_CLASSES = new Set<Lc4DevFailureEvidenceBody["gateway_fatal_class"]>([
  "none", "parse", "provenance", "execution", "delivery", "unknown",
]);
const OPERATIONS: readonly Lc4DevFailureOperation[] = Object.freeze([
  "response_plan_session_update_sent", "response_plan_session_update_acknowledged",
  "caller_pcm_delivery_started", "caller_pcm_delivery_completed", "response_plan_prepared", "caller_pcm_committed",
  "caller_pcm_commit_acknowledged",
  "server_vad_speech_started", "server_vad_speech_stopped", "caller_pcm_auto_committed",
  "response_generation_requested", "response_generation_auto_started", "response_generation_started",
  "response_terminal_observed", "assistant_pcm_captured", "listener_evidence_handed_off",
]);

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function requireHashOrNull(value: string | null, label: string): void {
  if (value !== null && !HASH.test(value)) throw new Error(`${label} must be null or one lowercase SHA-256`);
}

export function classifyLc4DevTerminalWireType(wireType: string | null): Lc4DevTerminalWireType {
  if (wireType === null) return "none";
  if (["response.done", "response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(wireType)) return "response_terminal";
  if (wireType === "error" || wireType.endsWith(".error")) return "provider_error";
  if (wireType === "connection.closed" || wireType === "client.close") return "connection_closed";
  if (wireType === "input_audio_buffer.append" || wireType === "realtime.input_audio.append") return "audio_append";
  if (wireType === "input_audio_buffer.commit" || wireType === "realtime.input_audio.commit") return "audio_commit";
  if (wireType === "response.create" || wireType === "realtime.response.create") return "response_request";
  if (wireType.includes("tool") || wireType.includes("function")) return "tool_activity";
  return "other";
}

export function createLc4DevFailureEvidence(input: Lc4DevFailureEvidenceBody): Lc4DevFailureEvidence {
  if (input.schema_version !== 2 || input.evidence_version !== LC4_DEV_FAILURE_EVIDENCE_VERSION
    || input.redaction !== "strict_allowlist_no_provider_plaintext_credentials_or_raw_ids") {
    throw new Error("LC4-DEV failure evidence version or redaction boundary is invalid");
  }
  if (!SAFE_ID.test(input.episode_id) || (input.opportunity_id !== null && !SAFE_ID.test(input.opportunity_id))) {
    throw new Error("LC4-DEV failure evidence contains an unsafe episode or opportunity ID");
  }
  if (!STAGES.has(input.failure_stage) || !CODES.has(input.failure_code)
    || !CLASSES.has(input.failure_class) || !TERMINAL_WIRE_TYPES.has(input.terminal_wire_type)
    || !GATEWAY_FATAL_CLASSES.has(input.gateway_fatal_class)) {
    throw new Error("LC4-DEV failure evidence contains a non-allowlisted diagnostic value");
  }
  if (!(["primary_exchange", "cleanup"] as const).includes(input.failure_role)
    || !(["canonical", "repair", null] as const).includes(input.playback_kind)) {
    throw new Error("LC4-DEV failure evidence role or playback kind is invalid");
  }
  if (!(["openai", "gemini", "xai"] as const).includes(input.provider)) {
    throw new Error("LC4-DEV failure evidence provider is invalid");
  }
  if (!input.model.trim() || input.model.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.model)) {
    throw new Error("LC4-DEV failure evidence model identity is invalid");
  }
  for (const [label, value] of Object.entries({
    caller_pcm_byte_length: input.caller_pcm_byte_length,
    caller_pcm_chunk_count: input.caller_pcm_chunk_count,
    caller_pcm_appended_chunk_count: input.caller_pcm_appended_chunk_count,
    caller_pcm_appended_byte_length: input.caller_pcm_appended_byte_length,
    output_pcm_byte_length: input.output_pcm_byte_length,
    output_pcm_chunk_count: input.output_pcm_chunk_count,
    wire_observation_count: input.wire_observation_count,
    gateway_batch_count: input.gateway_batch_count,
  })) requireCount(value, label);
  for (const [label, value] of Object.entries({
    caller_pcm_sha256: input.caller_pcm_sha256,
    output_pcm_sha256: input.output_pcm_sha256,
    terminal_wire_type_sha256: input.terminal_wire_type_sha256,
    terminal_wire_observation_sha256: input.terminal_wire_observation_sha256,
    secondary_failure_evidence_sha256: input.secondary_failure_evidence_sha256,
  })) requireHashOrNull(value, label);
  const operationIndexes = input.operation_order.map((operation) => OPERATIONS.indexOf(operation));
  if (operationIndexes.some((index) => index < 0)
    || new Set(input.operation_order).size !== input.operation_order.length) {
    throw new Error("LC4-DEV failure evidence operation order is not a unique allowlisted progression");
  }
  const operationIndex = (operation: Lc4DevFailureOperation) => input.operation_order.indexOf(operation);
  const requireBefore = (before: Lc4DevFailureOperation, after: Lc4DevFailureOperation) => {
    const beforeIndex = operationIndex(before);
    const afterIndex = operationIndex(after);
    if (afterIndex >= 0 && (beforeIndex < 0 || beforeIndex >= afterIndex)) {
      throw new Error(`LC4-DEV failure evidence operation progression requires ${before} before ${after}`);
    }
  };
  requireBefore("response_plan_session_update_sent", "response_plan_session_update_acknowledged");
  requireBefore("response_plan_session_update_acknowledged", "server_vad_speech_started");
  requireBefore("caller_pcm_delivery_started", "caller_pcm_delivery_completed");
  requireBefore("caller_pcm_delivery_started", "server_vad_speech_started");
  requireBefore("server_vad_speech_started", "server_vad_speech_stopped");
  requireBefore("server_vad_speech_stopped", "caller_pcm_auto_committed");
  requireBefore("caller_pcm_auto_committed", "response_generation_auto_started");
  requireBefore("caller_pcm_delivery_completed", "response_plan_prepared");
  requireBefore("response_plan_prepared", "caller_pcm_committed");
  requireBefore("caller_pcm_committed", "caller_pcm_commit_acknowledged");
  requireBefore("caller_pcm_committed", "response_generation_requested");
  if (operationIndex("response_generation_started") >= 0) {
    const requestIndex = operationIndex("response_generation_requested");
    const autoIndex = operationIndex("response_generation_auto_started");
    const startedIndex = operationIndex("response_generation_started");
    if ((requestIndex < 0 || requestIndex >= startedIndex)
      && (autoIndex < 0 || autoIndex >= startedIndex)) {
      throw new Error("LC4-DEV failure evidence operation progression lacks a causal response trigger");
    }
  }
  requireBefore("response_generation_started", "response_terminal_observed");
  requireBefore("response_terminal_observed", "assistant_pcm_captured");
  requireBefore("assistant_pcm_captured", "listener_evidence_handed_off");
  const booleans = [
    input.response_generation_requested,
    input.response_generation_started,
    input.response_terminal_observed,
    input.response_completed,
  ];
  if (booleans.some((value) => typeof value !== "boolean")) {
    throw new Error("LC4-DEV failure evidence response flags must be boolean");
  }
  const providerAutoStarted = input.operation_order.includes("response_generation_auto_started");
  const generationTriggered = input.response_generation_requested || providerAutoStarted;
  if ((input.response_generation_started
      && !input.response_generation_requested
      && !providerAutoStarted)
    || (input.response_terminal_observed && !generationTriggered)
    || (input.response_completed && (!input.response_generation_started || !input.response_terminal_observed))) {
    throw new Error("LC4-DEV failure evidence response lifecycle is inconsistent");
  }
  const operationSet = new Set(input.operation_order);
  if (operationSet.has("response_generation_requested") !== input.response_generation_requested
    || operationSet.has("response_generation_started") !== input.response_generation_started
    || operationSet.has("response_terminal_observed") !== input.response_terminal_observed
    || operationSet.has("assistant_pcm_captured") !== (input.output_pcm_byte_length > 0)) {
    throw new Error("LC4-DEV failure evidence lifecycle flags differ from its operation progression");
  }
  if (input.caller_pcm_appended_chunk_count > input.caller_pcm_chunk_count) {
    throw new Error("LC4-DEV failure evidence appended more audio chunks than were planned");
  }
  if (input.caller_pcm_appended_byte_length > input.caller_pcm_byte_length) {
    throw new Error("LC4-DEV failure evidence appended more audio bytes than were planned");
  }
  if ((input.output_pcm_chunk_count === 0) !== (input.output_pcm_byte_length === 0)) {
    throw new Error("LC4-DEV failure evidence output audio counts are inconsistent");
  }
  if ((input.output_pcm_byte_length === 0) !== (input.output_pcm_sha256 === null)) {
    throw new Error("LC4-DEV failure evidence output audio hash is inconsistent");
  }
  if (input.wire_observation_count === 0
    ? input.terminal_wire_type !== "none" || input.terminal_wire_type_sha256 !== null || input.terminal_wire_observation_sha256 !== null
    : input.terminal_wire_type === "none" || input.terminal_wire_type_sha256 === null || input.terminal_wire_observation_sha256 === null) {
    throw new Error("LC4-DEV failure evidence terminal wire commitment is inconsistent");
  }
  if (input.failure_role === "cleanup") {
    if (input.failure_stage !== "segment_close" || input.failure_code !== "segment_close_failed" || input.failure_class !== "cleanup") {
      throw new Error("LC4-DEV cleanup failure evidence must use the cleanup classification");
    }
  } else if (input.secondary_failure_evidence_sha256 !== null) {
    throw new Error("LC4-DEV primary failure evidence cannot reference a secondary failure");
  }
  // Construct the persisted object field-by-field. This is an intentional
  // runtime allowlist: callers cannot smuggle an Error, provider payload,
  // transcript, credential, or raw identifier through an excess property.
  const body = immutableJson({
    schema_version: input.schema_version,
    evidence_version: input.evidence_version,
    redaction: input.redaction,
    failure_role: input.failure_role,
    failure_stage: input.failure_stage,
    failure_code: input.failure_code,
    failure_class: input.failure_class,
    episode_id: input.episode_id,
    opportunity_id: input.opportunity_id,
    provider: input.provider,
    model: input.model,
    playback_kind: input.playback_kind,
    operation_order: input.operation_order,
    caller_pcm_sha256: input.caller_pcm_sha256,
    caller_pcm_byte_length: input.caller_pcm_byte_length,
    caller_pcm_chunk_count: input.caller_pcm_chunk_count,
    caller_pcm_appended_chunk_count: input.caller_pcm_appended_chunk_count,
    caller_pcm_appended_byte_length: input.caller_pcm_appended_byte_length,
    response_generation_requested: input.response_generation_requested,
    response_generation_started: input.response_generation_started,
    response_terminal_observed: input.response_terminal_observed,
    response_completed: input.response_completed,
    output_pcm_sha256: input.output_pcm_sha256,
    output_pcm_byte_length: input.output_pcm_byte_length,
    output_pcm_chunk_count: input.output_pcm_chunk_count,
    wire_observation_count: input.wire_observation_count,
    terminal_wire_type: input.terminal_wire_type,
    terminal_wire_type_sha256: input.terminal_wire_type_sha256,
    terminal_wire_observation_sha256: input.terminal_wire_observation_sha256,
    gateway_batch_count: input.gateway_batch_count,
    gateway_fatal_class: input.gateway_fatal_class,
    secondary_failure_evidence_sha256: input.secondary_failure_evidence_sha256,
  }) as unknown as Lc4DevFailureEvidenceBody;
  return Object.freeze({
    ...body,
    failure_evidence_sha256: sha256Hex(`${LC4_DEV_FAILURE_EVIDENCE_DOMAIN}${canonicalJson(body)}`),
  });
}

export class Lc4DevFailureEvidenceError extends Error {
  readonly failure: Lc4DevFailureEvidence;
  readonly retained_evidence: Lc4DevReplayArtifactReference | null;

  constructor(failure: Lc4DevFailureEvidence, retainedEvidence: Lc4DevReplayArtifactReference | null = null) {
    super(`LC4-DEV exchange failed: ${failure.failure_code}`);
    this.name = "Lc4DevFailureEvidenceError";
    this.failure = failure;
    this.retained_evidence = retainedEvidence;
  }
}

export function isLc4DevFailureEvidenceError(value: unknown): value is Lc4DevFailureEvidenceError {
  return value instanceof Lc4DevFailureEvidenceError;
}
