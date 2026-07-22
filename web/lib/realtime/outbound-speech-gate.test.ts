import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OutboundSpeechGate,
  createOutboundSpeechGatePolicy,
  type IndependentSpeechAsr,
  type IndependentSpeechAsrInput,
} from "./outbound-speech-gate";

const RECEIPT_SHA = "a".repeat(64);

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pcm(values = [1, 0, 2, 0]) {
  return {
    encoding: "pcm16" as const,
    sampleRateHz: 16_000,
    channels: 1 as const,
    data: Uint8Array.from(values),
  };
}

function asr(text: string, mutate: Partial<Awaited<ReturnType<IndependentSpeechAsr>>> = {}): IndependentSpeechAsr {
  return async (input: IndependentSpeechAsrInput) => ({
    text,
    audioSha256: input.audioSha256,
    audioBytes: input.audioBytes,
    sampleRateHz: input.audio.sampleRateHz,
    channels: 1,
    complete: true,
    engine: "fixture-asr",
    receiptSha256: RECEIPT_SHA,
    ...mutate,
  });
}

function gate(input: {
  asr?: IndependentSpeechAsr;
  transcript?: string;
  terminalAuthorized?: boolean;
  onViolation?: "suppress" | "suppress_and_regenerate";
  onEvidenceFailure?: "suppress" | "suppress_and_regenerate";
  now?: () => number;
} = {}) {
  const secret = "482-991";
  return new OutboundSpeechGate({
    independentAsr: input.asr,
    now: input.now,
    policy: createOutboundSpeechGatePolicy({
      maxDecisionLatencyMs: 100,
      secrets: [{ value: secret, fingerprintSha256: sha(secret), ruleId: "privacy.verification_code" }],
      forbiddenTerminalClaims: [{ phrase: "your return is complete", ruleId: "terminal.return_complete" }],
      terminalClaimsAuthorized: input.terminalAuthorized ?? false,
      onViolation: input.onViolation ?? "suppress",
      onEvidenceFailure: input.onEvidenceFailure ?? "suppress",
    }),
  });
}

function complete(gate: OutboundSpeechGate, transcript = "I can help with that") {
  gate.beginResponse("openai", "response-1", 1_000);
  gate.pushAudio("openai", "response-1", pcm(), 1_010);
  gate.pushProviderTranscript("openai", "response-1", transcript, true, 1_020);
  gate.markTerminal("openai", "response-1", "completed", 1_030);
}

