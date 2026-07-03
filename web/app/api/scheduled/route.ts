// Author: Harsha Gundala
// scheduled — pending/recent outbound work (campaign calls + recalls) with cancel support.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q } from "@/lib/db";
import { cancelCampaign, campaignStats } from "@/lib/campaigns";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
  return NextResponse.json({ scheduled, campaigns });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { cancel_id, cancel_campaign_id } = await req.json().catch(() => ({}));
  if (cancel_campaign_id) {
    const n = await cancelCampaign(session.orgId, String(cancel_campaign_id));
    return NextResponse.json({ ok: true, canceled: n });
  }
  if (cancel_id) {
    const rows = await q(
      `UPDATE scheduled_calls s SET status = 'canceled'
       FROM agents a WHERE s.id = $1 AND a.id = s.agent_id AND a.org_id = $2 AND s.status = 'pending'
       RETURNING s.id`,
      [cancel_id, session.orgId]
    );
    return NextResponse.json(rows.length ? { ok: true } : { error: "not found or not pending" }, { status: rows.length ? 200 : 404 });
  }
  return NextResponse.json({ error: "cancel_id or cancel_campaign_id required" }, { status: 400 });
}
