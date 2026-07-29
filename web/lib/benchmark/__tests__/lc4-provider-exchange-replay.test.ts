import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import {
  LC4_DEV_AUDIO_DELIVERY_PROFILE,
  LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
} from "../lc4-development-audio-contract";
import {
  createLc4DevArmBlindRepairProjection,
} from "../lc4-development-headless-listener-authority";
import { createLc4CapturedOutput } from "../lc4-listener-evidence";
import {
  assertLc4ProviderExchangeReplayProjection,
  type Lc4ProviderExchangeReplayExpectation,
} from "../lc4-provider-exchange-replay";
import {
  LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
} from "../lc4-production-provider-contract";
import {
  createLc4ProviderExecutionProfile,
  type Lc4ProviderExecutionProfile,
} from "../lc4-production-runner-foundation";
import { realtimeWireProjectionSha256 } from "../../realtime/client/wire-evidence";
import {
  LC4_XAI_SERVER_VAD_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
  LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256,
} from "../xai-server-vad";

const WIRE_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-wire-observation-set/v1\n";
const MANUAL_CAUSALITY_DOMAIN =
  "harshas-amazing-call-center/lc4-xai-manual-turn-causality/v1\n";
const LISTENER_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-pinned-listener-evidence/v1\n";
const CAS_RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-cas-receipt/v1\n";

type Provider = "openai" | "gemini" | "xai";
type Wire = Readonly<{
  provider: Provider;
  direction: "inbound" | "outbound";
  connection_epoch: number;
  sequence: number;
  wire_type: string;
  payload_sha256: string;
  payload_bytes: number;
  projection_sha256: string;
  observation_sha256: string;
  previous_observation_sha256: string | null;
  identity_hashes: Readonly<Record<string, string>>;
}>;
type WireRole = Readonly<{
  direction: Wire["direction"];
  wire_type: string;
  identity_hashes?: Readonly<Record<string, string>>;
  payload_sha256?: string;
  payload_bytes?: number;
  projection_sha256?: string;
}>;

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function pcm(seed: number, byteLength: number): Uint8Array {
  const value = new Uint8Array(byteLength);
  for (let index = 0; index < value.length; index += 2) {
    value[index] = (seed + index) % 251;
    value[index + 1] = (seed * 7 + index) % 251;
  }
  return value;
}

function frames(
  value: Uint8Array,
  sampleRateHz: number,
): readonly Uint8Array[] {
  const frameBytes = sampleRateHz
    * 2
    * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs
    / 1_000;
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < value.byteLength; offset += frameBytes) {
    result.push(value.slice(offset, Math.min(
      value.byteLength,
      offset + frameBytes,
    )));
  }
  return result;
}

function pcmEvidence(value: Uint8Array, sampleRateHz: number) {
  return {
    validCanonicalBase64: true as const,
    byteLength: value.byteLength,
    sha256: sha256Hex(value),
    encodedBytes: Buffer.byteLength(
      Buffer.from(value).toString("base64"),
      "utf8",
    ),
    format: {
      encoding: "pcm16" as const,
      sampleRateHz,
      channels: 1 as const,
    },
  };
}

function inputWireRole(
  provider: Provider,
  value: Uint8Array,
  sampleRateHz: number,
): WireRole {
  const base64 = Buffer.from(value).toString("base64");
  if (provider === "gemini") {
    const event = {
      realtimeInput: {
        audio: {
          data: base64,
          mimeType: `audio/pcm;rate=${sampleRateHz}`,
        },
      },
    };
    const serialized = JSON.stringify(event);
    return {
      direction: "outbound",
      wire_type: "realtimeInput.audio",
      payload_sha256: sha256Hex(serialized),
      payload_bytes: Buffer.byteLength(serialized),
      projection_sha256: realtimeWireProjectionSha256({
        audio: {
          direction: "input",
          chunks: [{
            ...pcmEvidence(value, sampleRateHz),
            mimeTypeRecognized: true,
          }],
        },
      }),
    };
  }
  const event = {
    type: "input_audio_buffer.append",
    audio: base64,
  };
  const serialized = JSON.stringify(event);
  return {
    direction: "outbound",
    wire_type: "input_audio_buffer.append",
    payload_sha256: sha256Hex(serialized),
    payload_bytes: Buffer.byteLength(serialized),
    projection_sha256: realtimeWireProjectionSha256({
      audio: pcmEvidence(value, sampleRateHz),
    }),
  };
}