describe("OutboundSpeechGate", () => {
  it("quarantines PCM until exact byte-bound ASR evidence passes", async () => {
    const instance = gate({ asr: asr("I can help with that") });
    complete(instance);

    expect(instance.status("response-1")).toMatchObject({ state: "terminal", audioBytes: 4 });
    const decision = await instance.finalizeResponse("response-1");

    expect(decision).toMatchObject({
      action: "release",
      reason: "policy_pass",
      evidenceCoverage: "exact_buffered_pcm",
      audioBytes: 4,
      violations: [],
    });
    expect(decision.audio?.map((audio) => Array.from(audio.data))).toEqual([[1, 0, 2, 0]]);
    expect(decision.audioSha256).toBe(sha(Buffer.from([1, 0, 2, 0]).toString("binary")));
  });

  it("suppresses a secret found only by independent ASR without exposing the secret", async () => {
    const instance = gate({ asr: asr("The code was 482 991") });
    complete(instance, "The verification succeeded");

    const decision = await instance.finalizeResponse("response-1");

    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe("policy_violation");
    expect(decision.audio).toBeUndefined();
    expect(decision.violations).toEqual([{
      code: "secret_echo",
      ruleId: "privacy.verification_code",
      secretFingerprintSha256: sha("482-991"),
      source: "independent_asr",
    }]);
    expect(JSON.stringify(decision)).not.toContain("482");
  });

  it("suppresses forbidden terminal claims until authoritative state permits them", async () => {
    const blocked = gate({ asr: asr("Your return is complete") });
    complete(blocked, "Your return is complete");
    const blockedDecision = await blocked.finalizeResponse("response-1");
    expect(blockedDecision.action).toBe("suppress");
    expect(blockedDecision.violations).toEqual([
      { code: "forbidden_terminal_claim", ruleId: "terminal.return_complete", source: "provider_transcript" },
    ]);

    const authorized = gate({ asr: asr("Your return is complete"), terminalAuthorized: true });
    complete(authorized, "Your return is complete");
    expect((await authorized.finalizeResponse("response-1")).action).toBe("release");
  });

  it("fails closed when the ASR receipt does not cover the exact buffered PCM", async () => {
    const instance = gate({
      asr: asr("I can help", { audioSha256: "b".repeat(64) }),
      onEvidenceFailure: "suppress_and_regenerate",
    });
    complete(instance);

    expect(await instance.finalizeResponse("response-1")).toMatchObject({
      action: "suppress_and_regenerate",
      reason: "evidence_mismatch",
      evidenceCoverage: "none",
    });
  });

  it("fails closed on missing evidence and non-completed provider terminals", async () => {
    const missing = gate();
    complete(missing);
    expect(await missing.finalizeResponse("response-1")).toMatchObject({
      action: "suppress",
      reason: "evidence_unavailable",
    });

    const cancelled = gate({ asr: asr("safe") });
    cancelled.beginResponse("xai", "cancelled", 10);
    cancelled.pushAudio("xai", "cancelled", pcm(), 11);
    cancelled.markTerminal("xai", "cancelled", "cancelled", 12);
    expect(await cancelled.finalizeResponse("cancelled")).toMatchObject({
      action: "suppress",
      reason: "provider_terminal_not_completed",
    });
  });

  it("has explicit fail-closed collection and ASR latency watchdogs", async () => {
    const stalled = gate({ asr: asr("safe") });
    stalled.beginResponse("openai", "stalled", 0);
    stalled.pushAudio("openai", "stalled", pcm(), 1);
    expect(stalled.expireResponse("stalled", 150_000)).toMatchObject({
      state: "sealed",
      sealedReason: "collection_latency_exceeded",
    });
    expect(await stalled.finalizeResponse("stalled")).toMatchObject({
      action: "suppress",
      reason: "collection_latency_exceeded",
    });

    const never = new Promise<never>(() => undefined);
    const timedOut = new OutboundSpeechGate({
      independentAsr: async () => never,
      policy: createOutboundSpeechGatePolicy({ maxDecisionLatencyMs: 10 }),
      setTimer: (callback) => {
        queueMicrotask(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    timedOut.beginResponse("xai", "timed-out", 0);
    timedOut.pushAudio("xai", "timed-out", pcm(), 1);
    timedOut.markTerminal("xai", "timed-out", "completed", 2);
    expect(await timedOut.finalizeResponse("timed-out")).toMatchObject({
      action: "suppress",
      reason: "evidence_timeout",
    });
  });

  it("labels provider-transcript-only release as unbound defense in depth", async () => {
    const instance = new OutboundSpeechGate({
      policy: createOutboundSpeechGatePolicy({ evidencePolicy: "provider_transcript_allowed" }),
    });
    instance.beginResponse("openai", "provider-only", 0);
    instance.pushAudio("openai", "provider-only", pcm(), 1);
    instance.pushProviderTranscript("openai", "provider-only", "safe", true, 2);
    instance.markTerminal("openai", "provider-only", "completed", 3);
    expect(await instance.finalizeResponse("provider-only")).toMatchObject({
      action: "release",
      evidenceCoverage: "provider_transcript_unbound",
    });
  });

  it("seals oversized, overlong, and format-changing responses before evaluation", async () => {
    const oversized = new OutboundSpeechGate({
      independentAsr: asr("safe"),
      policy: createOutboundSpeechGatePolicy({ maxBufferedAudioBytes: 2 }),
    });
    oversized.beginResponse("gemini", "large", 0);
    oversized.pushAudio("gemini", "large", pcm(), 1);
    expect(oversized.status("large")).toMatchObject({ state: "sealed", sealedReason: "buffer_limit_exceeded" });
    oversized.markTerminal("gemini", "large", "completed", 2);
    expect(await oversized.finalizeResponse("large")).toMatchObject({ action: "suppress", reason: "buffer_limit_exceeded" });

    const changed = gate({ asr: asr("safe") });
    changed.beginResponse("gemini", "changed", 0);
    changed.pushAudio("gemini", "changed", pcm(), 1);
    changed.pushAudio("gemini", "changed", { ...pcm(), sampleRateHz: 24_000 }, 2);
    expect(changed.status("changed")).toMatchObject({ state: "sealed", sealedReason: "invalid_audio_sequence" });
  });

  it("accepts normalized events from all three server adapters without releasing early", async () => {
    for (const provider of ["openai", "gemini", "xai"] as const) {
      const instance = gate({ asr: asr("safe answer") });
      instance.observe({
        type: "response.started", provider, responseId: `r-${provider}`, receivedAtMs: 1, wireType: "response.started",
      });
      instance.observe({
        type: "output.audio", provider, responseId: `r-${provider}`, receivedAtMs: 2, wireType: "audio",
        audio: pcm().data, format: { encoding: "pcm16", sampleRateHz: 16_000, channels: 1 },
      });
      expect(instance.status(`r-${provider}`).state).toBe("collecting");
      instance.observe({
        type: "output.transcript", provider, responseId: `r-${provider}`, receivedAtMs: 3,
        wireType: "transcript", text: "safe answer", phase: "final", source: "audio",
      });
      instance.observe({
        type: "response.completed", provider, responseId: `r-${provider}`, receivedAtMs: 4,
        wireType: "done", status: "completed",
      });
      expect((await instance.finalizeResponse(`r-${provider}`)).action).toBe("release");
    }
  });

  it("returns an idempotent immutable decision and rejects late output", async () => {
    const instance = gate({ asr: asr("safe") });
    complete(instance);
    const first = await instance.finalizeResponse("response-1");
    expect(await instance.finalizeResponse("response-1")).toBe(first);
    expect(() => instance.pushAudio("openai", "response-1", pcm(), 2_000)).toThrow(/finalized/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.violations)).toBe(true);
  });
});
