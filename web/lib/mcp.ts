// Author: Harsha Gundala
// mcp.ts — MCP gateway core: progressive-disclosure tools for live voice sessions.
// The base prompt stays slim; classify() reveals topic context + steps, begin_step() reveals execution detail.

import { createHash, randomUUID } from "node:crypto";
import { q, qOne } from "./db";
import { mcpGatewaySecret } from "./high-authority-secrets";
import { research } from "./xai";
import { searchKnowledge, hasReadyDocuments } from "./knowledge";
import {
  AgentFlowSchema,
  actionPolicyFor,
  alwaysActionPolicies,
  fallbackNode,
  findStep,
  flowToolExposure,
  listStepRefs,
  topicEntryStepPaths,
  topicNodes,
  type AgentFlow,
} from "./flow";
import {
  completeFlowStep,
  deriveFlowActionInvocationId,
  describeNextSteps,
  enterFlowStep,
  flowCapabilityScope,
  flowStateSummary,
  grantedTools,
  hashFlowValue,
  proveIndeterminateFlowActionAbsent,
  promoteIndeterminateFlowAction,
  selectFlowTopic,
  type FlowExecutionState,
  type RuntimeError,
} from "./flow-runtime";
import {
  loadFlowState,
  markFlowActionDispatchStartedAtomic,
  recoverStaleFlowActionsAtomic,
  reserveFlowActionAtomic,
  settleFlowActionAtomic,
  withLockedFlowState,
} from "./flow-state-store";
import { signFlowCapability, verifyFlowCapability } from "./flow-capability";
import {
  executePreparedToolInvocation,
  invokeTool,
  prepareToolInvocation,
  type PreparedToolInvocation,
  type ToolInvocationOutcome,
} from "./toolfactory/deploy";
import { queryRows, upsertRow } from "./datasets";
import { signScope } from "./voice";
import { log } from "./log";
import {
  normalizeE164,
  requirePublicOrigin,
  twilioAccountSid,
  twilioRestAuthorization,
} from "./telephony";
import {
  voiceToolExtensions,
  type PinnedVoiceToolDefinition,
  type PreparedVoiceToolInvocation,
  type VoiceToolPreparedExecutionResult,
  type VoiceToolDefinition,
  type VoiceToolExecutionContext,
  type VoiceToolScope,
} from "./voice-tools";
import { CALL_RUNTIME_SNAPSHOT_QUERY } from "./call-runtime-query";
import {
  isPinnedExternalMcpManifest,
  parseCallRuntimeSnapshot,
  type PinnedExternalMcpManifest,
} from "./call-runtime-snapshot";
import {
  invokePinnedExternalMcpTool,
  type RemoteMcpToolInvocationOutcome,
  validatePinnedExternalMcpArguments,
  verifyPinnedExternalMcpManifest,
} from "./remote-mcp-runtime";
import {
  ActionReconciliationSpecSchema,
  deriveReconciliation,
  evaluateReconciliationProof,
  reconciliationArgumentsMatchSchema,
} from "./action-reconciliation";
import {
  resolveReconciliationAuthority,
  type PinnedRecoveryToolDefinition,
} from "./reconciliation-authority";
import {
  publicAuditToolCallPayload,
  publicAuditToolResultPayload,
  type PublicToolAuditOptions,
} from "./public-audit";
import {
  compileVoiceToolSchema,
  normalizeVoiceToolSchema,
} from "./voice-tools/schema";
import {
  admitMcpToolInvocation,
  settleMcpToolInvocation,
  type McpToolInvocationAdmission,
} from "./mcp-invocation-store";
import {
  buildActiveCapabilityAuthority,
  bindActiveCapabilityInvocation,
  type ActiveCapabilityAuthority,
  type ActiveCapabilitySource,
  type ActiveCatalogExpectation,
} from "./active-capability-catalog";
import {
  activeFlowContext,
  activeFlowControlDefinitions,
} from "./active-capability-flow";

const L = log("mcp");
const MAX_HOLD_S = 20;
const MAX_HOLD_MUSIC_S = 30;
const PROTECTED_TABLES = new Set(["calls", "call_events", "logs"]);
const OPERATOR_APPROVAL_ONLY_VOICE_TOOLS = new Set([
  "request_recall",
  "send_email",
  "send_sms",
]);
const EFFECT_SAFE_BUILTIN_ACTIONS = new Set(["read_table", "search", "search_knowledge"]);
const DEFINITIVE_BUILTIN_REJECTION_CODES = new Set([
  "flow_incomplete",
  "unresolved_actions",
  "hold_music_unavailable",
  "unknown_table",
  "protected_table",
  "row_required",
  "support_unavailable",
  "call_provider_identity_incomplete",
  "recipient_email_missing",
  "invalid_email",
  "invalid_phone",
  "internet_disabled",
]);
const ACTION_ARGUMENT_MAX_BYTES = 240 * 1024;
const MAX_ACTION_VALIDATORS = 1_024;
const actionValidators = new Map<string, ReturnType<typeof compileVoiceToolSchema>>();

function boundedActionArguments(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { nodes: 0 }
): boolean {
  budget.nodes += 1;
  if (depth > 32 || budget.nodes > 10_000) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return false;
  seen.add(value);
  const values = Array.isArray(value)
    ? Object.keys(descriptors).map((key) => descriptors[key].value)
    : Object.entries(descriptors).map(([, descriptor]) => descriptor.value);
  if (values.length > 4_096 || values.some((item) => !boundedActionArguments(item, depth + 1, seen, budget))) {
    return false;
  }
  seen.delete(value);
  return true;
}

function validateCatalogActionArguments(
  definition: McpToolDef | undefined,
  args: Record<string, unknown>
): RuntimeError | null {
  if (!definition) return { error: "action is absent from the pinned tool catalog", code: "action_not_pinned" };
  try {
    if (!boundedActionArguments(args) || Buffer.byteLength(JSON.stringify(args), "utf8") > ACTION_ARGUMENT_MAX_BYTES) {
      return { error: "action arguments exceed the safe JSON limits", code: "invalid_action_arguments" };
    }
    const schemaHash = hashFlowValue(definition.inputSchema);
    let validator = actionValidators.get(schemaHash);
    if (!validator) {
      const normalized = normalizeVoiceToolSchema(definition.inputSchema, {
        label: `pinned action "${definition.name}" input schema`,
      });
      validator = compileVoiceToolSchema(normalized);
      if (actionValidators.size >= MAX_ACTION_VALIDATORS) {
        const oldest = actionValidators.keys().next().value as string | undefined;
        if (oldest) actionValidators.delete(oldest);
      }
      actionValidators.set(schemaHash, validator);
    }
    return validator(args)
      ? null
      : { error: "action arguments do not match the pinned input schema", code: "invalid_action_arguments" };
  } catch {
    return { error: "pinned action input schema is invalid", code: "invalid_action_schema" };
  }
}

