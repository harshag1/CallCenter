// Author: Harsha Gundala
// mcp.ts — MCP gateway core: progressive-disclosure tools for live voice sessions.
// The base prompt stays slim; classify() reveals topic context + steps, begin_step() reveals execution detail.

import { q, qOne } from "./db";
import { research } from "./xai";
import { searchKnowledge, hasReadyDocuments } from "./knowledge";
import { AgentFlowSchema, topicNodes, fallbackNode, type AgentFlow } from "./flow";
import { invokeTool } from "./toolfactory/deploy";
import { log } from "./log";

const L = log("mcp");
const MAX_HOLD_S = 20;

type Scope = { callId: string; agentId: string; orgId: string };
type McpToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

type CallCtx = {
  flow: AgentFlow;
  internetEnabled: boolean;
  allowedDomains: string[];
  docsReady: boolean;
  mintedTools: { slug: string; description: string; input_schema: Record<string, unknown> }[];
};

async function loadCtx(scope: Scope): Promise<CallCtx> {
  const [agentRow, org, docsReady] = await Promise.all([
    qOne<{ flow: unknown; tool_ids: string[] }>(
      `SELECT v.flow, v.tool_ids FROM agents a
       JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
       WHERE a.id = $1 AND a.org_id = $2`,
      [scope.agentId, scope.orgId]
    ),
    qOne<{ internet_enabled: boolean; allowed_domains: string[] }>(
      "SELECT internet_enabled, allowed_domains FROM orgs WHERE id = $1", [scope.orgId]
    ),
    hasReadyDocuments(scope.orgId),
  ]);
  const parsed = AgentFlowSchema.safeParse(agentRow?.flow ?? { nodes: [], edges: [] });
  const mintedTools = agentRow?.tool_ids?.length
    ? await q<CallCtx["mintedTools"][number]>(
        "SELECT slug, description, input_schema FROM tools WHERE id = ANY($1) AND org_id = $2 AND deploy_status = 'live'",
        [agentRow.tool_ids, scope.orgId]
      )
    : [];
  return {
    flow: parsed.success ? parsed.data : { nodes: [], edges: [] },
    internetEnabled: org?.internet_enabled ?? false,
    allowedDomains: org?.allowed_domains ?? [],
    docsReady,
    mintedTools,
  };
}

function saveEvent(scope: Scope, type: string, payload: unknown) {
  return q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,$2,$3)", [
    scope.callId, type, JSON.stringify(payload),
  ]).catch(() => {});
}

