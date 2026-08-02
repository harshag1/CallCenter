import { z } from "zod";
import {
  canonicalRuntimeControlJson,
  immutableRuntimeControlValue,
  runtimeControlSha256,
} from "./canonical";

export const HACC_TURN_CONTRACT_VERSION = "hacc-production-turn-contract.v1" as const;
export const MAX_TURN_CONTRACT_PAYLOAD_BYTES = 32_768;

const POLICY_DOMAIN = "harshas-amazing-call-center/runtime-control/turn-contract-policy/v1\n";
const CONTRACT_DOMAIN = "harshas-amazing-call-center/runtime-control/turn-contract/v1\n";

const TURN_CONTRACT_POLICY = Object.freeze({
  version: HACC_TURN_CONTRACT_VERSION,
  authority: "host_state_and_effect_gateway_only",
  exposure: "public_identifiers_statuses_and_digests_no_runtime_values",
  freshness: "conversation_flow_mission_and_capability_epoch_bound",
  ambiguity: "designated_reconciliation_only_otherwise_empty_frontier",
  provider_context: "advisory_never_effect_authority",
});

export const HACC_TURN_CONTRACT_POLICY_SHA256 = runtimeControlSha256(
  POLICY_DOMAIN,
  canonicalRuntimeControlJson(TURN_CONTRACT_POLICY),
);

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PublicIdSchema = z.string().min(1).max(128).regex(/^[a-z][a-z0-9._:/-]*$/);
const RevisionSchema = z.number().int().nonnegative().safe();

const ControlPlaneSchema = z.object({
  mode: z.enum(["flow", "mission", "unified"]),
  flow: z.object({
    revision: RevisionSchema,
    capability_epoch: RevisionSchema,
    state_sha256: HashSchema,
  }).strict().nullable(),
  mission: z.object({
    revision: RevisionSchema,
    capability_epoch: RevisionSchema,
    state_sha256: HashSchema,
  }).strict().nullable(),
}).strict().superRefine((control, ctx) => {
  const valid = control.mode === "flow"
    ? control.flow !== null && control.mission === null
    : control.mode === "mission"
      ? control.flow === null && control.mission !== null
      : control.flow !== null && control.mission !== null;
  if (!valid) ctx.addIssue({ code: "custom", message: "control-plane mode is ambiguous" });
});

const ReceiptSchema = z.object({
  receipt_id: PublicIdSchema,
  action_id: PublicIdSchema,
  action_semantic_sha256: HashSchema,
  capability_epoch: RevisionSchema,
  status: z.enum(["reserved", "succeeded", "failed", "indeterminate", "compensated"]),
  settled_revision: RevisionSchema.nullable(),
  receipt_sha256: HashSchema,
}).strict().superRefine((receipt, ctx) => {
  if ((receipt.status === "reserved") === (receipt.settled_revision !== null)) {
    ctx.addIssue({ code: "custom", message: "receipt status and settlement revision disagree" });
  }
});

const WorkerSchema = z.object({
  worker_id: PublicIdSchema,
  goal_id: PublicIdSchema,
  generation: z.number().int().positive().safe(),
  status: z.enum(["pending", "running", "cancel_requested", "succeeded", "failed", "cancelled", "indeterminate"]),
  authority_revision: RevisionSchema,
  capability_epoch: RevisionSchema,
  authority_sha256: HashSchema,
}).strict();

const SlotSchema = z.object({
  slot_id: PublicIdSchema,
  status: z.enum(["present", "missing"]),
}).strict();

const ActionSchema = z.object({
  action_id: PublicIdSchema,
  effect: z.enum(["read", "write", "opaque"]),
  purpose: z.enum(["operation", "reconciliation"]),
  policy_sha256: HashSchema,
  semantic_sha256: HashSchema,
}).strict().superRefine((action, ctx) => {
  if (action.purpose === "reconciliation" && action.effect !== "read") {
    ctx.addIssue({ code: "custom", message: "reconciliation actions must be read-only" });
  }
});

const AllowedClaimSchema = z.object({
  claim_id: PublicIdSchema,
  claim_class: z.enum(["progress", "clarification", "handoff", "effect_success", "terminal_success"]),
  supporting_receipt_id: PublicIdSchema.nullable(),
  supporting_action_id: PublicIdSchema.nullable(),
  claim_semantic_sha256: HashSchema,
}).strict();