function receiptIdForInvocation(callId: string, invocationId: string): string {
  const bytes = createHash("sha256")
    .update("hacc/provider-invocation/v1\0", "utf8")
    .update(callId, "utf8")
    .update("\0", "utf8")
    .update(invocationId, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Scope = VoiceToolScope;
type ToolInvocationMeta = {
  invocationId?: string;
  actionContext?: VoiceToolExecutionContext;
  preparedExtension?: PreparedVoiceToolInvocation;
  preparedGeneratedInvocation?: PreparedToolInvocation;
};
type McpToolDef = VoiceToolDefinition;

type CallCtx = {
  flow: AgentFlow;
  internetEnabled: boolean;
  allowedDomains: string[];
  docsReady: boolean;
  datasetSlugs: string[];
  holdMusic: boolean;
  runtimeDigest: string | null;
  mintedTools: {
    id: string;
    slug: string;
    description: string;
    input_schema: Record<string, unknown>;
    endpoint_url: string | null;
    invocation_key_id: string | null;
  }[];
  extensionTools: PinnedVoiceToolDefinition[];
  externalMcpServers: PinnedExternalMcpManifest[];
};

type LeasedToolDef = McpToolDef & {
  capability_grant: string;
  capability_expires_at: string;
  policy: {
    idempotency: "none" | "per_step" | "per_arguments" | "per_call" | "per_call_arguments";
    max_calls?: number;
  };
};

type GeneratedToolSigner = Readonly<{
  slug: string;
  endpoint_url: string;
  invocation_key_id: string;
  invocation_private_key_encrypted: string;
}>;

type EnterStepSuccess = Exclude<ReturnType<typeof enterFlowStep>, RuntimeError>;
type CompleteStepSuccess = Exclude<ReturnType<typeof completeFlowStep>, RuntimeError>;

async function loadCtx(scope: Scope): Promise<CallCtx> {
  const [agentRow, org, docsReady, datasets, holdMusic] = await Promise.all([
    // Campaign/recall calls carry a named flow — it overrides the agent's inbound default.
    qOne<{ status: string; flow: unknown; tool_ids: string[]; runtime_snapshot: unknown | null; runtime_digest: string | null }>(CALL_RUNTIME_SNAPSHOT_QUERY, [
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
  if (!agentRow || agentRow.status !== "active") {
    throw new Error("call tool authority is no longer active");
  }
  const pinned = agentRow?.runtime_snapshot
    ? parseCallRuntimeSnapshot(agentRow.runtime_snapshot, agentRow.runtime_digest)
    : null;
  const parsed = AgentFlowSchema.safeParse(pinned?.snapshot.flow ?? agentRow?.flow ?? { nodes: [], edges: [] });
  const flow = parsed.success ? parsed.data : { nodes: [], edges: [] };
  if (flow.schema_version === 2 && flowToolExposure(flow) === "gateway" && !pinned) {
    throw new Error("receipt-backed flow authority requires an immutable call runtime snapshot");
  }
  const mintedTools = pinned
      ? pinned.snapshot.toolManifest.map((tool) => ({
        id: tool.id,
        slug: tool.slug,
        description: tool.description,
        input_schema: tool.inputSchema,
        endpoint_url: tool.endpointUrl,
        invocation_key_id: tool.invocationKeyId ?? null,
      }))
    : agentRow?.tool_ids?.length
    ? await q<CallCtx["mintedTools"][number]>(
        `SELECT id, slug, description, input_schema, endpoint_url, invocation_key_id
         FROM tools WHERE id = ANY($1) AND org_id = $2 AND deploy_status = 'live'`,
        [agentRow.tool_ids, scope.orgId]
      )
    : [];
  const environment = pinned?.snapshot.environment;
  return {
    flow,
    internetEnabled: environment?.internetEnabled ?? org?.internet_enabled ?? false,
    allowedDomains: environment?.allowedDomains ?? org?.allowed_domains ?? [],
    docsReady: environment?.docsReady ?? docsReady,
    datasetSlugs: environment?.datasetSlugs ?? datasets.map((d) => d.slug),
    holdMusic: environment?.holdMusic ?? !!holdMusic,
    runtimeDigest: pinned?.digest ?? null,
    mintedTools,
    extensionTools: pinned?.snapshot.extensionManifest ?? await voiceToolExtensions.definitions(scope),
    externalMcpServers: pinned?.snapshot.externalMcpManifest.filter(isPinnedExternalMcpManifest) ?? [],
  };
}

function saveEvent(scope: Scope, type: string, payload: unknown) {
  return q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,$2,$3)", [
    scope.callId, type, JSON.stringify(payload),
  ]).catch(() => {});
}

/** Preflight real-call Twilio REST authority before the flow effect boundary. */
async function preflightBuiltInVoiceAction(scope: Scope, name: string): Promise<void> {
  if (name !== "contact_support" && name !== "end_call") return;
  const call = await qOne<{ twilio_call_sid: string | null }>(
    "SELECT twilio_call_sid FROM calls WHERE id = $1",
    [scope.callId]
  );
  if (!call?.twilio_call_sid) return;
  twilioAccountSid();
  twilioRestAuthorization();
}

function publicAuditOptions(
  scope: Scope,
  ctx: CallCtx,
  catalog: readonly McpToolDef[],
  audience: "realtime" | "background",
  trustedReceiptId?: string
): PublicToolAuditOptions {
  const refs = listStepRefs(ctx.flow);
  return {
    fingerprintKey: mcpGatewaySecret(),
    fingerprintScope: { organizationId: scope.orgId, callId: scope.callId },
    audience,
    trustedToolNames: catalog.map((tool) => tool.name),
    trustedMetadataValues: {
      topic: ctx.flow.nodes.map((node) => node.id),
      path: refs.map((ref) => ref.path),
      step: refs.flatMap((ref) => [ref.path, ref.step.id]),
      table: ctx.datasetSlugs,
      ...(trustedReceiptId ? { receipt_id: [trustedReceiptId] } : {}),
    },
  };
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
      name: "launch_task",
      description:
        "Hand read-only research to a background assistant with this call's transcript and search/table-read tools. Consequential email, text, or data writes must stay in a receipt-backed live flow. `when:'now'` runs immediately; `when:'end_of_call'` runs after hangup.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Read-only research instruction, e.g. 'find the relevant membership policy and summarize the applicable steps'." },
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
  // Remote schemas remain in the pinned internal catalog so Flow v2 may lease them through
  // run_action. They are never disclosed as direct Flow-v1 authority.
  for (const server of ctx.externalMcpServers) {
    for (const tool of server.tools) {
      tools.push({
        name: tool.name,
        description: tool.description ?? tool.title ?? `Remote action from ${server.label}`,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      });
    }
  }
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`voice tool name collision: "${tool.name}"`);
    names.add(tool.name);
  }
  return tools;
}

const FLOW_CONTROL_TOOLS = new Set([
  "classify",
  "enter_step",
  "complete_step",
  "get_flow_state",
  "run_action",
  "reconcile_action",
]);
const LEGACY_AUTHORITY_BEARING_CONTROLS = new Set([
  "classify",
  "begin_step",
  "enter_step",
  "complete_step",
  "get_flow_state",
]);

function stripLegacyCapabilityAuthority(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLegacyCapabilityAuthority);
  if (!value || typeof value !== "object") return value;
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "available_actions" || key === "always_available" ||
        key === "capability_grant" || key === "capability_expires_at") {
      continue;
    }
    clean[key] = stripLegacyCapabilityAuthority(item);
  }
  return clean;
}

