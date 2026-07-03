// Author: Harsha Gundala
// knowledge.ts — document ingestion (parse → chunk → embed → pgvector) and semantic search.

import { q, qOne } from "./db";
import { log } from "./log";

const L = log("knowledge");
const EMBED_MODEL = "text-embedding-3-small";
const CHUNK_CHARS = 2800;
const CHUNK_OVERLAP = 300;

async function embed(texts: string[]): Promise<number[][]> {
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

function chunk(text: string): string[] {
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + CHUNK_CHARS, clean.length);
    if (end < clean.length) {
      const brk = clean.lastIndexOf("\n", end);
      if (brk > i + CHUNK_CHARS / 2) end = brk;
    }
    chunks.push(clean.slice(i, end).trim());
    i = end - (end < clean.length ? CHUNK_OVERLAP : 0);
  }
  return chunks.filter((c) => c.length > 40);
}

/** Full ingestion for one uploaded document. Safe to run via waitUntil. */
export async function ingestDocument(documentId: string, buf: Buffer): Promise<void> {
  const doc = await qOne<{ org_id: string; filename: string; mime: string }>(
    "SELECT org_id, filename, mime FROM documents WHERE id = $1", [documentId]
  );
  if (!doc) return;
  try {
    const text = await extractText(buf, doc.mime, doc.filename);
    const pieces = chunk(text);
    if (!pieces.length) throw new Error("no extractable text");

    for (let i = 0; i < pieces.length; i += 64) {
      const batch = pieces.slice(i, i + 64);
      const vectors = await embed(batch);
      const values: string[] = [];
      const params: unknown[] = [];
      batch.forEach((content, j) => {
        const base = params.length;
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
        params.push(documentId, doc.org_id, i + j, content, JSON.stringify(vectors[j]));
      });
      await q(
        `INSERT INTO doc_chunks (document_id, org_id, chunk_index, content, embedding) VALUES ${values.join(",")}`,
        params
      );
    }
    await q("UPDATE documents SET status = 'ready' WHERE id = $1", [documentId]);
    L.info("ingested", { orgId: doc.org_id, data: { documentId, chunks: pieces.length } });
  } catch (e) {
    await q("UPDATE documents SET status = 'failed', error = $2 WHERE id = $1", [documentId, (e as Error).message]);
    L.error("ingest failed", { orgId: doc.org_id, err: (e as Error).message });
  }
}

export type KnowledgeHit = { content: string; filename: string; score: number };

export async function searchKnowledge(orgId: string, query: string, limit = 6): Promise<KnowledgeHit[]> {
  const [vector] = await embed([query]);
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
