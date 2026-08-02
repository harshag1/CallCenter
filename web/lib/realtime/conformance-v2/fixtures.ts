import { createHash } from "node:crypto";
import type {
  AcknowledgedSessionConfiguration,
  ConformanceProviderId,
  ProviderWireEvidence,
  ProviderWireSemantic,
  RealtimeLifecycleEvent,
  RequestedSessionConfiguration,
} from "./types";

type FakeProviderDescriptor = Readonly<{
  providerId: Extract<ConformanceProviderId, "openai" | "gemini" | "xai">;
  model: string;
  voice: string;
  sessionCreatedWireType: string;
  sessionResumedWireType: string;
  turnWireType: string;
  responseStartedWireType: string;
  audioWireType: string;
  toolWireType: string;
  toolResultWireType: string;
  usageWireType: string;
  terminalWireType: string;
}>;

const PROVIDERS: readonly FakeProviderDescriptor[] = Object.freeze([
  Object.freeze({
    providerId: "openai",
    model: "gpt-realtime-2026-06-03",
    voice: "marin",
    sessionCreatedWireType: "session.updated",
    sessionResumedWireType: "session.updated",
    turnWireType: "input_audio_buffer.committed",
    responseStartedWireType: "response.created",
    audioWireType: "response.output_audio.delta",
    toolWireType: "response.function_call_arguments.done",
    toolResultWireType: "conversation.item.created",
    usageWireType: "response.done",
    terminalWireType: "response.done",
  }),
  Object.freeze({
    providerId: "gemini",
    model: "gemini-2.5-flash-native-audio-preview",
    voice: "Kore",
    sessionCreatedWireType: "setupComplete",
    sessionResumedWireType: "sessionResumptionUpdate",
    turnWireType: "serverContent.inputTranscription",
    responseStartedWireType: "serverContent.modelTurn",
    audioWireType: "serverContent.modelTurn.inlineData",
    toolWireType: "toolCall.functionCalls",
    // A cancellation is not a successful result acknowledgement. Continued
    // model generation after clientToolResponse is the positive fake signal.
    toolResultWireType: "serverContent.modelTurn",
    usageWireType: "usageMetadata",
    terminalWireType: "serverContent.turnComplete",
  }),
  Object.freeze({
    providerId: "xai",
    model: "grok-voice-agent-latest",
    voice: "Ara",
    sessionCreatedWireType: "session.updated",
    sessionResumedWireType: "conversation.resumed",
    turnWireType: "input_audio_buffer.committed",
    responseStartedWireType: "response.created",
    audioWireType: "response.audio.delta",
    toolWireType: "response.function_call_arguments.done",
    toolResultWireType: "conversation.item.created",
    usageWireType: "response.done",
    terminalWireType: "response.done",
  }),
]);

const SETTINGS_SHA256 = "a".repeat(64);
const AUDIO_SHA256 = "b".repeat(64);
const ARGUMENTS_SHA256 = "c".repeat(64);
const RESULT_SHA256 = "d".repeat(64);
const RESUME_SHA256 = "e".repeat(64);

function requested(descriptor: FakeProviderDescriptor): RequestedSessionConfiguration {
  return Object.freeze({
    model: descriptor.model,
    voice: descriptor.voice,
    settingsSha256: SETTINGS_SHA256,
    features: Object.freeze([
      Object.freeze({ id: "audio_input" as const, requirement: "required" as const }),
      Object.freeze({ id: "audio_output" as const, requirement: "required" as const }),
      Object.freeze({ id: "tool_calls" as const, requirement: "required" as const }),
      Object.freeze({ id: "interruption" as const, requirement: "required" as const }),
      Object.freeze({ id: "session_resumption" as const, requirement: "preferred" as const }),
      Object.freeze({ id: "provider_usage" as const, requirement: "preferred" as const }),
    ]),
  });
}

function acknowledged(descriptor: FakeProviderDescriptor): AcknowledgedSessionConfiguration {
  return Object.freeze({
    model: descriptor.model,
    voice: descriptor.voice,
    settingsSha256: SETTINGS_SHA256,
    features: Object.freeze(requested(descriptor).features.map(({ id }) => Object.freeze({
      id,
      status: "enabled" as const,
    }))),
  });
}