function runtimeDigest(ctx: CallCtx, catalog: McpToolDef[]): string {
  return ctx.runtimeDigest ?? hashFlowValue({
    flow: ctx.flow,
    tools: [...catalog]
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}

/**
 * The flow ledger key is intentionally semantic and call-local. Never forward it verbatim:
 * unrelated callers can choose the same action/arguments and must not collide in a provider's
 * idempotency cache. The org and call are durable gateway authority, not model input.
 */
export function downstreamActionIdempotencyKey(
  orgId: string,
  callId: string,
  ledgerIdempotencyKey: string
): string {
  return hashFlowValue({
    domain: "hacc/downstream-action-idempotency/v1",
    orgId,
    callId,
    ledgerIdempotencyKey,
  });
}

async function loadPinnedGeneratedSigner(
  scope: Scope,
  tool: CallCtx["mintedTools"][number]
): Promise<GeneratedToolSigner | null> {
  if (!tool.endpoint_url || !tool.invocation_key_id) return null;
  const signer = await qOne<{
    slug: string;
    endpoint_url: string | null;
    invocation_key_id: string | null;
    invocation_private_key_encrypted: string | null;
  }>(
    `SELECT t.slug, r.endpoint_url, r.key_id AS invocation_key_id,
            r.private_key_encrypted AS invocation_private_key_encrypted
     FROM tools t
     JOIN tool_invocation_revisions r ON r.tool_id = t.id
     WHERE t.id = $1 AND t.org_id = $2
       AND r.key_id = $3 AND r.endpoint_url = $4
       AND r.status IN ('live','retired')
       AND r.revoked_at IS NULL`,
    [tool.id, scope.orgId, tool.invocation_key_id, tool.endpoint_url]
  ).catch(() => null);
  return signer &&
    signer.slug === tool.slug &&
    signer.endpoint_url === tool.endpoint_url &&
    signer.invocation_key_id === tool.invocation_key_id &&
    signer.invocation_private_key_encrypted
    ? Object.freeze({
        slug: signer.slug,
        endpoint_url: signer.endpoint_url,
        invocation_key_id: signer.invocation_key_id,
        invocation_private_key_encrypted: signer.invocation_private_key_encrypted,
      })
    : null;
}

async function pinnedGeneratedAuthorityIsActive(
  scope: Scope,
  tool: CallCtx["mintedTools"][number]
): Promise<boolean> {
  if (!tool.endpoint_url || !tool.invocation_key_id) return false;
  const active = await qOne<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM tool_invocation_revisions r
       JOIN tools t ON t.id = r.tool_id
       WHERE t.id = $1 AND t.org_id = $2
         AND r.key_id = $3 AND r.endpoint_url = $4
         AND r.status IN ('live','retired')
         AND r.revoked_at IS NULL
     ) AS active`,
    [tool.id, scope.orgId, tool.invocation_key_id, tool.endpoint_url]
  ).catch(() => null);
  return active?.active === true;
}

function directIntegrationContext(
  scope: Scope,
  ctx: CallCtx,
  catalog: McpToolDef[],
  tool: string,
  args: Record<string, unknown>,
  providerInvocationId: string | undefined
): VoiceToolExecutionContext | null {
  if (!providerInvocationId) return null;
  const receiptId = receiptIdForInvocation(scope.callId, providerInvocationId);
  return Object.freeze({
    audience: "direct" as const,
    invocationId: deriveFlowActionInvocationId(`call:${scope.callId}\0receipt:${receiptId}`),
    idempotencyKey: hashFlowValue({
      version: 1,
      callId: scope.callId,
      providerInvocationId,
      tool,
      arguments: args,
    }),
    receiptId,
    runtimeDigest: runtimeDigest(ctx, catalog),
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

const FLOW_V1_DIRECT_BUSINESS_TOOLS = new Set([
  "read_table",
  "search",
  "search_knowledge",
  "hold",
  "play_hold_music",
]);
const FLOW_V1_DIRECT_CONTROLS = new Set(["classify", "begin_step"]);

function assertFlowV1DirectAttachmentsAreSafe(ctx: CallCtx): void {
  if (ctx.mintedTools.length || ctx.extensionTools.length || ctx.externalMcpServers.length) {
    throw new Error(
      "Flow v1 cannot attach generated, extension, or remote tools; migrate this agent to Flow v2 gateway exposure"
    );
  }
  const explicitlyReferenced = new Set([
    ...(ctx.flow.always_tools ?? []),
    ...(ctx.flow.always_action_policies ?? []).map((policy) => policy.tool),
    ...ctx.flow.nodes.flatMap((node) => node.tools ?? []),
    ...listStepRefs(ctx.flow).flatMap((ref) => [
      ...(ref.step.tools ?? []),
      ...(ref.step.action_policies ?? []).map((policy) => policy.tool),
      ...(ref.step.output_bindings ?? []).map((binding) => binding.tool),
    ]),
  ]);
  const unsafe = [...explicitlyReferenced]
    .filter((name) => !FLOW_V1_DIRECT_BUSINESS_TOOLS.has(name))
    .sort((left, right) => left.localeCompare(right));
  if (unsafe.length) {
    throw new Error(
      `Flow v1 explicitly references consequential tools (${unsafe.join(", ")}); migrate this agent to Flow v2 gateway exposure`
    );
  }
}

async function activeCapabilityAuthorityFromContext(
  scope: Scope,
  ctx: CallCtx
): Promise<ActiveCapabilityAuthority> {
  const catalog = await listToolCatalogFor(scope, ctx);
  const digest = runtimeDigest(ctx, catalog);
  if (flowToolExposure(ctx.flow) === "direct") {
    assertFlowV1DirectAttachmentsAreSafe(ctx);
    const sources: ActiveCapabilitySource[] = catalog
      .filter((definition) =>
        FLOW_V1_DIRECT_CONTROLS.has(definition.name) ||
        FLOW_V1_DIRECT_BUSINESS_TOOLS.has(definition.name)
      )
      .map((definition) => ({
        kind: "direct" as const,
        definition: {
          ...definition,
          ...(new Set(["read_table", "search", "search_knowledge"]).has(definition.name)
            ? { effect: "read" as const }
            : {}),
        },
      }));
    return buildActiveCapabilityAuthority({
      runtimeDigest: digest,
      state: {
        status: "direct",
        topic: null,
        step: "$flow.direct",
        attempt: 0,
        capabilityEpoch: 0,
        stateRevision: 0,
      },
      context: {
        catalog_mode: "direct",
        migration_guidance: "Use Flow v2 gateway exposure for consequential or custom actions.",
      },
      sources,
    });
  }

  const state = await recoverStaleFlowActionsAtomic(scope.callId);
  const controls = activeFlowControlDefinitions(ctx.flow, state).map((definition) => ({
    kind: "direct" as const,
    definition,
  }));
  const leased = leasedActionsFor(scope, ctx, state, catalog, digest).map((tool) => {
    const {
      capability_grant: capabilityGrant,
      capability_expires_at: capabilityExpiresAt,
      policy,
      ...definition
    } = tool;
    return {
      kind: "leased_action" as const,
      definition,
      capabilityGrant,
      capabilityExpiresAt,
      policy,
    };
  });
  const capabilityScope = flowCapabilityScope(state);
  return buildActiveCapabilityAuthority({
    runtimeDigest: digest,
    state: {
      status: state.status,
      topic: state.nodeId,
      step: capabilityScope.step,
      attempt: capabilityScope.attempt,
      capabilityEpoch: state.capabilityEpoch,
      stateRevision: state.revision,
    },
    context: activeFlowContext(ctx.flow, state),
    sources: [...controls, ...leased],
  });
}

/** One source of truth for provider-visible catalog disclosure and private dispatch binding. */
export async function activeCapabilityAuthorityFor(scope: Scope): Promise<ActiveCapabilityAuthority> {
  return activeCapabilityAuthorityFromContext(scope, await loadCtx(scope));
}

type ActiveCapabilityInvocationMeta = Readonly<{
  invocationId: string;
  expectedCatalog: ActiveCatalogExpectation;
}>;

/**
 * Admits the provider-visible logical invocation before consulting current flow authority.
 * Exact terminal retries therefore replay the original raw outcome after a committed state
 * transition, while a new invocation is bound to private authority only in host memory.
 */
export async function callActiveCapability(
  scope: Scope,
  logicalName: string,
  modelArguments: Record<string, unknown>,
  meta: ActiveCapabilityInvocationMeta
): Promise<unknown> {
  const ctx = await loadCtx(scope);
  const staticCatalog = await listToolCatalogFor(scope, ctx);
  const auditOptions = publicAuditOptions(scope, ctx, staticCatalog, "realtime");

  let admission: McpToolInvocationAdmission;
  try {
    admission = await admitMcpToolInvocation({
      callId: scope.callId,
      providerInvocationId: meta.invocationId,
      logicalName,
      modelArguments,
      expectedCatalog: meta.expectedCatalog,
    });
  } catch (error) {
    // Provider-triggerable admission failures deliberately do not write the
    // shared logs table: without a durable receipt identity, repeated malformed
    // calls would otherwise create an alternate unbounded persistence sink.
    void error;
    const result = {
      error: "tool invocation could not establish durable replay authority",
      code: "tool_invocation_admission_failed",
    };
    return result;
  }
  if (!admission.execute) {
    return admission.result;
  }
  // Durable audit events are emitted only for a newly admitted identity.
  // Exact replays and quota/rate rejections already have a receipt or stable
  // rejection and must not become an unbounded secondary call_events sink.
  await saveEvent(
    scope,
    "tool_call",
    publicAuditToolCallPayload(logicalName, modelArguments, auditOptions)
  );

  let result: unknown;
  try {
    const authority = await activeCapabilityAuthorityFromContext(scope, ctx);
    const binding = bindActiveCapabilityInvocation(
      authority,
      meta.expectedCatalog,
      logicalName,
      modelArguments
    );
    if (!binding.ok) {
      result = binding.outcome;
    } else {
      const activeDefinition = authority.catalog.tools.find((tool) => tool.logical_name === logicalName);
      const invalid = validateCatalogActionArguments(
        activeDefinition
          ? {
              name: activeDefinition.logical_name,
              description: activeDefinition.description,
              inputSchema: activeDefinition.input_schema,
            }
          : undefined,
        modelArguments
      );
      if (invalid) {
        result = invalid;
      } else {
        const dispatched = await dispatch(
          scope,
          binding.targetName,
          binding.targetArguments as Record<string, unknown>,
          false,
          { invocationId: meta.invocationId },
          ctx
        );
        result = LEGACY_AUTHORITY_BEARING_CONTROLS.has(binding.targetName)
          ? stripLegacyCapabilityAuthority(dispatched)
          : dispatched;
      }
    }
  } catch (error) {
    L.error("active capability dispatch failed", {
      callId: scope.callId,
      orgId: scope.orgId,
      err: error instanceof Error ? error.message : "non-error rejection",
      data: { logicalName },
    });
    result = {
      error: error instanceof Error && /migrate this agent to Flow v2/.test(error.message)
        ? error.message
        : "tool execution failed",
      code: error instanceof Error && /migrate this agent to Flow v2/.test(error.message)
        ? "flow_v2_required"
        : "tool_execution_failed",
    };
  }

  try {
    result = await settleMcpToolInvocation(admission, result, "completed");
  } catch (error) {
    const indeterminate = {
      error: "tool execution finished without a durable replay result",
      code: "tool_invocation_indeterminate",
    };
    L.error("active capability invocation settlement failed", {
      callId: scope.callId,
      orgId: scope.orgId,
      err: error instanceof Error ? error.message : "non-error rejection",
      data: { logicalName },
    });
    try {
      result = await settleMcpToolInvocation(admission, indeterminate, "indeterminate");
    } catch {
      result = indeterminate;
    }
  }
  await saveEvent(
    scope,
    "tool_result",
    publicAuditToolResultPayload(logicalName, result, auditOptions)
  );
  return result;
}

async function flowStateWithLeases(
  scope: Scope,
  ctx: CallCtx,
  _state: FlowExecutionState,
  catalog?: McpToolDef[]
) {
  const resolvedCatalog = catalog ?? await listToolCatalogFor(scope, ctx);
  const recovered = await recoverStaleFlowActionsAtomic(scope.callId);
  return {
    ...flowStateSummary(ctx.flow, recovered),
    available_actions: leasedActionsFor(scope, ctx, recovered, resolvedCatalog),
  };
}

/**
 * Flow v2 keeps the initial model context intentionally small. Step-specific actions are
 * returned by enter_step and invoked through run_action, where the runtime enforces grants.
 */
export async function listToolsFor(scope: Scope): Promise<McpToolDef[]> {
  const ctx = await loadCtx(scope);
  const catalog = await listToolCatalogFor(scope, ctx);
  if (flowToolExposure(ctx.flow) === "direct") {
    assertFlowV1DirectAttachmentsAreSafe(ctx);
    return catalog.filter((definition) =>
      FLOW_V1_DIRECT_CONTROLS.has(definition.name) ||
      FLOW_V1_DIRECT_BUSINESS_TOOLS.has(definition.name)
    );
  }

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
    {
      name: "reconcile_action",
      description: "Resolve an indeterminate action through its pinned read-only proof contract. Supply only the receipt_id returned by run_action; the gateway derives every query argument and promotes the receipt only after exact read-back evidence.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          receipt_id: { type: "string", format: "uuid" },
        },
        required: ["receipt_id"],
      },
    },
  ];
  // Every business action, including always-available ones, goes through run_action so delayed
  // realtime calls cannot bypass epoch checks or the exactly-once admission ledger.
  return controls;
}

const BACKGROUND_TOOL_NAMES = new Set([
  "read_table",
  "search",
  "search_knowledge",
]);

export async function listToolsForAudience(
  scope: Scope,
  audience: "realtime" | "background"
): Promise<McpToolDef[]> {
  if (audience === "realtime") return listToolsFor(scope);
  const ctx = await loadCtx(scope);
  return (await listToolCatalogFor(scope, ctx)).filter((tool) => BACKGROUND_TOOL_NAMES.has(tool.name));
}

export async function callTool(
  scope: Scope,
  name: string,
  args: Record<string, unknown>,
  meta: ToolInvocationMeta = {}
): Promise<unknown> {
  return callToolForAudience(scope, "realtime", name, args, meta);
}

export async function callToolForAudience(
  scope: Scope,
  audience: "realtime" | "background",
  name: string,
  args: Record<string, unknown>,
  meta: ToolInvocationMeta = {}
): Promise<unknown> {
  if (audience === "background" && !BACKGROUND_TOOL_NAMES.has(name)) {
    return { error: `tool "${name}" is not available to background tasks`, code: "wrong_tool_audience" };
  }
  const ctx = await loadCtx(scope);
  const catalog = await listToolCatalogFor(scope, ctx);
  if (audience === "realtime" && flowToolExposure(ctx.flow) === "direct") {
    assertFlowV1DirectAttachmentsAreSafe(ctx);
    if (!FLOW_V1_DIRECT_CONTROLS.has(name) && !FLOW_V1_DIRECT_BUSINESS_TOOLS.has(name)) {
      return {
        error: `direct action "${name}" requires Flow v2 gateway exposure`,
        code: "flow_v2_required",
      };
    }
  }
  const trustedReceiptId = name === "run_action" && meta.invocationId
    ? receiptIdForInvocation(scope.callId, meta.invocationId)
    : undefined;
  const auditOptions = publicAuditOptions(scope, ctx, catalog, audience, trustedReceiptId);
  await saveEvent(scope, "tool_call", publicAuditToolCallPayload(name, args, auditOptions));
  let result: unknown;
  try {
    result = await dispatch(scope, name, args, audience === "background", meta, ctx);
  } catch (e) {
    L.error("MCP tool dispatch failed", {
      callId: scope.callId,
      orgId: scope.orgId,
      err: e instanceof Error ? e.message : "non-error rejection",
      data: { name, audience },
    });
    result = { error: "tool execution failed", code: "tool_execution_failed" };
  }
  await saveEvent(scope, "tool_result", publicAuditToolResultPayload(name, result, auditOptions));
  L.info("mcp tool", { callId: scope.callId, orgId: scope.orgId, data: { name, audience } });
  return result;
}

const RECEIPT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RECONCILIATION_LEASE_MS = 60_000;
const RECONCILIATION_QUERY_TIMEOUT_MS = 25_000;

type PreparedReconciliation = Readonly<{
  execute: true;
  proofId: string;
  ownerToken: string;
  attempt: number;
  receipt: FlowExecutionState["actionReceipts"][number];
  action: PinnedRecoveryToolDefinition & {
    effect: "write" | "opaque";
    reconciliation: ReturnType<typeof ActionReconciliationSpecSchema.parse>;
  };
  query: PinnedRecoveryToolDefinition & {
    effect: "read";
    outputSchema: Record<string, unknown>;
  };
  spec: ReturnType<typeof ActionReconciliationSpecSchema.parse>;
  queryArguments: Record<string, unknown>;
  policyHash: string;
  predicateHash: string;
}>;

type ReconciliationAdmission =
  | PreparedReconciliation
  | Readonly<{ execute: false; pending: true; proofId: string; receiptId: string }>
  | Readonly<{
      execute: false;
      replayed: true;
      receiptId: string;
      proofId: string;
      outcome: "committed" | "absent";
      result?: unknown;
    }>
  | RuntimeError;

async function prepareActionReconciliation(
  scope: Scope,
  ctx: CallCtx,
  receiptId: string,
  digest: string,
  catalog: readonly McpToolDef[]
): Promise<ReconciliationAdmission> {
  if (!RECEIPT_UUID.test(receiptId)) {
    return { error: "reconcile_action requires a valid receipt id", code: "invalid_receipt" };
  }
  // Reconciliation policies are executable authority. Never synthesize them from an unpinned
  // legacy runtime or from a tool guessed against the process-global extension registry.
  if (!ctx.runtimeDigest) {
    return { error: "this call has no pinned reconciliation authority", code: "reconciliation_not_pinned" };
  }
  const locked = await withLockedFlowState<ReconciliationAdmission>(scope.callId, async (state, client) => {
    const receipt = state.actionReceipts.find((candidate) => candidate.id === receiptId);
    if (!receipt) {
      return { value: { error: "unknown action receipt", code: "unknown_receipt" } };
    }
    if ((receipt.status === "succeeded" || receipt.status === "failed") &&
        receipt.reconciliationProofId) {
      return {
        value: {
          execute: false,
          replayed: true,
          receiptId,
          proofId: receipt.reconciliationProofId,
          outcome: receipt.status === "succeeded" ? "committed" : "absent",
          ...(receipt.status === "succeeded" ? { result: receipt.result } : {}),
        },
      };
    }
    if (receipt.status !== "indeterminate" || !receipt.invocationId || !receipt.dispatchStartedAt) {
      return {
        value: {
          error: "only a dispatched indeterminate receipt can be reconciled",
          code: "receipt_not_indeterminate",
        },
      };
    }

    let authority: ReturnType<typeof resolveReconciliationAuthority>;
    try {
      authority = resolveReconciliationAuthority(
        ctx.flow,
        receipt.step,
        receipt.tool,
        catalog as readonly PinnedRecoveryToolDefinition[]
      );
    } catch {
      return { value: { error: "the pinned reconciliation catalog is invalid", code: "reconciliation_not_pinned" } };
    }
    if (!authority) {
      return {
        value: {
          error: "the action has no pinned exact read-back contract",
          code: "reconciliation_not_supported",
        },
      };
    }
    const { action, query } = authority;
    const parsedSpec = ActionReconciliationSpecSchema.safeParse(action.reconciliation);
    if (!parsedSpec.success) return { value: { error: "the pinned reconciliation policy is invalid", code: "reconciliation_not_pinned" } };

    let derived: ReturnType<typeof deriveReconciliation>;
    try {
      derived = deriveReconciliation(parsedSpec.data, receipt, {
        callId: scope.callId,
        organizationId: scope.orgId,
        agentId: scope.agentId,
      });
    } catch {
      return { value: { error: "the reconciliation query could not be derived", code: "reconciliation_source_missing" } };
    }
    if (!reconciliationArgumentsMatchSchema(query.inputSchema, derived.queryArguments)) {
      return { value: { error: "derived reconciliation arguments violate the pinned query schema", code: "reconciliation_not_pinned" } };
    }

    const call = await client.query<{ status: string; runtime_digest: string | null }>(
      "SELECT status, runtime_digest FROM calls WHERE id = $1 FOR UPDATE",
      [scope.callId]
    );
    if (!call.rows[0] || call.rows[0].status !== "active" || call.rows[0].runtime_digest !== digest) {
      return { value: { error: "call reconciliation authority is no longer active", code: "call_not_active" } };
    }
    const ledger = await client.query<{
      status: string;
      runtime_digest: string;
      invocation_id: string;
      tool: string;
      arguments_hash: string;
      dispatch_started_at: Date | null;
      reconciliation_proof_id: string | null;
    }>(
      `SELECT status, runtime_digest, invocation_id, tool, arguments_hash,
              dispatch_started_at, reconciliation_proof_id
       FROM flow_action_receipts
       WHERE id = $1 AND call_id = $2
       FOR UPDATE`,
      [receiptId, scope.callId]
    );
    const persisted = ledger.rows[0];
    if (!persisted || persisted.status !== "indeterminate" ||
        persisted.runtime_digest !== digest ||
        persisted.invocation_id !== receipt.invocationId ||
        persisted.tool !== receipt.tool ||
        persisted.arguments_hash !== receipt.argumentsHash ||
        !persisted.dispatch_started_at ||
        persisted.reconciliation_proof_id) {
      return { value: { error: "receipt ledger and pinned replay state disagree", code: "receipt_state_mismatch" } };
    }

    const active = await client.query<{
      id: string;
      lease_valid: boolean;
    }>(
      `SELECT id, lease_expires_at > now() AS lease_valid
       FROM flow_action_reconciliation_proofs
       WHERE action_receipt_id = $1 AND status = 'querying'
       FOR UPDATE`,
      [receiptId]
    );
    if (active.rows[0]?.lease_valid) {
      return {
        value: {
          execute: false,
          pending: true,
          proofId: active.rows[0].id,
          receiptId,
        },
      };
    }
    if (active.rows[0]) {
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status = 'error', error = $3, completed_at = now()
         WHERE id = $1 AND call_id = $2 AND status = 'querying'`,
        [
          active.rows[0].id,
          scope.callId,
          JSON.stringify({ code: "reconciliation_owner_expired" }),
        ]
      );
    }

    const attempts = await client.query<{ last_attempt: number }>(
      `SELECT COALESCE(MAX(attempt), 0)::int AS last_attempt
       FROM flow_action_reconciliation_proofs
       WHERE action_receipt_id = $1`,
      [receiptId]
    );
    const attempt = (attempts.rows[0]?.last_attempt ?? 0) + 1;
    if (attempt > parsedSpec.data.maxProofAttempts) {
      return {
        value: {
          error: "the reconciliation proof attempt limit was reached; human review is required",
          code: "reconciliation_attempt_limit",
        },
      };
    }
    const proofId = randomUUID();
    const ownerToken = randomUUID();
    await client.query(
      `INSERT INTO flow_action_reconciliation_proofs
        (id, call_id, action_receipt_id, runtime_digest, policy_hash, attempt,
         query_tool, query_arguments, query_arguments_hash, predicate, predicate_hash,
         authoritative_result_path, status, owner_token, lease_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'querying',$13,
               now() + ($14 * interval '1 millisecond'))`,
      [
        proofId,
        scope.callId,
        receiptId,
        digest,
        derived.policyHash,
        attempt,
        parsedSpec.data.queryTool,
        JSON.stringify(derived.queryArguments),
        hashFlowValue(derived.queryArguments),
        JSON.stringify({
          committedWhen: parsedSpec.data.committedWhen,
          absentWhen: parsedSpec.data.absentWhen ?? null,
        }),
        derived.predicateHash,
        parsedSpec.data.authoritativeResultPath,
        ownerToken,
        RECONCILIATION_LEASE_MS,
      ]
    );
    return {
      value: {
        execute: true,
        proofId,
        ownerToken,
        attempt,
        receipt,
        action,
        query,
        spec: parsedSpec.data,
        queryArguments: derived.queryArguments,
        policyHash: derived.policyHash,
        predicateHash: derived.predicateHash,
      },
    };
  });
  return locked.value;
}

