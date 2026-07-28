// Author: Harsha Gundala
// flows-tools.ts — operator tools: outbound flows, campaign runs/scheduling, recall policy control.

import { q, qOne } from "../../db";
import {
  campaignAuthorizationArguments,
  campaignStats,
  cancelCampaign,
  createFlow,
  listFlows,
  previewCampaignForProposal,
  updateFlow,
} from "../../campaigns";
import { slimInstructions, AgentFlowSchema, normalizeFlow } from "../../flow";
import {
  createVoiceCampaignCostQuote,
  resolveVoiceMaxDurationSeconds,
} from "../../operator-pricing";
import type { OperatorTool } from "../types";
import {
  operatorActionArgumentsSha256,
  proposeOperatorAction,
} from "./operator-capability-policy";

const TOOL_NAME_PATTERN = "^[a-z][a-z0-9_.-]{1,63}$";
const FLOW_ID_PATTERN = "^[A-Za-z0-9_-]{1,64}$";
const FLOW_MAX_STEP_DEPTH = 8;

type JsonSchema = Record<string, unknown>;

const stringArraySchema = (description: string): JsonSchema => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1 },
});

const toolArraySchema = (description: string): JsonSchema => ({
  type: "array",
  description,
  items: { type: "string", pattern: TOOL_NAME_PATTERN },
});

const boundArgumentSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  description: "A host-resolved argument. The voice model must omit this argument; the gateway copies it from a successful receipt in the current step attempt.",
  properties: {
    argument: {
      type: "string",
      pattern: "^[A-Za-z_][A-Za-z0-9_-]{0,63}$",
      description: "Argument on the target tool that the model is not allowed to provide.",
    },
    source: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["receipt_result"] },
        tool: {
          type: "string",
          pattern: TOOL_NAME_PATTERN,
          description: "Granted source tool whose successful current-attempt receipt is authoritative.",
        },
        result_path: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "Safe dot path in the source receipt result, or $ for the full result.",
        },
      },
      required: ["kind", "tool", "result_path"],
    },
  },
  required: ["argument", "source"],
};

const reconciliationValueSourceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: {
      type: "string",
      enum: ["invocation_id", "call_id", "organization_id", "agent_id", "action_argument", "literal"],
    },
    path: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description: "Required only when source is action_argument.",
    },
    value: {
      description: "Required only when source is literal; terminal discriminator literals must be scalar JSON.",
    },
  },
  required: ["source"],
};

const reconciliationPredicateSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    resultPath: { type: "string", minLength: 1, maxLength: 512 },
    equals: reconciliationValueSourceSchema,
  },
  required: ["resultPath", "equals"],
};

const reconciliationSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  description: "Pinned authoritative read-back for an indeterminate write. Both terminal branches must echo invocation_id and contain distinct scalar literals on a shared discriminator path.",
  properties: {
    queryTool: {
      type: "string",
      pattern: TOOL_NAME_PATTERN,
      description: "Distinct pinned read-only proof action.",
    },
    queryArguments: {
      type: "object",
      description: "Host-derived proof arguments. At least one value source must be invocation_id.",
      additionalProperties: reconciliationValueSourceSchema,
    },
    committedWhen: {
      type: "array",
      minItems: 2,
      maxItems: 16,
      items: reconciliationPredicateSchema,
    },
    absentWhen: {
      type: "array",
      minItems: 2,
      maxItems: 16,
      items: reconciliationPredicateSchema,
    },
    queryOutputSchema: {
      type: "object",
      description: "Optional bounded JSON Schema for a proof action without its own pinned output schema.",
    },
    authoritativeResultPath: { type: "string", minLength: 1, maxLength: 512 },
    authoritativeResultSchema: {
      type: "object",
      description: "Required only when the mutated action has no pinned output schema.",
    },
    maxProofAttempts: { type: "integer", minimum: 1, maximum: 10 },
  },
  required: [
    "queryTool",
    "queryArguments",
    "committedWhen",
    "absentWhen",
    "authoritativeResultPath",
  ],
};

