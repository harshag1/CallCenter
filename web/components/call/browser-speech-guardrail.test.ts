import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserSpeechGuardrail } from "./browser-speech-guardrail";

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000a1";
const CALL_ID = "00000000-0000-4000-8000-0000000000c1";
const AUDIO_SHA256 = "a".repeat(64);

function bootstrap() {
  return {
    schemaVersion: 1,
    mode: "enforce",
    organizationId: ORGANIZATION_ID,
    provider: "xai",
    callId: CALL_ID,
    asrEndpoint: "/api/voice/outbound-speech/asr",
    policy: {
      evidencePolicy: "independent_asr_required",
      maxBufferedAudioBytes: 1024,
      maxBufferedAudioMs: 10_000,
      maxCollectionLatencyMs: 10_000,
      maxDecisionLatencyMs: 5_000,
      onViolation: "suppress",
      onEvidenceFailure: "suppress",
      secrets: [],
      forbiddenTerminalClaims: [],
      terminalClaimsAuthorized: false,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser ASR receipt audience", () => {
  it.each([
    ["legacy arbitrary hash", {
      text: "attacker transcript",
      audioSha256: AUDIO_SHA256,
      audioBytes: 4,
      sampleRateHz: 24_000,
      channels: 1,
      complete: true,
      engine: "attacker",
      receiptSha256: "f".repeat(64),
    }],
    ["cross-call substitution", {
      schemaVersion: 2,
      authorityId: "00000000-0000-4000-8000-0000000000d1",
      organizationId: ORGANIZATION_ID,
      callId: "00000000-0000-4000-8000-0000000000c2",
      provider: "xai",
      responseId: "response-1",
      text: "attacker transcript",
      transcriptSha256: "b".repeat(64),
      audioSha256: AUDIO_SHA256,
      audioBytes: 4,
      sampleRateHz: 24_000,
      channels: 1,
      complete: true,
      engine: "openai_audio_transcriptions",
      model: "whisper-1",
      decision: "transcribed",
      receiptHmacSha256: "c".repeat(64),
      receiptSha256: "d".repeat(64),
    }],
    ["cross-provider substitution", {
      schemaVersion: 2,
      authorityId: "00000000-0000-4000-8000-0000000000d1",
      organizationId: ORGANIZATION_ID,
      callId: CALL_ID,
      provider: "gemini",
      responseId: "response-1",
      text: "attacker transcript",
      transcriptSha256: "b".repeat(64),
      audioSha256: AUDIO_SHA256,
      audioBytes: 4,
      sampleRateHz: 24_000,
      channels: 1,
      complete: true,
      engine: "openai_audio_transcriptions",
      model: "whisper-1",
      decision: "transcribed",
      receiptHmacSha256: "c".repeat(64),
      receiptSha256: "d".repeat(64),
    }],
  ])("suppresses before playout for %s", async (_label, forgedReceipt) => {
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("btoa", (value: string) => Buffer.from(value, "binary").toString("base64"));
    const fetchMock = vi.fn(async () => Response.json(forgedReceipt));
    vi.stubGlobal("fetch", fetchMock);
    const created = createBrowserSpeechGuardrail({
      value: bootstrap(),
      provider: "xai",
      callId: CALL_ID,
      onEvidence: vi.fn(),
    });
    if (!created.config) throw new Error("fixture guardrail was not created");
    created.config.gate.beginResponse("xai", "response-1");
    created.config.gate.pushAudio("xai", "response-1", {
      encoding: "pcm16",
      sampleRateHz: 24_000,
      channels: 1,
      data: Uint8Array.from([1, 0, 2, 0]),
    });
    created.config.gate.markTerminal("xai", "response-1", "completed");

    await expect(created.config.gate.finalizeResponse("response-1")).resolves.toMatchObject({
      action: "suppress",
      reason: "evidence_unavailable",
      evidenceCoverage: "none",
      audioBytes: 4,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a cross-organization bootstrap before constructing any ASR client", () => {
    expect(() => createBrowserSpeechGuardrail({
      value: { ...bootstrap(), organizationId: "not-an-organization" },
      provider: "xai",
      callId: CALL_ID,
      onEvidence: vi.fn(),
    })).toThrow("mismatched speech authority");
  });
});
