// Author: Harsha Gundala
// calls/[id]/recording — upload (from call widget) and playback of call audio.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { ulawToWav } from "@/lib/audio";
import { isUuid } from "@/lib/http";

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const owned = await qOne(
    "SELECT c.id FROM calls c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1 AND a.org_id = $2",
    [id, session.orgId]
  );
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) return NextResponse.json({ error: "bad size" }, { status: 413 });
  const mime = req.headers.get("content-type") ?? "audio/webm";
  await q(
    `INSERT INTO call_recordings (call_id, mime, data) VALUES ($1,$2,$3)
     ON CONFLICT (call_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`,
    [id, mime, buf]
  );
  await q("UPDATE calls SET recording_path = $2 WHERE id = $1", [id, `db:${id}`]);
  return NextResponse.json({ ok: true });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rec = await qOne<{ mime: string; data: Buffer }>(
    `SELECT r.mime, r.data FROM call_recordings r
     JOIN calls c ON c.id = r.call_id JOIN agents a ON a.id = c.agent_id
     WHERE r.call_id = $1 AND a.org_id = $2`,
    [id, session.orgId]
  );
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (rec.mime.startsWith("audio/basic")) {
    // Bridge recordings are raw 8kHz μ-law — wrap in a WAV container for browser playback.
    // No max-age: the body grows while the call is live.
    return new Response(new Uint8Array(ulawToWav(rec.data)), {
      headers: { "Content-Type": "audio/wav", "Cache-Control": "private, no-store" },
    });
  }
  return new Response(new Uint8Array(rec.data), {
    headers: { "Content-Type": rec.mime, "Cache-Control": "private, max-age=3600" },
  });
}
