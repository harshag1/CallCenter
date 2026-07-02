// Author: Harsha Gundala
// calls/[id]/end — closes a call and runs the post-call pipeline (summary + sentiment).

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { chatJSON, MODELS } from "@/lib/xai";
import { log } from "@/lib/log";

const L = log("calls/end");

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
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
  try {
    const events = await q<{ type: string; payload: { text?: string; name?: string } }>(
      "SELECT type, payload FROM call_events WHERE call_id = $1 ORDER BY id LIMIT 400",
      [id]
    );
    const transcript = events
      .filter((e) => e.type === "user_said" || e.type === "agent_said")
      .map((e) => `${e.type === "user_said" ? "Caller" : "Agent"}: ${e.payload.text}`)
      .join("\n");
    if (transcript.length > 40) {
      const analysis = await chatJSON<{ summary: string; sentiment: "positive" | "neutral" | "negative" }>(
        [
          { role: "system", content: 'Analyze this call transcript. Reply JSON only: {"summary": "<2 sentences>", "sentiment": "positive|neutral|negative"}' },
          { role: "user", content: transcript.slice(0, 12_000) },
        ],
        { model: MODELS.fast, maxTokens: 300 }
      );
      await q("UPDATE calls SET summary = $2, sentiment = $3 WHERE id = $1", [id, analysis.summary, analysis.sentiment]);
    }
  } catch (e) {
    L.warn("post-call analysis failed", { callId: id, err: (e as Error).message });
  }
  return NextResponse.json({ ok: true });
}