async function finishReconciliationError(
  scope: Scope,
  prepared: PreparedReconciliation,
  code: string
): Promise<void> {
  await withLockedFlowState(scope.callId, async (_state, client) => {
    await client.query(
      `UPDATE flow_action_reconciliation_proofs
       SET status = 'error', error = $4, completed_at = now()
       WHERE id = $1 AND call_id = $2 AND owner_token = $3 AND status = 'querying'`,
      [prepared.proofId, scope.callId, prepared.ownerToken, JSON.stringify({ code })]
    );
    return { value: null };
  });
}

async function finishActionReconciliation(
  scope: Scope,
  digest: string,
  prepared: PreparedReconciliation,
  proofResult: unknown
): Promise<unknown> {
  const evaluation = evaluateReconciliationProof(
    prepared.spec,
    prepared.receipt,
    { callId: scope.callId, organizationId: scope.orgId, agentId: scope.agentId },
    proofResult,
    prepared.query.outputSchema,
    prepared.action.outputSchema
  );
  if (evaluation.outcome === "indeterminate" && evaluation.reason === "invalid_proof") {
    await finishReconciliationError(scope, prepared, "invalid_reconciliation_proof");
    return {
      error: "the read-back tool returned an invalid proof",
      code: "reconciliation_proof_invalid",
      receipt_id: prepared.receipt.id,
    };
  }

  const proofResultHash = hashFlowValue(proofResult);
  const locked = await withLockedFlowState<unknown>(scope.callId, async (state, client) => {
    const proof = await client.query<{
      status: string;
      owner_token: string;
      runtime_digest: string;
      lease_valid: boolean;
    }>(
      `SELECT status, owner_token, runtime_digest,
              lease_expires_at > clock_timestamp() AS lease_valid
       FROM flow_action_reconciliation_proofs
       WHERE id = $1 AND call_id = $2
       FOR UPDATE`,
      [prepared.proofId, scope.callId]
    );
    if (!proof.rows[0] || proof.rows[0].status !== "querying" ||
        proof.rows[0].owner_token !== prepared.ownerToken ||
        proof.rows[0].runtime_digest !== digest) {
      return { value: { error: "reconciliation proof ownership expired", code: "reconciliation_owner_expired" } };
    }
    if (!proof.rows[0].lease_valid) {
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status = 'error', error = $3, completed_at = clock_timestamp()
         WHERE id = $1 AND call_id = $2 AND status = 'querying'`,
        [prepared.proofId, scope.callId, JSON.stringify({ code: "reconciliation_owner_expired" })]
      );
      return { value: { error: "reconciliation proof ownership expired", code: "reconciliation_owner_expired" } };
    }
    const call = await client.query<{ status: string; runtime_digest: string | null }>(
      "SELECT status, runtime_digest FROM calls WHERE id = $1 FOR UPDATE",
      [scope.callId]
    );
    if (!call.rows[0] || call.rows[0].status !== "active" || call.rows[0].runtime_digest !== digest) {
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status = 'error', error = $3, completed_at = now()
         WHERE id = $1 AND call_id = $2 AND status = 'querying'`,
        [prepared.proofId, scope.callId, JSON.stringify({ code: "call_not_active" })]
      );
      return { value: { error: "call reconciliation authority is no longer active", code: "call_not_active" } };
    }
    const ledger = await client.query<{
      status: string;
      runtime_digest: string;
      invocation_id: string;
      reconciliation_proof_id: string | null;
    }>(
      `SELECT status, runtime_digest, invocation_id, reconciliation_proof_id
       FROM flow_action_receipts
       WHERE id = $1 AND call_id = $2
       FOR UPDATE`,
      [prepared.receipt.id, scope.callId]
    );
    if (!ledger.rows[0] || ledger.rows[0].status !== "indeterminate" ||
        ledger.rows[0].runtime_digest !== digest ||
        ledger.rows[0].invocation_id !== prepared.receipt.invocationId ||
        ledger.rows[0].reconciliation_proof_id) {
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status = 'error', error = $3, completed_at = now()
         WHERE id = $1 AND call_id = $2 AND status = 'querying'`,
        [prepared.proofId, scope.callId, JSON.stringify({ code: "receipt_state_mismatch" })]
      );
      return { value: { error: "receipt ledger changed during reconciliation", code: "receipt_state_mismatch" } };
    }

    if (evaluation.outcome === "indeterminate") {
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status = 'mismatch', proof_result = $4, proof_result_hash = $5,
             completed_at = now()
         WHERE id = $1 AND call_id = $2 AND owner_token = $3 AND status = 'querying'`,
        [
          prepared.proofId,
          scope.callId,
          prepared.ownerToken,
          JSON.stringify(proofResult),
          proofResultHash,
        ]
      );
      return {
        value: {
          reconciled: false,
          code: evaluation.reason,
          receipt_id: prepared.receipt.id,
          proof_id: prepared.proofId,
          attempt: prepared.attempt,
        },
      };
    }

    if (evaluation.outcome === "absent") {
      const resolved = proveIndeterminateFlowActionAbsent(state, {
        receiptId: prepared.receipt.id,
        proofId: prepared.proofId,
      });
      if ("error" in resolved) {
        await client.query(
          `UPDATE flow_action_reconciliation_proofs
           SET status = 'error', error = $3, completed_at = now()
           WHERE id = $1 AND call_id = $2 AND status = 'querying'`,
          [prepared.proofId, scope.callId, JSON.stringify({ code: resolved.code })]
        );
        return { value: resolved };
      }
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status = 'absent', proof_result = $4, proof_result_hash = $5,
             completed_at = now()
         WHERE id = $1 AND call_id = $2 AND owner_token = $3 AND status = 'querying'`,
        [
          prepared.proofId,
          scope.callId,
          prepared.ownerToken,
          JSON.stringify(proofResult),
          evaluation.proofResultHash,
        ]
      );
      const updated = await client.query(
        `UPDATE flow_action_receipts
         SET status = 'failed', result = NULL, result_hash = NULL,
             reconciliation_proof_id = $3, delivery_state = 'rejected',
             error = $4, settled_at = $5
         WHERE id = $1 AND call_id = $2 AND status = 'indeterminate'
           AND reconciliation_proof_id IS NULL`,
        [
          prepared.receipt.id,
          scope.callId,
          prepared.proofId,
          JSON.stringify({ code: "authoritative_absence_proven" }),
          resolved.receipt.settledAt,
        ]
      );
      if (updated.rowCount !== 1) throw new Error("reconciliation receipt changed while locked");
      return {
        state: resolved.state,
        value: {
          reconciled: true,
          outcome: "absent",
          retry_safe: true,
          receipt_id: prepared.receipt.id,
          proof_id: prepared.proofId,
          attempt: prepared.attempt,
        },
      };
    }

    const promoted = promoteIndeterminateFlowAction(state, {
      receiptId: prepared.receipt.id,
      proofId: prepared.proofId,
      result: evaluation.authoritativeResult,
    });
    if ("error" in promoted) {
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status = 'error', error = $3, completed_at = now()
         WHERE id = $1 AND call_id = $2 AND status = 'querying'`,
        [prepared.proofId, scope.callId, JSON.stringify({ code: promoted.code })]
      );
      return { value: promoted };
    }
    await client.query(
      `UPDATE flow_action_reconciliation_proofs
       SET status = 'committed', proof_result = $4, proof_result_hash = $5,
           authoritative_result = $6, authoritative_result_hash = $7,
           completed_at = now()
       WHERE id = $1 AND call_id = $2 AND owner_token = $3 AND status = 'querying'`,
      [
        prepared.proofId,
        scope.callId,
        prepared.ownerToken,
        JSON.stringify(proofResult),
        evaluation.proofResultHash,
        JSON.stringify(evaluation.authoritativeResult),
        evaluation.authoritativeResultHash,
      ]
    );
    const updated = await client.query(
      `UPDATE flow_action_receipts
       SET status = 'succeeded', result = $3, result_hash = $4,
           reconciliation_proof_id = $5, delivery_state = 'committed',
           error = NULL, settled_at = $6
       WHERE id = $1 AND call_id = $2 AND status = 'indeterminate'
         AND reconciliation_proof_id IS NULL`,
      [
        prepared.receipt.id,
        scope.callId,
        JSON.stringify(evaluation.authoritativeResult),
        evaluation.authoritativeResultHash,
        prepared.proofId,
        promoted.receipt.settledAt,
      ]
    );
    if (updated.rowCount !== 1) throw new Error("reconciliation receipt changed while locked");
    return {
      state: promoted.state,
      value: {
        reconciled: true,
        outcome: "committed",
        receipt_id: prepared.receipt.id,
        proof_id: prepared.proofId,
        attempt: prepared.attempt,
        result: evaluation.authoritativeResult,
      },
    };
  });
  return locked.value;
}