/**
 * Fake traces deliberately contain authentic provider wire-type vocabulary but
 * no network data, credentials, customer content, or provider SDK dependency.
 */
export function fakeProviderLifecycleTrace(
  providerId: "openai" | "gemini" | "xai",
): readonly RealtimeLifecycleEvent[] {
  const descriptor = PROVIDERS.find((candidate) => candidate.providerId === providerId);
  if (!descriptor) throw new Error(`unknown fake provider ${providerId}`);
  const logicalSessionId = `logical-${providerId}-1`;
  let clock = 1_800_000_000_000;
  let providerEventOrdinal = 0;
  const frameSequences = new Map<string, number>();
  const at = () => ++clock;
  const proof = (
    socketId: string,
    wireType: string,
    proves: ProviderWireSemantic,
  ): ProviderWireEvidence => {
    const ordinal = ++providerEventOrdinal;
    const frameSequence = (frameSequences.get(socketId) ?? -1) + 1;
    frameSequences.set(socketId, frameSequence);
    const frameBytes = Buffer.from(JSON.stringify({ providerId, socketId, frameSequence, wireType, proves }), "utf8");
    return Object.freeze({
      authority: "provider_wire",
      providerEventId: `${providerId}-event-${ordinal}`,
      wireType,
      observedAtMs: at(),
      socketId,
      direction: "provider_to_client",
      frameSequence,
      frameBytesBase64: frameBytes.toString("base64"),
      frameByteLength: frameBytes.byteLength,
      frameSha256: createHash("sha256").update(frameBytes).digest("hex"),
      proves,
    });
  };
  const base = (connectionId: string, connectionEpoch: number) => ({
    schemaVersion: "2.0" as const,
    providerId,
    logicalSessionId,
    connectionId,
    connectionEpoch,
    occurredAtMs: at(),
  });
  const first = "connection-0";
  const second = "connection-1";
  const config = requested(descriptor);
  const ack = acknowledged(descriptor);

  return Object.freeze([
    Object.freeze({ ...base(first, 0), type: "connection.opened", transport: providerId === "openai" ? "webrtc" : "websocket" }),
    Object.freeze({ ...base(first, 0), type: "session.configuration.requested", requestId: "configure-0", requested: config }),
    Object.freeze({
      ...base(first, 0),
      type: "session.configuration.acknowledged",
      requestId: "configure-0",
      providerSessionId: `${providerId}-session-1`,
      acknowledged: ack,
      evidence: proof(first, descriptor.sessionCreatedWireType, "session_acknowledgement"),
    }),
    Object.freeze({ ...base(first, 0), type: "turn.started", turnId: "turn-1", inputId: "input-1", trigger: "audio_commit", evidence: proof(first, descriptor.turnWireType, "turn_observation") }),
    Object.freeze({ ...base(first, 0), type: "response.started", turnId: "turn-1", responseId: "response-1", evidence: proof(first, descriptor.responseStartedWireType, "response_start") }),
    Object.freeze({
      ...base(first, 0), type: "response.audio.delta", turnId: "turn-1", responseId: "response-1",
      audioDeltaId: "audio-1-0", sequence: 0, byteLength: 960, durationMs: 20,
      payloadSha256: AUDIO_SHA256, evidence: proof(first, descriptor.audioWireType, "audio_delta"),
    }),
    Object.freeze({
      ...base(first, 0), type: "response.audio.delta", turnId: "turn-1", responseId: "response-1",
      audioDeltaId: "audio-1-1", sequence: 1, byteLength: 960, durationMs: 20,
      payloadSha256: "f".repeat(64), evidence: proof(first, descriptor.audioWireType, "audio_delta"),
    }),
    Object.freeze({
      ...base(first, 0), type: "tool.call.completed", turnId: "turn-1", responseId: "response-1",
      toolCallId: "tool-call-1", toolName: "membership.lookup", argumentsSha256: ARGUMENTS_SHA256,
      evidence: proof(first, descriptor.toolWireType, "tool_call"),
    }),
    Object.freeze({
      ...base(first, 0), type: "tool.result.submitted", turnId: "turn-1", responseId: "response-1",
      toolCallId: "tool-call-1", resultId: "tool-result-1", resultSha256: RESULT_SHA256,
    }),
    Object.freeze({
      ...base(first, 0), type: "tool.result.acknowledged", turnId: "turn-1", responseId: "response-1",
      toolCallId: "tool-call-1", resultId: "tool-result-1",
      evidence: proof(first, descriptor.toolResultWireType, "tool_result_acknowledgement"),
    }),
    Object.freeze({
      ...base(first, 0), type: "usage.reported", scope: "response", responseId: "response-1", cumulative: true,
      inputTextTokens: 20, inputAudioTokens: 80, outputTextTokens: 5, outputAudioTokens: 15,
      totalTokens: 120, evidence: proof(first, descriptor.usageWireType, "usage"),
    }),
    Object.freeze({
      ...base(first, 0), type: "response.terminal", turnId: "turn-1", responseId: "response-1",
      status: "completed", evidence: proof(first, descriptor.terminalWireType, "response_terminal"),
    }),
    Object.freeze({ ...base(first, 0), type: "turn.terminal", turnId: "turn-1", status: "completed" }),
    Object.freeze({ ...base(first, 0), type: "connection.disconnected", reasonCode: "planned_rotation", resumable: true }),
    Object.freeze({ ...base(second, 1), type: "connection.opened", transport: "websocket", reconnectOfConnectionId: first }),
    Object.freeze({
      ...base(second, 1), type: "session.resume.requested", requestId: "resume-1",
      priorConnectionId: first, resumeTokenSha256: RESUME_SHA256,
    }),
    Object.freeze({
      ...base(second, 1), type: "session.resume.acknowledged", requestId: "resume-1",
      providerSessionId: `${providerId}-session-1`, acknowledged: ack,
      evidence: proof(second, descriptor.sessionResumedWireType, "resume_acknowledgement"),
    }),
    Object.freeze({ ...base(second, 1), type: "turn.started", turnId: "turn-2", inputId: "input-2", trigger: "audio_commit", evidence: proof(second, descriptor.turnWireType, "turn_observation") }),
    Object.freeze({ ...base(second, 1), type: "response.started", turnId: "turn-2", responseId: "response-2", evidence: proof(second, descriptor.responseStartedWireType, "response_start") }),
    Object.freeze({
      ...base(second, 1), type: "response.audio.delta", turnId: "turn-2", responseId: "response-2",
      audioDeltaId: "audio-2-0", sequence: 0, byteLength: 960, durationMs: 20,
      payloadSha256: AUDIO_SHA256, evidence: proof(second, descriptor.audioWireType, "audio_delta"),
    }),
    Object.freeze({
      ...base(second, 1), type: "usage.reported", scope: "session", cumulative: true,
      inputTextTokens: 30, inputAudioTokens: 120, outputTextTokens: 8, outputAudioTokens: 22,
      totalTokens: 180, evidence: proof(second, descriptor.usageWireType, "usage"),
    }),
    Object.freeze({
      ...base(second, 1), type: "response.terminal", turnId: "turn-2", responseId: "response-2",
      status: "interrupted", interruption: { lastReleasedSequence: 0, releasedDurationMs: 20 },
      evidence: proof(second, descriptor.terminalWireType, "response_terminal"),
    }),
    Object.freeze({ ...base(second, 1), type: "turn.terminal", turnId: "turn-2", status: "abandoned" }),
    Object.freeze({ ...base(second, 1), type: "session.terminal", status: "completed" }),
  ] satisfies readonly RealtimeLifecycleEvent[]);
}

export const FAKE_OPENAI_LIFECYCLE_TRACE = fakeProviderLifecycleTrace("openai");
export const FAKE_GEMINI_LIFECYCLE_TRACE = fakeProviderLifecycleTrace("gemini");
export const FAKE_XAI_LIFECYCLE_TRACE = fakeProviderLifecycleTrace("xai");
