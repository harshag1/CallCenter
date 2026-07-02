// Author: Harsha Gundala
// files/[id]/raw — serves stored media/data file bytes (org-scoped) for playback and download.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { qOne } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const doc = await qOne<{ mime: string; data: Buffer | null; filename: string }>(
    "SELECT mime, data, filename FROM documents WHERE id = $1 AND org_id = $2",
    [id, session.orgId]
  );
  if (!doc?.data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new Response(new Uint8Array(doc.data), {
    headers: {
      "Content-Type": doc.mime,
      "Content-Disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
