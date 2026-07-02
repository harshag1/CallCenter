// Author: Harsha Gundala
// workspace — boot payload: bots, recent calls, and the focused bot's flow.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [agents, calls] = await Promise.all([
    q(
      `SELECT a.id, a.name, a.purpose, a.phone_number, a.active_version, v.voice, v.flow, v.instructions
       FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
       WHERE a.org_id = $1 ORDER BY a.created_at`,
      [session.orgId]
    ),
    q(
      `SELECT c.id, a.name AS agent, c.direction, c.status, c.started_at, c.duration_s, c.sentiment, c.summary
       FROM calls c JOIN agents a ON a.id = c.agent_id
       WHERE a.org_id = $1 ORDER BY c.started_at DESC LIMIT 20`,
      [session.orgId]
    ),
  ]);
  return NextResponse.json({ email: session.email, agents, calls });
}
