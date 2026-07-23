import { canonicalJson, sha256Hex } from "./artifacts";
import type {
  RealtimeWireObservation,
  ServerRealtimeProvider,
} from "../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  verifyRealtimeWireObservationChain,
} from "../realtime/client/wire-evidence";
import {
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
  isAcceptedXaiServerVadSilenceTail,
} from "./xai-server-vad";

export const PROVIDER_ROUNDTRIP_REPLAY_VERSION =
  "HACC-PROVIDER-ROUNDTRIP-REPLAY-v3" as const;

const PUBLIC_EXECUTION_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-public-execution/v3\n";
const REPLAY_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-replay/v3\n";
const SUMMARY_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-summary/v1\n";
const USAGE_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-sanitized-usage/v1\n";
const CAUSAL_BINDING_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-causal-binding/v1\n";
const SEMANTIC_PROJECTION_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-semantic-projection/v1\n";
const SEMANTIC_BINDING_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-semantic-binding/v1\n";
const INPUT_AUDIO_OBSERVATION_LIST_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-input-audio-observations/v1\n";
const INPUT_AUDIO_CHUNK_LIST_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-input-audio-chunks/v1\n";
const OUTPUT_AUDIO_OBSERVATION_LIST_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-output-audio-observations/v1\n";
const OUTPUT_AUDIO_CONTENT_DOMAIN =
  "harshas-amazing-call-center/provider-roundtrip-output-audio-content/v1\n";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

const QUALIFICATION_ROUNDTRIP_SEMANTICS = deepFreeze({
  target_tool_name: "complete_current_stage",
  target_arguments: {},
  result: { ok: true, qualification_stage: "completed" },
});

type QualificationSemanticHashes = Readonly<{
  target_tool_name_sha256: string;
  target_arguments_sha256: string;
  result_sha256: string;
  binding_sha256: string;
}>;

export type RoundtripInputAudioEvidence = Readonly<{
  observation_sha256s: readonly string[];
  observation_list_sha256: string;
  chunk_sha256s: readonly string[];
  chunk_list_sha256: string;
  audio_sha256: string;
  delivery_profile_sha256: string;
  packetizer_sha256: string;
  audio_bytes: number;
  chunk_count: number;
  frame_bytes: number;
  tail_bytes: number;
  sample_rate_hz: number;
  /** Provider-transport delimiter; distinct from and excluded from caller audio. */
  transport_suffix?: RoundtripInputAudioTransportSuffixEvidence;
}>;

export type RoundtripInputAudioTransportSuffixEvidence = Readonly<{
  purpose: "server_vad_end_of_speech_delimiter";
  completion: "full_plan_delivered" | "provider_native_speech_stop";
  policy_sha256: string;
  pcm_sha256: string;
  audio_bytes: number;
  duration_ms: number;
  chunk_sha256s: readonly string[];
  chunk_list_sha256: string;
  chunk_count: number;
  frame_bytes: number;
  tail_bytes: number;
  observation_sha256s: readonly string[];
  observation_list_sha256: string;
}>;

type RoundtripInputAudioTransportSuffixPlan = Omit<
  RoundtripInputAudioTransportSuffixEvidence,
  "observation_sha256s" | "observation_list_sha256"
>;

type RoundtripInputAudioProjectionPlan = Omit<
  RoundtripInputAudioEvidence,
  "observation_sha256s" | "observation_list_sha256" | "transport_suffix"
> & Readonly<{ transport_suffix?: RoundtripInputAudioTransportSuffixPlan }>;

export type RoundtripOutputAudioEvidence = Readonly<{
  observation_sha256s: readonly string[];
  observation_list_sha256: string;
  content_sha256: string;
  audio_bytes: number;
  chunk_count: number;
  sample_rate_hz: number;
  response_id_sha256: string;
}>;

export type RoundtripReplaySummary = Readonly<{
  schema_version: 1;
  provider: ServerRealtimeProvider;
  model: string;
  connection_epoch: 1;
  call: Readonly<{
    observation_sha256: string;
    call_id_sha256: string;
    response_id_sha256: string;
  }>;
  result: Readonly<{
    observation_sha256: string;
    call_id_sha256: string;
  }>;
  continuation: Readonly<{
    request_observation_sha256: string;
    origin_response_id_sha256: string;
    started_observation_sha256: string;
    response_id_sha256: string;
  }>;
  terminal: Readonly<{
    observation_sha256: string;
    response_id_sha256: string;
    status: "completed";
  }>;
  usage: Readonly<{
    evidence_sha256: string;
    response_id_sha256: string;
  }>;
  input_audio: RoundtripInputAudioEvidence;
  output_audio: RoundtripOutputAudioEvidence;
}>;

export type RoundtripUsageCounter =
  | "inputTextTokens"
  | "inputAudioTokens"
  | "cachedInputTokens"
  | "cachedInputTextTokens"
  | "cachedInputAudioTokens"
  | "outputTextTokens"
  | "outputAudioTokens"
  | "totalInputTokens"
  | "totalOutputTokens"
  | "totalTokens"
  | "inputAudioMinutes"
  | "outputAudioMinutes"
  | "billableTextInputEvents";

export type RoundtripSanitizedUsage = Readonly<{
  schema_version: 1;
  source: "provider_reported" | "client_measured_wire_pcm";
  response_id_sha256: string;
  terminal_observation_sha256: string;
  provider_usage_observation_sha256: string | null;
  contributing_wire_observation_sha256s: readonly string[];
  counters: Readonly<Partial<Record<RoundtripUsageCounter, number>>>;
}>;

/**
 * Gemini does not expose provider response IDs. This retained, content-free
 * host artifact is therefore mandatory: it binds the local response identity
 * to the exact input turn, outbound trigger, provider call, tool response, and
 * post-tool continuation on one connection epoch.
 */
export type RoundtripCausalBinding = Readonly<{
  schema_version: 1;
  provider: ServerRealtimeProvider;
  response_id_source: "provider" | "client_local";
  connection_epoch: 1;
  input_turn: number;
  trigger_observation_sha256: string;
  initial_response_id_sha256: string;
  call_id_sha256: string;
  call_response_id_sha256: string;
  call_observation_sha256: string;
  result_observation_sha256: string;
  continuation_request_observation_sha256: string;
  continuation_response_id_sha256: string;
  continuation_start_observation_sha256: string;
  terminal_observation_sha256: string;
  /** Provider usage frame, or the terminal frame for xAI wire-PCM metering. */
  usage_observation_sha256: string;
  usage_response_id_sha256: string;
  evidence_sha256: string;
}>;

export type GeminiRoundtripCausalBinding = RoundtripCausalBinding & Readonly<{
  provider: "gemini";
  response_id_source: "client_local";
}>;

export type ProviderRoundtripReplayInput = Readonly<{
  expected: Readonly<{
    provider: ServerRealtimeProvider;
    model: string;
  }>;
  summary: RoundtripReplaySummary;
  wire_observations: readonly RealtimeWireObservation[];
  sanitized_usage: readonly RoundtripSanitizedUsage[];
  causal_binding?: RoundtripCausalBinding | null;
}>;

