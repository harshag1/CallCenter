import { describe, expect, it } from "vitest";
import {
  replayProviderToolRoundtrip,
  projectRoundtripInputAudioEvidence,
  projectRoundtripOutputAudioEvidence,
  projectRoundtripPreToolOutputQuarantineEvidence,
  roundtripInputAudioChunkListSha256,
  roundtripCausalBindingSha256,
  roundtripSanitizedUsageSha256,
  type ProviderRoundtripReplayInput,
  type RoundtripCausalBinding,
  type RoundtripReplaySummary,
  type RoundtripSanitizedUsage,
} from "../provider-roundtrip-replay";
import { canonicalJson, sha256Hex } from "../artifacts";
import type {
  RealtimeWireObservation,
  ServerRealtimeProvider,
} from "../../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";

const H = (character: string) => character.repeat(64);

type WireSeed = Readonly<{
  direction: "inbound" | "outbound";
  wireType: string;
  projection?: Readonly<Record<string, unknown>>;
  identities?: RealtimeWireObservation["identities"];
  connectionEpoch?: number;
}>;

function wire(provider: ServerRealtimeProvider, seeds: readonly WireSeed[]): RealtimeWireObservation[] {
  let predecessor: string | null = null;
  return seeds.map((seed, index) => {
    const projection = seed.projection ?? {};
    const core = {
      schemaVersion: 1 as const,
      provider,
      direction: seed.direction,
      connectionEpoch: seed.connectionEpoch ?? 1,
      sequence: index + 1,
      observedAtMs: 1_000 + index,
      observedAtMonotonicMs: 100 + index,
      wireType: seed.wireType,
      payloadSha256: H(String((index + 1) % 10)),
      payloadBytes: 100 + index,
      projectionSha256: realtimeWireProjectionSha256(projection),
      previousObservationSha256: predecessor,
      identities: seed.identities ?? {},
      projection,
    };
    const observation = {
      ...core,
      observationSha256: realtimeWireObservationSha256(core),
    };
    predecessor = observation.observationSha256;
    return observation;
  });
}

function seeds(observations: readonly RealtimeWireObservation[]): WireSeed[] {
  return observations.map((observation) => ({
    direction: observation.direction,
    wireType: observation.wireType,
    projection: observation.projection,
    identities: observation.identities,
    connectionEpoch: observation.connectionEpoch,
  }));
}

function append(input: ProviderRoundtripReplayInput, seed: WireSeed): ProviderRoundtripReplayInput {
  return {
    ...input,
    wire_observations: wire(input.summary.provider, [...seeds(input.wire_observations), seed]),
  };
}

function withRebuiltWire(
  input: ProviderRoundtripReplayInput,
  nextSeeds: readonly WireSeed[],
): ProviderRoundtripReplayInput {
  return { ...input, wire_observations: wire(input.summary.provider, nextSeeds) };
}

function gatewayCall(callId: string, responseId?: string, itemId?: string) {
  return {
    gateway: "capability_gateway",
    callIdSha256: callId,
    ...(responseId ? { responseIdSha256: responseId } : {}),
    ...(itemId ? { itemIdSha256: itemId } : {}),
    argumentsSha256: H("a"),
    argumentsBytes: 67,
    argumentsJsonValid: true,
    targetToolNameSha256: realtimeWireIdentitySha256("target-tool", "complete_current_stage"),
    targetArgumentsSha256: sha256Hex(canonicalJson({})),
  };
}

function gatewayResult(callId: string) {
  return {
    gateway: "capability_gateway",
    callIdSha256: callId,
    resultSha256: sha256Hex(canonicalJson({ ok: true, qualification_stage: "completed" })),
    resultBytes: 49,
    resultJsonValid: true,
  };
}

function providerReportedUsage(
  responseId: string,
  terminalObservation: RealtimeWireObservation,
  counters: Readonly<Record<string, number>>,
): RoundtripSanitizedUsage {
  return {
    schema_version: 1,
    source: "provider_reported",
    response_id_sha256: responseId,
    terminal_observation_sha256: terminalObservation.observationSha256,
    provider_usage_observation_sha256: terminalObservation.observationSha256,
    contributing_wire_observation_sha256s: [terminalObservation.observationSha256],
    counters,
  };
}

