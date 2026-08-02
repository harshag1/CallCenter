import { canonicalJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  appendLc4DevNativeGatewayContract,
  assertLc4DevGatewayReceiptSet,
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  renderLc4DevHaccResponsePlan,
} from "./lc4-development-gateway-bridge";
import { assertHaccResponsePlan, type HaccResponsePlan } from "./response-plan";
import { realtimeToolFrontierSha256 } from "../realtime/client/openai-compatible";

const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL_RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-control-receipt/v1\n";
const REPAIR_DECISION_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-repair-decision-receipt/v1\n";
export const LC4_DEV_RESPONSE_PLAN_CHAIN_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-response-plan-chain/v1\n";

type JsonRecord = Record<string, JsonValue>;

const CONTROL_AUTHORITY_KEYS = Object.freeze([
  "schema_version",
  "manifest_sha256",
  "episode_id",
  "arm",
  "opportunity_id",
  "opportunity_index",
  "previous_exchange_sha256",
  "response_control",
  "flow_state_sha256",
  "gateway_transcript_head_sha256",
  "tool_world_state_sha256",
  "worker_state_sha256",
  "repair_state_sha256",
  "native_continuity_state_sha256",
] as const);

const REPAIR_DECISION_KEYS = Object.freeze([
  "schema_version",
  "protocol_id",
  "episode_id",
  "canonical_opportunity_id",
  "canonical_ordinal",
  "canonical_horizon",
  "advances_canonical_horizon",
  "canonical_control_receipt_sha256",
  "canonical_exchange_sha256",
  "canonical_listener_evidence_sha256",
  "semantic_replay_sha256",
  "plan_sha256",
  "plan_binding_sha256",
  "decision",
  "state_after_sha256",
] as const);

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length
    || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be one lowercase SHA-256`);
  }
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function safeOrdinal(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function controlReceiptSha256(authority: JsonRecord): string {
  return sha256Hex(`${CONTROL_RECEIPT_DOMAIN}${canonicalJson(authority)}`);
}

function repairDecisionReceiptSha256(decision: JsonRecord): string {
  return sha256Hex(`${REPAIR_DECISION_DOMAIN}${canonicalJson(decision)}`);
}

function exactControlAuthority(input: Readonly<{
  value: JsonValue;
  receipt_sha256: string;
  episode_id: string;
  opportunity_id: string;
  opportunity_index: number;
  arm: "native" | "hacc";
}>): JsonRecord {
  const authority = record(input.value, "LC4 retained control authority");
  exactKeys(
    authority,
    CONTROL_AUTHORITY_KEYS,
    "LC4 retained control authority",
  );
  hash(input.receipt_sha256, "LC4 retained control authority receipt");
  for (const [label, value] of [
    ["manifest", authority.manifest_sha256],
    ["flow state", authority.flow_state_sha256],
    ["gateway transcript head", authority.gateway_transcript_head_sha256],
    ["tool world state", authority.tool_world_state_sha256],
    ["worker state", authority.worker_state_sha256],
    ["repair state", authority.repair_state_sha256],
    ["native continuity state", authority.native_continuity_state_sha256],
  ] as const) hash(value, `LC4 retained control authority ${label}`);
  nullableHash(
    authority.previous_exchange_sha256,
    "LC4 retained control authority previous exchange",
  );
  if (authority.schema_version !== 1
    || authority.episode_id !== input.episode_id
    || authority.opportunity_id !== input.opportunity_id
    || safeOrdinal(
      authority.opportunity_index,
      "LC4 retained control authority opportunity index",
    ) !== input.opportunity_index
    || authority.arm !== input.arm
    || controlReceiptSha256(authority) !== input.receipt_sha256) {
    throw new Error(
      "LC4 retained control authority differs from its signed episode, opportunity, arm, or receipt",
    );
  }
  return authority;
}

function exactRepairDecision(input: Readonly<{
  value: JsonValue | null;
  receipt_sha256: string | null;
  episode_id: string;
  opportunity_id: string;
  opportunity_index: number;
  control_receipt_sha256: string;
  canonical_provider_exchange_sha256: string | null;
}>): JsonRecord {
  if (input.value === null || input.receipt_sha256 === null) {
    throw new Error("LC4 repair exchange lacks its retained signed repair decision");
  }
  const receipt = record(input.value, "LC4 retained repair decision");
  exactKeys(receipt, REPAIR_DECISION_KEYS, "LC4 retained repair decision");
  const decision = record(
    receipt.decision,
    "LC4 retained conversational repair decision",
  );
  hash(decision.decision_sha256, "LC4 retained conversational repair decision");
  hash(receipt.semantic_replay_sha256, "LC4 retained repair semantic replay");
  hash(receipt.plan_sha256, "LC4 retained repair plan");
  hash(receipt.plan_binding_sha256, "LC4 retained repair plan binding");
  hash(receipt.state_after_sha256, "LC4 retained repair state");
  if (input.canonical_provider_exchange_sha256 === null) {
    throw new Error(
      "LC4 repair exchange lacks its canonical provider-exchange authority",
    );
  }
  hash(
    input.canonical_provider_exchange_sha256,
    "LC4 canonical provider exchange for repair",
  );
  if (receipt.schema_version !== 1
    || receipt.protocol_id !== "HACC-LC4-DEV-v1"
    || receipt.episode_id !== input.episode_id
    || receipt.canonical_opportunity_id !== input.opportunity_id
    || receipt.canonical_ordinal !== input.opportunity_index
    || receipt.canonical_horizon !== 60
    || receipt.advances_canonical_horizon !== false
    || receipt.canonical_control_receipt_sha256
      !== input.control_receipt_sha256
    || receipt.canonical_exchange_sha256
      !== input.canonical_provider_exchange_sha256
    || decision.selection === null
    || repairDecisionReceiptSha256(receipt) !== input.receipt_sha256) {
    throw new Error(
      "LC4 retained repair decision differs from its canonical control, exchange, or selected repair",
    );
  }
  return receipt;
}

function orderedGatewayAuthorities(
  receiptSetValue: unknown,
): readonly JsonRecord[] {
  assertLc4DevGatewayReceiptSet(receiptSetValue);
  const receiptSet = record(
    receiptSetValue,
    "LC4 treatment gateway receipt set",
  );
  const receipts = receiptSet.receipts as unknown as readonly JsonRecord[];
  const projections = receiptSet.authority_projections as unknown as
    readonly JsonRecord[];
  const byHash = new Map(projections.map((projection) => [
    hash(
      projection.projection_sha256,
      "LC4 treatment gateway authority projection",
    ),
    projection,
  ]));
  return Object.freeze(receipts.map((receipt) => {
    const projection = byHash.get(hash(
      receipt.authority_projection_sha256,
      "LC4 treatment gateway receipt authority",
    ));
    if (!projection) {
      throw new Error(
        "LC4 treatment gateway receipt lacks its exact authority projection",
      );
    }
    return projection;
  }));
}

export type Lc4ProviderExchangeTreatmentBinding = Readonly<{
  control_receipt_sha256: string;
  previous_provider_exchange_sha256: string | null;
  previous_hacc_response_plan_sha256: string | null;
  initial_response_plan_sha256: string;
  terminal_response_plan_sha256: string;
  terminal_response_control_sha256: string;
  initial_flow_state_sha256: string;
  terminal_flow_state_sha256: string;
  tool_frontier_sha256: string;
  repair_decision_receipt_sha256: string | null;
  canonical_provider_exchange_sha256: string | null;
}>;

/**
 * Rebuilds every model-visible treatment field from retained authority rather
 * than accepting a self-consistent provider-exchange projection. The signed
 * control receipt owns the initial response; exact gateway authority owns any
 * post-tool rebound; a repair exchange additionally requires its signed CRP
 * decision.
 */
export function assertLc4ProviderExchangeTreatmentBinding(input: Readonly<{
  projection: JsonValue;
  control_authority: JsonValue;
  control_receipt_sha256: string;
  episode_id: string;
  opportunity_id: string;
  opportunity_index: number;
  arm: "native" | "hacc";
  playback_kind: "canonical" | "repair";
  repair_decision: JsonValue | null;
  repair_decision_receipt_sha256: string | null;
  canonical_provider_exchange_sha256: string | null;
  expected_previous_provider_exchange_sha256: string | null;
  expected_previous_hacc_response_plan_sha256: string | null;
}>): Lc4ProviderExchangeTreatmentBinding {
  const projection = record(
    input.projection,
    "LC4 provider exchange treatment projection",
  );
  const authority = exactControlAuthority({
    value: input.control_authority,
    receipt_sha256: input.control_receipt_sha256,
    episode_id: input.episode_id,
    opportunity_id: input.opportunity_id,
    opportunity_index: input.opportunity_index,
    arm: input.arm,
  });
  const expectedPreviousExchangeSha256 = nullableHash(
    input.expected_previous_provider_exchange_sha256,
    "LC4 expected previous provider exchange",
  );
  const expectedPreviousHaccPlanSha256 = nullableHash(
    input.expected_previous_hacc_response_plan_sha256,
    "LC4 expected previous HACC response plan",
  );
  if (authority.previous_exchange_sha256 !== expectedPreviousExchangeSha256) {
    throw new Error(
      "LC4 retained control authority forks from the prior effective provider exchange",
    );
  }
  if (projection.schema_version !== 5
    || projection.run_id !== input.episode_id
    || projection.opportunity_id !== input.opportunity_id
    || projection.playback_kind !== input.playback_kind) {
    throw new Error(
      "LC4 provider exchange treatment differs from its retained authority identity",
    );
  }
  if (input.playback_kind === "repair") {
    exactRepairDecision({
      value: input.repair_decision,
      receipt_sha256: input.repair_decision_receipt_sha256,
      episode_id: input.episode_id,
      opportunity_id: input.opportunity_id,
      opportunity_index: input.opportunity_index,
      control_receipt_sha256: input.control_receipt_sha256,
      canonical_provider_exchange_sha256:
        input.canonical_provider_exchange_sha256,
    });
    if (projection.repair_decision_receipt_sha256
      !== input.repair_decision_receipt_sha256) {
      throw new Error(
        "LC4 repair provider exchange differs from its signed repair decision",
      );
    }
  } else if (input.repair_decision !== null
    || input.repair_decision_receipt_sha256 !== null
    || input.canonical_provider_exchange_sha256 !== null
    || projection.repair_decision_receipt_sha256 !== null) {
    throw new Error(
      "LC4 canonical provider exchange contains repair-only authority",
    );
  }

  const responseControl = record(
    authority.response_control,
    "LC4 retained response control",
  );
  const expectedToolFrontierSha256 = realtimeToolFrontierSha256([
    LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  ]);
  if (projection.tool_frontier_sha256 !== expectedToolFrontierSha256) {
    throw new Error(
      "LC4 provider exchange tool frontier differs from the frozen model-visible gateway",
    );
  }

  let initialResponsePlanSha256: string;
  let terminalResponsePlanSha256: string;
  let terminalResponseControlSha256: string;
  const initialFlowStateSha256 = hash(
    authority.flow_state_sha256,
    "LC4 retained initial flow state",
  );
  let terminalFlowStateSha256 = initialFlowStateSha256;
  let currentPlan: HaccResponsePlan | null = null;
  let admittedPreviousHaccPlanSha256 = expectedPreviousHaccPlanSha256;

  if (input.arm === "hacc") {
    if (responseControl.kind !== "hacc_response_plan") {
      throw new Error("LC4 HACC authority lacks its response plan");
    }
    if (input.opportunity_index > 1
      && expectedPreviousHaccPlanSha256 === null) {
      throw new Error(
        "LC4 HACC treatment after the first opportunity lacks its prior terminal response plan",
      );
    }
    currentPlan = assertHaccResponsePlan(responseControl.plan);
    // The HACC controller may perform a signed host-only route transition
    // before the first provider exchange (for LC4 this is flow.select_topic).
    // Its resulting predecessor is not yet present in provider runtime state.
    // Admit it only at the first provider boundary, only when both external
    // continuity heads are genesis, and only from the exact control authority
    // already bound to control_receipt_sha256 above. Every later provider
    // exchange remains chained to the independently retained terminal plan.
    if (input.playback_kind === "canonical"
      && input.opportunity_index === 1
      && expectedPreviousExchangeSha256 === null
      && expectedPreviousHaccPlanSha256 === null) {
      admittedPreviousHaccPlanSha256 = currentPlan.previous_plan_sha256;
    }
    if (currentPlan.previous_plan_sha256
      !== admittedPreviousHaccPlanSha256) {
      throw new Error(
        `LC4 HACC signed control plan forks from retained terminal plan at opportunity ${input.opportunity_index}: expected ${String(admittedPreviousHaccPlanSha256)}, received ${String(currentPlan.previous_plan_sha256)}`,
      );
    }
    currentPlan = assertHaccResponsePlan(currentPlan, {
      previousPlanSha256: admittedPreviousHaccPlanSha256,
    });
    initialResponsePlanSha256 = currentPlan.plan_sha256;
    terminalResponsePlanSha256 = currentPlan.plan_sha256;
    terminalResponseControlSha256 = currentPlan.plan_sha256;
    if (currentPlan.state_sha256 !== initialFlowStateSha256
      || projection.response_control_kind !== "hacc_response_plan"
      || projection.response_plan_sha256 !== currentPlan.plan_sha256
      || canonicalJson(projection.response_plan_body)
        !== canonicalJson(currentPlan)
      || projection.rendered_control_context
        !== renderLc4DevHaccResponsePlan(currentPlan, input.playback_kind)) {
      throw new Error(
        "LC4 HACC model-visible initial response plan differs from signed control authority",
      );
    }
  } else {
    if (expectedPreviousHaccPlanSha256 !== null) {
      throw new Error(
        "LC4 Native treatment cannot claim a prior HACC response plan",
      );
    }
    if (responseControl.kind !== "native_context"
      || typeof responseControl.instructions !== "string"
      || !responseControl.instructions.trim()
      || responseControl.instructions_sha256
        !== sha256Hex(responseControl.instructions)) {
      throw new Error("LC4 Native authority lacks its exact context");
    }
    initialResponsePlanSha256 = responseControl.instructions_sha256 as string;
    terminalResponsePlanSha256 = initialResponsePlanSha256;
    terminalResponseControlSha256 = initialResponsePlanSha256;
    if (projection.response_control_kind !== "native_context"
      || projection.response_plan_sha256 !== null
      || projection.response_plan_body !== null
      || projection.rendered_control_context
        !== appendLc4DevNativeGatewayContract(
          responseControl.instructions as string,
          input.playback_kind,
        )) {
      throw new Error(
        "LC4 Native model-visible context differs from signed control authority",
      );
    }
  }

  if (typeof projection.rendered_control_context !== "string"
    || projection.response_plan_delivery_sha256
      !== sha256Hex(projection.rendered_control_context)) {
    throw new Error(
      "LC4 model-visible response-plan delivery differs from retained authority",
    );
  }

  for (const gatewayAuthority of orderedGatewayAuthorities(
    projection.dev_gateway_receipt_set,
  )) {
    if (gatewayAuthority.post_transition_response_control === null) continue;
    const reboundControl = record(
      gatewayAuthority.post_transition_response_control,
      "LC4 post-transition response control",
    );
    const reboundControlSha256 = sha256Hex(canonicalJson(reboundControl));
    if (gatewayAuthority.post_transition_response_control_sha256
      !== reboundControlSha256) {
      throw new Error(
        "LC4 terminal response control differs from its gateway authority",
      );
    }
    if (input.arm === "hacc") {
      if (currentPlan === null
        || reboundControl.kind !== "hacc_response_plan") {
        throw new Error("LC4 HACC gateway rebound lacks a response plan");
      }
      const reboundPlan = assertHaccResponsePlan(
        gatewayAuthority.post_transition_response_plan,
        { previousPlanSha256: currentPlan.plan_sha256 },
      );
      if (canonicalJson(reboundControl.plan) !== canonicalJson(reboundPlan)
        || reboundControl.transition_binding_sha256 === undefined
        || !SHA256.test(String(reboundControl.transition_binding_sha256))
        || gatewayAuthority.post_transition_response_plan_sha256
          !== reboundPlan.plan_sha256) {
        throw new Error(
          "LC4 HACC gateway rebound differs from its exact chained response plan",
        );
      }
      currentPlan = reboundPlan;
      terminalResponsePlanSha256 = reboundPlan.plan_sha256;
      terminalFlowStateSha256 = reboundPlan.state_sha256;
    } else {
      if (reboundControl.kind !== "native_context"
        || typeof reboundControl.instructions !== "string"
        || reboundControl.instructions_sha256
          !== sha256Hex(reboundControl.instructions)
        || gatewayAuthority.post_transition_response_plan !== null
        || gatewayAuthority.post_transition_response_plan_sha256
          !== reboundControl.instructions_sha256) {
        throw new Error(
          "LC4 Native gateway rebound differs from its exact authority context",
        );
      }
      terminalResponsePlanSha256 = reboundControl.instructions_sha256 as string;
    }
    terminalResponseControlSha256 = reboundControlSha256;
  }

  if (projection.terminal_response_plan_sha256
      !== terminalResponsePlanSha256
    || projection.terminal_response_control_sha256
      !== terminalResponseControlSha256) {
    throw new Error(
      "LC4 provider exchange terminal response control differs from its derived authority chain",
    );
  }
  return Object.freeze({
    control_receipt_sha256: input.control_receipt_sha256,
    previous_provider_exchange_sha256: expectedPreviousExchangeSha256,
    previous_hacc_response_plan_sha256:
      admittedPreviousHaccPlanSha256,
    initial_response_plan_sha256: initialResponsePlanSha256,
    terminal_response_plan_sha256: terminalResponsePlanSha256,
    terminal_response_control_sha256: terminalResponseControlSha256,
    initial_flow_state_sha256: initialFlowStateSha256,
    terminal_flow_state_sha256: terminalFlowStateSha256,
    tool_frontier_sha256: expectedToolFrontierSha256,
    repair_decision_receipt_sha256:
      input.repair_decision_receipt_sha256,
    canonical_provider_exchange_sha256:
      input.canonical_provider_exchange_sha256,
  });
}

export function lc4DevResponsePlanChainGenesis(
  preflightSha256: string,
  episodeId: string,
): string {
  hash(preflightSha256, "LC4 response-plan chain preflight");
  if (!episodeId) throw new Error("LC4 response-plan chain episode is empty");
  return sha256Hex(
    `lc4-dev-plan-genesis\n${preflightSha256}\n${episodeId}`,
  );
}

export function advanceLc4DevResponsePlanChain(input: Readonly<{
  previous_chain_head_sha256: string;
  playback_kind: "canonical" | "repair";
  control_receipt_sha256: string;
  initial_response_plan_sha256: string;
  provider_exchange_sha256: string;
  terminal_response_plan_sha256: string;
  terminal_response_control_sha256: string;
}>): string {
  const previous = hash(
    input.previous_chain_head_sha256,
    "LC4 previous response-plan chain head",
  );
  for (const [label, digest] of [
    ["control receipt", input.control_receipt_sha256],
    ["initial response plan", input.initial_response_plan_sha256],
    ["provider exchange", input.provider_exchange_sha256],
    ["terminal response plan", input.terminal_response_plan_sha256],
    ["terminal response control", input.terminal_response_control_sha256],
  ] as const) hash(digest, `LC4 response-plan chain ${label}`);
  if (input.playback_kind === "repair") return previous;
  const afterControl = sha256Hex(
    `${LC4_DEV_RESPONSE_PLAN_CHAIN_DOMAIN}${canonicalJson({
      previous,
      control_receipt_sha256: input.control_receipt_sha256,
      response_plan_sha256: input.initial_response_plan_sha256,
    })}`,
  );
  return sha256Hex(
    `${LC4_DEV_RESPONSE_PLAN_CHAIN_DOMAIN}${canonicalJson({
      previous: afterControl,
      provider_exchange_sha256: input.provider_exchange_sha256,
      terminal_response_plan_sha256: input.terminal_response_plan_sha256,
      terminal_response_control_sha256:
        input.terminal_response_control_sha256,
    })}`,
  );
}

/** Exact boundary check used before a HACC provider session is hydrated. */
export function assertLc4HaccRotationTreatmentCheckpoint(input: Readonly<{
  packet: JsonValue;
  terminal_flow_state_sha256: string;
  response_plan_chain_head_sha256: string;
}>): void {
  const packet = record(input.packet, "LC4 HACC rotation treatment packet");
  const terminalFlowStateSha256 = hash(
    input.terminal_flow_state_sha256,
    "LC4 HACC rotation terminal flow state",
  );
  const responsePlanChainHeadSha256 = hash(
    input.response_plan_chain_head_sha256,
    "LC4 HACC rotation response-plan chain head",
  );
  if (packet.packet_type
      !== "hacc_provider_conversation_plus_structured_state"
    || packet.flow_state_sha256 !== terminalFlowStateSha256
    || packet.response_plan_chain_head_sha256
      !== responsePlanChainHeadSha256) {
    throw new Error(
      "LC4 HACC rotation state differs from the independently replayed treatment chain",
    );
  }
}
