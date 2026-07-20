// Author: Harsha Gundala
// agents/[id]/support-number — edits the fallback node's transfer number (append-only version).

import { NextResponse } from "next/server";
import { getSession, normalizePhoneNumber } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { AgentFlowSchema } from "@/lib/flow";
import { isUuid } from "@/lib/http";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

type ActiveAgentVersion = Readonly<{
  version: number;
  instructions: string;
  voice: string;
  flow: unknown;
  tool_ids: string[];
  mcp_server_ids: string[];
  settings: Record<string, unknown>;
}>;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let body: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    body = await readPrivateJsonObject(req, 4 * 1024);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return json({ error: status === 403 ? "forbidden" : "invalid request" }, status);
  }
  if (Object.keys(body).length !== 1 || typeof body.number !== "string") {
    return json({ error: "invalid phone number" }, 400);
  }
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "agent not found" }, 404);
  const clean = normalizePhoneNumber(body.number);
  if (!clean) return json({ error: "invalid phone number" }, 400);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const current = await client.query<ActiveAgentVersion>(
      `SELECT v.version, v.instructions, v.voice, v.flow, v.tool_ids,
              v.mcp_server_ids, v.settings
       FROM agents a
       JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
       WHERE a.id = $1 AND a.org_id = $2
       FOR UPDATE OF a`,
      [id, session.orgId]
    );
    const cur = current.rows[0];
    if (!cur) {
      await client.query("ROLLBACK");
      return json({ error: "agent not found" }, 404);
    }

    const flow = AgentFlowSchema.parse(cur.flow);
    const fb = flow.nodes.find((node) => node.kind === "fallback");
    if (!fb) {
      await client.query("ROLLBACK");
      return json({ error: "no fallback node" }, 400);
    }
    fb.support_number = clean;

    // The agents row lock serializes this route's allocator. Do not introduce
    // an advisory lock here: older writers may take version locks before they
    // update agents. SERIALIZABLE plus the version primary key turns any race
    // with those writers into a retryable transaction error instead.
    const inserted = await client.query<{ version: number }>(
      `WITH next_version AS (
         SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM agent_versions
         WHERE agent_id = $1
       )
       INSERT INTO agent_versions
         (agent_id, version, instructions, voice, flow, tool_ids, mcp_server_ids, settings, created_by)
       SELECT $1, next_version.version, $2, $3, $4, $5, $6, $7, $8
       FROM next_version
       RETURNING version`,
      [
        id,
        cur.instructions,
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
      `UPDATE agents
       SET active_version = $3
       WHERE id = $1 AND org_id = $2 AND active_version = $4
       RETURNING id`,
      [id, session.orgId, next, cur.version]
    );
    if (activated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return json({ error: "agent changed; retry" }, 409);
    }

    await client.query("COMMIT");
    return json({ ok: true, support_number: clean, version: next });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code === "40001" || code === "40P01" || code === "23505") {
      return json({ error: "agent changed; retry" }, 409);
    }
    return json({ error: "failed to update support number" }, 500);
  } finally {
    client.release();
  }
}
