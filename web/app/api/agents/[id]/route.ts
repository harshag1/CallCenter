// Author: Harsha Gundala
// agents/[id] — active config for the node inspector: prompt, version, attached tools.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { isUuid } from "@/lib/http";

const BASE_TOOLS = ["classify", "begin_step", "hold", "contact_support", "request_recall", "send_email", "send_sms", "launch_task", "read_table", "write_table", "end_call", "log_note"];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const agent = await qOne<{
    name: string; version: number; instructions: string; voice: string;
    tool_ids: string[]; created_at: string; created_by: string;
  }>(
    `SELECT a.name, v.version, v.instructions, v.voice, v.tool_ids, v.created_at, v.created_by
     FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
     WHERE a.id = $1 AND a.org_id = $2`,
    [id, session.orgId]
  );
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });

  const minted = agent.tool_ids.length
    ? await q<{ slug: string }>(
        "SELECT slug FROM tools WHERE id = ANY($1) AND org_id = $2 AND deploy_status = 'live'",
        [agent.tool_ids, session.orgId]
      )
    : [];
  return NextResponse.json({
    name: agent.name,
    version: agent.version,
    instructions: agent.instructions,
    voice: agent.voice,
    updated_at: agent.created_at,
    updated_by: agent.created_by,
    tools: [...BASE_TOOLS, ...minted.map((m) => m.slug)],
  });
}
