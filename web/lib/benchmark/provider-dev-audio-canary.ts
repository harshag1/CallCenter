import { canonicalJson, sha256Hex } from "./artifacts";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import {
  trialAudioDeliveryProfileHash,
  type TrialAudioDeliveryProfile,
} from "./orchestrator";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  Pcm16Audio,
  RealtimeWireObservation,
} from "../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
} from "../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  verifyRealtimeWireObservationChain,
} from "../realtime/client/wire-evidence";
import {
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  type Lc4DevSemanticIntent,
} from "./lc4-development-gateway-bridge";
import {
  RealtimeAudioDeliveryError,
  SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME,
  deliverRealtimePcm16,
  packetizeRealtimePcm16,
  type RealtimeAudioDeliveryRuntime,
} from "../realtime/audio-delivery";

export const LC4_DEV_AUDIO_CANARY_VERSION = "HACC-LC4-DEV-AUDIO-CANARY-v1" as const;
export const LC4_DEV_AUDIO_CANARY_CONTROL_BYTES = 35_518 as const;
export const LC4_DEV_AUDIO_CANARY_CONTROL_SOURCE_SHA256 = "5dec812caaaa3a242be2f3157a136e20b3e3e8553f67a8acfc8fb92a2ef9f53c" as const;
export const LC4_DEV_AUDIO_CANARY_INTENT = "complete_current_stage" as const satisfies Lc4DevSemanticIntent;
export const LC4_DEV_AUDIO_CANARY_TOOL_SCHEMA_SHA256 = sha256Hex(
  `harshas-amazing-call-center/provider-tool-schema/v1\n${canonicalJson([LC4_DEV_SEMANTIC_GATEWAY_FUNCTION])}`,
);
export const LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256 = sha256Hex(
  `harshas-amazing-call-center/realtime-audio-delivery-contract/v1\n${canonicalJson({
    packetizer: "packetizeRealtimePcm16",
    delivery: "deliverRealtimePcm16",
    frame_boundary: "sample_rate_times_chunk_ms_exact_pcm16",
    pacing: "absolute_realtime_deadlines",
    required_profile: { schemaVersion: 1, chunkMs: 20, pace: "realtime" },
  })}`,
);

const CONTROL_PREFIX = [
  "This is an LC4 transport qualification with synthetic non-semantic audio, not a caller conversation.",
  `Call ${LOCAL_TOOL_PROXY_FUNCTION_NAME} exactly once with tool_name ${LC4_DEV_AUDIO_CANARY_INTENT} and arguments {}.`,
  "Do not speak, do not answer in text, and do not call any other tool.",
  "The remaining bytes are inert transport-size padding:",
].join(" ");
const CONTROL_PADDING_OPEN = "\n<lc4_qualification_padding>";
const CONTROL_PADDING_CLOSE = "</lc4_qualification_padding>";

export type Lc4DevAudioCanaryDeliveryReceipt = Readonly<{
  packetizer_version: string;
  packetizer_sha256: string;
  delivery_profile_sha256: string;
  audio_sha256: string;
  audio_bytes: number;
  chunk_count: number;
  chunk_bytes: readonly number[];
  chunk_sha256: readonly string[];
  scheduled_offset_ms: readonly number[];
}>;

export type Lc4DevAudioCanaryDeliver = (input: Readonly<{
  client: NormalizedRealtimeClient;
  audio: Pcm16Audio;
  profile: TrialAudioDeliveryProfile;
  runtime: RealtimeAudioDeliveryRuntime;
  signal: AbortSignal;
}>) => Promise<Lc4DevAudioCanaryDeliveryReceipt>;

export type Lc4DevAudioCanarySpecification = Readonly<{
  provider: LiveStsProvider;
  model: string;
  tool_schema_sha256: string;
  control_bytes: number;
  control_sha256: string;
  control_source_sha256: string;
  audio_bytes: number;
  audio_sha256: string;
  sample_rate_hz: number;
  required_minimum_chunks: 2;
}>;