function outputWireRole(
  value: Uint8Array,
  sampleRateHz: number,
  responseIdSha256: string,
): WireRole {
  return {
    direction: "inbound",
    wire_type: "response.audio.delta",
    identity_hashes: { responseIdSha256 },
    projection_sha256: realtimeWireProjectionSha256({
      audio: pcmEvidence(value, sampleRateHz),
    }),
  };
}

function geminiOutputRole(
  values: readonly Uint8Array[],
  sampleRateHz: number,
  terminal = false,
): WireRole {
  const projection: Record<string, unknown> = {
    audio: {
      direction: "output",
      chunks: values.map((value) => ({
        ...pcmEvidence(value, sampleRateHz),
        mimeTypeRecognized: true,
      })),
    },
  };
  if (terminal) projection.terminal = { status: "completed" };
  return {
    direction: "inbound",
    wire_type: "serverContent",
    projection_sha256: realtimeWireProjectionSha256(projection),
  };
}

function wireFor(provider: Provider, roles: readonly WireRole[]): readonly Wire[] {
  let previous: string | null = null;
  return roles.map((role, index) => {
    const observation = sha256Hex(
      `${provider}:observation:${index}:${role.wire_type}:${previous ?? "root"}`,
    );
    const value = Object.freeze({
      provider,
      direction: role.direction,
      connection_epoch: 1,
      sequence: index + 1,
      wire_type: role.wire_type,
      payload_sha256: role.payload_sha256
        ?? sha256Hex(`${provider}:payload:${index}:${role.wire_type}`),
      payload_bytes: role.payload_bytes ?? 17,
      projection_sha256: role.projection_sha256
        ?? realtimeWireProjectionSha256({}),
      observation_sha256: observation,
      previous_observation_sha256: previous,
      identity_hashes: role.identity_hashes ?? {},
    });
    previous = observation;
    return value;
  });
}

function rechain(wire: readonly Wire[]): readonly Wire[] {
  let previous: string | null = null;
  return wire.map((entry, index) => {
    const body = {
      ...entry,
      sequence: index + 1,
      previous_observation_sha256: previous,
    };
    const observation = sha256Hex(
      `rechain:${index}:${canonicalJson(body)}`,
    );
    previous = observation;
    return Object.freeze({
      ...body,
      observation_sha256: observation,
    });
  });
}

function delivery(value: Uint8Array, profile: Lc4ProviderExecutionProfile) {
  const chunks = frames(value, profile.input_sample_rate_hz);
  const frameBytes = profile.input_sample_rate_hz
    * 2
    * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs
    / 1_000;
  return {
    frame_byte_length: frameBytes,
    chunk_count: chunks.length,
    total_byte_length: value.byteLength,
    tail_byte_length: chunks.at(-1)!.byteLength,
    last_scheduled_offset_ms:
      (chunks.length - 1) * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs,
    media_duration_ms:
      value.byteLength / 2 / profile.input_sample_rate_hz * 1_000,
    chunks: chunks.map((chunk, index) => ({
      chunk_index: index + 1,
      byte_length: chunk.byteLength,
      scheduled_offset_ms:
        index * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs,
      appended_at_offset_ms:
        index * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs,
    })),
    profile_sha256: LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
    pcm_sha256: sha256Hex(value),
  };
}

function captureProjection(input: Readonly<{
  runId: string;
  opportunityId: string;
  provider: Provider;
  sampleRateHz: number;
  chunks: readonly Uint8Array[];
}>) {
  const capture = createLc4CapturedOutput({
    runId: input.runId,
    opportunityId: input.opportunityId,
    responseId: `response-${input.provider}-fixture`,
    provider: input.provider,
    surface: "server_realtime_pcm",
    sampleRateHz: input.sampleRateHz,
    chunks: input.chunks.map((chunk, index) => ({
      chunkId: `${input.opportunityId}-chunk-${index + 1}`,
      pcm: chunk,
    })),
  });
  return {
    projection: {
      ...capture,
      chunks: capture.chunks.map((chunk) => chunk.receipt),
    },
    pcm: Buffer.concat(capture.chunks.map((chunk) =>
      Buffer.from(chunk.pcm))),
  };
}