export type ProviderRoundtripPublicExecution = Readonly<{
  schema_version: 3;
  replay_version: typeof PROVIDER_ROUNDTRIP_REPLAY_VERSION;
  evidence_class: "provider_tool_roundtrip";
  provider: ServerRealtimeProvider;
  model_sha256: string;
  connection_epoch: 1;
  wire_event_count: number;
  wire_chain_head_sha256: string;
  call_id_sha256: string;
  origin_response_id_sha256: string;
  continuation_response_id_sha256: string;
  call_observation_sha256: string;
  result_observation_sha256: string;
  continuation_request_observation_sha256: string;
  continuation_started_observation_sha256: string;
  terminal_observation_sha256: string;
  final_usage_evidence_sha256: string;
  sanitized_usage_set_sha256: string;
  causal_binding_sha256: string | null;
  gateway_target_tool_name_sha256: string;
  gateway_target_arguments_sha256: string;
  gateway_qualification_result_sha256: string;
  gateway_semantic_binding_sha256: string;
  input_audio_observation_sha256s: readonly string[];
  input_audio_observation_list_sha256: string;
  input_audio_chunk_list_sha256: string;
  input_audio_sha256: string;
  input_audio_bytes: number;
  input_audio_chunk_count: number;
  output_audio_observation_sha256s: readonly string[];
  output_audio_observation_list_sha256: string;
  output_audio_content_sha256: string;
  output_audio_bytes: number;
  output_audio_chunk_count: number;
}>;

export type ProviderRoundtripReplayResult = Readonly<{
  schema_version: 3;
  replay_version: typeof PROVIDER_ROUNDTRIP_REPLAY_VERSION;
  valid: boolean;
  errors: readonly string[];
  public_execution: ProviderRoundtripPublicExecution | null;
  public_execution_sha256: string | null;
  replay_sha256: string | null;
}>;

type WireFact = Readonly<{
  observation: RealtimeWireObservation;
  index: number;
}>;

const USAGE_COUNTERS = new Set<RoundtripUsageCounter>([
  "inputTextTokens",
  "inputAudioTokens",
  "cachedInputTokens",
  "cachedInputTextTokens",
  "cachedInputAudioTokens",
  "outputTextTokens",
  "outputAudioTokens",
  "totalInputTokens",
  "totalOutputTokens",
  "totalTokens",
  "inputAudioMinutes",
  "outputAudioMinutes",
  "billableTextInputEvents",
]);

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => record(entry) !== null)
    : [];
}

