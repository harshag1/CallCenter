// Author: Harsha Gundala
// knowledge — file upload (multipart) routed by kind: knowledge (embed), media (raw audio), data (csv/json).

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { ingestDocument } from "@/lib/knowledge";
import { uploadKindFor, extOf, mimeFor, autoImportCsv } from "@/lib/files";
import { s3Enabled, putFile, fileKey } from "@/lib/storage";
import { log } from "@/lib/log";

const L = log("api/knowledge");

/** Puts raw bytes to S3 and records the key; returns false (caller falls back to bytea) on failure. */
async function storeToS3(orgId: string, documentId: string, filename: string, mime: string, buf: Buffer): Promise<boolean> {
  try {
    const key = fileKey(orgId, documentId, filename);
    await putFile(key, buf, mime);
    await q("UPDATE documents SET s3_key = $1 WHERE id = $2", [key, documentId]);
    return true;
  } catch (e) {
    L.warn("s3 put failed; using bytea fallback", { orgId, err: (e as Error).message, data: { documentId, filename } });
    return false;
  }
}

export const maxDuration = 300;
const MAX_BYTES = 20 * 1024 * 1024;
const EMBED_CSV_MAX = 2 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: "no files" }, { status: 400 });

  const created: { id: string; filename: string; kind: string }[] = [];
  const rejected: { filename: string; reason: string }[] = [];
  for (const file of files.slice(0, 10)) {
    if (file.size > MAX_BYTES) {
      rejected.push({ filename: file.name, reason: `exceeds ${MAX_BYTES / (1024 * 1024)}MB limit` });
      continue;
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const kind = uploadKindFor(file.name);
    const mime = file.type || mimeFor(file.name);

    if (kind === "knowledge") {
      const row = await qOne<{ id: string }>(
        `INSERT INTO documents (org_id, filename, mime, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id`,
        [session.orgId, file.name, mime, file.size]
      );
      if (s3Enabled()) await storeToS3(session.orgId, row!.id, file.name, mime, buf);
      created.push({ id: row!.id, filename: file.name, kind });
      waitUntil(ingestDocument(row!.id, buf));
      continue;
    }

    // media (mp3/wav/m4a) and data (csv/json): raw bytes to S3 when enabled (bytea otherwise);
    // CSVs always keep the bytea path (dataset auto-import + small-CSV embedding).
    const isCsv = kind === "data" && extOf(file.name) === "csv";
    const embedCsv = isCsv && file.size < EMBED_CSV_MAX;
    const useS3 = s3Enabled() && !isCsv;
    const row = await qOne<{ id: string }>(
      `INSERT INTO documents (org_id, filename, mime, size_bytes, kind, data, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        session.orgId, file.name, mime, file.size,
        kind, useS3 ? null : buf, embedCsv ? "ingesting" : "ready",
      ]
    );
    if (useS3 && !(await storeToS3(session.orgId, row!.id, file.name, mime, buf))) {
      await q("UPDATE documents SET data = $1 WHERE id = $2", [buf, row!.id]);
    }
    created.push({ id: row!.id, filename: file.name, kind });
    if (embedCsv) waitUntil(ingestDocument(row!.id, buf));
    // CSVs also become a first-class table: viewable, editable, agent-readable.
    if (isCsv) waitUntil(autoImportCsv(row!.id));
  }
  return NextResponse.json({ ok: true, documents: created, rejected });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const docs = await q(
    `SELECT id, filename, mime, kind, size_bytes, status, error, meta, created_at
     FROM documents WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [session.orgId]
  );
  return NextResponse.json({ documents: docs });
}
