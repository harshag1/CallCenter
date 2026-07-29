import { describe, expect, it, vi } from "vitest";
import {
  OutboundSpeechGate,
  createOutboundSpeechGatePolicy,
} from "@/lib/realtime/outbound-speech-gate";
import {
  BROWSER_OUTBOUND_SPEECH_GATE_SUPPORT,
  finalizeQuarantinedSpeech,
  pushQuarantinedPcm16Base64,
} from "./outbound-speech";

function playbackHarness() {
  const source = {
    buffer: null as AudioBuffer | null,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  };
  const context = {
    currentTime: 4,
    destination: {},
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      copyToChannel: vi.fn(),
    })),
    createBufferSource: vi.fn(() => source),
  } as unknown as AudioContext;
  return { context, source, playback: { playhead: 0, scheduled: [] as AudioBufferSourceNode[] } };
}

describe("browser outbound speech quarantine", () => {
  it("binds exact released bytes to AudioContext schedule ranges without claiming speaker proof", async () => {
    const gate = new OutboundSpeechGate({
      policy: createOutboundSpeechGatePolicy({ evidencePolicy: "provider_transcript_allowed" }),
    });
    const onEvidence = vi.fn();
    const audio = playbackHarness();
    gate.beginResponse("xai", "response-1");
    pushQuarantinedPcm16Base64(
      { gate, onEvidence },
      "xai",
      "response-1",
      Buffer.from([1, 0, 2, 0]).toString("base64"),
    );
    gate.pushProviderTranscript("xai", "response-1", "Safe response", true);

    expect(audio.context.createBuffer).not.toHaveBeenCalled();
    const evidence = await finalizeQuarantinedSpeech({
      config: { gate, onEvidence },
      provider: "xai",
      responseId: "response-1",
      terminalStatus: "completed",
      audioContext: audio.context,
      playback: audio.playback,
    });

    expect(evidence.playout).toMatchObject({
      status: "released_to_audio_context",
      evidenceLevel: "audio_context_schedule",
      audioBytes: 4,
      ranges: [{ byteStart: 0, byteEnd: 4, audioContextStartSeconds: 4.05 }],
    });
    expect(evidence.decision).not.toHaveProperty("audio");
    expect(audio.source.start).toHaveBeenCalledWith(4.05);
    expect(onEvidence).toHaveBeenCalledWith(evidence);
  });

  it("suppresses violating speech before AudioContext and records regeneration dispatch", async () => {
    const gate = new OutboundSpeechGate({
      policy: createOutboundSpeechGatePolicy({
        evidencePolicy: "provider_transcript_allowed",
        forbiddenTerminalClaims: [{ phrase: "your refund is complete", ruleId: "refund.requires_receipt" }],
        onViolation: "suppress_and_regenerate",
      }),
    });
    const onEvidence = vi.fn();
    const onRegenerationRequired = vi.fn();
    const audio = playbackHarness();
    gate.beginResponse("gemini", "response-2");
    pushQuarantinedPcm16Base64(
      { gate, onEvidence, onRegenerationRequired },
      "gemini",
      "response-2",
      Buffer.from([1, 0]).toString("base64"),
    );
    gate.pushProviderTranscript("gemini", "response-2", "Your refund is complete", true);

    const evidence = await finalizeQuarantinedSpeech({
      config: { gate, onEvidence, onRegenerationRequired },
      provider: "gemini",
      responseId: "response-2",
      terminalStatus: "completed",
      audioContext: audio.context,
      playback: audio.playback,
    });

    expect(evidence.playout).toEqual({
      status: "suppressed_before_playout",
      regenerationRequested: true,
    });
    expect(evidence.decision.violations).toEqual([{
      code: "forbidden_terminal_claim",
      ruleId: "refund.requires_receipt",
      source: "provider_transcript",
    }]);
    expect(audio.context.createBuffer).not.toHaveBeenCalled();
    expect(onRegenerationRequired).toHaveBeenCalledWith(evidence.decision);
  });

  it("advertises exact-PCM quarantine support for every stock browser provider", () => {
    expect(BROWSER_OUTBOUND_SPEECH_GATE_SUPPORT).toMatchObject({
      openai: {
        supported: true,
        capture: "webrtc_remote_track_to_muted_pcm_processor",
      },
      xai: { supported: true },
      gemini: { supported: true },
    });
  });
});
