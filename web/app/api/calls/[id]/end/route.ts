// Author: Harsha Gundala
// calls/[id]/end — closes a call and kicks the post-call analysis pipeline.

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { analyzeCall } from "@/lib/analysis";
import { isUuid } from "@/lib/http";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const call = await qOne<{ started_at: string }>(
    `SELECT c.started_at FROM calls c JOIN agents a ON a.id = c.agent_id
     WHERE c.id = $1 AND a.org_id = $2 AND c.status = 'active'`,
    [id, session.orgId]
  );
  if (!call) return NextResponse.json({ error: "not found" }, { status: 404 });
  await q(
    `UPDATE calls SET status = 'completed', ended_at = now(),
     duration_s = EXTRACT(EPOCH FROM (now() - started_at))::int WHERE id = $1`,
    [id]
  );

  // Post-call analysis — best-effort, never blocks the hangup.
  waitUntil(analyzeCall(id));
  return NextResponse.json({ ok: true });
}