function listenerLineage(input: Readonly<{
  runId: string;
  opportunityId: string;
  provider: Provider;
  responsePlanSha256: string | null;
  wireSetSha256: string;
  capture: ReturnType<typeof captureProjection>["projection"];
  outputPcm: Uint8Array;
}>) {
  const repair = createLc4DevArmBlindRepairProjection({
    opportunity_id: input.opportunityId,
    listener_status: "verified",
    semantic_result_sha256: sha256Hex("listener-semantic-result"),
    semantic_replay_sha256: sha256Hex("listener-semantic-replay"),
    unmet_blocker_codes: [],
    final_required_criteria_pass: true,
  });
  const outputSha256 = sha256Hex(input.outputPcm);
  const playbackAuthority = sha256Hex("listener-playback-authority");
  const body = {
    schema_version: 1,
    dependency_version: "lc4-dev-live-dependencies-v1",
    episode_id: input.runId,
    opportunity_id: input.opportunityId,
    provider: input.provider,
    capture_receipt_sha256: input.capture.capture_receipt_sha256,
    generated_pcm_sha256: outputSha256,
    captured_pcm_sha256: outputSha256,
    evaluator_consumed_pcm_sha256: outputSha256,
    evaluator_consumed_byte_start: 0,
    evaluator_consumed_byte_end: input.outputPcm.byteLength,
    evaluator_consumed_pcm_cas_receipt_sha256: domainHash(
      CAS_RECEIPT_DOMAIN,
      {
        schema_version: 1,
        algorithm: "sha256",
        artifact_sha256: outputSha256,
        byte_length: input.outputPcm.byteLength,
        relative_path: `${outputSha256.slice(0, 2)}/${outputSha256}`,
        media_type: "audio/pcm",
      },
    ),
    headless_listener_authority_receipt_sha256: playbackAuthority,
    headless_listener_authority_receipt_cas_sha256:
      sha256Hex("listener-authority-cas"),
    headless_listener_authority_receipt_cas_receipt_sha256:
      sha256Hex("listener-authority-cas-receipt"),
    physical_playback_status: "not_performed_headless",
    human_audibility_status: "not_measured_not_claimed",
    criterion_plan_sha256: sha256Hex("listener-criterion"),
    response_plan_sha256: input.responsePlanSha256,
    wire_observation_set_sha256: input.wireSetSha256,
    signed_invocation_artifact_cas_sha256:
      sha256Hex("evaluator-invocation-artifact"),
    signed_invocation_artifact_byte_length: 1_024,
    evaluation: {
      source_pcm_sha256: outputSha256,
      source_pcm_byte_length: input.outputPcm.byteLength,
      evaluator_contract_sha256: sha256Hex("evaluator-contract"),
      evaluator_build_sha256: sha256Hex("evaluator-build"),
      calibration_sha256: sha256Hex("evaluator-calibration"),
      transcript_sha256: sha256Hex("evaluator-transcript"),
      semantic_result_sha256: repair.semantic_result_sha256,
      semantic_artifact_cas_sha256: sha256Hex("semantic-artifact"),
      signed_invocation_receipt_sha256:
        sha256Hex("evaluator-invocation"),
      signed_invocation_artifact_cas_sha256:
        sha256Hex("evaluator-invocation-artifact"),
      signed_invocation_artifact_byte_length: 1_024,
      repair_projection: repair,
    },
    listener_manifest_sha256: sha256Hex("listener-manifest"),
  };
  const evidenceSha256 = domainHash(LISTENER_DOMAIN, body);
  const reference = {
    schema_version: 1 as const,
    retention_version: "lc4-dev-replay-evidence-v1" as const,
    kind: "listener_evidence" as const,
    evidence_sha256: evidenceSha256,
    byte_length: Buffer.byteLength(
      `${LISTENER_DOMAIN}${canonicalJson(body)}`,
    ),
    content_encoding: "domain-prefixed-canonical-json" as const,
    domain_prefix: LISTENER_DOMAIN,
  };
  return {
    body,
    reference,
    result: {
      listener_evidence_sha256: evidenceSha256,
      repair_projection: repair,
      playback_authority_receipt_sha256: playbackAuthority,
      listener_evidence: reference,
    },
  };
}

type Fixture = Readonly<{
  projection: Record<string, unknown>;
  expectation: Lc4ProviderExchangeReplayExpectation;
}>;

