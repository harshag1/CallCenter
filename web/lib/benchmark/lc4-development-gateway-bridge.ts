import { z } from "zod";
import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import type { ProviderFunctionTool } from "./capability-gateway";
import type { Lc4DevLiveEpisodePlan } from "./lc4-development-live-runner";
import type { Lc4PublicDevOpportunity } from "./lc4-public-development-corpus";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeToolCall,
  RealtimeToolResult,
} from "../realtime/client/types";
import { LOCAL_TOOL_PROXY_FUNCTION_NAME } from "../realtime/client/types";

export const LC4_DEV_GATEWAY_BRIDGE_VERSION = "lc4-dev-gateway-bridge-v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const MAX_TOOL_BATCHES_PER_OPPORTUNITY = 8;
const MAX_TOOL_CALLS_PER_BATCH = 16;
const MAX_PROVIDER_RESULT_BYTES = 64 * 1024;
const RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-dispatch-receipt/v1\n";
const RECEIPT_SET_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-dispatch-receipt-set/v1\n";
const AUTHORITY_PROJECTION_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-authority-projection/v1\n";

export const LC4_DEV_SEMANTIC_INTENTS = Object.freeze([
  "launch_async_worker",
  "record_async_worker_result",
  "submit_accessible_transcript",
  "reconcile_accessible_transcript",
  "complete_current_stage",
  "reserve_archive_room",
] as const);

export type Lc4DevSemanticIntent = typeof LC4_DEV_SEMANTIC_INTENTS[number];

export const LC4_DEV_INTENT_ACTION_MAP: Readonly<Record<Lc4DevSemanticIntent, string>> = Object.freeze({
  launch_async_worker: "archive.launch_worker",
  record_async_worker_result: "archive.observe_worker_result",
  submit_accessible_transcript: "archive.submit_transcript_request",
  reconcile_accessible_transcript: "archive.reconcile_transcript_request",
  complete_current_stage: "archive.complete_stage",
  reserve_archive_room: "archive.reserve_room",
});

/**
 * LC4-DEV's provider surface is one stable function plus one closed semantic
 * intent. All current action payloads are host/oracle-owned, so the model has
 * no admissible slots. This prevents benchmark driver state from leaking into
 * provider-authored arguments.
 */
export const LC4_DEV_SEMANTIC_GATEWAY_FUNCTION = immutableJson({
  type: "function",
  name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
  description: [
    "Request one LC4-DEV semantic intent from the closed enum.",
    "Pass an empty arguments object; the host binds every current benchmark slot.",
    "Never supply request identities, worker envelopes, reconciliation sources, receipts, or provider provenance.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      tool_name: {
        type: "string",
        description: "Closed semantic intent, not an implementation action name.",
        enum: LC4_DEV_SEMANTIC_INTENTS,
      },
      arguments: {
        type: "object",
        description: "No model-owned slots exist in LC4-DEV v1.",
        additionalProperties: false,
        properties: {},
      },
    },
    required: ["tool_name", "arguments"],
  },
}) as unknown as ProviderFunctionTool;

export function isLc4DevSemanticGatewayFunction(value: unknown): boolean {
  return canonicalJson(value) === canonicalJson(LC4_DEV_SEMANTIC_GATEWAY_FUNCTION);
}

const Lc4DevSemanticCallSchema = z.object({
  tool_name: z.enum(LC4_DEV_SEMANTIC_INTENTS),
  arguments: z.object({}).strict(),
}).strict();

function normalizeSemanticCall(input: unknown): Readonly<{
  semantic_intent: Lc4DevSemanticIntent;
  target_tool: string;
  target_arguments: Readonly<Record<string, JsonValue>>;
}> {
  const parsed = Lc4DevSemanticCallSchema.parse(input);
  return Object.freeze({
    semantic_intent: parsed.tool_name,
    target_tool: LC4_DEV_INTENT_ACTION_MAP[parsed.tool_name],
    target_arguments: Object.freeze({}),
  });
}

export function lc4DevSemanticIntentForAction(action: string): Lc4DevSemanticIntent {
  const match = Object.entries(LC4_DEV_INTENT_ACTION_MAP)
    .find(([, candidate]) => candidate === action)?.[0] as Lc4DevSemanticIntent | undefined;
  if (!match) throw new Error(`LC4-DEV action ${action} has no closed semantic intent`);
  return match;
}