export async function listToolsFor(scope: Scope): Promise<McpToolDef[]> {
  const ctx = await loadCtx(scope);
  const topics = topicNodes(ctx.flow);
  const tools: McpToolDef[] = [];

  if (topics.length) {
    tools.push({
      name: "classify",
      description:
        "REQUIRED first move once the caller's need is clear: classify the call into a topic. Returns the topic's context and the exact next steps available. Use 'other' when nothing fits.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", enum: [...topics.map((t) => t.id), "other"] },
        },
        required: ["topic"],
      },
    });
    tools.push({
      name: "begin_step",
      description:
        "After classify, when the caller commits to a direction, get that step's exact execution instructions. Only use step ids returned by classify.",
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string" }, step: { type: "string" } },
        required: ["topic", "step"],
      },
    });
  }

  tools.push(
    {
      name: "hold",
      description: `Put the caller on a brief hold (max ${MAX_HOLD_S}s). Say you'll check first, then call this. Returns when the hold is over.`,
      inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
    },
    {
      name: "contact_support",
      description:
        "Transfer the caller to the human support line. Announce the transfer out loud FIRST, then call this. On phone calls this performs a real transfer.",
      inputSchema: { type: "object", properties: { reason: { type: "string" } } },
    },
    {
      name: "request_recall",
      description:
        "Schedule a callback at a specific time (e.g. 'call me back tomorrow at 3pm'). Confirm number and time out loud before calling this.",
      inputSchema: {
        type: "object",
        properties: {
          to_number: { type: "string", description: "E.164" },
          run_at: { type: "string", description: "ISO-8601 UTC" },
          reason: { type: "string" },
        },
        required: ["to_number", "run_at", "reason"],
      },
    },
    {
      name: "log_note",
      description: "Attach a structured note to this call record (order numbers, outcomes, follow-ups).",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
        required: ["note"],
      },
    }
  );

  if (ctx.internetEnabled) {
    tools.push({
      name: "search",
      description: `Search the live web for current facts${ctx.allowedDomains.length ? ` (restricted to: ${ctx.allowedDomains.join(", ")})` : ""}. Use when the caller asks something outside tool-provided context.`,
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    });
  }
  if (ctx.docsReady) {
    tools.push({
      name: "search_knowledge",
      description: "Semantic search over the company's uploaded documents (policies, manuals, FAQs). Prefer this over web search for company-specific questions.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    });
  }
  for (const t of ctx.mintedTools) {
    tools.push({ name: t.slug, description: t.description, inputSchema: t.input_schema });
  }
  return tools;
}

export async function callTool(scope: Scope, name: string, args: Record<string, unknown>): Promise<unknown> {
  await saveEvent(scope, "tool_call", { name, args });
  let result: unknown;
  try {
    result = await dispatch(scope, name, args);
  } catch (e) {
    result = { error: (e as Error).message };
  }
  await saveEvent(scope, "tool_result", { name, result: JSON.stringify(result).slice(0, 2000) });
  L.info("mcp tool", { callId: scope.callId, orgId: scope.orgId, data: { name } });
  return result;
}

async function dispatch(scope: Scope, name: string, args: Record<string, unknown>): Promise<unknown> {
  const ctx = await loadCtx(scope);

  switch (name) {
    case "classify": {
      const id = String(args.topic);
      const node = id === "other" ? fallbackNode(ctx.flow) : ctx.flow.nodes.find((n) => n.id === id && n.kind === "topic");
      if (!node) return { error: `unknown topic ${id}. Valid: ${topicNodes(ctx.flow).map((t) => t.id).join(", ")}, other` };
      await saveEvent(scope, "state", { node: node.id });
      if (node.kind === "fallback") {
        return {
          context: node.context ?? "Out-of-scope request.",
          next_steps: [{ id: "transfer", label: "Contact support", when: "caller agrees to be transferred" }],
          guidance: "Offer to connect them with the support line via contact_support. If they'd rather get a callback, use request_recall.",
        };
      }
      return {
        context: node.context,
        next_steps: (node.steps ?? []).map((s) => ({ id: s.id, label: s.label })),
        guidance:
          "Work within this topic only. When the caller commits to one of next_steps, call begin_step for its exact instructions. If none fit, classify('other').",
      };
    }

    case "begin_step": {
      const node = ctx.flow.nodes.find((n) => n.id === String(args.topic));
      const step = node?.steps?.find((s) => s.id === String(args.step));
      if (!step) return { error: "unknown step — use ids returned by classify" };
      await saveEvent(scope, "state", { node: node!.id, step: step.id });
      return { instructions: step.instructions, always_available: ["search", "search_knowledge", "contact_support", "hold", "request_recall"] };
    }

    case "hold": {
      const s = Math.min(Math.max(Number(args.seconds) || 5, 1), MAX_HOLD_S);
      await saveEvent(scope, "state", { hold: s });
      await new Promise((r) => setTimeout(r, s * 1000));
      return { resumed: true, message: `Hold complete after ${s}s — thank the caller for waiting and continue.` };
    }

    case "contact_support": {
      const support = fallbackNode(ctx.flow)?.support_number;
      if (!support) return { error: "no support number configured — apologize and offer a callback via request_recall" };
      await saveEvent(scope, "state", { node: "other", transfer: support });
      const call = await qOne<{ twilio_call_sid: string | null }>(
        "SELECT twilio_call_sid FROM calls WHERE id = $1", [scope.callId]
      );
      if (call?.twilio_call_sid && process.env.TWILIO_ACCOUNT_SID) {
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${call.twilio_call_sid}.json`,
          {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ Twiml: `<Response><Dial>${support}</Dial></Response>` }),
          }
        );
        if (!res.ok) return { error: `transfer failed (${res.status}) — offer a callback instead` };
        return { transferred: true, to: support };
      }
      return { simulated: true, to: support, message: `Browser call — tell the caller you'd transfer them to ${support} on a real line.` };
    }

    case "request_recall": {
      const row = await qOne<{ id: string }>(
        `INSERT INTO scheduled_calls (agent_id, to_number, run_at, reason, parent_call_id, created_by)
         VALUES ($1,$2,$3,$4,$5,'voice-agent') RETURNING id`,
        [scope.agentId, args.to_number, args.run_at, args.reason ?? null, scope.callId]
      );
      return { ok: true, scheduled_id: row!.id, message: `Callback scheduled for ${args.run_at}` };
    }

    case "log_note":
      await q("UPDATE calls SET metadata = metadata || $2 WHERE id = $1", [
        scope.callId,
        JSON.stringify({ notes: [{ note: args.note, tags: args.tags ?? [], ts: new Date().toISOString() }] }),
      ]);
      return { ok: true };

    case "search": {
      if (!ctx.internetEnabled) return { error: "internet access is disabled for this org" };
      const text = await research(
        `Answer for a live phone agent: 2-4 dense factual sentences, no preamble.${ctx.allowedDomains.length ? ` Only use information from these domains: ${ctx.allowedDomains.join(", ")}.` : ""}`,
        String(args.query),
        600,
        ctx.allowedDomains.length ? ctx.allowedDomains : undefined
      );
      return { findings: text };
    }

    case "search_knowledge": {
      const hits = await searchKnowledge(scope.orgId, String(args.query));
      if (!hits.length) return { results: [], note: "nothing relevant in uploaded documents" };
      return { results: hits.map((h) => ({ source: h.filename, excerpt: h.content.slice(0, 1200), score: Number(h.score.toFixed(3)) })) };
    }

    default: {
      const tool = ctx.mintedTools.find((t) => t.slug === name);
      if (!tool) return { error: `unknown tool ${name}` };
      const row = await qOne<{ endpoint_url: string | null }>(
        "SELECT endpoint_url FROM tools WHERE org_id = $1 AND slug = $2 AND deploy_status = 'live'",
        [scope.orgId, name]
      );
      return row?.endpoint_url ? await invokeTool(row.endpoint_url, args) : { error: `tool ${name} not deployed` };
    }
  }
}