function fixture(
  provider: Provider,
  serverVad = false,
): Fixture {
  const profile = createLc4ProviderExecutionProfile(
    provider,
    serverVad ? "interactive_transport_qualification" : undefined,
  );
  const runId = `${provider}-${serverVad ? "server-vad" : "manual"}-run`;
  const opportunityId = "op-1";
  const frameBytes = profile.input_sample_rate_hz
    * 2
    * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs
    / 1_000;
  const caller = pcm(provider.length, frameBytes * 2);
  const callerFrames = frames(caller, profile.input_sample_rate_hz);
  const outputChunks = [
    pcm(provider.length + 11, 4),
    pcm(provider.length + 23, 6),
  ];
  const captured = captureProjection({
    runId,
    opportunityId,
    provider,
    sampleRateHz: profile.output_sample_rate_hz,
    chunks: outputChunks,
  });
  const responseIdentity = sha256Hex(`${provider}-response-identity`);
  let suffix: Record<string, unknown> | null = null;
  let roles: WireRole[];
  if (provider === "gemini") {
    roles = [
      { direction: "outbound", wire_type: "realtimeInput.activityStart" },
      ...callerFrames.map((frame) =>
        inputWireRole(provider, frame, profile.input_sample_rate_hz)),
      { direction: "outbound", wire_type: "realtimeInput.activityEnd" },
      geminiOutputRole(outputChunks, profile.output_sample_rate_hz),
      {
        direction: "inbound",
        wire_type: "serverContent",
        projection_sha256: realtimeWireProjectionSha256({
          terminal: { status: "completed" },
        }),
      },
    ];
  } else if (serverVad) {
    const suffixChunkCount =
      LC4_XAI_SERVER_VAD_SILENCE_TAIL.minimum_accepted_chunk_count;
    const suffixFrameBytes = LC4_XAI_SERVER_VAD_SILENCE_TAIL.sample_rate_hz
      * 2
      * LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms
      / 1_000;
    suffix = {
      schema_version: 1,
      purpose: LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose,
      completion: "provider_native_speech_stop",
      policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
      pcm_sha256: sha256Hex(
        new Uint8Array(suffixChunkCount * suffixFrameBytes),
      ),
      audio_bytes: suffixChunkCount * suffixFrameBytes,
      duration_ms:
        suffixChunkCount * LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms,
      chunk_count: suffixChunkCount,
      frame_bytes: suffixFrameBytes,
      tail_bytes: suffixFrameBytes,
      delivery_profile_sha256: LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
      scheduled_offsets_ms: Array.from(
        { length: suffixChunkCount },
        (_, index) =>
          index * LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms,
      ),
    };
    const suffixFrame = new Uint8Array(suffixFrameBytes);
    roles = [
      { direction: "outbound", wire_type: "session.update" },
      { direction: "inbound", wire_type: "session.updated" },
      ...callerFrames.map((frame) =>
        inputWireRole(provider, frame, profile.input_sample_rate_hz)),
      { direction: "inbound", wire_type: "input_audio_buffer.speech_started" },
      ...Array.from({ length: suffixChunkCount }, () =>
        inputWireRole(provider, suffixFrame, profile.input_sample_rate_hz)),
      { direction: "inbound", wire_type: "input_audio_buffer.speech_stopped" },
      { direction: "inbound", wire_type: "input_audio_buffer.committed" },
      {
        direction: "inbound",
        wire_type: "response.created",
        identity_hashes: { responseIdSha256: responseIdentity },
      },
      ...outputChunks.map((chunk) => outputWireRole(
        chunk,
        profile.output_sample_rate_hz,
        responseIdentity,
      )),
      {
        direction: "inbound",
        wire_type: "response.done",
        identity_hashes: { responseIdSha256: responseIdentity },
      },
    ];
  } else {
    roles = [
      ...callerFrames.map((frame) =>
        inputWireRole(provider, frame, profile.input_sample_rate_hz)),
      { direction: "outbound", wire_type: "input_audio_buffer.commit" },
      ...(provider === "xai"
        ? [{ direction: "inbound" as const, wire_type: "input_audio_buffer.committed" }]
        : []),
      { direction: "outbound", wire_type: "response.create" },
      {
        direction: "inbound",
        wire_type: "response.created",
        identity_hashes: { responseIdSha256: responseIdentity },
      },
      ...outputChunks.map((chunk) => outputWireRole(
        chunk,
        profile.output_sample_rate_hz,
        responseIdentity,
      )),
      {
        direction: "inbound",
        wire_type: "response.done",
        identity_hashes: { responseIdSha256: responseIdentity },
      },
    ];
  }
  const wire = wireFor(provider, roles);
  const wireSetSha256 = domainHash(WIRE_SET_DOMAIN, wire);
  const listener = listenerLineage({
    runId,
    opportunityId,
    provider,
    responsePlanSha256: null,
    wireSetSha256,
    capture: captured.projection,
    outputPcm: captured.pcm,
  });
  let manualCausality = null;
  if (provider === "xai" && !serverVad) {
    const commit = wire.find((entry) =>
      entry.wire_type === "input_audio_buffer.commit")!;
    const acknowledgement = wire.find((entry) =>
      entry.wire_type === "input_audio_buffer.committed")!;
    const create = wire.find((entry) =>
      entry.wire_type === "response.create")!;
    const start = wire.find((entry) =>
      entry.wire_type === "response.created")!;
    const body = {
      schema_version: 1,
      connection_epoch: 1,
      commit_observation_sha256: commit.observation_sha256,
      commit_sequence: commit.sequence,
      commit_ack_observation_sha256: acknowledgement.observation_sha256,
      commit_ack_sequence: acknowledgement.sequence,
      response_create_observation_sha256: create.observation_sha256,
      response_create_sequence: create.sequence,
      response_start_observation_sha256: start.observation_sha256,
      response_start_sequence: start.sequence,
      response_id_sha256: responseIdentity,
    };
    manualCausality = {
      ...body,
      causality_sha256: domainHash(MANUAL_CAUSALITY_DOMAIN, body),
    };
  }
  const projection = {
    schema_version: 2,
    adapter_version: LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
    run_id: runId,
    opportunity_id: opportunityId,
    segment_ordinal: 1,
    playback_kind: "canonical",
    provider,
    model: profile.model,
    caller_pcm_sha256: sha256Hex(caller),
    caller_pcm_byte_length: caller.byteLength,
    assistant_conversation_transcript_sha256:
      listener.body.evaluation.transcript_sha256,
    assistant_conversation_transcript_source:
      "listener_exact_captured_pcm_asr",
    response_control_kind: "native_context",
    response_plan_sha256: null,
    requested_runtime_identity: {
      provider,
      model: profile.model,
      voice: profile.voice,
    },
    effective_runtime_identity: {
      provider,
      model: profile.model,
      voice: profile.voice,
    },
    input_audio_delivery: delivery(caller, profile),
    output_capture: captured.projection,
    transport_mode: serverVad
      ? "provider_native_server_vad"
      : "manual_commit",
    transport_purpose: provider === "xai"
      ? profile.transport_purpose
      : null,
    transport_profile_sha256:
      profile.transport_profile_sha256 ?? profile.provider_profile_sha256,
    transport_parity_sha256: provider === "xai"
      ? sha256Hex(`${provider}-transport-parity`)
      : profile.provider_profile_sha256,
    tool_frontier_sha256: sha256Hex(`${provider}-tool-frontier`),
    server_vad_setting_sha256:
      serverVad ? LC4_XAI_SERVER_VAD_SHA256 : null,
    server_vad_transport_disclosure_sha256:
      serverVad ? LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256 : null,
    server_vad_transport_suffix: suffix,
    per_turn_session_update_observation_sha256:
      serverVad ? wire[0]!.observation_sha256 : null,
    per_turn_session_ack_observation_sha256:
      serverVad ? wire[1]!.observation_sha256 : null,
    xai_manual_turn_causality: manualCausality,
    operation_order: serverVad
      ? [
          "response_plan_session_update_sent",
          "response_plan_session_update_acknowledged",
          "caller_pcm_delivery_started",
          "caller_pcm_delivery_completed",
          "server_vad_silence_tail_delivery_started",
          "server_vad_speech_started",
          "server_vad_speech_stopped",
          "server_vad_silence_tail_prefix_accepted",
          "caller_pcm_auto_committed",
          "response_generation_auto_started",
          "assistant_pcm_captured",
          "listener_evidence_handed_off",
        ]
      : [
          "caller_pcm_delivery_started",
          "caller_pcm_delivery_completed",
          "response_plan_prepared",
          "caller_pcm_committed",
          ...(provider === "xai"
            ? ["caller_pcm_commit_acknowledged"]
            : []),
          "response_generation_requested",
          "assistant_pcm_captured",
          "listener_evidence_handed_off",
        ],
    wire_observations: wire,
    wire_observation_set_sha256: wireSetSha256,
    dev_listener_result: listener.result,
  };
  return {
    projection,
    expectation: {
      run_id: runId,
      opportunity_id: opportunityId,
      segment_ordinal: 1,
      playback_kind: "canonical",
      caller_pcm_sha256: sha256Hex(caller),
      caller_pcm_byte_length: caller.byteLength,
      response_control_kind: "native_context",
      provider_profile: profile,
      input_audio_delivery_profile_sha256:
        LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
      caller_pcm: caller,
      listener_consumed_pcm: captured.pcm,
      listener_evidence_projection: listener.body as unknown as JsonValue,
      listener_evidence_reference: listener.reference,
      listener_manifest_sha256: sha256Hex("listener-manifest"),
      evaluator_build_sha256: sha256Hex("evaluator-build"),
    },
  };
}

