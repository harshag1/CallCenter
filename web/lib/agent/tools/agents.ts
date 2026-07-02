// Author: Harsha Gundala
// agents.ts — operator tools: bot roster and append-only bot configuration (prompt, voice, flow, tools).

import { q, qOne } from "../../db";
import { FlowSchema } from "../../surface-dsl";
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
    "Update a bot by creating a new immutable version (append-only; old versions remain revertible). Provide only the fields to change. `flow` is the call-flow graph rendered in the UI: {nodes:[{id,label,kind:start|state|tool|decision|end}],edges:[{from,to,label?}]}. Keep flows honest — they should mirror the instructions.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      name: { type: "string" },
      instructions: { type: "string" },
      voice: { type: "string", enum: ["eve", "ara", "rex", "sal", "leo"] },
      flow: { type: "object" },
      tool_ids: { type: "array", items: { type: "string" } },
      mcp_server_ids: { type: "array", items: { type: "string" } },
    },
    required: ["agent_id"],
  },
  async execute(args, ctx) {
    const cur = await qOne<{ version: number; instructions: string; voice: string; flow: unknown; tool_ids: string[]; mcp_server_ids: string[] }>(
      `SELECT v.* FROM agent_versions v JOIN agents a ON a.id = v.agent_id AND a.org_id = $2
       WHERE v.agent_id = $1 AND v.version = a.active_version`,
      [args.agent_id, ctx.orgId]
    );
    if (!cur) return { output: { error: "agent not found" } };

    let flow = cur.flow;
    if (args.flow) {
      const parsed = FlowSchema.safeParse(args.flow);
      if (!parsed.success) return { output: { error: `invalid flow: ${parsed.error.message.slice(0, 300)}` } };
      flow = parsed.data;
    }
    const next = cur.version + 1;
    await q(
      `INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, tool_ids, mcp_server_ids, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        args.agent_id, next,
        args.instructions ?? cur.instructions,
        args.voice ?? cur.voice,
        JSON.stringify(flow),
        (args.tool_ids as string[]) ?? cur.tool_ids,
        (args.mcp_server_ids as string[]) ?? cur.mcp_server_ids,
        `operator (${ctx.email})`,
      ]
    );
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