const actionPolicySchema = (allowBoundArguments: boolean): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  description: "Server-enforced admission, replay, and effect policy for one granted action.",
  properties: {
    tool: { type: "string", pattern: TOOL_NAME_PATTERN },
    max_calls: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Maximum successful executions admitted in this policy scope.",
    },
    idempotency: {
      type: "string",
      enum: ["none", "per_step", "per_arguments", "per_call", "per_call_arguments"],
      description: "Use a non-none scope for writes and opaque effects.",
    },
    effect: {
      type: "string",
      enum: ["read", "write", "opaque"],
      description: "Immutable operator-authored effect classification.",
    },
    reconciliation: reconciliationSchema,
    ...(allowBoundArguments ? {
      bound_arguments: {
        type: "array",
        maxItems: 64,
        description: "Arguments injected from authoritative receipts. They cannot be supplied or overridden by the model.",
        items: boundArgumentSchema,
      },
    } : {}),
  },
  required: ["tool"],
});

const outputBindingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  description: "Commits a durable step output only from the named tool's successful receipt in the current attempt.",
  properties: {
    output: { type: "string", minLength: 1 },
    tool: { type: "string", pattern: TOOL_NAME_PATTERN },
    result_path: {
      type: "string",
      minLength: 1,
      description: "Dot path inside the authoritative action result.",
    },
    value_type: {
      type: "string",
      enum: ["string", "number", "boolean", "object", "array"],
      description: "Optional runtime type check before the value can be committed.",
    },
  },
  required: ["output", "tool", "result_path"],
};

const transitionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    to: {
      type: "string",
      minLength: 1,
      description: "Absolute target path, including the topic node id (for example returns.verify.eligibility).",
    },
    label: { type: "string", minLength: 1 },
    when: {
      type: "string",
      minLength: 1,
      description: "Human-readable branch guidance. This text is not a machine guard.",
    },
    condition: {
      type: "object",
      additionalProperties: false,
      description: "Machine-enforced condition over an output persisted by the step being completed. Receipt-bind consequential branch outputs.",
      properties: {
        output: { type: "string", minLength: 1 },
        operator: { type: "string", enum: ["equals", "not_equals", "exists", "in"] },
        value: {
          description: "Required for equals/not_equals; an array is required for in; omit for exists.",
        },
      },
      required: ["output", "operator"],
    },
  },
  required: ["to"],
};

function flowStepSchema(depth: number): JsonSchema {
  const properties: Record<string, unknown> = {
    id: { type: "string", pattern: FLOW_ID_PATTERN },
    label: { type: "string", minLength: 1 },
    instructions: {
      type: "string",
      minLength: 1,
      description: "Exact behavior disclosed only when this step is active.",
    },
    context: {
      type: "string",
      minLength: 1,
      description: "Knowledge scoped to this step and its descendants.",
    },
    tools: toolArraySchema("Actions granted while this step or one of its descendants is active."),
    required_outputs: stringArraySchema("Durable output keys that must be present before this step can complete."),
    output_bindings: {
      type: "array",
      description: "Receipt-authoritative durable outputs. Use these for decisions and consequential completion state.",
      items: outputBindingSchema,
    },
    action_policies: {
      type: "array",
      description: "Admission policies for granted actions, including host-bound arguments for chained operations.",
      items: actionPolicySchema(true),
    },
    success_criteria: stringArraySchema("Reviewable completion criteria for the active step."),
    transitions: {
      type: "array",
      description: "Explicit next-step branches. Targets are always absolute paths.",
      items: transitionSchema,
    },
    on_failure: {
      type: "string",
      minLength: 1,
      description: "Absolute recovery path unlocked only after max_attempts is reached.",
    },
    max_attempts: { type: "integer", minimum: 1, maximum: 10 },
    checkpoint: {
      type: "boolean",
      description: "Persist a recovery marker after successful completion.",
    },
  };
  if (depth === 1) {
    properties.entry = {
      type: "boolean",
      description: "Marks this top-level step as directly selectable after classification.",
    };
  }
  if (depth < FLOW_MAX_STEP_DEPTH) {
    properties.steps = {
      type: "array",
      description: `Nested control steps (current depth ${depth}; maximum ${FLOW_MAX_STEP_DEPTH}). Children inherit node and ancestor tools but not sibling tools.`,
      items: flowStepSchema(depth + 1),
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["id", "label", "instructions"],
  };
}

/** Provider-facing authoring schema. It is deliberately reference-free and unrolled to
 * the runtime's eight-level limit so every supported model receives the same contract. */
export const FLOW_V2_AUTHORING_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  description: "Flow v2 progressive-disclosure graph. The server pins schema_version=2 and tool_exposure=gateway.",
  properties: {
    schema_version: { type: "integer", enum: [2] },
    tool_exposure: { type: "string", enum: ["gateway"] },
    max_step_entries: {
      type: "integer",
      minimum: 1,
      maximum: 10_000,
      description: "Call-level circuit breaker across all step entries and retries.",
    },
    always_tools: toolArraySchema("Rare actions available throughout the call, still gated by run_action."),
    always_action_policies: {
      type: "array",
      description: "Policies for always_tools. Receipt-bound arguments are intentionally step-only and cannot be declared here.",
      items: actionPolicySchema(false),
    },
    nodes: {
      type: "array",
      description: "Exactly one step-free incoming_call entry, one or more topic nodes, and an optional fallback.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: FLOW_ID_PATTERN },
          label: { type: "string", minLength: 1 },
          kind: { type: "string", enum: ["incoming_call", "topic", "fallback"] },
          icon: { type: "string" },
          context: {
            type: "string",
            description: "Topic/fallback context disclosed only after routing.",
          },
          tools: toolArraySchema("Actions inherited by every active step in this topic."),
          steps: {
            type: "array",
            description: "Recursive topic workflow. Steps are invalid on incoming_call nodes.",
            items: flowStepSchema(1),
          },
          support_number: { type: "string" },
          table: { type: "string" },
        },
        required: ["id", "label", "kind"],
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string", minLength: 1 },
          to: { type: "string", minLength: 1 },
          label: { type: "string" },
          when: { type: "string" },
        },
        required: ["from", "to"],
      },
    },
  },
  required: ["nodes", "edges"],
};

