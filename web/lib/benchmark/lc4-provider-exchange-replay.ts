import { canonicalJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  createLc4GeminiOutputAttribution,
  type Lc4GeminiOutputAttribution,
  type Lc4ProviderExchangeOperation,
  type Lc4SanitizedWireObservation,
  type Lc4XaiServerVadTransportSuffixEvidence,
} from "./lc4-production-provider-adapter";
import type { Lc4DevReplayArtifactReference } from "./lc4-development-evidence-retention";
import {
  assertLc4DevArmBlindRepairProjection,
  type Lc4DevArmBlindRepairProjection,
} from "./lc4-development-headless-listener-authority";
import {
  LC4_DEV_AUDIO_DELIVERY_PROFILE,
  LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
} from "./lc4-development-audio-contract";
import {
  LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
} from "./lc4-production-provider-contract";
import type { Lc4ProviderExecutionProfile } from "./lc4-production-runner-foundation";
import { realtimeWireProjectionSha256 } from "../realtime/client/wire-evidence";
import {
  isAcceptedXaiServerVadSilenceTail,
  LC4_XAI_SERVER_VAD_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
  LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256,
} from "./xai-server-vad";
import type { Lc4CapturedOutput } from "./lc4-listener-evidence";
import {
  assertLc4XaiManualTurnCausality,
} from "./lc4-xai-manual-turn-causality";

const SHA256 = /^[a-f0-9]{64}$/u;
const WIRE_SET_DOMAIN = "harshas-amazing-call-center/lc4-wire-observation-set/v1\n";
const CAPTURE_CHUNK_DOMAIN =
  "hacc/lc4/listener-output-chunk-receipt/v1\n";
const CAPTURE_DOMAIN = "hacc/lc4/listener-output-capture/v1\n";
const CAPTURE_CHUNK_SEQUENCE_DOMAIN =
  "hacc/lc4/listener-output-chunk-sequence/v1\n";
const LISTENER_EVIDENCE_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-pinned-listener-evidence/v1\n";
const CAS_RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-cas-receipt/v1\n";
const LC4_DEV_LIVE_DEPENDENCY_VERSION =
  "lc4-dev-live-dependencies-v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

type JsonRecord = Record<string, JsonValue>;
const WIRE_OBSERVATION_KEYS = Object.freeze([
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
const MAX_RETAINED_WIRE_OBSERVATIONS = 512;

export type Lc4ProviderExchangeReplayExpectation = Readonly<{
  run_id: string;
  opportunity_id: string;
  segment_ordinal: 1 | 2 | 3;
  playback_kind: "canonical" | "repair";
  caller_pcm_sha256: string;
  caller_pcm_byte_length: number;
  response_control_kind: "native_context" | "hacc_response_plan";
  provider_profile: Lc4ProviderExecutionProfile;
  input_audio_delivery_profile_sha256: string;
  /** Exact retained caller bytes, independently resolved from immutable CAS. */
  caller_pcm: Uint8Array;
  /** Exact retained output bytes consumed by the pinned listener evaluator. */
  listener_consumed_pcm: Uint8Array;
  /** Exact canonical listener JSON resolved from its immutable ledger edge. */
  listener_evidence_projection: JsonValue;
  /** The exact listener reference carried beside the provider exchange. */
  listener_evidence_reference: Lc4DevReplayArtifactReference;
  /** Listener dependency root independently frozen into signed preflight. */
  listener_manifest_sha256: string;
  /** Evaluator executable/model build independently frozen into preflight. */
  evaluator_build_sha256: string;
}>;

export type Lc4ProviderExchangeReplayResult = Readonly<{
  /** Exact capture rebuilt from receipt-only projection plus retained CAS PCM. */
  output_capture: Lc4CapturedOutput;
  output_audio_lineage_scope:
    | "client_observed_interval_wire_projection_capture_cas_evaluator_exact_complete_frame_attribution_provider_response_id_unavailable"
    | "capture_cas_evaluator_exact_provider_output_wire_completeness_unverified"
    | "client_observed_identity_scoped_wire_pcm_capture_cas_evaluator_exact";
}>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function hash(value: unknown, label: string): string {
  const digest = string(value, label);
  if (!SHA256.test(digest)) throw new Error(`${label} must be one lowercase SHA-256`);
  return digest;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function finiteNumber(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum) {
    throw new Error(`${label} must be a finite number >= ${minimum}`);
  }
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function assertOnlyKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  if (canonicalJson(Object.keys(value).sort())
    !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function safeId(value: unknown, label: string): string {
  const identifier = string(value, label);
  if (!SAFE_ID.test(identifier)) throw new Error(`${label} is invalid`);
  return identifier;
}

function bytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)
    || value.byteLength < 2
    || value.byteLength % 2 !== 0) {
    throw new Error(`${label} must be nonempty complete PCM16 bytes`);
  }
  return value;
}

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function encodedPcmProjection(input: Readonly<{
  pcm: Uint8Array;
  sampleRateHz: number;
}>): Readonly<{
  validCanonicalBase64: true;
  byteLength: number;
  sha256: string;
  encodedBytes: number;
  format: Readonly<{
    encoding: "pcm16";
    sampleRateHz: number;
    channels: 1;
  }>;
}> {
  return Object.freeze({
    validCanonicalBase64: true as const,
    byteLength: input.pcm.byteLength,
    sha256: sha256Hex(input.pcm),
    encodedBytes: Buffer.byteLength(
      Buffer.from(input.pcm).toString("base64"),
      "utf8",
    ),
    format: Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz: input.sampleRateHz,
      channels: 1 as const,
    }),
  });
}

function callerFrames(
  pcm: Uint8Array,
  sampleRateHz: number,
): readonly Uint8Array[] {
  const frameByteLength = sampleRateHz
    * 2
    * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs
    / 1_000;
  if (!Number.isSafeInteger(frameByteLength)
    || frameByteLength < 2) {
    throw new Error("LC4 provider input sample rate cannot use the frozen packetizer");
  }
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.byteLength; offset += frameByteLength) {
    frames.push(pcm.slice(
      offset,
      Math.min(pcm.byteLength, offset + frameByteLength),
    ));
  }
  return Object.freeze(frames);
}

function wireObservations(value: unknown, provider: string): readonly Lc4SanitizedWireObservation[] {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > MAX_RETAINED_WIRE_OBSERVATIONS) {
    throw new Error(
      "LC4 provider exchange wire observations must be one nonempty bounded array",
    );
  }
  let priorSequence = 0;
  let priorEpoch = 0;
  let priorObservationSha256: string | null = null;
  for (const [index, candidate] of value.entries()) {
    const observation = record(candidate, `LC4 provider exchange wire observation ${index + 1}`);
    if (canonicalJson(Object.keys(observation).sort())
        !== canonicalJson([...WIRE_OBSERVATION_KEYS].sort())
      || observation.provider !== provider
      || (observation.direction !== "inbound" && observation.direction !== "outbound")
      || typeof observation.wire_type !== "string"
      || !observation.wire_type
      || integer(observation.connection_epoch, "LC4 wire connection epoch", 1) < priorEpoch
      || integer(observation.sequence, "LC4 wire sequence", 1) <= priorSequence) {
      throw new Error("LC4 provider exchange wire observation has invalid provider, direction, epoch, or order");
    }
    hash(observation.payload_sha256, "LC4 wire payload hash");
    integer(observation.payload_bytes, "LC4 wire payload bytes", 1);
    hash(observation.projection_sha256, "LC4 wire projection hash");
    hash(observation.observation_sha256, "LC4 wire observation hash");
    const identities = record(
      observation.identity_hashes,
      "LC4 wire identity commitments",
    );
    for (const [key, digest] of Object.entries(identities)) {
      if (!WIRE_IDENTITY_KEYS.has(key)) {
        throw new Error("LC4 provider exchange wire observation has an unknown identity commitment");
      }
      hash(digest, `LC4 wire ${key}`);
    }
    if (observation.previous_observation_sha256 !== null) {
      hash(observation.previous_observation_sha256, "LC4 wire predecessor hash");
    }
    if (index > 0 && (
      observation.connection_epoch !== priorEpoch
      || observation.sequence !== priorSequence + 1
      || observation.previous_observation_sha256 !== priorObservationSha256
    )) {
      throw new Error("LC4 provider exchange retained wire slice is reordered, truncated, or chain-tampered");
    }
    priorEpoch = observation.connection_epoch as number;
    priorSequence = observation.sequence as number;
    priorObservationSha256 = observation.observation_sha256 as string;
  }
  return value as unknown as readonly Lc4SanitizedWireObservation[];
}

