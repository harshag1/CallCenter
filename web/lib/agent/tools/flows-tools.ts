// Author: Harsha Gundala
// flows-tools.ts — operator tools: outbound flows, campaign runs/scheduling, recall policy control.

import { q, qOne } from "../../db";
import { createFlow, updateFlow, listFlows, launchCampaign, kickCampaign, cancelCampaign, campaignStats } from "../../campaigns";
import { slimInstructions, AgentFlowSchema, normalizeFlow } from "../../flow";
import type { OperatorTool } from "../types";

const FLOW_DOC = `Prefer Flow v2: {schema_version:2,always_tools?:[tool],tool_exposure:"gateway",nodes:[{id,label,kind:"incoming_call"|"topic"|"fallback",icon?,context?,tools?:[tool],steps?:[Step],support_number?,table?}],edges:[{from,to,when?}]}. Step is recursive: {id,label,instructions,context?,tools?:[tool],required_outputs?:[key],success_criteria?:[text],checkpoint?:boolean,max_attempts?:number,steps?:[Step],transitions?:[{to:"absolute.step.path",when?,label?}],on_failure?:"absolute.step.path"}. RULES: exactly one entry with no steps; topic steps may nest up to 8 levels; grant only the tools needed at each step; use required_outputs for deterministic completion; all transition targets are absolute paths; when recording data, grant write_table and require the durable row id/output.`;

export const createFlowTool: OperatorTool = {
  name: "create_flow",
  description: `Create a named outbound flow for a bot (separate from its inbound flow). Campaign calls run this flow with the same tool runtime (classify/steps/write_table/etc). ${FLOW_DOC}`,
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      name: { type: "string", description: "Short name, e.g. 'Satisfaction Survey'" },
      persona: { type: "string", description: "2-3 sentences: who the agent is on this call and the call's goal." },
      flow: { type: "object" },
    },
    required: ["agent_id", "name", "persona", "flow"],
  },
  async execute(args, ctx) {
    const owned = await qOne("SELECT id FROM agents WHERE id = $1 AND org_id = $2", [args.agent_id, ctx.orgId]);
    if (!owned) return { output: { error: "agent not found" } };
    try {
      const parsed = AgentFlowSchema.parse({ schema_version: 2, tool_exposure: "gateway", ...args.flow as object });
      const normalized = normalizeFlow(parsed, "outbound");
      if ("error" in normalized) return { output: normalized };
      const row = await createFlow(ctx.orgId, String(args.agent_id), {
        name: String(args.name),
        flow: normalized.flow,
        instructions: slimInstructions(String(args.persona), normalized.flow),
        createdBy: `operator (${ctx.email})`,
      });
      return {
        output: { ok: true, flow_id: row.id, name: row.name },
        flow: normalized.flow as never,
        flowMeta: { id: row.id, label: row.name },
        notice: `Flow "${row.name}" created`,
      };
    } catch (e) {
      return { output: { error: (e as Error).message.slice(0, 400) } };
    }
  },
};

export const updateFlowTool: OperatorTool = {
  name: "update_flow",
  description: `Edit a named outbound flow (graph and/or persona). ${FLOW_DOC}`,
  parameters: {
    type: "object",
    properties: {
      flow_id: { type: "string" },
      name: { type: "string" },
      persona: { type: "string" },
      flow: { type: "object" },
    },
    required: ["flow_id"],
  },
  async execute(args, ctx) {
    try {
      let parsed = args.flow ? AgentFlowSchema.parse({ schema_version: 2, tool_exposure: "gateway", ...args.flow as object }) : null;
      if (parsed) {
        const normalized = normalizeFlow(parsed, "outbound");
        if ("error" in normalized) return { output: normalized };
        parsed = normalized.flow;
      }
      const instructions = parsed && args.persona ? slimInstructions(String(args.persona), parsed) : undefined;
      const ok = await updateFlow(ctx.orgId, String(args.flow_id), {
        name: args.name ? String(args.name) : undefined,
        flow: parsed ?? undefined,
        instructions,
      });
      if (!ok) return { output: { error: "flow not found" } };
      const row = await qOne<{ name: string; flow: unknown }>(
        "SELECT name, flow FROM flows WHERE id = $1", [args.flow_id]
      );
      return {
        output: { ok: true },
        flow: row!.flow as never,
        flowMeta: { id: String(args.flow_id), label: row!.name },
        notice: `Flow "${row!.name}" updated`,
      };
    } catch (e) {
      return { output: { error: (e as Error).message.slice(0, 400) } };
    }
  },
};

export const openFlowTool: OperatorTool = {
  name: "open_flow",
  description:
    "Open a flow in the user's flow panel (switches what they're looking at). Use list_flows first if unsure of ids. For a bot's inbound default, pass flow_id 'inbound:<agent_id>'.",
  parameters: {
    type: "object",
    properties: { flow_id: { type: "string" } },
    required: ["flow_id"],
  },
  async execute(args, ctx) {
    const id = String(args.flow_id);
    if (id.startsWith("inbound:")) {
      const agent = await qOne<{ name: string; flow: unknown }>(
        `SELECT a.name, v.flow FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
         WHERE a.id = $1 AND a.org_id = $2`,
        [id.slice(8), ctx.orgId]
      );
      if (!agent) return { output: { error: "agent not found" } };
      return {
        output: { ok: true, opened: `${agent.name} — inbound` },
        flow: agent.flow as never,
        flowMeta: { id, label: `${agent.name} — inbound` },
      };
    }
    const row = await qOne<{ name: string; flow: unknown }>(
      "SELECT name, flow FROM flows WHERE id = $1 AND org_id = $2", [id, ctx.orgId]
    );
    if (!row) return { output: { error: "flow not found" } };
    return { output: { ok: true, opened: row.name }, flow: row.flow as never, flowMeta: { id, label: row.name } };
  },
};

