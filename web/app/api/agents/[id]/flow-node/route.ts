// Author: Harsha Gundala
// agents/[id]/flow-node — edits one node of the active inbound flow (append-only version).

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import {
  AgentFlowSchema,
  FlowNodeSchema,
  validateAgentFlow,
  type FlowDiagnostic,
} from "@/lib/flow";
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

function invalidFlowResponse(diagnostics: readonly FlowDiagnostic[]): NextResponse {
  return NextResponse.json(
    {
      error: "invalid flow",
      diagnostics: diagnostics.slice(0, 20).map(({ path, message }) => ({ path, message })),
    },
    { status: 422, headers: PRIVATE_NO_STORE_HEADERS }
  );
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

  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const current = await client.query<{
      version: number;
      instructions: string;
      voice: string;
      flow: unknown;
      tool_ids: string[];
      mcp_server_ids: string[];
      settings: Record<string, unknown>;
    }>(
      `SELECT v.version, v.instructions, v.voice, v.flow, v.tool_ids, v.mcp_server_ids, v.settings
       FROM agents a
       JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
       WHERE a.id = $1 AND a.org_id = $2
       FOR UPDATE OF a`,
      [id, session.orgId]
    );
    const cur = current.rows[0];
    if (!cur) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "agent not found" },
        { status: 404, headers: PRIVATE_NO_STORE_HEADERS }
      );
    }

    const flow = AgentFlowSchema.parse(cur.flow);
    if (!instructionsOnly) {
      const idx = flow.nodes.findIndex((node) => node.id === parsedNode!.data!.id);
      if (idx < 0) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "node not found" },
          { status: 404, headers: PRIVATE_NO_STORE_HEADERS }
        );
      }
      flow.nodes[idx] = { ...flow.nodes[idx], ...parsedNode!.data! };
    }

    const validation = validateAgentFlow(flow);
    const errors = validation.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (errors.length) {
      await client.query("ROLLBACK");
      return invalidFlowResponse(errors);
    }

    const inserted = await client.query<{ version: number }>(
      `WITH next_version AS (
         SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM agent_versions WHERE agent_id = $1
       )
       INSERT INTO agent_versions
         (agent_id, version, instructions, voice, flow, tool_ids, mcp_server_ids, settings, created_by)
       SELECT $1, next_version.version, $2, $3, $4, $5, $6, $7, $8
       FROM next_version
       RETURNING version`,
      [
        id,
        instructionsOnly ? String(body.instructions).slice(0, 20000) : cur.instructions,
        cur.voice,
        JSON.stringify(flow),
        cur.tool_ids,
        cur.mcp_server_ids,
        JSON.stringify(cur.settings),
        `studio (${session.email})`,
      ]
    );
    const next = inserted.rows[0]?.version;
    if (!next) throw new Error("agent version creation failed");
    const activated = await client.query<{ id: string }>(
      "UPDATE agents SET active_version = $3 WHERE id = $1 AND org_id = $2 RETURNING id",
      [id, session.orgId, next]
    );
    if (activated.rowCount !== 1) throw new Error("agent activation lost its ownership lock");
    await client.query("COMMIT");
    return NextResponse.json(
      { ok: true, flow, version: next },
      { headers: PRIVATE_NO_STORE_HEADERS }
    );
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    return NextResponse.json(
      { error: "flow update failed safely" },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    );
  } finally {
    client.release();
  }
}
