// Author: Harsha Gundala
// telephony/status — Twilio status callback: marks unanswered/failed outbound legs (missed calls).

import { NextResponse } from "next/server";
import { q, qOne } from "@/lib/db";
import { isUuid } from "@/lib/http";
import { log } from "@/lib/log";

const L = log("telephony/status");
const MISSED = new Set(["no-answer", "busy", "failed", "canceled"]);

export async function POST(req: Request) {
  const callId = new URL(req.url).searchParams.get("callId");
  if (!callId || !isUuid(callId)) return NextResponse.json({ ok: true });
  const form = await req.formData().catch(() => new FormData());
  const sid = String(form.get("CallSid") ?? "");
  const status = String(form.get("CallStatus") ?? "");

  // The CallSid must match the call row — the callId param alone is not trusted.
  const call = await qOne<{ status: string }>(
    "SELECT status FROM calls WHERE id = $1 AND twilio_call_sid = $2", [callId, sid]
  );
  if (!call) return NextResponse.json({ ok: true });

  if (MISSED.has(status) && call.status !== "completed") {
    await q(
      `UPDATE calls SET status = 'no-answer', ended_at = now(),
       duration_s = COALESCE(duration_s, 0) WHERE id = $1`,
      [callId]
    );
    L.info("outbound missed", { callId, data: { twilioStatus: status } });
  } else if (status === "completed") {
    // Belt-and-suspenders: bridge teardown normally closes it.
    await q(
      `UPDATE calls SET status = 'completed', ended_at = COALESCE(ended_at, now()),
       duration_s = COALESCE(duration_s, EXTRACT(EPOCH FROM (now() - started_at))::int)
       WHERE id = $1 AND status IN ('active','dialing')`,
      [callId]
    );
  }
  return NextResponse.json({ ok: true });
}