export const listFlowsTool: OperatorTool = {
  name: "list_flows",
  description: "List a bot's flows: the inbound default plus named outbound flows (with ids for open_flow/run_campaign).",
  parameters: { type: "object", properties: { agent_id: { type: "string" } } },
  async execute(args, ctx) {
    const flows = await listFlows(ctx.orgId, args.agent_id ? String(args.agent_id) : null);
    const agents = await q<{ id: string; name: string }>(
      "SELECT id, name FROM agents WHERE org_id = $1 AND ($2::uuid IS NULL OR id = $2)",
      [ctx.orgId, args.agent_id ?? null]
    );
    return {
      output: {
        inbound: agents.map((a) => ({ flow_id: `inbound:${a.id}`, name: `${a.name} — inbound` })),
        outbound: flows.map((f) => ({ flow_id: f.id, name: f.name, agent_id: f.agent_id })),
      },
    };
  },
};

export const runCampaignTool: OperatorTool = {
  name: "run_campaign",
  description:
    "Run an outbound flow against every valid phone number in a table — NOW (parallel dialing starts immediately) or at a scheduled time. Calls appear in the log live; a Scheduled tab tracks pending work.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      flow_id: { type: "string" },
      name: { type: "string", description: "Campaign name, e.g. 'July satisfaction survey'" },
      dataset: { type: "string", description: "Table slug holding the targets, e.g. customers" },
      phone_column: { type: "string", default: "phone" },
      run_at: { type: "string", description: "ISO-8601 to schedule for later; omit to dial now." },
    },
    required: ["agent_id", "flow_id", "name", "dataset"],
  },
  async execute(args, ctx) {
    try {
      const launch = await launchCampaign(ctx.orgId, {
        agentId: String(args.agent_id),
        flowId: String(args.flow_id),
        name: String(args.name),
        datasetSlug: String(args.dataset),
        phoneColumn: args.phone_column ? String(args.phone_column) : undefined,
        runAt: args.run_at ? String(args.run_at) : null,
        createdBy: `operator (${ctx.email})`,
      });
      if (!launch.scheduled) {
        const { waitUntil } = await import("@vercel/functions");
        waitUntil(kickCampaign(launch.campaignId).then(() => undefined).catch(() => {}));
      }
      return {
        output: { ...launch },
        notice: launch.scheduled
          ? `Campaign scheduled — ${launch.targets} calls at ${args.run_at}`
          : `Dialing ${launch.targets} numbers now`,
      };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};

export const listCampaignsTool: OperatorTool = {
  name: "list_campaigns",
  description: "List campaigns with live stats (answered, missed, pending, avg satisfaction).",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    return { output: await campaignStats(ctx.orgId) };
  },
};

export const cancelCampaignTool: OperatorTool = {
  name: "cancel_campaign",
  description: "Cancel a campaign: pending calls are dropped; completed calls keep their data.",
  parameters: { type: "object", properties: { campaign_id: { type: "string" } }, required: ["campaign_id"] },
  async execute(args, ctx) {
    const n = await cancelCampaign(ctx.orgId, String(args.campaign_id));
    return { output: { ok: true, canceled_pending: n }, notice: `Campaign canceled (${n} pending calls dropped)` };
  },
};

export const getRecallPolicy: OperatorTool = {
  name: "get_recall_policy",
  description: "Read a bot's cut-off recall policy: whether dropped-mid-sentence callers get an automatic callback, and the callback instructions.",
  parameters: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] },
  async execute(args, ctx) {
    const row = await qOne<{ recall_policy: unknown }>(
      "SELECT recall_policy FROM agents WHERE id = $1 AND org_id = $2", [args.agent_id, ctx.orgId]
    );
    return { output: row ? row.recall_policy : { error: "agent not found" } };
  },
};

export const setRecallPolicy: OperatorTool = {
  name: "set_recall_policy",
  description:
    "Change a bot's cut-off recall policy — toggle it or rewrite the callback instructions. The post-call analyst obeys this policy when it detects a caller was cut off mid-sentence.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      enabled: { type: "boolean" },
      instructions: { type: "string", description: "How the callback agent should behave (timing, tone, what to reference)." },
    },
    required: ["agent_id"],
  },
  async execute(args, ctx) {
    const rows = await q<{ recall_policy: unknown }>(
      `UPDATE agents SET recall_policy = recall_policy
         || CASE WHEN $3::boolean IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('enabled', $3::boolean) END
         || CASE WHEN $4::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('instructions', $4::text) END
       WHERE id = $1 AND org_id = $2 RETURNING recall_policy`,
      [args.agent_id, ctx.orgId, args.enabled ?? null, args.instructions ?? null]
    );
    if (!rows.length) return { output: { error: "agent not found" } };
    return { output: rows[0].recall_policy as Record<string, unknown>, notice: "Recall policy updated" };
  },
};