type Arm = Lc4DevLiveEpisodePlan["arm"];

export type Lc4DevGatewayExecutionInput = Readonly<{
  bridge_version: typeof LC4_DEV_GATEWAY_BRIDGE_VERSION;
  episode_id: string;
  opportunity_id: string;
  opportunity_index: number;
  provider: Lc4DevLiveEpisodePlan["provider"];
  arm: Arm;
  provider_call_id: string;
  provider_response_id: string;
  semantic_intent: Lc4DevSemanticIntent;
  target_tool: string;
  target_arguments: Readonly<Record<string, JsonValue>>;
  request_sha256: string;
  provider_provenance_sha256: string;
}>;

/**
 * Executable authority injected by the DEV control plane. Native and HACC are
 * both explicit here so the implementation can preserve the preregistered raw
 * Native policy while applying Flow/gateway authority only to HACC.
 */
export type Lc4DevGatewayExecutor = Readonly<{
  kind: "lc4-dev-arm-aware-gateway-v1";
  manifest_sha256: string;
  execute(input: Lc4DevGatewayExecutionInput): Promise<Readonly<{
    provider_output: JsonValue;
    authoritative_receipt_sha256: string;
    control_plane_head_sha256: string;
    disposition: "executed" | "replayed" | "deduplicated" | "verified" | "rejected";
    authority_projection: Lc4DevGatewayAuthorityProjection;
  }>>;
}>;

/**
 * Replay-complete, DEV-public authority projection. Raw provider call/response
 * identities and credentials are excluded; model-visible public arguments,
 * the host-effective arguments, provider-visible result, and authoritative
 * ToolWorld receipt are retained so an independent process can recompute the
 * dispatch and world transition rather than trusting summary hashes.
 */
export type Lc4DevGatewayAuthorityProjection = Readonly<{
  schema_version: 1;
  bridge_version: typeof LC4_DEV_GATEWAY_BRIDGE_VERSION;
  redaction: "public_dev_authority_no_raw_provider_ids_or_credentials";
  episode_id: string;
  opportunity_id: string;
  opportunity_index: number;
  provider: Lc4DevLiveEpisodePlan["provider"];
  arm: Arm;
  semantic_intent: Lc4DevSemanticIntent;
  target_tool: string;
  provider_call_id_sha256: string;
  provider_response_id_sha256: string;
  request_sha256: string;
  provider_provenance_sha256: string;
  model_arguments: Readonly<Record<string, JsonValue>>;
  effective_arguments: Readonly<Record<string, JsonValue>> | null;
  provider_output: JsonValue;
  authoritative_receipt: JsonValue;
  authoritative_tool_world_receipt: JsonValue | null;
  post_transition_response_plan_sha256: string | null;
  post_transition_response_control_sha256: string | null;
  authoritative_receipt_sha256: string;
  control_plane_head_sha256: string;
  disposition: "executed" | "replayed" | "deduplicated" | "verified" | "rejected";
  projection_sha256: string;
}>;

/** Content-free evidence: arguments, results, prompts, transcripts, and IDs are hashes only. */
export type Lc4DevSanitizedGatewayReceipt = Readonly<{
  schema_version: 1;
  bridge_version: typeof LC4_DEV_GATEWAY_BRIDGE_VERSION;
  opportunity_id: string;
  provider: Lc4DevLiveEpisodePlan["provider"];
  arm: Arm;
  batch_ordinal: number;
  call_ordinal: number;
  semantic_intent: Lc4DevSemanticIntent;
  target_tool: string;
  provider_call_id_sha256: string;
  provider_response_id_sha256: string;
  request_sha256: string;
  provider_provenance_sha256: string;
  provider_output_sha256: string;
  post_transition_response_plan_sha256: string | null;
  post_transition_response_control_sha256: string | null;
  authoritative_receipt_sha256: string;
  control_plane_head_sha256: string;
  disposition: "executed" | "replayed" | "deduplicated" | "verified" | "rejected";
  receipt_sha256: string;
}>;

export type Lc4DevGatewayReceiptSet = Readonly<{
  receipts: readonly Lc4DevSanitizedGatewayReceipt[];
  authority_projections: readonly Lc4DevGatewayAuthorityProjection[];
  receipt_set_sha256: string;
}>;