function requireOperation(
  positions: ReadonlyMap<Lc4ProviderExchangeOperation, number>,
  operation: Lc4ProviderExchangeOperation,
): number {
  const position = positions.get(operation);
  if (position === undefined) throw new Error(`LC4 provider exchange is missing ${operation}`);
  return position;
}

function before(
  positions: ReadonlyMap<Lc4ProviderExchangeOperation, number>,
  earlier: Lc4ProviderExchangeOperation,
  later: Lc4ProviderExchangeOperation,
): void {
  if (requireOperation(positions, earlier) >= requireOperation(positions, later)) {
    throw new Error(`LC4 provider exchange operation order violates ${earlier} before ${later}`);
  }
}

function assertOperationFsm(
  value: unknown,
  mode: "manual_commit" | "provider_native_server_vad",
  provider: string,
): readonly Lc4ProviderExchangeOperation[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("LC4 provider exchange operation order must be a string array");
  }
  const operations = value as Lc4ProviderExchangeOperation[];
  if (new Set(operations).size !== operations.length) {
    throw new Error("LC4 provider exchange operation order contains duplicates");
  }
  const positions = new Map(operations.map((operation, index) => [operation, index]));
  const manual = [
    "caller_pcm_delivery_started",
    "caller_pcm_delivery_completed",
    "response_plan_prepared",
    "caller_pcm_committed",
    ...(provider === "xai" ? ["caller_pcm_commit_acknowledged"] : []),
    "response_generation_requested",
    "assistant_pcm_captured",
    "listener_evidence_handed_off",
  ] as Lc4ProviderExchangeOperation[];
  const serverVad = [
    "response_plan_session_update_sent",
    "response_plan_session_update_acknowledged",
    "caller_pcm_delivery_started",
    "caller_pcm_delivery_completed",
    "server_vad_silence_tail_delivery_started",
    "server_vad_silence_tail_prefix_accepted",
    "server_vad_speech_started",
    "server_vad_speech_stopped",
    "caller_pcm_auto_committed",
    "response_generation_auto_started",
    "assistant_pcm_captured",
    "listener_evidence_handed_off",
  ] as Lc4ProviderExchangeOperation[];
  const expected = mode === "manual_commit" ? manual : serverVad;
  if (operations.length !== expected.length
    || operations.some((operation) => !expected.includes(operation))) {
    throw new Error(`LC4 provider exchange operation set contradicts ${mode}`);
  }
  if (mode === "manual_commit") {
    for (let index = 1; index < manual.length; index += 1) {
      before(positions, manual[index - 1]!, manual[index]!);
    }
  } else {
    before(positions, "response_plan_session_update_sent", "response_plan_session_update_acknowledged");
    before(positions, "response_plan_session_update_acknowledged", "caller_pcm_delivery_started");
    before(positions, "caller_pcm_delivery_started", "caller_pcm_delivery_completed");
    before(positions, "caller_pcm_delivery_completed", "server_vad_silence_tail_delivery_started");
    before(positions, "caller_pcm_delivery_started", "server_vad_speech_started");
    before(positions, "server_vad_speech_started", "server_vad_speech_stopped");
    before(positions, "server_vad_silence_tail_delivery_started", "server_vad_speech_stopped");
    before(positions, "server_vad_speech_stopped", "server_vad_silence_tail_prefix_accepted");
    before(positions, "server_vad_speech_stopped", "caller_pcm_auto_committed");
    before(positions, "caller_pcm_auto_committed", "response_generation_auto_started");
    before(positions, "response_generation_auto_started", "assistant_pcm_captured");
    before(positions, "assistant_pcm_captured", "listener_evidence_handed_off");
  }
  return Object.freeze([...operations]);
}

function oneWire(
  observations: readonly Lc4SanitizedWireObservation[],
  input: Readonly<{
    observation_sha256: string;
    direction: "inbound" | "outbound";
    wire_type: string;
    label: string;
  }>,
): Lc4SanitizedWireObservation {
  const matches = observations.filter((observation) =>
    observation.observation_sha256 === input.observation_sha256);
  if (matches.length !== 1
    || matches[0]!.direction !== input.direction
    || matches[0]!.wire_type !== input.wire_type) {
    throw new Error(`LC4 provider exchange ${input.label} does not resolve to its exact wire role`);
  }
  return matches[0]!;
}

function wires(
  observations: readonly Lc4SanitizedWireObservation[],
  direction: "inbound" | "outbound",
  wireType: string,
): readonly Lc4SanitizedWireObservation[] {
  return observations.filter((observation) =>
    observation.direction === direction
    && observation.wire_type === wireType);
}

function exactlyOneWire(
  observations: readonly Lc4SanitizedWireObservation[],
  direction: "inbound" | "outbound",
  wireType: string,
  label: string,
): Lc4SanitizedWireObservation {
  const matches = wires(observations, direction, wireType);
  if (matches.length !== 1) {
    throw new Error(`LC4 ${label} requires exactly one ${direction} ${wireType}`);
  }
  return matches[0]!;
}

function assertInputAudioDelivery(input: Readonly<{
  value: unknown;
  expectedPcm: Uint8Array;
  profile: Lc4ProviderExecutionProfile;
  expectedProfileSha256: string;
}>): readonly Uint8Array[] {
  const delivery = record(input.value, "LC4 input audio delivery");
  assertOnlyKeys(delivery, [
    "frame_byte_length",
    "chunk_count",
    "total_byte_length",
    "tail_byte_length",
    "last_scheduled_offset_ms",
    "media_duration_ms",
    "chunks",
    "profile_sha256",
    "pcm_sha256",
  ], "LC4 input audio delivery");
  if (input.expectedProfileSha256
      !== LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256
    || delivery.profile_sha256 !== input.expectedProfileSha256
    || delivery.pcm_sha256 !== sha256Hex(input.expectedPcm)) {
    throw new Error(
      "LC4 provider exchange replay audio delivery differs from its frozen profile or caller PCM",
    );
  }
  const frames = callerFrames(
    input.expectedPcm,
    input.profile.input_sample_rate_hz,
  );
  const expectedFrameBytes = input.profile.input_sample_rate_hz
    * 2
    * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs
    / 1_000;
  const expectedDuration = input.expectedPcm.byteLength
    / 2
    / input.profile.input_sample_rate_hz
    * 1_000;
  if (delivery.frame_byte_length !== expectedFrameBytes
    || delivery.chunk_count !== frames.length
    || delivery.total_byte_length !== input.expectedPcm.byteLength
    || delivery.tail_byte_length !== frames.at(-1)!.byteLength
    || delivery.last_scheduled_offset_ms !== (
      frames.length - 1
    ) * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs
    || delivery.media_duration_ms !== expectedDuration
    || !Array.isArray(delivery.chunks)
    || delivery.chunks.length !== frames.length) {
    throw new Error(
      "LC4 input audio delivery byte, chunk, tail, schedule, or duration accounting is invalid",
    );
  }
  let priorAppendedOffset = Number.NEGATIVE_INFINITY;
  for (const [index, candidate] of delivery.chunks.entries()) {
    const chunk = record(candidate, `LC4 input audio delivery chunk ${index + 1}`);
    assertOnlyKeys(chunk, [
      "chunk_index",
      "byte_length",
      "scheduled_offset_ms",
      "appended_at_offset_ms",
    ], `LC4 input audio delivery chunk ${index + 1}`);
    const scheduledOffset =
      index * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs;
    const appendedOffset = finiteNumber(
      chunk.appended_at_offset_ms,
      `LC4 input audio delivery chunk ${index + 1} append offset`,
    );
    if (chunk.chunk_index !== index + 1
      || chunk.byte_length !== frames[index]!.byteLength
      || chunk.scheduled_offset_ms !== scheduledOffset
      || appendedOffset < scheduledOffset
      || appendedOffset < priorAppendedOffset) {
      throw new Error(
        "LC4 input audio delivery chunk order, bytes, or pacing is invalid",
      );
    }
    priorAppendedOffset = appendedOffset;
  }
  return frames;
}

