import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  IndependentSpeechAsrReceipt,
} from "./outbound-speech-gate";
import {
  independentSpeechAsrReceiptDigestMessage,
  independentSpeechAsrReceiptHmacMessage,
} from "./outbound-speech-gate";
import {
  OUTBOUND_SPEECH_ASR_ENGINE,
  OUTBOUND_SPEECH_ASR_MODEL,
} from "./outbound-speech-asr-config.server";

const OPENAI_TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const SHA256 = /^[a-f0-9]{64}$/;
export const MAX_GUARDED_PCM_BYTES = 16 * 1024 * 1024;

export type GuardedSpeechAsrRequest = Readonly<{
  authorityId: string;
  organizationId: string;
  callId: string;
  responseId: string;
  provider: "openai" | "xai" | "gemini";
  pcm: Uint8Array;
  audioSha256: string;
  sampleRateHz: number;
  audioDurationMs: number;
}>;

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function wavFromPcm16(pcm: Uint8Array, sampleRateHz: number): Uint8Array {
  const output = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(output.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) output[offset + index] = text.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  output.set(pcm, 44);
  return output;
}

export function parseGuardedSpeechAsrRequest(value: unknown): Readonly<{
  schemaVersion: 1;
  callId: string;
  responseId: string;
  provider: "openai" | "xai" | "gemini";
  pcm: Uint8Array;
  audioSha256: string;
  sampleRateHz: number;
  audioDurationMs: number;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guarded speech ASR request is invalid");
  }
  const root = value as Record<string, unknown>;
  const audio = root.audio && typeof root.audio === "object" && !Array.isArray(root.audio)
    ? root.audio as Record<string, unknown>
    : null;
  if (root.schemaVersion !== 1 || !audio || audio.encoding !== "pcm16" || audio.channels !== 1) {
    throw new Error("guarded speech ASR request schema is invalid");
  }
  exactKeys(root, ["schemaVersion", "callId", "responseId", "provider", "audio"], "guarded speech ASR request");
  exactKeys(
    audio,
    ["encoding", "sampleRateHz", "channels", "base64", "sha256", "bytes", "durationMs"],
    "guarded speech ASR audio",
  );
  const boundedIdentity = (candidate: unknown, label: string, max: number) => {
    if (
      typeof candidate !== "string"
      || !candidate
      || candidate.length > max
      || /[\u0000-\u001f\u007f]/u.test(candidate)
    ) throw new Error(`${label} is invalid`);
    return candidate;
  };
  const callId = boundedIdentity(root.callId, "callId", 128);
  const responseId = boundedIdentity(root.responseId, "responseId", 512);
  if (root.provider !== "openai" && root.provider !== "xai" && root.provider !== "gemini") {
    throw new Error("guarded speech ASR provider is invalid");
  }
  if (
    typeof audio.base64 !== "string"
    || audio.base64.length === 0
    || audio.base64.length > Math.ceil(MAX_GUARDED_PCM_BYTES / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.base64)
  ) {
    throw new Error("guarded speech ASR PCM is invalid");
  }
  const pcmBuffer = Buffer.from(audio.base64, "base64");
  if (
    pcmBuffer.byteLength === 0
    || pcmBuffer.byteLength > MAX_GUARDED_PCM_BYTES
    || pcmBuffer.byteLength % 2 !== 0
    || pcmBuffer.toString("base64") !== audio.base64
  ) {
    throw new Error("guarded speech ASR PCM is non-canonical or outside its safety bound");
  }
  if (!Number.isSafeInteger(audio.bytes) || audio.bytes !== pcmBuffer.byteLength) {
    throw new Error("guarded speech ASR byte count is invalid");
  }
  if (
    !Number.isSafeInteger(audio.sampleRateHz)
    || (audio.sampleRateHz as number) < 8_000
    || (audio.sampleRateHz as number) > 96_000
  ) {
    throw new Error("guarded speech ASR sample rate is invalid");
  }
  const expectedDuration = pcmBuffer.byteLength / 2 / (audio.sampleRateHz as number) * 1_000;
  if (
    typeof audio.durationMs !== "number"
    || !Number.isFinite(audio.durationMs)
    || Math.abs(audio.durationMs - expectedDuration) > 0.001
  ) {
    throw new Error("guarded speech ASR duration is invalid");
  }
  if (typeof audio.sha256 !== "string" || !SHA256.test(audio.sha256)) {
    throw new Error("guarded speech ASR audio hash is invalid");
  }
  const actualSha256 = createHash("sha256").update(pcmBuffer).digest("hex");
  if (actualSha256 !== audio.sha256) throw new Error("guarded speech ASR audio hash mismatched");
  return Object.freeze({
    schemaVersion: 1,
    callId,
    responseId,
    provider: root.provider,
    pcm: new Uint8Array(pcmBuffer),
    audioSha256: actualSha256,
    sampleRateHz: audio.sampleRateHz as number,
    audioDurationMs: expectedDuration,
  });
}

