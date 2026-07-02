// Author: Harsha Gundala
// calls/[id]/events — transcript/tool event ingestion from the call widget + polling reads.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { readJson, isUuid } from "@/lib/http";

async function ownsCall(callId: string, orgId: string) {
  if (!isUuid(callId)) return null;
  return qOne(
    "SELECT c.id FROM calls c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1 AND a.org_id = $2",
    [callId, orgId]
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await ownsCall(id, session.orgId))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await readJson<{ events?: unknown }>(req);
  if (!body || !Array.isArray(body.events)) {
    return NextResponse.json({ error: "events array required" }, { status: 400 });
  }
  for (const ev of (body.events as { type?: unknown; payload?: unknown }[]).slice(0, 50)) {
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string") continue;
    await q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,$2,$3)", [
      id, ev.type.slice(0, 40), JSON.stringify(ev.payload ?? {}),
    ]);
  }
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await ownsCall(id, session.orgId))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const after = Math.min(Math.max(Number(new URL(req.url).searchParams.get("after") ?? 0) || 0, 0), Number.MAX_SAFE_INTEGER);
  const events = await q(
    "SELECT id, ts, type, payload FROM call_events WHERE call_id = $1 AND id > $2 ORDER BY id LIMIT 300",
    [id, after]
  );
  return NextResponse.json({ events });
}