export type Lc4DevAudioCanaryCode =
  | "dev_gateway_tool_call_observed"
  | "dev_gateway_tool_call_not_observed"
  | "audio_delivery_contract_failed"
  | "response_generation_failed";

export type Lc4DevAudioCanaryFailureEvidence = Readonly<{
  schema_version: 1;
  provider: LiveStsProvider;
  model: string;
  status: "passed" | "failed";
  code: Lc4DevAudioCanaryCode;
  failure_class: "none" | "audio_delivery_contract_failed" | "response_generation_failed";
  primary: true;
  operation_order: readonly string[];
  input_audio: Readonly<{
    bytes: number;
    chunks: number;
    sha256: string;
    complete: boolean;
  }>;
  response: Readonly<{
    requested: boolean;
    gateway_call_observed: boolean;
  }>;
  wire: Readonly<{
    count: number;
    terminal_type: string | null;
    terminal_observation_sha256: string | null;
  }>;
}>;

export type Lc4DevAudioCanaryExecution = Readonly<{
  provider: LiveStsProvider;
  model: string;
  attemptedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  code: Lc4DevAudioCanaryCode;
  specification: Lc4DevAudioCanarySpecification;
  delivery: Lc4DevAudioCanaryDeliveryReceipt | null;
  callerAudioBytes: number;
  responseGenerationRequested: boolean;
  responseGenerationEvidenceSha256: string;
  providerToolCallEvidence: Readonly<Record<string, unknown>> | null;
  providerToolCallEvidenceSha256: string | null;
  sanitizedFailureEvidence: Lc4DevAudioCanaryFailureEvidence;
  failureEvidenceSha256: string;
  wireObservations: readonly RealtimeWireObservation[];
  usage: readonly NormalizedRealtimeUsage[];
}>;

export function lc4DevAudioCanaryFailureEvidenceSha256(evidence: Lc4DevAudioCanaryFailureEvidence): string {
  return sha256Hex(
    `harshas-amazing-call-center/lc4-dev-audio-failure-evidence/v1\n${canonicalJson(evidence)}`,
  );
}

type Input = Readonly<{
  provider: LiveStsProvider;
  model: string;
  client: NormalizedRealtimeClient;
  sampleRateHz: number;
  profile: TrialAudioDeliveryProfile;
  deliverAudio?: Lc4DevAudioCanaryDeliver;
  audioDeliveryRuntime?: RealtimeAudioDeliveryRuntime;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}>;

export function lc4DevAudioCanaryControl(): string {
  const fixed = `${CONTROL_PREFIX}${CONTROL_PADDING_OPEN}${CONTROL_PADDING_CLOSE}`;
  const remaining = LC4_DEV_AUDIO_CANARY_CONTROL_BYTES - Buffer.byteLength(fixed, "utf8");
  if (remaining < 1) throw new Error("LC4 DEV audio canary control prefix exceeds its frozen size");
  const control = `${CONTROL_PREFIX}${CONTROL_PADDING_OPEN}${"x".repeat(remaining)}${CONTROL_PADDING_CLOSE}`;
  if (Buffer.byteLength(control, "utf8") !== LC4_DEV_AUDIO_CANARY_CONTROL_BYTES) {
    throw new Error("LC4 DEV audio canary control size drifted");
  }
  return control;
}

export function createLc4DevAudioCanaryPcm(sampleRateHz: number): Pcm16Audio {
  if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 96_000) {
    throw new Error("LC4 DEV audio canary sample rate is invalid");
  }
  // Forty milliseconds guarantees at least two 20 ms packets. A deterministic,
  // low-amplitude dual tone proves real PCM transport while encoding no speech.
  const samples = Math.round(sampleRateHz * 0.04);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) {
    const first = Math.sin(2 * Math.PI * 440 * index / sampleRateHz);
    const second = Math.sin(2 * Math.PI * 660 * index / sampleRateHz);
    view.setInt16(index * 2, Math.round((first + second) * 1_200), true);
  }
  return Object.freeze({
    encoding: "pcm16" as const,
    sampleRateHz,
    channels: 1 as const,
    data: bytes,
  });
}