function openAiPacket(options: Readonly<{
  multiFrameCall?: boolean;
  conflictingTerminalProjection?: boolean;
}> = {}): ProviderRoundtripReplayInput {
  const callId = realtimeWireIdentitySha256("call", "call-openai-1");
  const origin = realtimeWireIdentitySha256("response", "response-openai-origin");
  const continuation = realtimeWireIdentitySha256("response", "response-openai-continuation");
  const itemId = realtimeWireIdentitySha256("item", "item-openai-1");
  const completedCall = gatewayCall(callId, origin, options.multiFrameCall ? itemId : undefined);
  const responseOmittedCall = Object.fromEntries(Object.entries(completedCall).filter(
    ([key]) => key !== "responseIdSha256",
  ));
  const incompleteCall = {
    gateway: "capability_gateway",
    callIdSha256: callId,
    responseIdSha256: origin,
    itemIdSha256: itemId,
    argumentsSha256: sha256Hex(""),
    argumentsBytes: 0,
    argumentsJsonValid: false,
  };
  const responseOmittedIncompleteCall = Object.fromEntries(Object.entries(incompleteCall).filter(
    ([key]) => key !== "responseIdSha256",
  ));
  const callFrames: WireSeed[] = options.multiFrameCall ? [
    {
      direction: "inbound",
      wireType: "response.output_item.added",
      identities: { callIdSha256: callId, responseIdSha256: origin, itemIdSha256: itemId },
      projection: { gatewayCalls: [incompleteCall] },
    },
    {
      direction: "inbound",
      wireType: "conversation.item.added",
      identities: { callIdSha256: callId, itemIdSha256: itemId },
      projection: { gatewayCalls: [responseOmittedIncompleteCall] },
    },
    {
      direction: "inbound",
      wireType: "response.function_call_arguments.done",
      identities: { callIdSha256: callId, responseIdSha256: origin, itemIdSha256: itemId },
      projection: { gatewayCalls: [completedCall] },
    },
    {
      direction: "inbound",
      wireType: "conversation.item.done",
      identities: { callIdSha256: callId, itemIdSha256: itemId },
      projection: {
        gatewayCalls: [{
          ...responseOmittedCall,
          ...(options.conflictingTerminalProjection
            ? { targetArgumentsSha256: H("f") }
            : {}),
        }],
      },
    },
    {
      direction: "inbound",
      wireType: "response.output_item.done",
      identities: { callIdSha256: callId, responseIdSha256: origin, itemIdSha256: itemId },
      projection: { gatewayCalls: [completedCall] },
    },
    {
      direction: "inbound",
      wireType: "response.done",
      identities: { callIdSha256: callId, responseIdSha256: origin, itemIdSha256: itemId },
      projection: {
        gatewayCalls: [completedCall],
        terminal: { status: "completed" },
        usage: { totalTokens: 4 },
      },
    },
  ] : [{
    direction: "inbound",
    wireType: "response.function_call_arguments.done",
    identities: { callIdSha256: callId, responseIdSha256: origin },
    projection: { gatewayCalls: [completedCall] },
  }];
  const observations = wire("openai", [
    {
      direction: "outbound",
      wireType: "input_audio_buffer.append",
      projection: {
        audio: {
          direction: "input", validCanonicalBase64: true, sha256: H("9"), byteLength: 2,
          format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        },
      },
    },
    { direction: "outbound", wireType: "response.create", projection: { dynamicControl: { sha256: H("1") } } },
    { direction: "inbound", wireType: "response.created", identities: { responseIdSha256: origin } },
    ...callFrames,
    {
      direction: "outbound",
      wireType: "conversation.item.create",
      identities: { callIdSha256: callId },
      projection: { gatewayResults: [gatewayResult(callId)] },
    },
    { direction: "outbound", wireType: "response.create", projection: { dynamicControl: { sha256: H("2") } } },
    { direction: "inbound", wireType: "response.created", identities: { responseIdSha256: continuation } },
    {
      direction: "inbound",
      wireType: "response.output_audio.delta",
      identities: { responseIdSha256: continuation },
      projection: {
        audio: {
          direction: "output",
          validCanonicalBase64: true,
          sha256: H("8"),
          byteLength: 24_000,
          format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        },
      },
    },
    {
      direction: "inbound",
      wireType: "response.done",
      identities: { responseIdSha256: continuation },
      projection: { terminal: { status: "completed" }, usage: { totalTokens: 8 } },
    },
  ]);
  const callIndex = 2 + callFrames.length;
  const resultIndex = callIndex + 1;
  const continuationRequestIndex = callIndex + 2;
  const continuationStartIndex = callIndex + 3;
  const terminalIndex = callIndex + 5;
  const usage = providerReportedUsage(continuation, observations[terminalIndex]!, { totalTokens: 8 });
  const inputAudio = projectRoundtripInputAudioEvidence(observations, {
    chunk_sha256s: [H("9")], chunk_list_sha256: roundtripInputAudioChunkListSha256([H("9")]),
    audio_sha256: H("7"), delivery_profile_sha256: H("6"), packetizer_sha256: H("5"),
    audio_bytes: 2, chunk_count: 1, frame_bytes: 2, tail_bytes: 2, sample_rate_hz: 24_000,
  })!;
  const outputAudio = projectRoundtripOutputAudioEvidence({
    provider: "openai", wire: observations,
    continuation_start_observation_sha256: observations[continuationStartIndex]!.observationSha256,
    terminal_observation_sha256: observations[terminalIndex]!.observationSha256,
    continuation_response_id_sha256: continuation,
  })!;
  const summary: RoundtripReplaySummary = {
    schema_version: 1,
    provider: "openai",
    model: "gpt-realtime-2.1",
    connection_epoch: 1,
    call: {
      observation_sha256: observations[callIndex]!.observationSha256,
      call_id_sha256: callId,
      response_id_sha256: origin,
    },
    result: { observation_sha256: observations[resultIndex]!.observationSha256, call_id_sha256: callId },
    continuation: {
      request_observation_sha256: observations[continuationRequestIndex]!.observationSha256,
      origin_response_id_sha256: origin,
      started_observation_sha256: observations[continuationStartIndex]!.observationSha256,
      response_id_sha256: continuation,
    },
    terminal: {
      observation_sha256: observations[terminalIndex]!.observationSha256,
      response_id_sha256: continuation,
      status: "completed",
    },
    usage: {
      evidence_sha256: roundtripSanitizedUsageSha256(usage),
      response_id_sha256: continuation,
    },
    input_audio: inputAudio,
    output_audio: outputAudio,
  };
  return {
    expected: { provider: "openai", model: "gpt-realtime-2.1" },
    summary,
    wire_observations: observations,
    sanitized_usage: [usage],
  };
}

