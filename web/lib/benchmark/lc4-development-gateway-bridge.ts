import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import { CapabilityGatewayCallSchema } from "./capability-gateway";
import type { Lc4DevLiveEpisodePlan } from "./lc4-development-live-runner";
import type { Lc4PublicDevOpportunity } from "./lc4-public-development-corpus";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeToolCall,
  RealtimeToolResult,
} from "../realtime/client/types";

export const LC4_DEV_GATEWAY_BRIDGE_VERSION = "lc4-dev-gateway-bridge-v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const MAX_TOOL_BATCHES_PER_OPPORTUNITY = 8;
const MAX_TOOL_CALLS_PER_BATCH = 16;
const MAX_PROVIDER_RESULT_BYTES = 64 * 1024;
const RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-dispatch-receipt/v1\n";
const RECEIPT_SET_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-dispatch-receipt-set/v1\n";

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
  }>>;
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
  target_tool: string;
  provider_call_id_sha256: string;
  provider_response_id_sha256: string;
  request_sha256: string;
  provider_provenance_sha256: string;
  provider_output_sha256: string;
  authoritative_receipt_sha256: string;
  control_plane_head_sha256: string;
  disposition: "executed" | "replayed" | "deduplicated" | "verified" | "rejected";
  receipt_sha256: string;
}>;

export type Lc4DevGatewayReceiptSet = Readonly<{
  receipts: readonly Lc4DevSanitizedGatewayReceipt[];
  receipt_set_sha256: string;
}>;

type OpportunityContext = Readonly<{
  episode: Lc4DevLiveEpisodePlan;
  opportunity: Lc4PublicDevOpportunity;
}>;

type ExecutableCall = Readonly<{
  call_id: string;
  response_id: string;
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
  const parsed = CapabilityGatewayCallSchema.parse(call.argumentsJson);
  const requestBody = {
    method: "tools/call" as const,
    params: { name: parsed.tool_name, arguments: parsed.arguments },
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
    target_tool: parsed.tool_name,
    target_arguments: parsed.arguments,
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
      calls: Object.freeze(event.dispatches.map((dispatch) => freeze({
        call_id: dispatch.callId,
        response_id: event.responseId,
        target_tool: dispatch.request.params.name,
        target_arguments: dispatch.request.params.arguments as Readonly<Record<string, JsonValue>>,
        request_sha256: sha256Hex(canonicalJson(dispatch.request)),
        provider_provenance_sha256: sha256Hex(canonicalJson(dispatch.provenance)),
      }))),
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
    if (this.#batchOrdinal !== 0 || this.#receipts.length !== 0 || this.#toolResponseIds.size !== 0) {
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
    if (this.#toolResponseIds.has(batch.response_id)) {
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
    const receiptSetSha256 = sha256Hex(`${RECEIPT_SET_DOMAIN}${canonicalJson(receipts)}`);
    this.#context = null;
    this.#batchOrdinal = 0;
    this.#receipts = [];
    this.#toolResponseIds = new Set();
    this.#seenCallIds = new Set();
    this.#queue = Promise.resolve();
    return Object.freeze({ receipts, receipt_set_sha256: receiptSetSha256 });
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
        target_tool: call.target_tool,
        target_arguments: call.target_arguments,
        request_sha256: call.request_sha256,
        provider_provenance_sha256: call.provider_provenance_sha256,
      }));
      requireHash(outcome.authoritative_receipt_sha256, "LC4-DEV authoritative gateway receipt");
      requireHash(outcome.control_plane_head_sha256, "LC4-DEV control plane head");
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
        target_tool: call.target_tool,
        provider_call_id_sha256: sha256Hex(call.call_id),
        provider_response_id_sha256: sha256Hex(call.response_id),
        request_sha256: call.request_sha256,
        provider_provenance_sha256: call.provider_provenance_sha256,
        provider_output_sha256: sha256Hex(canonicalJson(providerOutput)),
        authoritative_receipt_sha256: outcome.authoritative_receipt_sha256,
        control_plane_head_sha256: outcome.control_plane_head_sha256,
        disposition: outcome.disposition,
      });
      this.#receipts.push(freeze({
        ...body,
        receipt_sha256: sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(body)}`),
      }));
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
