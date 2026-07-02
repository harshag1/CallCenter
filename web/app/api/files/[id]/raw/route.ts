// Author: Harsha Gundala
// files/[id]/raw — serves stored media/data file bytes (org-scoped) for playback and download.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { qOne } from "@/lib/db";
import { mimeFor } from "@/lib/files";
import { isUuid } from "@/lib/http";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const doc = await qOne<{ mime: string; data: Buffer | null; filename: string }>(
    "SELECT mime, data, filename FROM documents WHERE id = $1 AND org_id = $2",
    [id, session.orgId]
  );
  if (!doc?.data) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Prefer a concrete type so browsers can inline-play/preview; some uploads stored octet-stream.
  const contentType =
    doc.mime && doc.mime !== "application/octet-stream" ? doc.mime : mimeFor(doc.filename);
  return new Response(new Uint8Array(doc.data), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
