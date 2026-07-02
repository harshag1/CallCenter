// Author: Harsha Gundala
// agents/[id]/support-number — edits the fallback node's transfer number (append-only version).

import { NextResponse } from "next/server";
import { getSession, normalizePhoneNumber } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { AgentFlowSchema } from "@/lib/flow";
import { isUuid } from "@/lib/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const { number } = await req.json().catch(() => ({}));
  const clean = normalizePhoneNumber(String(number ?? ""));
  if (!clean) return NextResponse.json({ error: "invalid phone number" }, { status: 400 });

  const cur = await qOne<{ version: number; instructions: string; voice: string; flow: unknown; tool_ids: string[]; mcp_server_ids: string[] }>(
    `SELECT v.* FROM agent_versions v JOIN agents a ON a.id = v.agent_id AND a.org_id = $2
     WHERE v.agent_id = $1 AND v.version = a.active_version`,
    [id, session.orgId]
  );
  if (!cur) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  const flow = AgentFlowSchema.parse(cur.flow);
  const fb = flow.nodes.find((n) => n.kind === "fallback");
  if (!fb) return NextResponse.json({ error: "no fallback node" }, { status: 400 });
  fb.support_number = clean;

  const next = cur.version + 1;
  await q(
    `INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, tool_ids, mcp_server_ids, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, next, cur.instructions, cur.voice, JSON.stringify(flow), cur.tool_ids, cur.mcp_server_ids, `studio (${session.email})`]
  );
  await q("UPDATE agents SET active_version = $2 WHERE id = $1", [id, next]);
  return NextResponse.json({ ok: true, support_number: clean, version: next });
}
