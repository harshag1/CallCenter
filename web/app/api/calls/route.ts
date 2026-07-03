// Author: Harsha Gundala
// calls — org-scoped call log; ?call=<id> returns one call plus the exact agent-version flow it ran.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { isUuid } from "@/lib/http";

const FIELDS = `c.id, c.agent_id, a.name AS agent, c.agent_version, c.direction, c.status,
  c.from_number, c.to_number, c.started_at, c.ended_at, c.duration_s,
  c.satisfaction, c.resolution, c.review, c.experiment_id, c.variant, c.summary,
  c.flow_id, c.campaign_id, c.parent_call_id, cp.name AS campaign, COALESCE(fl.name, a.name) AS flow_name`;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);

  const callId = url.searchParams.get("call");
  if (callId) {
    if (!isUuid(callId)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const row = await qOne(
      `SELECT ${FIELDS}, v.flow
       FROM calls c
       JOIN agents a ON a.id = c.agent_id
       LEFT JOIN campaigns cp ON cp.id = c.campaign_id LEFT JOIN flows fl ON fl.id = c.flow_id
       LEFT JOIN agent_versions v ON v.agent_id = c.agent_id AND v.version = c.agent_version
       WHERE c.id = $1 AND a.org_id = $2`,
      [callId, session.orgId]
    );
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { flow, ...call } = row as Record<string, unknown>;
    return NextResponse.json({ call, flow: flow ?? null });
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 500);
  const calls = await q(
    `SELECT ${FIELDS}
     FROM calls c JOIN agents a ON a.id = c.agent_id LEFT JOIN campaigns cp ON cp.id = c.campaign_id LEFT JOIN flows fl ON fl.id = c.flow_id
     WHERE a.org_id = $1 ORDER BY c.started_at DESC LIMIT $2`,
    [session.orgId, limit]
  );
  return NextResponse.json({ calls });
}
