// Author: Harsha Gundala
// cron/scheduler — dials due outbound calls/recalls (runs every minute via Vercel cron).

import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { log } from "@/lib/log";
import { analyzeCall } from "@/lib/analysis";
import { sweepCallTasks } from "@/lib/tasks";
import { dialDue } from "@/lib/campaigns";

const L = log("cron/scheduler");
export const maxDuration = 120;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Dialer (campaign-aware): claims due scheduled calls and originates in parallel.
  const results = await dialDue(15);
  // Analysis backstop: bridge-terminated calls can outlive their function context,
  // so sweep any recently-completed call that never got scored.
  const unanalyzed = await q<{ id: string }>(
    `SELECT c.id FROM calls c
     WHERE c.status = 'completed' AND c.satisfaction IS NULL
       AND c.ended_at > now() - interval '2 hours'
       AND (SELECT count(*) FROM call_events e WHERE e.call_id = c.id
            AND e.type IN ('user_said','agent_said','human_segment')) >= 1
     ORDER BY c.ended_at DESC LIMIT 5`
  );
  for (const c of unanalyzed) {
    await analyzeCall(c.id).catch((e) => L.warn("sweep analysis failed", { callId: c.id, err: (e as Error).message }));
  }

  const tasksRun = await sweepCallTasks().catch(() => 0);

  return NextResponse.json({ processed: Object.keys(results).length, analyzed: unanalyzed.length, tasks: tasksRun, results });
}