export function lc4DevAudioCanarySpecification(provider: LiveStsProvider, model: string, sampleRateHz: number): Lc4DevAudioCanarySpecification {
  const audio = createLc4DevAudioCanaryPcm(sampleRateHz);
  const control = lc4DevAudioCanaryControl();
  return Object.freeze({
    provider,
    model,
    tool_schema_sha256: LC4_DEV_AUDIO_CANARY_TOOL_SCHEMA_SHA256,
    control_bytes: Buffer.byteLength(control, "utf8"),
    control_sha256: sha256Hex(control),
    control_source_sha256: LC4_DEV_AUDIO_CANARY_CONTROL_SOURCE_SHA256,
    audio_bytes: audio.data.byteLength,
    audio_sha256: sha256Hex(audio.data),
    sample_rate_hz: sampleRateHz,
    required_minimum_chunks: 2 as const,
  });
}

type ControlledDevGatewayCall = Readonly<{
  evidence: Readonly<Record<string, unknown>>;
  callId: string;
  responseId: string;
  wireObservationSha256: string;
}>;

function devGatewayCall(event: NormalizedRealtimeEvent): ControlledDevGatewayCall | null {
  if (event.type === "tool.dispatch") {
    if (event.wireObservation?.availability !== "observed" || event.gateway !== LOCAL_TOOL_PROXY_FUNCTION_NAME || event.dispatches.length !== 1) return null;
    const dispatch = event.dispatches[0]!;
    const request = dispatch.request;
    const providerCallId = request.params._meta[LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY];
    const provenance = request.params._meta[PROVIDER_PROVENANCE_META_KEY];
    if (request.method !== "tools/call"
      || request.params.name !== LC4_DEV_AUDIO_CANARY_INTENT
      || request.params.arguments === null
      || typeof request.params.arguments !== "object"
      || Array.isArray(request.params.arguments)
      || Object.keys(request.params.arguments).length !== 0
      || providerCallId !== dispatch.callId
      || provenance !== dispatch.provenance
      || dispatch.provenance.nativeCallId !== dispatch.callId
      || dispatch.provenance.nativeResponseId !== event.responseId) return null;
    return Object.freeze({
      callId: dispatch.callId,
      responseId: event.responseId,
      wireObservationSha256: event.wireObservation.observationSha256,
      evidence: Object.freeze({
        evidence_kind: "provenance_bound_lc4_dev_gateway_dispatch",
        provider: event.provider,
        response_id_sha256: realtimeWireIdentitySha256("response", event.responseId),
        call_id_sha256: realtimeWireIdentitySha256("call", dispatch.callId),
        semantic_intent: request.params.name,
        arguments_sha256: sha256Hex(canonicalJson(request.params.arguments)),
        terminal_wire_type: dispatch.provenance.terminalWireType,
        wire_observation_sha256: event.wireObservation.observationSha256,
        provenance_sha256: sha256Hex(canonicalJson(dispatch.provenance)),
      }),
    });
  }
  if (event.type !== "tool.calls" || event.provider !== "gemini" || event.wireObservation?.availability !== "observed") return null;
  const matching = event.calls.filter((call) => {
    if (call.name !== LOCAL_TOOL_PROXY_FUNCTION_NAME || call.argumentsJson === null || typeof call.argumentsJson !== "object") return false;
    const args = call.argumentsJson as Record<string, unknown>;
    return args.tool_name === LC4_DEV_AUDIO_CANARY_INTENT
      && args.arguments !== null
      && typeof args.arguments === "object"
      && !Array.isArray(args.arguments)
      && Object.keys(args.arguments as Record<string, unknown>).length === 0;
  });
  if (matching.length !== 1 || event.calls.length !== 1) return null;
  const call = matching[0]!;
  return Object.freeze({
    callId: call.callId,
    responseId: event.responseId,
    wireObservationSha256: event.wireObservation.observationSha256,
    evidence: Object.freeze({
      evidence_kind: "wire_bound_lc4_dev_gateway_call",
      provider: event.provider,
      response_id_sha256: realtimeWireIdentitySha256("response", event.responseId),
      call_id_sha256: realtimeWireIdentitySha256("call", call.callId),
      semantic_intent: LC4_DEV_AUDIO_CANARY_INTENT,
      arguments_sha256: sha256Hex(call.argumentsText),
      terminal_wire_type: call.terminalWireType,
      wire_observation_sha256: event.wireObservation.observationSha256,
    }),
  });
}