function expectedInputWireFrame(input: Readonly<{
  provider: "openai" | "gemini" | "xai";
  pcm: Uint8Array;
  sampleRateHz: number;
}>): Readonly<{
  payload_sha256: string;
  payload_bytes: number;
  projection_sha256: string;
}> {
  const base64 = Buffer.from(input.pcm).toString("base64");
  if (input.provider === "gemini") {
    const event = {
      realtimeInput: {
        audio: {
          data: base64,
          mimeType: `audio/pcm;rate=${input.sampleRateHz}`,
        },
      },
    };
    const serialized = JSON.stringify(event);
    const audio = {
      direction: "input",
      chunks: [{
        ...encodedPcmProjection({
          pcm: input.pcm,
          sampleRateHz: input.sampleRateHz,
        }),
        mimeTypeRecognized: true,
      }],
    };
    return Object.freeze({
      payload_sha256: sha256Hex(serialized),
      payload_bytes: Buffer.byteLength(serialized, "utf8"),
      projection_sha256: realtimeWireProjectionSha256({ audio }),
    });
  }
  const event = {
    type: "input_audio_buffer.append",
    audio: base64,
  };
  const serialized = JSON.stringify(event);
  return Object.freeze({
    payload_sha256: sha256Hex(serialized),
    payload_bytes: Buffer.byteLength(serialized, "utf8"),
    projection_sha256: realtimeWireProjectionSha256({
      audio: encodedPcmProjection({
        pcm: input.pcm,
        sampleRateHz: input.sampleRateHz,
      }),
    }),
  });
}

function assertInputWireLineage(input: Readonly<{
  observations: readonly Lc4SanitizedWireObservation[];
  profile: Lc4ProviderExecutionProfile;
  callerFrames: readonly Uint8Array[];
  serverVadSuffix: JsonRecord | null;
}>): void {
  const wireType = input.profile.provider === "gemini"
    ? "realtimeInput.audio"
    : "input_audio_buffer.append";
  const appends = wires(input.observations, "outbound", wireType);
  const suffixFrames = input.serverVadSuffix === null
    ? []
    : Array.from(
        {
          length: integer(
            input.serverVadSuffix.chunk_count,
            "LC4 xAI server-VAD suffix chunk count",
            1,
          ),
        },
        () => new Uint8Array(integer(
          input.serverVadSuffix!.frame_bytes,
          "LC4 xAI server-VAD suffix frame bytes",
          2,
        )),
      );
  const expectedFrames = [...input.callerFrames, ...suffixFrames];
  if (appends.length !== expectedFrames.length) {
    throw new Error(
      "LC4 provider exchange caller PCM wire append count differs from the exact packetizer receipt",
    );
  }
  if (input.profile.provider === "gemini") {
    const start = exactlyOneWire(
      input.observations,
      "outbound",
      "realtimeInput.activityStart",
      "Gemini caller input",
    );
    const end = exactlyOneWire(
      input.observations,
      "outbound",
      "realtimeInput.activityEnd",
      "Gemini caller input",
    );
    if (appends.some((append) =>
      append.sequence <= start.sequence
      || append.sequence >= end.sequence)) {
      throw new Error(
        "LC4 Gemini caller PCM wire append escaped its activity boundary",
      );
    }
  } else if (input.serverVadSuffix === null) {
    const commit = exactlyOneWire(
      input.observations,
      "outbound",
      "input_audio_buffer.commit",
      `${input.profile.provider} caller input`,
    );
    if (appends.some((append) => append.sequence >= commit.sequence)) {
      throw new Error(
        "LC4 manual caller PCM wire append occurred after its input commit",
      );
    }
  } else {
    const acknowledgement = exactlyOneWire(
      input.observations,
      "inbound",
      "session.updated",
      "xAI server-VAD caller input",
    );
    const speechStop = exactlyOneWire(
      input.observations,
      "inbound",
      "input_audio_buffer.speech_stopped",
      "xAI server-VAD caller input",
    );
    if (appends.some((append) =>
      append.sequence <= acknowledgement.sequence
      || append.sequence >= speechStop.sequence)) {
      throw new Error(
        "LC4 xAI server-VAD caller/suffix PCM escaped its acknowledged speech boundary",
      );
    }
  }
  for (const [index, observation] of appends.entries()) {
    const expected = expectedInputWireFrame({
      provider: input.profile.provider,
      pcm: expectedFrames[index]!,
      sampleRateHz: input.profile.input_sample_rate_hz,
    });
    if (observation.payload_sha256 !== expected.payload_sha256
      || observation.payload_bytes !== expected.payload_bytes
      || observation.projection_sha256 !== expected.projection_sha256) {
      throw new Error(
        "LC4 provider exchange caller PCM wire append differs from its exact retained PCM chunk",
      );
    }
  }
}

function identityHash(
  observation: Lc4SanitizedWireObservation,
  key: "responseIdSha256" | "callIdSha256",
  label: string,
): string {
  const digest = observation.identity_hashes[key];
  if (typeof digest !== "string" || !SHA256.test(digest)) {
    throw new Error(`LC4 ${label} lacks its ${key} identity commitment`);
  }
  return digest;
}

function assertToolCallResultCausality(
  observations: readonly Lc4SanitizedWireObservation[],
  input: Readonly<{
    provider: "openai" | "gemini";
    call_wire_type: "response.function_call_arguments.done" | "toolCall";
    result_wire_type: "conversation.item.create" | "toolResponse";
  }>,
): void {
  const calls = wires(observations, "inbound", input.call_wire_type);
  const results = wires(observations, "outbound", input.result_wire_type);
  if ((calls.length === 0) !== (results.length === 0)) {
    throw new Error(
      `LC4 ${input.provider} provider tool call/result lifecycle is incomplete`,
    );
  }
  const callIds = new Set<string>();
  for (const call of calls) {
    const callId = identityHash(
      call,
      "callIdSha256",
      `${input.provider} tool call`,
    );
    if (callIds.has(callId)) {
      throw new Error(`LC4 ${input.provider} provider tool call identity is duplicated`);
    }
    callIds.add(callId);
    const matches = results.filter((result) =>
      result.identity_hashes.callIdSha256 === callId);
    if (matches.length !== 1 || matches[0]!.sequence <= call.sequence) {
      throw new Error(
        `LC4 ${input.provider} provider tool result is missing, foreign, duplicated, or reordered`,
      );
    }
  }
  if (results.some((result) => {
    const callId = result.identity_hashes.callIdSha256;
    return typeof callId !== "string" || !callIds.has(callId);
  })) {
    throw new Error(`LC4 ${input.provider} provider tool result has no causal call`);
  }
}

