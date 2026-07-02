// Author: Harsha Gundala
// stt.ts — μ-law → Whisper transcription for post-transfer human-leg audio. Never throws.

import { ulawToWav } from "./audio";
import { log } from "./log";

const L = log("stt");
const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/** Transcribes 8kHz μ-law audio (English). Returns "" on any failure. */
export async function transcribeUlaw(ulawBuf: Buffer): Promise<string> {
  if (!ulawBuf.length || !process.env.OPENAI_API_KEY) return "";
  try {
    const wav = ulawToWav(ulawBuf);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "segment.wav");
    form.append("model", "whisper-1");
    form.append("language", "en");
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      L.warn("transcription failed", { data: { status: res.status } });
      return "";
    }
    const body = (await res.json()) as { text?: string };
    return typeof body.text === "string" ? body.text.trim() : "";
  } catch (e) {
    L.warn("transcription error", { data: { err: (e as Error).message } });
    return "";
  }
}
