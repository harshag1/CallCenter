import { describe, expect, it } from "vitest";
import {
  buildProviderTransportEvidence,
  verifyProviderTransportEvidence,
  type ProviderNormalizedWireLink,
} from "../provider-transport-evidence";
import type {
  RealtimeWireObservation,
  SessionConfigurationAcknowledgement,
} from "../../realtime/client/types";
import {
  realtimeWireObservationReference,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";

const H = (character: string) => character.repeat(64);
const LIMITS = Object.freeze({
  maxTurns: 1,
  maxSessionMs: 10_000,
  maxInputAudioBytes: 4_096,
  maxOutputAudioBytes: 4_096,
  maxToolCalls: 1,
  sessionReadyTimeoutMs: 1_000,
  responseTimeoutMs: 2_000,
});

function verifiedConfiguration(): SessionConfigurationAcknowledgement {
  const verified = (character: string) => Object.freeze({
    status: "verified" as const,
    requestedSha256: H(character),
    acknowledgedSha256: H(character),
    acknowledgedBy: "session.updated" as const,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    strictParityVerified: true,
    paidBenchmarkReady: true,
    session: verified("0"),
    fields: Object.freeze({
      model: verified("1"),
      voice: verified("2"),
      instructions: verified("3"),
      tools: verified("4"),
      tool_choice: verified("5"),
      input_audio: verified("6"),
      output_audio: verified("7"),
      turn_detection: verified("8"),
    }),
  });
}

function geminiConfiguration(): SessionConfigurationAcknowledgement {
  const unverifiable = (character: string) => Object.freeze({
    status: "unverifiable" as const,
    requestedSha256: H(character),
    reason: "setupComplete does not echo the requested field",
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    strictParityVerified: false,
    paidBenchmarkReady: false,
    session: unverifiable("0"),
    fields: Object.freeze({
      model: unverifiable("1"),
      voice: unverifiable("2"),
      instructions: unverifiable("3"),
      tools: unverifiable("4"),
      tool_choice: Object.freeze({ status: "not_requested" as const }),
      input_audio: unverifiable("6"),
      output_audio: unverifiable("7"),
      turn_detection: unverifiable("8"),
    }),
  });
}

function wire(
  provider: "openai" | "xai" | "gemini",
  entries: readonly Readonly<{
    direction: "inbound" | "outbound";
    wireType: string;
    projection: Record<string, unknown>;
    callIdSha256?: string;
    sessionIdSha256?: string;
  }>[],
): RealtimeWireObservation[] {
  let predecessor: string | null = null;
  return entries.map((entry, index) => {
    const projectionSha256 = realtimeWireProjectionSha256(entry.projection);
    const core = {
      schemaVersion: 1 as const,
      provider,
      direction: entry.direction,
      connectionEpoch: 1,
      sequence: index + 1,
      observedAtMs: 1_000 + index,
      observedAtMonotonicMs: 100 + index,
      wireType: entry.wireType,
      payloadSha256: H(String((index + 1) % 10)),
      payloadBytes: 10 + index,
      projectionSha256,
      previousObservationSha256: predecessor,
      identities: Object.freeze({
        ...(entry.callIdSha256 ? { callIdSha256: entry.callIdSha256 } : {}),
        ...(entry.sessionIdSha256 ? { sessionIdSha256: entry.sessionIdSha256 } : {}),
      }),
      projection: Object.freeze(entry.projection),
    };
    const observation = Object.freeze({
      ...core,
      observationSha256: realtimeWireObservationSha256(core),
    });
    predecessor = observation.observationSha256;
    return observation;
  });
}

function links(
  observations: readonly RealtimeWireObservation[],
  types: readonly string[],
): ProviderNormalizedWireLink[] {
  return types.map((type, index) => Object.freeze({
    normalized_sequence: index + 1,
    normalized_type: type,
    wire_type: observations[index]!.wireType,
    attribution: realtimeWireObservationReference(observations[index]!),
  }));
}

function completeWire(provider: "openai" | "xai" | "gemini", omitProviderUsage = false) {
  const callId = H("a");
  return wire(provider, [
    {
      direction: "outbound",
      wireType: provider === "gemini" ? "setup" : "session.update",
      projection: provider === "gemini"
        ? { session: { providerTranscriptionPolicy: { input: "disabled", output: "disabled" } } }
        : {
            session: {
              present: true,
              fieldSha256: {
                model: H("1"),
                voice: H("2"),
                instructions: H("3"),
                tools: H("4"),
                tool_choice: H("5"),
                input_audio: H("6"),
                output_audio: H("7"),
                turn_detection: H("8"),
              },
            },
          },
    },
    {
      direction: "inbound",
      wireType: provider === "gemini" ? "setupComplete" : "session.updated",
      sessionIdSha256: provider === "gemini" ? undefined : H("d"),
      projection: provider === "gemini"
        ? { session: { acknowledgement: "ready" } }
        : {
            session: {
              acknowledgement: "ready",
              fieldSha256: {
                model: H("1"),
                voice: H("2"),
                instructions: H("3"),
                tools: H("4"),
                tool_choice: H("5"),
                input_audio: H("6"),
                output_audio: H("7"),
                turn_detection: H("8"),
              },
            },
          },
    },
    {
      direction: "outbound",
      wireType: provider === "gemini" ? "realtimeInput.audio" : "input_audio_buffer.append",
      projection: { audio: { direction: "input", byteLength: 4, sha256: H("b") } },
    },
    {
      direction: "inbound",
      wireType: provider === "gemini" ? "toolCall" : "response.function_call_arguments.done",
      callIdSha256: callId,
      projection: { gatewayCalls: [{ gateway: "capability_gateway", callIdSha256: callId }] },
    },
    {
      direction: "outbound",
      wireType: provider === "gemini" ? "toolResponse" : "conversation.item.create",
      callIdSha256: callId,
      projection: { gatewayResults: [{ gateway: "capability_gateway", callIdSha256: callId }] },
    },
    {
      direction: "inbound",
      wireType: provider === "gemini" ? "serverContent" : "response.output_audio.delta",
      projection: { audio: { direction: "output", byteLength: 4, sha256: H("c") } },
    },
    {
      direction: "inbound",
      wireType: provider === "gemini" ? "usageMetadata" : "response.done",
      projection: omitProviderUsage ? {} : { usage: { totalTokens: 2 } },
    },
    {
      direction: "inbound",
      wireType: provider === "gemini" ? "serverContent" : "response.done",
      projection: { terminal: { status: "completed" } },
    },
  ]);
}

describe("provider transport compatibility evidence", () => {
  it("admits a complete OpenAI/xAI-shaped packet only as C3 transport compatibility", () => {
    const observations = completeWire("openai");
    const evidence = buildProviderTransportEvidence({
      provider: "openai",
      model: "gpt-realtime-2.1",
      sessionReady: true,
      sessionIdSha256: H("d"),
      sessionConfiguration: verifiedConfiguration(),
      wireObservations: observations,
      normalizedLinks: links(observations, [
        "provider.event",
        "session.ready",
        "provider.event",
        "tool.calls",
        "tool.dispatch",
        "output.audio",
        "usage",
        "response.completed",
      ]),
      inputAudio: [{
        ordinal: 1,
        byte_length: 4,
        sha256: H("b"),
        sample_rate_hz: 24_000,
        channels: 1,
        encoding: "pcm16",
      }],
      outputAudio: [{
        ordinal: 1,
        byte_length: 4,
        sha256: H("c"),
        sample_rate_hz: 24_000,
        channels: 1,
        encoding: "pcm16",
      }],
      normalizedToolCallCount: 1,
      kernelInvocationCount: 1,
      usage: [{ totalTokens: 2, raw: { total_tokens: 2 } }],
      normalizedTerminalCount: 1,
      limits: LIMITS,
      elapsedMs: 500,
    });

    expect(evidence.gate1_transport_smoke).toEqual({
      eligible: true,
      errors: [],
      claim_boundary: "transport_compatibility_only",
    });
    expect(evidence.wire).toMatchObject({
      observation_count: 8,
      chain_valid: true,
      directions: ["inbound", "outbound"],
      normalized_unavailable_count: 0,
    });
    expect(evidence.gateway).toEqual({
      normalized_call_count: 1,
      kernel_invocation_count: 1,
      wire_call_count: 1,
      wire_result_count: 1,
      matched_call_id_count: 1,
    });
    expect(verifyProviderTransportEvidence({
      evidence,
      wireObservations: observations,
      usage: [{ totalTokens: 2, raw: { total_tokens: 2 } }],
      provider: "openai",
      model: "gpt-realtime-2.1",
    })).toEqual({ valid: true, errors: [] });

    const forged = {
      ...evidence,
      audio: { ...evidence.audio, output_total_bytes: evidence.audio.output_total_bytes + 2 },
    } as typeof evidence;
    expect(verifyProviderTransportEvidence({
      evidence: forged,
      wireObservations: observations,
      usage: [{ totalTokens: 2, raw: { total_tokens: 2 } }],
      provider: "openai",
      model: "gpt-realtime-2.1",
    })).toMatchObject({
      valid: false,
      errors: ["provider_transport_evidence_recomputation_mismatch"],
    });
  });

  it("keeps Gemini request-bound configuration explicitly unverifiable while admitting transport", () => {
    const observations = completeWire("gemini");
    const evidence = buildProviderTransportEvidence({
      provider: "gemini",
      model: "gemini-3.1-flash-live-preview",
      sessionReady: true,
      sessionConfiguration: geminiConfiguration(),
      wireObservations: observations,
      normalizedLinks: links(observations, [
        "provider.event",
        "session.ready",
        "provider.event",
        "tool.calls",
        "tool.dispatch",
        "output.audio",
        "usage",
        "response.completed",
      ]),
      inputAudio: [{
        ordinal: 1,
        byte_length: 4,
        sha256: H("b"),
        sample_rate_hz: 16_000,
        channels: 1,
        encoding: "pcm16",
      }],
      outputAudio: [{
        ordinal: 1,
        byte_length: 4,
        sha256: H("c"),
        sample_rate_hz: 24_000,
        channels: 1,
        encoding: "pcm16",
      }],
      normalizedToolCallCount: 1,
      kernelInvocationCount: 1,
      usage: [{ totalTokens: 2, raw: { totalTokenCount: 2 } }],
      normalizedTerminalCount: 1,
      limits: LIMITS,
      elapsedMs: 500,
    });

    expect(evidence.gate1_transport_smoke.eligible).toBe(true);
    expect(evidence.session.configuration).toMatchObject({
      strictParityVerified: false,
      paidBenchmarkReady: false,
      fields: { model: { status: "unverifiable" } },
    });
    expect(evidence.gemini_provider_transcription).toBe("disabled");
  });

  it("accepts xAI's frozen client-metered PCM accounting rule without inventing provider usage", () => {
    const observations = completeWire("xai", true);
    const evidence = buildProviderTransportEvidence({
      provider: "xai",
      model: "grok-voice-think-fast-1.0",
      sessionReady: true,
      sessionIdSha256: H("d"),
      sessionConfiguration: verifiedConfiguration(),
      wireObservations: observations,
      normalizedLinks: links(observations, [
        "provider.event",
        "session.ready",
        "provider.event",
        "tool.calls",
        "tool.dispatch",
        "output.audio",
        "usage",
        "response.completed",
      ]),
      inputAudio: [{
        ordinal: 1,
        byte_length: 4,
        sha256: H("b"),
        sample_rate_hz: 24_000,
        channels: 1,
        encoding: "pcm16",
      }],
      outputAudio: [{
        ordinal: 1,
        byte_length: 4,
        sha256: H("c"),
        sample_rate_hz: 24_000,
        channels: 1,
        encoding: "pcm16",
      }],
      normalizedToolCallCount: 1,
      kernelInvocationCount: 1,
      usage: [{
        inputAudioMinutes: 0.001,
        outputAudioMinutes: 0.001,
        billableTextInputEvents: 0,
        meteringSource: "client_measured",
        raw: {},
      }],
      normalizedTerminalCount: 1,
      limits: LIMITS,
      elapsedMs: 500,
    });

    expect(evidence.gate1_transport_smoke.eligible).toBe(true);
    expect(evidence.usage).toMatchObject({
      wire_event_count: 0,
      status: "xai_client_measured_from_wire_pcm",
    });
  });

  it("fails closed on missing PCM, usage, terminal linkage, or a mismatched gateway identity", () => {
    const observations = completeWire("openai").map((entry) => entry);
    const resultProjection = {
      gatewayResults: [{ gateway: "capability_gateway", callIdSha256: H("f") }],
    };
    const prior = observations[3]!;
    observations.splice(4, 1, ...wire("openai", [{
      direction: "outbound",
      wireType: "conversation.item.create",
      callIdSha256: H("f"),
      projection: resultProjection,
    }]).map((entry) => {
      const rewritten = {
        schemaVersion: entry.schemaVersion,
        provider: entry.provider,
        direction: entry.direction,
        connectionEpoch: entry.connectionEpoch,
        sequence: 5,
        observedAtMs: entry.observedAtMs,
        observedAtMonotonicMs: entry.observedAtMonotonicMs,
        wireType: entry.wireType,
        payloadSha256: entry.payloadSha256,
        payloadBytes: entry.payloadBytes,
        projectionSha256: entry.projectionSha256,
        previousObservationSha256: prior.observationSha256,
        identities: entry.identities,
        projection: entry.projection,
      };
      return Object.freeze({ ...rewritten, observationSha256: realtimeWireObservationSha256(rewritten) });
    }));
    const evidence = buildProviderTransportEvidence({
      provider: "openai",
      model: "gpt-realtime-2.1",
      sessionReady: true,
      sessionConfiguration: verifiedConfiguration(),
      wireObservations: observations,
      normalizedLinks: [],
      inputAudio: [],
      outputAudio: [],
      normalizedToolCallCount: 1,
      kernelInvocationCount: 1,
      usage: [],
      normalizedTerminalCount: 0,
      limits: LIMITS,
      elapsedMs: 500,
    });

    expect(evidence.gate1_transport_smoke.eligible).toBe(false);
    expect(evidence.gate1_transport_smoke.errors).toEqual(expect.arrayContaining([
      "wire_observation_chain_invalid_or_empty",
      "input_pcm_missing",
      "output_pcm_missing",
      "exactly_one_gateway_roundtrip_not_proven",
      "usage_evidence_missing",
      "terminal_response_evidence_missing",
    ]));
  });
});
