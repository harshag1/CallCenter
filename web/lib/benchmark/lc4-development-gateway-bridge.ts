import { z } from "zod";
import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import type { ProviderFunctionTool } from "./capability-gateway";
import type { Lc4DevLiveEpisodePlan } from "./lc4-development-live-runner";
import type { Lc4PublicDevOpportunity } from "./lc4-public-development-corpus";
import {
  createHaccProviderResponsePlanView,
  type HaccResponsePlan,
} from "./response-plan";
import { renderLc4ListenerAssertionContract } from "./lc4-listener-assertion-contract";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeResponsePreparation,
  RealtimeToolResult,
} from "../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
} from "../realtime/client/types";

export const LC4_DEV_GATEWAY_BRIDGE_VERSION = "lc4-dev-gateway-bridge-v4" as const;

const HASH = /^[a-f0-9]{64}$/u;
const MAX_TOOL_BATCHES_PER_OPPORTUNITY = 8;
const MAX_REJECTED_TOOL_BATCHES_PER_OPPORTUNITY = 3;
const MAX_TOOL_CALLS_PER_BATCH = 16;
const MAX_PROVIDER_RESULT_BYTES = 4_000;
export const LC4_DEV_MAX_REPLAY_MODEL_ARGUMENT_BYTES = 64 * 1_024;
export const LC4_DEV_MAX_REPLAY_BATCH_ARGUMENT_BYTES = 256 * 1_024;
const RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-dispatch-receipt/v2\n";
const REJECTION_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-rejection-receipt/v2\n";
const RECEIPT_SET_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-dispatch-receipt-set/v3\n";
const AUTHORITY_PROJECTION_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-authority-projection/v2\n";

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

export function lc4DevSemanticIntentsForActions(
  actions: readonly string[],
): readonly Lc4DevSemanticIntent[] {
  const actionSet = new Set(actions);
  return Object.freeze(
    LC4_DEV_SEMANTIC_INTENTS.filter((intent) => actionSet.has(LC4_DEV_INTENT_ACTION_MAP[intent])),
  );
}

function lc4DevGatewayContract(eligibleSemanticIntents: readonly Lc4DevSemanticIntent[]): Readonly<{
  function_name: typeof LOCAL_TOOL_PROXY_FUNCTION_NAME;
  tool_name_policy: "one_exact_eligible_semantic_intent";
  arguments_policy: "exact_empty_object";
  eligible_semantic_intents: readonly Lc4DevSemanticIntent[];
}> {
  return freeze({
    function_name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
    tool_name_policy: "one_exact_eligible_semantic_intent",
    arguments_policy: "exact_empty_object",
    eligible_semantic_intents: Object.freeze([...eligibleSemanticIntents]),
  });
}

/**
 * LC4's internal actions deliberately differ from the stable semantic names
 * exposed by its single provider function. This projection removes internal
 * implementation IDs (including non-callable flow.get_state) and commits the
 * model-visible semantic frontier back to the authoritative plan SHA.
 */
export function renderLc4DevHaccResponsePlan(
  plan: HaccResponsePlan,
  phase: "canonical" | "repair" = "canonical",
): string {
  const providerView = createHaccProviderResponsePlanView(plan);
  const {
    eligible_actions: eligibleActions,
    designated_reconciliation_actions: designatedReconciliationActions,
    ...common
  } = providerView;
  const eligibleSemanticIntents = phase === "repair"
    ? Object.freeze([]) as readonly Lc4DevSemanticIntent[]
    : lc4DevSemanticIntentsForActions(eligibleActions);
  const designatedReconciliationIntents = phase === "repair"
    ? Object.freeze([]) as readonly Lc4DevSemanticIntent[]
    : lc4DevSemanticIntentsForActions(designatedReconciliationActions);
  const view = freeze({
    ...common,
    plan_type: "hacc-lc4-provider-response-plan.v1" as const,
    phase,
    advances_horizon: phase === "canonical",
    eligible_semantic_intents: eligibleSemanticIntents,
    designated_reconciliation_intents: designatedReconciliationIntents,
    gateway_contract: lc4DevGatewayContract(eligibleSemanticIntents),
  });
  return [
    `<hacc_response_plan>\n${canonicalJson(view)}\n</hacc_response_plan>`,
    renderLc4ListenerAssertionContract(),
  ].join("\n");
}

/**
 * Native receives one static, arm-common callable vocabulary. Its surrounding
 * instructions are byte-stable and contain no host projection of the active
 * flow, current facts, evaluator criteria, or expected next action.
 */
