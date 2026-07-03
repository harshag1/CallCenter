// Author: Harsha Gundala
// flows/[id] — PATCH one node of a named (outbound) flow; org-scoped, bumps updated_at.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { qOne } from "@/lib/db";
import { AgentFlowSchema, FlowNodeSchema } from "@/lib/flow";
import { isUuid, readJson } from "@/lib/http";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await readJson<{ node?: unknown }>(req);
  const parsedNode = FlowNodeSchema.safeParse(body?.node);
  if (!parsedNode.success) return NextResponse.json({ error: "invalid node" }, { status: 400 });

  const cur = await qOne<{ flow: unknown }>(
    "SELECT flow FROM flows WHERE id = $1 AND org_id = $2",
    [id, session.orgId]
  );
  if (!cur) return NextResponse.json({ error: "flow not found" }, { status: 404 });

  const flow = AgentFlowSchema.parse(cur.flow);
  const idx = flow.nodes.findIndex((n) => n.id === parsedNode.data.id);
  if (idx < 0) return NextResponse.json({ error: "node not found" }, { status: 404 });
  flow.nodes[idx] = { ...flow.nodes[idx], ...parsedNode.data };

  await qOne(
    "UPDATE flows SET flow = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING id",
    [id, session.orgId, JSON.stringify(flow)]
  );
  return NextResponse.json({ flow });
}