export async function transcribeGuardedSpeech(
  input: GuardedSpeechAsrRequest,
  apiKey: string,
  receiptHmacKey: string,
): Promise<IndependentSpeechAsrReceipt> {
  if (!apiKey) throw new Error("guarded speech independent ASR is unavailable");
  const wav = wavFromPcm16(input.pcm, input.sampleRateHz);
  const wavBody = new Uint8Array(wav.byteLength);
  wavBody.set(wav);
  const form = new FormData();
  form.append("file", new Blob([wavBody.buffer], { type: "audio/wav" }), "guarded-response.wav");
  form.append("model", OUTBOUND_SPEECH_ASR_MODEL);
  form.append("language", "en");
  const response = await fetch(OPENAI_TRANSCRIPTION_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`guarded speech independent ASR failed with status ${response.status}`);
  const body = await response.json() as { text?: unknown };
  if (typeof body.text !== "string" || body.text.length > 32_000) {
    throw new Error("guarded speech independent ASR returned invalid text");
  }
  return createGuardedSpeechAsrReceipt({
    authorityId: input.authorityId,
    organizationId: input.organizationId,
    callId: input.callId,
    provider: input.provider,
    responseId: input.responseId,
    text: body.text,
    audioSha256: input.audioSha256,
    audioBytes: input.pcm.byteLength,
    sampleRateHz: input.sampleRateHz,
  }, receiptHmacKey);
}

export function createGuardedSpeechAsrReceipt(
  input: Readonly<{
    authorityId: string;
    organizationId: string;
    callId: string;
    provider: "openai" | "xai" | "gemini";
    responseId: string;
    text: string;
    audioSha256: string;
    audioBytes: number;
    sampleRateHz: number;
  }>,
  receiptHmacKey: string,
): IndependentSpeechAsrReceipt {
  const core = Object.freeze({
    schemaVersion: 2 as const,
    authorityId: input.authorityId,
    organizationId: input.organizationId,
    callId: input.callId,
    provider: input.provider,
    responseId: input.responseId,
    text: input.text,
    transcriptSha256: createHash("sha256").update(input.text).digest("hex"),
    audioSha256: input.audioSha256,
    audioBytes: input.audioBytes,
    sampleRateHz: input.sampleRateHz,
    channels: 1 as const,
    complete: true as const,
    engine: OUTBOUND_SPEECH_ASR_ENGINE,
    model: OUTBOUND_SPEECH_ASR_MODEL,
    decision: "transcribed" as const,
  });
  const receiptHmacSha256 = createHmac("sha256", receiptHmacKey)
    .update(independentSpeechAsrReceiptHmacMessage(core))
    .digest("hex");
  const signed = Object.freeze({ ...core, receiptHmacSha256 });
  return Object.freeze({
    ...signed,
    receiptSha256: createHash("sha256")
      .update(independentSpeechAsrReceiptDigestMessage(signed))
      .digest("hex"),
  });
}

export function verifyGuardedSpeechAsrReceipt(
  value: unknown,
  expected: Readonly<{
    organizationId: string;
    callId: string;
    provider: "openai" | "xai" | "gemini";
    responseId: string;
    audioSha256: string;
    audioBytes: number;
    sampleRateHz: number;
  }>,
  receiptHmacKey: string,
): IndependentSpeechAsrReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guarded speech ASR receipt is invalid");
  }
  const receipt = value as IndependentSpeechAsrReceipt;
  if (
    receipt.schemaVersion !== 2
    || receipt.organizationId !== expected.organizationId
    || receipt.callId !== expected.callId
    || receipt.provider !== expected.provider
    || receipt.responseId !== expected.responseId
    || receipt.audioSha256 !== expected.audioSha256
    || receipt.audioBytes !== expected.audioBytes
    || receipt.sampleRateHz !== expected.sampleRateHz
    || receipt.channels !== 1
    || receipt.complete !== true
    || receipt.engine !== OUTBOUND_SPEECH_ASR_ENGINE
    || receipt.model !== OUTBOUND_SPEECH_ASR_MODEL
    || receipt.decision !== "transcribed"
    || typeof receipt.text !== "string"
    || createHash("sha256").update(receipt.text).digest("hex") !== receipt.transcriptSha256
    || typeof receipt.receiptHmacSha256 !== "string"
    || !SHA256.test(receipt.receiptHmacSha256)
    || typeof receipt.receiptSha256 !== "string"
    || !SHA256.test(receipt.receiptSha256)
  ) {
    throw new Error("guarded speech ASR receipt binding is invalid");
  }
  const expectedHmac = createHmac("sha256", receiptHmacKey)
    .update(independentSpeechAsrReceiptHmacMessage(receipt))
    .digest();
  const suppliedHmac = Buffer.from(receipt.receiptHmacSha256, "hex");
  if (
    suppliedHmac.byteLength !== expectedHmac.byteLength
    || !timingSafeEqual(suppliedHmac, expectedHmac)
  ) {
    throw new Error("guarded speech ASR receipt authentication failed");
  }
  const receiptSha256 = createHash("sha256")
    .update(independentSpeechAsrReceiptDigestMessage(receipt))
    .digest("hex");
  if (receiptSha256 !== receipt.receiptSha256) {
    throw new Error("guarded speech ASR receipt digest failed");
  }
  return Object.freeze({ ...receipt });
}
