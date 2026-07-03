// Author: Harsha Gundala
// mcp.ts — MCP gateway core: progressive-disclosure tools for live voice sessions.
// The base prompt stays slim; classify() reveals topic context + steps, begin_step() reveals execution detail.

import { q, qOne } from "./db";
import { research } from "./xai";
import { searchKnowledge, hasReadyDocuments } from "./knowledge";
import { AgentFlowSchema, topicNodes, fallbackNode, type AgentFlow } from "./flow";
import { invokeTool } from "./toolfactory/deploy";
import { queryRows, upsertRow, findCustomerByPhone } from "./datasets";
import { signScope } from "./voice";
import { sendAgentEmail } from "./email";
import { sendSms } from "./sms";
import { log } from "./log";

/** The human's number on this call, direction-aware. */
async function callerNumber(callId: string): Promise<string | null> {
  const call = await qOne<{ direction: string; from_number: string | null; to_number: string | null }>(
    "SELECT direction, from_number, to_number FROM calls WHERE id = $1", [callId]
  );
  if (!call) return null;
  return (call.direction === "outbound" ? call.to_number : call.from_number) ?? null;
}

const L = log("mcp");
const MAX_HOLD_S = 20;
const MAX_HOLD_MUSIC_S = 30;
const PROTECTED_TABLES = new Set(["calls", "call_events", "logs"]);

type Scope = { callId: string; agentId: string; orgId: string };
type McpToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

type CallCtx = {
  flow: AgentFlow;
  internetEnabled: boolean;
  allowedDomains: string[];
  docsReady: boolean;
  datasetSlugs: string[];
  holdMusic: boolean;
  mintedTools: { slug: string; description: string; input_schema: Record<string, unknown> }[];
};

