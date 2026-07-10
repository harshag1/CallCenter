// Author: Harsha Gundala
// agents.ts — operator tools: bot roster and append-only bot configuration (prompt, voice, flow, tools).

import { q, qOne } from "../../db";
import { AgentFlowSchema, validateAgentFlow, type AgentFlow } from "../../flow";
import type { OperatorTool } from "../types";

export const listAgents: OperatorTool = {
  name: "list_agents",
  description: "List this org's voice bots with their active config (instructions, voice, flow, attached tools).",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    const rows = await q(
      `SELECT a.id, a.name, a.purpose, a.phone_number, a.active_version, v.instructions, v.voice, v.flow, v.tool_ids
       FROM agents a
       JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
       WHERE a.org_id = $1 ORDER BY a.created_at`,
      [ctx.orgId]
    );
    return { output: rows };
  },
};

export const updateAgent: OperatorTool = {
  name: "update_agent",
  description:
    "Update a bot by creating a new immutable version (append-only; old versions remain revertible). Providers: xai, openai, or gemini; model ids stay configurable for new releases. Prefer Flow v2 nested steps and scoped tools. Topic nodes MUST keep their context and steps (copy them from the current flow when unchanged). The incoming_call and fallback nodes are preserved automatically if omitted.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      name: { type: "string" },
      instructions: { type: "string" },
      provider: { type: "string", enum: ["xai", "openai", "gemini"] },
      model: { type: "string", description: "Optional provider model id; omit to use the provider default." },
      voice: { type: "string", description: "Provider voice id/name. Defaults: xAI ara, OpenAI marin, Gemini Kore." },
      provider_settings: { type: "object", description: "Advanced provider-specific realtime session settings." },
      flow: { type: "object" },
      tool_ids: { type: "array", items: { type: "string" } },
      mcp_server_ids: { type: "array", items: { type: "string" } },
    },
    required: ["agent_id"],
  },
  async execute(args, ctx) {
    const cur = await qOne<{ version: number; instructions: string; voice: string; flow: unknown; tool_ids: string[]; mcp_server_ids: string[]; settings: Record<string, unknown> }>(
      `SELECT v.* FROM agent_versions v JOIN agents a ON a.id = v.agent_id AND a.org_id = $2
       WHERE v.agent_id = $1 AND v.version = a.active_version`,
      [args.agent_id, ctx.orgId]
    );
    if (!cur) return { output: { error: "agent not found" } };

    let flow = cur.flow;
    if (args.flow) {
      const parsed = AgentFlowSchema.safeParse({ schema_version: 2, tool_exposure: "gateway", ...args.flow as object });
      if (!parsed.success) return { output: { error: `invalid flow: ${parsed.error.message.slice(0, 300)}` } };
      const healed = healFlow(parsed.data, AgentFlowSchema.parse(cur.flow));
      if ("error" in healed) return { output: healed };
      flow = healed.flow;
    }
    const settings = {
      ...cur.settings,
      ...(args.provider ? { voice_provider: args.provider } : {}),
      ...(args.model ? { voice_model: args.model } : {}),
      ...(args.provider_settings ? { provider_settings: args.provider_settings } : {}),
    };
    const inserted = await qOne<{ version: number }>(
      `WITH locked AS (
         SELECT pg_advisory_xact_lock(hashtext($1::text))
       ), next_version AS (
         SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM agent_versions, locked WHERE agent_id = $1
       )
       INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, tool_ids, mcp_server_ids, settings, created_by)
       SELECT $1, next_version.version, $2, $3, $4, $5, $6, $7, $8 FROM next_version
       RETURNING version`,
      [
        args.agent_id,
        args.instructions ?? cur.instructions,
        args.voice ?? cur.voice,
        JSON.stringify(flow),
        (args.tool_ids as string[]) ?? cur.tool_ids,
        (args.mcp_server_ids as string[]) ?? cur.mcp_server_ids,
        JSON.stringify(settings),
        `operator (${ctx.email})`,
      ]
    );
    const next = inserted!.version;
    await q(
      "UPDATE agents SET active_version = $2, name = COALESCE($3, name) WHERE id = $1",
      [args.agent_id, next, args.name ?? null]
    );
    return {
      output: { ok: true, version: next },
      flow: flow as never,
      notice: `Bot updated to v${next}`,
    };
  },
};


/** Structural guardrails: an updated flow may never collapse the graph.
 *  Preserves incoming_call/fallback from the current flow when omitted, merges missing
 *  topic context/steps from same-id nodes, prunes dangling edges, reconnects orphans. */
function healFlow(next: AgentFlow, current: AgentFlow): { flow: AgentFlow } | { error: string } {
  const nodes = [...next.nodes];

  // Old-vocabulary rescue: start→incoming_call, decision/state with no better match → topic.
  for (const n of nodes) {
    if ((n.kind as string) === "start") n.kind = "incoming_call";
    else if (!["incoming_call", "topic", "fallback"].includes(n.kind)) {
      const wasFallback = current.nodes.find((c) => c.id === n.id)?.kind === "fallback";
      n.kind = wasFallback ? "fallback" : "topic";
    }
  }

  if (!nodes.some((n) => n.kind === "incoming_call")) {
    const inc = current.nodes.find((n) => n.kind === "incoming_call");
    if (inc) nodes.unshift(inc);
  }
  if (!nodes.some((n) => n.kind === "fallback")) {
    const fb = current.nodes.find((n) => n.kind === "fallback");
    if (fb) nodes.push(fb);
  }

  // Merge lost topic payloads from the current flow.
  for (const n of nodes) {
    if (n.kind !== "topic") continue;
    const prev = current.nodes.find((c) => c.id === n.id);
    if (prev) {
      n.context ??= prev.context;
      n.steps ??= prev.steps;
      n.icon ??= prev.icon;
    }
  }

  if (!nodes.some((n) => n.kind === "topic")) {
    return { error: "flow must keep at least one topic node — include the topics that should remain" };
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges = next.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const incoming = nodes.find((n) => n.kind === "incoming_call");
  if (incoming) {
    for (const n of nodes) {
      if (n.id !== incoming.id && !edges.some((e) => e.to === n.id)) {
        edges.push({ from: incoming.id, to: n.id });
      }
    }
  }
  const flow = { ...next, nodes, edges };
  const validation = validateAgentFlow(flow);
  const errors = validation.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (errors.length) return { error: errors.slice(0, 5).map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ") };
  return { flow };
}
