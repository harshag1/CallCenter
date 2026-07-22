import { describe, expect, it } from "vitest";
import {
  replayProviderToolRoundtrip,
  roundtripCausalBindingSha256,
  roundtripSanitizedUsageSha256,
  type ProviderRoundtripReplayInput,
  type RoundtripCausalBinding,
  type RoundtripReplaySummary,
  type RoundtripSanitizedUsage,
} from "../provider-roundtrip-replay";
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

function gatewayCall(callId: string, responseId?: string) {
  return {
    gateway: "capability_gateway",
    callIdSha256: callId,
    ...(responseId ? { responseIdSha256: responseId } : {}),
    argumentsSha256: H("a"),
    argumentsBytes: 67,
    targetToolNameSha256: H("b"),
    targetArgumentsSha256: H("c"),
  };
}

function gatewayResult(callId: string) {
  return {
    gateway: "capability_gateway",
    callIdSha256: callId,
    resultSha256: H("d"),
    resultBytes: 49,
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

function openAiPacket(): ProviderRoundtripReplayInput {
  const callId = realtimeWireIdentitySha256("call", "call-openai-1");
  const origin = realtimeWireIdentitySha256("response", "response-openai-origin");
  const continuation = realtimeWireIdentitySha256("response", "response-openai-continuation");
  const observations = wire("openai", [
    { direction: "outbound", wireType: "response.create", projection: { dynamicControl: { sha256: H("1") } } },
    { direction: "inbound", wireType: "response.created", identities: { responseIdSha256: origin } },
    {
      direction: "inbound",
      wireType: "response.function_call_arguments.done",
      identities: { callIdSha256: callId, responseIdSha256: origin },
      projection: { gatewayCalls: [gatewayCall(callId, origin)] },
    },
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
  const usage = providerReportedUsage(continuation, observations[7]!, { totalTokens: 8 });
  const summary: RoundtripReplaySummary = {
    schema_version: 1,
    provider: "openai",
    model: "gpt-realtime-2.1",
    connection_epoch: 1,
    call: {
      observation_sha256: observations[2]!.observationSha256,
      call_id_sha256: callId,
      response_id_sha256: origin,
    },
    result: { observation_sha256: observations[3]!.observationSha256, call_id_sha256: callId },
    continuation: {
      request_observation_sha256: observations[4]!.observationSha256,
      origin_response_id_sha256: origin,
      started_observation_sha256: observations[5]!.observationSha256,
      response_id_sha256: continuation,
    },
    terminal: {
      observation_sha256: observations[7]!.observationSha256,
      response_id_sha256: continuation,
      status: "completed",
    },
    usage: {
      evidence_sha256: roundtripSanitizedUsageSha256(usage),
      response_id_sha256: continuation,
    },
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
  const observations = wire("xai", [
    {
      direction: "outbound",
      wireType: "input_audio_buffer.append",
      projection: {
        audio: {
          direction: "input",
          validCanonicalBase64: true,
          byteLength: 48_000,
          format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        },
      },
    },
    { direction: "inbound", wireType: "input_audio_buffer.speech_started" },
    { direction: "inbound", wireType: "input_audio_buffer.speech_stopped" },
    { direction: "inbound", wireType: "input_audio_buffer.committed" },
    { direction: "inbound", wireType: "response.created", identities: { responseIdSha256: origin } },
    {
      direction: "inbound",
      wireType: "response.function_call_arguments.done",
      identities: { callIdSha256: callId, responseIdSha256: origin },
      projection: { gatewayCalls: [gatewayCall(callId, origin)] },
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
          direction: "output",
          validCanonicalBase64: true,
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
  const contributors = [observations[0]!.observationSha256, observations[9]!.observationSha256];
  const usage: RoundtripSanitizedUsage = {
    schema_version: 1,
    source: "client_measured_wire_pcm",
    response_id_sha256: continuation,
    terminal_observation_sha256: observations[10]!.observationSha256,
    provider_usage_observation_sha256: null,
    contributing_wire_observation_sha256s: contributors,
    counters: { inputAudioMinutes: 1 / 60, outputAudioMinutes: 1 / 120 },
  };
  return {
    expected: { provider: "xai", model: "grok-voice-think-fast-1.0" },
    summary: {
      schema_version: 1,
      provider: "xai",
      model: "grok-voice-think-fast-1.0",
      connection_epoch: 1,
      call: {
        observation_sha256: observations[5]!.observationSha256,
        call_id_sha256: callId,
        response_id_sha256: origin,
      },
      result: { observation_sha256: observations[6]!.observationSha256, call_id_sha256: callId },
      continuation: {
        request_observation_sha256: observations[7]!.observationSha256,
        origin_response_id_sha256: origin,
        started_observation_sha256: observations[8]!.observationSha256,
        response_id_sha256: continuation,
      },
      terminal: {
        observation_sha256: observations[10]!.observationSha256,
        response_id_sha256: continuation,
        status: "completed",
      },
      usage: {
        evidence_sha256: roundtripSanitizedUsageSha256(usage),
        response_id_sha256: continuation,
      },
    },
    wire_observations: observations,
    sanitized_usage: [usage],
  };
}

function geminiPacket(withBinding = true): ProviderRoundtripReplayInput {
  const callId = realtimeWireIdentitySha256("call", "call-gemini-1");
  const initialResponse = realtimeWireIdentitySha256("response", "gemini-local-response-1-1");
  const continuationResponse = realtimeWireIdentitySha256("response", "gemini-local-response-1-2");
  const observations = wire("gemini", [
    {
      direction: "outbound",
      wireType: "realtimeInput.activityEnd",
      projection: { audio: { direction: "input", activity: "end" } },
    },
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
  const usage = providerReportedUsage(continuationResponse, observations[4]!, { totalTokens: 12 });
  const summary: RoundtripReplaySummary = {
    schema_version: 1,
    provider: "gemini",
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    connection_epoch: 1,
    call: {
      observation_sha256: observations[1]!.observationSha256,
      call_id_sha256: callId,
      response_id_sha256: initialResponse,
    },
    result: { observation_sha256: observations[2]!.observationSha256, call_id_sha256: callId },
    continuation: {
      request_observation_sha256: observations[2]!.observationSha256,
      origin_response_id_sha256: initialResponse,
      started_observation_sha256: observations[3]!.observationSha256,
      response_id_sha256: continuationResponse,
    },
    terminal: {
      observation_sha256: observations[4]!.observationSha256,
      response_id_sha256: continuationResponse,
      status: "completed",
    },
    usage: {
      evidence_sha256: roundtripSanitizedUsageSha256(usage),
      response_id_sha256: continuationResponse,
    },
  };
  const bindingBody: Omit<RoundtripCausalBinding, "evidence_sha256"> = {
    schema_version: 1,
    provider: "gemini",
    response_id_source: "client_local",
    connection_epoch: 1,
    input_turn: 1,
    trigger_observation_sha256: observations[0]!.observationSha256,
    initial_response_id_sha256: initialResponse,
    call_id_sha256: callId,
    call_response_id_sha256: initialResponse,
    call_observation_sha256: observations[1]!.observationSha256,
    result_observation_sha256: observations[2]!.observationSha256,
    continuation_request_observation_sha256: observations[2]!.observationSha256,
    continuation_response_id_sha256: continuationResponse,
    continuation_start_observation_sha256: observations[3]!.observationSha256,
    terminal_observation_sha256: observations[4]!.observationSha256,
    usage_observation_sha256: observations[4]!.observationSha256,
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
      valid: true,
      errors: [],
      public_execution_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      replay_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.public_execution).toMatchObject({
      provider: input.summary.provider,
      connection_epoch: 1,
      call_id_sha256: input.summary.call.call_id_sha256,
      terminal_observation_sha256: input.summary.terminal.observation_sha256,
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
