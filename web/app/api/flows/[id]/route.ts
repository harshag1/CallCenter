// Author: Harsha Gundala
// flows/[id] — PATCH one node of a named (outbound) flow; org-scoped, bumps updated_at.

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
const EditFlowNodeSchema = z.object({ node: z.unknown() }).strict();

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

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let rawBody: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    rawBody = await readPrivateJsonObject(req, MAX_FLOW_NODE_BODY_BYTES);
  } catch (error) {
    return privateRequestError(error);
  }
  const bodyResult = EditFlowNodeSchema.safeParse(rawBody);
  if (!bodyResult.success) return NextResponse.json({ error: "invalid node" }, { status: 400 });

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsedNode = FlowNodeSchema.safeParse(bodyResult.data.node);
  if (!parsedNode.success) return NextResponse.json({ error: "invalid node" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const current = await client.query<{ flow: unknown }>(
      "SELECT flow FROM flows WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [id, session.orgId]
    );
    const cur = current.rows[0];
    if (!cur) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "flow not found" },
        { status: 404, headers: PRIVATE_NO_STORE_HEADERS }
      );
    }

    const flow = AgentFlowSchema.parse(cur.flow);
    const idx = flow.nodes.findIndex((node) => node.id === parsedNode.data.id);
    if (idx < 0) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "node not found" },
        { status: 404, headers: PRIVATE_NO_STORE_HEADERS }
      );
    }
    flow.nodes[idx] = { ...flow.nodes[idx], ...parsedNode.data };

    const validation = validateAgentFlow(flow);
    const errors = validation.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (errors.length) {
      await client.query("ROLLBACK");
      return invalidFlowResponse(errors);
    }

    const updated = await client.query<{ id: string }>(
      "UPDATE flows SET flow = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING id",
      [id, session.orgId, JSON.stringify(flow)]
    );
    if (updated.rowCount !== 1) throw new Error("flow update lost its ownership lock");
    await client.query("COMMIT");
    return NextResponse.json({ flow }, { headers: PRIVATE_NO_STORE_HEADERS });
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
