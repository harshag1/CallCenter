// Author: Harsha Gundala
// voice/token — mints an ephemeral realtime token + session config for a browser call.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { mintEphemeralToken } from "@/lib/xai";
import { loadActiveAgent, buildVoiceSession } from "@/lib/voice";
import { readJson, isUuid } from "@/lib/http";
import { qOne } from "@/lib/db";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { agentId, flowId } = (await readJson<{ agentId?: string; flowId?: string }>(req)) ?? {};
  if (!isUuid(agentId)) return NextResponse.json({ error: "valid agentId required" }, { status: 400 });
  const agent = await loadActiveAgent(agentId, session.orgId);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  // Optional named flow (outbound test calls): must be org-owned.
  let namedFlowId: string | null = null;
  if (flowId) {
    if (!isUuid(flowId)) return NextResponse.json({ error: "invalid flowId" }, { status: 400 });
    const owned = await qOne<{ id: string }>(
      "SELECT id FROM flows WHERE id = $1 AND org_id = $2", [flowId, session.orgId]
    );
    if (!owned) return NextResponse.json({ error: "flow not found" }, { status: 404 });
    namedFlowId = flowId;
  }

  const origin = process.env.PUBLIC_ORIGIN ?? new URL(req.url).origin;
  const [token, voiceSession] = await Promise.all([
    mintEphemeralToken(600),
    buildVoiceSession(agent, "web", origin, {}, { flowId: namedFlowId }),
  ]);
  return NextResponse.json({
    token,
    callId: voiceSession.callId,
    sessionUpdate: voiceSession.sessionUpdate,
    wsUrl: "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
  });
}