async function executePinnedReconciliationQuery(
  scope: Scope,
  ctx: CallCtx,
  digest: string,
  prepared: PreparedReconciliation
): Promise<unknown> {
  const invocationId = deriveFlowActionInvocationId(`reconciliation:${prepared.proofId}`);
  const idempotencyKey = hashFlowValue({
    domain: "hacc/reconciliation-query/v1",
    proofId: prepared.proofId,
    query: prepared.query.name,
  });
  const executionContext: VoiceToolExecutionContext = Object.freeze({
    audience: "reconciliation" as const,
    invocationId,
    idempotencyKey,
    receiptId: prepared.receipt.id,
    runtimeDigest: digest,
  });

  const extension = ctx.extensionTools.find((tool) => tool.name === prepared.query.name);
  if (extension) {
    return voiceToolExtensions.executePinned(
      extension.name,
      prepared.queryArguments,
      scope,
      extension,
      executionContext,
      ctx.extensionTools
    );
  }

  const generated = ctx.mintedTools.find((tool) => tool.slug === prepared.query.name);
  if (generated) {
    const signer = await loadPinnedGeneratedSigner(scope, generated);
    if (!signer || !generated.endpoint_url) throw new Error("pinned generated read-back tool is unavailable");
    const invocation = prepareToolInvocation(
      generated.endpoint_url,
      prepared.queryArguments,
      {
        keyId: signer.invocation_key_id,
        privateKeyPkcs8Encrypted: signer.invocation_private_key_encrypted,
        slug: signer.slug,
      },
      {
        orgId: scope.orgId,
        toolId: generated.id,
        invocationId,
        audience: "reconciliation",
        idempotencyKey,
        callId: scope.callId,
        agentId: scope.agentId,
        runtimeDigest: digest,
        receiptId: prepared.receipt.id,
      }
    );
    // Signing is deliberately pre-network. Revocation can race that local work, so repeat the
    // exact revision check at the last possible point before the prepared invocation leaves
    // the process. A revoked read-back never consumes external authority and the mutation
    // receipt remains indeterminate.
    if (!await pinnedGeneratedAuthorityIsActive(scope, generated)) {
      throw new Error("pinned generated read-back authority was revoked before network dispatch");
    }
    const outcome = await executePreparedToolInvocation(invocation);
    if (outcome.outcome !== "succeeded" || outcome.acknowledged !== true ||
        outcome.invocationId !== invocationId) {
      throw new Error("generated read-back did not return an exact acknowledgement");
    }
    return outcome.value;
  }

  const remote = ctx.externalMcpServers.find((server) =>
    server.tools.some((tool) => tool.name === prepared.query.name)
  );
  if (remote) {
    await verifyPinnedExternalMcpManifest(remote, scope.orgId);
    const outcome = await invokePinnedExternalMcpTool(
      scope.orgId,
      remote,
      prepared.query.name,
      prepared.queryArguments,
      { invocationId, idempotencyKey }
    );
    if (outcome.outcome !== "succeeded" || outcome.acknowledged !== true) {
      throw new Error("remote read-back did not return an exact acknowledgement");
    }
    return outcome.value;
  }

  throw new Error("pinned reconciliation query has no executable source");
}

