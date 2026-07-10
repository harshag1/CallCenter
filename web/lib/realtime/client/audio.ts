import type { Pcm16Audio, Pcm16Format } from "./types";

export const PCM16_MONO_24KHZ = {
  encoding: "pcm16",
  sampleRateHz: 24_000,
  channels: 1,
} as const satisfies Pcm16Format;

export function assertPcm16Format(format: Pcm16Format): void {
  if (format.encoding !== "pcm16") throw new Error("Realtime audio must be signed PCM16");
  if (format.channels !== 1) throw new Error("Realtime audio must be mono");
  if (!Number.isInteger(format.sampleRateHz) || format.sampleRateHz <= 0) {
    throw new Error("PCM sampleRateHz must be a positive integer");
  }
}

export function assertPcm16Audio(audio: Pcm16Audio, expected?: Pcm16Format): void {
  assertPcm16Format(audio);
  if (!(audio.data instanceof Uint8Array)) throw new Error("PCM audio data must be a Uint8Array");
  if (audio.data.byteLength === 0) throw new Error("PCM audio data cannot be empty");
  if (audio.data.byteLength % 2 !== 0) throw new Error("PCM16 audio must contain complete 16-bit samples");
  if (expected && (
    audio.encoding !== expected.encoding
    || audio.sampleRateHz !== expected.sampleRateHz
    || audio.channels !== expected.channels
  )) {
    throw new Error(
      `PCM format mismatch: expected ${expected.sampleRateHz} Hz mono ${expected.encoding}, `
      + `received ${audio.sampleRateHz} Hz/${audio.channels}ch ${audio.encoding}`,
    );
  }
}

export function pcm16ToBase64(audio: Pcm16Audio, expected?: Pcm16Format): string {
  assertPcm16Audio(audio, expected);
  return Buffer.from(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength).toString("base64");
}

export function base64ToPcm16(value: string): Uint8Array {
  if (!isCanonicalBase64(value)) throw new Error("Provider audio delta was not canonical base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Provider audio delta was not canonical base64");
  if (decoded.byteLength % 2 !== 0) throw new Error("Provider audio delta contained a partial PCM16 sample");
  return Uint8Array.from(decoded);
}

export function pcm16DurationMs(audio: Pcm16Audio): number {
  assertPcm16Audio(audio);
  return (audio.data.byteLength / 2 / audio.sampleRateHz) * 1_000;
}

export function chunkPcm16(audio: Pcm16Audio, maximumDurationMs: number): Pcm16Audio[] {
  assertPcm16Audio(audio);
  if (!Number.isFinite(maximumDurationMs) || maximumDurationMs <= 0) {
    throw new Error("maximumDurationMs must be positive");
  }
  const samplesPerChunk = Math.max(1, Math.floor(audio.sampleRateHz * maximumDurationMs / 1_000));
  const bytesPerChunk = samplesPerChunk * 2;
  const result: Pcm16Audio[] = [];
  for (let offset = 0; offset < audio.data.byteLength; offset += bytesPerChunk) {
    result.push({
      encoding: audio.encoding,
      sampleRateHz: audio.sampleRateHz,
      channels: audio.channels,
      data: audio.data.subarray(offset, Math.min(offset + bytesPerChunk, audio.data.byteLength)),
    });
  }
  return result;
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const firstPadding = value.indexOf("=");
  return firstPadding === -1 || firstPadding >= value.length - 2;
}
