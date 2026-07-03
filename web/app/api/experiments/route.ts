// Author: Harsha Gundala
// experiments — list with quick per-experiment stats.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const experiments = await q(
    `SELECT e.id, e.agent_id, e.name, e.hypothesis, e.status, e.variants, e.created_by, e.created_at,
            a.name AS agent_name,
            (SELECT s.id FROM screens s WHERE s.experiment_id = e.id ORDER BY s.created_at LIMIT 1) AS screen_id,
            (SELECT count(*) FROM calls c WHERE c.experiment_id = e.id
              AND EXISTS (SELECT 1 FROM call_events ev WHERE ev.call_id = c.id AND ev.type = 'user_said'))::int AS calls,
            (SELECT ROUND(AVG(satisfaction)::numeric, 2)::float FROM calls c WHERE c.experiment_id = e.id
              AND EXISTS (SELECT 1 FROM call_events ev WHERE ev.call_id = c.id AND ev.type = 'user_said')) AS avg_satisfaction
     FROM experiments e JOIN agents a ON a.id = e.agent_id
     WHERE e.org_id = $1 ORDER BY e.created_at DESC`,
    [session.orgId]
  );
  return NextResponse.json({ experiments });
}