async function loadCtx(scope: Scope): Promise<CallCtx> {
  const [agentRow, org, docsReady, datasets, holdMusic] = await Promise.all([
    // Campaign/recall calls carry a named flow — it overrides the agent's inbound default.
    qOne<{ flow: unknown; tool_ids: string[] }>(
      `SELECT COALESCE(f.flow, v.flow) AS flow, v.tool_ids FROM agents a
       JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
       LEFT JOIN calls c ON c.id = $3
       LEFT JOIN flows f ON f.id = c.flow_id AND f.org_id = a.org_id
       WHERE a.id = $1 AND a.org_id = $2`,
      [scope.agentId, scope.orgId, scope.callId]
    ),
    qOne<{ internet_enabled: boolean; allowed_domains: string[] }>(
      "SELECT internet_enabled, allowed_domains FROM orgs WHERE id = $1", [scope.orgId]
    ),
    hasReadyDocuments(scope.orgId),
    q<{ slug: string }>("SELECT slug FROM datasets WHERE org_id = $1 ORDER BY created_at", [scope.orgId]),
    qOne(
      `SELECT 1 AS ok FROM media_renditions mr JOIN documents d ON d.id = mr.document_id
       WHERE d.org_id = $1 AND d.meta->>'hold_music' = 'true' AND mr.kind = 'ulaw8k' LIMIT 1`,
      [scope.orgId]
    ),
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
    datasetSlugs: datasets.map((d) => d.slug),
    holdMusic: !!holdMusic,
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
        "Transfer the caller to the human support line. Say ONLY something like \"Connecting you to a human now\" — NEVER speak the phone number aloud. On phone calls this performs a real transfer.",
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
    },
    {
      name: "end_call",
      description:
        "Hang up the call. Use ONLY after the conversation has naturally concluded. CHECK FIRST: if any flow step told you to record data (write_table etc.) and you have not called that tool yet, record it NOW before ending — unrecorded answers are lost forever.",
      inputSchema: { type: "object", properties: { reason: { type: "string" } } },
    },
    {
      name: "send_email",
      description:
        "Email the caller (or another address). Omit `to` to use the caller's email from the customers table — if it isn't on file, ask for it out loud, save it with write_table, then send. Confirm before sending.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Email address; omit to use the caller's email on file." },
          subject: { type: "string" },
          message: { type: "string", description: "Plain-text body; line breaks preserved." },
        },
        required: ["subject", "message"],
      },
    },
    {
      name: "send_sms",
      description: "Text the caller (or another number). Omit `to` to text the number they're calling from. Keep it short.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "E.164 number; omit for the caller's number." },
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
    {
      name: "launch_task",
      description:
        "Hand work to a background assistant that has this call's full transcript plus the same email/text/table/search tools — for heavier reasoning or follow-ups that shouldn't block the conversation. `when:'now'` runs immediately in parallel; `when:'end_of_call'` runs after hangup (e.g. 'email this caller a summary of the call').",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Instruction for the background assistant, e.g. 'email the caller a summary and next steps'." },
          when: { type: "string", enum: ["now", "end_of_call"], default: "end_of_call" },
        },
        required: ["command"],
      },
    },
    {
      name: "read_table",
      description: `Read rows from a company data table. Tables: ${ctx.datasetSlugs.join(", ") || "none yet"}. Filter is exact-match on column values, e.g. {"phone": "+15551234567"}.`,
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", ...(ctx.datasetSlugs.length ? { enum: ctx.datasetSlugs } : {}) },
          filter: { type: "object" },
          limit: { type: "number" },
        },
        required: ["table"],
      },
    },
    {
      name: "write_table",
      description:
        "Insert or update a row in a company data table (save caller details to customers, log feedback, etc). Provide match (column equality) to update the existing row instead of inserting a duplicate.",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", ...(ctx.datasetSlugs.length ? { enum: ctx.datasetSlugs } : {}) },
          row: { type: "object" },
          match: { type: "object" },
        },
        required: ["table", "row"],
      },
    }
  );

  if (ctx.holdMusic) {
    tools.push({
      name: "play_hold_music",
      description: `Put the caller on hold WITH music (max ${MAX_HOLD_MUSIC_S}s) while you work. Say you'll be a moment first. Returns when the hold is over.`,
      inputSchema: { type: "object", properties: { seconds: { type: "number" } } },
    });
  }

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
      if (!node && id === "other") {
        // Flow has no fallback node (common for outbound flows) — give generic off-topic guidance.
        await saveEvent(scope, "state", { node: "other" });
        return {
          context: "Off-topic request for this call.",
          next_steps: [],
          guidance: "Politely steer back to the purpose of this call. If the caller needs real support, offer request_recall or suggest they call the main line.",
        };
      }
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
      return { instructions: step.instructions, always_available: ["search", "search_knowledge", "read_table", "write_table", "contact_support", "hold", "request_recall"] };
    }

    case "hold": {
      const s = Math.min(Math.max(Number(args.seconds) || 5, 1), MAX_HOLD_S);
      await saveEvent(scope, "hold_start", { seconds: s, until: new Date(Date.now() + s * 1000).toISOString() });
      await new Promise((r) => setTimeout(r, s * 1000));
      await saveEvent(scope, "hold_end", {});
      return { resumed: true, message: `Hold complete after ${s}s — thank the caller for waiting and continue.` };
    }

    case "play_hold_music": {
      if (!ctx.holdMusic) return { error: "no hold music configured for this org" };
      const s = Math.min(Math.max(Number(args.seconds) || 15, 1), MAX_HOLD_MUSIC_S);
      await saveEvent(scope, "hold_start", { seconds: s, until: new Date(Date.now() + s * 1000).toISOString(), music: true });
      await new Promise((r) => setTimeout(r, s * 1000));
      await saveEvent(scope, "hold_end", {});
      return { resumed: true, message: `Hold music finished after ${s}s — thank the caller for waiting and continue.` };
    }

    case "read_table": {
      const table = String(args.table ?? "");
      const res = await queryRows(
        scope.orgId, table,
        (args.filter as Record<string, unknown>) ?? undefined,
        Math.min(Math.max(Number(args.limit) || 20, 1), 50)
      );
      if (!res) return { error: `unknown table "${table}". Available: ${ctx.datasetSlugs.join(", ")}` };
      return { table: res.dataset.slug, count: res.rows.length, rows: res.rows.map((r) => ({ id: r.id, ...r.data })) };
    }

    case "write_table": {
      const table = String(args.table ?? "");
      if (PROTECTED_TABLES.has(table)) return { error: `"${table}" is not writable — datasets only` };
      if (!args.row || typeof args.row !== "object") return { error: "row object required" };
      try {
        const res = await upsertRow(
          scope.orgId, table,
          args.row as Record<string, unknown>,
          (args.match as Record<string, unknown>) ?? undefined
        );
        return { ok: true, id: res.id, updated: res.updated };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    case "contact_support": {
      const support = fallbackNode(ctx.flow)?.support_number;
      if (!support) return { error: "no support number configured — apologize and offer a callback via request_recall" };
      await saveEvent(scope, "state", { node: "other", transfer: support });
      const call = await qOne<{ twilio_call_sid: string | null }>(
        "SELECT twilio_call_sid FROM calls WHERE id = $1", [scope.callId]
      );
      if (call?.twilio_call_sid && process.env.TWILIO_ACCOUNT_SID) {
        // Observe-mode transfer: redirect the Twilio leg to our TwiML so the bridge keeps listening.
        const transferUrl =
          `${process.env.PUBLIC_ORIGIN}/api/telephony/twiml` +
          `?transfer=${encodeURIComponent(support)}&scope=${encodeURIComponent(signScope(scope))}`;
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${call.twilio_call_sid}.json`,
          {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ Url: transferUrl, Method: "GET" }),
          }
        );
        if (!res.ok) return { error: `transfer failed (${res.status}) — offer a callback instead` };
        return { transferred: true, message: "Transfer initiated — say 'Connecting you to a human now' and nothing else. Do NOT say the phone number." };
      }
      return { simulated: true, message: "This is a browser test call, so a real transfer isn't possible — say that on a real phone call they'd be connected to a human now. Do NOT say any phone number." };
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

    case "end_call": {
      await saveEvent(scope, "state", { state: "ending", reason: args.reason ?? null });
      const call = await qOne<{ twilio_call_sid: string | null }>(
        "SELECT twilio_call_sid FROM calls WHERE id = $1", [scope.callId]
      );
      if (call?.twilio_call_sid && process.env.TWILIO_ACCOUNT_SID) {
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
        // Fire-and-return so the agent can finish speaking its goodbye before the leg drops.
        setTimeout(() => {
          void fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${call.twilio_call_sid}.json`,
            {
              method: "POST",
              headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ Status: "completed" }),
            }
          ).catch(() => {});
        }, 4000);
        return { ok: true, message: "Call will end in a few seconds — say your goodbye now if you haven't." };
      }
      return { ok: true, simulated: true, message: "Browser call — the caller ends it from their side." };
    }

    case "send_email": {
      let to = args.to ? String(args.to).trim() : null;
      if (!to) {
        const number = await callerNumber(scope.callId);
        const customer = number ? await findCustomerByPhone(scope.orgId, number).catch(() => null) : null;
        to = customer?.email ? String(customer.email) : null;
        if (!to) return { error: "no email on file for this caller — ask for their email, save it with write_table on customers, then send_email again" };
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { error: "invalid email address" };
      const org = await qOne<{ name: string | null }>("SELECT name FROM orgs WHERE id = $1", [scope.orgId]);
      await sendAgentEmail({ to, subject: String(args.subject), message: String(args.message), brand: org?.name });
      return { ok: true, sent_to: to };
    }

    case "send_sms": {
      let to = args.to ? String(args.to).trim() : null;
      if (!to) to = await callerNumber(scope.callId);
      if (!to || !/^\+\d{7,15}$/.test(to)) return { error: "no valid number — provide `to` in E.164" };
      await sendSms(to, String(args.message));
      return { ok: true, sent_to: to };
    }

    case "launch_task": {
      const when = args.when === "now" ? "now" : "end_of_call";
      const row = await qOne<{ id: string }>(
        `INSERT INTO call_tasks (call_id, org_id, agent_id, command, trigger_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [scope.callId, scope.orgId, scope.agentId, String(args.command), when]
      );
      if (when === "now") {
        const [{ waitUntil }, { runCallTask }] = await Promise.all([import("@vercel/functions"), import("./tasks")]);
        waitUntil(runCallTask(row!.id).catch(() => {}));
      }
      return {
        ok: true, task_id: row!.id,
        message: when === "now" ? "Background assistant started — it works in parallel, continue the call." : "Queued — it will run right after this call ends.",
      };
    }

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