const ProhibitedClaimSchema = z.object({
  claim_id: PublicIdSchema,
  claim_class: z.enum(["private_value", "effect_success", "terminal_success", "ambiguous_retry", "unsupported"]),
  reason_code: PublicIdSchema,
}).strict();

const AmbiguitySchema = z.object({
  ambiguity_id: PublicIdSchema,
  reason_code: PublicIdSchema,
  receipt_id: PublicIdSchema.nullable(),
  designated_reconciliation_actions: z.array(PublicIdSchema).max(32),
}).strict();

export const TurnContractSourceSchema = z.object({
  conversation: z.object({
    conversation_id: PublicIdSchema,
    revision: RevisionSchema,
    head_sha256: HashSchema,
  }).strict(),
  public_identifier_registry_sha256: HashSchema,
  control_plane: ControlPlaneSchema,
  capability_epoch: RevisionSchema,
  frontier: z.object({
    eligible_intents: z.array(PublicIdSchema).max(256),
    eligible_actions: z.array(ActionSchema).max(1_024),
  }).strict(),
  required_slots: z.array(SlotSchema).max(256),
  claims: z.object({
    allowed: z.array(AllowedClaimSchema).max(256),
    prohibited: z.array(ProhibitedClaimSchema).max(252),
  }).strict(),
  receipts: z.array(ReceiptSchema).max(1_024),
  workers: z.array(WorkerSchema).max(256),
  ambiguities: z.array(AmbiguitySchema).max(64),
  lifecycle: z.object({
    status: z.enum(["routing", "active", "completed", "failed"]),
    refresh_required: z.boolean(),
    preferred_response_mode: z.enum(["route", "clarify", "act", "await_worker", "terminal"]),
  }).strict(),
}).strict();

export type TurnContractSource = z.infer<typeof TurnContractSourceSchema>;

export const TurnContractFreshnessSchema = z.object({
  conversation_id: PublicIdSchema,
  conversation_revision: RevisionSchema,
  conversation_head_sha256: HashSchema,
  flow_revision: RevisionSchema.nullable(),
  flow_state_sha256: HashSchema.nullable(),
  mission_revision: RevisionSchema.nullable(),
  mission_state_sha256: HashSchema.nullable(),
  capability_epoch: RevisionSchema,
  public_identifier_registry_sha256: HashSchema,
}).strict();

export type TurnContractFreshness = z.infer<typeof TurnContractFreshnessSchema>;

export const TurnContractAssertionExpectationSchema = TurnContractFreshnessSchema.extend({
  expected_contract_sha256: HashSchema,
}).strict();
export type TurnContractAssertionExpectation = z.infer<typeof TurnContractAssertionExpectationSchema>;

const TurnContractPayloadSchema = z.object({
  schema_version: z.literal(1),
  contract_type: z.literal(HACC_TURN_CONTRACT_VERSION),
  policy_sha256: z.literal(HACC_TURN_CONTRACT_POLICY_SHA256),
  conversation: TurnContractSourceSchema.shape.conversation,
  public_identifier_registry_sha256: HashSchema,
  control_plane: ControlPlaneSchema,
  capability_epoch: RevisionSchema,
  eligible_intents: z.array(PublicIdSchema).max(256),
  eligible_actions: z.array(ActionSchema).max(1_024),
  required_slots: z.array(SlotSchema).max(256),
  allowed_claims: z.array(AllowedClaimSchema).max(256),
  prohibited_claims: z.array(ProhibitedClaimSchema).max(256),
  receipts: z.array(ReceiptSchema).max(1_024),
  workers: z.array(WorkerSchema).max(256),
  ambiguities: z.array(AmbiguitySchema).max(64),
  lifecycle: TurnContractSourceSchema.shape.lifecycle,
  response_mode: z.enum(["route", "clarify", "act", "reconcile", "await_worker", "recover", "terminal", "fail_closed"]),
  enforcement: z.literal("host_gateway_and_speech_release_gate"),
  canonical_payload_encoding: z.literal("utf8_canonical_json"),
}).strict();

export const ProductionTurnContractSchema = TurnContractPayloadSchema.extend({
  canonical_payload_byte_length: z.number().int().positive().max(MAX_TURN_CONTRACT_PAYLOAD_BYTES),
  contract_sha256: HashSchema,
}).strict();

export type ProductionTurnContract = z.infer<typeof ProductionTurnContractSchema>;

export class TurnContractError extends Error {
  constructor(
    readonly code: "turn_contract_invalid" | "turn_contract_stale" | "turn_contract_ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "TurnContractError";
  }
}

