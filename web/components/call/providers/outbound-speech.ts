import type { RealtimeResponseTerminalStatus, ServerRealtimeProvider } from "@/lib/realtime/client/types";
import type { OutboundSpeechGateDecision } from "@/lib/realtime/outbound-speech-gate";
import {
  decodePcm16Base64,
  playPcm16Bytes,
  type BrowserOutboundSpeechGateConfig,
  type BrowserOutboundSpeechGateEvidence,
  type PlaybackState,
} from "./types";

export const BROWSER_OUTBOUND_SPEECH_GATE_SUPPORT = Object.freeze({
  openai: Object.freeze({
    supported: true as const,
    evidenceLevel: "captured_remote_track_pcm_quarantine_and_audio_context_schedule" as const,
    capture: "webrtc_remote_track_to_muted_pcm_processor" as const,
  }),
  xai: Object.freeze({
    supported: true as const,
    evidenceLevel: "exact_pcm_quarantine_and_audio_context_schedule" as const,
  }),
  gemini: Object.freeze({
    supported: true as const,
    evidenceLevel: "exact_pcm_quarantine_and_audio_context_schedule" as const,
  }),
});

export function boundedSpeechResponseId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function pushQuarantinedPcm16Base64(
  config: BrowserOutboundSpeechGateConfig,
  provider: Extract<ServerRealtimeProvider, "openai" | "xai" | "gemini">,
  responseId: string,
  base64: string,
  sampleRateHz = 24_000,
): void {
  config.gate.pushAudio(provider, responseId, {
    encoding: "pcm16",
    sampleRateHz,
    channels: 1,
    data: decodePcm16Base64(base64),
  });
}

function withoutAudio(decision: OutboundSpeechGateDecision): Omit<OutboundSpeechGateDecision, "audio"> {
  return Object.freeze({
    schemaVersion: decision.schemaVersion,
    responseId: decision.responseId,
    provider: decision.provider,
    action: decision.action,
    reason: decision.reason,
    evidenceCoverage: decision.evidenceCoverage,
    audioSha256: decision.audioSha256,
    audioBytes: decision.audioBytes,
    audioDurationMs: decision.audioDurationMs,
    providerTranscriptSha256: decision.providerTranscriptSha256,
    independentAsrTranscriptSha256: decision.independentAsrTranscriptSha256,
    independentAsrReceiptSha256: decision.independentAsrReceiptSha256,
    violations: Object.freeze(decision.violations.map((violation) => Object.freeze({ ...violation }))),
    collectionLatencyMs: decision.collectionLatencyMs,
    decisionLatencyMs: decision.decisionLatencyMs,
  });
}

export async function finalizeQuarantinedSpeech(args: Readonly<{
  config: BrowserOutboundSpeechGateConfig;
  provider: Extract<ServerRealtimeProvider, "openai" | "xai" | "gemini">;
  responseId: string;
  terminalStatus: RealtimeResponseTerminalStatus;
  audioContext: AudioContext;
  recordingDestination?: MediaStreamAudioDestinationNode;
  playback: PlaybackState;
  /** Re-checked after asynchronous ASR so stop/reconnect cannot release stale audio. */
  isTransportActive?: () => boolean;
}>): Promise<BrowserOutboundSpeechGateEvidence> {
  args.config.gate.markTerminal(args.provider, args.responseId, args.terminalStatus);
  const decision = await args.config.gate.finalizeResponse(args.responseId);
  const safeDecision = withoutAudio(decision);
  let evidence: BrowserOutboundSpeechGateEvidence;
  if (decision.action === "release") {
    if (args.isTransportActive && !args.isTransportActive()) {
      throw new Error("speech gate release was abandoned because the transport is no longer active");
    }
    if (!decision.audioSha256 || !decision.audio || decision.audio.length === 0) {
      throw new Error("speech gate release omitted exact PCM evidence");
    }
    let byteOffset = 0;
    const ranges = decision.audio.map((audio) => {
      const scheduled = playPcm16Bytes(
        audio.data,
        args.audioContext,
        args.recordingDestination,
        args.playback,
        audio.sampleRateHz,
      );
      const byteStart = byteOffset;
      byteOffset += scheduled.byteLength;
      return Object.freeze({
        byteStart,
        byteEnd: byteOffset,
        sampleRateHz: scheduled.sampleRateHz,
        audioContextStartSeconds: scheduled.audioContextStartSeconds,
        audioContextEndSeconds: scheduled.audioContextEndSeconds,
      });
    });
    if (byteOffset !== decision.audioBytes) throw new Error("speech gate playout byte binding mismatched");
    evidence = Object.freeze({
      schemaVersion: 1 as const,
      provider: args.provider,
      responseId: args.responseId,
      decision: safeDecision,
      playout: Object.freeze({
        status: "released_to_audio_context" as const,
        evidenceLevel: "audio_context_schedule" as const,
        audioSha256: decision.audioSha256,
        audioBytes: byteOffset,
        ranges: Object.freeze(ranges),
      }),
    });
  } else {
    let regenerationRequested = false;
    if (decision.action === "suppress_and_regenerate" && args.config.onRegenerationRequired) {
      await args.config.onRegenerationRequired(safeDecision);
      regenerationRequested = true;
    }
    evidence = Object.freeze({
      schemaVersion: 1 as const,
      provider: args.provider,
      responseId: args.responseId,
      decision: safeDecision,
      playout: Object.freeze({
        status: "suppressed_before_playout" as const,
        regenerationRequested,
      }),
    });
  }
  args.config.onEvidence(evidence);
  return evidence;
}