function usageProjection(observation: RealtimeWireObservation): Record<string, number> | null {
  const value = record(observation.projection.usage);
  if (!value) return null;
  const result: Record<string, number> = {};
  for (const [key, counter] of Object.entries(value)) {
    if (!USAGE_COUNTERS.has(key as RoundtripUsageCounter)
      || typeof counter !== "number" || !Number.isFinite(counter) || counter < 0) return null;
    result[key] = counter;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function terminalStatus(observation: RealtimeWireObservation): string | null {
  const terminal = record(observation.projection.terminal);
  return typeof terminal?.status === "string" ? terminal.status : null;
}

function wireAudioMinutes(observation: RealtimeWireObservation): Readonly<{
  direction: "input" | "output";
  minutes: number;
}> | null {
  const audio = record(observation.projection.audio);
  if (!audio || (audio.direction !== "input" && audio.direction !== "output")) return null;
  const chunks = Array.isArray(audio.chunks) ? audio.chunks : [audio];
  let seconds = 0;
  for (const chunkValue of chunks) {
    const chunk = record(chunkValue);
    const format = record(chunk?.format);
    if (!chunk || !format || chunk.validCanonicalBase64 !== true
      || typeof chunk.byteLength !== "number" || !Number.isSafeInteger(chunk.byteLength)
      || chunk.byteLength <= 0 || chunk.byteLength % 2 !== 0
      || format.encoding !== "pcm16" || format.channels !== 1
      || typeof format.sampleRateHz !== "number" || !Number.isSafeInteger(format.sampleRateHz)
      || format.sampleRateHz <= 0) return null;
    seconds += chunk.byteLength / 2 / format.sampleRateHz;
  }
  return { direction: audio.direction, minutes: seconds / 60 };
}

function usageEvidenceSha256(usage: RoundtripSanitizedUsage): string {
  return sha256Hex(`${USAGE_DOMAIN}${canonicalJson(usage)}`);
}

function summarySha256(summary: RoundtripReplaySummary): string {
  return sha256Hex(`${SUMMARY_DOMAIN}${canonicalJson(summary)}`);
}

function semanticProjectionSha256(
  kind: "target_tool_name" | "target_arguments" | "result",
  semanticValue: unknown,
  wireProjectionSha256: string,
): string {
  return sha256Hex(`${SEMANTIC_PROJECTION_DOMAIN}${canonicalJson({
    kind,
    semantic_value: semanticValue,
    wire_projection_sha256: wireProjectionSha256,
  })}`);
}

function qualificationSemanticHashes(
  targetToolNameWireSha256: string,
  targetArgumentsWireSha256: string,
  resultWireSha256: string,
): QualificationSemanticHashes {
  const targetToolNameSha256 = semanticProjectionSha256(
    "target_tool_name",
    QUALIFICATION_ROUNDTRIP_SEMANTICS.target_tool_name,
    targetToolNameWireSha256,
  );
  const targetArgumentsSha256 = semanticProjectionSha256(
    "target_arguments",
    QUALIFICATION_ROUNDTRIP_SEMANTICS.target_arguments,
    targetArgumentsWireSha256,
  );
  const resultSha256 = semanticProjectionSha256(
    "result",
    QUALIFICATION_ROUNDTRIP_SEMANTICS.result,
    resultWireSha256,
  );
  const body = {
    target_tool_name_sha256: targetToolNameSha256,
    target_arguments_sha256: targetArgumentsSha256,
    result_sha256: resultSha256,
  };
  return deepFreeze({
    ...body,
    binding_sha256: sha256Hex(`${SEMANTIC_BINDING_DOMAIN}${canonicalJson(body)}`),
  });
}

type PcmProjectionChunk = Readonly<{
  sha256: string;
  byte_length: number;
  sample_rate_hz: number;
}>;

export function roundtripInputAudioChunkListSha256(
  chunkSha256s: readonly string[],
): string {
  return sha256Hex(`${INPUT_AUDIO_CHUNK_LIST_DOMAIN}${canonicalJson(chunkSha256s)}`);
}

function projectedPcmChunks(
  observation: RealtimeWireObservation,
  expectedDirection: "input" | "output",
): readonly PcmProjectionChunk[] | null {
  const audio = record(observation.projection.audio);
  if (!audio || (audio.direction !== undefined && audio.direction !== expectedDirection)) return null;
  const values = Array.isArray(audio.chunks) ? audio.chunks : [audio];
  if (values.length === 0) return null;
  const chunks: PcmProjectionChunk[] = [];
  for (const value of values) {
    const chunk = record(value);
    const format = record(chunk?.format);
    if (!chunk || !format || chunk.validCanonicalBase64 !== true
      || typeof chunk.sha256 !== "string" || !SHA256.test(chunk.sha256)
      || typeof chunk.byteLength !== "number" || !Number.isSafeInteger(chunk.byteLength)
      || chunk.byteLength <= 0 || chunk.byteLength % 2 !== 0
      || format.encoding !== "pcm16" || format.channels !== 1
      || typeof format.sampleRateHz !== "number" || !Number.isSafeInteger(format.sampleRateHz)
      || format.sampleRateHz <= 0) return null;
    chunks.push({
      sha256: chunk.sha256,
      byte_length: chunk.byteLength,
      sample_rate_hz: format.sampleRateHz,
    });
  }
  return deepFreeze(chunks);
}

export function projectRoundtripInputAudioEvidence(
  wire: readonly RealtimeWireObservation[],
  expected: RoundtripInputAudioProjectionPlan,
): RoundtripInputAudioEvidence | null {
  if (!SHA256.test(expected.audio_sha256)
    || !SHA256.test(expected.delivery_profile_sha256)
    || !SHA256.test(expected.packetizer_sha256)
    || !Number.isSafeInteger(expected.audio_bytes) || expected.audio_bytes <= 0
    || !Number.isSafeInteger(expected.chunk_count) || expected.chunk_count <= 0
    || !Number.isSafeInteger(expected.frame_bytes) || expected.frame_bytes <= 0
    || !Number.isSafeInteger(expected.tail_bytes) || expected.tail_bytes <= 0
    || expected.tail_bytes > expected.frame_bytes
    || !Number.isSafeInteger(expected.sample_rate_hz) || expected.sample_rate_hz <= 0) return null;
  if (!Array.isArray(expected.chunk_sha256s)
    || expected.chunk_sha256s.length !== expected.chunk_count
    || expected.chunk_sha256s.some((hash) => !SHA256.test(hash))
    || expected.chunk_list_sha256 !== roundtripInputAudioChunkListSha256(
      expected.chunk_sha256s,
    )) return null;
  const observations = wire.filter((observation) => (
    observation.direction === "outbound"
    && (observation.wireType === "input_audio_buffer.append"
      || observation.wireType === "realtimeInput.audio")
  ));
  const suffix = expected.transport_suffix;
  if (suffix !== undefined && (
    suffix.purpose !== "server_vad_end_of_speech_delimiter"
    || (suffix.completion !== "full_plan_delivered"
      && suffix.completion !== "provider_native_speech_stop")
    || !SHA256.test(suffix.policy_sha256)
    || !SHA256.test(suffix.pcm_sha256)
    || !Number.isSafeInteger(suffix.audio_bytes) || suffix.audio_bytes <= 0
    || !Number.isSafeInteger(suffix.duration_ms) || suffix.duration_ms <= 0
    || !Number.isSafeInteger(suffix.chunk_count) || suffix.chunk_count <= 0
    || !Number.isSafeInteger(suffix.frame_bytes) || suffix.frame_bytes <= 0
    || !Number.isSafeInteger(suffix.tail_bytes) || suffix.tail_bytes <= 0
    || suffix.tail_bytes > suffix.frame_bytes
    || !Array.isArray(suffix.chunk_sha256s)
    || suffix.chunk_sha256s.length !== suffix.chunk_count
    || suffix.chunk_sha256s.some((hash) => !SHA256.test(hash))
    || suffix.chunk_list_sha256 !== roundtripInputAudioChunkListSha256(suffix.chunk_sha256s)
  )) return null;
  const suffixChunkCount = suffix?.chunk_count ?? 0;
  if (observations.length !== expected.chunk_count + suffixChunkCount) return null;
  let totalBytes = 0;
  for (const [index, observation] of observations.slice(0, expected.chunk_count).entries()) {
    const chunks = projectedPcmChunks(observation, "input");
    if (!chunks || chunks.length !== 1) return null;
    const chunk = chunks[0]!;
    const expectedBytes = index === expected.chunk_count - 1
      ? expected.tail_bytes
      : expected.frame_bytes;
    if (chunk.byte_length !== expectedBytes
      || chunk.sample_rate_hz !== expected.sample_rate_hz
      || chunk.sha256 !== expected.chunk_sha256s[index]) return null;
    totalBytes += chunk.byte_length;
  }
  if (totalBytes !== expected.audio_bytes) return null;
  const callerObservations = observations.slice(0, expected.chunk_count);
  const observationSha256s = callerObservations.map(({ observationSha256 }) => observationSha256);
  let transportSuffix: RoundtripInputAudioTransportSuffixEvidence | undefined;
  if (suffix !== undefined) {
    const suffixObservations = observations.slice(expected.chunk_count);
    let suffixBytes = 0;
    for (const [index, observation] of suffixObservations.entries()) {
      const chunks = projectedPcmChunks(observation, "input");
      if (!chunks || chunks.length !== 1) return null;
      const chunk = chunks[0]!;
      const expectedBytes = index === suffixObservations.length - 1
        ? suffix.tail_bytes
        : suffix.frame_bytes;
      if (chunk.byte_length !== expectedBytes
        || chunk.sample_rate_hz !== expected.sample_rate_hz
        || chunk.sha256 !== suffix.chunk_sha256s[index]) return null;
      suffixBytes += chunk.byte_length;
    }
    if (suffixBytes !== suffix.audio_bytes) return null;
    const suffixObservationSha256s = suffixObservations.map(({ observationSha256 }) => observationSha256);
    transportSuffix = deepFreeze({
      ...suffix,
      observation_sha256s: suffixObservationSha256s,
      observation_list_sha256: sha256Hex(
        `${INPUT_AUDIO_OBSERVATION_LIST_DOMAIN}${canonicalJson(suffixObservationSha256s)}`,
      ),
    });
  }
  return deepFreeze({
    chunk_sha256s: expected.chunk_sha256s,
    chunk_list_sha256: expected.chunk_list_sha256,
    audio_sha256: expected.audio_sha256,
    delivery_profile_sha256: expected.delivery_profile_sha256,
    packetizer_sha256: expected.packetizer_sha256,
    audio_bytes: expected.audio_bytes,
    chunk_count: expected.chunk_count,
    frame_bytes: expected.frame_bytes,
    tail_bytes: expected.tail_bytes,
    sample_rate_hz: expected.sample_rate_hz,
    observation_sha256s: observationSha256s,
    observation_list_sha256: sha256Hex(
      `${INPUT_AUDIO_OBSERVATION_LIST_DOMAIN}${canonicalJson(observationSha256s)}`,
    ),
    ...(transportSuffix === undefined ? {} : { transport_suffix: transportSuffix }),
  });
}

export function projectRoundtripOutputAudioEvidence(input: Readonly<{
  provider: ServerRealtimeProvider;
  wire: readonly RealtimeWireObservation[];
  continuation_start_observation_sha256: string;
  terminal_observation_sha256: string;
  continuation_response_id_sha256: string;
}>): RoundtripOutputAudioEvidence | null {
  if (!SHA256.test(input.continuation_response_id_sha256)) return null;
  const startIndex = input.wire.findIndex(({ observationSha256 }) => (
    observationSha256 === input.continuation_start_observation_sha256
  ));
  const terminalIndex = input.wire.findIndex(({ observationSha256 }) => (
    observationSha256 === input.terminal_observation_sha256
  ));
  if (startIndex < 0 || terminalIndex <= startIndex) return null;
  const candidates = input.wire
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation, index }) => (
      index >= startIndex && index < terminalIndex
      && observation.direction === "inbound"
      && record(observation.projection.audio) !== null
    ));
  if (candidates.length === 0) return null;
  const content: Array<Readonly<{
    observation_sha256: string;
    projection_sha256: string;
    chunks: readonly PcmProjectionChunk[];
  }>> = [];
  let audioBytes = 0;
  let sampleRateHz: number | null = null;
  let chunkCount = 0;
  for (const { observation } of candidates) {
    const responseIdSha256 = observation.identities.responseIdSha256;
    if (input.provider !== "gemini" && responseIdSha256 !== input.continuation_response_id_sha256) {
      return null;
    }
    if (input.provider === "gemini" && responseIdSha256 !== undefined
      && responseIdSha256 !== input.continuation_response_id_sha256) return null;
    const chunks = projectedPcmChunks(observation, "output");
    if (!chunks) return null;
    for (const chunk of chunks) {
      if (sampleRateHz !== null && chunk.sample_rate_hz !== sampleRateHz) return null;
      sampleRateHz = chunk.sample_rate_hz;
      audioBytes += chunk.byte_length;
      chunkCount += 1;
    }
    content.push({
      observation_sha256: observation.observationSha256,
      projection_sha256: observation.projectionSha256,
      chunks,
    });
  }
  if (audioBytes <= 0 || chunkCount <= 0 || sampleRateHz === null) return null;
  const observationSha256s = candidates.map(({ observation }) => observation.observationSha256);
  return deepFreeze({
    observation_sha256s: observationSha256s,
    observation_list_sha256: sha256Hex(
      `${OUTPUT_AUDIO_OBSERVATION_LIST_DOMAIN}${canonicalJson(observationSha256s)}`,
    ),
    content_sha256: sha256Hex(`${OUTPUT_AUDIO_CONTENT_DOMAIN}${canonicalJson(content)}`),
    audio_bytes: audioBytes,
    chunk_count: chunkCount,
    sample_rate_hz: sampleRateHz,
    response_id_sha256: input.continuation_response_id_sha256,
  });
}

