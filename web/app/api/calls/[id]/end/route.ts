// Author: Harsha Gundala
// calls/[id]/end — closes a call and kicks the post-call analysis pipeline.

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { analyzeCall } from "@/lib/analysis";
import { isUuid } from "@/lib/http";
import {
  assertEmptyPrivateRequest,
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
} from "@/lib/private-json-request";

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginBrowserMutation(req);
    await assertEmptyPrivateRequest(req);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return json({ error: status === 403 ? "forbidden" : "invalid request" }, status);
  }
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "not found" }, 404);
  const call = await qOne<{ started_at: string }>(
    `SELECT c.started_at FROM calls c JOIN agents a ON a.id = c.agent_id
     WHERE c.id = $1 AND a.org_id = $2 AND c.status = 'active'`,
    [id, session.orgId]
  );
  if (!call) return json({ error: "not found" }, 404);
  await q(
    `UPDATE calls SET status = 'completed', ended_at = now(),
     duration_s = EXTRACT(EPOCH FROM (now() - started_at))::int WHERE id = $1`,
    [id]
  );

  // Post-call analysis — best-effort, never blocks the hangup.
  waitUntil(analyzeCall(id));
  return json({ ok: true });
}