function withWire(
  source: Fixture,
  wire: readonly Wire[],
): Fixture {
  return {
    projection: {
      ...source.projection,
      wire_observations: wire,
      wire_observation_set_sha256: domainHash(WIRE_SET_DOMAIN, wire),
    },
    expectation: source.expectation,
  };
}

function withListenerMutation(
  source: Fixture,
  mutate: (listener: Record<string, unknown>) => Record<string, unknown>,
): Fixture {
  const body = mutate(JSON.parse(canonicalJson(
    source.expectation.listener_evidence_projection,
  )) as Record<string, unknown>);
  const evidenceSha256 = domainHash(LISTENER_DOMAIN, body);
  const reference = {
    ...source.expectation.listener_evidence_reference,
    evidence_sha256: evidenceSha256,
    byte_length: Buffer.byteLength(
      `${LISTENER_DOMAIN}${canonicalJson(body)}`,
    ),
  };
  const result = source.projection.dev_listener_result as Record<string, unknown>;
  return {
    projection: {
      ...source.projection,
      dev_listener_result: {
        ...result,
        listener_evidence_sha256: evidenceSha256,
        listener_evidence: reference,
      },
    },
    expectation: {
      ...source.expectation,
      listener_evidence_projection: body as JsonValue,
      listener_evidence_reference: reference,
    },
  };
}

