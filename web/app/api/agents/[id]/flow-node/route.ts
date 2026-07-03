// Author: Harsha Gundala
// agents/[id]/flow-node — edits one node of the active inbound flow (append-only version).

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { AgentFlowSchema, FlowNodeSchema } from "@/lib/flow";
import { isUuid, readJson } from "@/lib/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await readJson<{ node?: unknown; instructions?: string }>(req);
  const instructionsOnly = !body?.node && typeof body?.instructions === "string" && body.instructions.trim().length > 0;
  const parsedNode = instructionsOnly ? null : FlowNodeSchema.safeParse(body?.node);
  if (!instructionsOnly && !parsedNode!.success) return NextResponse.json({ error: "invalid node" }, { status: 400 });

  const cur = await qOne<{ version: number; instructions: string; voice: string; flow: unknown; tool_ids: string[]; mcp_server_ids: string[] }>(
    `SELECT v.* FROM agent_versions v JOIN agents a ON a.id = v.agent_id AND a.org_id = $2
     WHERE v.agent_id = $1 AND v.version = a.active_version`,
    [id, session.orgId]
  );
  if (!cur) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  const flow = AgentFlowSchema.parse(cur.flow);
  if (!instructionsOnly) {
    const idx = flow.nodes.findIndex((n) => n.id === parsedNode!.data!.id);
    if (idx < 0) return NextResponse.json({ error: "node not found" }, { status: 404 });
    flow.nodes[idx] = { ...flow.nodes[idx], ...parsedNode!.data! };
  }

  // Next version = MAX+1, not active+1 — active may have been reverted below existing versions.
  const nextRow = await qOne<{ next: number }>(
    "SELECT COALESCE(MAX(version),0) + 1 AS next FROM agent_versions WHERE agent_id = $1", [id]
  );
  const next = nextRow!.next;
  await q(
    `INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, tool_ids, mcp_server_ids, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id, next,
      instructionsOnly ? String(body!.instructions).slice(0, 20000) : cur.instructions,
      cur.voice, JSON.stringify(flow), cur.tool_ids, cur.mcp_server_ids, `studio (${session.email})`,
    ]
  );
  await q("UPDATE agents SET active_version = $2 WHERE id = $1", [id, next]);
  return NextResponse.json({ ok: true, flow, version: next });
}