export function appendLc4DevNativeGatewayContract(
  instructions: string,
  phase: "canonical" | "repair" = "canonical",
): string {
  if (!instructions.trim()) throw new Error("LC4-DEV Native instructions are empty");
  const contract = lc4DevGatewayContract(
    phase === "canonical" ? LC4_DEV_SEMANTIC_INTENTS : Object.freeze([]),
  );
  return [
    instructions,
    `<lc4_gateway_contract>\n${canonicalJson(contract)}\n</lc4_gateway_contract>`,
    renderLc4ListenerAssertionContract(),
  ].join("\n");
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
  currentResponsePreparation(input: Readonly<{
    episode: Lc4DevLiveEpisodePlan;
    opportunity: Lc4PublicDevOpportunity;
    phase: "canonical" | "repair";
  }>): RealtimeResponsePreparation;
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
 * dispatch and world transition rather than trusting summary hashes. Rebound
 * response plans and controls remain host evidence here; they are deliberately
 * absent from the provider-visible tool result.
 */
export type Lc4DevGatewayAuthorityProjection = Readonly<{
  schema_version: 2;
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
  post_transition_response_plan: JsonValue | null;
  post_transition_response_control: JsonValue | null;
  post_transition_response_plan_sha256: string | null;
  post_transition_response_control_sha256: string | null;
  authoritative_receipt_sha256: string;
  control_plane_head_sha256: string;
  disposition: "executed" | "replayed" | "deduplicated" | "verified" | "rejected";
  projection_sha256: string;
}>;

/** Content-free evidence: arguments, results, prompts, transcripts, and IDs are hashes only. */
export type Lc4DevSanitizedGatewayReceipt = Readonly<{
  schema_version: 2;
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
  authority_projection_sha256: string;
  receipt_sha256: string;
}>;

export const LC4_DEV_PRE_DISPATCH_REJECTION_CODES = Object.freeze([
  "unknown_semantic_intent",
  "model_arguments_forbidden",
  "malformed_semantic_request",
  "batch_rejected_invalid_member",
  "tool_calls_forbidden_during_repair",
] as const);

export type Lc4DevPreDispatchRejectionCode =
  typeof LC4_DEV_PRE_DISPATCH_REJECTION_CODES[number];

/**
 * A correlatable model-authored request that was refused before executable
 * authority existed. It is intentionally separate from authority projections:
 * a malformed attempt cannot satisfy an obligation or be mistaken for a
 * ToolWorld transition.
 */
export type Lc4DevSanitizedGatewayRejection = Readonly<{
  schema_version: 2;
  bridge_version: typeof LC4_DEV_GATEWAY_BRIDGE_VERSION;
  opportunity_id: string;
  phase: "canonical" | "repair";
  provider: Lc4DevLiveEpisodePlan["provider"];
  arm: Arm;
  batch_ordinal: number;
  call_ordinal: number;
  rejection_code: Lc4DevPreDispatchRejectionCode;
  provider_call_id_sha256: string;
  provider_response_id_sha256: string;
  request_sha256: string;
  provider_provenance_sha256: string;
  model_arguments_sha256: string;
  provider_output_sha256: string;
  executor_invoked: false;
  authority_effect: "none";
  rejection_receipt_sha256: string;
}>;

export type Lc4DevGatewayReceiptSet = Readonly<{
  receipts: readonly Lc4DevSanitizedGatewayReceipt[];
  authority_projections: readonly Lc4DevGatewayAuthorityProjection[];
  pre_dispatch_rejections: readonly Lc4DevSanitizedGatewayRejection[];
  receipt_set_sha256: string;
}>;

/**
 * Provider-visible tool history captured at the delivery boundary.
 *
 * This deliberately preserves provider batch boundaries: history hydration
 * must recreate every function call in a batch before recreating any result
 * from that batch. The coordinator keeps it separate from the compact receipt
 * set; the versioned DEV provider-exchange artifact incorporates the bounded
 * snapshot into its own committed replay hash.
 */
export type Lc4DevGatewayConversationToolCall = Readonly<{
  call_ordinal: number;
  gateway_tool_name: typeof LOCAL_TOOL_PROXY_FUNCTION_NAME;
  model_arguments: Readonly<Record<string, JsonValue>>;
  provider_output_canonical_json: string;
  source_kind: "authority_projection" | "pre_dispatch_rejection";
  source_sha256: string;
  disposition:
    | Lc4DevGatewayAuthorityProjection["disposition"]
    | "pre_dispatch_rejected";
  pre_dispatch_rejection_code: Lc4DevPreDispatchRejectionCode | null;
}>;

export type Lc4DevGatewayConversationToolBatch = Readonly<{
  schema_version: 2;
  bridge_version: typeof LC4_DEV_GATEWAY_BRIDGE_VERSION;
  batch_ordinal: number;
  provider_response_id_sha256: string;
  calls: readonly Lc4DevGatewayConversationToolCall[];
}>;

export type Lc4DevGatewayOpportunityWithConversationReplay = Readonly<{
  receipt_set: Lc4DevGatewayReceiptSet;
  conversation_tool_batches: readonly Lc4DevGatewayConversationToolBatch[];
}>;

type OpportunityContext = Readonly<{
  episode: Lc4DevLiveEpisodePlan;
  opportunity: Lc4PublicDevOpportunity;
  phase: "canonical" | "repair";
}>;

type ExecutableCall = Readonly<{
  call_id: string;
  response_id: string;
  semantic_intent: Lc4DevSemanticIntent;
  target_tool: string;
  target_arguments: Readonly<Record<string, JsonValue>>;
  gateway_tool_name: typeof LOCAL_TOOL_PROXY_FUNCTION_NAME;
  model_arguments: Readonly<Record<string, JsonValue>>;
  request_sha256: string;
  provider_provenance_sha256: string;
}>;

type CandidateCall = Readonly<{
  call_id: string;
  response_id: string;
  gateway_tool_name: typeof LOCAL_TOOL_PROXY_FUNCTION_NAME;
  semantic_input: Readonly<Record<string, JsonValue>>;
  request_sha256: string;
  provider_provenance_sha256: string;
}>;

type RejectedCall = Readonly<{
  candidate: CandidateCall;
  rejection_code: Lc4DevPreDispatchRejectionCode;
}>;

class Lc4DevGatewayProvenanceError extends Error {}

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function gatewayRecord(value: unknown, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function assertGatewayKeys(
  value: Record<string, JsonValue>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length
    || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} has an invalid schema`);
  }
}

function gatewayOrdinal(value: JsonValue, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function gatewayBodyWithout(
  value: Record<string, JsonValue>,
  excluded: ReadonlySet<string>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.has(key)),
  );
}

/**
 * Independently recomputes every nested receipt digest and then closes the
 * cross-record lineage. This is the canonical admission gate used both at the
 * source boundary and by retained provider-exchange replay.
 */
export function assertLc4DevGatewayReceiptSet(
  value: unknown,
): asserts value is Lc4DevGatewayReceiptSet {
  const set = gatewayRecord(value, "LC4-DEV gateway receipt set");
  assertGatewayKeys(set, [
    "receipts",
    "authority_projections",
    "pre_dispatch_rejections",
    "receipt_set_sha256",
  ], "LC4-DEV gateway receipt set");
  if (!Array.isArray(set.receipts)
    || !Array.isArray(set.authority_projections)
    || !Array.isArray(set.pre_dispatch_rejections)) {
    throw new Error("LC4-DEV gateway receipt set arrays are invalid");
  }
  requireHash(String(set.receipt_set_sha256), "LC4-DEV gateway receipt set");

  const authorities = new Map<string, Record<string, JsonValue>>();
  for (const candidate of set.authority_projections) {
    const authority = gatewayRecord(candidate, "LC4-DEV gateway authority projection");
    const claimed = String(authority.projection_sha256);
    requireHash(claimed, "LC4-DEV gateway authority projection");
    const body = gatewayBodyWithout(authority, new Set(["projection_sha256"]));
    if (authority.schema_version !== 2
      || authority.bridge_version !== LC4_DEV_GATEWAY_BRIDGE_VERSION
      || sha256Hex(`${AUTHORITY_PROJECTION_DOMAIN}${canonicalJson(body)}`) !== claimed
      || authorities.has(claimed)) {
      throw new Error("LC4-DEV gateway authority projection hash or version is invalid");
    }
    authorities.set(claimed, authority);
  }

  const authorityReceiptCounts = new Map<string, number>();
  const orderedSources: Array<Readonly<{
    batch: number;
    call: number;
    kind: "authority_projection" | "pre_dispatch_rejection";
    sha256: string;
  }>> = [];
  let priorReceiptPosition = "";
  for (const candidate of set.receipts) {
    const receipt = gatewayRecord(candidate, "LC4-DEV gateway dispatch receipt");
    const claimed = String(receipt.receipt_sha256);
    const authoritySha256 = String(receipt.authority_projection_sha256);
    requireHash(claimed, "LC4-DEV gateway dispatch receipt");
    requireHash(authoritySha256, "LC4-DEV gateway dispatch authority projection");
    const body = gatewayBodyWithout(receipt, new Set(["receipt_sha256"]));
    const batch = gatewayOrdinal(receipt.batch_ordinal, "LC4-DEV gateway receipt batch ordinal");
    const call = gatewayOrdinal(receipt.call_ordinal, "LC4-DEV gateway receipt call ordinal");
    const position = `${String(batch).padStart(8, "0")}:${String(call).padStart(8, "0")}`;
    const authority = authorities.get(authoritySha256);
    if (receipt.schema_version !== 2
      || receipt.bridge_version !== LC4_DEV_GATEWAY_BRIDGE_VERSION
      || sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(body)}`) !== claimed
      || position <= priorReceiptPosition
      || !authority
      || receipt.opportunity_id !== authority.opportunity_id
      || receipt.provider !== authority.provider
      || receipt.arm !== authority.arm
      || receipt.semantic_intent !== authority.semantic_intent
      || receipt.target_tool !== authority.target_tool
      || receipt.provider_call_id_sha256 !== authority.provider_call_id_sha256
      || receipt.provider_response_id_sha256 !== authority.provider_response_id_sha256
      || receipt.request_sha256 !== authority.request_sha256
      || receipt.provider_provenance_sha256 !== authority.provider_provenance_sha256
      || receipt.provider_output_sha256 !== sha256Hex(canonicalJson(authority.provider_output))
      || receipt.post_transition_response_plan_sha256
        !== authority.post_transition_response_plan_sha256
      || receipt.post_transition_response_control_sha256
        !== authority.post_transition_response_control_sha256
      || receipt.authoritative_receipt_sha256 !== authority.authoritative_receipt_sha256
      || receipt.control_plane_head_sha256 !== authority.control_plane_head_sha256
      || receipt.disposition !== authority.disposition) {
      throw new Error("LC4-DEV gateway dispatch receipt lineage is invalid");
    }
    priorReceiptPosition = position;
    authorityReceiptCounts.set(
      authoritySha256,
      (authorityReceiptCounts.get(authoritySha256) ?? 0) + 1,
    );
    orderedSources.push({
      batch,
      call,
      kind: "authority_projection",
      sha256: authoritySha256,
    });
  }

  let priorRejectionPosition = "";
  const rejectionHashes = new Set<string>();
  for (const candidate of set.pre_dispatch_rejections) {
    const rejection = gatewayRecord(candidate, "LC4-DEV gateway rejection receipt");
    const claimed = String(rejection.rejection_receipt_sha256);
    requireHash(claimed, "LC4-DEV gateway rejection receipt");
    requireHash(String(rejection.model_arguments_sha256), "LC4-DEV gateway rejection model arguments");
    requireHash(String(rejection.provider_output_sha256), "LC4-DEV gateway rejection provider output");
    const sourceBody = gatewayBodyWithout(
      rejection,
      new Set(["rejection_receipt_sha256", "provider_output_sha256"]),
    );
    const batch = gatewayOrdinal(rejection.batch_ordinal, "LC4-DEV gateway rejection batch ordinal");
    const call = gatewayOrdinal(rejection.call_ordinal, "LC4-DEV gateway rejection call ordinal");
    const position = `${String(batch).padStart(8, "0")}:${String(call).padStart(8, "0")}`;
    const expectedProviderOutput = {
      ok: false,
      code: "capability_request_rejected",
      reason: rejection.rejection_code,
      retriable: true,
      executed: false,
      rejection_receipt_sha256: claimed,
    };
    if (rejection.schema_version !== 2
      || rejection.bridge_version !== LC4_DEV_GATEWAY_BRIDGE_VERSION
      || sha256Hex(`${REJECTION_RECEIPT_DOMAIN}${canonicalJson(sourceBody)}`) !== claimed
      || sha256Hex(canonicalJson(expectedProviderOutput))
        !== rejection.provider_output_sha256
      || position <= priorRejectionPosition
      || rejectionHashes.has(claimed)) {
      throw new Error("LC4-DEV gateway rejection receipt hash, version, or order is invalid");
    }
    priorRejectionPosition = position;
    rejectionHashes.add(claimed);
    orderedSources.push({
      batch,
      call,
      kind: "pre_dispatch_rejection",
      sha256: claimed,
    });
  }
  if (authorities.size !== authorityReceiptCounts.size
    || [...authorityReceiptCounts.values()].some((count) => count !== 1)) {
    throw new Error("LC4-DEV gateway authority projections do not map one-to-one to receipts");
  }
  orderedSources.sort((left, right) => left.batch - right.batch || left.call - right.call);
  for (let index = 1; index < orderedSources.length; index += 1) {
    const prior = orderedSources[index - 1]!;
    const current = orderedSources[index]!;
    if (prior.batch === current.batch && prior.call === current.call) {
      throw new Error("LC4-DEV gateway receipt source position is duplicated");
    }
  }
  const expectedSetHash = sha256Hex(`${RECEIPT_SET_DOMAIN}${canonicalJson({
    receipts: set.receipts,
    authority_projections: set.authority_projections,
    pre_dispatch_rejections: set.pre_dispatch_rejections,
  })}`);
  if (set.receipt_set_sha256 !== expectedSetHash) {
    throw new Error("LC4-DEV gateway receipt set digest is invalid");
  }
}

