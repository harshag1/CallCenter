// Author: Harsha Gundala
// flows — named flow listing for the flow-panel dropdown (inbound default + outbound flows).

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q } from "@/lib/db";
import { listFlows } from "@/lib/campaigns";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const agentId = new URL(req.url).searchParams.get("agentId");

  const [outbound, agents] = await Promise.all([
    listFlows(session.orgId, agentId),
    q<{ id: string; name: string; flow: unknown }>(
      `SELECT a.id, a.name, v.flow FROM agents a
       JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
       WHERE a.org_id = $1 AND ($2::uuid IS NULL OR a.id = $2)`,
      [session.orgId, agentId]
    ),
  ]);
  return NextResponse.json({
    flows: [
      ...agents.map((a) => ({
        id: `inbound:${a.id}`, agent_id: a.id, name: `${a.name} — inbound`, kind: "inbound", flow: a.flow,
      })),
      ...outbound.map((f) => ({ id: f.id, agent_id: f.agent_id, name: f.name, kind: f.kind, flow: f.flow, instructions: f.instructions })),
    ],
  });
}