type OpportunityContext = Readonly<{
  episode: Lc4DevLiveEpisodePlan;
  opportunity: Lc4PublicDevOpportunity;
}>;

type ExecutableCall = Readonly<{
  call_id: string;
  response_id: string;
  semantic_intent: Lc4DevSemanticIntent;
  target_tool: string;
  target_arguments: Readonly<Record<string, JsonValue>>;
  request_sha256: string;
  provider_provenance_sha256: string;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function providerOutputSnapshot(value: JsonValue): JsonValue {
  const frozen = freeze(value);
  const encoded = canonicalJson(frozen);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PROVIDER_RESULT_BYTES) {
    throw new Error("LC4-DEV gateway provider output exceeds 64 KiB");
  }
  return frozen;
}

function normalizedGeminiCall(call: RealtimeToolCall): ExecutableCall {
  if (call.name !== "capability_gateway") {
    throw new Error("LC4-DEV Gemini attempted a function outside capability_gateway");
  }
  if (call.argumentsError || call.argumentsJson === null) {
    throw new Error("LC4-DEV Gemini capability_gateway arguments are malformed");
  }
  const parsed = normalizeSemanticCall(call.argumentsJson);
  const requestBody = {
    method: "tools/call" as const,
    params: { name: parsed.semantic_intent, arguments: parsed.target_arguments },
  };
  const provenance = {
    provider: "gemini" as const,
    response_id: call.responseId,
    call_id: call.callId,
    item_id: call.itemId ?? null,
    terminal_event_id: call.terminalEventId ?? null,
    terminal_wire_type: call.terminalWireType,
  };
  return freeze({
    call_id: call.callId,
    response_id: call.responseId,
    semantic_intent: parsed.semantic_intent,
    target_tool: parsed.target_tool,
    target_arguments: parsed.target_arguments,
    request_sha256: sha256Hex(canonicalJson(requestBody)),
    provider_provenance_sha256: sha256Hex(canonicalJson(provenance)),
  });
}

function callsFromEvent(event: NormalizedRealtimeEvent): Readonly<{
  response_id: string;
  calls: readonly ExecutableCall[];
}> | null {
  if (event.type === "tool.dispatch") {
    return Object.freeze({
      response_id: event.responseId,
      calls: Object.freeze(event.dispatches.map((dispatch) => {
        const parsed = normalizeSemanticCall({
          tool_name: dispatch.request.params.name,
          arguments: dispatch.request.params.arguments,
        });
        return freeze({
          call_id: dispatch.callId,
          response_id: event.responseId,
          semantic_intent: parsed.semantic_intent,
          target_tool: parsed.target_tool,
          target_arguments: parsed.target_arguments,
          request_sha256: sha256Hex(canonicalJson(dispatch.request)),
          provider_provenance_sha256: sha256Hex(canonicalJson(dispatch.provenance)),
        });
      })),
    });
  }
  if (event.type === "tool.calls" && event.provider === "gemini") {
    return Object.freeze({
      response_id: event.responseId,
      calls: Object.freeze(event.calls.map(normalizedGeminiCall)),
    });
  }
  return null;
}

/**
 * One coordinator is attached to one provider session. It serializes complete
 * provider batches, executes every call exactly once in provider order, sends
 * all results with auto-response disabled, and then requests exactly one
 * continuation. Event callbacks never run gateway work inline.
 */
export class Lc4DevGatewayTurnCoordinator {
  readonly #client: NormalizedRealtimeClient;
  readonly #executor: Lc4DevGatewayExecutor;
  readonly #onFatal: (error: Error) => void;
  #context: OpportunityContext | null = null;
  #queue: Promise<void> = Promise.resolve();
  #fatal: Error | null = null;
  #batchOrdinal = 0;
  #receipts: Lc4DevSanitizedGatewayReceipt[] = [];
  #authorityProjections: Lc4DevGatewayAuthorityProjection[] = [];
  #toolResponseIds = new Set<string>();
  #seenCallIds = new Set<string>();

  constructor(input: Readonly<{
    client: NormalizedRealtimeClient;
    executor: Lc4DevGatewayExecutor;
    onFatal(error: Error): void;
  }>) {
    requireHash(input.executor.manifest_sha256, "LC4-DEV gateway executor manifest");
    this.#client = input.client;
    this.#executor = input.executor;
    this.#onFatal = input.onFatal;
  }

