// Author: Harsha Gundala
// knowledge — file upload (multipart) routed by kind: knowledge (embed), media (raw audio), data (csv/json).

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { ingestDocument } from "@/lib/knowledge";
import { uploadKindFor, extOf, mimeFor, autoImportCsv } from "@/lib/files";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateFormData,
} from "@/lib/private-json-request";

export const maxDuration = 300;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = 64 * 1024 * 1024;
const EMBED_CSV_MAX = 2 * 1024 * 1024;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function POST(req: Request) {
  try {
    assertSameOriginBrowserMutation(req);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 403;
    return json({ error: "forbidden" }, status);
  }
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  let form: FormData;
  try {
    form = await readPrivateFormData(req, MAX_UPLOAD_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return json({ error: status === 413 ? "payload too large" : "invalid upload" }, status);
  }
  if ([...form.keys()].some((key) => key !== "files")) {
    return json({ error: "invalid upload" }, 400);
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return json({ error: "no files" }, 400);

  const created: { id: string; filename: string; kind: string }[] = [];
  const rejected: { filename: string; reason: string }[] = [];
  for (const file of files.slice(0, 10)) {
    if (
      file.name.length === 0
      || file.name.length > 255
      || /[\u0000-\u001f\u007f]/.test(file.name)
      || file.type.length > 255
      || /[\u0000-\u001f\u007f]/.test(file.type)
    ) {
      rejected.push({ filename: "invalid filename", reason: "invalid file metadata" });
      continue;
    }
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
      created.push({ id: row!.id, filename: file.name, kind });
      waitUntil(ingestDocument(row!.id, buf));
      continue;
    }

    // media (mp3/wav/m4a) and data (csv/json): store raw bytes; embed small CSVs as searchable text.
    const embedCsv = kind === "data" && extOf(file.name) === "csv" && file.size < EMBED_CSV_MAX;
    const row = await qOne<{ id: string }>(
      `INSERT INTO documents (org_id, filename, mime, size_bytes, kind, data, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        session.orgId, file.name, mime, file.size,
        kind, buf, embedCsv ? "ingesting" : "ready",
      ]
    );
    created.push({ id: row!.id, filename: file.name, kind });
    if (embedCsv) waitUntil(ingestDocument(row!.id, buf));
    // CSVs also become a first-class table: viewable, editable, agent-readable.
    if (kind === "data" && extOf(file.name) === "csv") waitUntil(autoImportCsv(row!.id));
  }
  return json({ ok: true, documents: created, rejected });
}

export async function GET() {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const docs = await q(
    `SELECT id, filename, mime, kind, size_bytes, status, error, meta, created_at
     FROM documents WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [session.orgId]
  );
  return json({ documents: docs });
}