type ReplayedOutputCapture = Readonly<{
  capture: JsonRecord;
  chunks: readonly JsonRecord[];
  pcmChunks: readonly Uint8Array[];
}>;

function assertOutputCapture(input: Readonly<{
  value: unknown;
  profile: Lc4ProviderExecutionProfile;
  runId: string;
  opportunityId: string;
  listenerPcm: Uint8Array;
}>): ReplayedOutputCapture {
  const capture = record(input.value, "LC4 provider output capture");
  assertOnlyKeys(capture, [
    "schema_version",
    "run_id",
    "opportunity_id",
    "response_id",
    "provider",
    "surface",
    "format",
    "chunks",
    "generated_byte_length",
    "generated_pcm_sha256",
    "generated_chunk_sequence_sha256",
    "capture_receipt_sha256",
  ], "LC4 provider output capture");
  const format = record(capture.format, "LC4 provider output capture format");
  assertOnlyKeys(format, [
    "encoding",
    "endianness",
    "sample_rate_hz",
    "channels",
  ], "LC4 provider output capture format");
  if (capture.schema_version !== 1
    || capture.run_id !== input.runId
    || capture.opportunity_id !== input.opportunityId
    || capture.provider !== input.profile.provider
    || capture.surface !== "server_realtime_pcm"
    || format.encoding !== "pcm16"
    || format.endianness !== "little"
    || format.sample_rate_hz !== input.profile.output_sample_rate_hz
    || format.channels !== 1
    || safeId(capture.response_id, "LC4 provider output response ID")
      !== capture.response_id
    || !Array.isArray(capture.chunks)
    || capture.chunks.length < 1
    || capture.chunks.length > 4_096) {
    throw new Error(
      "LC4 provider output capture identity, surface, format, or chunks are invalid",
    );
  }
  const listenerPcm = bytes(
    input.listenerPcm,
    "LC4 listener-consumed provider output",
  );
  const chunks: JsonRecord[] = [];
  const pcmChunks: Uint8Array[] = [];
  let previous: string | null = null;
  let offset = 0;
  for (const [ordinal, candidate] of capture.chunks.entries()) {
    const chunk = record(candidate, `LC4 output capture chunk ${ordinal + 1}`);
    assertOnlyKeys(chunk, [
      "schema_version",
      "run_id",
      "opportunity_id",
      "response_id",
      "provider",
      "surface",
      "ordinal",
      "chunk_id",
      "sample_rate_hz",
      "byte_length",
      "pcm_sha256",
      "previous_chunk_receipt_sha256",
      "receipt_sha256",
    ], `LC4 output capture chunk ${ordinal + 1}`);
    const byteLength = integer(
      chunk.byte_length,
      `LC4 output capture chunk ${ordinal + 1} bytes`,
      2,
    );
    if (byteLength % 2 !== 0
      || offset + byteLength > listenerPcm.byteLength) {
      throw new Error("LC4 output capture chunk exceeds exact listener PCM");
    }
    const pcm = listenerPcm.slice(offset, offset + byteLength);
    offset += byteLength;
    const {
      receipt_sha256: claimedReceipt,
      ...chunkBody
    } = chunk;
    if (chunk.schema_version !== 1
      || chunk.run_id !== capture.run_id
      || chunk.opportunity_id !== capture.opportunity_id
      || chunk.response_id !== capture.response_id
      || chunk.provider !== capture.provider
      || chunk.surface !== capture.surface
      || chunk.ordinal !== ordinal
      || safeId(
        chunk.chunk_id,
        `LC4 output capture chunk ${ordinal + 1} ID`,
      ) !== chunk.chunk_id
      || chunk.sample_rate_hz !== format.sample_rate_hz
      || chunk.pcm_sha256 !== sha256Hex(pcm)
      || chunk.previous_chunk_receipt_sha256 !== previous
      || claimedReceipt !== domainHash(
        CAPTURE_CHUNK_DOMAIN,
        chunkBody,
      )) {
      throw new Error(
        "LC4 output capture chunk is substituted, reordered, truncated, or rehashed",
      );
    }
    previous = string(
      claimedReceipt,
      `LC4 output capture chunk ${ordinal + 1} receipt`,
    );
    chunks.push(chunk);
    pcmChunks.push(pcm);
  }
  const generatedByteLength = integer(
    capture.generated_byte_length,
    "LC4 output capture generated bytes",
    2,
  );
  const captureBody = {
    schema_version: capture.schema_version,
    run_id: capture.run_id,
    opportunity_id: capture.opportunity_id,
    response_id: capture.response_id,
    provider: capture.provider,
    surface: capture.surface,
    format: capture.format,
    chunks,
    generated_byte_length: capture.generated_byte_length,
    generated_pcm_sha256: capture.generated_pcm_sha256,
    generated_chunk_sequence_sha256:
      capture.generated_chunk_sequence_sha256,
  };
  if (offset !== listenerPcm.byteLength
    || generatedByteLength !== listenerPcm.byteLength
    || capture.generated_pcm_sha256 !== sha256Hex(listenerPcm)
    || capture.generated_chunk_sequence_sha256 !== domainHash(
      CAPTURE_CHUNK_SEQUENCE_DOMAIN,
      { format: capture.format, chunks },
    )
    || capture.capture_receipt_sha256 !== domainHash(
      CAPTURE_DOMAIN,
      captureBody,
    )) {
    throw new Error(
      "LC4 output capture aggregate differs from its exact complete listener PCM",
    );
  }
  return Object.freeze({
    capture,
    chunks: Object.freeze(chunks),
    pcmChunks: Object.freeze(pcmChunks),
  });
}

function assertExactOpenAiCompatibleOutputWire(input: Readonly<{
  observations: readonly Lc4SanitizedWireObservation[];
  capture: ReplayedOutputCapture;
  profile: Lc4ProviderExecutionProfile;
}>): void {
  const audio = input.observations.filter((observation) =>
    observation.direction === "inbound"
    && (observation.wire_type === "response.audio.delta"
      || observation.wire_type === "response.output_audio.delta"));
  if (audio.length < 1) {
    throw new Error("LC4 provider output has no inbound PCM wire evidence");
  }
  const outputResponseId = identityHash(
    audio.at(-1)!,
    "responseIdSha256",
    `${input.profile.provider} output audio`,
  );
  const outputAudio = audio.filter((observation) =>
    observation.identity_hashes.responseIdSha256 === outputResponseId);
  if (outputAudio.length !== input.capture.pcmChunks.length) {
    throw new Error(
      "LC4 provider output capture chunk count differs from its identity-matched inbound PCM wire frames",
    );
  }
  const starts = wires(
    input.observations,
    "inbound",
    "response.created",
  ).filter((observation) =>
    observation.identity_hashes.responseIdSha256 === outputResponseId);
  const terminals = wires(
    input.observations,
    "inbound",
    "response.done",
  ).filter((observation) =>
    observation.identity_hashes.responseIdSha256 === outputResponseId);
  if (starts.length !== 1
    || terminals.length !== 1
    || starts[0]!.sequence >= outputAudio[0]!.sequence
    || terminals[0]!.sequence <= outputAudio.at(-1)!.sequence) {
    throw new Error(
      "LC4 provider output capture is not enclosed by one identity-matched response start and terminal",
    );
  }
  for (const [index, observation] of outputAudio.entries()) {
    const expectedProjection = realtimeWireProjectionSha256({
      audio: encodedPcmProjection({
        pcm: input.capture.pcmChunks[index]!,
        sampleRateHz: input.profile.output_sample_rate_hz,
      }),
    });
    if (observation.projection_sha256 !== expectedProjection) {
      throw new Error(
        "LC4 provider output capture PCM differs from its exact inbound wire audio projection",
      );
    }
  }
}

