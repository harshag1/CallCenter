import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createGuardedSpeechAsrReceipt,
  parseGuardedSpeechAsrRequest,
  transcribeGuardedSpeech,
  verifyGuardedSpeechAsrReceipt,
} from "./outbound-speech-asr.server";

afterEach(() => vi.unstubAllGlobals());
const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000a1";
const AUTHORITY_ID = "00000000-0000-4000-8000-0000000000d1";
const RECEIPT_KEY = "independent-test-receipt-key-at-least-32-bytes";

function request() {
  const pcm = Buffer.from([1, 0, 2, 0]);
  return {
    schemaVersion: 1,
    callId: "00000000-0000-4000-8000-000000000092",
    responseId: "response-safe",
    provider: "xai",
    audio: {
      encoding: "pcm16",
      sampleRateHz: 24_000,
      channels: 1,
      base64: pcm.toString("base64"),
      sha256: createHash("sha256").update(pcm).digest("hex"),
      bytes: pcm.byteLength,
      durationMs: pcm.byteLength / 2 / 24_000 * 1_000,
    },
  };
}

describe("exact-PCM browser speech ASR boundary", () => {
  it("rejects byte, hash, and duration ambiguity before paid ASR", () => {
    const valid = parseGuardedSpeechAsrRequest(request());
    expect(valid.pcm).toEqual(new Uint8Array([1, 0, 2, 0]));
    expect(valid.audioSha256).toMatch(/^[a-f0-9]{64}$/);

    expect(() => parseGuardedSpeechAsrRequest({
      ...request(),
      audio: { ...request().audio, bytes: 2 },
    })).toThrow("byte count");
    expect(() => parseGuardedSpeechAsrRequest({
      ...request(),
      audio: { ...request().audio, sha256: "0".repeat(64) },
    })).toThrow("hash mismatched");
    expect(() => parseGuardedSpeechAsrRequest({
      ...request(),
      retry: true,
    })).toThrow("unsupported fields");
    expect(() => parseGuardedSpeechAsrRequest({
      ...request(),
      audio: { ...request().audio, formatHint: "trusted" },
    })).toThrow("unsupported fields");
  });

  it("returns a receipt bound to the exact WAV source PCM", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.body).toBeInstanceOf(FormData);
      return Response.json({ text: "This is safe." });
    });
    vi.stubGlobal("fetch", fetchMock);
    const parsed = parseGuardedSpeechAsrRequest(request());
    const receipt = await transcribeGuardedSpeech({
      authorityId: AUTHORITY_ID,
      organizationId: ORGANIZATION_ID,
      callId: parsed.callId,
      responseId: parsed.responseId,
      provider: parsed.provider,
      pcm: parsed.pcm,
      audioSha256: parsed.audioSha256,
      sampleRateHz: parsed.sampleRateHz,
      audioDurationMs: parsed.audioDurationMs,
    }, "test-asr-key", RECEIPT_KEY);

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      authorityId: AUTHORITY_ID,
      organizationId: ORGANIZATION_ID,
      callId: parsed.callId,
      provider: parsed.provider,
      responseId: parsed.responseId,
      text: "This is safe.",
      transcriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      audioSha256: parsed.audioSha256,
      audioBytes: 4,
      sampleRateHz: 24_000,
      channels: 1,
      complete: true,
      engine: "openai_audio_transcriptions",
      model: "whisper-1",
      decision: "transcribed",
      receiptHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(verifyGuardedSpeechAsrReceipt(receipt, {
      organizationId: ORGANIZATION_ID,
      callId: parsed.callId,
      provider: parsed.provider,
      responseId: parsed.responseId,
      audioSha256: parsed.audioSha256,
      audioBytes: parsed.pcm.byteLength,
      sampleRateHz: parsed.sampleRateHz,
    }, RECEIPT_KEY)).toEqual(receipt);
  });

  it("authenticates every call/provider/response/audio/transcript/model/decision binding", () => {
    const parsed = parseGuardedSpeechAsrRequest(request());
    const receipt = createGuardedSpeechAsrReceipt({
      authorityId: AUTHORITY_ID,
      organizationId: ORGANIZATION_ID,
      callId: parsed.callId,
      provider: parsed.provider,
      responseId: parsed.responseId,
      text: "Safe transcript",
      audioSha256: parsed.audioSha256,
      audioBytes: parsed.pcm.byteLength,
      sampleRateHz: parsed.sampleRateHz,
    }, RECEIPT_KEY);
    const expected = {
      organizationId: ORGANIZATION_ID,
      callId: parsed.callId,
      provider: parsed.provider,
      responseId: parsed.responseId,
      audioSha256: parsed.audioSha256,
      audioBytes: parsed.pcm.byteLength,
      sampleRateHz: parsed.sampleRateHz,
    };
    for (const candidate of [
      { ...receipt, organizationId: "00000000-0000-4000-8000-0000000000b2" },
      { ...receipt, callId: "00000000-0000-4000-8000-0000000000c2" },
      { ...receipt, provider: "openai" },
      { ...receipt, responseId: "response-substituted" },
      { ...receipt, audioSha256: "0".repeat(64) },
      { ...receipt, audioBytes: receipt.audioBytes + 2 },
      { ...receipt, sampleRateHz: 48_000 },
      { ...receipt, text: "tampered transcript" },
      { ...receipt, model: "substituted-model" },
      { ...receipt, decision: "release" },
      { ...receipt, receiptHmacSha256: "0".repeat(64) },
      { ...receipt, receiptSha256: "0".repeat(64) },
    ]) {
      expect(() => verifyGuardedSpeechAsrReceipt(
        candidate,
        expected,
        RECEIPT_KEY,
      )).toThrow();
    }
  });
});
