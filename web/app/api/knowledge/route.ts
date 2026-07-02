// Author: Harsha Gundala
// knowledge — document upload (multipart) with background ingestion, and listing.

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { ingestDocument } from "@/lib/knowledge";

export const maxDuration = 300;
const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: "no files" }, { status: 400 });

  const created: { id: string; filename: string }[] = [];
  for (const file of files.slice(0, 10)) {
    if (file.size > MAX_BYTES) continue;
    const buf = Buffer.from(await file.arrayBuffer());
    const row = await qOne<{ id: string }>(
      `INSERT INTO documents (org_id, filename, mime, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id`,
      [session.orgId, file.name, file.type || "application/octet-stream", file.size]
    );
    created.push({ id: row!.id, filename: file.name });
    waitUntil(ingestDocument(row!.id, buf));
  }
  return NextResponse.json({ ok: true, documents: created });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const docs = await q(
    "SELECT id, filename, mime, size_bytes, status, error, created_at FROM documents WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50",
    [session.orgId]
  );
  return NextResponse.json({ documents: docs });
}