function geminiOutputProjectionSha256(
  pcmChunks: readonly Uint8Array[],
  sampleRateHz: number,
  terminal: boolean,
): string {
  const projection: Record<string, unknown> = {
    audio: {
      direction: "output",
      chunks: pcmChunks.map((pcm) => ({
        ...encodedPcmProjection({ pcm, sampleRateHz }),
        mimeTypeRecognized: true,
      })),
    },
  };
  if (terminal) projection.terminal = { status: "completed" };
  return realtimeWireProjectionSha256(projection);
}

function assertExactGeminiOutputWire(input: Readonly<{
  observations: readonly Lc4SanitizedWireObservation[];
  capture: ReplayedOutputCapture;
  profile: Lc4ProviderExecutionProfile;
}>): void {
  const activityEnd = exactlyOneWire(
    input.observations,
    "outbound",
    "realtimeInput.activityEnd",
    "Gemini finite caller turn",
  );
  const serverContent = input.observations.filter((observation) =>
    observation.direction === "inbound"
    && observation.wire_type === "serverContent"
    && observation.sequence > activityEnd.sequence);
  if (serverContent.length < 1) {
    throw new Error("LC4 Gemini output has no observed serverContent turn");
  }
  const terminalOnly = realtimeWireProjectionSha256({
    terminal: { status: "completed" },
  });
  let states = new Map<string, number>([["0:false", 1]]);
  let candidates = 0;
  for (const observation of serverContent) {
    const next = new Map<string, number>();
    let matchedAudioOrTerminal = false;
    for (const [state, ways] of states) {
      const [startText, terminalText] = state.split(":");
      const start = Number(startText);
      const terminalSeen = terminalText === "true";
      if (terminalSeen) continue;
      if (observation.projection_sha256 === terminalOnly
        && start === input.capture.pcmChunks.length) {
        matchedAudioOrTerminal = true;
        const key = `${start}:true`;
        next.set(key, Math.min(2, (next.get(key) ?? 0) + ways));
      }
      for (
        let end = start + 1;
        end <= input.capture.pcmChunks.length;
        end += 1
      ) {
        candidates += 1;
        if (candidates > 100_000) {
          throw new Error(
            "LC4 Gemini output wire-to-capture attribution is too ambiguous to replay safely",
          );
        }
        const chunks = input.capture.pcmChunks.slice(start, end);
        const audioOnly = observation.projection_sha256
          === geminiOutputProjectionSha256(
            chunks,
            input.profile.output_sample_rate_hz,
            false,
          );
        const audioAndTerminal = observation.projection_sha256
          === geminiOutputProjectionSha256(
            chunks,
            input.profile.output_sample_rate_hz,
            true,
          );
        if (audioOnly || audioAndTerminal) {
          if (audioAndTerminal
            && end !== input.capture.pcmChunks.length) continue;
          matchedAudioOrTerminal = true;
          const key = `${end}:${terminalSeen || audioAndTerminal}`;
          next.set(key, Math.min(2, (next.get(key) ?? 0) + ways));
        }
      }
    }
    if (!matchedAudioOrTerminal) next.clear();
    states = next;
  }
  if (states.get(`${input.capture.pcmChunks.length}:true`) !== 1) {
    throw new Error(
      "LC4 Gemini output capture PCM lacks one unique ordered activityEnd-to-turnComplete serverContent alignment",
    );
  }
}

function materializeOutputCapture(
  capture: ReplayedOutputCapture,
): Lc4CapturedOutput {
  return Object.freeze({
    ...(capture.capture as unknown as Omit<Lc4CapturedOutput, "chunks">),
    chunks: Object.freeze(capture.chunks.map((receipt, index) =>
      Object.freeze({
        pcm: Uint8Array.from(capture.pcmChunks[index]!),
        receipt: receipt as unknown as Lc4CapturedOutput["chunks"][number]["receipt"],
      }))),
  });
}

function assertVersionedGeminiOutputAttribution(input: Readonly<{
  value: JsonValue;
  observations: readonly Lc4SanitizedWireObservation[];
  capture: ReplayedOutputCapture;
}>): void {
  const attribution = record(
    input.value,
    "LC4 Gemini versioned output attribution",
  );
  if (!Array.isArray(attribution.interval_frames)) {
    throw new Error("LC4 Gemini versioned output attribution interval frames must be an array");
  }
  const wireProjections = attribution.interval_frames.map(
    (candidate, index) => {
      const frame = record(
        candidate,
        `LC4 Gemini versioned output attribution interval frame ${index + 1}`,
      );
      const wireObservation = record(
        frame.wire_observation,
        `LC4 Gemini versioned output attribution interval frame ${index + 1} wire observation`,
      );
      return Object.freeze({
        wire_observation_sha256: hash(
          wireObservation.observation_sha256,
          `LC4 Gemini versioned output attribution interval frame ${index + 1} observation`,
        ),
        redacted_projection: frame.redacted_projection,
      });
    },
  );
  const rebuilt = createLc4GeminiOutputAttribution({
    observations: input.observations,
    wire_projections: wireProjections,
    capture: materializeOutputCapture(input.capture),
  });
  if (canonicalJson(rebuilt) !== canonicalJson(
    attribution as unknown as Lc4GeminiOutputAttribution,
  )) {
    throw new Error(
      "LC4 Gemini versioned output attribution differs from exact wire projections and capture",
    );
  }
}

