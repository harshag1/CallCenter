// Author: Harsha Gundala
// mcp.ts — MCP gateway core: progressive-disclosure tools for live voice sessions.
// The base prompt stays slim; classify() reveals topic context + steps, begin_step() reveals execution detail.

import { randomUUID } from "node:crypto";
import { q, qOne } from "./db";
import { research } from "./xai";
import { searchKnowledge, hasReadyDocuments } from "./knowledge";
import {
  AgentFlowSchema,
  alwaysActionPolicies,
  alwaysTools,
  fallbackNode,
  findStep,
  flowToolExposure,
  topicEntryStepPaths,
  topicNodes,
  type AgentFlow,
} from "./flow";
import {
  completeFlowStep,
  describeNextSteps,
  enterFlowStep,
  flowCapabilityScope,
  flowStateSummary,
  grantedTools,
  hashFlowValue,
  selectFlowTopic,
  type FlowExecutionState,
  type RuntimeError,
} from "./flow-runtime";
import {
  loadFlowState,
  reserveFlowActionAtomic,
  settleFlowActionAtomic,
  withLockedFlowState,
} from "./flow-state-store";
import { signFlowCapability, verifyFlowCapability } from "./flow-capability";
import { invokeTool } from "./toolfactory/deploy";
import { queryRows, upsertRow, findCustomerByPhone } from "./datasets";
import { signScope } from "./voice";
import { sendAgentEmail } from "./email";
import { sendSms } from "./sms";
import { log } from "./log";
import { voiceToolExtensions, type VoiceToolScope } from "./voice-tools";
import { CALL_RUNTIME_SNAPSHOT_QUERY } from "./call-runtime-query";
import { parseCallRuntimeSnapshot } from "./call-runtime-snapshot";

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

type Scope = VoiceToolScope;
type McpToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

type CallCtx = {
  flow: AgentFlow;
  internetEnabled: boolean;
  allowedDomains: string[];
  docsReady: boolean;
  datasetSlugs: string[];
  holdMusic: boolean;
  runtimeDigest: string | null;
  mintedTools: { slug: string; description: string; input_schema: Record<string, unknown>; endpoint_url: string | null }[];
  extensionTools: McpToolDef[];
};

type LeasedToolDef = McpToolDef & {
  capability_grant: string;
  capability_expires_at: string;
  policy: {
    idempotency: "none" | "per_step" | "per_arguments" | "per_call" | "per_call_arguments";
    max_calls?: number;
  };
};

type EnterStepSuccess = Exclude<ReturnType<typeof enterFlowStep>, RuntimeError>;
type CompleteStepSuccess = Exclude<ReturnType<typeof completeFlowStep>, RuntimeError>;

async function loadCtx(scope: Scope): Promise<CallCtx> {
  const [agentRow, org, docsReady, datasets, holdMusic] = await Promise.all([
    // Campaign/recall calls carry a named flow — it overrides the agent's inbound default.
    qOne<{ flow: unknown; tool_ids: string[]; runtime_snapshot: unknown | null; runtime_digest: string | null }>(CALL_RUNTIME_SNAPSHOT_QUERY, [
      scope.agentId, scope.orgId, scope.callId,
    ]),
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
  const pinned = agentRow?.runtime_snapshot
    ? parseCallRuntimeSnapshot(agentRow.runtime_snapshot, agentRow.runtime_digest)
    : null;
  const parsed = AgentFlowSchema.safeParse(pinned?.snapshot.flow ?? agentRow?.flow ?? { nodes: [], edges: [] });
  const mintedTools = pinned
    ? pinned.snapshot.toolManifest.map((tool) => ({
        slug: tool.slug,
        description: tool.description,
        input_schema: tool.inputSchema,
        endpoint_url: tool.endpointUrl,
      }))
    : agentRow?.tool_ids?.length
    ? await q<CallCtx["mintedTools"][number]>(
        "SELECT slug, description, input_schema, endpoint_url FROM tools WHERE id = ANY($1) AND org_id = $2 AND deploy_status = 'live'",
        [agentRow.tool_ids, scope.orgId]
      )
    : [];
  const environment = pinned?.snapshot.environment;
  return {
    flow: parsed.success ? parsed.data : { nodes: [], edges: [] },
    internetEnabled: environment?.internetEnabled ?? org?.internet_enabled ?? false,
    allowedDomains: environment?.allowedDomains ?? org?.allowed_domains ?? [],
    docsReady: environment?.docsReady ?? docsReady,
    datasetSlugs: environment?.datasetSlugs ?? datasets.map((d) => d.slug),
    holdMusic: environment?.holdMusic ?? !!holdMusic,
    runtimeDigest: pinned?.digest ?? null,
    mintedTools,
    extensionTools: pinned?.snapshot.extensionManifest ?? await voiceToolExtensions.definitions(scope),
  };
}

function saveEvent(scope: Scope, type: string, payload: unknown) {
  return q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,$2,$3)", [
    scope.callId, type, JSON.stringify(payload),
  ]).catch(() => {});
}