function xaiPacket(): ProviderRoundtripReplayInput {
  const callId = realtimeWireIdentitySha256("call", "call-xai-1");
  const origin = realtimeWireIdentitySha256("response", "response-xai-origin");
  const continuation = realtimeWireIdentitySha256("response", "response-xai-continuation");
  const itemId = realtimeWireIdentitySha256("item", "item-xai-1");
  const completedCall = gatewayCall(callId, origin, itemId);
  const incompleteCall = {
    gateway: "capability_gateway",
    callIdSha256: callId,
    responseIdSha256: origin,
    itemIdSha256: itemId,
    argumentsSha256: sha256Hex(""),
    argumentsBytes: 0,
    argumentsJsonValid: false,
  };
  const responseOmittedIncompleteCall = Object.fromEntries(Object.entries(incompleteCall).filter(
    ([key]) => key !== "responseIdSha256",
  ));
  const observations = wire("xai", [
    {
      direction: "outbound",
      wireType: "input_audio_buffer.append",
      projection: {
        audio: {
          direction: "input",
          validCanonicalBase64: true,
          sha256: H("9"),
          byteLength: 48_000,
          format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        },
      },
    },
    { direction: "inbound", wireType: "input_audio_buffer.speech_started" },
    { direction: "inbound", wireType: "input_audio_buffer.speech_stopped" },
    { direction: "inbound", wireType: "input_audio_buffer.committed" },
    {
      direction: "inbound",
      wireType: "conversation.item.input_audio_transcription.completed",
      identities: { itemIdSha256: realtimeWireIdentitySha256("item", "input-xai-1") },
      projection: { terminal: { status: "completed" } },
    },
    { direction: "inbound", wireType: "response.created", identities: { responseIdSha256: origin } },
    {
      direction: "inbound",
      wireType: "response.audio.delta",
      identities: { responseIdSha256: origin },
      projection: {
        audio: {
          validCanonicalBase64: true,
          sha256: H("7"),
          byteLength: 24_000,
          format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        },
      },
    },
    {
      direction: "inbound",
      wireType: "response.output_item.added",
      identities: { callIdSha256: callId, responseIdSha256: origin, itemIdSha256: itemId },
      projection: { gatewayCalls: [incompleteCall] },
    },
    {
      direction: "inbound",
      wireType: "conversation.item.added",
      identities: { callIdSha256: callId, itemIdSha256: itemId },
      projection: { gatewayCalls: [responseOmittedIncompleteCall] },
    },
    {
      direction: "inbound",
      wireType: "response.function_call_arguments.done",
      identities: { callIdSha256: callId, responseIdSha256: origin, itemIdSha256: itemId },
      projection: { gatewayCalls: [completedCall] },
    },
    {
      direction: "inbound",
      wireType: "response.output_item.done",
      identities: { callIdSha256: callId, responseIdSha256: origin, itemIdSha256: itemId },
      projection: { gatewayCalls: [completedCall] },
    },
    {
      direction: "inbound",
      wireType: "response.done",
      identities: { callIdSha256: callId, responseIdSha256: origin, itemIdSha256: itemId },
      projection: {
        gatewayCalls: [completedCall],
        terminal: { status: "completed" },
      },
    },
    {
      direction: "outbound",
      wireType: "conversation.item.create",
      identities: { callIdSha256: callId },
      projection: { gatewayResults: [gatewayResult(callId)] },
    },
    { direction: "outbound", wireType: "response.create" },
    { direction: "inbound", wireType: "response.created", identities: { responseIdSha256: continuation } },
    {
      direction: "inbound",
      wireType: "response.audio.delta",
      identities: { responseIdSha256: continuation },
      projection: {
        audio: {
          validCanonicalBase64: true,
          sha256: H("8"),
          byteLength: 24_000,
          format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        },
      },
    },
    {
      direction: "inbound",
      wireType: "response.done",
      identities: { responseIdSha256: continuation },
      projection: { terminal: { status: "completed" } },
    },
  ]);
  const rootStart = observations.find((observation) => (
    observation.wireType === "response.created"
    && observation.identities.responseIdSha256 === origin
  ))!;
  const rootTerminal = observations.find((observation) => (
    observation.wireType === "response.done"
    && observation.identities.responseIdSha256 === origin
  ))!;
  const result = observations.find((observation) => (
    observation.wireType === "conversation.item.create"
  ))!;
  const continuationRequest = observations.find((observation) => (
    observation.wireType === "response.create"
  ))!;
  const continuationStart = observations.find((observation) => (
    observation.wireType === "response.created"
    && observation.identities.responseIdSha256 === continuation
  ))!;
  const continuationAudio = observations.find((observation) => (
    observation.wireType === "response.audio.delta"
    && observation.identities.responseIdSha256 === continuation
  ))!;
  const continuationTerminal = observations.find((observation) => (
    observation.wireType === "response.done"
    && observation.identities.responseIdSha256 === continuation
  ))!;
  const contributors = [continuationAudio.observationSha256];
  const usage: RoundtripSanitizedUsage = {
    schema_version: 1,
    source: "client_measured_wire_pcm",
    response_id_sha256: continuation,
    terminal_observation_sha256: continuationTerminal.observationSha256,
    provider_usage_observation_sha256: null,
    contributing_wire_observation_sha256s: contributors,
    counters: { inputAudioMinutes: 0, outputAudioMinutes: 1 / 120 },
  };
  const inputAudio = projectRoundtripInputAudioEvidence(observations, {
    chunk_sha256s: [H("9")], chunk_list_sha256: roundtripInputAudioChunkListSha256([H("9")]),
    audio_sha256: H("7"), delivery_profile_sha256: H("6"), packetizer_sha256: H("5"),
    audio_bytes: 48_000, chunk_count: 1, frame_bytes: 48_000, tail_bytes: 48_000,
    sample_rate_hz: 24_000,
  })!;
  const outputAudio = projectRoundtripOutputAudioEvidence({
    provider: "xai", wire: observations,
    continuation_start_observation_sha256: continuationStart.observationSha256,
    terminal_observation_sha256: continuationTerminal.observationSha256,
    continuation_response_id_sha256: continuation,
  })!;
  const preToolOutputQuarantine = projectRoundtripPreToolOutputQuarantineEvidence({
    provider: "xai",
    wire: observations,
    response_started_observation_sha256: rootStart.observationSha256,
    terminal_observation_sha256: rootTerminal.observationSha256,
    response_id_sha256: origin,
  })!;
  return {
    expected: { provider: "xai", model: "grok-voice-think-fast-1.0" },
    summary: {
      schema_version: 1,
      provider: "xai",
      model: "grok-voice-think-fast-1.0",
      connection_epoch: 1,
      call: {
        observation_sha256: rootTerminal.observationSha256,
        call_id_sha256: callId,
        response_id_sha256: origin,
      },
      result: { observation_sha256: result.observationSha256, call_id_sha256: callId },
      continuation: {
        request_observation_sha256: continuationRequest.observationSha256,
        origin_response_id_sha256: origin,
        started_observation_sha256: continuationStart.observationSha256,
        response_id_sha256: continuation,
      },
      terminal: {
        observation_sha256: continuationTerminal.observationSha256,
        response_id_sha256: continuation,
        status: "completed",
      },
      usage: {
        evidence_sha256: roundtripSanitizedUsageSha256(usage),
        response_id_sha256: continuation,
      },
      input_audio: inputAudio,
      output_audio: outputAudio,
      pre_tool_output_quarantine: preToolOutputQuarantine,
    },
    wire_observations: observations,
    sanitized_usage: [usage],
  };
}