function assertListenerEvidence(input: Readonly<{
  projection: JsonRecord;
  capture: ReplayedOutputCapture;
  expected: Lc4ProviderExchangeReplayExpectation;
}>): void {
  const listenerResult = record(
    input.projection.dev_listener_result,
    "LC4 DEV listener result",
  );
  assertOnlyKeys(listenerResult, [
    "listener_evidence_sha256",
    "repair_projection",
    "playback_authority_receipt_sha256",
    "listener_evidence",
  ], "LC4 DEV listener result");
  const listenerReference = record(
    listenerResult.listener_evidence,
    "LC4 DEV listener evidence reference",
  );
  assertOnlyKeys(listenerReference, [
    "schema_version",
    "retention_version",
    "kind",
    "evidence_sha256",
    "byte_length",
    "content_encoding",
    "domain_prefix",
  ], "LC4 DEV listener evidence reference");
  if (listenerReference.schema_version !== 1
    || listenerReference.retention_version
      !== "lc4-dev-replay-evidence-v1"
    || listenerReference.kind !== "listener_evidence"
    || listenerReference.content_encoding
      !== "domain-prefixed-canonical-json"
    || listenerReference.domain_prefix !== LISTENER_EVIDENCE_DOMAIN
    || integer(
      listenerReference.byte_length,
      "LC4 DEV listener evidence byte length",
      1,
    ) !== input.expected.listener_evidence_reference.byte_length
    || canonicalJson(listenerReference)
      !== canonicalJson(input.expected.listener_evidence_reference)) {
    throw new Error(
      "LC4 DEV listener result differs from its exact retained evidence reference",
    );
  }
  const evidence = record(
    input.expected.listener_evidence_projection,
    "LC4 DEV listener evidence",
  );
  assertOnlyKeys(evidence, [
    "schema_version",
    "dependency_version",
    "episode_id",
    "opportunity_id",
    "provider",
    "capture_receipt_sha256",
    "generated_pcm_sha256",
    "captured_pcm_sha256",
    "evaluator_consumed_pcm_sha256",
    "evaluator_consumed_byte_start",
    "evaluator_consumed_byte_end",
    "evaluator_consumed_pcm_cas_receipt_sha256",
    "headless_listener_authority_receipt_sha256",
    "headless_listener_authority_receipt_cas_sha256",
    "headless_listener_authority_receipt_cas_receipt_sha256",
    "physical_playback_status",
    "human_audibility_status",
    "criterion_plan_sha256",
    "response_plan_sha256",
    "wire_observation_set_sha256",
    "signed_invocation_artifact_cas_sha256",
    "signed_invocation_artifact_byte_length",
    "evaluation",
    "listener_manifest_sha256",
  ], "LC4 DEV listener evidence");
  const evidenceSha256 = domainHash(LISTENER_EVIDENCE_DOMAIN, evidence);
  if (listenerResult.listener_evidence_sha256 !== evidenceSha256
    || listenerReference.evidence_sha256 !== evidenceSha256) {
    throw new Error(
      "LC4 DEV listener result is not bound to the exact retained listener JSON",
    );
  }
  const capture = input.capture.capture;
  const listenerPcm = input.expected.listener_consumed_pcm;
  const pcmSha256 = sha256Hex(listenerPcm);
  const expectedPcmCasReceipt = domainHash(CAS_RECEIPT_DOMAIN, {
    schema_version: 1,
    algorithm: "sha256",
    artifact_sha256: pcmSha256,
    byte_length: listenerPcm.byteLength,
    relative_path: `${pcmSha256.slice(0, 2)}/${pcmSha256}`,
    media_type: "audio/pcm",
  });
  const evaluation = record(
    evidence.evaluation,
    "LC4 DEV listener evaluation",
  );
  const allowedEvaluationKeys = new Set([
    "source_pcm_sha256",
    "source_pcm_byte_length",
    "evaluator_contract_sha256",
    "evaluator_build_sha256",
    "calibration_sha256",
    "transcript_sha256",
    "semantic_result_sha256",
    "semantic_artifact_cas_sha256",
    "signed_invocation_receipt_sha256",
    "signed_invocation_artifact_cas_sha256",
    "signed_invocation_artifact_byte_length",
    "repair_projection",
  ]);
  if (Object.keys(evaluation).some((key) =>
    !allowedEvaluationKeys.has(key))
    || ![
      "source_pcm_sha256",
      "source_pcm_byte_length",
      "evaluator_contract_sha256",
      "evaluator_build_sha256",
      "calibration_sha256",
      "transcript_sha256",
      "semantic_result_sha256",
      "signed_invocation_receipt_sha256",
      "signed_invocation_artifact_cas_sha256",
      "signed_invocation_artifact_byte_length",
      "repair_projection",
    ].every((key) => Object.hasOwn(evaluation, key))) {
    throw new Error("LC4 DEV listener evaluation has missing or unknown fields");
  }
  for (const [label, digest] of [
    ["evaluator contract", evaluation.evaluator_contract_sha256],
    ["evaluator build", evaluation.evaluator_build_sha256],
    ["evaluator calibration", evaluation.calibration_sha256],
    ["evaluator transcript", evaluation.transcript_sha256],
    ["evaluator semantic result", evaluation.semantic_result_sha256],
    ["evaluator signed invocation", evaluation.signed_invocation_receipt_sha256],
    [
      "evaluator signed invocation artifact",
      evaluation.signed_invocation_artifact_cas_sha256,
    ],
    [
      "listener signed invocation artifact",
      evidence.signed_invocation_artifact_cas_sha256,
    ],
    ["listener criterion plan", evidence.criterion_plan_sha256],
    ["listener manifest", evidence.listener_manifest_sha256],
    [
      "headless listener authority receipt",
      evidence.headless_listener_authority_receipt_sha256,
    ],
    [
      "headless listener authority CAS artifact",
      evidence.headless_listener_authority_receipt_cas_sha256,
    ],
    [
      "headless listener authority CAS receipt",
      evidence.headless_listener_authority_receipt_cas_receipt_sha256,
    ],
  ] as const) hash(digest, `LC4 ${label}`);
  if (evaluation.semantic_artifact_cas_sha256 !== undefined) {
    hash(
      evaluation.semantic_artifact_cas_sha256,
      "LC4 evaluator semantic artifact CAS hash",
    );
  }
  const invocationArtifactByteLength = integer(
    evaluation.signed_invocation_artifact_byte_length,
    "LC4 evaluator signed invocation artifact byte length",
    1,
  );
  const listenerInvocationArtifactByteLength = integer(
    evidence.signed_invocation_artifact_byte_length,
    "LC4 listener signed invocation artifact byte length",
    1,
  );
  assertLc4DevArmBlindRepairProjection(
    evaluation.repair_projection as unknown as Lc4DevArmBlindRepairProjection,
  );
  if (evidence.schema_version !== 1
    || evidence.dependency_version !== LC4_DEV_LIVE_DEPENDENCY_VERSION
    || evidence.episode_id !== input.expected.run_id
    || evidence.opportunity_id !== input.expected.opportunity_id
    || evidence.provider !== input.expected.provider_profile.provider
    || evidence.capture_receipt_sha256
      !== capture.capture_receipt_sha256
    || evidence.generated_pcm_sha256 !== pcmSha256
    || evidence.captured_pcm_sha256 !== pcmSha256
    || evidence.evaluator_consumed_pcm_sha256 !== pcmSha256
    || evidence.evaluator_consumed_byte_start !== 0
    || evidence.evaluator_consumed_byte_end !== listenerPcm.byteLength
    || evidence.evaluator_consumed_pcm_cas_receipt_sha256
      !== expectedPcmCasReceipt
    || evidence.headless_listener_authority_receipt_sha256
      !== listenerResult.playback_authority_receipt_sha256
    || evidence.physical_playback_status !== "not_performed_headless"
    || evidence.human_audibility_status !== "not_measured_not_claimed"
    || evidence.response_plan_sha256
      !== input.projection.response_plan_sha256
    || evidence.wire_observation_set_sha256
      !== input.projection.wire_observation_set_sha256
    || evidence.listener_manifest_sha256
      !== input.expected.listener_manifest_sha256
    || input.projection.assistant_conversation_transcript_source
      !== "listener_exact_captured_pcm_asr"
    || input.projection.assistant_conversation_transcript_sha256
      !== evaluation.transcript_sha256
    || evaluation.source_pcm_sha256 !== pcmSha256
    || evaluation.source_pcm_byte_length !== listenerPcm.byteLength
    || evaluation.evaluator_build_sha256
      !== input.expected.evaluator_build_sha256
    || evidence.signed_invocation_artifact_cas_sha256
      !== evaluation.signed_invocation_artifact_cas_sha256
    || listenerInvocationArtifactByteLength
      !== invocationArtifactByteLength
    || record(
      evaluation.repair_projection,
      "LC4 evaluator repair projection",
    ).semantic_result_sha256 !== evaluation.semantic_result_sha256
    || canonicalJson(evaluation.repair_projection)
      !== canonicalJson(listenerResult.repair_projection)) {
    throw new Error(
      "LC4 DEV listener/CAS/evaluator evidence is not bound to the exact complete output capture",
    );
  }
}