export function lc4DevAudioCanaryProviderToolCallEvidenceSha256(
  evidence: Readonly<Record<string, unknown>>,
): string {
  return sha256Hex(
    `harshas-amazing-call-center/lc4-dev-audio-tool-call-evidence/v1\n${canonicalJson(evidence)}`,
  );
}

export function assertLc4DevAudioCanaryExecutionEvidence(
  execution: Lc4DevAudioCanaryExecution,
): void {
  const evidence = execution.providerToolCallEvidence;
  const evidenceSha256 = execution.providerToolCallEvidenceSha256;
  if (execution.status !== "passed") {
    if (evidence !== null || evidenceSha256 !== null) {
      throw new Error("failed LC4 DEV audio canary cannot retain passing tool-call evidence");
    }
    return;
  }
  const verification = verifyRealtimeWireObservationChain(execution.wireObservations);
  if (!verification.valid) throw new Error("LC4 DEV audio canary retained wire chain is invalid");
  if (evidence === null
    || evidenceSha256 === null
    || lc4DevAudioCanaryProviderToolCallEvidenceSha256(evidence) !== evidenceSha256) {
    throw new Error("passing LC4 DEV audio canary tool-call evidence is absent or hash-mismatched");
  }
  const expectedKind = execution.provider === "gemini"
    ? "wire_bound_lc4_dev_gateway_call"
    : "provenance_bound_lc4_dev_gateway_dispatch";
  if (evidence.evidence_kind !== expectedKind
    || evidence.provider !== execution.provider
    || evidence.semantic_intent !== LC4_DEV_AUDIO_CANARY_INTENT
    || typeof evidence.terminal_wire_type !== "string"
    || !/^[a-f0-9]{64}$/u.test(String(evidence.response_id_sha256))
    || !/^[a-f0-9]{64}$/u.test(String(evidence.call_id_sha256))
    || !/^[a-f0-9]{64}$/u.test(String(evidence.arguments_sha256))
    || !/^[a-f0-9]{64}$/u.test(String(evidence.response_trigger_wire_observation_sha256))
    || !/^[a-f0-9]{64}$/u.test(String(evidence.response_started_wire_observation_sha256))
    || !/^[a-f0-9]{64}$/u.test(String(evidence.wire_observation_sha256))) {
    throw new Error("passing LC4 DEV audio canary tool-call evidence contract is invalid");
  }
  const triggerIndex = execution.wireObservations.findIndex(
    (candidate) => candidate.observationSha256 === evidence.response_trigger_wire_observation_sha256,
  );
  const responseStartedIndex = execution.wireObservations.findIndex(
    (candidate) => candidate.observationSha256 === evidence.response_started_wire_observation_sha256,
  );
  const callIndex = execution.wireObservations.findIndex(
    (candidate) => candidate.observationSha256 === evidence.wire_observation_sha256,
  );
  const trigger = execution.wireObservations[triggerIndex];
  const responseStarted = execution.wireObservations[responseStartedIndex];
  const observation = execution.wireObservations.find(
    (candidate) => candidate.observationSha256 === evidence.wire_observation_sha256,
  );
  if (trigger?.direction !== "outbound"
    || trigger.provider !== execution.provider
    || trigger.wireType !== (execution.provider === "gemini" ? "realtimeInput.activityEnd" : "response.create")
    || responseStarted?.direction !== "inbound"
    || responseStarted.provider !== execution.provider
    || responseStarted.identities.responseIdSha256 !== evidence.response_id_sha256
    || triggerIndex < 0
    || responseStartedIndex <= triggerIndex
    || (execution.provider === "gemini" ? callIndex < responseStartedIndex : callIndex <= responseStartedIndex)
    || observation?.direction !== "inbound"
    || observation.provider !== execution.provider
    || observation.wireType !== evidence.terminal_wire_type
    || observation.identities.responseIdSha256 !== evidence.response_id_sha256
    || observation.identities.callIdSha256 !== evidence.call_id_sha256) {
    throw new Error("passing LC4 DEV audio canary tool call is not bound to its retained provider frame");
  }
}

