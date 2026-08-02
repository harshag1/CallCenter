import { describe, expect, it } from "vitest";
import {
  browserOutboundSpeechGateRejection,
  sanitizeBrowserOutboundSpeechGateEvidence,
  sanitizeBrowserOutboundSpeechGateRejection,
} from "./browser-outbound-speech-evidence";

function releasedEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "openai",
    responseId: "response-1",
    decision: {
      schemaVersion: 1,
      responseId: "response-1",
      provider: "openai",
      action: "release",
      reason: "policy_pass",
      evidenceCoverage: "exact_buffered_pcm",
      audioSha256: "a".repeat(64),
      audioBytes: 8,
      audioDurationMs: 1,
      providerTranscriptSha256: null,
      independentAsrTranscriptSha256: "b".repeat(64),
      independentAsrReceiptSha256: "c".repeat(64),
      violations: [],
      collectionLatencyMs: 2,
      decisionLatencyMs: 3,
    },
    playout: {
      status: "released_to_audio_context",
      evidenceLevel: "audio_context_schedule",
      audioSha256: "a".repeat(64),
      audioBytes: 8,
      ranges: [
        { byteStart: 0, byteEnd: 4, sampleRateHz: 24_000, audioContextStartSeconds: 1, audioContextEndSeconds: 1.001 },
        { byteStart: 4, byteEnd: 8, sampleRateHz: 24_000, audioContextStartSeconds: 1.001, audioContextEndSeconds: 1.002 },
      ],
    },
  };
}

describe("browser outbound speech evidence durable boundary", () => {
  it("reconstructs exact content-free release evidence", () => {
    expect(sanitizeBrowserOutboundSpeechGateEvidence(releasedEvidence())).toEqual(releasedEvidence());
  });

  it("accepts internally consistent suppression evidence", () => {
    const evidence = releasedEvidence();
    evidence.decision = {
      ...(evidence.decision as Record<string, unknown>),
      action: "suppress_and_regenerate",
      reason: "evidence_timeout",
      evidenceCoverage: "none",
      audioSha256: null,
      audioBytes: 0,
      audioDurationMs: 0,
      independentAsrTranscriptSha256: null,
      independentAsrReceiptSha256: null,
    };
    evidence.playout = { status: "suppressed_before_playout", regenerationRequested: true };
    expect(sanitizeBrowserOutboundSpeechGateEvidence(evidence)).toEqual(evidence);
  });

  it.each([
    ["unknown property", (value: Record<string, unknown>) => { value.secret = "Bearer durable-secret"; }],
    ["raw audio", (value: Record<string, unknown>) => {
      (value.decision as Record<string, unknown>).audio = [{ data: "private-pcm" }];
    }],
    ["provider mismatch", (value: Record<string, unknown>) => {
      (value.decision as Record<string, unknown>).provider = "xai";
    }],
    ["PII-shaped response identity", (value: Record<string, unknown>) => {
      value.responseId = "alice@example.test";
      (value.decision as Record<string, unknown>).responseId = "alice@example.test";
    }],
    ["hash mismatch", (value: Record<string, unknown>) => {
      (value.playout as Record<string, unknown>).audioSha256 = "d".repeat(64);
    }],
    ["noncontiguous ranges", (value: Record<string, unknown>) => {
      const ranges = (value.playout as { ranges: Record<string, unknown>[] }).ranges;
      ranges[1].byteStart = 6;
    }],
    ["non-finite playout time", (value: Record<string, unknown>) => {
      const ranges = (value.playout as { ranges: Record<string, unknown>[] }).ranges;
      ranges[0].audioContextStartSeconds = Number.POSITIVE_INFINITY;
    }],
  ])("rejects %s without copying attacker-controlled content", (_label, mutate) => {
    const evidence = releasedEvidence();
    mutate(evidence);
    expect(sanitizeBrowserOutboundSpeechGateEvidence(evidence)).toBeNull();
  });

  it("uses a fixed content-free terminal rejection schema", () => {
    expect(browserOutboundSpeechGateRejection("client_validation")).toEqual({
      schemaVersion: 1,
      reason: "malformed_or_unsupported",
      stage: "client_validation",
    });
    expect(sanitizeBrowserOutboundSpeechGateRejection({
      schemaVersion: 1,
      reason: "malformed_or_unsupported",
      stage: "server_validation",
    })).toEqual(browserOutboundSpeechGateRejection("server_validation"));
    expect(sanitizeBrowserOutboundSpeechGateRejection({
      schemaVersion: 1,
      reason: "malformed_or_unsupported",
      stage: "server_validation",
      raw: "alice@example.test Bearer secret",
    })).toBeNull();
  });
});