async function listToolCatalogFor(scope: Scope, loaded?: CallCtx): Promise<McpToolDef[]> {
  const ctx = loaded ?? await loadCtx(scope);
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
      description: `Search the live web for current facts${ctx.allowedDomains.length ? ` (restricted to: ${ctx.allowedDomains.join(", ")})` : ""}. Takes several seconds — ALWAYS say a short natural line first ("Let me look that up for you…") so the caller is never in silence, THEN call this.`,
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
  tools.push(...ctx.extensionTools);
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`voice tool name collision: "${tool.name}"`);
    names.add(tool.name);
  }
  return tools;
}

const FLOW_CONTROL_TOOLS = new Set(["classify", "enter_step", "complete_step", "get_flow_state", "run_action"]);

function runtimeDigest(ctx: CallCtx, catalog: McpToolDef[]): string {
  return ctx.runtimeDigest ?? hashFlowValue({
    flow: ctx.flow,
    tools: [...catalog]
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}

function leasedActionsFor(
  scope: Scope,
  ctx: CallCtx,
  state: FlowExecutionState,
  catalog: McpToolDef[],
  digest = runtimeDigest(ctx, catalog)
): LeasedToolDef[] {
  const allowed = new Set(grantedTools(ctx.flow, state));
  const scopeState = flowCapabilityScope(state);
  const ref = state.currentStep && !state.completedSteps.includes(state.currentStep)
    ? findStep(ctx.flow, state.currentStep)
    : undefined;
  return catalog.filter((tool) => allowed.has(tool.name) && !FLOW_CONTROL_TOOLS.has(tool.name)).map((tool) => {
    const policy = ref?.step.action_policies?.find((candidate) => candidate.tool === tool.name)
      ?? alwaysActionPolicies(ctx.flow).find((candidate) => candidate.tool === tool.name);
    const signed = signFlowCapability({
      callId: scope.callId,
      agentId: scope.agentId,
      orgId: scope.orgId,
      runtimeDigest: digest,
      capabilityEpoch: state.capabilityEpoch,
      step: scopeState.step,
      attempt: scopeState.attempt,
      tool: tool.name,
    });
    return {
      ...tool,
      capability_grant: signed.token,
      capability_expires_at: signed.expiresAt,
      policy: {
        idempotency: policy?.idempotency ?? "none",
        ...(policy?.max_calls !== undefined ? { max_calls: policy.max_calls } : {}),
      },
    };
  });
}

async function flowStateWithLeases(
  scope: Scope,
  ctx: CallCtx,
  state: FlowExecutionState,
  catalog?: McpToolDef[]
) {
  const resolvedCatalog = catalog ?? await listToolCatalogFor(scope, ctx);
  return {
    ...flowStateSummary(ctx.flow, state),
    available_actions: leasedActionsFor(scope, ctx, state, resolvedCatalog),
  };
}

/**
 * Flow v2 keeps the initial model context intentionally small. Step-specific actions are
 * returned by enter_step and invoked through run_action, where the runtime enforces grants.
 */
export async function listToolsFor(scope: Scope): Promise<McpToolDef[]> {
  const ctx = await loadCtx(scope);
  const catalog = await listToolCatalogFor(scope, ctx);
  if (flowToolExposure(ctx.flow) === "direct") return catalog;

  const classify = catalog.find((tool) => tool.name === "classify");
  const controls: McpToolDef[] = [
    ...(classify ? [classify] : []),
    {
      name: "enter_step",
      description: "Enter one of the step paths returned by classify, complete_step, or get_flow_state. Returns only the context and action schemas needed for that step.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path such as membership.renew.verify_identity" } },
        required: ["path"],
      },
    },
    {
      name: "complete_step",
      description: "Commit the active checkpoint and unlock valid next steps. Receipt-bound outputs are populated by the runtime; include only conversational outputs and any matching values you want checked.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, outputs: { type: "object" } },
        required: ["outputs"],
      },
    },
    {
      name: "get_flow_state",
      description: "Recover the durable flow checkpoint, currently granted actions, and valid next steps after uncertainty or reconnection.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "run_action",
      description: "Execute an action granted by the active flow step. Copy its capability_grant exactly from enter_step/get_flow_state; stale, edited, or replayed grants fail closed.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: { type: "object" },
          capability_grant: { type: "string", description: "Opaque short-lived grant returned beside this action." },
        },
        required: ["name", "arguments", "capability_grant"],
      },
    },
  ];
  // Every business action, including always-available ones, goes through run_action so delayed
  // realtime calls cannot bypass epoch checks or the exactly-once admission ledger.
  return controls;
}