function geminiPacket(
  withBinding = true,
  withPreToolOutput = false,
): ProviderRoundtripReplayInput {
  const callId = realtimeWireIdentitySha256("call", "call-gemini-1");
  const initialResponse = realtimeWireIdentitySha256("response", "gemini-local-response-1-1");
  const continuationResponse = realtimeWireIdentitySha256("response", "gemini-local-response-1-2");
  const preToolOutputSeeds: WireSeed[] = withPreToolOutput ? [
    {
      direction: "inbound",
      wireType: "serverContent",
      projection: {
        text: [{
          kind: "input_transcript",
          sha256: sha256Hex("Please complete the current stage."),
          byteLength: Buffer.byteLength("Please complete the current stage.", "utf8"),
        }],
      },
    },
    {
      direction: "inbound",
      wireType: "serverContent",
      projection: { terminal: { status: "completed" } },
    },
    {
      direction: "inbound",
      wireType: "serverContent",
      projection: {
        audio: {
          direction: "output",
          chunks: [{
            validCanonicalBase64: true,
            sha256: H("7"),
            byteLength: 2,
            format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
          }],
        },
      },
    },
    {
      direction: "inbound",
      wireType: "serverContent",
      projection: {
        text: [{
          kind: "output_transcript",
          sha256: sha256Hex("I will complete that now."),
          byteLength: Buffer.byteLength("I will complete that now.", "utf8"),
        }],
      },
    },
  ] : [];
  const observations = wire("gemini", [
    {
      direction: "outbound",
      wireType: "realtimeInput.audio",
      projection: {
        audio: {
          direction: "input",
          chunks: [{
            validCanonicalBase64: true, sha256: H("9"), byteLength: 2,
            format: { encoding: "pcm16", sampleRateHz: 16_000, channels: 1 },
          }],
        },
      },
    },
    {
      direction: "outbound",
      wireType: "realtimeInput.activityEnd",
      projection: { audio: { direction: "input", activity: "end" } },
    },
    ...preToolOutputSeeds,
    {
      direction: "inbound",
      wireType: "toolCall",
      identities: { callIdSha256: callId },
      projection: { gatewayCalls: [gatewayCall(callId)] },
    },
    {
      direction: "outbound",
      wireType: "toolResponse",
      identities: { callIdSha256: callId },
      projection: { gatewayResults: [gatewayResult(callId)] },
    },
    {
      direction: "inbound",
      wireType: "serverContent",
      projection: {
        audio: {
          direction: "output",
          chunks: [{
            validCanonicalBase64: true,
            sha256: H("8"),
            byteLength: 24_000,
            format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
          }],
        },
      },
    },
    {
      direction: "inbound",
      wireType: "mixedServerMessage",
      projection: { terminal: { status: "completed" }, usage: { totalTokens: 12 } },
    },
  ]);
  const callIndex = 2 + preToolOutputSeeds.length;
  const resultIndex = callIndex + 1;
  const continuationStartIndex = callIndex + 2;
  const terminalIndex = callIndex + 3;
  const usage = providerReportedUsage(
    continuationResponse,
    observations[terminalIndex]!,
    { totalTokens: 12 },
  );
  const inputAudio = projectRoundtripInputAudioEvidence(observations, {
    chunk_sha256s: [H("9")], chunk_list_sha256: roundtripInputAudioChunkListSha256([H("9")]),
    audio_sha256: H("7"), delivery_profile_sha256: H("6"), packetizer_sha256: H("5"),
    audio_bytes: 2, chunk_count: 1, frame_bytes: 2, tail_bytes: 2, sample_rate_hz: 16_000,
  })!;
  const outputAudio = projectRoundtripOutputAudioEvidence({
    provider: "gemini", wire: observations,
    continuation_start_observation_sha256: observations[continuationStartIndex]!.observationSha256,
    terminal_observation_sha256: observations[terminalIndex]!.observationSha256,
    continuation_response_id_sha256: continuationResponse,
  })!;
  const summary: RoundtripReplaySummary = {
    schema_version: 1,
    provider: "gemini",
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    connection_epoch: 1,
    call: {
      observation_sha256: observations[callIndex]!.observationSha256,
      call_id_sha256: callId,
      response_id_sha256: initialResponse,
    },
    result: { observation_sha256: observations[resultIndex]!.observationSha256, call_id_sha256: callId },
    continuation: {
      request_observation_sha256: observations[resultIndex]!.observationSha256,
      origin_response_id_sha256: initialResponse,
      started_observation_sha256: observations[continuationStartIndex]!.observationSha256,
      response_id_sha256: continuationResponse,
    },
    terminal: {
      observation_sha256: observations[terminalIndex]!.observationSha256,
      response_id_sha256: continuationResponse,
      status: "completed",
    },
    usage: {
      evidence_sha256: roundtripSanitizedUsageSha256(usage),
      response_id_sha256: continuationResponse,
    },
    input_audio: inputAudio,
    output_audio: outputAudio,
    ...(withPreToolOutput ? {
      pre_tool_output_quarantine: projectRoundtripPreToolOutputQuarantineEvidence({
        provider: "gemini",
        wire: observations,
        response_id_sha256: initialResponse,
        response_started_observation_sha256: observations[1]!.observationSha256,
        terminal_observation_sha256: observations[callIndex]!.observationSha256,
      })!,
    } : {}),
  };
  const bindingBody: Omit<RoundtripCausalBinding, "evidence_sha256"> = {
    schema_version: 1,
    provider: "gemini",
    response_id_source: "client_local",
    connection_epoch: 1,
    input_turn: 1,
    trigger_observation_sha256: observations[1]!.observationSha256,
    initial_response_id_sha256: initialResponse,
    call_id_sha256: callId,
    call_response_id_sha256: initialResponse,
    call_observation_sha256: observations[callIndex]!.observationSha256,
    result_observation_sha256: observations[resultIndex]!.observationSha256,
    continuation_request_observation_sha256: observations[resultIndex]!.observationSha256,
    continuation_response_id_sha256: continuationResponse,
    continuation_start_observation_sha256: observations[continuationStartIndex]!.observationSha256,
    terminal_observation_sha256: observations[terminalIndex]!.observationSha256,
    usage_observation_sha256: observations[terminalIndex]!.observationSha256,
    usage_response_id_sha256: continuationResponse,
  };
  return {
    expected: { provider: "gemini", model: summary.model },
    summary,
    wire_observations: observations,
    sanitized_usage: [usage],
    ...(withBinding ? {
      causal_binding: {
        ...bindingBody,
        evidence_sha256: roundtripCausalBindingSha256(bindingBody),
      },
    } : {}),
  };
}

