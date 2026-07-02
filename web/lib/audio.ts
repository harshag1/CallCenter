// Author: Harsha Gundala
// audio.ts — G.711 μ-law codec, sample mixing, and WAV container helpers for 8kHz telephony audio.

const BIAS = 0x84;
const CLIP = 32635;

/** μ-law byte → PCM16 lookup table (built once at module load). */
const ULAW_TO_PCM = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  ULAW_TO_PCM[i] = u & 0x80 ? -magnitude : magnitude;
}

/** Encode one PCM16 sample to a μ-law byte. */
export function ulawEncodeSample(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function ulawDecode(ulaw: Uint8Array): Int16Array {
  const pcm = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) pcm[i] = ULAW_TO_PCM[ulaw[i]];
  return pcm;
}

export function ulawEncode(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = ulawEncodeSample(pcm[i]);
  return out;
}

/** Mix two μ-law streams into one (decode → sum with clipping → re-encode). Shorter input is zero-padded. */
export function mixUlaw(a: Uint8Array, b: Uint8Array): Buffer {
  const n = Math.max(a.length, b.length);
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) {
    const sum = (i < a.length ? ULAW_TO_PCM[a[i]] : 0) + (i < b.length ? ULAW_TO_PCM[b[i]] : 0);
    out[i] = ulawEncodeSample(sum < -32768 ? -32768 : sum > 32767 ? 32767 : sum);
  }
  return out;
}

/** Wrap mono PCM16 samples in a WAV (RIFF) container. */
export function pcm16ToWav(pcm: Int16Array, rate = 8000): Buffer {
  const dataLen = pcm.length * 2;
  const buf = Buffer.allocUnsafe(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits/sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

/** μ-law bytes → playable WAV buffer. */
export function ulawToWav(ulaw: Uint8Array, rate = 8000): Buffer {
  return pcm16ToWav(ulawDecode(ulaw), rate);
}

/** Encodes float PCM (-1..1) to a μ-law byte buffer (hold-music transcode path). */
export function floatToUlawBuffer(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = ulawEncodeSample(Math.round(clamped * 32_767));
  }
  return out;
}