export function roundtripCausalBindingSha256(
  binding: Omit<RoundtripCausalBinding, "evidence_sha256">,
): string {
  return sha256Hex(`${CAUSAL_BINDING_DOMAIN}${canonicalJson(binding)}`);
}

function factsWithProjectionArray(
  wire: readonly RealtimeWireObservation[],
  key: "gatewayCalls" | "gatewayResults",
): readonly Readonly<{ fact: WireFact; item: Record<string, unknown> }>[] {
  return wire.flatMap((observation, index) => records(observation.projection[key])
    .map((item) => ({ fact: { observation, index }, item })));
}

type GatewayProjectionFact = Readonly<{
  fact: WireFact;
  item: Record<string, unknown>;
}>;

const TERMINAL_GATEWAY_CALL_WIRE_TYPES = new Set([
  "toolCall",
  "response.function_call_arguments.done",
  "response.output_item.done",
  "conversation.item.done",
  "response.done",
  "response.completed",
]);

const GATEWAY_CALL_IDENTITY_KEYS = [
  "gateway",
  "callIdSha256",
  "responseIdSha256",
  "itemIdSha256",
] as const;

const GATEWAY_CALL_SEMANTIC_KEYS = [
  "argumentsSha256",
  "argumentsBytes",
  "argumentsJsonValid",
  "targetToolNameSha256",
  "targetArgumentsSha256",
] as const;

/**
 * OpenAI-compatible providers project one native function call on several
 * lifecycle frames (item-added, item-done, then response-done). Those frames
 * are observations of one provider call, not three executable calls. Select
 * the exact observation admitted by the executor while proving every other
 * terminal projection is the same call with the same completed semantics.
 */
function selectGatewayCallProjection(
  calls: readonly GatewayProjectionFact[],
  summary: RoundtripReplaySummary,
  errors: string[],
): GatewayProjectionFact | undefined {
  const exactlyAccepted = calls.find(({ fact }) => (
    fact.observation.observationSha256 === summary.call.observation_sha256
  ));
  const callIds = new Set(calls.map(({ item }) => item.callIdSha256));
  if (calls.length === 0 || callIds.size !== 1
    || !callIds.has(summary.call.call_id_sha256)) {
    errors.push("gateway_call_count_not_exactly_one");
  }
  if (!exactlyAccepted) {
    errors.push("gateway_call_binding_invalid");
  }
  // Keep validating a malformed packet after a stale summary reference so the
  // replay reports the independently observable semantic fault as well.
  const accepted = exactlyAccepted ?? calls.find((candidate) => (
    candidate.item.callIdSha256 === summary.call.call_id_sha256
    && TERMINAL_GATEWAY_CALL_WIRE_TYPES.has(candidate.fact.observation.wireType)
  )) ?? calls.find(({ item }) => item.callIdSha256 === summary.call.call_id_sha256);
  if (!accepted) return undefined;
  const terminalWireTypes = calls
    .filter(({ fact }) => TERMINAL_GATEWAY_CALL_WIRE_TYPES.has(fact.observation.wireType))
    .map(({ fact }) => fact.observation.wireType);
  if (new Set(terminalWireTypes).size !== terminalWireTypes.length) {
    errors.push("gateway_call_count_not_exactly_one");
  }

  const conflicts = calls.some((candidate) => {
    if (candidate === accepted) return false;
    const terminal = TERMINAL_GATEWAY_CALL_WIRE_TYPES.has(
      candidate.fact.observation.wireType,
    );
    for (const key of GATEWAY_CALL_IDENTITY_KEYS) {
      const candidateValue = candidate.item[key];
      const acceptedValue = accepted.item[key];
      // Some lifecycle frames (notably conversation.item.done) omit the
      // response identity even though adjacent response-scoped frames bind the
      // same call and item. Treat omission as non-authoritative; a different
      // value is still a hard identity conflict.
      if (candidateValue !== undefined && acceptedValue !== undefined
        && candidateValue !== acceptedValue) return true;
    }
    if (!terminal) {
      // Item-added is a progress snapshot and may legitimately contain empty
      // or incomplete arguments. Identity is still immutable, but only a
      // valid complete projection is comparable to terminal semantics.
      if (candidate.item.argumentsJsonValid !== true) return false;
    }
    return GATEWAY_CALL_SEMANTIC_KEYS.some((key) => (
      candidate.item[key] !== accepted.item[key]
    ));
  });
  if (conflicts) errors.push("gateway_call_projection_conflict");
  if (!TERMINAL_GATEWAY_CALL_WIRE_TYPES.has(accepted.fact.observation.wireType)) {
    const laterTerminalCorroboration = calls.some((candidate) => (
      candidate.fact.index > accepted.fact.index
      && TERMINAL_GATEWAY_CALL_WIRE_TYPES.has(candidate.fact.observation.wireType)
      && !GATEWAY_CALL_IDENTITY_KEYS.some((key) => (
        candidate.item[key] !== undefined && accepted.item[key] !== undefined
        && candidate.item[key] !== accepted.item[key]
      ))
      && !GATEWAY_CALL_SEMANTIC_KEYS.some((key) => (
        candidate.item[key] !== accepted.item[key]
      ))
    ));
    if (!laterTerminalCorroboration) {
      errors.push("gateway_call_accepted_projection_not_terminal");
    }
  }
  return accepted;
}

function pushHashError(errors: string[], value: unknown, code: string): value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    errors.push(code);
    return false;
  }
  return true;
}

function assertUsageShape(usage: RoundtripSanitizedUsage, errors: string[], index: number): void {
  const prefix = `usage_${index + 1}`;
  if (usage.schema_version !== 1) errors.push(`${prefix}_schema_invalid`);
  if (usage.source !== "provider_reported" && usage.source !== "client_measured_wire_pcm") {
    errors.push(`${prefix}_source_invalid`);
  }
  pushHashError(errors, usage.response_id_sha256, `${prefix}_response_id_invalid`);
  pushHashError(errors, usage.terminal_observation_sha256, `${prefix}_terminal_reference_invalid`);
  if (usage.provider_usage_observation_sha256 !== null) {
    pushHashError(errors, usage.provider_usage_observation_sha256, `${prefix}_provider_reference_invalid`);
  }
  if (!Array.isArray(usage.contributing_wire_observation_sha256s)
    || usage.contributing_wire_observation_sha256s.length === 0
    || new Set(usage.contributing_wire_observation_sha256s).size
      !== usage.contributing_wire_observation_sha256s.length) {
    errors.push(`${prefix}_contributors_invalid`);
  }
  for (const hash of usage.contributing_wire_observation_sha256s) {
    pushHashError(errors, hash, `${prefix}_contributor_hash_invalid`);
  }
  const counters = record(usage.counters);
  if (!counters || Object.keys(counters).length === 0) {
    errors.push(`${prefix}_counters_missing`);
    return;
  }
  for (const [key, value] of Object.entries(counters)) {
    if (!USAGE_COUNTERS.has(key as RoundtripUsageCounter)
      || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push(`${prefix}_counter_invalid`);
    }
  }
}

