// Author: Harsha Gundala
// voice.ts — builds xAI realtime session configs for bots; scoped MCP tokens; call rows.
// Session build also resolves A/B experiment variants and injects caller CRM context.

import { createHmac } from "node:crypto";
import { q, qOne } from "./db";
import { pickVariant } from "./experiments";
import { findCustomerByPhone, phoneDigits } from "./datasets";

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

async function loadAgentVersion(agent: AgentVersionRow, version: number): Promise<AgentVersionRow | null> {
  const v = await qOne<Pick<AgentVersionRow, "version" | "instructions" | "voice" | "flow" | "tool_ids" | "mcp_server_ids" | "settings">>(
    `SELECT version, instructions, voice, flow, tool_ids, mcp_server_ids, settings
     FROM agent_versions WHERE agent_id = $1 AND version = $2`,
    [agent.agent_id, version]
  );
  return v ? { ...agent, ...v } : null;
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

type CallRow = {
  direction: string;
  from_number: string | null;
  to_number: string | null;
  experiment_id: string | null;
  variant: string | null;
  agent_version: number;
  flow_id: string | null;
};

/** Honors a stamped experiment variant, or lazily picks one (covers PSTN calls created outside buildVoiceSession). */
async function resolveVariant(agent: AgentVersionRow, callId: string, call: CallRow | null): Promise<AgentVersionRow> {
  if (!call) return agent;
  let version: number | null = call.experiment_id ? call.agent_version : null;
  if (!call.experiment_id) {
    const pick = await pickVariant(agent.agent_id).catch(() => null);
    if (pick) {
      version = pick.agentVersion;
      await q(
        "UPDATE calls SET experiment_id = $2, variant = $3, agent_version = $4 WHERE id = $1",
        [callId, pick.experimentId, pick.variant, pick.agentVersion]
      );
    }
  }
  if (version && version !== agent.version) {
    return (await loadAgentVersion(agent, version)) ?? agent;
  }
  return agent;
}

/** CRM lookup + recent-call history for the caller's number; empty string when unknown (web calls). */
async function callerContextBlock(orgId: string, callId: string, call: CallRow | null): Promise<string> {
  const number = call?.direction === "outbound" ? call?.to_number : call?.from_number;
  if (!number) return "";
  const digits = phoneDigits(number);
  if (digits.length < 7) return "";

  const [customer, recent] = await Promise.all([
    findCustomerByPhone(orgId, number).catch(() => null),
    q<{ started_at: string; summary: string | null; satisfaction: number | null }>(
      `SELECT c.started_at, c.summary, c.satisfaction
       FROM calls c JOIN agents a ON a.id = c.agent_id
       WHERE a.org_id = $1 AND c.id <> $2 AND c.status = 'completed'
         AND RIGHT(regexp_replace(COALESCE(CASE WHEN c.direction = 'outbound' THEN c.to_number ELSE c.from_number END, ''), '\\D', '', 'g'), 10) = RIGHT($3, 10)
       ORDER BY c.started_at DESC LIMIT 3`,
      [orgId, callId, digits]
    ).catch(() => []),
  ]);
  if (!customer && !recent.length) return "";

  const lines = ["CALLER CONTEXT (from CRM):"];
  if (customer) {
    const bits = ["name", "email", "notes"]
      .filter((k) => customer[k])
      .map((k) => `${k}: ${String(customer[k]).slice(0, 200)}`);
    lines.push(bits.length ? bits.join(", ") : "known customer (no details on file)");
  } else {
    lines.push("not in the customers table");
  }
  if (recent.length) {
    lines.push("recent calls:");
    for (const r of recent) {
      lines.push(
        `- ${new Date(r.started_at).toISOString().slice(0, 10)}: ${r.summary ?? "no summary"}${r.satisfaction != null ? ` (satisfaction ${r.satisfaction}/10)` : ""}`
      );
    }
  }
  lines.push("Greet them by name if known.");
  return `${lines.join("\n")}\n\n`;
}

/** Builds the session.update payload for an existing call. Audio "pcmu" targets telephony (8kHz μ-law). */
export async function sessionUpdateForCall(
  agent: AgentVersionRow,
  callId: string,
  direction: "web" | "inbound" | "outbound",
  origin: string,
  audio: "pcm" | "pcmu" = "pcm"
): Promise<Record<string, unknown>> {
  const scope = signScope({ callId, agentId: agent.agent_id, orgId: agent.org_id });

  const call = await qOne<CallRow>(
    "SELECT direction, from_number, to_number, experiment_id, variant, agent_version, flow_id FROM calls WHERE id = $1",
    [callId]
  );
  let [effective, callerContext] = await Promise.all([
    resolveVariant(agent, callId, call),
    callerContextBlock(agent.org_id, callId, call),
  ]);
  // Campaign/recall calls run a named outbound flow: its instructions replace the inbound default.
  if (call?.flow_id) {
    const named = await qOne<{ instructions: string }>(
      "SELECT instructions FROM flows WHERE id = $1 AND org_id = $2", [call.flow_id, agent.org_id]
    );
    if (named) effective = { ...effective, instructions: named.instructions };
  }

  const tools: Record<string, unknown>[] = [
    {
      type: "mcp",
      server_label: "callcenter",
      server_url: `${origin}/api/mcp?scope=${scope}`,
    },
  ];
  const mcpRows = effective.mcp_server_ids.length
    ? await q<{ label: string; server_url: string; allowed_tools: string[] | null }>(
        "SELECT label, server_url, allowed_tools FROM mcp_servers WHERE id = ANY($1) AND org_id = $2",
        [effective.mcp_server_ids, effective.org_id]
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

  const humanNumber = call ? (call.direction === "outbound" ? call.to_number : call.from_number) : null;
  const callFacts = humanNumber
    ? `CALL FACTS: the number on this call is ${humanNumber} — use it whenever a step needs the caller's phone number; never ask them for it.\n\n`
    : "";
  return {
    type: "session.update",
    session: {
      voice: effective.voice,
      instructions:
        `${callFacts}${callerContext}${effective.instructions}\n\nYou are on a live ${direction} call. Keep responses short and natural for voice. ` +
        `If the caller asks for a callback at a specific time, use the request_recall tool.`,
      turn_detection: { type: "server_vad" },
      tools,
      ...(audio === "pcmu"
        ? {
            audio: {
              input: { format: { type: "audio/pcmu", rate: 8000 } },
              output: { format: { type: "audio/pcmu", rate: 8000 } },
            },
          }
        : {}),
      ...effective.settings,
    },
  };
}

/** Creates the call row (experiment variant stamped at insert) and the session.update payload. */
export async function buildVoiceSession(
  agent: AgentVersionRow,
  direction: "web" | "inbound" | "outbound",
  origin: string,
  numbers: { from?: string; to?: string } = {}
): Promise<{ callId: string; sessionUpdate: Record<string, unknown> }> {
  const pick = await pickVariant(agent.agent_id).catch(() => null);
  const call = await qOne<{ id: string }>(
    `INSERT INTO calls (agent_id, agent_version, direction, from_number, to_number, experiment_id, variant)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      agent.agent_id, pick?.agentVersion ?? agent.version, direction,
      numbers.from ?? null, numbers.to ?? null, pick?.experimentId ?? null, pick?.variant ?? null,
    ]
  );
  const callId = call!.id;
  const sessionUpdate = await sessionUpdateForCall(agent, callId, direction, origin);
  return { callId, sessionUpdate };
}
