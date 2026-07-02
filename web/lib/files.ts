// Author: Harsha Gundala
// files.ts — upload kind routing + hold-music transcode (mp3 → mono 8kHz μ-law rendition).

import { q, qOne } from "./db";
import { floatToUlawBuffer } from "./audio";
import { log } from "./log";

const L = log("files");

const MEDIA_EXT = new Set(["mp3", "wav", "m4a"]);
const DATA_EXT = new Set(["csv", "json"]);

export function extOf(filename: string): string {
  return filename.toLowerCase().split(".").pop() ?? "";
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

/** Best-effort content type from the filename; used when the client omits File.type. */
export function mimeFor(filename: string): string {
  return MIME_BY_EXT[extOf(filename)] ?? "application/octet-stream";
}

/** Routes an upload to its documents.kind: media (audio), data (tabular), knowledge (embed path). */
export function uploadKindFor(filename: string): "media" | "data" | "knowledge" {
  const ext = extOf(filename);
  if (MEDIA_EXT.has(ext)) return "media";
  if (DATA_EXT.has(ext)) return "data";
  return "knowledge";
}

function toMono(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 1) return channelData[0];
  const n = channelData[0].length;
  const mono = new Float32Array(n);
  for (const ch of channelData) {
    for (let i = 0; i < n; i++) mono[i] += ch[i] / channelData.length;
  }
  return mono;
}

function resampleTo8k(samples: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === 8000) return samples;
  const ratio = sourceRate / 8000;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = samples[Math.floor(i * ratio)];
  return out;
}

/** Decodes an mp3 document and stores a 'ulaw8k' media rendition for telephony hold music. */
export async function transcodeHoldMusic(documentId: string): Promise<void> {
  const doc = await qOne<{ org_id: string; filename: string; data: Buffer | null }>(
    "SELECT org_id, filename, data FROM documents WHERE id = $1", [documentId]
  );
  if (!doc?.data?.length) return;
  if (extOf(doc.filename) !== "mp3") {
    L.warn("hold-music transcode skipped: only mp3 supported", { orgId: doc.org_id, data: { documentId, filename: doc.filename } });
    return;
  }
  try {
    const { MPEGDecoder } = await import("mpg123-decoder");
    const decoder = new MPEGDecoder();
    await decoder.ready;
    let decoded;
    try {
      decoded = decoder.decode(new Uint8Array(doc.data));
    } finally {
      decoder.free();
    }
    if (!decoded.channelData.length || !decoded.samplesDecoded) throw new Error("no audio decoded");

    const ulaw = floatToUlawBuffer(resampleTo8k(toMono(decoded.channelData), decoded.sampleRate));
    await q(
      `INSERT INTO media_renditions (document_id, kind, data) VALUES ($1,'ulaw8k',$2)
       ON CONFLICT (document_id, kind) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
      [documentId, ulaw]
    );
    L.info("hold music transcoded", { orgId: doc.org_id, data: { documentId, seconds: Math.round(ulaw.length / 8000) } });
  } catch (e) {
    L.error("hold-music transcode failed", { orgId: doc.org_id, err: (e as Error).message, data: { documentId } });
  }
}