function sortedUniqueIds(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort(compareIds);
  if (new Set(sorted).size !== sorted.length) {
    throw new TurnContractError("turn_contract_ambiguous", `${label} contain duplicate identities`);
  }
  return sorted;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueBy<T>(values: readonly T[], identity: (value: T) => string, label: string): T[] {
  const sorted = [...values].sort((left, right) => compareIds(identity(left), identity(right)));
  const ids = sorted.map(identity);
  if (new Set(ids).size !== ids.length) {
    throw new TurnContractError("turn_contract_ambiguous", `${label} contain duplicate identities`);
  }
  return sorted;
}

function actualFreshness(source: TurnContractSource): TurnContractFreshness {
  return {
    conversation_id: source.conversation.conversation_id,
    conversation_revision: source.conversation.revision,
    conversation_head_sha256: source.conversation.head_sha256,
    flow_revision: source.control_plane.flow?.revision ?? null,
    flow_state_sha256: source.control_plane.flow?.state_sha256 ?? null,
    mission_revision: source.control_plane.mission?.revision ?? null,
    mission_state_sha256: source.control_plane.mission?.state_sha256 ?? null,
    capability_epoch: source.capability_epoch,
    public_identifier_registry_sha256: source.public_identifier_registry_sha256,
  };
}

function assertFreshness(source: TurnContractSource, expectedInput: unknown): void {
  try {
    canonicalRuntimeControlJson(expectedInput);
  } catch {
    throw new TurnContractError("turn_contract_invalid", "turn contract expected freshness is not inert JSON");
  }
  const expectedResult = TurnContractFreshnessSchema.safeParse(expectedInput);
  if (!expectedResult.success) {
    throw new TurnContractError("turn_contract_invalid", "turn contract expected freshness is invalid");
  }
  const expected = expectedResult.data;
  const actual = actualFreshness(source);
  if (canonicalRuntimeControlJson(actual) !== canonicalRuntimeControlJson(expected)) {
    throw new TurnContractError("turn_contract_stale", "turn contract authority snapshot is stale");
  }
  const planeEpochs = [source.control_plane.flow?.capability_epoch, source.control_plane.mission?.capability_epoch]
    .filter((epoch): epoch is number => epoch !== undefined);
  if (planeEpochs.some((epoch) => epoch !== source.capability_epoch)) {
    throw new TurnContractError("turn_contract_stale", "turn contract capability epochs disagree");
  }
}

function responseMode(source: TurnContractSource, actions: readonly z.infer<typeof ActionSchema>[]): ProductionTurnContract["response_mode"] {
  if (source.lifecycle.refresh_required) return "recover";
  if (source.ambiguities.length > 0) return actions.length > 0 ? "reconcile" : "fail_closed";
  if (source.lifecycle.status === "completed" || source.lifecycle.status === "failed") return "terminal";
  if (source.lifecycle.preferred_response_mode === "await_worker") return "await_worker";
  return source.lifecycle.preferred_response_mode;
}

function normalizeSource(sourceInput: unknown): TurnContractSource {
  try {
    canonicalRuntimeControlJson(sourceInput);
  } catch {
    throw new TurnContractError("turn_contract_invalid", "turn contract source is not inert JSON");
  }
  const parsed = TurnContractSourceSchema.safeParse(sourceInput);
  if (!parsed.success) {
    throw new TurnContractError("turn_contract_invalid", `turn contract source is invalid: ${parsed.error.message}`);
  }
  const source = parsed.data;
  return {
    ...source,
    frontier: {
      eligible_intents: sortedUniqueIds(source.frontier.eligible_intents, "eligible intents"),
      eligible_actions: sortedUniqueBy(source.frontier.eligible_actions, (action) => action.action_id, "eligible actions"),
    },
    required_slots: sortedUniqueBy(source.required_slots, (slot) => slot.slot_id, "required slots"),
    claims: {
      allowed: sortedUniqueBy(source.claims.allowed, (claim) => claim.claim_id, "allowed claims"),
      prohibited: sortedUniqueBy(source.claims.prohibited, (claim) => claim.claim_id, "prohibited claims"),
    },
    receipts: sortedUniqueBy(source.receipts, (receipt) => receipt.receipt_id, "receipts"),
    workers: sortedUniqueBy(source.workers, (worker) => worker.worker_id, "workers"),
    ambiguities: sortedUniqueBy(source.ambiguities, (ambiguity) => ambiguity.ambiguity_id, "ambiguities")
      .map((ambiguity) => ({
        ...ambiguity,
        designated_reconciliation_actions: sortedUniqueIds(
          ambiguity.designated_reconciliation_actions,
          `ambiguity ${ambiguity.ambiguity_id} designated actions`,
        ),
      })),
  };
}

function validateSemantics(source: TurnContractSource): void {
  const actionById = new Map(source.frontier.eligible_actions.map((action) => [action.action_id, action]));
  const receiptById = new Map(source.receipts.map((receipt) => [receipt.receipt_id, receipt]));
  const prohibitedIds = new Set(source.claims.prohibited.map((claim) => claim.claim_id));
  for (const claim of source.claims.allowed) {
    if (prohibitedIds.has(claim.claim_id)) {
      throw new TurnContractError("turn_contract_ambiguous", "a claim cannot be both allowed and prohibited");
    }
    if (claim.claim_class === "effect_success" || claim.claim_class === "terminal_success") {
      const receipt = claim.supporting_receipt_id ? receiptById.get(claim.supporting_receipt_id) : undefined;
      if (!receipt || receipt.status !== "succeeded") {
        throw new TurnContractError("turn_contract_ambiguous", "success claims require an authoritative settled receipt");
      }
      if (claim.supporting_action_id === null || receipt.action_id !== claim.supporting_action_id) {
        throw new TurnContractError("turn_contract_ambiguous", "success claim receipt belongs to a different action");
      }
      if (receipt.capability_epoch !== source.capability_epoch) {
        throw new TurnContractError("turn_contract_stale", "success claim receipt belongs to a stale capability epoch");
      }
      if (claim.claim_class === "terminal_success" && source.lifecycle.status !== "completed") {
        throw new TurnContractError("turn_contract_ambiguous", "terminal success claim requires a completed lifecycle");
      }
    } else if (claim.supporting_receipt_id !== null || claim.supporting_action_id !== null) {
      throw new TurnContractError("turn_contract_ambiguous", "non-success claims cannot cite an effect receipt or action");
    }
  }
  const ambiguityReceiptIds = new Set(source.ambiguities.flatMap((ambiguity) => ambiguity.receipt_id ?? []));
  for (const receipt of source.receipts) {
    if (receipt.settled_revision !== null && receipt.settled_revision > source.conversation.revision) {
      throw new TurnContractError("turn_contract_stale", "receipt settlement is newer than the conversation head");
    }
    if (receipt.status === "indeterminate" && !ambiguityReceiptIds.has(receipt.receipt_id)) {
      throw new TurnContractError("turn_contract_ambiguous", "indeterminate receipt lacks an ambiguity quarantine");
    }
  }
  if (source.workers.some((worker) => worker.authority_revision > source.conversation.revision
      || worker.capability_epoch !== source.capability_epoch)) {
    throw new TurnContractError("turn_contract_stale", "worker authority is newer than the conversation head");
  }
  for (const ambiguity of source.ambiguities) {
    if (ambiguity.receipt_id !== null && receiptById.get(ambiguity.receipt_id)?.status !== "indeterminate") {
      throw new TurnContractError("turn_contract_ambiguous", "ambiguity quarantine does not bind an indeterminate receipt");
    }
    for (const action of ambiguity.designated_reconciliation_actions) {
      const repairAction = actionById.get(action);
      if (!repairAction) {
        throw new TurnContractError("turn_contract_ambiguous", "designated reconciliation action is outside the capability frontier");
      }
      if (repairAction.purpose !== "reconciliation" || repairAction.effect !== "read") {
        throw new TurnContractError("turn_contract_ambiguous", "designated reconciliation action is not a read-only repair capability");
      }
    }
  }
  const terminal = source.lifecycle.status === "completed" || source.lifecycle.status === "failed";
  if (terminal !== (source.lifecycle.preferred_response_mode === "terminal")) {
    throw new TurnContractError("turn_contract_ambiguous", "lifecycle status and preferred response mode disagree");
  }
  if (terminal && (source.ambiguities.length > 0
      || source.receipts.some((receipt) => receipt.status === "reserved" || receipt.status === "indeterminate")
      || source.workers.some((worker) => ["pending", "running", "cancel_requested", "indeterminate"].includes(worker.status)))) {
    throw new TurnContractError("turn_contract_ambiguous", "terminal state retains unresolved effects or workers");
  }
  if (source.lifecycle.preferred_response_mode === "await_worker"
      && !source.workers.some((worker) => ["pending", "running", "cancel_requested"].includes(worker.status))) {
    throw new TurnContractError("turn_contract_ambiguous", "await-worker response mode has no active worker");
  }
}

function systemProhibitedClaims(source: TurnContractSource): z.infer<typeof ProhibitedClaimSchema>[] {
  const claims: z.infer<typeof ProhibitedClaimSchema>[] = [{
    claim_id: "system.private_value.repeat",
    claim_class: "private_value",
    reason_code: "runtime_values_are_not_provider_context",
  }];
  if (source.ambiguities.length > 0) {
    claims.push(
      {
        claim_id: "system.ambiguous_effect.retry",
        claim_class: "ambiguous_retry",
        reason_code: "reconcile_before_any_mutation",
      },
      {
        claim_id: "system.terminal_success.pending_reconciliation",
        claim_class: "terminal_success",
        reason_code: "effect_outcome_is_indeterminate",
      },
    );
  }
  if (source.lifecycle.refresh_required) {
    claims.push({
      claim_id: "system.effect_success.stale_authority",
      claim_class: "effect_success",
      reason_code: "refresh_authority_before_claim",
    });
  }
  return claims;
}

function payloadFromSource(source: TurnContractSource): z.infer<typeof TurnContractPayloadSchema> {
  let intents = source.frontier.eligible_intents;
  let actions = source.frontier.eligible_actions;
  let allowedClaims = source.claims.allowed;
  if (source.lifecycle.refresh_required) {
    intents = [];
    actions = [];
    allowedClaims = allowedClaims.filter((claim) => claim.claim_class === "clarification" || claim.claim_class === "handoff");
  } else if (source.ambiguities.length > 0) {
    intents = [];
    const designated = new Set(source.ambiguities.flatMap((ambiguity) => ambiguity.designated_reconciliation_actions));
    actions = actions.filter((action) => designated.has(action.action_id));
    allowedClaims = allowedClaims.filter((claim) => claim.claim_class === "clarification" || claim.claim_class === "handoff");
  } else if (source.lifecycle.status === "completed" || source.lifecycle.status === "failed") {
    intents = [];
    actions = [];
    allowedClaims = allowedClaims.filter((claim) => claim.claim_class === "terminal_success");
  }
  const prohibitedClaims = sortedUniqueBy(
    [...source.claims.prohibited, ...systemProhibitedClaims(source)],
    (claim) => claim.claim_id,
    "effective prohibited claims",
  );
  const prohibitedClaimIds = new Set(prohibitedClaims.map((claim) => claim.claim_id));
  if (allowedClaims.some((claim) => prohibitedClaimIds.has(claim.claim_id))) {
    throw new TurnContractError("turn_contract_ambiguous", "an allowed claim conflicts with a system prohibition");
  }
  return {
    schema_version: 1,
    contract_type: HACC_TURN_CONTRACT_VERSION,
    policy_sha256: HACC_TURN_CONTRACT_POLICY_SHA256,
    conversation: source.conversation,
    public_identifier_registry_sha256: source.public_identifier_registry_sha256,
    control_plane: source.control_plane,
    capability_epoch: source.capability_epoch,
    eligible_intents: intents,
    eligible_actions: actions,
    required_slots: source.required_slots,
    allowed_claims: allowedClaims,
    prohibited_claims: prohibitedClaims,
    receipts: source.receipts,
    workers: source.workers,
    ambiguities: source.ambiguities,
    lifecycle: source.lifecycle,
    response_mode: responseMode(source, actions),
    enforcement: "host_gateway_and_speech_release_gate",
    canonical_payload_encoding: "utf8_canonical_json",
  };
}

export function turnContractCanonicalPayloadBytes(contractInput: unknown): Uint8Array {
  const contract = ProductionTurnContractSchema.parse(contractInput);
  const payload: z.infer<typeof TurnContractPayloadSchema> = {
    schema_version: contract.schema_version,
    contract_type: contract.contract_type,
    policy_sha256: contract.policy_sha256,
    conversation: contract.conversation,
    public_identifier_registry_sha256: contract.public_identifier_registry_sha256,
    control_plane: contract.control_plane,
    capability_epoch: contract.capability_epoch,
    eligible_intents: contract.eligible_intents,
    eligible_actions: contract.eligible_actions,
    required_slots: contract.required_slots,
    allowed_claims: contract.allowed_claims,
    prohibited_claims: contract.prohibited_claims,
    receipts: contract.receipts,
    workers: contract.workers,
    ambiguities: contract.ambiguities,
    lifecycle: contract.lifecycle,
    response_mode: contract.response_mode,
    enforcement: contract.enforcement,
    canonical_payload_encoding: contract.canonical_payload_encoding,
  };
  return Buffer.from(canonicalRuntimeControlJson(payload), "utf8");
}

export function createProductionTurnContract(
  sourceInput: unknown,
  expectedFreshness: unknown,
): ProductionTurnContract {
  const source = normalizeSource(sourceInput);
  assertFreshness(source, expectedFreshness);
  validateSemantics(source);
  const payload = TurnContractPayloadSchema.parse(payloadFromSource(source));
  const canonicalBytes = Buffer.from(canonicalRuntimeControlJson(payload), "utf8");
  if (canonicalBytes.byteLength > MAX_TURN_CONTRACT_PAYLOAD_BYTES) {
    throw new TurnContractError("turn_contract_invalid", `turn contract exceeds ${MAX_TURN_CONTRACT_PAYLOAD_BYTES} canonical bytes`);
  }
  return immutableRuntimeControlValue({
    ...payload,
    canonical_payload_byte_length: canonicalBytes.byteLength,
    contract_sha256: runtimeControlSha256(CONTRACT_DOMAIN, canonicalBytes),
  });
}

export function assertProductionTurnContract(
  contractInput: unknown,
  expectationInput: unknown,
): ProductionTurnContract {
  try {
    canonicalRuntimeControlJson(contractInput);
  } catch {
    throw new TurnContractError("turn_contract_invalid", "turn contract is not inert JSON");
  }
  const parsed = ProductionTurnContractSchema.safeParse(contractInput);
  if (!parsed.success) {
    throw new TurnContractError("turn_contract_invalid", `turn contract is invalid: ${parsed.error.message}`);
  }
  const contract = parsed.data;
  const expectation = TurnContractAssertionExpectationSchema.safeParse(expectationInput);
  if (!expectation.success) {
    throw new TurnContractError("turn_contract_invalid", "turn contract assertion expectation is invalid");
  }
  const bytes = turnContractCanonicalPayloadBytes(contract);
  if (bytes.byteLength !== contract.canonical_payload_byte_length) {
    throw new TurnContractError("turn_contract_invalid", "turn contract canonical byte length mismatch");
  }
  if (runtimeControlSha256(CONTRACT_DOMAIN, bytes) !== contract.contract_sha256) {
    throw new TurnContractError("turn_contract_invalid", "turn contract hash mismatch");
  }
  if (contract.contract_sha256 !== expectation.data.expected_contract_sha256) {
    throw new TurnContractError("turn_contract_stale", "turn contract differs from the host-retained commitment");
  }
  const source: TurnContractSource = {
    conversation: contract.conversation,
    public_identifier_registry_sha256: contract.public_identifier_registry_sha256,
    control_plane: contract.control_plane,
    capability_epoch: contract.capability_epoch,
    frontier: { eligible_intents: contract.eligible_intents, eligible_actions: contract.eligible_actions },
    required_slots: contract.required_slots,
    claims: { allowed: contract.allowed_claims, prohibited: contract.prohibited_claims },
    receipts: contract.receipts,
    workers: contract.workers,
    ambiguities: contract.ambiguities,
    lifecycle: contract.lifecycle,
  };
  const normalized = normalizeSource(source);
  if (canonicalRuntimeControlJson(source) !== canonicalRuntimeControlJson(normalized)) {
    throw new TurnContractError("turn_contract_invalid", "turn contract collections are not canonical sorted sets");
  }
  validateSemantics(source);
  const expectedMode = responseMode(source, contract.eligible_actions);
  if (contract.response_mode !== expectedMode) {
    throw new TurnContractError("turn_contract_invalid", "turn contract response mode disagrees with bound state");
  }
  const expectedFreshness: TurnContractFreshness = {
    conversation_id: expectation.data.conversation_id,
    conversation_revision: expectation.data.conversation_revision,
    conversation_head_sha256: expectation.data.conversation_head_sha256,
    flow_revision: expectation.data.flow_revision,
    flow_state_sha256: expectation.data.flow_state_sha256,
    mission_revision: expectation.data.mission_revision,
    mission_state_sha256: expectation.data.mission_state_sha256,
    capability_epoch: expectation.data.capability_epoch,
    public_identifier_registry_sha256: expectation.data.public_identifier_registry_sha256,
  };
  assertFreshness(source, expectedFreshness);
  return immutableRuntimeControlValue(contract);
}
