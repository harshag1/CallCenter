// Author: Harsha Gundala
// voice.ts — builds xAI realtime session configs for bots; scoped MCP tokens; call rows.

import { createHmac } from "node:crypto";
import { q, qOne } from "./db";

export type AgentVersionRow = {
  agent_id: string;
  org_id: string;
  name: string;
  version: number;
  instructions: string;
  voice: string;
  flow: unknown;
  tool_ids: string[];
  mcp_server_ids: string[];
  settings: Record<string, unknown>;
};

export async function loadActiveAgent(agentId: string, orgId: string): Promise<AgentVersionRow | null> {
  return qOne<AgentVersionRow>(
    `SELECT a.id AS agent_id, a.org_id, a.name, v.version, v.instructions, v.voice, v.flow,
            v.tool_ids, v.mcp_server_ids, v.settings
     FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
     WHERE a.id = $1 AND a.org_id = $2`,
    [agentId, orgId]
  );
}

/** Signed scope embedded in the MCP gateway URL so xAI's server-side calls are org+call bound. */
export function signScope(payload: { callId: string; agentId: string; orgId: string }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", process.env.MCP_GATEWAY_SECRET!).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyScope(token: string): { callId: string; agentId: string; orgId: string } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = createHmac("sha256", process.env.MCP_GATEWAY_SECRET!).update(body).digest("base64url");
  if (sig !== expect) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}

/** Creates the call row and the session.update payload a realtime client sends after connecting. */
export async function buildVoiceSession(
  agent: AgentVersionRow,
  direction: "web" | "inbound" | "outbound",
  origin: string,
  numbers: { from?: string; to?: string } = {}
): Promise<{ callId: string; sessionUpdate: Record<string, unknown> }> {
  const call = await qOne<{ id: string }>(
    `INSERT INTO calls (agent_id, agent_version, direction, from_number, to_number)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [agent.agent_id, agent.version, direction, numbers.from ?? null, numbers.to ?? null]
  );
  const callId = call!.id;
  const scope = signScope({ callId, agentId: agent.agent_id, orgId: agent.org_id });

  const tools: Record<string, unknown>[] = [
    {
      type: "mcp",
      server_label: "callcenter",
      server_url: `${origin}/api/mcp?scope=${scope}`,
    },
  ];
  const mcpRows = agent.mcp_server_ids.length
    ? await q<{ label: string; server_url: string; allowed_tools: string[] | null }>(
        "SELECT label, server_url, allowed_tools FROM mcp_servers WHERE id = ANY($1) AND org_id = $2",
        [agent.mcp_server_ids, agent.org_id]
      )
    : [];
  for (const m of mcpRows) {
    tools.push({
      type: "mcp",
      server_label: m.label.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      server_url: m.server_url,
      ...(m.allowed_tools?.length ? { allowed_tools: m.allowed_tools } : {}),
    });
  }

  const sessionUpdate = {
    type: "session.update",
    session: {
      voice: agent.voice,
      instructions:
        `${agent.instructions}\n\nYou are on a live ${direction} call. Keep responses short and natural for voice. ` +
        `If the caller asks for a callback at a specific time, use the request_recall tool.`,
      turn_detection: { type: "server_vad" },
      tools,
      ...agent.settings,
    },
  };
  return { callId, sessionUpdate };
}
