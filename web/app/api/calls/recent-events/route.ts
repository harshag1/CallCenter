// Author: Harsha Gundala
// calls/recent-events — polling fallback for the SSE stream: org-scoped call_events after a cursor.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import type { LiveCallEvent } from "@/lib/realtime-types";

const LIMIT = 200;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const afterRaw = new URL(req.url).searchParams.get("after");
  if (afterRaw === null) {
    // Cursor sync: hand back the current high-water mark without replaying history.
    const head = await qOne<{ max: string }>("SELECT COALESCE(MAX(id),0)::text AS max FROM call_events");
    return NextResponse.json({ events: [], last: Number(head?.max ?? 0) });
  }

  // Clamp to a bigint-safe integer — huge cursors otherwise overflow pg's int8 parse.
  const after = Math.min(Number.parseInt(afterRaw, 10), Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(after) || after < 0) {
    return NextResponse.json({ error: "bad cursor" }, { status: 400 });
  }

  const rows = await q<{ id: string; call_id: string; type: string; payload: Record<string, unknown>; ts: string }>(
    `SELECT e.id::text, e.call_id, e.type, e.payload, e.ts
     FROM call_events e
     JOIN calls c ON c.id = e.call_id
     JOIN agents a ON a.id = c.agent_id
     WHERE a.org_id = $1 AND e.id > $2
     ORDER BY e.id ASC
     LIMIT ${LIMIT}`,
    [session.orgId, after]
  );

  const events: LiveCallEvent[] = rows.map((r) => ({
    kind: "call_event",
    callId: r.call_id,
    eventId: Number(r.id),
    type: r.type,
    payload: r.payload,
    ts: r.ts,
  }));
  return NextResponse.json({ events, last: events.length ? events[events.length - 1].eventId : after });
}