function assertResponsePreparation(
  preparation: RealtimeResponsePreparation,
): RealtimeResponsePreparation {
  if (!preparation.additionalInstructions.trim()) {
    throw new Error("LC4-DEV continuation response control is empty");
  }
  requireHash(preparation.contextSha256, "LC4-DEV continuation response control");
  if (sha256Hex(preparation.additionalInstructions) !== preparation.contextSha256) {
    throw new Error("LC4-DEV continuation response control hash mismatch");
  }
  if (preparation.contextAuthority !== "advisory_only_gateway_and_speech_gate_enforced") {
    throw new Error("LC4-DEV continuation response control authority boundary mismatch");
  }
  return Object.freeze({ ...preparation });
}

function providerOutputSnapshot(value: JsonValue): JsonValue {
  const frozen = freeze(value);
  const encoded = canonicalJson(frozen);
  const encodedBytes = Buffer.byteLength(encoded, "utf8");
  if (encodedBytes > MAX_PROVIDER_RESULT_BYTES) {
    throw new Error(
      `LC4-DEV gateway provider output exceeds ${MAX_PROVIDER_RESULT_BYTES} UTF-8 bytes: `
      + `actual_bytes=${encodedBytes}`,
    );
  }
  return frozen;
}

function normalizedModelArguments(
  value: unknown,
): Readonly<Record<string, JsonValue>> {
  const normalized = immutableJson(value);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error("LC4-DEV gateway model arguments must be a JSON object");
  }
  return normalized as Readonly<Record<string, JsonValue>>;
}