function assertOpenAiWireCausality(
  observations: readonly Lc4SanitizedWireObservation[],
): void {
  const appends = wires(
    observations,
    "outbound",
    "input_audio_buffer.append",
  );
  const commit = exactlyOneWire(
    observations,
    "outbound",
    "input_audio_buffer.commit",
    "OpenAI finite caller turn",
  );
  const creates = wires(observations, "outbound", "response.create");
  const starts = wires(observations, "inbound", "response.created");
  const audio = observations.filter((observation) =>
    observation.direction === "inbound"
    && (observation.wire_type === "response.audio.delta"
      || observation.wire_type === "response.output_audio.delta"));
  const terminals = wires(observations, "inbound", "response.done");
  if (appends.length < 1
    || creates.length < 1
    || starts.length < 1
    || audio.length < 1
    || terminals.length < 1
    || appends.some((append) => append.sequence >= commit.sequence)
    || creates[0]!.sequence <= commit.sequence
    || starts[0]!.sequence <= creates[0]!.sequence) {
    throw new Error(
      "LC4 OpenAI wire evidence lacks ordered append/commit/create/start/audio/terminal roles",
    );
  }
  const outputAudio = audio.at(-1)!;
  const outputResponseId = identityHash(
    outputAudio,
    "responseIdSha256",
    "OpenAI output audio",
  );
  const outputStarts = starts.filter((start) =>
    start.identity_hashes.responseIdSha256 === outputResponseId
    && start.sequence < outputAudio.sequence);
  const outputTerminals = terminals.filter((terminal) =>
    terminal.identity_hashes.responseIdSha256 === outputResponseId
    && terminal.sequence > outputAudio.sequence);
  if (outputStarts.length !== 1 || outputTerminals.length !== 1) {
    throw new Error(
      "LC4 OpenAI output audio is not enclosed by one identity-matched response start and terminal",
    );
  }
  assertToolCallResultCausality(observations, {
    provider: "openai",
    call_wire_type: "response.function_call_arguments.done",
    result_wire_type: "conversation.item.create",
  });
  const toolResults = wires(
    observations,
    "outbound",
    "conversation.item.create",
  );
  for (const result of toolResults) {
    if (!creates.some((create) => create.sequence > result.sequence)) {
      throw new Error(
        "LC4 OpenAI tool result lacks a subsequent continuation response.create",
      );
    }
  }
}

function assertGeminiWireCausality(
  observations: readonly Lc4SanitizedWireObservation[],
): void {
  const start = exactlyOneWire(
    observations,
    "outbound",
    "realtimeInput.activityStart",
    "Gemini finite caller turn",
  );
  const end = exactlyOneWire(
    observations,
    "outbound",
    "realtimeInput.activityEnd",
    "Gemini finite caller turn",
  );
  const audio = wires(observations, "outbound", "realtimeInput.audio");
  const serverContent = observations.filter((observation) =>
    observation.direction === "inbound"
    && (observation.wire_type === "serverContent"
      || observation.wire_type.startsWith("serverContent.")));
  if (audio.length < 1
    || audio.some((observation) =>
      observation.sequence <= start.sequence
      || observation.sequence >= end.sequence)
    || end.sequence <= start.sequence
    || serverContent.length < 1
    || !serverContent.some((observation) =>
      observation.sequence > end.sequence)
    || observations.some((observation) =>
      observation.direction === "outbound"
      && (observation.wire_type === "response.create"
        || observation.wire_type === "input_audio_buffer.commit"))) {
    throw new Error(
      "LC4 Gemini wire evidence lacks ordered activityStart/audio/activityEnd/provider-response roles",
    );
  }
  assertToolCallResultCausality(observations, {
    provider: "gemini",
    call_wire_type: "toolCall",
    result_wire_type: "toolResponse",
  });
  const toolResults = wires(observations, "outbound", "toolResponse");
  for (const result of toolResults) {
    if (!serverContent.some((observation) =>
      observation.sequence > result.sequence)) {
      throw new Error(
        "LC4 Gemini tool result lacks a subsequent provider continuation",
      );
    }
  }
}

function assertManualCausality(
  value: unknown,
  observations: readonly Lc4SanitizedWireObservation[],
): void {
  assertLc4XaiManualTurnCausality(value, observations);
}

function assertServerVadSuffix(
  value: unknown,
  deliveryProfileSha256: string,
): void {
  const suffix = record(value, "LC4 xAI server-VAD suffix") as unknown as Lc4XaiServerVadTransportSuffixEvidence;
  if (suffix.schema_version !== 1
    || suffix.purpose !== LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose
    || suffix.completion !== "provider_native_speech_stop"
    || suffix.policy_sha256 !== LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256
    || suffix.delivery_profile_sha256 !== deliveryProfileSha256
    || !isAcceptedXaiServerVadSilenceTail(suffix)
    || !Array.isArray(suffix.scheduled_offsets_ms)
    || canonicalJson(suffix.scheduled_offsets_ms) !== canonicalJson(
      Array.from({ length: suffix.chunk_count }, (_, index) =>
        index * LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms),
    )) {
    throw new Error("LC4 xAI server-VAD suffix contradicts the frozen delimiter policy");
  }
}

