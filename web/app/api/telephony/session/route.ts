// Author: Harsha Gundala
// telephony/session — hands the bridge a ready session.update for a scoped call (μ-law telephony audio).

import { NextResponse } from "next/server";
import { qOne } from "@/lib/db";
import { verifyScope, loadActiveAgent, voiceSessionSpecForCall } from "@/lib/voice";
import { buildProviderSessionUpdate, serverRealtimeEndpoint } from "@/lib/realtime/registry";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = verifyScope(url.searchParams.get("scope") ?? "");
  if (!scope) return NextResponse.json({ error: "invalid scope" }, { status: 401 });

  const call = await qOne<{ direction: "inbound" | "outbound"; metadata: { reason?: string } }>(
    "SELECT direction, metadata FROM calls WHERE id = $1 AND agent_id = $2",
    [scope.callId, scope.agentId]
  );
  const agent = await loadActiveAgent(scope.agentId, scope.orgId);
  if (!call || !agent) return NextResponse.json({ error: "call not found" }, { status: 404 });

  const origin = process.env.PUBLIC_ORIGIN ?? url.origin;
  const spec = await voiceSessionSpecForCall(agent, scope.callId, call.direction, origin);
  if (call.direction === "outbound" && call.metadata?.reason) {
    spec.instructions += `\n\nYou are placing this outbound call. Purpose: ${call.metadata.reason}. Open by introducing yourself and the reason for the call.`;
  }
  try {
    return NextResponse.json({
      ...serverRealtimeEndpoint(spec),
      sessionUpdate: buildProviderSessionUpdate(spec, "pcmu"),
      callId: scope.callId,
      model: spec.model,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
}