const BACKGROUND_TOOL_NAMES = new Set([
  "send_email",
  "send_sms",
  "read_table",
  "write_table",
  "search",
  "search_knowledge",
  "log_note",
]);

export async function listToolsForAudience(
  scope: Scope,
  audience: "realtime" | "background"
): Promise<McpToolDef[]> {
  if (audience === "realtime") return listToolsFor(scope);
  const ctx = await loadCtx(scope);
  return (await listToolCatalogFor(scope, ctx)).filter((tool) => BACKGROUND_TOOL_NAMES.has(tool.name));
}

export async function callTool(scope: Scope, name: string, args: Record<string, unknown>): Promise<unknown> {
  return callToolForAudience(scope, "realtime", name, args);
}

export async function callToolForAudience(
  scope: Scope,
  audience: "realtime" | "background",
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (audience === "background" && !BACKGROUND_TOOL_NAMES.has(name)) {
    return { error: `tool "${name}" is not available to background tasks`, code: "wrong_tool_audience" };
  }
  await saveEvent(scope, "tool_call", { name, args, audience });
  let result: unknown;
  try {
    result = await dispatch(scope, name, args, audience === "background");
  } catch (e) {
    result = { error: (e as Error).message };
  }
  await saveEvent(scope, "tool_result", { name, result: JSON.stringify(result).slice(0, 2000), audience });
  L.info("mcp tool", { callId: scope.callId, orgId: scope.orgId, data: { name, audience } });
  return result;
}