function assertServerVadWireCausality(
  projection: JsonRecord,
  observations: readonly Lc4SanitizedWireObservation[],
): void {
  const update = oneWire(observations, {
    observation_sha256: hash(
      projection.per_turn_session_update_observation_sha256,
      "LC4 xAI server-VAD session update observation",
    ),
    direction: "outbound",
    wire_type: "session.update",
    label: "server-VAD session update",
  });
  const acknowledgement = oneWire(observations, {
    observation_sha256: hash(
      projection.per_turn_session_ack_observation_sha256,
      "LC4 xAI server-VAD session acknowledgement observation",
    ),
    direction: "inbound",
    wire_type: "session.updated",
    label: "server-VAD session acknowledgement",
  });
  const exact = (direction: "inbound" | "outbound", wireType: string) => {
    const matches = observations.filter((observation) =>
      observation.direction === direction && observation.wire_type === wireType);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const speechStart = exact("inbound", "input_audio_buffer.speech_started");
  const speechStop = exact("inbound", "input_audio_buffer.speech_stopped");
  const autoCommit = exact("inbound", "input_audio_buffer.committed");
  const autoResponse = observations.find((observation) =>
    observation.direction === "inbound" && observation.wire_type === "response.created");
  if (update.connection_epoch !== acknowledgement.connection_epoch
    || update.sequence >= acknowledgement.sequence
    || observations.filter((observation) =>
      observation.direction === "outbound" && observation.wire_type === "session.update").length !== 1
    || observations.filter((observation) =>
      observation.direction === "inbound" && observation.wire_type === "session.updated").length !== 1
    || !speechStart || !speechStop || !autoCommit || !autoResponse
    || !(acknowledgement.sequence < speechStart.sequence
      && speechStart.sequence < speechStop.sequence
      && speechStop.sequence < autoCommit.sequence
      && autoCommit.sequence < autoResponse.sequence)
    || observations.some((observation) =>
      observation.direction === "outbound"
      && observation.wire_type === "input_audio_buffer.commit")
    || observations.some((observation) =>
      observation.direction === "outbound"
      && observation.wire_type === "response.create"
      && observation.sequence < autoResponse.sequence)) {
    throw new Error("LC4 xAI server-VAD wire evidence violates update/speech/auto-commit/auto-response causality");
  }
}

/**
 * Replays the semantic contract of a CAS-retained provider exchange. A fresh,
 * internally consistent CAS hash cannot make a different transport mode,
 * profile, or causal FSM admissible.
 */
export function assertLc4ProviderExchangeReplayProjection(
  value: JsonValue,
  expected: Lc4ProviderExchangeReplayExpectation,
): Lc4ProviderExchangeReplayResult {
  const projection = record(value, "LC4 provider exchange replay projection");
  const profile = expected.provider_profile;
  const callerPcm = bytes(expected.caller_pcm, "LC4 exact retained caller PCM");
  const listenerPcm = bytes(
    expected.listener_consumed_pcm,
    "LC4 exact retained listener PCM",
  );
  const schemaVersion = projection.schema_version;
  const hasGeminiOutputAttribution = Object.prototype.hasOwnProperty.call(
    projection,
    "gemini_output_attribution",
  );
  if ((schemaVersion !== 2 && schemaVersion !== 3)
    || (schemaVersion === 2 && hasGeminiOutputAttribution)
    || (schemaVersion === 3 && !hasGeminiOutputAttribution)
    || projection.adapter_version !== LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION
    || projection.run_id !== expected.run_id
    || projection.opportunity_id !== expected.opportunity_id
    || projection.segment_ordinal !== expected.segment_ordinal
    || projection.playback_kind !== expected.playback_kind
    || projection.provider !== profile.provider
    || projection.model !== profile.model
    || projection.caller_pcm_sha256 !== expected.caller_pcm_sha256
    || projection.caller_pcm_byte_length !== expected.caller_pcm_byte_length
    || expected.caller_pcm_sha256 !== sha256Hex(callerPcm)
    || expected.caller_pcm_byte_length !== callerPcm.byteLength
    || projection.response_control_kind !== expected.response_control_kind) {
    throw new Error("LC4 provider exchange replay differs from its episode, opportunity, PCM, or arm");
  }
  if (schemaVersion === 3) {
    if (profile.provider === "gemini") {
      record(
        projection.gemini_output_attribution,
        "LC4 Gemini versioned output attribution",
      );
    } else if (projection.gemini_output_attribution !== null) {
      throw new Error(
        "LC4 non-Gemini schema v3 exchange contains Gemini output attribution",
      );
    }
  }
  const requested = record(projection.requested_runtime_identity, "LC4 requested runtime identity");
  const effective = record(projection.effective_runtime_identity, "LC4 effective runtime identity");
  for (const identity of [requested, effective]) {
    if (identity.provider !== profile.provider
      || identity.model !== profile.model
      || identity.voice !== profile.voice) {
      throw new Error("LC4 provider exchange replay runtime identity differs from its frozen profile");
    }
  }
  const inputFrames = assertInputAudioDelivery({
    value: projection.input_audio_delivery,
    expectedPcm: callerPcm,
    profile,
    expectedProfileSha256: expected.input_audio_delivery_profile_sha256,
  });
  const expectedMode = profile.provider === "xai"
    ? profile.transport_mode
    : "manual_commit";
  const expectedPurpose = profile.provider === "xai"
    ? profile.transport_purpose
    : null;
  const expectedProfileSha256 = profile.transport_profile_sha256
    ?? profile.provider_profile_sha256;
  if (projection.transport_mode !== expectedMode
    || projection.transport_purpose !== expectedPurpose
    || projection.transport_profile_sha256 !== expectedProfileSha256) {
    throw new Error("LC4 provider exchange replay transport mode or profile differs from the frozen episode");
  }
  hash(projection.transport_parity_sha256, "LC4 provider exchange transport parity");
  if (profile.provider !== "xai"
    && projection.transport_parity_sha256 !== profile.provider_profile_sha256) {
    throw new Error("LC4 provider exchange replay transport parity differs from the frozen provider profile");
  }
  hash(projection.tool_frontier_sha256, "LC4 provider exchange tool frontier");
  const observations = wireObservations(projection.wire_observations, profile.provider);
  if (projection.wire_observation_set_sha256 !== sha256Hex(
    `${WIRE_SET_DOMAIN}${canonicalJson(observations)}`,
  )) throw new Error("LC4 provider exchange wire observation set commitment is invalid");
  assertOperationFsm(projection.operation_order, expectedMode!, profile.provider);
  const outputCapture = assertOutputCapture({
    value: projection.output_capture,
    profile,
    runId: expected.run_id,
    opportunityId: expected.opportunity_id,
    listenerPcm,
  });

  if (expectedMode === "provider_native_server_vad") {
    if (profile.provider !== "xai"
      || expectedPurpose !== "interactive_transport_qualification"
      || projection.server_vad_setting_sha256 !== LC4_XAI_SERVER_VAD_SHA256
      || projection.server_vad_transport_disclosure_sha256
        !== LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256
      || projection.xai_manual_turn_causality !== null) {
      throw new Error("LC4 provider exchange replay server-VAD evidence contradicts its transport profile");
    }
    assertServerVadSuffix(
      projection.server_vad_transport_suffix,
      expected.input_audio_delivery_profile_sha256,
    );
    assertInputWireLineage({
      observations,
      profile,
      callerFrames: inputFrames,
      serverVadSuffix: record(
        projection.server_vad_transport_suffix,
        "LC4 xAI server-VAD suffix",
      ),
    });
    assertServerVadWireCausality(projection, observations);
  } else {
    if (projection.server_vad_setting_sha256 !== null
      || projection.server_vad_transport_disclosure_sha256 !== null
      || projection.server_vad_transport_suffix !== null
      || nullableHash(
        projection.per_turn_session_update_observation_sha256,
        "LC4 per-turn session update observation",
      ) !== null
      || nullableHash(
        projection.per_turn_session_ack_observation_sha256,
        "LC4 per-turn session acknowledgement observation",
      ) !== null) {
      throw new Error("LC4 provider exchange replay manual transport contains server-VAD evidence");
    }
    assertInputWireLineage({
      observations,
      profile,
      callerFrames: inputFrames,
      serverVadSuffix: null,
    });
    if (profile.provider === "xai") {
      assertManualCausality(projection.xai_manual_turn_causality, observations);
    } else {
      if (projection.xai_manual_turn_causality !== null) {
        throw new Error("LC4 non-xAI provider exchange contains xAI manual causality evidence");
      }
      if (profile.provider === "openai") {
        assertOpenAiWireCausality(observations);
      } else {
        assertGeminiWireCausality(observations);
      }
    }
  }
  let outputAudioLineageScope:
    Lc4ProviderExchangeReplayResult["output_audio_lineage_scope"];
  if (profile.provider === "gemini") {
    if (schemaVersion === 3) {
      assertVersionedGeminiOutputAttribution({
        value: projection.gemini_output_attribution,
        observations,
        capture: outputCapture,
      });
      outputAudioLineageScope =
        "client_observed_interval_wire_projection_capture_cas_evaluator_exact_complete_frame_attribution_provider_response_id_unavailable";
    } else {
      assertExactGeminiOutputWire({
        observations,
        capture: outputCapture,
        profile,
      });
      outputAudioLineageScope =
        "capture_cas_evaluator_exact_provider_output_wire_completeness_unverified";
    }
  } else {
    assertExactOpenAiCompatibleOutputWire({
      observations,
      capture: outputCapture,
      profile,
    });
    outputAudioLineageScope =
      "client_observed_identity_scoped_wire_pcm_capture_cas_evaluator_exact";
  }
  assertListenerEvidence({
    projection,
    capture: outputCapture,
    expected,
  });
  return Object.freeze({
    output_capture: materializeOutputCapture(outputCapture),
    output_audio_lineage_scope: outputAudioLineageScope,
  });
}