function verifyCausalBinding(
  input: ProviderRoundtripReplayInput,
  byHash: ReadonlyMap<string, WireFact>,
  finalUsage: RoundtripSanitizedUsage | undefined,
  errors: string[],
): string | null {
  const binding = input.causal_binding;
  if (!binding) {
    if (input.summary.provider === "gemini") {
      errors.push("gemini_exact_local_causal_binding_missing");
    }
    return null;
  }
  if (binding.schema_version !== 1 || binding.provider !== input.summary.provider
    || binding.connection_epoch !== 1) errors.push("causal_binding_header_invalid");
  const expectedSource = input.summary.provider === "gemini" ? "client_local" : "provider";
  if (binding.response_id_source !== expectedSource) {
    errors.push("causal_binding_response_identity_source_invalid");
  }
  if (!Number.isSafeInteger(binding.input_turn) || binding.input_turn < 1) {
    errors.push("causal_binding_turn_invalid");
  }
  for (const [key, value] of Object.entries(binding)) {
    if (key.endsWith("_sha256")) pushHashError(errors, value, `causal_binding_${key}_invalid`);
  }
  const bindingBody = Object.fromEntries(
    Object.entries(binding).filter(([key]) => key !== "evidence_sha256"),
  ) as Omit<RoundtripCausalBinding, "evidence_sha256">;
  const computedEvidenceSha256 = roundtripCausalBindingSha256(bindingBody);
  if (binding.evidence_sha256 !== computedEvidenceSha256) {
    errors.push("causal_binding_evidence_sha256_mismatch");
  }
  const summary = input.summary;
  if (binding.call_response_id_sha256 !== summary.call.response_id_sha256
    || binding.initial_response_id_sha256 !== summary.continuation.origin_response_id_sha256
    || binding.continuation_response_id_sha256 !== summary.continuation.response_id_sha256
    || binding.continuation_response_id_sha256 !== summary.terminal.response_id_sha256
    || binding.usage_response_id_sha256 !== summary.usage.response_id_sha256) {
    errors.push("causal_binding_response_mismatch");
  }
  if (binding.call_id_sha256 !== summary.call.call_id_sha256
    || binding.call_observation_sha256 !== summary.call.observation_sha256
    || binding.result_observation_sha256 !== summary.result.observation_sha256
    || binding.continuation_request_observation_sha256
      !== summary.continuation.request_observation_sha256
    || binding.continuation_start_observation_sha256
      !== summary.continuation.started_observation_sha256
    || binding.terminal_observation_sha256 !== summary.terminal.observation_sha256) {
    errors.push("causal_binding_summary_mismatch");
  }
  const expectedUsageObservationSha256 = finalUsage?.source === "provider_reported"
    ? finalUsage.provider_usage_observation_sha256
    : finalUsage?.terminal_observation_sha256 ?? null;
  if (!expectedUsageObservationSha256
    || binding.usage_observation_sha256 !== expectedUsageObservationSha256) {
    errors.push("causal_binding_usage_observation_mismatch");
  }
  const trigger = byHash.get(binding.trigger_observation_sha256);
  const call = byHash.get(binding.call_observation_sha256);
  const result = byHash.get(binding.result_observation_sha256);
  const request = byHash.get(binding.continuation_request_observation_sha256);
  const continuation = byHash.get(binding.continuation_start_observation_sha256);
  const terminal = byHash.get(binding.terminal_observation_sha256);
  if (!trigger) {
    errors.push("causal_binding_trigger_missing");
  } else if (summary.provider === "gemini"
    && (trigger.observation.direction !== "outbound"
      || (trigger.observation.wireType !== "realtimeInput.activityEnd"
        && trigger.observation.wireType !== "clientContent"))) {
    errors.push("gemini_initial_trigger_wire_binding_invalid");
  } else if (summary.provider === "openai"
    && (trigger.observation.direction !== "outbound"
      || trigger.observation.wireType !== "response.create")) {
    errors.push("openai_initial_trigger_wire_binding_invalid");
  } else if (summary.provider === "xai"
    && (trigger.observation.direction !== "inbound"
      || trigger.observation.wireType !== "input_audio_buffer.speech_stopped")) {
    errors.push("xai_initial_trigger_wire_binding_invalid");
  }
  if (!trigger || !call || !result || !request || !continuation || !terminal
    || !(trigger.index < call.index && call.index < result.index
      && result.index <= request.index && request.index < continuation.index
      && continuation.index <= terminal.index)) {
    errors.push("causal_binding_order_invalid");
  }
  if (summary.provider === "gemini" && (result?.observation.wireType !== "toolResponse"
    || result.observation.direction !== "outbound"
    || request?.observation.observationSha256 !== result.observation.observationSha256)) {
    errors.push("gemini_tool_response_trigger_invalid");
  }
  if (summary.provider === "gemini" && (!continuation || continuation.observation.direction !== "inbound"
    || (continuation.observation.wireType !== "serverContent"
      && continuation.observation.wireType !== "mixedServerMessage"))) {
    errors.push("gemini_continuation_observation_invalid");
  }
  return computedEvidenceSha256;
}