async function dispatch(
  scope: Scope,
  name: string,
  args: Record<string, unknown>,
  bypassGateway = false
): Promise<unknown> {
  const ctx = await loadCtx(scope);

  if (
    !bypassGateway &&
    flowToolExposure(ctx.flow) === "gateway" &&
    !FLOW_CONTROL_TOOLS.has(name) &&
    !alwaysTools(ctx.flow).includes(name)
  ) {
    return { error: `action "${name}" is not globally available; enter the correct flow step and use run_action` };
  }

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
      if (ctx.flow.schema_version === 2) {
        const selected = await withLockedFlowState<{
          result: FlowExecutionState | RuntimeError;
          alreadySelected: boolean;
        }>(scope.callId, (current) => {
          const next = selectFlowTopic(ctx.flow, current, node.id);
          if ("error" in next) return { value: { result: next, alreadySelected: false } };
          return {
            ...(next !== current ? { state: next } : {}),
            value: { result: next, alreadySelected: next === current && !!current.currentStep },
          };
        });
        if ("error" in selected.value.result) return selected.value.result;
        if (selected.value.alreadySelected) {
          return {
            already_selected: true,
            guidance: "This topic is already active. Continue from the durable state instead of restarting its entry steps.",
            state: await flowStateWithLeases(scope, ctx, selected.state),
          };
        }
      }
      if (node.kind === "fallback") {
        return {
          context: node.context ?? "Out-of-scope request.",
          next_steps: [{ id: "transfer", label: "Contact support", when: "caller agrees to be transferred" }],
          guidance: "Offer to connect them with the support line via contact_support. If they'd rather get a callback, use request_recall.",
          ...(ctx.flow.schema_version === 2
            ? { state: await flowStateWithLeases(scope, ctx, await loadFlowState(scope.callId)) }
            : {}),
        };
      }
      return {
        context: node.context,
        next_steps: ctx.flow.schema_version === 2
          ? topicEntryStepPaths(ctx.flow, node.id).map((path) => {
              const step = findStep(ctx.flow, path)?.step;
              return { id: step?.id ?? path, path, label: step?.label ?? path, context: step?.context };
            })
          : (node.steps ?? []).map((s) => ({
              id: s.id,
              path: `${node.id}.${s.id}`,
              label: s.label,
              context: s.context,
            })),
        guidance:
          ctx.flow.schema_version === 2
            ? "Work within this topic only. When the caller commits to one of next_steps, call enter_step with its path. If none fit, classify('other')."
            : "Work within this topic only. When the caller commits to one of next_steps, call begin_step for its exact instructions. If none fit, classify('other').",
        ...(ctx.flow.schema_version === 2
          ? { state: await flowStateWithLeases(scope, ctx, await loadFlowState(scope.callId)) }
          : {}),
      };
    }

    case "begin_step": {
      if (ctx.flow.schema_version === 2) {
        return { error: "flow v2 uses enter_step with an absolute path" };
      }
      const node = ctx.flow.nodes.find((n) => n.id === String(args.topic));
      const step = node?.steps?.find((s) => s.id === String(args.step));
      if (!step) return { error: "unknown step — use ids returned by classify" };
      await saveEvent(scope, "state", { node: node!.id, step: step.id });
      return { instructions: step.instructions, always_available: ["search", "search_knowledge", "read_table", "write_table", "contact_support", "hold", "request_recall"] };
    }

    case "enter_step": {
      const transition = await withLockedFlowState<EnterStepSuccess | RuntimeError>(scope.callId, (state) => {
        const entered = enterFlowStep(ctx.flow, state, String(args.path ?? ""));
        return "error" in entered
          ? { value: entered }
          : { state: entered.state, value: entered };
      });
      const entered = transition.value;
      if ("error" in entered) return entered;
      const saved = transition.state;
      const catalog = await listToolCatalogFor(scope, ctx);
      const digest = runtimeDigest(ctx, catalog);
      return {
        path: entered.path,
        context: entered.step.context,
        instructions: entered.step.instructions,
        success_criteria: entered.step.success_criteria ?? [],
        required_outputs: entered.step.required_outputs ?? [],
        output_bindings: entered.step.output_bindings ?? [],
        checkpoint: entered.step.checkpoint ?? false,
        available_actions: leasedActionsFor(scope, ctx, saved, catalog, digest),
        next_steps: describeNextSteps(ctx.flow, saved),
        capability_epoch: saved.capabilityEpoch,
        runtime_digest: digest,
        revision: saved.revision,
      };
    }

    case "complete_step": {
      let completedPath = "";
      const transition = await withLockedFlowState<CompleteStepSuccess | RuntimeError>(scope.callId, (state) => {
        completedPath = String(args.path ?? state.currentStep ?? "");
        const completed = completeFlowStep(ctx.flow, state, {
          path: args.path ? String(args.path) : undefined,
          outputs: (args.outputs as Record<string, unknown>) ?? {},
        });
        return "error" in completed
          ? { value: completed }
          : { state: completed.state, value: completed };
      });
      const completed = transition.value;
      if ("error" in completed) return completed;
      const saved = transition.state;
      await saveEvent(scope, "state", {
        node: saved.nodeId,
        step: saved.currentStep,
        completed: completedPath,
        capability_epoch: saved.capabilityEpoch,
        revision: saved.revision,
      });
      return flowStateWithLeases(scope, ctx, saved);
    }

    case "get_flow_state": {
      return flowStateWithLeases(scope, ctx, await loadFlowState(scope.callId));
    }

    case "run_action": {
      const action = String(args.name ?? "");
      if (FLOW_CONTROL_TOOLS.has(action)) return { error: "flow control tools cannot be nested inside run_action" };
      const state = await loadFlowState(scope.callId);
      const actionArgs = args.arguments && typeof args.arguments === "object"
        ? args.arguments as Record<string, unknown>
        : {};
      const catalog = await listToolCatalogFor(scope, ctx);
      const digest = runtimeDigest(ctx, catalog);
      const capabilityScope = flowCapabilityScope(state);
      const verified = verifyFlowCapability(String(args.capability_grant ?? ""), {
        callId: scope.callId,
        agentId: scope.agentId,
        orgId: scope.orgId,
        runtimeDigest: digest,
        capabilityEpoch: state.capabilityEpoch,
        step: capabilityScope.step,
        attempt: capabilityScope.attempt,
        tool: action,
      });
      if ("error" in verified) return verified;

      const receiptId = randomUUID();
      const ownerToken = randomUUID();
      const reservation = await reserveFlowActionAtomic(scope.callId, ctx.flow, {
        receiptId,
        ownerToken,
        runtimeDigest: digest,
        tool: action,
        arguments: actionArgs,
        capabilityEpoch: verified.claims.capabilityEpoch,
      });
      if ("error" in reservation) return reservation;
      if (!reservation.execute) {
        if (reservation.receipt.status === "succeeded") {
          return {
            ...(reservation.receipt.result && typeof reservation.receipt.result === "object"
              ? reservation.receipt.result as Record<string, unknown>
              : { result: reservation.receipt.result }),
            receipt_id: reservation.receipt.id,
            replayed: true,
          };
        }
        if (reservation.receipt.status === "indeterminate") {
          return {
            error: "the prior action may have committed and requires reconciliation before retrying",
            code: "action_indeterminate",
            receipt_id: reservation.receipt.id,
          };
        }
        return { pending: true, receipt_id: reservation.receipt.id };
      }

      await saveEvent(scope, "tool_call", {
        name: action,
        arguments_hash: reservation.receipt.argumentsHash,
        receipt_id: reservation.receipt.id,
        capability_epoch: reservation.receipt.capabilityEpoch,
        via: "run_action",
      });
      let result: unknown;
      try {
        result = await dispatch(scope, action, actionArgs, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : "action execution failed without a result";
        await settleFlowActionAtomic(scope.callId, {
          receiptId: reservation.receipt.id,
          ownerToken,
          status: "indeterminate",
          error: message,
          deliveryState: "unknown",
        });
        await saveEvent(scope, "tool_result", {
          name: action,
          receipt_id: reservation.receipt.id,
          status: "indeterminate",
          via: "run_action",
        });
        return {
          error: "action outcome is indeterminate; recover or reconcile before retrying",
          code: "action_indeterminate",
          receipt_id: reservation.receipt.id,
        };
      }
      const failed = !!result && typeof result === "object" && "error" in result;
      const settled = await settleFlowActionAtomic(scope.callId, {
        receiptId: reservation.receipt.id,
        ownerToken,
        status: failed ? "failed" : "succeeded",
        result,
        ...(failed ? { error: String((result as { error: unknown }).error), deliveryState: "not_sent" as const } : { deliveryState: "committed" as const }),
      });
      if ("error" in settled) return settled;
      await saveEvent(scope, "tool_result", {
        name: action,
        receipt_id: settled.receipt.id,
        result_hash: settled.receipt.resultHash,
        status: settled.receipt.status,
        via: "run_action",
      });
      if (failed) {
        return {
          ...(result as Record<string, unknown>),
          receipt_id: settled.receipt.id,
          receipt_status: settled.receipt.status,
        };
      }
      return {
        ...(result && typeof result === "object" ? result as Record<string, unknown> : { result }),
        receipt_id: settled.receipt.id,
        receipt_status: settled.receipt.status,
      };
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
      if (ctx.flow.schema_version === 2 && flowToolExposure(ctx.flow) === "gateway") {
        const state = await loadFlowState(scope.callId);
        const node = ctx.flow.nodes.find((candidate) => candidate.id === state.nodeId);
        const unresolved = state.actionReceipts.filter((receipt) =>
          receipt.status === "reserved" || receipt.status === "indeterminate"
        );
        const terminal = state.status === "completed" || state.status === "failed" || node?.kind === "fallback";
        if (!terminal || unresolved.length) {
          return {
            error: unresolved.length
              ? "the call has unresolved actions that must settle or be reconciled before ending"
              : "the active flow is incomplete; finish it or use the explicit fallback/handoff path before ending",
            code: unresolved.length ? "unresolved_actions" : "flow_incomplete",
            unresolved_receipts: unresolved.map((receipt) => receipt.id),
            state: await flowStateWithLeases(scope, ctx, state),
          };
        }
      }
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
        `Answer for a live phone agent: 2-3 dense factual sentences, no preamble. Run AT MOST ONE web search.${ctx.allowedDomains.length ? ` Only use information from these domains: ${ctx.allowedDomains.join(", ")}.` : ""}`,
        String(args.query),
        400,
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
      if (voiceToolExtensions.has(name)) return voiceToolExtensions.execute(name, args, scope);
      const tool = ctx.mintedTools.find((t) => t.slug === name);
      if (!tool) return { error: `unknown tool ${name}` };
      return tool.endpoint_url ? await invokeTool(tool.endpoint_url, args) : { error: `tool ${name} not deployed in this call's runtime snapshot` };
    }
  }
}
