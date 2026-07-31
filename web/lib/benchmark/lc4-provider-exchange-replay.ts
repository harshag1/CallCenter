import { canonicalJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  createLc4GeminiOutputAttribution,
  LC4_GEMINI_OUTPUT_ATTRIBUTION_DOMAIN,
  LC4_GEMINI_OUTPUT_CHUNK_SEQUENCE_DOMAIN,
  LC4_SUPPRESSED_OUTPUT_CHUNK_SEQUENCE_DOMAIN,
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
import {
  assertLc4DevGatewayReceiptSet,
  LC4_DEV_GATEWAY_BRIDGE_VERSION,
  LC4_DEV_PRE_DISPATCH_REJECTION_CODES,
} from "./lc4-development-gateway-bridge";
import { LOCAL_TOOL_PROXY_FUNCTION_NAME } from "../realtime/client/types";

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
const SUPPRESSED_UNPLAYED_OUTPUT_DOMAIN_V1 =
  "harshas-amazing-call-center/lc4-suppressed-unplayed-output/v1\n";
const SUPPRESSED_UNPLAYED_OUTPUT_DOMAIN_V2 =
  "harshas-amazing-call-center/lc4-suppressed-unplayed-output/v2\n";
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
// One response may legitimately combine hundreds of 20 ms caller frames with
// provider audio, transcript deltas, and a tool-result continuation. Keep the
// per-exchange set bounded well below the 64 MiB retained-artifact ceiling
// without rejecting those exact long-form wire lineages.
const MAX_RETAINED_WIRE_OBSERVATIONS = 8_192;
const MAX_DEV_GATEWAY_CONVERSATION_BATCHES = 16;
const MAX_DEV_GATEWAY_CONVERSATION_CALLS_PER_BATCH = 16;
const MAX_DEV_GATEWAY_CONVERSATION_ARGUMENT_BYTES = 64 * 1024;
const MAX_DEV_GATEWAY_CONVERSATION_OUTPUT_BYTES = 4_000;

export type Lc4ProviderExchangeReplayExpectation = Readonly<{
  run_id: string;
  opportunity_id: string;
  segment_ordinal: 1 | 2 | 3 | 4 | 5 | 6;
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

function outputChunkSequenceSha256(input: Readonly<{
  domain: string;
  scope: "all_observed_output" | "suppressed_before_listener_admission";
  sample_rate_hz: number;
  chunks: readonly Readonly<{
    pcm_sha256: string;
    byte_length: number;
  }>[];
}>): string {
  return domainHash(input.domain, {
    scope: input.scope,
    format: {
      encoding: "pcm16",
      sample_rate_hz: input.sample_rate_hz,
      channels: 1,
    },
    chunks: input.chunks.map((chunk, index) => ({
      ordinal: index + 1,
      pcm_sha256: chunk.pcm_sha256,
      byte_length: chunk.byte_length,
    })),
  });
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

function encodedPcmCommitmentProjection(input: Readonly<{
  pcm_sha256: string;
  byte_length: number;
  sample_rate_hz: number;
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
    byteLength: input.byte_length,
    sha256: input.pcm_sha256,
    encodedBytes: Math.ceil(input.byte_length / 3) * 4,
    format: Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz: input.sample_rate_hz,
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

function assertSuppressedUnplayedOutput(
  value: unknown,
  capture: ReplayedOutputCapture,
  profile: Lc4ProviderExecutionProfile,
): Readonly<{
  audio_chunks: readonly Readonly<{
    chunk_index: number;
    provider_response_id_sha256: string | null;
    pcm_sha256: string;
    byte_length: number;
  }>[];
  audio_chunk_count: number;
  audio_byte_length: number;
  audio_chunk_sequence_sha256: string;
}> {
  const suppression = record(
    value,
    "LC4 suppressed unplayed output evidence",
  );
  if (suppression.schema_version === 1) {
    assertOnlyKeys(suppression, [
      "schema_version",
      "policy",
      "tool_dispatch_count",
      "response_count",
      "audio_chunk_count",
      "audio_byte_length",
      "audio_pcm_sha256",
      "transcript_count",
      "transcript_hash_set_sha256",
      "caller_heard_audio_chunk_count",
      "caller_heard_audio_byte_length",
      "caller_heard_audio_pcm_sha256",
      "evidence_sha256",
    ], "LC4 legacy suppressed unplayed output evidence");
    const {
      evidence_sha256: claimedEvidence,
      ...body
    } = suppression;
    if (suppression.policy
        !== "exclude_everything_before_the_final_tool_batch_from_caller_heard_history"
      || suppression.tool_dispatch_count !== 0
      || suppression.response_count !== 0
      || suppression.audio_chunk_count !== 0
      || suppression.audio_byte_length !== 0
      || suppression.audio_pcm_sha256 !== null
      || suppression.transcript_count !== 0
      || suppression.transcript_hash_set_sha256 !== null
      || suppression.caller_heard_audio_chunk_count
        !== capture.chunks.length
      || suppression.caller_heard_audio_byte_length
        !== capture.capture.generated_byte_length
      || suppression.caller_heard_audio_pcm_sha256
        !== capture.capture.generated_pcm_sha256
      || claimedEvidence !== domainHash(
        SUPPRESSED_UNPLAYED_OUTPUT_DOMAIN_V1,
        body,
      )) {
      throw new Error(
        "LC4 legacy suppression is replayable only when it makes no suppressed-output claim",
      );
    }
    return Object.freeze({
      audio_chunks: Object.freeze([]),
      audio_chunk_count: 0,
      audio_byte_length: 0,
      audio_chunk_sequence_sha256: outputChunkSequenceSha256({
        domain: LC4_SUPPRESSED_OUTPUT_CHUNK_SEQUENCE_DOMAIN,
        scope: "suppressed_before_listener_admission",
        sample_rate_hz: profile.output_sample_rate_hz,
        chunks: [],
      }),
    });
  }
  assertOnlyKeys(suppression, [
    "schema_version",
    "policy",
    "audio_chunks",
    "audio_chunk_count",
    "audio_byte_length",
    "audio_chunk_sequence_sha256",
    "listener_admitted_audio_chunk_count",
    "listener_admitted_audio_byte_length",
    "listener_admitted_audio_pcm_sha256",
    "evidence_sha256",
  ], "LC4 suppressed unplayed output evidence");
  if (!Array.isArray(suppression.audio_chunks)
    || suppression.audio_chunks.length > MAX_RETAINED_WIRE_OBSERVATIONS) {
    throw new Error(
      "LC4 suppressed output chunk commitments are invalid or exceed their bound",
    );
  }
  const audioChunks = suppression.audio_chunks.map((candidate, index) => {
    const chunk = record(
      candidate,
      `LC4 suppressed output chunk ${index + 1}`,
    );
    assertOnlyKeys(chunk, [
      "chunk_index",
      "provider_response_id_sha256",
      "pcm_sha256",
      "byte_length",
    ], `LC4 suppressed output chunk ${index + 1}`);
    const responseIdSha256 = nullableHash(
      chunk.provider_response_id_sha256,
      `LC4 suppressed output chunk ${index + 1} provider response`,
    );
    const pcmSha256 = hash(
      chunk.pcm_sha256,
      `LC4 suppressed output chunk ${index + 1} PCM`,
    );
    const byteLength = integer(
      chunk.byte_length,
      `LC4 suppressed output chunk ${index + 1} bytes`,
      2,
    );
    if (chunk.chunk_index !== index + 1
      || byteLength % 2 !== 0
      || (profile.provider === "gemini") !== (responseIdSha256 === null)) {
      throw new Error(
        "LC4 suppressed output chunk order, format, or provider identity is invalid",
      );
    }
    return Object.freeze({
      chunk_index: index + 1,
      provider_response_id_sha256: responseIdSha256,
      pcm_sha256: pcmSha256,
      byte_length: byteLength,
    });
  });
  const audioChunkCount = integer(
    suppression.audio_chunk_count,
    "LC4 suppressed output audio chunk count",
  );
  const audioByteLength = integer(
    suppression.audio_byte_length,
    "LC4 suppressed output audio bytes",
  );
  const listenerAdmittedChunkCount = integer(
    suppression.listener_admitted_audio_chunk_count,
    "LC4 listener-admitted output chunk count",
    1,
  );
  const listenerAdmittedByteLength = integer(
    suppression.listener_admitted_audio_byte_length,
    "LC4 listener-admitted output bytes",
    2,
  );
  const audioChunkSequenceSha256 = hash(
    suppression.audio_chunk_sequence_sha256,
    "LC4 suppressed output chunk sequence",
  );
  const {
    evidence_sha256: claimedEvidence,
    ...body
  } = suppression;
  if (suppression.schema_version !== 2
    || suppression.policy
      !== "exclude_everything_before_the_final_tool_batch_from_listener_evaluation_and_reconnect_history"
    || audioChunkCount !== audioChunks.length
    || audioByteLength !== audioChunks.reduce(
      (total, chunk) => total + chunk.byte_length,
      0,
    )
    || audioChunkSequenceSha256 !== outputChunkSequenceSha256({
      domain: LC4_SUPPRESSED_OUTPUT_CHUNK_SEQUENCE_DOMAIN,
      scope: "suppressed_before_listener_admission",
      sample_rate_hz: profile.output_sample_rate_hz,
      chunks: audioChunks,
    })
    || listenerAdmittedChunkCount !== capture.chunks.length
    || listenerAdmittedByteLength !== capture.capture.generated_byte_length
    || suppression.listener_admitted_audio_pcm_sha256
      !== capture.capture.generated_pcm_sha256
    || claimedEvidence !== domainHash(
      SUPPRESSED_UNPLAYED_OUTPUT_DOMAIN_V2,
      body,
    )) {
    throw new Error(
      "LC4 suppressed output evidence differs from its policy, ordered commitment, or exact listener-admitted capture",
    );
  }
  return Object.freeze({
    audio_chunks: Object.freeze(audioChunks),
    audio_chunk_count: audioChunkCount,
    audio_byte_length: audioByteLength,
    audio_chunk_sequence_sha256: audioChunkSequenceSha256,
  });
}

function assertExactOpenAiCompatibleOutputWire(input: Readonly<{
  observations: readonly Lc4SanitizedWireObservation[];
  capture: ReplayedOutputCapture;
  profile: Lc4ProviderExecutionProfile;
  suppression: Readonly<{
    audio_chunks: readonly Readonly<{
      chunk_index: number;
      provider_response_id_sha256: string | null;
      pcm_sha256: string;
      byte_length: number;
    }>[];
  }>;
}>): void {
  const audio = input.observations.filter((observation) =>
    observation.direction === "inbound"
    && (observation.wire_type === "response.audio.delta"
      || observation.wire_type === "response.output_audio.delta"));
  if (audio.length < 1) {
    throw new Error("LC4 provider output has no inbound PCM wire evidence");
  }
  if (audio.length !== input.suppression.audio_chunks.length
      + input.capture.pcmChunks.length) {
    throw new Error(
      "LC4 provider output wire does not exactly partition into suppressed and listener-admitted chunks",
    );
  }
  for (const [index, commitment] of input.suppression.audio_chunks.entries()) {
    const observation = audio[index]!;
    if (commitment.provider_response_id_sha256 === null
      || observation.identity_hashes.responseIdSha256
        !== commitment.provider_response_id_sha256
      || observation.projection_sha256 !== realtimeWireProjectionSha256({
        audio: encodedPcmCommitmentProjection({
          pcm_sha256: commitment.pcm_sha256,
          byte_length: commitment.byte_length,
          sample_rate_hz: input.profile.output_sample_rate_hz,
        }),
      })) {
      throw new Error(
        "LC4 suppressed output chunk commitment differs from its exact ordered inbound wire projection",
      );
    }
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
  if (canonicalJson(outputAudio)
    !== canonicalJson(audio.slice(input.suppression.audio_chunks.length))) {
    throw new Error(
      "LC4 listener-admitted output is not the exact terminal wire-audio suffix",
    );
  }
  const toolCalls = wires(
    input.observations,
    "inbound",
    "response.function_call_arguments.done",
  );
  const toolResults = wires(
    input.observations,
    "outbound",
    "conversation.item.create",
  );
  const listenerAdmissionStart = outputAudio[0]!;
  if ((input.suppression.audio_chunks.length > 0
      && (toolCalls.length < 1 || toolResults.length < 1))
    || toolCalls.some((observation) =>
      observation.sequence >= listenerAdmissionStart.sequence)
    || toolResults.some((observation) =>
      observation.sequence >= listenerAdmissionStart.sequence)) {
    throw new Error(
      "LC4 listener-admitted output does not begin after the final observed tool batch",
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

function assertGeminiServerContentProjectionShape(
  value: unknown,
  label: string,
): JsonRecord {
  const projection = record(value, label);
  const allowedKeys = new Set(["audio", "terminal", "text", "usage"]);
  if (Object.keys(projection).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} has an unsupported field`);
  }
  if (projection.text !== undefined) {
    if (!Array.isArray(projection.text)
      || projection.text.length < 1
      || projection.text.length > 128) {
      throw new Error(`${label} text evidence is invalid`);
    }
    const kinds = new Set([
      "input_transcript",
      "output_transcript",
      "model_text",
    ]);
    for (const [index, candidate] of projection.text.entries()) {
      const textEvidence = record(
        candidate,
        `${label} text evidence ${index + 1}`,
      );
      assertOnlyKeys(textEvidence, [
        "kind",
        "sha256",
        "byteLength",
      ], `${label} text evidence ${index + 1}`);
      if (!kinds.has(String(textEvidence.kind))
        || !SHA256.test(String(textEvidence.sha256))
        || !Number.isSafeInteger(textEvidence.byteLength)
        || (textEvidence.byteLength as number) < 0
        || (textEvidence.byteLength as number) > 1_000_000) {
        throw new Error(`${label} text evidence is invalid`);
      }
    }
  }
  if (projection.usage !== undefined) {
    const usage = record(projection.usage, `${label} usage evidence`);
    const allowedUsageKeys = new Set([
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
    ]);
    if (Object.keys(usage).length < 1
      || Object.keys(usage).some((key) => !allowedUsageKeys.has(key))
      || Object.values(usage).some((entry) =>
        !Number.isSafeInteger(entry)
        || (entry as number) < 0
        || (entry as number) > 1_000_000_000_000)) {
      throw new Error(`${label} usage evidence is invalid`);
    }
  }
  if (projection.audio !== undefined) {
    const audio = record(projection.audio, `${label} audio evidence`);
    assertOnlyKeys(audio, ["direction", "chunks"], `${label} audio evidence`);
    if (audio.direction !== "output"
      || !Array.isArray(audio.chunks)
      || audio.chunks.length < 1) {
      throw new Error(`${label} audio evidence is invalid`);
    }
    for (const [index, candidate] of audio.chunks.entries()) {
      const chunk = record(candidate, `${label} audio chunk ${index + 1}`);
      assertOnlyKeys(chunk, [
        "validCanonicalBase64",
        "byteLength",
        "sha256",
        "encodedBytes",
        "format",
        "mimeTypeRecognized",
      ], `${label} audio chunk ${index + 1}`);
      const format = record(
        chunk.format,
        `${label} audio chunk ${index + 1} format`,
      );
      assertOnlyKeys(format, [
        "encoding",
        "sampleRateHz",
        "channels",
      ], `${label} audio chunk ${index + 1} format`);
    }
  }
  if (projection.terminal !== undefined) {
    const terminal = record(projection.terminal, `${label} terminal`);
    assertOnlyKeys(terminal, ["status"], `${label} terminal`);
  }
  return projection;
}

function assertVersionedGeminiOutputAttribution(input: Readonly<{
  value: JsonValue;
  observations: readonly Lc4SanitizedWireObservation[];
  capture: ReplayedOutputCapture;
  suppression: Readonly<{
    audio_chunks: readonly Readonly<{
      chunk_index: number;
      provider_response_id_sha256: string | null;
      pcm_sha256: string;
      byte_length: number;
    }>[];
    audio_chunk_count: number;
    audio_byte_length: number;
    audio_chunk_sequence_sha256: string;
  }>;
}>): void {
  const attribution = record(
    input.value,
    "LC4 Gemini versioned output attribution",
  );
  assertOnlyKeys(attribution, [
    "schema_version",
    "contract",
    "completeness",
    "observation_scope",
    "activity_end",
    "terminal",
    "interval_observation_sha256s",
    "interval_frames",
    "server_content_frames",
    "output_audio_chunk_count",
    "output_audio_byte_length",
    "output_audio_chunk_sequence_sha256",
    "attribution_sha256",
  ], "LC4 Gemini versioned output attribution");
  if (attribution.schema_version !== 2) {
    throw new Error(
      "LC4 Gemini output attribution must use the independently replayable v2 contract",
    );
  }
  if (!Array.isArray(attribution.interval_frames)) {
    throw new Error("LC4 Gemini versioned output attribution interval frames must be an array");
  }
  const wireProjections = attribution.interval_frames.map(
    (candidate, index) => {
      const frame = record(
        candidate,
        `LC4 Gemini versioned output attribution interval frame ${index + 1}`,
      );
      assertOnlyKeys(frame, [
        "interval_index",
        "direction",
        "wire_type",
        "wire_observation",
        "redacted_projection",
      ], `LC4 Gemini versioned output attribution interval frame ${index + 1}`);
      const wireObservation = record(
        frame.wire_observation,
        `LC4 Gemini versioned output attribution interval frame ${index + 1} wire observation`,
      );
      assertOnlyKeys(wireObservation, [
        "connection_epoch",
        "sequence",
        "observation_sha256",
        "payload_sha256",
        "payload_byte_length",
        "projection_sha256",
      ], `LC4 Gemini versioned output attribution interval frame ${index + 1} wire observation`);
      return Object.freeze({
        wire_observation_sha256: hash(
          wireObservation.observation_sha256,
          `LC4 Gemini versioned output attribution interval frame ${index + 1} observation`,
        ),
        redacted_projection: frame.redacted_projection,
      });
    },
  );
  if (input.suppression.audio_chunk_count === 0) {
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
    return;
  }

  const activityEnd = exactlyOneWire(
    input.observations,
    "outbound",
    "realtimeInput.activityEnd",
    "Gemini versioned output attribution",
  );
  const intervalObservations = input.observations.filter((observation) =>
    observation.connection_epoch === activityEnd.connection_epoch
    && observation.sequence > activityEnd.sequence);
  if (intervalObservations.length !== wireProjections.length) {
    throw new Error(
      "LC4 Gemini versioned output attribution omits or adds an interval frame",
    );
  }
  const wirePointer = (observation: Lc4SanitizedWireObservation) =>
    Object.freeze({
      connection_epoch: observation.connection_epoch,
      sequence: observation.sequence,
      observation_sha256: observation.observation_sha256,
      payload_sha256: observation.payload_sha256,
      payload_byte_length: observation.payload_bytes,
      projection_sha256: observation.projection_sha256,
    });
  const intervalFrames = attribution.interval_frames;
  if (!Array.isArray(intervalFrames)
    || intervalFrames.length !== intervalObservations.length) {
    throw new Error(
      "LC4 Gemini versioned output attribution interval frame count is invalid",
    );
  }
  for (const [index, candidate] of intervalFrames.entries()) {
    const frame = record(
      candidate,
      `LC4 Gemini versioned output attribution interval frame ${index + 1}`,
    );
    assertOnlyKeys(frame, [
      "interval_index",
      "direction",
      "wire_type",
      "wire_observation",
      "redacted_projection",
    ], `LC4 Gemini versioned output attribution interval frame ${index + 1}`);
    assertOnlyKeys(
      record(
        frame.wire_observation,
        `LC4 Gemini interval frame ${index + 1} wire observation`,
      ),
      [
        "connection_epoch",
        "sequence",
        "observation_sha256",
        "payload_sha256",
        "payload_byte_length",
        "projection_sha256",
      ],
      `LC4 Gemini interval frame ${index + 1} wire observation`,
    );
    const observation = intervalObservations[index]!;
    if (frame.interval_index !== index + 1
      || frame.direction !== observation.direction
      || frame.wire_type !== observation.wire_type
      || canonicalJson(frame.wire_observation)
        !== canonicalJson(wirePointer(observation))
      || realtimeWireProjectionSha256(record(
        frame.redacted_projection,
        `LC4 Gemini interval frame ${index + 1} projection`,
      )) !== observation.projection_sha256
      || observation.wire_type === "mixedServerMessage") {
      throw new Error(
        "LC4 Gemini versioned output attribution interval differs from exact wire evidence",
      );
    }
    const projection = record(
      frame.redacted_projection,
      `LC4 Gemini interval frame ${index + 1} projection`,
    );
    if (observation.wire_type === "serverContent") {
      assertGeminiServerContentProjectionShape(
        projection,
        `LC4 Gemini interval frame ${index + 1} serverContent projection`,
      );
    }
    if (observation.wire_type !== "serverContent"
      && (projection.audio !== undefined || projection.terminal !== undefined)) {
      throw new Error(
        "LC4 Gemini versioned output or terminal escaped a serverContent frame",
      );
    }
  }

  const serverObservations = intervalObservations.filter((observation) =>
    observation.direction === "inbound"
    && observation.wire_type === "serverContent");
  if (!Array.isArray(attribution.server_content_frames)
    || attribution.server_content_frames.length !== serverObservations.length) {
    throw new Error(
      "LC4 Gemini versioned output attribution serverContent frame count is invalid",
    );
  }
  const attributedChunks: Array<Readonly<{
    pcm_sha256: string;
    byte_length: number;
    interval_sequence: number;
  }>> = [];
  let terminalObservation: Lc4SanitizedWireObservation | null = null;
  for (const [serverIndex, candidate] of attribution.server_content_frames.entries()) {
    const frame = record(
      candidate,
      `LC4 Gemini versioned serverContent frame ${serverIndex + 1}`,
    );
    assertOnlyKeys(frame, [
      "server_content_index",
      "interval_index",
      "wire_observation",
      "redacted_projection",
      "output_audio_chunks",
      "terminal_status",
    ], `LC4 Gemini versioned serverContent frame ${serverIndex + 1}`);
    assertOnlyKeys(
      record(
        frame.wire_observation,
        `LC4 Gemini versioned serverContent frame ${serverIndex + 1} wire observation`,
      ),
      [
        "connection_epoch",
        "sequence",
        "observation_sha256",
        "payload_sha256",
        "payload_byte_length",
        "projection_sha256",
      ],
      `LC4 Gemini versioned serverContent frame ${serverIndex + 1} wire observation`,
    );
    const observation = serverObservations[serverIndex]!;
    const intervalIndex = intervalObservations.findIndex(
      (entry) => entry.observation_sha256 === observation.observation_sha256,
    ) + 1;
    const projection = record(
      frame.redacted_projection,
      `LC4 Gemini versioned serverContent frame ${serverIndex + 1} projection`,
    );
    if (frame.server_content_index !== serverIndex + 1
      || frame.interval_index !== intervalIndex
      || canonicalJson(frame.wire_observation)
        !== canonicalJson(wirePointer(observation))
      || canonicalJson(projection)
        !== canonicalJson(record(
          intervalFrames[intervalIndex - 1]!.redacted_projection,
          `LC4 Gemini interval frame ${intervalIndex} projection`,
        ))) {
      throw new Error(
        "LC4 Gemini versioned serverContent attribution differs from its interval frame",
      );
    }
    const projectedAudio = projection.audio === undefined
      ? null
      : record(
          projection.audio,
          `LC4 Gemini versioned serverContent frame ${serverIndex + 1} audio`,
        );
    const projectedChunks = projectedAudio === null
      ? []
      : projectedAudio.chunks;
    if (projectedAudio !== null
      && (projectedAudio.direction !== "output"
        || !Array.isArray(projectedChunks))) {
      throw new Error(
        "LC4 Gemini versioned serverContent audio projection is invalid",
      );
    }
    if (!Array.isArray(frame.output_audio_chunks)
      || frame.output_audio_chunks.length
        !== (Array.isArray(projectedChunks) ? projectedChunks.length : 0)) {
      throw new Error(
        "LC4 Gemini versioned output chunk count differs from its frame projection",
      );
    }
    for (const [frameChunkIndex, outputCandidate] of frame.output_audio_chunks.entries()) {
      const output = record(
        outputCandidate,
        `LC4 Gemini versioned output chunk ${attributedChunks.length + 1}`,
      );
      assertOnlyKeys(output, [
        "output_chunk_index",
        "frame_chunk_index",
        "pcm_sha256",
        "byte_length",
        "mime_type",
        "format",
      ], `LC4 Gemini versioned output chunk ${attributedChunks.length + 1}`);
      const projected = record(
        (projectedChunks as JsonValue[])[frameChunkIndex],
        `LC4 Gemini versioned projected output chunk ${attributedChunks.length + 1}`,
      );
      assertOnlyKeys(projected, [
        "validCanonicalBase64",
        "byteLength",
        "sha256",
        "encodedBytes",
        "format",
        "mimeTypeRecognized",
      ], `LC4 Gemini versioned projected output chunk ${attributedChunks.length + 1}`);
      const projectedFormat = record(
        projected.format,
        `LC4 Gemini versioned projected output chunk ${attributedChunks.length + 1} format`,
      );
      assertOnlyKeys(projectedFormat, [
        "encoding",
        "sampleRateHz",
        "channels",
      ], `LC4 Gemini versioned projected output chunk ${attributedChunks.length + 1} format`);
      const outputFormat = record(
        output.format,
        `LC4 Gemini versioned output chunk ${attributedChunks.length + 1} format`,
      );
      assertOnlyKeys(outputFormat, [
        "encoding",
        "sample_rate_hz",
        "channels",
      ], `LC4 Gemini versioned output chunk ${attributedChunks.length + 1} format`);
      const byteLength = integer(
        projected.byteLength,
        `LC4 Gemini versioned output chunk ${attributedChunks.length + 1} bytes`,
        2,
      );
      const pcmSha256 = hash(
        projected.sha256,
        `LC4 Gemini versioned output chunk ${attributedChunks.length + 1} PCM`,
      );
      if (projected.validCanonicalBase64 !== true
        || projected.mimeTypeRecognized !== true
        || projected.encodedBytes !== Math.ceil(byteLength / 3) * 4
        || projectedFormat.encoding !== "pcm16"
        || projectedFormat.sampleRateHz !== 24_000
        || projectedFormat.channels !== 1
        || output.output_chunk_index !== attributedChunks.length + 1
        || output.frame_chunk_index !== frameChunkIndex + 1
        || output.pcm_sha256 !== pcmSha256
        || output.byte_length !== byteLength
        || output.mime_type !== "audio/pcm;rate=24000"
        || outputFormat.encoding !== "pcm16"
        || outputFormat.sample_rate_hz !== 24_000
        || outputFormat.channels !== 1) {
        throw new Error(
          "LC4 Gemini versioned output chunk differs from its exact redacted wire projection",
        );
      }
      attributedChunks.push(Object.freeze({
        pcm_sha256: pcmSha256,
        byte_length: byteLength,
        interval_sequence: observation.sequence,
      }));
    }
    const terminal = projection.terminal === undefined
      ? null
      : record(
          projection.terminal,
          `LC4 Gemini versioned serverContent frame ${serverIndex + 1} terminal`,
        );
    const terminalStatus = terminal?.status ?? null;
    if (terminalStatus !== null
      && terminalStatus !== "completed"
      && terminalStatus !== "failed"
      && terminalStatus !== "interrupted") {
      throw new Error("LC4 Gemini versioned terminal status is invalid");
    }
    if (frame.terminal_status !== terminalStatus) {
      throw new Error(
        "LC4 Gemini versioned terminal attribution differs from its projection",
      );
    }
    if (terminalStatus !== null) {
      if (terminalObservation !== null || terminalStatus !== "completed") {
        throw new Error(
          "LC4 Gemini versioned attribution requires one completed terminal",
        );
      }
      terminalObservation = observation;
    }
  }
  if (terminalObservation === null
    || intervalObservations.at(-1)!.observation_sha256
      !== terminalObservation.observation_sha256) {
    throw new Error(
      "LC4 Gemini versioned attribution interval is not terminal-complete",
    );
  }

  const suppressedChunks = attributedChunks.slice(
    0,
    input.suppression.audio_chunk_count,
  );
  const callerHeardChunks = attributedChunks.slice(
    input.suppression.audio_chunk_count,
  );
  const toolCalls = wires(input.observations, "inbound", "toolCall");
  const toolResults = wires(input.observations, "outbound", "toolResponse");
  const listenerAdmissionSequence = callerHeardChunks[0]?.interval_sequence;
  if (suppressedChunks.length !== input.suppression.audio_chunk_count
    || canonicalJson(suppressedChunks.map((chunk, index) => ({
      chunk_index: index + 1,
      provider_response_id_sha256: null,
      pcm_sha256: chunk.pcm_sha256,
      byte_length: chunk.byte_length,
    }))) !== canonicalJson(input.suppression.audio_chunks)
    || suppressedChunks.reduce(
      (total, chunk) => total + chunk.byte_length,
      0,
    ) !== input.suppression.audio_byte_length
    || input.suppression.audio_chunk_sequence_sha256
      !== outputChunkSequenceSha256({
        domain: LC4_SUPPRESSED_OUTPUT_CHUNK_SEQUENCE_DOMAIN,
        scope: "suppressed_before_listener_admission",
        sample_rate_hz: 24_000,
        chunks: suppressedChunks,
      })
    || callerHeardChunks.length !== input.capture.chunks.length
    || callerHeardChunks.some((chunk, index) =>
      chunk.pcm_sha256 !== input.capture.chunks[index]!.pcm_sha256
      || chunk.byte_length !== input.capture.chunks[index]!.byte_length)
    || listenerAdmissionSequence === undefined
    || (input.suppression.audio_chunk_count > 0
      && (toolCalls.length < 1 || toolResults.length < 1))
    || toolCalls.some((observation) =>
      observation.sequence >= listenerAdmissionSequence)
    || toolResults.some((observation) =>
      observation.sequence >= listenerAdmissionSequence)
    || attributedChunks.length !== attribution.output_audio_chunk_count
    || attributedChunks.reduce(
      (total, chunk) => total + chunk.byte_length,
      0,
    ) !== attribution.output_audio_byte_length
    || attribution.output_audio_chunk_sequence_sha256
      !== outputChunkSequenceSha256({
        domain: LC4_GEMINI_OUTPUT_CHUNK_SEQUENCE_DOMAIN,
        scope: "all_observed_output",
        sample_rate_hz: 24_000,
        chunks: attributedChunks,
      })) {
    throw new Error(
      "LC4 Gemini versioned attribution does not partition into exact suppressed and listener-admitted output",
    );
  }
  const expectedActivityEnd = {
    connection_epoch: activityEnd.connection_epoch,
    sequence: activityEnd.sequence,
    observation_sha256: activityEnd.observation_sha256,
  };
  const expectedTerminal = {
    connection_epoch: terminalObservation.connection_epoch,
    sequence: terminalObservation.sequence,
    observation_sha256: terminalObservation.observation_sha256,
    status: "completed",
  };
  const {
    attribution_sha256: claimedAttribution,
    ...attributionBody
  } = attribution;
  const activityEndProjection = record(
    attribution.activity_end,
    "LC4 Gemini versioned activityEnd pointer",
  );
  assertOnlyKeys(activityEndProjection, [
    "connection_epoch",
    "sequence",
    "observation_sha256",
  ], "LC4 Gemini versioned activityEnd pointer");
  const terminalProjection = record(
    attribution.terminal,
    "LC4 Gemini versioned terminal pointer",
  );
  assertOnlyKeys(terminalProjection, [
    "connection_epoch",
    "sequence",
    "observation_sha256",
    "status",
  ], "LC4 Gemini versioned terminal pointer");
  if (attribution.contract
      !== "gemini_server_content_output_audio_attribution"
    || attribution.completeness !== "verified_activity_end_to_terminal"
    || attribution.observation_scope !== "client_observed_wire_frames"
    || canonicalJson(attribution.activity_end)
      !== canonicalJson(expectedActivityEnd)
    || canonicalJson(attribution.terminal) !== canonicalJson(expectedTerminal)
    || canonicalJson(attribution.interval_observation_sha256s)
      !== canonicalJson(intervalObservations.map(
        (observation) => observation.observation_sha256,
      ))
    || claimedAttribution !== sha256Hex(
      `${LC4_GEMINI_OUTPUT_ATTRIBUTION_DOMAIN}${canonicalJson(attributionBody)}`,
    )) {
    throw new Error(
      "LC4 Gemini versioned output attribution header or aggregate hash is invalid",
    );
  }
}

function assertListenerEvidence(input: Readonly<{
  projection: JsonRecord;
  capture: ReplayedOutputCapture;
  expected: Lc4ProviderExchangeReplayExpectation;
}>): void {
  const isHaccResponsePlan =
    input.expected.response_control_kind === "hacc_response_plan";
  if (isHaccResponsePlan) {
    hash(
      input.projection.response_plan_sha256,
      "LC4 initial HACC response plan",
    );
  }
  const expectedListenerResponsePlanSha256 = isHaccResponsePlan
    ? hash(
        input.projection.terminal_response_plan_sha256,
        "LC4 terminal HACC response plan",
      )
    : null;
  if (input.expected.response_control_kind === "native_context"
    && input.projection.response_plan_sha256 !== null) {
    throw new Error(
      "LC4 Native exchange cannot carry a HACC response-plan commitment",
    );
  }
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
      !== expectedListenerResponsePlanSha256
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

export function assertLc4DevGatewayConversationToolBatches(
  value: unknown,
  receiptSetValue: unknown,
  expected: Readonly<{
    episode_id: string;
    opportunity_id: string;
    provider: "openai" | "gemini" | "xai";
    arm: "native" | "hacc";
    phase: "canonical" | "repair";
  }>,
): void {
  if (!Array.isArray(value)
    || value.length > MAX_DEV_GATEWAY_CONVERSATION_BATCHES) {
    throw new Error(
      "LC4 DEV gateway conversation replay batch set is invalid or exceeds its bound",
    );
  }
  assertLc4DevGatewayReceiptSet(receiptSetValue);
  const receiptSet = record(
    receiptSetValue,
    "LC4 DEV gateway receipt set",
  );
  const authorityValues = receiptSet.authority_projections;
  const rejectionValues = receiptSet.pre_dispatch_rejections;
  const receiptValues = receiptSet.receipts;
  if (!Array.isArray(authorityValues)
    || !Array.isArray(rejectionValues)
    || !Array.isArray(receiptValues)) {
    throw new Error("LC4 DEV gateway receipt set omits replay sources");
  }
  const authorities = new Map<string, JsonRecord>();
  for (const candidate of authorityValues) {
    const authority = record(
      candidate,
      "LC4 DEV gateway authority projection",
    );
    if (authority.episode_id !== expected.episode_id
      || authority.opportunity_id !== expected.opportunity_id
      || authority.provider !== expected.provider
      || authority.arm !== expected.arm
      || expected.phase !== "canonical") {
      throw new Error(
        "LC4 DEV gateway authority projection differs from its outer exchange",
      );
    }
    authorities.set(
      hash(
        authority.projection_sha256,
        "LC4 DEV gateway authority projection hash",
      ),
      authority,
    );
  }
  const authorityReceipts = new Map<string, JsonRecord>();
  for (const candidate of receiptValues) {
    const receipt = record(candidate, "LC4 DEV gateway dispatch receipt");
    if (receipt.episode_id !== expected.episode_id
      || receipt.opportunity_id !== expected.opportunity_id
      || receipt.provider !== expected.provider
      || receipt.arm !== expected.arm
      || expected.phase !== "canonical") {
      throw new Error(
        "LC4 DEV gateway dispatch receipt differs from its outer exchange",
      );
    }
    authorityReceipts.set(
      hash(
        receipt.authority_projection_sha256,
        "LC4 DEV gateway dispatch authority projection",
      ),
      receipt,
    );
  }
  const rejections = new Map<string, JsonRecord>();
  for (const candidate of rejectionValues) {
    const rejection = record(
      candidate,
      "LC4 DEV gateway pre-dispatch rejection",
    );
    if (rejection.episode_id !== expected.episode_id
      || rejection.opportunity_id !== expected.opportunity_id
      || rejection.provider !== expected.provider
      || rejection.arm !== expected.arm
      || rejection.phase !== expected.phase
      || (expected.phase === "repair"
        && rejection.rejection_code
          !== "tool_calls_forbidden_during_repair")) {
      throw new Error(
        "LC4 DEV gateway rejection differs from its outer exchange",
      );
    }
    rejections.set(
      hash(
        rejection.rejection_receipt_sha256,
        "LC4 DEV gateway rejection receipt",
      ),
      rejection,
    );
  }
  const seenSources = new Set<string>();
  const observedSourceOrder: string[] = [];
  for (const [batchIndex, candidate] of value.entries()) {
    const batch = record(
      candidate,
      "LC4 DEV gateway conversation replay batch",
    );
    assertOnlyKeys(batch, [
      "schema_version",
      "bridge_version",
      "batch_ordinal",
      "provider_response_id_sha256",
      "calls",
    ], "LC4 DEV gateway conversation replay batch");
    if (batch.schema_version !== 2
      || batch.bridge_version !== LC4_DEV_GATEWAY_BRIDGE_VERSION
      || integer(
        batch.batch_ordinal,
        "LC4 DEV gateway conversation replay batch ordinal",
        1,
      ) !== batchIndex + 1
      || !Array.isArray(batch.calls)
      || batch.calls.length < 1
      || batch.calls.length > MAX_DEV_GATEWAY_CONVERSATION_CALLS_PER_BATCH) {
      throw new Error("LC4 DEV gateway conversation replay batch is invalid");
    }
    const providerResponseSha256 = hash(
      batch.provider_response_id_sha256,
      "LC4 DEV gateway conversation replay provider response",
    );
    for (const [callIndex, callValue] of batch.calls.entries()) {
      const call = record(
        callValue,
        "LC4 DEV gateway conversation replay call",
      );
      assertOnlyKeys(call, [
        "call_ordinal",
        "gateway_tool_name",
        "model_arguments",
        "provider_output_canonical_json",
        "source_kind",
        "source_sha256",
        "disposition",
        "pre_dispatch_rejection_code",
      ], "LC4 DEV gateway conversation replay call");
      if (integer(
        call.call_ordinal,
        "LC4 DEV gateway conversation replay call ordinal",
        1,
      ) !== callIndex + 1
        || call.gateway_tool_name !== LOCAL_TOOL_PROXY_FUNCTION_NAME) {
        throw new Error("LC4 DEV gateway conversation replay call order or name is invalid");
      }
      const modelArguments = record(
        call.model_arguments,
        "LC4 DEV gateway conversation replay model arguments",
      );
      if (Buffer.byteLength(canonicalJson(modelArguments), "utf8")
        > MAX_DEV_GATEWAY_CONVERSATION_ARGUMENT_BYTES) {
        throw new Error("LC4 DEV gateway conversation replay model arguments exceed their bound");
      }
      const output = string(
        call.provider_output_canonical_json,
        "LC4 DEV gateway conversation replay delivered output",
      );
      if (!output
        || Buffer.byteLength(output, "utf8")
          > MAX_DEV_GATEWAY_CONVERSATION_OUTPUT_BYTES) {
        throw new Error("LC4 DEV gateway conversation replay delivered output exceeds its bound");
      }
      let parsedOutput: JsonValue;
      try {
        parsedOutput = JSON.parse(output) as JsonValue;
      } catch {
        throw new Error("LC4 DEV gateway conversation replay delivered output is not JSON");
      }
      if (canonicalJson(parsedOutput) !== output) {
        throw new Error("LC4 DEV gateway conversation replay delivered output is not canonical JSON");
      }
      const sourceSha256 = hash(
        call.source_sha256,
        "LC4 DEV gateway conversation replay source",
      );
      if (seenSources.has(sourceSha256)) {
        throw new Error("LC4 DEV gateway conversation replay source is duplicated");
      }
      seenSources.add(sourceSha256);
      observedSourceOrder.push(sourceSha256);
      if (call.source_kind === "authority_projection") {
        const authority = authorities.get(sourceSha256);
        const receipt = authorityReceipts.get(sourceSha256);
        const expectedModelArguments = authority
          ? {
              tool_name: authority.semantic_intent,
              arguments: authority.model_arguments,
            }
          : null;
        if (!authority
          || !receipt
          || authority.provider_response_id_sha256 !== providerResponseSha256
          || receipt.batch_ordinal !== batch.batch_ordinal
          || receipt.call_ordinal !== call.call_ordinal
          || receipt.provider_response_id_sha256 !== providerResponseSha256
          || canonicalJson(modelArguments) !== canonicalJson(expectedModelArguments)
          || canonicalJson(authority.provider_output) !== output
          || authority.disposition !== call.disposition
          || call.pre_dispatch_rejection_code !== null) {
          throw new Error(
            "LC4 DEV gateway conversation replay authority call differs from its retained source",
          );
        }
      } else if (call.source_kind === "pre_dispatch_rejection") {
        const rejection = rejections.get(sourceSha256);
        if (!rejection
          || rejection.provider_response_id_sha256 !== providerResponseSha256
          || rejection.batch_ordinal !== batch.batch_ordinal
          || rejection.call_ordinal !== call.call_ordinal
          || rejection.model_arguments_sha256
            !== sha256Hex(canonicalJson(modelArguments))
          || rejection.provider_output_sha256 !== sha256Hex(output)
          || call.disposition !== "pre_dispatch_rejected"
          || !LC4_DEV_PRE_DISPATCH_REJECTION_CODES.includes(
            call.pre_dispatch_rejection_code as (
              typeof LC4_DEV_PRE_DISPATCH_REJECTION_CODES[number]
            ),
          )
          || rejection.rejection_code
            !== call.pre_dispatch_rejection_code) {
          throw new Error(
            "LC4 DEV gateway conversation replay rejected call differs from its retained source",
          );
        }
      } else {
        throw new Error("LC4 DEV gateway conversation replay source kind is invalid");
      }
    }
  }
  const expectedSources = new Set([
    ...authorities.keys(),
    ...rejections.keys(),
  ]);
  if (seenSources.size !== expectedSources.size
    || [...seenSources].some((source) => !expectedSources.has(source))) {
    throw new Error(
      "LC4 DEV gateway conversation replay does not exactly cover its retained sources",
    );
  }
  const expectedSourceOrder = [
    ...receiptValues.map((candidate) => {
      const receipt = record(candidate, "LC4 DEV gateway dispatch receipt");
      return {
        batch: integer(receipt.batch_ordinal, "LC4 DEV receipt batch ordinal", 1),
        call: integer(receipt.call_ordinal, "LC4 DEV receipt call ordinal", 1),
        sha256: hash(
          receipt.authority_projection_sha256,
          "LC4 DEV receipt authority projection",
        ),
      };
    }),
    ...rejectionValues.map((candidate) => {
      const rejection = record(candidate, "LC4 DEV gateway rejection receipt");
      return {
        batch: integer(rejection.batch_ordinal, "LC4 DEV rejection batch ordinal", 1),
        call: integer(rejection.call_ordinal, "LC4 DEV rejection call ordinal", 1),
        sha256: hash(
          rejection.rejection_receipt_sha256,
          "LC4 DEV rejection receipt hash",
        ),
      };
    }),
  ].sort((left, right) => left.batch - right.batch || left.call - right.call)
    .map(({ sha256 }) => sha256);
  if (canonicalJson(observedSourceOrder) !== canonicalJson(expectedSourceOrder)) {
    throw new Error(
      "LC4 DEV gateway conversation replay source order differs from its receipts",
    );
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
  if ((schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4
      && schemaVersion !== 5)
    || (schemaVersion === 2 && hasGeminiOutputAttribution)
    || ((schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5)
      && !hasGeminiOutputAttribution)
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
  if (schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5) {
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
  const suppression = schemaVersion === 4 || schemaVersion === 5
    ? assertSuppressedUnplayedOutput(
      projection.suppressed_unplayed_output,
      outputCapture,
      profile,
    )
    : Object.freeze({
        audio_chunks: Object.freeze([]),
        audio_chunk_count: 0,
        audio_byte_length: 0,
        audio_chunk_sequence_sha256: outputChunkSequenceSha256({
          domain: LC4_SUPPRESSED_OUTPUT_CHUNK_SEQUENCE_DOMAIN,
          scope: "suppressed_before_listener_admission",
          sample_rate_hz: profile.output_sample_rate_hz,
          chunks: [],
        }),
      });
  if (schemaVersion === 5) {
    assertLc4DevGatewayConversationToolBatches(
      projection.dev_gateway_conversation_tool_batches,
      projection.dev_gateway_receipt_set,
      {
        episode_id: expected.run_id,
        opportunity_id: expected.opportunity_id,
        provider: profile.provider,
        arm: expected.response_control_kind === "hacc_response_plan"
          ? "hacc"
          : "native",
        phase: expected.playback_kind,
      },
    );
  } else if (Object.hasOwn(
    projection,
    "dev_gateway_conversation_tool_batches",
  )) {
    throw new Error(
      "LC4 pre-v5 provider exchange cannot contain retained DEV gateway conversation replay",
    );
  }

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
    if (schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5) {
      assertVersionedGeminiOutputAttribution({
        value: projection.gemini_output_attribution,
        observations,
        capture: outputCapture,
        suppression,
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
      suppression,
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