export function replayProviderToolRoundtrip(
  input: ProviderRoundtripReplayInput,
): ProviderRoundtripReplayResult {
  const errors: string[] = [];
  try {
    const { summary, wire_observations: wire, sanitized_usage: usage } = input;
    if (summary.schema_version !== 1 || summary.connection_epoch !== 1) {
      errors.push("summary_header_invalid");
    }
    if ((summary.provider !== "openai" && summary.provider !== "xai" && summary.provider !== "gemini")
      || input.expected.provider !== summary.provider) errors.push("provider_mismatch");
    if (!SAFE_MODEL.test(summary.model) || input.expected.model !== summary.model) {
      errors.push("model_mismatch_or_invalid");
    }
    const hashValues: readonly [unknown, string][] = [
      [summary.call.observation_sha256, "summary_call_observation_invalid"],
      [summary.call.call_id_sha256, "summary_call_id_invalid"],
      [summary.call.response_id_sha256, "summary_call_response_id_invalid"],
      [summary.result.observation_sha256, "summary_result_observation_invalid"],
      [summary.result.call_id_sha256, "summary_result_call_id_invalid"],
      [summary.continuation.request_observation_sha256, "summary_continuation_request_invalid"],
      [summary.continuation.origin_response_id_sha256, "summary_origin_response_id_invalid"],
      [summary.continuation.started_observation_sha256, "summary_continuation_started_invalid"],
      [summary.continuation.response_id_sha256, "summary_continuation_response_id_invalid"],
      [summary.terminal.observation_sha256, "summary_terminal_observation_invalid"],
      [summary.terminal.response_id_sha256, "summary_terminal_response_id_invalid"],
      [summary.usage.evidence_sha256, "summary_usage_evidence_invalid"],
      [summary.usage.response_id_sha256, "summary_usage_response_id_invalid"],
      [summary.input_audio.observation_list_sha256, "summary_input_audio_observation_list_invalid"],
      [summary.input_audio.chunk_list_sha256, "summary_input_audio_chunk_list_invalid"],
      [summary.input_audio.audio_sha256, "summary_input_audio_sha256_invalid"],
      [summary.input_audio.delivery_profile_sha256, "summary_input_delivery_profile_invalid"],
      [summary.input_audio.packetizer_sha256, "summary_input_packetizer_invalid"],
      [summary.output_audio.observation_list_sha256, "summary_output_audio_observation_list_invalid"],
      [summary.output_audio.content_sha256, "summary_output_audio_content_invalid"],
      [summary.output_audio.response_id_sha256, "summary_output_audio_response_id_invalid"],
    ];
    for (const [value, code] of hashValues) pushHashError(errors, value, code);
    for (const hash of summary.input_audio.observation_sha256s) {
      pushHashError(errors, hash, "summary_input_audio_observation_invalid");
    }
    for (const hash of summary.input_audio.chunk_sha256s) {
      pushHashError(errors, hash, "summary_input_audio_chunk_invalid");
    }
    if (summary.input_audio.transport_suffix !== undefined) {
      const suffix = summary.input_audio.transport_suffix;
      pushHashError(errors, suffix.policy_sha256, "summary_input_audio_suffix_policy_invalid");
      pushHashError(errors, suffix.pcm_sha256, "summary_input_audio_suffix_pcm_invalid");
      pushHashError(errors, suffix.observation_list_sha256, "summary_input_audio_suffix_observation_list_invalid");
      pushHashError(errors, suffix.chunk_list_sha256, "summary_input_audio_suffix_chunk_list_invalid");
      for (const hash of suffix.observation_sha256s) {
        pushHashError(errors, hash, "summary_input_audio_suffix_observation_invalid");
      }
      for (const hash of suffix.chunk_sha256s) {
        pushHashError(errors, hash, "summary_input_audio_suffix_chunk_invalid");
      }
      if (summary.provider !== "xai") {
        errors.push("summary_input_audio_suffix_provider_invalid");
      } else if (suffix.policy_sha256 !== LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256
        || !isAcceptedXaiServerVadSilenceTail(suffix)) {
        errors.push("summary_input_audio_suffix_completion_invalid");
      }
    }
    for (const hash of summary.output_audio.observation_sha256s) {
      pushHashError(errors, hash, "summary_output_audio_observation_invalid");
    }
    if (summary.call.call_id_sha256 !== summary.result.call_id_sha256) {
      errors.push("call_result_id_mismatch");
    }
    if (summary.call.response_id_sha256 !== summary.continuation.origin_response_id_sha256) {
      errors.push("continuation_origin_response_mismatch");
    }
    if (summary.terminal.status !== "completed") errors.push("summary_terminal_not_completed");
    if (summary.continuation.response_id_sha256 !== summary.terminal.response_id_sha256
      || summary.continuation.response_id_sha256 !== summary.usage.response_id_sha256) {
      errors.push("continuation_terminal_usage_response_mismatch");
    }
    if (summary.call.response_id_sha256 === summary.continuation.response_id_sha256) {
      errors.push("continuation_response_not_distinct");
    }
    if (summary.output_audio.response_id_sha256 !== summary.continuation.response_id_sha256) {
      errors.push("output_audio_continuation_response_mismatch");
    }
    const chain = verifyRealtimeWireObservationChain(wire);
    if (!chain.valid || chain.eventCount === 0 || chain.chainHead === null) {
      errors.push("wire_chain_invalid", ...chain.errors.map((error) => `wire:${error}`));
    }
    if (wire.some((observation) => observation.provider !== summary.provider)) {
      errors.push("wire_provider_mismatch");
    }
    if (wire.some((observation) => observation.connectionEpoch !== 1)) {
      errors.push("wire_reconnect_or_nonfirst_epoch");
    }
    for (const observation of wire) {
      for (const key of ["gatewayCalls", "gatewayResults"] as const) {
        if (!Object.prototype.hasOwnProperty.call(observation.projection, key)) continue;
        const value = observation.projection[key];
        if (!Array.isArray(value) || value.length === 0
          || value.some((entry) => record(entry) === null)) {
          errors.push(`wire_${key}_projection_malformed`);
        }
      }
      if (Object.prototype.hasOwnProperty.call(observation.projection, "usage")
        && usageProjection(observation) === null) {
        errors.push("wire_usage_projection_malformed");
      }
    }
    const byHash = new Map<string, WireFact>();
    for (const [index, observation] of wire.entries()) {
      if (byHash.has(observation.observationSha256)) errors.push("duplicate_wire_observation_hash");
      byHash.set(observation.observationSha256, { observation, index });
    }

    const expectedInputAudio = {
      chunk_sha256s: summary.input_audio.chunk_sha256s,
      chunk_list_sha256: summary.input_audio.chunk_list_sha256,
      audio_sha256: summary.input_audio.audio_sha256,
      delivery_profile_sha256: summary.input_audio.delivery_profile_sha256,
      packetizer_sha256: summary.input_audio.packetizer_sha256,
      audio_bytes: summary.input_audio.audio_bytes,
      chunk_count: summary.input_audio.chunk_count,
      frame_bytes: summary.input_audio.frame_bytes,
      tail_bytes: summary.input_audio.tail_bytes,
      sample_rate_hz: summary.input_audio.sample_rate_hz,
      ...(summary.input_audio.transport_suffix === undefined ? {} : {
        transport_suffix: {
          purpose: summary.input_audio.transport_suffix.purpose,
          completion: summary.input_audio.transport_suffix.completion,
          policy_sha256: summary.input_audio.transport_suffix.policy_sha256,
          pcm_sha256: summary.input_audio.transport_suffix.pcm_sha256,
          audio_bytes: summary.input_audio.transport_suffix.audio_bytes,
          duration_ms: summary.input_audio.transport_suffix.duration_ms,
          chunk_sha256s: summary.input_audio.transport_suffix.chunk_sha256s,
          chunk_list_sha256: summary.input_audio.transport_suffix.chunk_list_sha256,
          chunk_count: summary.input_audio.transport_suffix.chunk_count,
          frame_bytes: summary.input_audio.transport_suffix.frame_bytes,
          tail_bytes: summary.input_audio.transport_suffix.tail_bytes,
        },
      }),
    };
    const projectedInputAudio = projectRoundtripInputAudioEvidence(wire, expectedInputAudio);
    if (projectedInputAudio === null
      || canonicalJson(projectedInputAudio) !== canonicalJson(summary.input_audio)) {
      errors.push("input_audio_delivery_replay_mismatch");
    }
    const projectedOutputAudio = projectRoundtripOutputAudioEvidence({
      provider: summary.provider,
      wire,
      continuation_start_observation_sha256: summary.continuation.started_observation_sha256,
      terminal_observation_sha256: summary.terminal.observation_sha256,
      continuation_response_id_sha256: summary.continuation.response_id_sha256,
    });
    if (projectedOutputAudio === null
      || canonicalJson(projectedOutputAudio) !== canonicalJson(summary.output_audio)) {
      errors.push("output_audio_continuation_replay_mismatch");
    }

    const calls = factsWithProjectionArray(wire, "gatewayCalls");
    const results = factsWithProjectionArray(wire, "gatewayResults");
    if (results.length !== 1) errors.push("gateway_result_count_not_exactly_one");
    const call = selectGatewayCallProjection(calls, summary, errors);
    const result = results[0];
    let semanticHashes: QualificationSemanticHashes | null = null;
    if (call) {
      if (call.fact.observation.observationSha256 !== summary.call.observation_sha256
        || call.item.gateway !== "capability_gateway"
        || call.item.callIdSha256 !== summary.call.call_id_sha256
        || call.fact.observation.identities.callIdSha256 !== summary.call.call_id_sha256
        || call.fact.observation.direction !== "inbound") errors.push("gateway_call_binding_invalid");
      if (summary.provider !== "gemini"
        && (call.item.responseIdSha256 !== summary.call.response_id_sha256
          || call.fact.observation.identities.responseIdSha256 !== summary.call.response_id_sha256)) {
        errors.push("gateway_call_response_binding_invalid");
      }
      if (call.item.argumentsJsonValid !== true) {
        errors.push("gateway_arguments_json_invalid");
      }
    }
    if (result) {
      if (result.fact.observation.observationSha256 !== summary.result.observation_sha256
        || result.item.gateway !== "capability_gateway"
        || result.item.callIdSha256 !== summary.result.call_id_sha256
        || result.fact.observation.identities.callIdSha256 !== summary.result.call_id_sha256
        || result.fact.observation.direction !== "outbound") errors.push("gateway_result_binding_invalid");
      if (result.item.resultJsonValid !== true) {
        errors.push("gateway_result_json_invalid");
      }
    }
    if (call && result && call.fact.index >= result.fact.index) errors.push("call_result_order_invalid");

    const expectedTargetToolNameWireSha256 = realtimeWireIdentitySha256(
      "target-tool",
      QUALIFICATION_ROUNDTRIP_SEMANTICS.target_tool_name,
    );
    const expectedTargetArgumentsWireSha256 = sha256Hex(
      canonicalJson(QUALIFICATION_ROUNDTRIP_SEMANTICS.target_arguments),
    );
    const expectedResultWireSha256 = sha256Hex(
      canonicalJson(QUALIFICATION_ROUNDTRIP_SEMANTICS.result),
    );
    const targetToolNameWireSha256 = call?.item.targetToolNameSha256;
    const targetArgumentsWireSha256 = call?.item.targetArgumentsSha256;
    const resultWireSha256 = result?.item.resultSha256;
    if (targetToolNameWireSha256 !== expectedTargetToolNameWireSha256) {
      errors.push("gateway_target_tool_name_semantic_mismatch");
    }
    if (targetArgumentsWireSha256 !== expectedTargetArgumentsWireSha256) {
      errors.push("gateway_target_arguments_semantic_mismatch");
    }
    if (resultWireSha256 !== expectedResultWireSha256) {
      errors.push("gateway_qualification_result_semantic_mismatch");
    }
    if (typeof targetToolNameWireSha256 === "string"
      && SHA256.test(targetToolNameWireSha256)
      && typeof targetArgumentsWireSha256 === "string"
      && SHA256.test(targetArgumentsWireSha256)
      && typeof resultWireSha256 === "string"
      && SHA256.test(resultWireSha256)) {
      semanticHashes = qualificationSemanticHashes(
        targetToolNameWireSha256,
        targetArgumentsWireSha256,
        resultWireSha256,
      );
    } else {
      errors.push("gateway_semantic_projection_missing_or_invalid");
    }

    const callFact = byHash.get(summary.call.observation_sha256);
    const resultFact = byHash.get(summary.result.observation_sha256);
    const requestFact = byHash.get(summary.continuation.request_observation_sha256);
    const startedFact = byHash.get(summary.continuation.started_observation_sha256);
    const terminalFact = byHash.get(summary.terminal.observation_sha256);
    if (!callFact || !resultFact || !requestFact || !startedFact || !terminalFact) {
      errors.push("summary_wire_reference_missing");
    }

    if (summary.provider !== "gemini") {
      const continuationRequests = wire.filter((observation, index) => (
        resultFact !== undefined && index > resultFact.index
        && observation.direction === "outbound" && observation.wireType === "response.create"
      ));
      if (continuationRequests.length !== 1
        || continuationRequests[0]?.observationSha256 !== summary.continuation.request_observation_sha256
        || requestFact?.observation.direction !== "outbound"
        || requestFact?.observation.wireType !== "response.create") {
        errors.push("continuation_request_count_or_binding_invalid");
      }
      const continuationStarts = wire.filter((observation, index) => (
        requestFact !== undefined && index > requestFact.index
        && observation.direction === "inbound" && observation.wireType === "response.created"
      ));
      if (continuationStarts.length !== 1
        || continuationStarts[0]?.observationSha256 !== summary.continuation.started_observation_sha256
        || continuationStarts[0]?.identities.responseIdSha256
          !== summary.continuation.response_id_sha256) {
        errors.push("continuation_response_count_or_binding_invalid");
      }
    } else if (summary.continuation.request_observation_sha256
      !== summary.result.observation_sha256) {
      errors.push("gemini_tool_response_is_not_continuation_trigger");
    }

    if (callFact && resultFact && requestFact && startedFact && terminalFact
      && !(callFact.index < resultFact.index && resultFact.index <= requestFact.index
        && requestFact.index < startedFact.index && startedFact.index <= terminalFact.index)) {
      errors.push("roundtrip_order_invalid");
    }

    const terminalFacts = wire
      .map((observation, index) => ({ observation, index }))
      .filter(({ observation }) => terminalStatus(observation) !== null);
    if (terminalFacts.some(({ observation }) => terminalStatus(observation) !== "completed")) {
      errors.push("noncompleted_terminal_retained");
    }
    if (summary.provider === "gemini") {
      if (terminalFacts.length !== 1
        || terminalFacts[0]?.observation.observationSha256 !== summary.terminal.observation_sha256) {
        errors.push("gemini_terminal_count_or_binding_invalid");
      }
    } else {
      const allowedResponseIds = new Set([
        summary.call.response_id_sha256,
        summary.continuation.response_id_sha256,
      ]);
      if (terminalFacts.some(({ observation }) => (
        !observation.identities.responseIdSha256
        || !allowedResponseIds.has(observation.identities.responseIdSha256)
      ))) errors.push("unrelated_terminal_retained");
      const terminalCounts = new Map<string, number>();
      for (const { observation } of terminalFacts) {
        const responseId = observation.identities.responseIdSha256;
        if (responseId) terminalCounts.set(responseId, (terminalCounts.get(responseId) ?? 0) + 1);
      }
      if ([...terminalCounts.values()].some((count) => count !== 1)) {
        errors.push("duplicate_terminal_for_response");
      }
      const finalTerminals = terminalFacts.filter(({ observation }) => (
        observation.identities.responseIdSha256 === summary.continuation.response_id_sha256
      ));
      if (finalTerminals.length !== 1
        || finalTerminals[0]?.observation.observationSha256 !== summary.terminal.observation_sha256) {
        errors.push("final_terminal_count_or_binding_invalid");
      }
    }

    if (!Array.isArray(usage) || usage.length === 0) errors.push("sanitized_usage_missing");
    usage.forEach((entry, index) => assertUsageShape(entry, errors, index));
    const usageHashes = usage.map(usageEvidenceSha256);
    if (new Set(usageHashes).size !== usageHashes.length) errors.push("duplicate_sanitized_usage");
    const finalUsageIndexes = usageHashes
      .map((hash, index) => hash === summary.usage.evidence_sha256 ? index : -1)
      .filter((index) => index >= 0);
    if (finalUsageIndexes.length !== 1) errors.push("final_usage_count_or_binding_invalid");
    const finalUsage = finalUsageIndexes.length === 1 ? usage[finalUsageIndexes[0]!] : undefined;
    if (finalUsage && (finalUsage.response_id_sha256 !== summary.usage.response_id_sha256
      || finalUsage.terminal_observation_sha256 !== summary.terminal.observation_sha256)) {
      errors.push("final_usage_summary_binding_invalid");
    }

    const providerUsageFacts = wire
      .map((observation, index) => ({ observation, index, counters: usageProjection(observation) }))
      .filter((fact): fact is typeof fact & { counters: Record<string, number> } => fact.counters !== null);
    const reportedUsage = usage.filter((entry) => entry.source === "provider_reported");
    const measuredUsage = usage.filter((entry) => entry.source === "client_measured_wire_pcm");
    if (summary.provider !== "gemini") {
      const allowedProviderUsageResponseIds = new Set([
        summary.call.response_id_sha256,
        summary.continuation.response_id_sha256,
      ]);
      if (providerUsageFacts.some(({ observation }) => (
        !observation.identities.responseIdSha256
        || !allowedProviderUsageResponseIds.has(observation.identities.responseIdSha256)
      ))) errors.push("provider_usage_response_binding_invalid");
      const providerUsageCounts = new Map<string, number>();
      for (const { observation } of providerUsageFacts) {
        const responseId = observation.identities.responseIdSha256;
        if (responseId) {
          providerUsageCounts.set(responseId, (providerUsageCounts.get(responseId) ?? 0) + 1);
        }
      }
      if ([...providerUsageCounts.values()].some((count) => count !== 1)) {
        errors.push("provider_usage_count_mismatch");
      }
    } else if (providerUsageFacts.length !== reportedUsage.length) {
      errors.push("provider_usage_count_mismatch");
    }
    for (const entry of reportedUsage) {
      if (!entry.provider_usage_observation_sha256
        || entry.contributing_wire_observation_sha256s.length !== 1
        || entry.contributing_wire_observation_sha256s[0]
          !== entry.provider_usage_observation_sha256) {
        errors.push("provider_usage_contributors_invalid");
        continue;
      }
      const fact = providerUsageFacts.find(({ observation }) => (
        observation.observationSha256 === entry.provider_usage_observation_sha256
      ));
      if (!fact || canonicalJson(fact.counters) !== canonicalJson(entry.counters)) {
        errors.push("provider_usage_projection_mismatch");
        continue;
      }
      if (summary.provider !== "gemini"
        && fact.observation.identities.responseIdSha256 !== entry.response_id_sha256) {
        errors.push("provider_usage_response_binding_invalid");
      }
      if (summary.provider === "gemini" && entry !== finalUsage) {
        errors.push("gemini_unattributable_extra_usage");
      }
    }
    if (measuredUsage.length > 0) {
      if (summary.provider !== "xai" || measuredUsage.length !== 1
        || providerUsageFacts.length !== 0 || usage.length !== 1) {
        errors.push("client_measured_usage_policy_invalid");
      }
      const measured = measuredUsage[0]!;
      if (measured.provider_usage_observation_sha256 !== null) {
        errors.push("client_measured_usage_has_provider_reference");
      }
      const audioFacts = wire
        .map((observation) => ({ observation, audio: wireAudioMinutes(observation) }))
        .filter((fact): fact is typeof fact & { audio: NonNullable<ReturnType<typeof wireAudioMinutes>> } => (
          fact.audio !== null
        ));
      const expectedContributors = audioFacts.map(({ observation }) => observation.observationSha256);
      if (canonicalJson(expectedContributors)
        !== canonicalJson(measured.contributing_wire_observation_sha256s)) {
        errors.push("client_measured_usage_contributors_mismatch");
      }
      const expectedCounters: Partial<Record<RoundtripUsageCounter, number>> = {};
      for (const { audio } of audioFacts) {
        const key = audio.direction === "input" ? "inputAudioMinutes" : "outputAudioMinutes";
        expectedCounters[key] = (expectedCounters[key] ?? 0) + audio.minutes;
      }
      if (canonicalJson(expectedCounters) !== canonicalJson(measured.counters)) {
        errors.push("client_measured_usage_counters_mismatch");
      }
    }

    const allowedUsageResponseIds = new Set([
      summary.call.response_id_sha256,
      summary.continuation.response_id_sha256,
    ]);
    if (usage.some((entry) => !allowedUsageResponseIds.has(entry.response_id_sha256))) {
      errors.push("unrelated_sanitized_usage");
    }
    const usageResponseCounts = new Map<string, number>();
    for (const entry of usage) {
      usageResponseCounts.set(
        entry.response_id_sha256,
        (usageResponseCounts.get(entry.response_id_sha256) ?? 0) + 1,
      );
    }
    if ([...usageResponseCounts.values()].some((count) => count !== 1)) {
      errors.push("duplicate_usage_for_response");
    }
    if (usage.some((entry) => !byHash.has(entry.terminal_observation_sha256))) {
      errors.push("usage_terminal_reference_missing");
    }

    const bindingSha256 = verifyCausalBinding(input, byHash, finalUsage, errors);

    if (errors.length > 0 || chain.chainHead === null || semanticHashes === null) {
      return deepFreeze({
        schema_version: 3 as const,
        replay_version: PROVIDER_ROUNDTRIP_REPLAY_VERSION,
        valid: false,
        errors: [...new Set(errors)],
        public_execution: null,
        public_execution_sha256: null,
        replay_sha256: null,
      });
    }

    const publicExecution = deepFreeze({
      schema_version: 3 as const,
      replay_version: PROVIDER_ROUNDTRIP_REPLAY_VERSION,
      evidence_class: "provider_tool_roundtrip" as const,
      provider: summary.provider,
      model_sha256: sha256Hex(summary.model),
      connection_epoch: 1 as const,
      wire_event_count: wire.length,
      wire_chain_head_sha256: chain.chainHead,
      call_id_sha256: summary.call.call_id_sha256,
      origin_response_id_sha256: summary.call.response_id_sha256,
      continuation_response_id_sha256: summary.continuation.response_id_sha256,
      call_observation_sha256: summary.call.observation_sha256,
      result_observation_sha256: summary.result.observation_sha256,
      continuation_request_observation_sha256: summary.continuation.request_observation_sha256,
      continuation_started_observation_sha256: summary.continuation.started_observation_sha256,
      terminal_observation_sha256: summary.terminal.observation_sha256,
      final_usage_evidence_sha256: summary.usage.evidence_sha256,
      sanitized_usage_set_sha256: sha256Hex(canonicalJson(usageHashes)),
      causal_binding_sha256: bindingSha256,
      gateway_target_tool_name_sha256: semanticHashes.target_tool_name_sha256,
      gateway_target_arguments_sha256: semanticHashes.target_arguments_sha256,
      gateway_qualification_result_sha256: semanticHashes.result_sha256,
      gateway_semantic_binding_sha256: semanticHashes.binding_sha256,
      input_audio_observation_sha256s: summary.input_audio.observation_sha256s,
      input_audio_observation_list_sha256: summary.input_audio.observation_list_sha256,
      input_audio_chunk_list_sha256: summary.input_audio.chunk_list_sha256,
      input_audio_sha256: summary.input_audio.audio_sha256,
      input_audio_bytes: summary.input_audio.audio_bytes,
      input_audio_chunk_count: summary.input_audio.chunk_count,
      output_audio_observation_sha256s: summary.output_audio.observation_sha256s,
      output_audio_observation_list_sha256: summary.output_audio.observation_list_sha256,
      output_audio_content_sha256: summary.output_audio.content_sha256,
      output_audio_bytes: summary.output_audio.audio_bytes,
      output_audio_chunk_count: summary.output_audio.chunk_count,
    });
    const publicExecutionSha256 = sha256Hex(
      `${PUBLIC_EXECUTION_DOMAIN}${canonicalJson(publicExecution)}`,
    );
    const replaySha256 = sha256Hex(`${REPLAY_DOMAIN}${canonicalJson({
      expected_provider: input.expected.provider,
      expected_model_sha256: sha256Hex(input.expected.model),
      summary_sha256: summarySha256(summary),
      wire_chain_head_sha256: chain.chainHead,
      sanitized_usage_sha256s: usageHashes,
      causal_binding_sha256: bindingSha256,
      gateway_target_tool_name_sha256: semanticHashes.target_tool_name_sha256,
      gateway_target_arguments_sha256: semanticHashes.target_arguments_sha256,
      gateway_qualification_result_sha256: semanticHashes.result_sha256,
      gateway_semantic_binding_sha256: semanticHashes.binding_sha256,
      input_audio_observation_list_sha256: summary.input_audio.observation_list_sha256,
      input_audio_chunk_list_sha256: summary.input_audio.chunk_list_sha256,
      output_audio_observation_list_sha256: summary.output_audio.observation_list_sha256,
      output_audio_content_sha256: summary.output_audio.content_sha256,
      public_execution_sha256: publicExecutionSha256,
    })}`);
    return deepFreeze({
      schema_version: 3 as const,
      replay_version: PROVIDER_ROUNDTRIP_REPLAY_VERSION,
      valid: true,
      errors: [],
      public_execution: publicExecution,
      public_execution_sha256: publicExecutionSha256,
      replay_sha256: replaySha256,
    });
  } catch (error) {
    return deepFreeze({
      schema_version: 3 as const,
      replay_version: PROVIDER_ROUNDTRIP_REPLAY_VERSION,
      valid: false,
      errors: [`replay_input_invalid:${error instanceof Error ? error.message : "unknown"}`],
      public_execution: null,
      public_execution_sha256: null,
      replay_sha256: null,
    });
  }
}

export function roundtripSanitizedUsageSha256(usage: RoundtripSanitizedUsage): string {
  return usageEvidenceSha256(usage);
}
