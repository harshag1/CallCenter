// Author: Harsha Gundala
// cron/scheduler — dials due outbound calls/recalls (runs every minute via Vercel cron).

import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { log } from "@/lib/log";
import { originateCall } from "@/lib/telephony";
import { analyzeCall } from "@/lib/analysis";
import { sweepCallTasks } from "@/lib/tasks";

const L = log("cron/scheduler");
export const maxDuration = 120;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const due = await q<{ id: string; agent_id: string; to_number: string; attempts: number; reason: string | null }>(
    `UPDATE scheduled_calls SET status = 'dialing', attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM scheduled_calls
       WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at LIMIT 10 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, agent_id, to_number, attempts, reason`
  );

  const results: Record<string, string> = {};
  for (const job of due) {
    try {
      const callId = await originateCall(job.agent_id, job.to_number, job.reason);
      await q("UPDATE scheduled_calls SET status = 'done' WHERE id = $1", [job.id]);
      results[job.id] = `dialed:${callId}`;
    } catch (e) {
      const retry = job.attempts < 3;
      await q(
        `UPDATE scheduled_calls SET status = $2, run_at = CASE WHEN $2 = 'pending' THEN now() + interval '5 minutes' ELSE run_at END
         WHERE id = $1`,
        [job.id, retry ? "pending" : "failed"]
      );
      results[job.id] = `error:${(e as Error).message}`;
      L.error("dial failed", { data: { job: job.id }, err: (e as Error).message });
    }
  }
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

  return NextResponse.json({ processed: due.length, analyzed: unanalyzed.length, tasks: tasksRun, results });
}