const FLOW_DOC = `Author Flow v2 as a progressive-disclosure state machine. Exactly one incoming_call node is step-free; topic steps can nest eight levels. Node and ancestor tools are inherited only while their descendant is active. required_outputs block completion. output_bindings commit values from successful current-attempt action receipts; use them for machine conditions. action_policies enforce max_calls, effect, idempotency, reconciliation, and bound_arguments. A bound argument is injected by the host from a prior receipt and MUST NOT be requested from the model. transitions use absolute paths; "when" is guidance while "condition" is enforced. on_failure unlocks only at max_attempts. Keep always_tools rare.`;
const CAMPAIGN_REQUEST_PROPERTIES = Object.freeze({
  agent_id: { type: "string" },
  flow_id: { type: "string" },
  name: { type: "string", description: "Campaign name, e.g. 'July satisfaction survey'" },
  dataset: { type: "string", description: "Table slug holding the targets, e.g. customers" },
  phone_column: { type: "string", default: "phone" },
  run_at: { type: "string", description: "ISO-8601 to schedule for later; omit to make the jobs immediately eligible." },
  max_duration_seconds: { type: "number", description: "Optional per-call connected duration limit; defaults to the deployment cap." },
});

async function prepareCampaign(args: Record<string, unknown>, orgId: string) {
  const targetSnapshot = await previewCampaignForProposal(orgId, {
    agentId: String(args.agent_id ?? ""),
    flowId: String(args.flow_id ?? ""),
    datasetSlug: String(args.dataset ?? ""),
    phoneColumn: args.phone_column ? String(args.phone_column) : undefined,
  });
  const preview = targetSnapshot.preview;
  const agent = await qOne<{ phone_number: string | null }>(
    "SELECT phone_number FROM agents WHERE id = $1 AND org_id = $2",
    [preview.agentId, orgId]
  );
  if (!agent?.phone_number) throw new Error("campaign agent has no approved outbound phone number");
  const maxDurationSeconds = resolveVoiceMaxDurationSeconds(args.max_duration_seconds);
  const costQuote = createVoiceCampaignCostQuote({
    originE164: agent.phone_number,
    destinationE164s: targetSnapshot.displayTargets,
    targetSetSha256: preview.targetSetSha256,
    maxDurationSeconds,
  });
  const reservationMicroUsd = costQuote.reservationMicroUsd;
  const authorization = campaignAuthorizationArguments(preview, {
    name: String(args.name ?? ""),
    runAt: args.run_at ? String(args.run_at) : null,
    fromNumber: agent.phone_number,
    maxDurationSeconds,
    costQuote,
    worstCaseMicroUsd: reservationMicroUsd,
  });
  return Object.freeze({
    preview,
    costQuote,
    reservationMicroUsd,
    authorization,
    privateDisplay: Object.freeze({ targets: targetSnapshot.displayTargets }),
  });
}