function observationForReference(
  observations: readonly RealtimeWireObservation[],
  reference: Readonly<{
    observationSha256: string;
    connectionEpoch: number;
    sequence: number;
    payloadSha256: string;
    projectionSha256: string;
  }>,
): RealtimeWireObservation | null {
  return observations.find((observation) => (
    observation.observationSha256 === reference.observationSha256
    && observation.connectionEpoch === reference.connectionEpoch
    && observation.sequence === reference.sequence
    && observation.payloadSha256 === reference.payloadSha256
    && observation.projectionSha256 === reference.projectionSha256
  )) ?? null;
}

function callIsBoundToRetainedWire(input: Readonly<{
  candidate: ControlledDevGatewayCall;
  responseStartedObservationSha256: string;
  triggerObservationSha256: string;
  observations: readonly RealtimeWireObservation[];
}>): boolean {
  const verification = verifyRealtimeWireObservationChain(input.observations);
  if (!verification.valid) return false;
  const triggerIndex = input.observations.findIndex(
    (observation) => observation.observationSha256 === input.triggerObservationSha256,
  );
  const responseStartedIndex = input.observations.findIndex(
    (observation) => observation.observationSha256 === input.responseStartedObservationSha256,
  );
  const callIndex = input.observations.findIndex(
    (observation) => observation.observationSha256 === input.candidate.wireObservationSha256,
  );
  if (triggerIndex < 0
    || responseStartedIndex <= triggerIndex
    || (input.candidate.evidence.provider === "gemini"
      ? callIndex < responseStartedIndex
      : callIndex <= responseStartedIndex)) return false;
  const callObservation = input.observations[callIndex]!;
  return callObservation.direction === "inbound"
    && callObservation.provider === input.candidate.evidence.provider
    && callObservation.wireType === input.candidate.evidence.terminal_wire_type
    && callObservation.identities.responseIdSha256 === realtimeWireIdentitySha256("response", input.candidate.responseId)
    && callObservation.identities.callIdSha256 === realtimeWireIdentitySha256("call", input.candidate.callId);
}

function sanitizedEvent(event: NormalizedRealtimeEvent): Readonly<Record<string, unknown>> {
  const wireObservationSha256 = event.wireObservation?.availability === "observed"
    ? event.wireObservation.observationSha256
    : null;
  if (event.type === "response.started" || event.type === "response.completed") {
    return Object.freeze({
      type: event.type,
      provider: event.provider,
      response_id_sha256: sha256Hex(event.responseId),
      wire_type: event.wireType,
      wire_observation_sha256: wireObservationSha256,
      ...(event.type === "response.completed" ? { status: event.status } : {}),
    });
  }
  if (event.type === "error") {
    return Object.freeze({
      type: event.type,
      provider: event.provider,
      code: event.code ?? "provider_error",
      fatal: event.fatal,
      wire_type: event.wireType,
      wire_observation_sha256: wireObservationSha256,
    });
  }
  return Object.freeze({ type: event.type, provider: event.provider, wire_type: event.wireType });
}

