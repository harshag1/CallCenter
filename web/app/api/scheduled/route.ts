// Author: Harsha Gundala
// scheduled — pending/recent outbound work (campaign calls + recalls) with cancel support.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q } from "@/lib/db";
import { cancelCampaign, campaignStats } from "@/lib/campaigns";
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

export async function GET() {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const [scheduled, campaigns] = await Promise.all([
    q(
      `SELECT s.id, s.to_number, s.run_at, s.reason, s.status, s.attempts, s.parent_call_id,
              s.campaign_id, a.name AS agent, c.name AS campaign
       FROM scheduled_calls s
       JOIN agents a ON a.id = s.agent_id
       LEFT JOIN campaigns c ON c.id = s.campaign_id
       WHERE a.org_id = $1 AND s.status IN ('pending','dialing')
       ORDER BY (s.status = 'pending') DESC, s.run_at DESC LIMIT 200`,
      [session.orgId]
    ),
    campaignStats(session.orgId),
  ]);
  return json({ scheduled, campaigns });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    body = await readPrivateJsonObject(req, 4 * 1024);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return json({ error: status === 403 ? "forbidden" : "invalid request" }, status);
  }
  const keys = Object.keys(body);
  if (
    keys.length !== 1
    || (keys[0] !== "cancel_id" && keys[0] !== "cancel_campaign_id")
    || !isUuid(body[keys[0]])
  ) return json({ error: "cancel_id or cancel_campaign_id required" }, 400);

  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { cancel_id, cancel_campaign_id } = body;
  if (cancel_campaign_id) {
    const n = await cancelCampaign(session.orgId, cancel_campaign_id as string);
    return json({ ok: true, canceled: n });
  }
  if (cancel_id) {
    const rows = await q(
      `UPDATE scheduled_calls s SET status = 'canceled'
       FROM agents a WHERE s.id = $1 AND a.id = s.agent_id AND a.org_id = $2 AND s.status = 'pending'
       RETURNING s.id`,
      [cancel_id, session.orgId]
    );
    return json(rows.length ? { ok: true } : { error: "not found or not pending" }, rows.length ? 200 : 404);
  }
  return json({ error: "cancel_id or cancel_campaign_id required" }, 400);
}