  beginOpportunity(context: OpportunityContext): void {
    if (this.#context !== null) throw new Error("LC4-DEV gateway coordinator already has an active opportunity");
    if (this.#fatal) throw this.#fatal;
    if (this.#batchOrdinal !== 0 || this.#receipts.length !== 0 || this.#authorityProjections.length !== 0 || this.#toolResponseIds.size !== 0) {
      throw new Error("LC4-DEV gateway coordinator state was not sealed after the prior opportunity");
    }
    this.#context = context;
  }

  observe(event: NormalizedRealtimeEvent): void {
    let batch: ReturnType<typeof callsFromEvent>;
    try {
      batch = callsFromEvent(event);
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (batch === null) return;
    const { calls } = batch;
    const context = this.#context;
    if (!context) {
      this.#fail(new Error("LC4-DEV provider emitted a tool batch outside an active opportunity"));
      return;
    }
    if (calls.length === 0 || calls.length > MAX_TOOL_CALLS_PER_BATCH) {
      this.#fail(new Error("LC4-DEV provider tool batch is empty or exceeds 16 calls"));
      return;
    }
    const responseIds = new Set(calls.map((call) => call.response_id));
    if (responseIds.size !== 1 || !responseIds.has(batch.response_id)) {
      this.#fail(new Error("LC4-DEV provider tool batch response provenance is inconsistent"));
      return;
    }
    if (context.episode.provider !== "gemini" && this.#toolResponseIds.has(batch.response_id)) {
      this.#fail(new Error("LC4-DEV provider repeated an executable tool batch response"));
      return;
    }
    if (this.#batchOrdinal >= MAX_TOOL_BATCHES_PER_OPPORTUNITY) {
      this.#fail(new Error("LC4-DEV opportunity exceeded eight provider tool batches"));
      return;
    }
    for (const call of calls) {
      if (this.#seenCallIds.has(call.call_id)) {
        this.#fail(new Error("LC4-DEV provider reused a tool call identity"));
        return;
      }
      this.#seenCallIds.add(call.call_id);
    }
    // Gemini Live can emit several sequential toolCall batches under one
    // model-turn response id as each tool result advances the same turn. The
    // provider call id is its replay boundary; OpenAI/xAI retain the stricter
    // one-executable-batch-per-response invariant above.
    this.#toolResponseIds.add(batch.response_id);
    const batchOrdinal = ++this.#batchOrdinal;
    this.#queue = this.#queue.then(() => this.#executeBatch(context, batchOrdinal, calls!)).catch((error) => {
      this.#fail(error);
    });
  }

  ownsToolResponse(responseId: string): boolean {
    return this.#toolResponseIds.has(responseId);
  }

  async finishOpportunity(): Promise<Lc4DevGatewayReceiptSet> {
    if (!this.#context) throw new Error("LC4-DEV gateway coordinator has no active opportunity");
    await this.#queue;
    if (this.#fatal) throw this.#fatal;
    const receipts = Object.freeze([...this.#receipts]);
    const authorityProjections = Object.freeze([...this.#authorityProjections]);
    const receiptSetSha256 = sha256Hex(`${RECEIPT_SET_DOMAIN}${canonicalJson({ receipts, authority_projections: authorityProjections })}`);
    this.#context = null;
    this.#batchOrdinal = 0;
    this.#receipts = [];
    this.#authorityProjections = [];
    this.#toolResponseIds = new Set();
    this.#seenCallIds = new Set();
    this.#queue = Promise.resolve();
    return Object.freeze({ receipts, authority_projections: authorityProjections, receipt_set_sha256: receiptSetSha256 });
  }

  async #executeBatch(
    context: OpportunityContext,
    batchOrdinal: number,
    calls: readonly ExecutableCall[],
  ): Promise<void> {
    if (this.#fatal) throw this.#fatal;
    const results: RealtimeToolResult[] = [];
    for (const [index, call] of calls.entries()) {
      if (this.#fatal) throw this.#fatal;
      const outcome = await this.#executor.execute(freeze({
        bridge_version: LC4_DEV_GATEWAY_BRIDGE_VERSION,
        episode_id: context.episode.episode_id,
        opportunity_id: context.opportunity.id,
        opportunity_index: context.opportunity.index,
        provider: context.episode.provider,
        arm: context.episode.arm,
        provider_call_id: call.call_id,
        provider_response_id: call.response_id,
        semantic_intent: call.semantic_intent,
        target_tool: call.target_tool,
        target_arguments: call.target_arguments,
        request_sha256: call.request_sha256,
        provider_provenance_sha256: call.provider_provenance_sha256,
      }));
      requireHash(outcome.authoritative_receipt_sha256, "LC4-DEV authoritative gateway receipt");
      requireHash(outcome.control_plane_head_sha256, "LC4-DEV control plane head");
      requireHash(outcome.authority_projection.projection_sha256, "LC4-DEV gateway authority projection");
      if (outcome.authority_projection.post_transition_response_plan_sha256 !== null) {
        requireHash(outcome.authority_projection.post_transition_response_plan_sha256, "LC4-DEV post-transition response plan");
      }
      if (outcome.authority_projection.post_transition_response_control_sha256 !== null) {
        requireHash(outcome.authority_projection.post_transition_response_control_sha256, "LC4-DEV post-transition response control");
      }
      const { projection_sha256: claimedProjection, ...projectionBody } = outcome.authority_projection;
      if (claimedProjection !== sha256Hex(`${AUTHORITY_PROJECTION_DOMAIN}${canonicalJson(projectionBody)}`)
        || outcome.authority_projection.episode_id !== context.episode.episode_id
        || outcome.authority_projection.opportunity_id !== context.opportunity.id
        || outcome.authority_projection.provider_call_id_sha256 !== sha256Hex(call.call_id)
        || outcome.authority_projection.provider_response_id_sha256 !== sha256Hex(call.response_id)
        || outcome.authority_projection.request_sha256 !== call.request_sha256
        || outcome.authority_projection.provider_provenance_sha256 !== call.provider_provenance_sha256
        || outcome.authority_projection.semantic_intent !== call.semantic_intent
        || outcome.authority_projection.target_tool !== call.target_tool
        || outcome.authority_projection.authoritative_receipt_sha256 !== outcome.authoritative_receipt_sha256
        || outcome.authority_projection.control_plane_head_sha256 !== outcome.control_plane_head_sha256
        || outcome.authority_projection.disposition !== outcome.disposition
        || canonicalJson(outcome.authority_projection.model_arguments) !== canonicalJson(call.target_arguments)) {
        throw new Error("LC4-DEV gateway authority projection does not replay the exact provider dispatch");
      }
      const providerOutput = providerOutputSnapshot(outcome.provider_output);
      results.push({ callId: call.call_id, output: providerOutput });
      const body = freeze({
        schema_version: 1 as const,
        bridge_version: LC4_DEV_GATEWAY_BRIDGE_VERSION,
        opportunity_id: context.opportunity.id,
        provider: context.episode.provider,
        arm: context.episode.arm,
        batch_ordinal: batchOrdinal,
        call_ordinal: index + 1,
        semantic_intent: call.semantic_intent,
        target_tool: call.target_tool,
        provider_call_id_sha256: sha256Hex(call.call_id),
        provider_response_id_sha256: sha256Hex(call.response_id),
        request_sha256: call.request_sha256,
        provider_provenance_sha256: call.provider_provenance_sha256,
        provider_output_sha256: sha256Hex(canonicalJson(providerOutput)),
        post_transition_response_plan_sha256: outcome.authority_projection.post_transition_response_plan_sha256,
        post_transition_response_control_sha256: outcome.authority_projection.post_transition_response_control_sha256,
        authoritative_receipt_sha256: outcome.authoritative_receipt_sha256,
        control_plane_head_sha256: outcome.control_plane_head_sha256,
        disposition: outcome.disposition,
      });
      this.#receipts.push(freeze({
        ...body,
        receipt_sha256: sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(body)}`),
      }));
      this.#authorityProjections.push(freeze(outcome.authority_projection));
    }
    // Every adapter has a different default. Passing false removes ambiguity;
    // the host requests exactly one continuation only after the full batch is sent.
    if (this.#fatal) throw this.#fatal;
    this.#client.submitToolResults(Object.freeze(results), false);
    this.#client.createResponse();
  }

  #fail(error: unknown): void {
    if (this.#fatal) return;
    this.#fatal = error instanceof Error ? error : new Error("LC4-DEV gateway bridge failed");
    this.#onFatal(this.#fatal);
  }
}