function assertReplayableModelArgumentBatch(calls: readonly CandidateCall[]): void {
  const canonicalArguments = calls.map((call, index) => {
    const encoded = canonicalJson(call.semantic_input);
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    if (encodedBytes > LC4_DEV_MAX_REPLAY_MODEL_ARGUMENT_BYTES) {
      throw new Error(
        `LC4-DEV gateway model arguments at call ${index + 1} exceed `
        + `${LC4_DEV_MAX_REPLAY_MODEL_ARGUMENT_BYTES} UTF-8 bytes: actual_bytes=${encodedBytes}`,
      );
    }
    return call.semantic_input;
  });
  const aggregateBytes = Buffer.byteLength(canonicalJson(canonicalArguments), "utf8");
  if (aggregateBytes > LC4_DEV_MAX_REPLAY_BATCH_ARGUMENT_BYTES) {
    throw new Error(
      `LC4-DEV gateway model argument batch exceeds `
      + `${LC4_DEV_MAX_REPLAY_BATCH_ARGUMENT_BYTES} UTF-8 bytes: `
      + `actual_bytes=${aggregateBytes}`,
    );
  }
}

function candidateCallsFromEvent(event: NormalizedRealtimeEvent): Readonly<{
  provider: Lc4DevLiveEpisodePlan["provider"];
  response_id: string;
  calls: readonly CandidateCall[];
}> | null {
  if (event.type === "tool.dispatch") {
    return Object.freeze({
      provider: event.provider,
      response_id: event.responseId,
      calls: Object.freeze(event.dispatches.map((dispatch) => {
        const metadata = dispatch.request.params._meta;
        if (dispatch.provenance.provider !== event.provider
          || dispatch.provenance.nativeCallId !== dispatch.callId
          || dispatch.provenance.nativeResponseId !== event.responseId
          || metadata[LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY] !== dispatch.callId
          || canonicalJson(metadata[PROVIDER_PROVENANCE_META_KEY]) !== canonicalJson(dispatch.provenance)) {
          throw new Lc4DevGatewayProvenanceError(
            "LC4-DEV local gateway dispatch provenance is inconsistent",
          );
        }
        return freeze({
          call_id: dispatch.callId,
          response_id: event.responseId,
          gateway_tool_name: event.gateway,
          semantic_input: normalizedModelArguments({
            tool_name: dispatch.request.params.name,
            arguments: dispatch.request.params.arguments,
          }),
          request_sha256: sha256Hex(canonicalJson(dispatch.request)),
          provider_provenance_sha256: sha256Hex(canonicalJson(dispatch.provenance)),
        });
      })),
    });
  }
  if (event.type === "tool.calls" && event.provider === "gemini") {
    return Object.freeze({
      provider: event.provider,
      response_id: event.responseId,
      calls: Object.freeze(event.calls.map((call) => {
        if (call.name !== "capability_gateway") {
          throw new Error("LC4-DEV Gemini attempted a function outside capability_gateway");
        }
        if (call.argumentsError || call.argumentsJson === null) {
          throw new Error("LC4-DEV Gemini capability_gateway arguments are malformed");
        }
        const requestBody = {
          method: "tools/call" as const,
          params: { name: call.name, arguments: call.argumentsJson },
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
          gateway_tool_name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
          semantic_input: normalizedModelArguments(call.argumentsJson),
          request_sha256: sha256Hex(canonicalJson(requestBody)),
          provider_provenance_sha256: sha256Hex(canonicalJson(provenance)),
        });
      })),
    });
  }
  return null;
}

