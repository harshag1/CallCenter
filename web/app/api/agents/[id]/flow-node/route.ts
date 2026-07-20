// Author: Harsha Gundala
// agents/[id]/flow-node — edits one node of the active inbound flow (append-only version).

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { AgentFlowSchema, FlowNodeSchema } from "@/lib/flow";
import { isUuid } from "@/lib/http";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

const MAX_FLOW_NODE_BODY_BYTES = 512 * 1024;
const EditFlowNodeSchema = z.object({
  node: z.unknown().optional(),
  instructions: z.string().optional(),
}).strict();

function privateRequestError(error: unknown): NextResponse {
  const status = error instanceof PrivateRequestError ? error.status : 400;
  const message = status === 403
    ? "forbidden"
    : status === 413
      ? "payload too large"
      : status === 415
        ? "unsupported media type"
        : "invalid request";
  return NextResponse.json({ error: message }, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let rawBody: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    rawBody = await readPrivateJsonObject(req, MAX_FLOW_NODE_BODY_BYTES);
  } catch (error) {
    return privateRequestError(error);
  }
  const bodyResult = EditFlowNodeSchema.safeParse(rawBody);
  if (!bodyResult.success) return NextResponse.json({ error: "invalid node" }, { status: 400 });
  const body = bodyResult.data;

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const instructionsOnly = !body.node && typeof body.instructions === "string" && body.instructions.trim().length > 0;
  const parsedNode = instructionsOnly ? null : FlowNodeSchema.safeParse(body.node);
  if (!instructionsOnly && !parsedNode!.success) return NextResponse.json({ error: "invalid node" }, { status: 400 });

  const cur = await qOne<{ version: number; instructions: string; voice: string; flow: unknown; tool_ids: string[]; mcp_server_ids: string[]; settings: Record<string, unknown> }>(
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

  const inserted = await qOne<{ version: number }>(
    `WITH locked AS (
       SELECT pg_advisory_xact_lock(hashtext($1::text))
     ), next_version AS (
       SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM agent_versions, locked WHERE agent_id = $1
     )
     INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, tool_ids, mcp_server_ids, settings, created_by)
     SELECT $1, next_version.version, $2, $3, $4, $5, $6, $7, $8 FROM next_version
     RETURNING version`,
    [
      id,
      instructionsOnly ? String(body.instructions).slice(0, 20000) : cur.instructions,
      cur.voice, JSON.stringify(flow), cur.tool_ids, cur.mcp_server_ids, JSON.stringify(cur.settings), `studio (${session.email})`,
    ]
  );
  const next = inserted!.version;
  await q("UPDATE agents SET active_version = $2 WHERE id = $1", [id, next]);
  return NextResponse.json({ ok: true, flow, version: next });
}