describe("provider tool roundtrip offline replay", () => {
  it.each([
    ["OpenAI", openAiPacket],
    ["xAI", xaiPacket],
    ["Gemini", geminiPacket],
  ])("verifies a complete %s real-wire-shaped call/result/continuation/terminal/usage chain", (_, build) => {
    const input = build();
    const result = replayProviderToolRoundtrip(input);
    expect(result).toMatchObject({
      schema_version: 3,
      replay_version: "HACC-PROVIDER-ROUNDTRIP-REPLAY-v3",
      valid: true,
      errors: [],
      public_execution_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      replay_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.public_execution).toMatchObject({
      schema_version: 3,
      replay_version: "HACC-PROVIDER-ROUNDTRIP-REPLAY-v3",
      provider: input.summary.provider,
      connection_epoch: 1,
      call_id_sha256: input.summary.call.call_id_sha256,
      terminal_observation_sha256: input.summary.terminal.observation_sha256,
      gateway_target_tool_name_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      gateway_target_arguments_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      gateway_qualification_result_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      gateway_semantic_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      input_audio_observation_list_sha256: input.summary.input_audio.observation_list_sha256,
      output_audio_content_sha256: input.summary.output_audio.content_sha256,
    });
  });

  it("is deterministic and exposes no raw model or provider-native identifiers", () => {
    const input = openAiPacket();
    const first = replayProviderToolRoundtrip(input);
    const second = replayProviderToolRoundtrip(structuredClone(input));
    expect(second).toEqual(first);
    const publicJson = JSON.stringify(first.public_execution);
    expect(publicJson).not.toContain(input.summary.model);
    expect(publicJson).not.toContain("call-openai-1");
    expect(publicJson).not.toContain("response-openai-continuation");
  });

  it("binds xAI pre-tool audio as suppressed root-response quarantine, never playable output", () => {
    const input = xaiPacket();
    const replay = replayProviderToolRoundtrip(input);
    expect(input.summary.pre_tool_output_quarantine).toMatchObject({
      disposition: "suppressed_never_caller_playable",
      audio_bytes: 24_000,
      audio_chunk_count: 1,
      released_audio_bytes: 0,
      response_id_sha256: input.summary.call.response_id_sha256,
    });
    expect(replay.public_execution).toMatchObject({
      pre_tool_quarantine_audio_bytes: 24_000,
      pre_tool_quarantine_released_audio_bytes: 0,
      output_audio_bytes: 24_000,
    });
    expect(replay.public_execution?.pre_tool_quarantine_evidence_sha256)
      .toBe(input.summary.pre_tool_output_quarantine?.evidence_sha256);
  });

  it("binds Gemini pre-tool audio and output transcript to the exact activity-end/tool-call window", () => {
    const input = geminiPacket(true, true);
    const replay = replayProviderToolRoundtrip(input);
    const quarantine = input.summary.pre_tool_output_quarantine;

    expect(replay.valid).toBe(true);
    expect(replay.errors).toEqual([]);
    expect(quarantine).toMatchObject({
      disposition: "suppressed_never_caller_playable",
      response_started_observation_sha256:
        input.causal_binding?.trigger_observation_sha256,
      terminal_observation_sha256: input.summary.call.observation_sha256,
      response_id_sha256: input.summary.call.response_id_sha256,
      audio_bytes: 2,
      audio_chunk_count: 1,
      released_audio_bytes: 0,
    });
    expect(quarantine?.observation_sha256s).toHaveLength(2);
    expect(replay.public_execution).toMatchObject({
      pre_tool_quarantine_audio_bytes: 2,
      pre_tool_quarantine_released_audio_bytes: 0,
      pre_tool_quarantine_evidence_sha256: quarantine?.evidence_sha256,
    });

    const retainedKinds = input.wire_observations
      .filter((observation) => quarantine?.observation_sha256s.includes(
        observation.observationSha256,
      ))
      .flatMap((observation) => Array.isArray(observation.projection.text)
        ? observation.projection.text
        : [])
      .flatMap((entry) => typeof entry === "object" && entry !== null && "kind" in entry
        ? [entry.kind]
        : []);
    expect(retainedKinds).toEqual(["output_transcript"]);
  });

  it("rejects a missing or caller-released Gemini quarantine receipt", () => {
    const input = geminiPacket(true, true);
    const quarantine = input.summary.pre_tool_output_quarantine!;
    const withoutQuarantine = { ...input.summary };
    Reflect.deleteProperty(withoutQuarantine, "pre_tool_output_quarantine");

    const missing = replayProviderToolRoundtrip({
      ...input,
      summary: withoutQuarantine,
    });
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain("gemini_pre_tool_quarantine_missing");

    const released = replayProviderToolRoundtrip({
      ...input,
      summary: {
        ...input.summary,
        pre_tool_output_quarantine: {
          ...quarantine,
          released_audio_bytes: 1 as 0,
        },
      },
    });
    expect(released.valid).toBe(false);
    expect(released.errors).toContain("pre_tool_quarantine_contract_invalid");
    expect(released.public_execution).toBeNull();
  });

  it("refuses to project reordered or tool-call-frame-only Gemini audio", () => {
    const input = geminiPacket(true, true);
    const originalSeeds = seeds(input.wire_observations);
    const audioSeedIndex = originalSeeds.findIndex((seed, index) => (
      index > 1
      && typeof seed.projection?.audio === "object"
      && seed.projection.audio !== null
      && !Array.isArray(seed.projection.audio)
      && "direction" in seed.projection.audio
      && seed.projection.audio.direction === "output"
    ));
    const outputTranscriptIndex = originalSeeds.findIndex((seed) => (
      Array.isArray(seed.projection?.text)
      && seed.projection.text.some((entry) => (
        typeof entry === "object" && entry !== null
        && "kind" in entry && entry.kind === "output_transcript"
      ))
    ));
    const preToolAudio = originalSeeds[audioSeedIndex]!;

    const terminalOnlySeeds = originalSeeds
      .filter((_, index) => index !== audioSeedIndex && index !== outputTranscriptIndex)
      .map((seed) => seed.wireType === "toolCall"
        ? {
            ...seed,
            projection: {
              ...seed.projection,
              audio: preToolAudio.projection?.audio,
            },
          }
        : seed);
    const terminalOnlyWire = wire("gemini", terminalOnlySeeds);
    const terminalOnlyCallIndex = terminalOnlyWire.findIndex((observation) => (
      observation.wireType === "toolCall"
    ));
    expect(projectRoundtripPreToolOutputQuarantineEvidence({
      provider: "gemini",
      wire: terminalOnlyWire,
      response_id_sha256: input.summary.call.response_id_sha256,
      response_started_observation_sha256: terminalOnlyWire[1]!.observationSha256,
      terminal_observation_sha256: terminalOnlyWire[terminalOnlyCallIndex]!.observationSha256,
    })).toBeNull();

    const reorderedSeeds = originalSeeds.filter((_, index) => index !== audioSeedIndex);
    const reorderedCallIndex = reorderedSeeds.findIndex((seed) => seed.wireType === "toolCall");
    reorderedSeeds.splice(reorderedCallIndex + 1, 0, preToolAudio);
    const reorderedWire = wire("gemini", reorderedSeeds);
    const reorderedTerminalIndex = reorderedWire.findIndex((observation) => (
      observation.wireType === "toolCall"
    ));
    expect(projectRoundtripPreToolOutputQuarantineEvidence({
      provider: "gemini",
      wire: reorderedWire,
      response_id_sha256: input.summary.call.response_id_sha256,
      response_started_observation_sha256: reorderedWire[1]!.observationSha256,
      terminal_observation_sha256: reorderedWire[reorderedTerminalIndex]!.observationSha256,
    })).toBeNull();
  });

  it("keeps OpenAI on the fail-before-tool policy when a quarantine is injected", () => {
    const openai = openAiPacket();
    const gemini = geminiPacket(true, true);
    const replay = replayProviderToolRoundtrip({
      ...openai,
      summary: {
        ...openai.summary,
        pre_tool_output_quarantine: gemini.summary.pre_tool_output_quarantine,
      },
    });

    expect(replay.valid).toBe(false);
    expect(replay.errors).toContain("provider_pre_tool_quarantine_forbidden");
  });

  it("replays the retained xAI lifecycle shape with an independent transcript terminal and implicit audio direction", () => {
    const input = xaiPacket();
    const replay = replayProviderToolRoundtrip(input);
    const transcriptTerminal = input.wire_observations.find((observation) => (
      observation.wireType === "conversation.item.input_audio_transcription.completed"
    ));
    const continuationAudio = input.wire_observations.find((observation) => (
      observation.observationSha256 === input.summary.output_audio.observation_sha256s[0]
    ));
    const acceptedCall = input.wire_observations.find((observation) => (
      observation.observationSha256 === input.summary.call.observation_sha256
    ));

    expect(replay.valid).toBe(true);
    expect(transcriptTerminal?.projection.terminal).toEqual({ status: "completed" });
    expect(transcriptTerminal?.identities.responseIdSha256).toBeUndefined();
    expect(continuationAudio?.projection.audio).not.toHaveProperty("direction");
    expect(acceptedCall?.wireType).toBe("response.done");
    expect(input.wire_observations.filter((observation) => (
      Array.isArray(observation.projection.gatewayCalls)
    ))).toHaveLength(5);
  });

  it("rejects a transcript terminal falsely rebound to a model response", () => {
    const input = xaiPacket();
    const replay = replayProviderToolRoundtrip(append(input, {
      direction: "inbound",
      wireType: "conversation.item.input_audio_transcription.completed",
      identities: { responseIdSha256: input.summary.terminal.response_id_sha256 },
      projection: { terminal: { status: "completed" } },
    }));

    expect(replay.valid).toBe(false);
    expect(replay.errors).toContain("transcript_terminal_response_binding_invalid");
  });

  it("rejects a claimed xAI quarantine release or a missing quarantine receipt", () => {
    const input = xaiPacket();
    const quarantine = input.summary.pre_tool_output_quarantine!;
    const released = replayProviderToolRoundtrip({
      ...input,
      summary: {
        ...input.summary,
        pre_tool_output_quarantine: {
          ...quarantine,
          released_audio_bytes: 1 as 0,
        },
      },
    });
    expect(released.valid).toBe(false);
    expect(released.errors).toContain("pre_tool_quarantine_contract_invalid");
    const withoutQuarantine = { ...input.summary };
    Reflect.deleteProperty(withoutQuarantine, "pre_tool_output_quarantine");
    const missing = replayProviderToolRoundtrip({ ...input, summary: withoutQuarantine });
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain("xai_pre_tool_quarantine_missing");
  });

  it("rejects root audio that is omitted from or rebound outside the xAI quarantine", () => {
    const input = xaiPacket();
    const nextSeeds = seeds(input.wire_observations);
    nextSeeds[5] = {
      ...nextSeeds[5]!,
      identities: { responseIdSha256: input.summary.continuation.response_id_sha256 },
    };
    const replay = replayProviderToolRoundtrip(withRebuiltWire(input, nextSeeds));
    expect(replay.valid).toBe(false);
    expect(replay.errors).toContain("pre_tool_quarantine_replay_mismatch");
  });

  it("rejects quarantined root audio included in xAI continuation-scoped usage", () => {
    const input = xaiPacket();
    const contaminatedUsage: RoundtripSanitizedUsage = {
      ...input.sanitized_usage[0]!,
      contributing_wire_observation_sha256s: [
        input.summary.pre_tool_output_quarantine!.observation_sha256s[0]!,
        input.summary.output_audio.observation_sha256s[0]!,
      ],
      counters: { inputAudioMinutes: 0, outputAudioMinutes: 1 / 60 },
    };
    const replay = replayProviderToolRoundtrip({
      ...input,
      summary: {
        ...input.summary,
        usage: {
          ...input.summary.usage,
          evidence_sha256: roundtripSanitizedUsageSha256(contaminatedUsage),
        },
      },
      sanitized_usage: [contaminatedUsage],
    });
    expect(replay.valid).toBe(false);
    expect(replay.errors).toContain("client_measured_usage_contributors_mismatch");
    expect(replay.errors).toContain("client_measured_usage_counters_mismatch");
  });

  it("deduplicates one OpenAI call across its full six-frame lifecycle", () => {
    const input = openAiPacket({ multiFrameCall: true });
    const replay = replayProviderToolRoundtrip(input);

    expect(replay.valid).toBe(true);
    expect(replay.errors).toEqual([]);
    expect(input.wire_observations.filter((observation) => (
      Array.isArray(observation.projection.gatewayCalls)
    ))).toHaveLength(6);
    expect(input.wire_observations.filter((observation) => (
      observation.projection.usage !== undefined
    ))).toHaveLength(2);
    expect(input.sanitized_usage).toHaveLength(1);
    expect(replay.public_execution?.call_observation_sha256)
      .toBe(input.summary.call.observation_sha256);
    expect(input.wire_observations.find((observation) => (
      observation.observationSha256 === input.summary.call.observation_sha256
    ))?.wireType).toBe("response.done");
  });

  it("rejects a mutated terminal projection of a repeated OpenAI call", () => {
    const replay = replayProviderToolRoundtrip(openAiPacket({
      multiFrameCall: true,
      conflictingTerminalProjection: true,
    }));

    expect(replay.valid).toBe(false);
    expect(replay.errors).toContain("gateway_call_projection_conflict");
  });

  it.each([
    [
      "gateway target",
      3,
      "gatewayCalls",
      "targetToolNameSha256",
      "gateway_target_tool_name_semantic_mismatch",
    ],
    [
      "empty target arguments",
      3,
      "gatewayCalls",
      "targetArgumentsSha256",
      "gateway_target_arguments_semantic_mismatch",
    ],
    [
      "qualification result",
      4,
      "gatewayResults",
      "resultSha256",
      "gateway_qualification_result_semantic_mismatch",
    ],
  ] as const)("rejects an independently mutated %s semantic hash", (
    _,
    observationIndex,
    projectionKey,
    semanticHashKey,
    expectedError,
  ) => {
    const input = openAiPacket();
    const nextSeeds = seeds(input.wire_observations);
    const seed = nextSeeds[observationIndex]!;
    const projection = structuredClone(seed.projection ?? {});
    const entries = projection[projectionKey];
    if (!Array.isArray(entries) || typeof entries[0] !== "object" || entries[0] === null) {
      throw new Error("semantic fixture projection is missing");
    }
    entries[0] = { ...entries[0], [semanticHashKey]: H("f") };
    nextSeeds[observationIndex] = { ...seed, projection };

    const result = replayProviderToolRoundtrip(withRebuiltWire(input, nextSeeds));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(expectedError);
  });

  it.each([
    [3, "gatewayCalls", "argumentsJsonValid", "gateway_arguments_json_invalid"],
    [4, "gatewayResults", "resultJsonValid", "gateway_result_json_invalid"],
  ] as const)("rejects a false %s JSON-validity projection", (
    observationIndex,
    projectionKey,
    validityKey,
    expectedError,
  ) => {
    const input = openAiPacket();
    const nextSeeds = seeds(input.wire_observations);
    const seed = nextSeeds[observationIndex]!;
    const projection = structuredClone(seed.projection ?? {});
    const entries = projection[projectionKey];
    if (!Array.isArray(entries) || typeof entries[0] !== "object" || entries[0] === null) {
      throw new Error("JSON-validity fixture projection is missing");
    }
    entries[0] = { ...entries[0], [validityKey]: false };
    nextSeeds[observationIndex] = { ...seed, projection };

    const result = replayProviderToolRoundtrip(withRebuiltWire(input, nextSeeds));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(expectedError);
  });

  it("rejects a mismatched call/result ID", () => {
    const input = openAiPacket();
    const result = replayProviderToolRoundtrip({
      ...input,
      summary: { ...input.summary, result: { ...input.summary.result, call_id_sha256: H("f") } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("call_result_id_mismatch");
  });

  it("rejects expected provider/model drift before evidence admission", () => {
    const input = openAiPacket();
    expect(replayProviderToolRoundtrip({
      ...input,
      expected: { ...input.expected, model: "gpt-realtime-unregistered" },
    }).errors).toContain("model_mismatch_or_invalid");
    expect(replayProviderToolRoundtrip({
      ...input,
      expected: { ...input.expected, provider: "xai" },
    }).errors).toContain("provider_mismatch");
  });

  it("rejects missing and reordered causal events", () => {
    const input = openAiPacket();
    const original = seeds(input.wire_observations);
    const missing = withRebuiltWire(input, original.filter((_, index) => index !== 3));
    const reordered = withRebuiltWire(input, [
      ...original.slice(0, 2), original[3]!, original[2]!, ...original.slice(4),
    ]);
    expect(replayProviderToolRoundtrip(missing).valid).toBe(false);
    expect(replayProviderToolRoundtrip(reordered).valid).toBe(false);
  });

  it("rejects a partial preregistered input append set", () => {
    const input = openAiPacket();
    const partial = withRebuiltWire(input, seeds(input.wire_observations).slice(1));
    const replay = replayProviderToolRoundtrip(partial);
    expect(replay.valid).toBe(false);
    expect(replay.errors).toContain("input_audio_delivery_replay_mismatch");
  });

  it("rejects same-length input PCM with a different per-chunk content hash", () => {
    const input = openAiPacket();
    const nextSeeds = seeds(input.wire_observations);
    const first = nextSeeds[0]!;
    const projection = structuredClone(first.projection ?? {});
    const audio = projection.audio;
    if (typeof audio !== "object" || audio === null || Array.isArray(audio)) {
      throw new Error("input PCM fixture projection is missing");
    }
    nextSeeds[0] = { ...first, projection: { ...projection, audio: { ...audio, sha256: H("f") } } };
    const replay = replayProviderToolRoundtrip(withRebuiltWire(input, nextSeeds));
    expect(replay.valid).toBe(false);
    expect(replay.errors).toContain("input_audio_delivery_replay_mismatch");
  });

  it.each([
    {
      id: "removed",
      mutate: (original: WireSeed[]) => original.filter((_, index) => index !== 7),
    },
    {
      id: "text-only",
      mutate: (original: WireSeed[]) => original.map((seed, index) => index === 7
        ? { ...seed, projection: { text: [{ kind: "transcript", sha256: H("f"), byteLength: 2 }] } }
        : seed),
    },
    {
      id: "bound to the wrong response",
      mutate: (original: WireSeed[]) => original.map((seed, index) => index === 7
        ? { ...seed, identities: { responseIdSha256: H("f") } }
        : seed),
    },
    {
      id: "ordered after the terminal",
      mutate: (original: WireSeed[]) => [
        ...original.slice(0, 7), original[8]!, original[7]!,
      ],
    },
  ])("rejects $id continuation output PCM", ({ mutate }) => {
    const input = openAiPacket();
    const replay = replayProviderToolRoundtrip(withRebuiltWire(
      input,
      mutate(seeds(input.wire_observations)),
    ));
    expect(replay.valid).toBe(false);
    expect(replay.errors).toContain("output_audio_continuation_replay_mismatch");
  });

  it("rejects unrelated or duplicate terminal frames", () => {
    const input = openAiPacket();
    const unrelated = append(input, {
      direction: "inbound",
      wireType: "response.done",
      identities: { responseIdSha256: H("e") },
      projection: { terminal: { status: "completed" } },
    });
    expect(replayProviderToolRoundtrip(unrelated).errors).toContain("unrelated_terminal_retained");

    const duplicate = append(input, {
      direction: "inbound",
      wireType: "response.done",
      identities: { responseIdSha256: input.summary.terminal.response_id_sha256 },
      projection: { terminal: { status: "completed" } },
    });
    expect(replayProviderToolRoundtrip(duplicate).errors)
      .toContain("final_terminal_count_or_binding_invalid");
  });

  it("rejects unrelated usage and counter disagreement", () => {
    const input = openAiPacket();
    const unrelatedWire = append(input, {
      direction: "inbound",
      wireType: "response.done",
      identities: { responseIdSha256: H("e") },
      projection: { usage: { totalTokens: 3 } },
    });
    expect(replayProviderToolRoundtrip(unrelatedWire).valid).toBe(false);

    const badUsage: RoundtripSanitizedUsage = {
      ...input.sanitized_usage[0]!,
      counters: { totalTokens: 999 },
    };
    const result = replayProviderToolRoundtrip({
      ...input,
      sanitized_usage: [badUsage],
      summary: {
        ...input.summary,
        usage: {
          ...input.summary.usage,
          evidence_sha256: roundtripSanitizedUsageSha256(badUsage),
        },
      },
    });
    expect(result.errors).toContain("provider_usage_projection_mismatch");

    const duplicateUsage = replayProviderToolRoundtrip({
      ...input,
      sanitized_usage: [input.sanitized_usage[0]!, input.sanitized_usage[0]!],
    });
    expect(duplicateUsage.errors).toContain("duplicate_sanitized_usage");
    expect(duplicateUsage.errors).toContain("duplicate_usage_for_response");
  });

  it("rejects any reconnect or epoch-two observation", () => {
    const input = append(openAiPacket(), {
      direction: "inbound",
      wireType: "session.created",
      connectionEpoch: 2,
    });
    expect(replayProviderToolRoundtrip(input).errors).toContain("wire_reconnect_or_nonfirst_epoch");
  });

  it("rejects duplicate calls, results, and continuation requests", () => {
    const input = openAiPacket();
    const duplicateCall = append(input, {
      direction: "inbound",
      wireType: "response.function_call_arguments.done",
      identities: {
        callIdSha256: input.summary.call.call_id_sha256,
        responseIdSha256: input.summary.call.response_id_sha256,
      },
      projection: { gatewayCalls: [gatewayCall(
        input.summary.call.call_id_sha256,
        input.summary.call.response_id_sha256,
      )] },
    });
    expect(replayProviderToolRoundtrip(duplicateCall).errors)
      .toContain("gateway_call_count_not_exactly_one");

    const duplicateResult = append(input, {
      direction: "outbound",
      wireType: "conversation.item.create",
      identities: { callIdSha256: input.summary.call.call_id_sha256 },
      projection: { gatewayResults: [gatewayResult(input.summary.call.call_id_sha256)] },
    });
    expect(replayProviderToolRoundtrip(duplicateResult).errors)
      .toContain("gateway_result_count_not_exactly_one");

    const duplicatedRequestSeeds = seeds(input.wire_observations);
    duplicatedRequestSeeds.splice(5, 0, { direction: "outbound", wireType: "response.create" });
    expect(replayProviderToolRoundtrip(withRebuiltWire(input, duplicatedRequestSeeds)).errors)
      .toContain("continuation_request_count_or_binding_invalid");
  });

  it("fails Gemini closed without its exact local turn/response causal artifact", () => {
    const result = replayProviderToolRoundtrip(geminiPacket(false));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("gemini_exact_local_causal_binding_missing");
  });

  it("rejects a forged Gemini causal binding self-hash or response join", () => {
    const input = geminiPacket();
    const forgedHash = replayProviderToolRoundtrip({
      ...input,
      causal_binding: { ...input.causal_binding!, evidence_sha256: H("f") },
    });
    expect(forgedHash.errors).toContain("causal_binding_evidence_sha256_mismatch");

    const body = {
      ...input.causal_binding!,
      continuation_response_id_sha256: H("e"),
    };
    const unsealed = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "evidence_sha256"),
    ) as Omit<RoundtripCausalBinding, "evidence_sha256">;
    const forgedJoin = replayProviderToolRoundtrip({
      ...input,
      causal_binding: {
        ...unsealed,
        evidence_sha256: roundtripCausalBindingSha256(unsealed),
      },
    });
    expect(forgedJoin.errors).toContain("causal_binding_response_mismatch");
  });

  it("rejects a broken redacted wire hash chain", () => {
    const input = openAiPacket();
    const corrupted = [...input.wire_observations];
    corrupted[3] = { ...corrupted[3]!, previousObservationSha256: H("0") };
    const result = replayProviderToolRoundtrip({ ...input, wire_observations: corrupted });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("wire_chain_invalid");
  });
});