function haccToolContinuationFixture(provider: Provider): Fixture {
  const initialResponsePlanSha256 = sha256Hex(
    `${provider}-initial-response-plan`,
  );
  const terminalResponsePlanSha256 = sha256Hex(
    `${provider}-post-tool-response-plan`,
  );
  const native = fixture(provider);
  const hacc: Fixture = {
    projection: {
      ...native.projection,
      response_control_kind: "hacc_response_plan",
      response_plan_sha256: initialResponsePlanSha256,
      terminal_response_plan_sha256: terminalResponsePlanSha256,
    },
    expectation: {
      ...native.expectation,
      response_control_kind: "hacc_response_plan",
    },
  };
  return withListenerMutation(hacc, (listener) => ({
    ...listener,
    response_plan_sha256: terminalResponsePlanSha256,
  }));
}

function replay(value: Fixture): void {
  assertLc4ProviderExchangeReplayProjection(
    value.projection as unknown as JsonValue,
    value.expectation,
  );
}

describe("LC4 retained provider exchange audio-lineage replay", () => {
  it.each(["openai", "gemini", "xai"] as const)(
    "replays exact %s caller wire, output capture, CAS, and evaluator lineage",
    (provider) => {
      expect(() => replay(fixture(provider))).not.toThrow();
    },
  );

  it("replays exact xAI server-VAD caller plus delimiter and output lineage", () => {
    expect(() => replay(fixture("xai", true))).not.toThrow();
  });

  it.each(["openai", "gemini", "xai"] as const)(
    "binds %s HACC listener evidence to the terminal post-tool response plan",
    (provider) => {
      const valid = haccToolContinuationFixture(provider);
      expect(valid.projection.response_plan_sha256)
        .not.toBe(valid.projection.terminal_response_plan_sha256);
      expect(() => replay(valid)).not.toThrow();
    },
  );

  it("rejects a rehashed HACC listener rebound to the initial pre-tool response plan", () => {
    const valid = haccToolContinuationFixture("openai");
    const mutation = withListenerMutation(valid, (listener) => ({
      ...listener,
      response_plan_sha256: valid.projection.response_plan_sha256,
    }));
    expect(() => replay(mutation)).toThrow(/listener\/CAS\/evaluator/u);
  });

  it("rejects a substituted terminal HACC response plan", () => {
    const valid = haccToolContinuationFixture("openai");
    expect(() => replay({
      ...valid,
      projection: {
        ...valid.projection,
        terminal_response_plan_sha256:
          sha256Hex("substituted-terminal-response-plan"),
      },
    })).toThrow(/listener\/CAS\/evaluator/u);
  });

  it("rejects a Native exchange that smuggles a HACC plan commitment", () => {
    const valid = fixture("openai");
    expect(() => replay({
      ...valid,
      projection: {
        ...valid.projection,
        response_plan_sha256: sha256Hex("smuggled-hacc-plan"),
      },
    })).toThrow(/cannot carry a HACC response-plan/u);
  });

  it("replays a bounded long-form response with more than 512 wire observations", () => {
    const valid = fixture("openai");
    const wire = [...valid.projection.wire_observations as readonly Wire[]];
    const responseStartIndex = wire.findIndex((entry) =>
      entry.wire_type === "response.created");
    const responseStart = wire[responseStartIndex]!;
    const transcriptDeltas = Array.from({ length: 600 }, (_, index) => ({
      ...responseStart,
      wire_type: "response.output_audio_transcript.delta",
      payload_sha256: sha256Hex(`long-transcript-delta-${index}`),
      projection_sha256: realtimeWireProjectionSha256({}),
    }));
    wire.splice(responseStartIndex + 1, 0, ...transcriptDeltas);
    const expanded = withWire(valid, rechain(wire));
    const rebound = withListenerMutation(expanded, (listener) => ({
      ...listener,
      wire_observation_set_sha256:
        expanded.projection.wire_observation_set_sha256,
    }));

    expect((rebound.projection.wire_observations as readonly Wire[]).length)
      .toBeGreaterThan(512);
    expect(() => replay(rebound)).not.toThrow();
  });

  it("rejects a wire-observation set above the retained custody bound", () => {
    const valid = fixture("openai");
    const first = (valid.projection.wire_observations as readonly Wire[])[0]!;
    const oversized = Array.from({ length: 8_193 }, () => first);

    expect(() => replay({
      ...valid,
      projection: {
        ...valid.projection,
        wire_observations: oversized,
      },
    })).toThrow(/nonempty bounded array/u);
  });

  it("rejects reconnect transcript provenance that is not the exact captured-PCM listener transcript", () => {
    const valid = fixture("gemini");
    expect(() => replay({
      ...valid,
      projection: {
        ...valid.projection,
        assistant_conversation_transcript_sha256: sha256Hex("different transcript"),
      },
    })).toThrow(/listener\/CAS\/evaluator evidence/u);
    expect(() => replay({
      ...valid,
      projection: {
        ...valid.projection,
        assistant_conversation_transcript_source: "provider_native_output_transcript",
      },
    })).toThrow(/listener\/CAS\/evaluator evidence/u);
  });

  it("rejects freshly rehashed input delivery truncation", () => {
    const valid = fixture("openai");
    const input = valid.projection.input_audio_delivery as Record<string, unknown>;
    const mutation: Fixture = {
      ...valid,
      projection: {
        ...valid.projection,
        input_audio_delivery: {
          ...input,
          chunks: (input.chunks as unknown[]).slice(0, -1),
          chunk_count: Number(input.chunk_count) - 1,
        },
      },
    };
    expect(sha256Hex(canonicalJson(mutation.projection))).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => replay(mutation)).toThrow(/accounting/u);
  });

  it("rejects an exact-count input append whose PCM projection is substituted", () => {
    const valid = fixture("gemini");
    const wire = (valid.projection.wire_observations as readonly Wire[])
      .map((entry) => entry.wire_type === "realtimeInput.audio"
        ? {
            ...entry,
            projection_sha256: sha256Hex("substituted-input-audio"),
          }
        : entry);
    expect(() => replay(withWire(valid, rechain(wire))))
      .toThrow(/exact retained PCM chunk/u);
  });

  it("rejects rehashed xAI manual caller audio moved after commit", () => {
    const valid = fixture("xai");
    const wire = [...valid.projection.wire_observations as readonly Wire[]];
    const append = wire.shift()!;
    const commitIndex = wire.findIndex((entry) =>
      entry.wire_type === "input_audio_buffer.commit");
    wire.splice(commitIndex + 1, 0, append);
    expect(() => replay(withWire(valid, rechain(wire))))
      .toThrow(/after its input commit/u);
  });

  it("rejects rehashed server-VAD suffix audio moved after speech stop", () => {
    const valid = fixture("xai", true);
    const wire = [...valid.projection.wire_observations as readonly Wire[]];
    const stopIndex = wire.findIndex((entry) =>
      entry.wire_type === "input_audio_buffer.speech_stopped");
    const appendIndex = wire.findIndex((entry, index) =>
      index > stopIndex
      && entry.wire_type === "input_audio_buffer.append");
    expect(appendIndex).toBe(-1);
    const beforeStop = wire
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) =>
        entry.wire_type === "input_audio_buffer.append")
      .at(-1)!;
    wire.splice(beforeStop.index, 1);
    const newStop = wire.findIndex((entry) =>
      entry.wire_type === "input_audio_buffer.speech_stopped");
    wire.splice(newStop + 1, 0, beforeStop.entry);
    expect(() => replay(withWire(valid, rechain(wire))))
      .toThrow(/speech boundary/u);
  });

  it("rejects output capture chunk reordering even when outer JSON is rehashed", () => {
    const valid = fixture("openai");
    const capture = valid.projection.output_capture as Record<string, unknown>;
    const chunks = [...capture.chunks as unknown[]].reverse();
    const mutation: Fixture = {
      ...valid,
      projection: {
        ...valid.projection,
        output_capture: { ...capture, chunks },
      },
    };
    expect(() => replay(mutation)).toThrow(/substituted|reordered/u);
  });

  it("rejects an identity-selected output wire PCM substitution", () => {
    const valid = fixture("openai");
    const wire = (valid.projection.wire_observations as readonly Wire[])
      .map((entry) => entry.wire_type === "response.audio.delta"
        ? {
            ...entry,
            projection_sha256: sha256Hex("substituted-output-audio"),
          }
        : entry);
    expect(() => replay(withWire(valid, rechain(wire))))
      .toThrow(/exact inbound wire audio projection/u);
  });

  it("rejects a response start inserted between captured output chunks", () => {
    const valid = fixture("openai");
    const wire = [...valid.projection.wire_observations as readonly Wire[]];
    const startIndex = wire.findIndex((entry) =>
      entry.wire_type === "response.created");
    const [start] = wire.splice(startIndex, 1);
    const firstAudioIndex = wire.findIndex((entry) =>
      entry.wire_type === "response.audio.delta");
    wire.splice(firstAudioIndex + 1, 0, start!);
    expect(() => replay(withWire(valid, rechain(wire))))
      .toThrow(/enclosed|ordered/u);
  });

  it("rejects Gemini terminal-before-audio after a full wire rehash", () => {
    const valid = fixture("gemini");
    const wire = [...valid.projection.wire_observations as readonly Wire[]];
    const terminalIndex = wire.findIndex((entry) =>
      entry.direction === "inbound"
      && entry.projection_sha256 === realtimeWireProjectionSha256({
        terminal: { status: "completed" },
      }));
    const [terminal] = wire.splice(terminalIndex, 1);
    const audioIndex = wire.findIndex((entry) =>
      entry.direction === "inbound"
      && entry.wire_type === "serverContent");
    wire.splice(audioIndex, 0, terminal!);
    expect(() => replay(withWire(valid, rechain(wire))))
      .toThrow(/activityEnd-to-turnComplete/u);
  });

  it("rejects any unclassified Gemini serverContent inside the output turn", () => {
    const valid = fixture("gemini");
    const wire = [...valid.projection.wire_observations as readonly Wire[]];
    const terminalIndex = wire.findIndex((entry) =>
      entry.direction === "inbound"
      && entry.projection_sha256 === realtimeWireProjectionSha256({
        terminal: { status: "completed" },
      }));
    wire.splice(terminalIndex, 0, {
      ...wire[terminalIndex]!,
      projection_sha256: realtimeWireProjectionSha256({
        text: [{ kind: "model_text", sha256: sha256Hex("omitted"), byteLength: 7 }],
      }),
    });
    expect(() => replay(withWire(valid, rechain(wire))))
      .toThrow(/unique ordered/u);
  });

  it("rejects a self-consistently rehashed evaluator PCM substitution", () => {
    const mutation = withListenerMutation(fixture("xai"), (listener) => ({
      ...listener,
      evaluator_consumed_pcm_sha256: sha256Hex("substituted-evaluator-pcm"),
    }));
    expect(() => replay(mutation)).toThrow(/listener\/CAS\/evaluator/u);
  });

  it("rejects a self-consistently rehashed PCM CAS receipt substitution", () => {
    const mutation = withListenerMutation(fixture("openai"), (listener) => ({
      ...listener,
      evaluator_consumed_pcm_cas_receipt_sha256:
        sha256Hex("substituted-pcm-cas-receipt"),
    }));
    expect(() => replay(mutation)).toThrow(/listener\/CAS\/evaluator/u);
  });

  it("rejects a retained listener reference substituted beside exact JSON", () => {
    const valid = fixture("gemini");
    const mutation: Fixture = {
      ...valid,
      expectation: {
        ...valid.expectation,
        listener_evidence_reference: {
          ...valid.expectation.listener_evidence_reference,
          evidence_sha256: sha256Hex("foreign-listener-reference"),
        },
      },
    };
    expect(() => replay(mutation)).toThrow(/exact retained evidence reference/u);
  });
});
