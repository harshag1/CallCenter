// Author: Harsha Gundala
// knowledge.ts — document ingestion (parse → chunk → embed → vector store) and semantic search.
// Primary: Modal CLIP ViT-B-32 (512-dim) + TurboPuffer. Fallback: OpenAI text-embedding-3-small + pgvector.

import { q, qOne } from "./db";
import { tpufEnabled, tpufUpsert, tpufQuery } from "./vector";
import { log } from "./log";

const L = log("knowledge");
const EMBED_MODEL = "text-embedding-3-small";
const CLIP_BATCH = 128;
const TPUF_CONTENT_CAP = 2400;

// CLIP's text encoder has a hard 77-token context (~280 chars of English) — anything longer is
// silently truncated by the tokenizer, so clip-tpuf mode chunks fine-grained with sentence-aware
// breaks. OpenAI embeddings take 8k tokens, so the fallback keeps the original coarse chunks.
const CHUNKING: Record<RagMode, { chars: number; overlap: number; min: number }> = {
  "clip-tpuf": { chars: 280, overlap: 40, min: 20 },
  "openai-pgvector": { chars: 2800, overlap: 300, min: 40 },
};

export type RagMode = "clip-tpuf" | "openai-pgvector";

/** Provider selection for BOTH ingest and search, so 512-dim CLIP vectors live only in TurboPuffer
 * and pgvector stays 1536-dim. A half-configured primary (e.g. Modal set but no TURBOPUFFER_API_KEY,
 * today's live situation) falls back to OpenAI + pgvector as a whole — reads and writes never split. */
export function ragMode(): RagMode {
  return process.env.MODAL_EMBED_URL && process.env.MODAL_EMBED_SECRET && tpufEnabled()
    ? "clip-tpuf"
    : "openai-pgvector";
}

const orgNamespace = (orgId: string) => `org-${orgId}`;

/** CLIP text embeddings from the Modal endpoint. L2-normalized 512-dim; batches of ≤128. */
export async function embedClip(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += CLIP_BATCH) {
    const res = await fetch(process.env.MODAL_EMBED_URL!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MODAL_EMBED_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ texts: texts.slice(i, i + CLIP_BATCH) }),
    });
    if (!res.ok) throw new Error(`clip embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { embeddings: number[][] };
    out.push(...json.embeddings);
  }
  return out;
}

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.data.map((d: { embedding: number[] }) => d.embedding);
}

async function extractText(buf: Buffer, mime: string, filename: string): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (mime.includes("pdf") || ext === "pdf") {
    // unpdf ships a serverless pdfjs build — no DOM globals needed (pdf-parse broke on Vercel).
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(buf), { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  }
  if (mime.includes("wordprocessingml") || ext === "docx") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: buf })).value;
  }
  return buf.toString("utf8"); // txt, md, csv, json, code
}

/** Last natural break in a window: sentence end, then newline, then word boundary. */
function lastBreak(win: string): number {
  let best = -1;
  const re = /[.!?]["')\]]?(?=\s)/g;
  for (let m = re.exec(win); m; m = re.exec(win)) best = m.index + m[0].length;
  if (best > 0) return best;
  const nl = win.lastIndexOf("\n");
  return nl > 0 ? nl : win.lastIndexOf(" ");
}

function chunk(text: string, mode: RagMode): string[] {
  const { chars, overlap, min } = CHUNKING[mode];
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + chars, clean.length);
    if (end < clean.length) {
      const half = i + Math.floor(chars / 2);
      const brk = lastBreak(clean.slice(half, end));
      if (brk > 0) end = half + brk;
    }
    chunks.push(clean.slice(i, end).trim());
    i = end - (end < clean.length ? overlap : 0);
  }
  return chunks.filter((c) => c.length >= min);
}

async function ingestClipTpuf(documentId: string, orgId: string, filename: string, pieces: string[]): Promise<void> {
  for (let i = 0; i < pieces.length; i += CLIP_BATCH) {
    const batch = pieces.slice(i, i + CLIP_BATCH);
    const vectors = await embedClip(batch);
    await tpufUpsert(
      orgNamespace(orgId),
      batch.map((content, j) => ({
        id: `${documentId}:${i + j}`,
        vector: vectors[j],
        attributes: {
          document_id: documentId,
          org_id: orgId,
          filename,
          chunk_index: i + j,
          content: content.slice(0, TPUF_CONTENT_CAP),
        },
      }))
    );
  }
}

async function ingestPgvector(documentId: string, orgId: string, pieces: string[]): Promise<void> {
  for (let i = 0; i < pieces.length; i += 64) {
    const batch = pieces.slice(i, i + 64);
    const vectors = await embedOpenAI(batch);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((content, j) => {
      const base = params.length;
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
      params.push(documentId, orgId, i + j, content, JSON.stringify(vectors[j]));
    });
    await q(
      `INSERT INTO doc_chunks (document_id, org_id, chunk_index, content, embedding) VALUES ${values.join(",")}`,
      params
    );
  }
}

/** Full ingestion for one uploaded document. Safe to run via waitUntil. */
export async function ingestDocument(documentId: string, buf: Buffer): Promise<void> {
  const doc = await qOne<{ org_id: string; filename: string; mime: string }>(
    "SELECT org_id, filename, mime FROM documents WHERE id = $1", [documentId]
  );
  if (!doc) return;
  const mode = ragMode();
  try {
    const text = await extractText(buf, doc.mime, doc.filename);
    const pieces = chunk(text, mode);
    if (!pieces.length) throw new Error("no extractable text");

    if (mode === "clip-tpuf") {
      await ingestClipTpuf(documentId, doc.org_id, doc.filename, pieces);
    } else {
      await ingestPgvector(documentId, doc.org_id, pieces);
    }
    await q("UPDATE documents SET status = 'ready' WHERE id = $1", [documentId]);
    L.info("ingested", { orgId: doc.org_id, data: { documentId, chunks: pieces.length, mode } });
  } catch (e) {
    await q("UPDATE documents SET status = 'failed', error = $2 WHERE id = $1", [documentId, (e as Error).message]);
    L.error("ingest failed", { orgId: doc.org_id, err: (e as Error).message });
  }
}

export type KnowledgeHit = { content: string; filename: string; score: number };

export async function searchKnowledge(orgId: string, query: string, limit = 6): Promise<KnowledgeHit[]> {
  if (ragMode() === "clip-tpuf") {
    const [vector] = await embedClip([query]);
    const hits = await tpufQuery(orgNamespace(orgId), vector, limit);
    return hits.map((h) => ({
      content: String(h.attributes.content ?? ""),
      filename: String(h.attributes.filename ?? ""),
      score: h.score,
    }));
  }
  const [vector] = await embedOpenAI([query]);
  return q<KnowledgeHit>(
    `SELECT c.content, d.filename, 1 - (c.embedding <=> $2::vector) AS score
     FROM doc_chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.org_id = $1 AND d.status = 'ready'
     ORDER BY c.embedding <=> $2::vector
     LIMIT $3`,
    [orgId, JSON.stringify(vector), limit]
  );
}

export async function hasReadyDocuments(orgId: string): Promise<boolean> {
  return !!(await qOne("SELECT id FROM documents WHERE org_id = $1 AND status = 'ready' LIMIT 1", [orgId]));
}