function validDelivery(
  specification: Lc4DevAudioCanarySpecification,
  delivery: Lc4DevAudioCanaryDeliveryReceipt,
  profile: TrialAudioDeliveryProfile,
): boolean {
  const audio = createLc4DevAudioCanaryPcm(specification.sample_rate_hz);
  const expected = packetizeRealtimePcm16(audio, profile);
  if (delivery.packetizer_sha256 !== LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256
    || delivery.delivery_profile_sha256 !== trialAudioDeliveryProfileHash(profile)
    || delivery.audio_sha256 !== specification.audio_sha256
    || delivery.audio_bytes !== specification.audio_bytes
    || delivery.chunk_count < specification.required_minimum_chunks
    || delivery.chunk_count !== delivery.chunk_bytes.length
    || delivery.chunk_count !== delivery.chunk_sha256.length
    || delivery.chunk_count !== delivery.scheduled_offset_ms.length
    || delivery.chunk_bytes.some((bytes) => !Number.isSafeInteger(bytes) || bytes < 2 || bytes % 2 !== 0)
    || delivery.chunk_sha256.some((digest) => !/^[a-f0-9]{64}$/u.test(digest))
    || delivery.chunk_bytes.reduce((sum, bytes) => sum + bytes, 0) !== specification.audio_bytes
    || canonicalJson(delivery.chunk_bytes) !== canonicalJson(expected.frames.map((frame) => frame.data.byteLength))
    || canonicalJson(delivery.chunk_sha256) !== canonicalJson(expected.frames.map((frame) => sha256Hex(frame.data)))) return false;
  return delivery.scheduled_offset_ms.every((offset, index) => offset === index * profile.chunkMs);
}

/**
 * The only production delivery path for the DEV audio canary. The injectable
 * `deliverAudio` seam on the executor exists solely so tests can prove forged,
 * single-frame, or unpaced receipts fail closed.
 */
export async function deliverLc4DevAudioCanaryWithProductionPacketizer(input: Readonly<{
  client: NormalizedRealtimeClient;
  audio: Pcm16Audio;
  profile: TrialAudioDeliveryProfile;
  runtime: RealtimeAudioDeliveryRuntime;
  signal: AbortSignal;
}>): Promise<Lc4DevAudioCanaryDeliveryReceipt> {
  const plan = packetizeRealtimePcm16(input.audio, input.profile);
  const receipt = await deliverRealtimePcm16({
    client: input.client,
    audio: input.audio,
    profile: input.profile,
    runtime: input.runtime,
    signal: input.signal,
  });
  if (receipt.chunk_count !== plan.frames.length
    || receipt.total_byte_length !== plan.total_byte_length
    || canonicalJson(receipt.chunks.map((chunk) => chunk.byte_length))
      !== canonicalJson(plan.frames.map((frame) => frame.data.byteLength))) {
    throw new Error("LC4 DEV audio delivery receipt does not match the production packetizer plan");
  }
  return Object.freeze({
    packetizer_version: "HACC-REALTIME-AUDIO-DELIVERY-v1",
    packetizer_sha256: LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
    delivery_profile_sha256: trialAudioDeliveryProfileHash(input.profile),
    audio_sha256: sha256Hex(input.audio.data),
    audio_bytes: receipt.total_byte_length,
    chunk_count: receipt.chunk_count,
    chunk_bytes: Object.freeze(receipt.chunks.map((chunk) => chunk.byte_length)),
    chunk_sha256: Object.freeze(plan.frames.map((frame) => sha256Hex(frame.data))),
    scheduled_offset_ms: Object.freeze(receipt.chunks.map((chunk) => chunk.scheduled_offset_ms)),
  });
}