function classifySemanticCall(candidate: CandidateCall):
  | Readonly<{ ok: true; call: ExecutableCall }>
  | Readonly<{ ok: false; rejection_code: Lc4DevPreDispatchRejectionCode }> {
  const input = candidate.semantic_input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return Object.freeze({ ok: false, rejection_code: "malformed_semantic_request" });
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "arguments" || keys[1] !== "tool_name") {
    return Object.freeze({ ok: false, rejection_code: "malformed_semantic_request" });
  }
  if (typeof record.tool_name !== "string"
    || !(LC4_DEV_SEMANTIC_INTENTS as readonly string[]).includes(record.tool_name)) {
    return Object.freeze({ ok: false, rejection_code: "unknown_semantic_intent" });
  }
  if (record.arguments === null
    || typeof record.arguments !== "object"
    || Array.isArray(record.arguments)) {
    return Object.freeze({ ok: false, rejection_code: "malformed_semantic_request" });
  }
  if (Object.keys(record.arguments as Record<string, unknown>).length !== 0) {
    return Object.freeze({ ok: false, rejection_code: "model_arguments_forbidden" });
  }
  const parsed = normalizeSemanticCall(input);
  return Object.freeze({
    ok: true,
    call: freeze({
      call_id: candidate.call_id,
      response_id: candidate.response_id,
      semantic_intent: parsed.semantic_intent,
      target_tool: parsed.target_tool,
      target_arguments: parsed.target_arguments,
      gateway_tool_name: candidate.gateway_tool_name,
      model_arguments: candidate.semantic_input,
      request_sha256: candidate.request_sha256,
      provider_provenance_sha256: candidate.provider_provenance_sha256,
    }),
  });
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
  #fatalClass: "none" | "parse" | "provenance" | "execution" | "delivery" | "unknown" = "none";
  #batchOrdinal = 0;
  #rejectedBatchCount = 0;
  #receipts: Lc4DevSanitizedGatewayReceipt[] = [];
  #authorityProjections: Lc4DevGatewayAuthorityProjection[] = [];
  #preDispatchRejections: Lc4DevSanitizedGatewayRejection[] = [];
  #conversationToolBatches: Lc4DevGatewayConversationToolBatch[] = [];
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

  beginOpportunity(context: Omit<OpportunityContext, "phase"> & Readonly<{
    phase?: OpportunityContext["phase"];
  }>): void {
    if (this.#context !== null) throw new Error("LC4-DEV gateway coordinator already has an active opportunity");
    if (this.#fatal) throw this.#fatal;
    if (this.#batchOrdinal !== 0
      || this.#rejectedBatchCount !== 0
      || this.#receipts.length !== 0
      || this.#authorityProjections.length !== 0
      || this.#preDispatchRejections.length !== 0
      || this.#conversationToolBatches.length !== 0
      || this.#toolResponseIds.size !== 0) {
      throw new Error("LC4-DEV gateway coordinator state was not sealed after the prior opportunity");
    }
    this.#context = Object.freeze({ ...context, phase: context.phase ?? "canonical" });
  }

  observe(event: NormalizedRealtimeEvent): void {
    let batch: ReturnType<typeof candidateCallsFromEvent>;
    try {
      batch = candidateCallsFromEvent(event);
    } catch (error) {
      this.#fail(error, error instanceof Lc4DevGatewayProvenanceError ? "provenance" : "parse");
      return;
    }
    if (batch === null) return;
    const { calls: candidates } = batch;
    const context = this.#context;
    if (!context) {
      this.#fail(new Error("LC4-DEV provider emitted a tool batch outside an active opportunity"), "provenance");
      return;
    }
    if (batch.provider !== context.episode.provider) {
      this.#fail(new Error("LC4-DEV provider tool batch differs from the active episode"), "provenance");
      return;
    }
    if (candidates.length === 0 || candidates.length > MAX_TOOL_CALLS_PER_BATCH) {
      this.#fail(new Error("LC4-DEV provider tool batch is empty or exceeds 16 calls"), "provenance");
      return;
    }
    const responseIds = new Set(candidates.map((call) => call.response_id));
    if (responseIds.size !== 1 || !responseIds.has(batch.response_id)) {
      this.#fail(new Error("LC4-DEV provider tool batch response provenance is inconsistent"), "provenance");
      return;
    }
    try {
      assertReplayableModelArgumentBatch(candidates);
    } catch (error) {
      this.#fail(error, "parse");
      return;
    }
    if (context.episode.provider !== "gemini" && this.#toolResponseIds.has(batch.response_id)) {
      this.#fail(new Error("LC4-DEV provider repeated an executable tool batch response"), "provenance");
      return;
    }
    if (this.#batchOrdinal >= MAX_TOOL_BATCHES_PER_OPPORTUNITY) {
      this.#fail(new Error("LC4-DEV opportunity exceeded eight provider tool batches"), "provenance");
      return;
    }
    for (const call of candidates) {
      if (this.#seenCallIds.has(call.call_id)) {
        this.#fail(new Error("LC4-DEV provider reused a tool call identity"), "provenance");
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
    const classified = context.phase === "repair"
      ? candidates.map(() => Object.freeze({
          ok: false as const,
          rejection_code: "tool_calls_forbidden_during_repair" as const,
        }))
      : candidates.map(classifySemanticCall);
    const rejectedMember = classified.find((entry) => !entry.ok);
    if (rejectedMember) {
      this.#rejectedBatchCount += 1;
      if (this.#rejectedBatchCount > MAX_REJECTED_TOOL_BATCHES_PER_OPPORTUNITY) {
        this.#fail(new Error("LC4-DEV opportunity exceeded three rejected provider tool batches"), "provenance");
        return;
      }
      const rejectedCalls = Object.freeze(classified.map((entry, index): RejectedCall => Object.freeze({
        candidate: candidates[index]!,
        rejection_code: entry.ok ? "batch_rejected_invalid_member" : entry.rejection_code,
      })));
      this.#queue = this.#queue.then(
        () => this.#rejectBatch(context, batchOrdinal, rejectedCalls),
      ).catch((error) => {
        this.#fail(error, "delivery");
      });
      return;
    }
    const executableCalls = Object.freeze(classified.map((entry) => {
      if (!entry.ok) throw new Error("LC4-DEV semantic batch classification changed after admission");
      return entry.call;
    }));
    this.#queue = this.#queue.then(() => this.#executeBatch(context, batchOrdinal, executableCalls)).catch((error) => {
      this.#fail(error, "execution");
    });
  }

  ownsToolResponse(responseId: string): boolean {
    return this.#toolResponseIds.has(responseId);
  }

  /** A strict, plaintext-free projection suitable for failed-exchange evidence. */
  diagnosticSnapshot(): Readonly<{
    batch_count: number;
    receipt_count: number;
    authority_projection_count: number;
    rejection_count: number;
    fatal_class: "none" | "parse" | "provenance" | "execution" | "delivery" | "unknown";
  }> {
    return Object.freeze({
      batch_count: this.#batchOrdinal,
      receipt_count: this.#receipts.length,
      authority_projection_count: this.#authorityProjections.length,
      rejection_count: this.#preDispatchRejections.length,
      fatal_class: this.#fatalClass,
    });
  }

  async finishOpportunity(): Promise<Lc4DevGatewayReceiptSet> {
    const finished = await this.finishOpportunityWithConversationReplay();
    return finished.receipt_set;
  }

  async finishOpportunityWithConversationReplay():
  Promise<Lc4DevGatewayOpportunityWithConversationReplay> {
    if (!this.#context) throw new Error("LC4-DEV gateway coordinator has no active opportunity");
    await this.#queue;
    if (this.#fatal) throw this.#fatal;
    const receipts = Object.freeze([...this.#receipts]);
    const authorityProjections = Object.freeze([...this.#authorityProjections]);
    const preDispatchRejections = Object.freeze([...this.#preDispatchRejections]);
    const conversationToolBatches = Object.freeze([...this.#conversationToolBatches]);
    const receiptSetSha256 = sha256Hex(`${RECEIPT_SET_DOMAIN}${canonicalJson({
      receipts,
      authority_projections: authorityProjections,
      pre_dispatch_rejections: preDispatchRejections,
    })}`);
    const receiptSet = Object.freeze({
      receipts,
      authority_projections: authorityProjections,
      pre_dispatch_rejections: preDispatchRejections,
      receipt_set_sha256: receiptSetSha256,
    });
    assertLc4DevGatewayReceiptSet(receiptSet);
    this.#context = null;
    this.#batchOrdinal = 0;
    this.#rejectedBatchCount = 0;
    this.#receipts = [];
    this.#authorityProjections = [];
    this.#preDispatchRejections = [];
    this.#conversationToolBatches = [];
    this.#toolResponseIds = new Set();
    this.#seenCallIds = new Set();
    this.#queue = Promise.resolve();
    this.#fatalClass = "none";
    return Object.freeze({
      receipt_set: receiptSet,
      conversation_tool_batches: conversationToolBatches,
    });
  }

  async #rejectBatch(
    context: OpportunityContext,
    batchOrdinal: number,
    calls: readonly RejectedCall[],
  ): Promise<void> {
    if (this.#fatal) throw this.#fatal;
    const results: RealtimeToolResult[] = [];
    const conversationCalls: Lc4DevGatewayConversationToolCall[] = [];
    for (const [index, call] of calls.entries()) {
      const rejectionBody = freeze({
        schema_version: 2 as const,
        bridge_version: LC4_DEV_GATEWAY_BRIDGE_VERSION,
        opportunity_id: context.opportunity.id,
        phase: context.phase,
        provider: context.episode.provider,
        arm: context.episode.arm,
        batch_ordinal: batchOrdinal,
        call_ordinal: index + 1,
        rejection_code: call.rejection_code,
        provider_call_id_sha256: sha256Hex(call.candidate.call_id),
        provider_response_id_sha256: sha256Hex(call.candidate.response_id),
        request_sha256: call.candidate.request_sha256,
        provider_provenance_sha256: call.candidate.provider_provenance_sha256,
        model_arguments_sha256: sha256Hex(canonicalJson(call.candidate.semantic_input)),
        executor_invoked: false as const,
        authority_effect: "none" as const,
      });
      const rejectionReceiptSha256 = sha256Hex(
        `${REJECTION_RECEIPT_DOMAIN}${canonicalJson(rejectionBody)}`,
      );
      const providerOutput = providerOutputSnapshot(freeze({
        ok: false,
        code: "capability_request_rejected",
        reason: call.rejection_code,
        retriable: true,
        executed: false,
        rejection_receipt_sha256: rejectionReceiptSha256,
      }));
      results.push({ callId: call.candidate.call_id, output: providerOutput });
      conversationCalls.push(freeze({
        call_ordinal: index + 1,
        gateway_tool_name: call.candidate.gateway_tool_name,
        model_arguments: call.candidate.semantic_input,
        provider_output_canonical_json: canonicalJson(providerOutput),
        source_kind: "pre_dispatch_rejection" as const,
        source_sha256: rejectionReceiptSha256,
        disposition: "pre_dispatch_rejected" as const,
        pre_dispatch_rejection_code: call.rejection_code,
      }));
      this.#preDispatchRejections.push(freeze({
        ...rejectionBody,
        provider_output_sha256: sha256Hex(canonicalJson(providerOutput)),
        rejection_receipt_sha256: rejectionReceiptSha256,
      }));
    }
    this.#deliverToolContinuation(context, results, freeze({
      schema_version: 2 as const,
      bridge_version: LC4_DEV_GATEWAY_BRIDGE_VERSION,
      batch_ordinal: batchOrdinal,
      provider_response_id_sha256: sha256Hex(calls[0]!.candidate.response_id),
      calls: conversationCalls,
    }));
  }

  async #executeBatch(
    context: OpportunityContext,
    batchOrdinal: number,
    calls: readonly ExecutableCall[],
  ): Promise<void> {
    if (this.#fatal) throw this.#fatal;
    const results: RealtimeToolResult[] = [];
    const conversationCalls: Lc4DevGatewayConversationToolCall[] = [];
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
      const fullResponsePlan = outcome.authority_projection.post_transition_response_plan;
      const fullResponseControl = outcome.authority_projection.post_transition_response_control;
      const fullResponsePlanRecord = fullResponsePlan !== null
        && typeof fullResponsePlan === "object"
        && !Array.isArray(fullResponsePlan)
        ? fullResponsePlan as Readonly<Record<string, JsonValue>>
        : null;
      if (context.episode.arm === "hacc") {
        const authoritativeTransition =
          outcome.authority_projection.authoritative_tool_world_receipt !== null
          && outcome.disposition !== "rejected";
        if (authoritativeTransition
          && (fullResponsePlan === null
            || fullResponseControl === null
            || outcome.authority_projection.post_transition_response_plan_sha256 === null
            || outcome.authority_projection.post_transition_response_control_sha256 === null)) {
          throw new Error("LC4-DEV HACC authoritative transition omits its full post-transition response control");
        }
        if ((outcome.authority_projection.post_transition_response_plan_sha256 === null) !== (fullResponsePlan === null)
          || (outcome.authority_projection.post_transition_response_control_sha256 === null) !== (fullResponseControl === null)) {
          throw new Error("LC4-DEV HACC authority projection does not retain its full post-transition response control");
        }
        if (fullResponsePlan !== null
          && (fullResponsePlanRecord === null
            || fullResponsePlanRecord.plan_sha256 !== outcome.authority_projection.post_transition_response_plan_sha256)) {
          throw new Error("LC4-DEV HACC authority projection response plan does not match its committed digest");
        }
      }
      if (fullResponseControl !== null
        && sha256Hex(canonicalJson(fullResponseControl))
          !== outcome.authority_projection.post_transition_response_control_sha256) {
        throw new Error("LC4-DEV authority projection response control does not match its committed digest");
      }
      const { projection_sha256: claimedProjection, ...projectionBody } = outcome.authority_projection;
      if (claimedProjection !== sha256Hex(`${AUTHORITY_PROJECTION_DOMAIN}${canonicalJson(projectionBody)}`)
        || outcome.authority_projection.bridge_version !== LC4_DEV_GATEWAY_BRIDGE_VERSION
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
        || canonicalJson(outcome.authority_projection.provider_output) !== canonicalJson(outcome.provider_output)
        || canonicalJson(outcome.authority_projection.model_arguments) !== canonicalJson(call.target_arguments)) {
        throw new Error("LC4-DEV gateway authority projection does not replay the exact provider dispatch");
      }
      const providerOutput = providerOutputSnapshot(outcome.provider_output);
      results.push({ callId: call.call_id, output: providerOutput });
      const body = freeze({
        schema_version: 2 as const,
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
        authority_projection_sha256: outcome.authority_projection.projection_sha256,
      });
      this.#receipts.push(freeze({
        ...body,
        receipt_sha256: sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(body)}`),
      }));
      this.#authorityProjections.push(freeze(outcome.authority_projection));
      conversationCalls.push(freeze({
        call_ordinal: index + 1,
        gateway_tool_name: call.gateway_tool_name,
        model_arguments: call.model_arguments,
        provider_output_canonical_json: canonicalJson(providerOutput),
        source_kind: "authority_projection" as const,
        source_sha256: outcome.authority_projection.projection_sha256,
        disposition: outcome.disposition,
        pre_dispatch_rejection_code: null,
      }));
    }
    // Every adapter has a different default. The shared delivery path binds
    // the final post-transition control, submits the complete batch with
    // implicit generation disabled, then requests exactly one continuation.
    if (this.#fatal) throw this.#fatal;
    this.#deliverToolContinuation(context, results, freeze({
      schema_version: 2 as const,
      bridge_version: LC4_DEV_GATEWAY_BRIDGE_VERSION,
      batch_ordinal: batchOrdinal,
      provider_response_id_sha256: sha256Hex(calls[0]!.response_id),
      calls: conversationCalls,
    }));
  }

  #deliverToolContinuation(
    context: OpportunityContext,
    results: readonly RealtimeToolResult[],
    conversationToolBatch: Lc4DevGatewayConversationToolBatch,
  ): void {
    try {
      const prepareToolContinuation = this.#client.prepareToolContinuation;
      if (typeof prepareToolContinuation !== "function") {
        throw new Error("LC4-DEV provider client cannot bind tool-continuation response control");
      }
      const currentResponsePreparation = this.#executor.currentResponsePreparation;
      if (typeof currentResponsePreparation !== "function") {
        throw new Error("LC4-DEV gateway executor cannot resolve current continuation control");
      }
      const preparation = assertResponsePreparation(
        currentResponsePreparation({
          episode: context.episode,
          opportunity: context.opportunity,
          phase: context.phase,
        }),
      );
      // The result is the bounded authoritative outcome. The host applies the
      // post-transition plan through the provider's continuation-control path,
      // before result delivery, instead of duplicating it into the tool output.
      prepareToolContinuation.call(this.#client, preparation);
      this.#client.submitToolResults(Object.freeze([...results]), false);
      // Snapshot only after synchronous provider delivery accepts the exact
      // batch. Failed preflight/rebind/submission attempts cannot enter replay.
      this.#conversationToolBatches.push(conversationToolBatch);
      this.#client.createResponse();
    } catch (error) {
      this.#fail(error, "delivery");
      throw error;
    }
  }

  #fail(
    error: unknown,
    failureClass: "parse" | "provenance" | "execution" | "delivery" | "unknown" = "unknown",
  ): void {
    if (this.#fatal) return;
    this.#fatal = error instanceof Error ? error : new Error("LC4-DEV gateway bridge failed");
    this.#fatalClass = failureClass;
    this.#onFatal(this.#fatal);
  }
}