export const createFlowTool: OperatorTool = {
  name: "create_flow",
  description: `Create a named outbound flow for a bot (separate from its inbound flow). Campaign calls run this flow with the same tool runtime (classify/steps/write_table/etc). ${FLOW_DOC}`,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      agent_id: { type: "string" },
      name: { type: "string", description: "Short name, e.g. 'Satisfaction Survey'" },
      persona: { type: "string", description: "2-3 sentences: who the agent is on this call and the call's goal." },
      flow: FLOW_V2_AUTHORING_SCHEMA,
    },
    required: ["agent_id", "name", "persona", "flow"],
  },
  async execute(args, ctx) {
    const owned = await qOne("SELECT id FROM agents WHERE id = $1 AND org_id = $2", [args.agent_id, ctx.orgId]);
    if (!owned) return { output: { error: "agent not found" } };
    try {
      const parsed = AgentFlowSchema.parse({ ...args.flow as object, schema_version: 2, tool_exposure: "gateway" });
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
    additionalProperties: false,
    properties: {
      flow_id: { type: "string" },
      name: { type: "string" },
      persona: { type: "string" },
      flow: FLOW_V2_AUTHORING_SCHEMA,
    },
    required: ["flow_id"],
  },
  async execute(args, ctx) {
    try {
      let parsed = args.flow ? AgentFlowSchema.parse({ ...args.flow as object, schema_version: 2, tool_exposure: "gateway" }) : null;
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
        "SELECT name, flow FROM flows WHERE id = $1 AND org_id = $2", [args.flow_id, ctx.orgId]
      );
      if (!row) return { output: { error: "flow not found" } };
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

export const previewCampaignTool: OperatorTool = {
  name: "preview_campaign",
  description:
    "Freeze and preview the exact tenant-owned target set, schedule, per-call duration cap, and configured call spend reservation before asking the human to confirm run_campaign. This never creates jobs or dials.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: CAMPAIGN_REQUEST_PROPERTIES,
    required: ["agent_id", "flow_id", "name", "dataset"],
  },
  async execute(args, ctx) {
    try {
      const prepared = await prepareCampaign(args, ctx.orgId);
      return {
        output: {
          requires_confirmation: true,
          target_preview: prepared.preview,
          authorization_arguments: prepared.authorization,
          authorization_arguments_sha256: operatorActionArgumentsSha256(
            "run_campaign",
            prepared.authorization
          ),
          spend_reservation_usd: prepared.reservationMicroUsd / 1_000_000,
        },
        notice: `Previewed ${prepared.preview.targetCount} unique targets; no calls were scheduled or placed`,
      };
    } catch (e) {
      return { output: { error: (e as Error).message.slice(0, 400) } };
    }
  },
};

export const runCampaignTool: OperatorTool = {
  name: "run_campaign",
  description:
    "Propose an outbound campaign from a fresh tenant-owned target snapshot. The browser must show and approve the exact targets, runtime, schedule, duration cap, and configured spend reservation before the server materializes or dials anything.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: CAMPAIGN_REQUEST_PROPERTIES,
    required: ["agent_id", "flow_id", "name", "dataset"],
  },
  async execute(args, ctx) {
    try {
      const prepared = await prepareCampaign(args, ctx.orgId);
      const proposal = await proposeOperatorAction({
        ctx,
        capability: "run_campaign",
        argumentsValue: prepared.authorization,
        privateDisplay: prepared.privateDisplay,
        estimatedUnits: prepared.costQuote.units,
        estimatedMicroUsd: prepared.reservationMicroUsd,
      });
      return {
        output: { status: "human_confirmation_required", proposal_id: proposal.proposalId },
        operatorActionConfirmation: proposal,
        notice: `Review ${prepared.preview.targetCount} exact campaign targets; no jobs or calls were created`,
      };
    } catch (e) {
      return { output: { error: (e as Error).message.slice(0, 400) } };
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
    const owned = await qOne("SELECT id FROM campaigns WHERE id = $1 AND org_id = $2", [args.campaign_id, ctx.orgId]);
    if (!owned) return { output: { error: "campaign not found" } };
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