export async function executeLc4DevAudioCanary(input: Input): Promise<Lc4DevAudioCanaryExecution> {
  const now = input.now ?? (() => new Date());
  const attemptedAt = now().toISOString();
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("LC4 DEV audio canary timeout must be 1000..60000ms");
  }
  if (input.client.provider !== input.provider) throw new Error("LC4 DEV audio canary client provider mismatch");
  const specification = lc4DevAudioCanarySpecification(input.provider, input.model, input.sampleRateHz);
  const audio = createLc4DevAudioCanaryPcm(input.sampleRateHz);
  const control = lc4DevAudioCanaryControl();
  const wireObservations: RealtimeWireObservation[] = [];
  const usage: NormalizedRealtimeUsage[] = [];
  const responseEvidence: Readonly<Record<string, unknown>>[] = [];
  const operationOrder: string[] = [];
  const responseStartedObservations = new Map<string, string>();
  let callEvidence: Readonly<Record<string, unknown>> | null = null;
  const acceptedCallRef: { current: ControlledDevGatewayCall | null } = { current: null };
  let delivery: Lc4DevAudioCanaryDeliveryReceipt | null = null;
  let callerAudioBytes = 0;
  let callerAudioChunks = 0;
  let responseTriggerInvoked = false;
  let triggerObservationSha256: string | null = null;
  let failureClass: "none" | "audio_delivery_contract_failed" | "response_generation_failed" = "none";
  let finish: (() => void) | null = null;
  const terminal = new Promise<void>((resolve) => { finish = resolve; });
  const unsubscribeWire = input.client.onWireObservation?.((observation) => {
    wireObservations.push(observation);
    const expectedTriggerWireType = input.provider === "gemini"
      ? "realtimeInput.activityEnd"
      : "response.create";
    if (responseTriggerInvoked
      && triggerObservationSha256 === null
      && observation.provider === input.provider
      && observation.direction === "outbound"
      && observation.wireType === expectedTriggerWireType) {
      triggerObservationSha256 = observation.observationSha256;
    }
  });
  const unsubscribeEvent = input.client.onEvent((event) => {
    if (event.type === "usage") usage.push(event.usage);
    if (event.type === "response.started" || event.type === "response.completed" || event.type === "error") {
      responseEvidence.push(sanitizedEvent(event));
    }
    if (event.type === "response.started"
      && responseTriggerInvoked
      && triggerObservationSha256 !== null
      && event.wireObservation?.availability === "observed") {
      const observation = observationForReference(wireObservations, event.wireObservation);
      const triggerIndex = wireObservations.findIndex(
        (candidate) => candidate.observationSha256 === triggerObservationSha256,
      );
      const startedIndex = observation === null ? -1 : wireObservations.indexOf(observation);
      if (observation?.direction === "inbound"
        && observation.provider === input.provider
        && observation.identities.responseIdSha256 === realtimeWireIdentitySha256("response", event.responseId)
        && startedIndex > triggerIndex
        && verifyRealtimeWireObservationChain(wireObservations).valid) {
        responseStartedObservations.set(event.responseId, observation.observationSha256);
      }
    }
    const candidate = event.provider === input.provider ? devGatewayCall(event) : null;
    const responseStartedObservationSha256 = candidate === null
      ? undefined
      : responseStartedObservations.get(candidate.responseId);
    const controlled = candidate
      && triggerObservationSha256 !== null
      && responseStartedObservationSha256 !== undefined
      && callIsBoundToRetainedWire({
        candidate,
        responseStartedObservationSha256,
        triggerObservationSha256,
        observations: wireObservations,
      })
      ? candidate
      : null;
    if (controlled) {
      const boundEvidence = Object.freeze({
        ...controlled.evidence,
        response_trigger_wire_observation_sha256: triggerObservationSha256,
        response_started_wire_observation_sha256: responseStartedObservationSha256,
      });
      acceptedCallRef.current = Object.freeze({ ...controlled, evidence: boundEvidence });
      callEvidence = boundEvidence;
      responseEvidence.push(Object.freeze({
        type: "lc4_dev_gateway_tool_call_observed",
        evidence_sha256: sha256Hex(canonicalJson(boundEvidence)),
      }));
      finish?.();
    } else if (event.type === "tool.dispatch"
      || (event.type === "tool.calls" && event.provider === "gemini")
      || event.type === "response.completed"
      || event.type === "error") {
      failureClass = "response_generation_failed";
      finish?.();
    }
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await input.client.connect();
    operationOrder.push("session_ready");
    if (input.client.state !== "ready") throw new Error("LC4 DEV audio canary client did not remain ready");
    delivery = await (input.deliverAudio ?? deliverLc4DevAudioCanaryWithProductionPacketizer)({
      client: input.client,
      audio,
      profile: input.profile,
      runtime: input.audioDeliveryRuntime ?? SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME,
      signal: input.signal ?? new AbortController().signal,
    });
    callerAudioBytes = delivery.audio_bytes;
    callerAudioChunks = delivery.chunk_count;
    operationOrder.push("caller_pcm_packetized_and_paced");
    if (!validDelivery(specification, delivery, input.profile)) {
      failureClass = "audio_delivery_contract_failed";
      throw new Error("LC4 DEV audio canary delivery receipt is invalid");
    }
    input.client.prepareResponse({
      additionalInstructions: control,
      contextSha256: specification.control_sha256,
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
    });
    operationOrder.push("maximum_control_prepared");
    if (input.provider === "gemini") responseTriggerInvoked = true;
    input.client.commitInputAudio();
    operationOrder.push("caller_pcm_committed");
    if (input.provider !== "gemini") responseTriggerInvoked = true;
    input.client.createResponse();
    operationOrder.push("response_generation_requested");
    await Promise.race([
      terminal,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch (error) {
    if (error instanceof RealtimeAudioDeliveryError) {
      callerAudioBytes = error.bytes_appended;
      callerAudioChunks = error.chunks_appended;
    }
    if (failureClass === "none") failureClass = delivery === null
      ? "audio_delivery_contract_failed"
      : "response_generation_failed";
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribeEvent();
    unsubscribeWire?.();
    input.client.close(1000, "LC4 DEV audio canary complete");
  }
  const acceptedCall = acceptedCallRef.current;
  if (acceptedCall !== null) {
    const responseStartedObservationSha256 = responseStartedObservations.get(acceptedCall.responseId);
    if (triggerObservationSha256 === null
      || responseStartedObservationSha256 === undefined
      || !callIsBoundToRetainedWire({
        candidate: acceptedCall,
        responseStartedObservationSha256,
        triggerObservationSha256,
        observations: wireObservations,
      })) {
      callEvidence = null;
      failureClass = "response_generation_failed";
    }
  }
  const status = callEvidence ? "passed" as const : "failed" as const;
  const code = callEvidence
    ? "dev_gateway_tool_call_observed" as const
    : failureClass === "audio_delivery_contract_failed"
      ? "audio_delivery_contract_failed" as const
      : failureClass === "response_generation_failed"
        ? "response_generation_failed" as const
        : "dev_gateway_tool_call_not_observed" as const;
  const failureEvidence: Lc4DevAudioCanaryFailureEvidence = Object.freeze({
    schema_version: 1 as const,
    provider: input.provider,
    model: input.model,
    status,
    code,
    failure_class: status === "passed" ? "none" : failureClass === "none" ? "response_generation_failed" : failureClass,
    primary: true as const,
    operation_order: Object.freeze([...operationOrder]),
    input_audio: Object.freeze({
      bytes: callerAudioBytes,
      chunks: callerAudioChunks,
      sha256: delivery?.audio_sha256 ?? specification.audio_sha256,
      complete: delivery !== null,
    }),
    response: Object.freeze({
      requested: operationOrder.includes("response_generation_requested"),
      gateway_call_observed: callEvidence !== null,
    }),
    wire: Object.freeze({
      count: wireObservations.length,
      terminal_type: wireObservations.at(-1)?.wireType ?? null,
      terminal_observation_sha256: wireObservations.at(-1)?.observationSha256 ?? null,
    }),
  });
  const execution = Object.freeze({
    provider: input.provider,
    model: input.model,
    attemptedAt,
    completedAt: now().toISOString(),
    status,
    code,
    specification,
    delivery,
    callerAudioBytes,
    responseGenerationRequested: operationOrder.includes("response_generation_requested"),
    responseGenerationEvidenceSha256: sha256Hex(
      `harshas-amazing-call-center/lc4-dev-audio-response-evidence/v1\n${canonicalJson(responseEvidence)}`,
    ),
    providerToolCallEvidence: callEvidence,
    providerToolCallEvidenceSha256: callEvidence === null
      ? null
      : lc4DevAudioCanaryProviderToolCallEvidenceSha256(callEvidence),
    sanitizedFailureEvidence: failureEvidence,
    failureEvidenceSha256: lc4DevAudioCanaryFailureEvidenceSha256(failureEvidence),
    wireObservations: Object.freeze([...wireObservations]),
    usage: Object.freeze([...usage]),
  });
  assertLc4DevAudioCanaryExecutionEvidence(execution);
  return execution;
}
