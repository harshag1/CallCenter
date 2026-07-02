// Author: Harsha Gundala
// telephony/events — scope-authenticated event ingestion + call completion from the bridge.

import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { verifyScope } from "@/lib/voice";

export async function POST(req: Request) {
  const { scope: token, events, complete } = await req.json().catch(() => ({}));
  const scope = verifyScope(String(token ?? ""));
  if (!scope) return NextResponse.json({ error: "invalid scope" }, { status: 401 });

  for (const ev of ((events ?? []) as { type: string; payload: unknown }[]).slice(0, 50)) {
    await q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,$2,$3)", [
      scope.callId, String(ev.type).slice(0, 40), JSON.stringify(ev.payload ?? {}),
    ]);
  }
  if (complete) {
    await q(
      `UPDATE calls SET status = 'completed', ended_at = now(),
       duration_s = EXTRACT(EPOCH FROM (now() - started_at))::int
       WHERE id = $1 AND status IN ('active','dialing')`,
      [scope.callId]
    );
  }
  return NextResponse.json({ ok: true });
}