async function executeActionReconciliation(
  scope: Scope,
  ctx: CallCtx,
  receiptId: string
): Promise<unknown> {
  const catalog = await listToolCatalogFor(scope, ctx);
  const digest = runtimeDigest(ctx, catalog);
  const admission = await prepareActionReconciliation(scope, ctx, receiptId, digest, catalog);
  if ("error" in admission) return admission;
  if (!admission.execute) {
    return "replayed" in admission
      ? {
          reconciled: true,
          replayed: true,
          outcome: admission.outcome,
          ...(admission.outcome === "absent" ? { retry_safe: true } : {}),
          receipt_id: admission.receiptId,
          proof_id: admission.proofId,
          ...(admission.outcome === "committed" ? { result: admission.result } : {}),
        }
      : {
          pending: true,
          receipt_id: admission.receiptId,
          proof_id: admission.proofId,
        };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const execution = executePinnedReconciliationQuery(scope, ctx, digest, admission);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("reconciliation query timed out")), RECONCILIATION_QUERY_TIMEOUT_MS);
    });
    const proofResult = await Promise.race([execution, timeout]);
    return await finishActionReconciliation(scope, digest, admission, proofResult);
  } catch {
    await finishReconciliationError(scope, admission, "reconciliation_query_failed");
    return {
      error: "the read-only reconciliation query failed; the action remains indeterminate",
      code: "reconciliation_query_failed",
      receipt_id: admission.receipt.id,
      proof_id: admission.proofId,
      attempt: admission.attempt,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function dispatch(
  scope: Scope,
  name: string,
  args: Record<string, unknown>,
  bypassGateway = false,
  meta: ToolInvocationMeta = {},
  loadedCtx?: CallCtx
): Promise<unknown> {
  const ctx = loadedCtx ?? await loadCtx(scope);

  // Voice providers are untrusted model runtimes, not human operators. These
  // funded actions remain available through the Studio operator proposal /
  // exact-approval path, but must never reach shared provider credentials from
  // a live call. Keep the dispatch guard as defense in depth for legacy pinned
  // snapshots and callers that bypass catalog discovery.
  if (OPERATOR_APPROVAL_ONLY_VOICE_TOOLS.has(name)) {
    return {
      error: `action "${name}" requires an exact human operator approval in Studio`,
      code: "operator_approval_required",
    };
  }

  if (
    !bypassGateway &&
    flowToolExposure(ctx.flow) === "gateway" &&
    !FLOW_CONTROL_TOOLS.has(name)
  ) {
    return { error: `action "${name}" must use run_action with a current capability grant` };
  }

  if (!FLOW_CONTROL_TOOLS.has(name)) {
    const catalog = await listToolCatalogFor(scope, ctx);
    const invalid = validateCatalogActionArguments(
      catalog.find((definition) => definition.name === name),
      args
    );
    if (invalid) return invalid;
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
          guidance: "Politely steer back to the purpose of this call. If the caller needs real support, offer the configured human support path or suggest they call the main line.",
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
          guidance: "Offer to connect them with the support line via contact_support. Do not promise or schedule a callback from the live voice runtime.",
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
      return { instructions: step.instructions, always_available: ["search", "search_knowledge", "read_table", "write_table", "contact_support", "hold"] };
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

    case "reconcile_action": {
      if (flowToolExposure(ctx.flow) !== "gateway") {
        return { error: "reconcile_action is available only to receipt-backed gateway flows", code: "wrong_tool_audience" };
      }
      const receiptId = typeof args.receipt_id === "string" ? args.receipt_id : "";
      return executeActionReconciliation(scope, ctx, receiptId);
    }

    case "run_action": {
      if (!meta.invocationId || meta.invocationId.length > 256) {
        return { error: "run_action requires a stable provider invocation identity", code: "missing_invocation_identity" };
      }
      const action = String(args.name ?? "");
      if (FLOW_CONTROL_TOOLS.has(action)) return { error: "flow control tools cannot be nested inside run_action" };
      const state = await loadFlowState(scope.callId);
      if (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) {
        return { error: "run_action arguments must be a JSON object", code: "invalid_action_arguments" };
      }
      const actionArgs = args.arguments as Record<string, unknown>;
      const catalog = await listToolCatalogFor(scope, ctx);
      const invalidCatalogArguments = validateCatalogActionArguments(
        catalog.find((definition) => definition.name === action),
        actionArgs
      );
      if (invalidCatalogArguments) return invalidCatalogArguments;
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

      const remote = ctx.externalMcpServers.find((server) =>
        server.tools.some((tool) => tool.name === action)
      );
      const generatedTool = ctx.mintedTools.find((tool) => tool.slug === action);
      const generatedAction = !!generatedTool;
      const pinnedExtension = ctx.extensionTools.find((tool) => tool.name === action);
      if (remote) {
        const invalidArguments = validatePinnedExternalMcpArguments(remote, action, actionArgs);
        if (invalidArguments) return invalidArguments;
      }

      const receiptId = receiptIdForInvocation(scope.callId, meta.invocationId);
      const downstreamInvocationId = deriveFlowActionInvocationId(
        `call:${scope.callId}\0receipt:${receiptId}`
      );
      const ownerToken = randomUUID();
      const reservation = await reserveFlowActionAtomic(scope.callId, ctx.flow, {
        receiptId,
        invocationId: downstreamInvocationId,
        ownerToken,
        runtimeDigest: digest,
        tool: action,
        arguments: actionArgs,
        capabilityEpoch: verified.claims.capabilityEpoch,
        providerInvocationId: meta.invocationId,
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
        if (reservation.receipt.status === "failed") {
          return {
            error: "the prior provider invocation was rejected before execution; retry with a new tool-call identity",
            code: "action_rejected",
            receipt_id: reservation.receipt.id,
            receipt_status: reservation.receipt.status,
          };
        }
        return { pending: true, receipt_id: reservation.receipt.id };
      }

      const actionContext: VoiceToolExecutionContext = {
        audience: "flow_action",
        invocationId: reservation.receipt.invocationId ?? reservation.receipt.id,
        idempotencyKey: downstreamActionIdempotencyKey(
          scope.orgId,
          scope.callId,
          reservation.receipt.idempotencyKey
        ),
        receiptId: reservation.receipt.id,
        runtimeDigest: digest,
      };
      const pinnedActionPolicy = actionPolicyFor(
        ctx.flow,
        reservation.receipt.step,
        action
      );
      const rejectBeforeDispatch = async (error: string, rejectionCode: string) => {
        const rejected = await settleFlowActionAtomic(scope.callId, {
          receiptId: reservation.receipt.id,
          ownerToken,
          status: "failed",
          error,
          deliveryState: "not_sent",
        });
        return "error" in rejected
          ? rejected
          : {
              error: "action was rejected before its mutating operation began",
              code: "action_rejected",
              rejection_code: rejectionCode,
              receipt_id: rejected.receipt.id,
              receipt_status: rejected.receipt.status,
            };
      };
      let preparedExtension: PreparedVoiceToolInvocation | undefined;
      if (pinnedExtension) {
        const preflight = await voiceToolExtensions.preflightPinned(
          action,
          actionArgs,
          scope,
          pinnedExtension,
          actionContext,
          ctx.extensionTools
        );
        if (!preflight.ok) return rejectBeforeDispatch(preflight.error, preflight.code);
        preparedExtension = preflight.prepared;
      }
      let preparedGeneratedInvocation: PreparedToolInvocation | undefined;
      if (generatedTool) {
        const signer = await loadPinnedGeneratedSigner(scope, generatedTool) ?? undefined;
        if (!signer) {
          return rejectBeforeDispatch(
            "generated tool invocation revision is unavailable",
            "generated_tool_not_pinned"
          );
        }
        try {
          preparedGeneratedInvocation = prepareToolInvocation(
            generatedTool.endpoint_url!,
            actionArgs,
            {
              keyId: signer.invocation_key_id,
              privateKeyPkcs8Encrypted: signer.invocation_private_key_encrypted,
              slug: signer.slug,
            },
            {
              orgId: scope.orgId,
              toolId: generatedTool.id,
              invocationId: actionContext.invocationId!,
              audience: "flow_action",
              idempotencyKey: actionContext.idempotencyKey!,
              callId: scope.callId,
              agentId: scope.agentId,
              runtimeDigest: actionContext.runtimeDigest,
              receiptId: actionContext.receiptId,
            }
          );
        } catch {
          return rejectBeforeDispatch(
            "generated tool invocation could not be prepared before dispatch",
            "generated_tool_preflight_failed"
          );
        }
      }
      if (remote) {
        try {
          await verifyPinnedExternalMcpManifest(remote, scope.orgId);
        } catch {
          return rejectBeforeDispatch(
            "pinned remote MCP preflight failed",
            "remote_mcp_preflight_failed"
          );
        }
      }

      if (!generatedAction && !remote && !pinnedExtension) {
        try {
          await preflightBuiltInVoiceAction(scope, action);
        } catch {
          return rejectBeforeDispatch(
            "real-call provider REST authority is unavailable",
            "provider_rest_authority_unavailable"
          );
        }
      }

      const dispatchPermit = await markFlowActionDispatchStartedAtomic(scope.callId, {
        receiptId: reservation.receipt.id,
        ownerToken,
        runtimeDigest: digest,
      });
      if ("error" in dispatchPermit) {
        if (dispatchPermit.code !== "dispatch_already_started") {
          await settleFlowActionAtomic(scope.callId, {
            receiptId: reservation.receipt.id,
            ownerToken,
            status: "failed",
            error: dispatchPermit.error,
            deliveryState: "not_sent",
          }).catch(() => undefined);
        }
        return dispatchPermit;
      }
      let result: unknown;
      try {
        result = await dispatch(scope, action, actionArgs, true, {
          ...meta,
          actionContext,
          ...(preparedExtension ? { preparedExtension } : {}),
          ...(preparedGeneratedInvocation ? { preparedGeneratedInvocation } : {}),
        }, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : "action execution failed without a result";
        // A read classification is immutable call authority, not a model assertion. Once an
        // action is pinned read-only, transport failure cannot hide a downstream mutation; the
        // receipt may therefore fail/reject and release a retry. Opaque/write integrations stay
        // indeterminate after the durable dispatch boundary.
        const effectSafeFailure = pinnedActionPolicy?.effect === "read" ||
          pinnedExtension?.effect === "read" ||
          (!generatedAction && !remote && !pinnedExtension && EFFECT_SAFE_BUILTIN_ACTIONS.has(action));
        await settleFlowActionAtomic(scope.callId, {
          receiptId: reservation.receipt.id,
          ownerToken,
          status: effectSafeFailure ? "failed" : "indeterminate",
          error: message,
          deliveryState: effectSafeFailure ? "rejected" : "unknown",
        });
        if (effectSafeFailure) {
          return {
            error: "read-only action failed without changing external state",
            code: "action_rejected",
            rejection_code: "effect_safe_action_failed",
            receipt_id: reservation.receipt.id,
            receipt_status: "failed",
          };
        }
        return {
          error: "action outcome is indeterminate; recover or reconcile before retrying",
          code: "action_indeterminate",
          receipt_id: reservation.receipt.id,
        };
      }
      let authoritativeResult = result;
      let acknowledgedCompletion = false;
      let requiresExternalReconciliation = false;
      let rejectedOutcome: {
        error: string;
        code: string;
        deliveryState: "not_sent" | "rejected";
      } | null = null;
      if (generatedAction) {
        const generated = result as ToolInvocationOutcome;
        if (generated?.outcome === "succeeded" && generated.acknowledged === true &&
            generated.invocationId === reservation.receipt.invocationId) {
          authoritativeResult = generated.value;
          acknowledgedCompletion = true;
        } else if (generated?.outcome === "rejected" && generated.acknowledged === false &&
                   generated.invocationId === reservation.receipt.invocationId) {
          rejectedOutcome = {
            error: generated.error,
            code: "generated_tool_rejected",
            deliveryState: "rejected",
          };
        } else {
          authoritativeResult = { error: "generated tool returned an unrecognized execution outcome" };
        }
      } else if (remote) {
        const remoteOutcome = result as RemoteMcpToolInvocationOutcome;
        if (remoteOutcome?.outcome === "succeeded" && remoteOutcome.acknowledged === true) {
          authoritativeResult = remoteOutcome.value;
          // A read classification lives only in the immutable Flow policy already bound into
          // the call runtime digest. Opaque/write MCP success still is not terminal mutation
          // evidence and remains blocked for exact read-back reconciliation.
          if (pinnedActionPolicy?.effect === "read") acknowledgedCompletion = true;
          else requiresExternalReconciliation = true;
        } else if (remoteOutcome?.outcome === "rejected" && remoteOutcome.acknowledged === false) {
          rejectedOutcome = {
            error: remoteOutcome.error,
            code: remoteOutcome.code,
            deliveryState: "rejected",
          };
        } else {
          authoritativeResult = { error: "remote MCP returned an unrecognized execution outcome" };
        }
      } else if (pinnedExtension) {
        const extension = result as VoiceToolPreparedExecutionResult;
        if (extension?.ok === true && extension.executionStarted === true) {
          // The trusted local extension boundary validates and detaches output before this
          // acknowledgement. Extension-owned `{ error }` fields remain ordinary business data.
          authoritativeResult = extension.value;
          acknowledgedCompletion = true;
        } else if (extension?.ok === false && extension.executionStarted === false &&
                   extension.code === "extension_preflight_expired") {
          rejectedOutcome = {
            error: extension.error,
            code: extension.code,
            // The durable dispatch boundary already exists, even though the registry proves
            // the extension execute function was never invoked. The ledger encodes this as a
            // post-boundary rejection; `not_sent` is reserved for pre-boundary preflight.
            deliveryState: "rejected",
          };
        } else if (extension?.ok === false) {
          // An invalid/consumed capability can race a live execution. Any failure after the
          // extension began is likewise opaque, so neither is safe to retry automatically.
          authoritativeResult = { error: extension.error };
        } else {
          authoritativeResult = { error: "extension tool returned an unrecognized execution outcome" };
        }
      }
      const resultError = authoritativeResult && typeof authoritativeResult === "object" &&
        "error" in authoritativeResult
        ? authoritativeResult as { error: unknown; code?: unknown }
        : null;
      // External success envelopes are the execution acknowledgement. Their business payload
      // may legitimately contain a top-level `error` field (for example a lookup describing a
      // declined order); never reinterpret that data as transport failure. Only an
      // unacknowledged error outcome is eligible for effect-safe rejection.
      const provenNoEffectFailure = !acknowledgedCompletion && !!resultError && (
        pinnedActionPolicy?.effect === "read" ||
        pinnedExtension?.effect === "read" ||
        (!generatedAction && !remote && !pinnedExtension && (
          EFFECT_SAFE_BUILTIN_ACTIONS.has(action) ||
          (typeof resultError.code === "string" && DEFINITIVE_BUILTIN_REJECTION_CODES.has(resultError.code))
        ))
      );
      if (!rejectedOutcome && provenNoEffectFailure) {
        rejectedOutcome = {
          error: String(resultError.error),
          code: typeof resultError.code === "string" ? resultError.code : "effect_safe_action_failed",
          deliveryState: "rejected",
        };
      }
      if (rejectedOutcome) {
        const rejected = await settleFlowActionAtomic(scope.callId, {
          receiptId: reservation.receipt.id,
          ownerToken,
          status: "failed",
          error: rejectedOutcome.error,
          deliveryState: rejectedOutcome.deliveryState,
        });
        if ("error" in rejected) return rejected;
        return {
          error: "action was rejected before its mutating operation began",
          code: "action_rejected",
          rejection_code: rejectedOutcome.code,
          receipt_id: rejected.receipt.id,
          receipt_status: rejected.receipt.status,
        };
      }
      // Once dispatchStartedAt is durable, a plain `{ error }` is not proof that a mutating
      // integration made zero changes. Only an affirmative non-error response may commit;
      // every other post-boundary outcome remains blocked for exact read-back reconciliation.
      const ambiguous = requiresExternalReconciliation || (
        !acknowledgedCompletion &&
        !!authoritativeResult &&
        typeof authoritativeResult === "object" &&
        "error" in authoritativeResult
      );
      const ambiguousError = requiresExternalReconciliation
        ? "remote MCP action has no pinned terminal acknowledgement contract"
        : ambiguous && authoritativeResult && typeof authoritativeResult === "object" && "error" in authoritativeResult
          ? String((authoritativeResult as { error: unknown }).error)
          : "action outcome is indeterminate";
      const settled = await settleFlowActionAtomic(scope.callId, {
        receiptId: reservation.receipt.id,
        ownerToken,
        status: ambiguous ? "indeterminate" : "succeeded",
        ...(ambiguous
          ? {
              error: ambiguousError,
              deliveryState: "unknown" as const,
            }
          : { result: authoritativeResult, deliveryState: "committed" as const }),
      });
      if ("error" in settled) return settled;
      if (ambiguous) {
        return {
          error: "action outcome is indeterminate; reconcile before retrying",
          code: "action_indeterminate",
          receipt_id: settled.receipt.id,
          receipt_status: settled.receipt.status,
        };
      }
      return {
        ...(authoritativeResult && typeof authoritativeResult === "object"
          ? authoritativeResult as Record<string, unknown>
          : { result: authoritativeResult }),
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
      if (!ctx.holdMusic) return { error: "no hold music configured for this org", code: "hold_music_unavailable" };
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
      if (!res) return {
        error: `unknown table "${table}". Available: ${ctx.datasetSlugs.join(", ")}`,
        code: "unknown_table",
      };
      return { table: res.dataset.slug, count: res.rows.length, rows: res.rows.map((r) => ({ id: r.id, ...r.data })) };
    }

    case "write_table": {
      const table = String(args.table ?? "");
      if (PROTECTED_TABLES.has(table)) return {
        error: `"${table}" is not writable — datasets only`,
        code: "protected_table",
      };
      if (!args.row || typeof args.row !== "object") return { error: "row object required", code: "row_required" };
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
      const support = normalizeE164(fallbackNode(ctx.flow)?.support_number);
      if (!support) return {
        error: "no valid support number configured — apologize and direct the caller to the organization's main support channel",
        code: "support_unavailable",
      };
      const call = await qOne<{
        twilio_call_sid: string | null;
        twilio_account_sid: string | null;
        to_number: string | null;
      }>(
        "SELECT twilio_call_sid, twilio_account_sid, to_number FROM calls WHERE id = $1", [scope.callId]
      );
      if (call?.twilio_call_sid && call.twilio_account_sid && call.to_number) {
        const accountSid = twilioAccountSid();
        const to = normalizeE164(call.to_number);
        if (call.twilio_account_sid !== accountSid || !to) {
          return {
            error: "call provider identity is incomplete — direct the caller to the organization's main support channel",
            code: "call_provider_identity_incomplete",
          };
        }
        // Preflight least-privilege REST authority before any call state claims
        // that a real transfer is in progress.
        const auth = twilioRestAuthorization();
        // Observe-mode transfer: redirect the Twilio leg to our TwiML so the bridge keeps listening.
        const transferScope = signScope(scope, {
          audience: "telephony-transfer",
          purpose: "human-transfer",
          method: "GET",
          provider: "twilio",
          ttlSeconds: 2 * 60,
          providerCallId: call.twilio_call_sid,
          providerAccountId: accountSid,
          providerTo: to,
          authorizedTarget: support,
        });
        const transferUrl =
          `${requirePublicOrigin()}/api/telephony/twiml` +
          `?transfer=${encodeURIComponent(support)}&capability=${encodeURIComponent(transferScope)}`;
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${call.twilio_call_sid}.json`,
          {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ Url: transferUrl, Method: "GET" }),
          }
        );
        if (!res.ok) return { error: `transfer failed (${res.status}) — direct the caller to the organization's main support channel` };
        await saveEvent(scope, "state", { node: "other", transfer: support });
        return { transferred: true, message: "Transfer initiated — say 'Connecting you to a human now' and nothing else. Do NOT say the phone number." };
      }
      await saveEvent(scope, "state", { node: "other", transfer_simulated: true });
      return { simulated: true, message: "This is a browser test call, so a real transfer isn't possible — say that on a real phone call they'd be connected to a human now. Do NOT say any phone number." };
    }

    case "request_recall": {
      return { error: "callback scheduling requires an exact human operator approval in Studio", code: "operator_approval_required" };
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
        // When end_call itself is executed through run_action, its freshly reserved receipt
        // is necessarily unresolved until this dispatch returns. Exclude only that exact,
        // host-bound receipt; older reservations and indeterminate actions still block hangup.
        const currentReceiptId = meta.actionContext?.receiptId;
        const unresolved = state.actionReceipts.filter((receipt) =>
          (receipt.status === "reserved" || receipt.status === "indeterminate") &&
          receipt.id !== currentReceiptId
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
      const call = await qOne<{ twilio_call_sid: string | null }>(
        "SELECT twilio_call_sid FROM calls WHERE id = $1", [scope.callId]
      );
      if (call?.twilio_call_sid && process.env.TWILIO_ACCOUNT_SID) {
        const accountSid = twilioAccountSid();
        const auth = twilioRestAuthorization();
        await saveEvent(scope, "state", { state: "ending", reason: args.reason ?? null });
        // Fire-and-return so the agent can finish speaking its goodbye before the leg drops.
        setTimeout(() => {
          void fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${call.twilio_call_sid}.json`,
            {
              method: "POST",
              headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ Status: "completed" }),
            }
          ).catch(() => {});
        }, 4000);
        return { ok: true, message: "Call will end in a few seconds — say your goodbye now if you haven't." };
      }
      await saveEvent(scope, "state", { state: "ending", reason: args.reason ?? null, simulated: true });
      return { ok: true, simulated: true, message: "Browser call — the caller ends it from their side." };
    }

    case "send_email": {
      return { error: "email sending requires an exact human operator approval in Studio", code: "operator_approval_required" };
    }

    case "send_sms": {
      return { error: "SMS sending requires an exact human operator approval in Studio", code: "operator_approval_required" };
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
      if (!ctx.internetEnabled) return { error: "internet access is disabled for this org", code: "internet_disabled" };
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
      const catalog = await listToolCatalogFor(scope, ctx);
      const integrationContext = meta.actionContext ?? directIntegrationContext(
        scope,
        ctx,
        catalog,
        name,
        args,
        meta.invocationId
      );
      const remote = ctx.externalMcpServers.find((server) =>
        server.tools.some((tool) => tool.name === name)
      );
      if (remote) {
        if (integrationContext?.audience !== "flow_action") {
          return {
            error: "remote MCP actions require a receipt-backed flow and pinned reconciliation contract",
            code: "remote_mcp_receipt_required",
          };
        }
        if (!integrationContext?.invocationId || !integrationContext.idempotencyKey) {
          return { error: "remote MCP execution requires a stable gateway invocation identity", code: "missing_invocation_identity" };
        }
        const outcome = await invokePinnedExternalMcpTool(scope.orgId, remote, name, args, {
          invocationId: integrationContext.invocationId,
          idempotencyKey: integrationContext.idempotencyKey,
        });
        return integrationContext.audience === "flow_action"
          ? outcome
          : outcome.outcome === "succeeded"
            ? outcome.value
            : { error: outcome.error, code: outcome.code };
      }
      const pinnedExtension = ctx.extensionTools.find((tool) => tool.name === name);
      if (pinnedExtension) {
        return meta.preparedExtension
          ? voiceToolExtensions.executePrepared(meta.preparedExtension)
          : voiceToolExtensions.executePinned(
          name,
          args,
          scope,
          pinnedExtension,
          integrationContext ?? {
            audience: "direct",
            runtimeDigest: runtimeDigest(ctx, catalog),
          },
          ctx.extensionTools
        );
      }
      const tool = ctx.mintedTools.find((t) => t.slug === name);
      if (!tool) return { error: `unknown tool ${name}` };
      if (!tool.endpoint_url || !tool.invocation_key_id) {
        return { error: `tool ${name} has no pinned isolated invocation revision; redeploy it` };
      }
      if (!integrationContext?.invocationId || !integrationContext.idempotencyKey) {
        return { error: "generated tool execution requires a stable gateway invocation identity", code: "missing_invocation_identity" };
      }
      if (integrationContext.audience !== "flow_action" && integrationContext.audience !== "direct") {
        return { error: "generated tool execution has an invalid audience", code: "wrong_tool_audience" };
      }
      let outcome: ToolInvocationOutcome;
      if (meta.preparedGeneratedInvocation) {
        const prepared = meta.preparedGeneratedInvocation;
        if (prepared.binding.toolId !== tool.id || prepared.binding.slug !== tool.slug ||
            prepared.binding.invocationId !== integrationContext.invocationId ||
            prepared.endpointUrl !== tool.endpoint_url) {
          return { error: `tool ${name} prepared invocation binding changed`, code: "generated_tool_preflight_mismatch" };
        }
        // Preparation decrypted and signed locally before the durable dispatch marker. Recheck the
        // exact revision immediately before the prepared object is allowed to cross the network.
        if (!await pinnedGeneratedAuthorityIsActive(scope, tool)) {
          return {
            outcome: "rejected",
            acknowledged: false,
            invocationId: integrationContext.invocationId,
            error: "generated tool authority was revoked before network dispatch",
          } satisfies ToolInvocationOutcome;
        }
        outcome = await executePreparedToolInvocation(prepared);
      } else {
        const signer = await loadPinnedGeneratedSigner(scope, tool);
        if (!signer || signer.slug !== tool.slug || signer.endpoint_url !== tool.endpoint_url ||
            signer.invocation_key_id !== tool.invocation_key_id) {
          return { error: `tool ${name} invocation revision changed; start a new call after redeploying` };
        }
        outcome = await invokeTool(
          tool.endpoint_url,
          args,
          {
            keyId: signer.invocation_key_id,
            privateKeyPkcs8Encrypted: signer.invocation_private_key_encrypted,
            slug: signer.slug,
          },
          {
            orgId: scope.orgId,
            toolId: tool.id,
            invocationId: integrationContext.invocationId,
            audience: integrationContext.audience,
            idempotencyKey: integrationContext.idempotencyKey,
            callId: scope.callId,
            agentId: scope.agentId,
            runtimeDigest: integrationContext.runtimeDigest,
            receiptId: integrationContext.receiptId,
          }
        );
      }
      return integrationContext.audience === "flow_action"
        ? outcome
        : outcome.outcome === "succeeded"
          ? outcome.value
          : { error: outcome.error, code: "generated_tool_rejected" };
    }
  }
}
