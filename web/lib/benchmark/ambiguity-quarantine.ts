import { findStep, type AgentFlow } from "../flow";
import { ActionReconciliationSpecSchema } from "../action-reconciliation";
import {
  flowStateSummary,
  hashFlowValue,
  promoteIndeterminateFlowAction,
  settleFlowAction,
  type FlowActionReceipt,
  type FlowExecutionState,
  type RuntimeError,
} from "../flow-runtime";
import type { JsonValue, WorldReceipt } from "./scenario-schema";
import {
  ProviderCapabilitySnapshotSchema,
  type ProviderCapabilitySnapshot,
} from "./capability-gateway";

export type AmbiguityQuarantine = Readonly<{
  schemaVersion: 1;
  status: "reconciliation_required" | "released";
  flowReceiptId: string;
  worldReceiptId: string;
  step: string;
  action: string;
  designatedReconciliationActions: readonly string[];
  authoritativeResult: JsonValue;
  authoritativeResultSha256: string;
  flowReceiptEvidenceSha256: string;
  worldReceiptEvidenceSha256: string;
  flowStateHeadSha256AtQuarantine: string;
  capabilityEpoch: number;
  createdAt: string;
  evidenceHeadSha256: string;
  reconciliationFlowReceiptId?: string;
  reconciliationWorldReceiptId?: string;
  releaseEvidenceSha256?: string;
  flowStateHeadSha256AtRelease?: string;
  releasedAt?: string;
  quarantineEvidenceHeadSha256?: string;
}>;

export type QuarantineTransition = Readonly<{
  state: FlowExecutionState;
  quarantine: AmbiguityQuarantine;
  replayed: boolean;
}>;

const canonicalIso = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

function fail(error: string, code: string): RuntimeError {
  return { error, code };
}

function worldReceiptHash(receipt: WorldReceipt): string {
  return hashFlowValue(receipt);
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  return hashFlowValue(left) === hashFlowValue(right);
}

/** A host-designated readback must contain every prior outcome field exactly. */
function containsExactPriorResult(readback: JsonValue, prior: JsonValue): boolean {
  if (prior === null || typeof prior !== "object" || Array.isArray(prior)) {
    return exactJsonEqual(readback, prior);
  }
  if (readback === null || typeof readback !== "object" || Array.isArray(readback)) return false;
  return Object.entries(prior).every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(readback, key)
    && containsExactPriorResult(readback[key], value)
  );
}

function exactWorldFlowBinding(flowReceipt: FlowActionReceipt, worldReceipt: WorldReceipt): boolean {
  return flowReceipt.tool === worldReceipt.tool
    && flowReceipt.arguments !== undefined
    && exactJsonEqual(flowReceipt.arguments, worldReceipt.arguments)
    && flowReceipt.argumentsHash === hashFlowValue(worldReceipt.arguments);
}

function evidenceHead(input: Omit<AmbiguityQuarantine, "evidenceHeadSha256">): string {
  return hashFlowValue(input);
}

/** Host-authored output bindings designate readback tools; names are never guessed. */
export function designatedReconciliationActionsForReceipt(
  flow: AgentFlow,
  state: FlowExecutionState,
  flowReceiptId: string,
): readonly string[] {
  const receipt = state.actionReceipts.find((candidate) => candidate.id === flowReceiptId);
  if (!receipt) throw new Error("ambiguous Flow receipt was not found");
  const step = findStep(flow, receipt.step)?.step;
  if (!step) throw new Error("ambiguous Flow receipt is not bound to a configured step");
  const granted = new Set(step.tools ?? []);
  const explicitPolicy = (step.action_policies ?? [])
    .find((policy) => policy.tool === receipt.tool)?.reconciliation;
  const parsedPolicy = ActionReconciliationSpecSchema.safeParse(explicitPolicy);
  if (explicitPolicy !== undefined && !parsedPolicy.success) {
    throw new Error("ambiguous Flow receipt has an invalid explicit reconciliation contract");
  }
  const explicitQueryTool = parsedPolicy.success ? parsedPolicy.data.queryTool : undefined;
  if (explicitQueryTool) {
    if (!granted.has(explicitQueryTool) || explicitQueryTool === receipt.tool) {
      throw new Error("ambiguous Flow receipt has an invalid explicit reconciliation query tool");
    }
    return Object.freeze([explicitQueryTool]);
  }
  return Object.freeze([...new Set((step.output_bindings ?? [])
    .map((binding) => binding.tool)
    .filter((tool) => tool !== receipt.tool && granted.has(tool)))].sort());
}

function quarantineIntegrityError(quarantine: AmbiguityQuarantine): RuntimeError | null {
  const { evidenceHeadSha256, ...body } = quarantine;
  const actions = [...new Set(quarantine.designatedReconciliationActions)].sort();
  const releasedShape = quarantine.status === "released"
    ? Boolean(
      quarantine.reconciliationFlowReceiptId
      && quarantine.reconciliationWorldReceiptId
      && quarantine.releaseEvidenceSha256
      && quarantine.flowStateHeadSha256AtRelease
      && quarantine.releasedAt
      && quarantine.quarantineEvidenceHeadSha256
    )
    : !quarantine.reconciliationFlowReceiptId
      && !quarantine.reconciliationWorldReceiptId
      && !quarantine.releaseEvidenceSha256
      && !quarantine.flowStateHeadSha256AtRelease
      && !quarantine.releasedAt
      && !quarantine.quarantineEvidenceHeadSha256;
  if (
    evidenceHead(body) !== evidenceHeadSha256
    || hashFlowValue(quarantine.authoritativeResult) !== quarantine.authoritativeResultSha256
    || exactJsonEqual(actions, quarantine.designatedReconciliationActions) === false
    || !releasedShape
  ) {
    return fail("ambiguity quarantine evidence is corrupt", "quarantine_evidence_invalid");
  }
  return null;
}

/**
 * Convert an authoritative after-commit timeout into durable no-retry Flow
 * state while retaining the exact ToolWorld outcome as private host evidence.
 * The raw ToolWorld receipt is never rewritten.
 */
export function quarantineCommittedAfterError(input: Readonly<{
  state: FlowExecutionState;
  flowReceiptId: string;
  worldReceipt: WorldReceipt;
  designatedReconciliationActions: readonly string[];
  now: string;
}>): QuarantineTransition | RuntimeError {
  if (!canonicalIso(input.now)) return fail("quarantine time must be canonical ISO-8601", "invalid_quarantine_time");
  const receipt = input.state.actionReceipts.find((candidate) => candidate.id === input.flowReceiptId);
  if (!receipt) return fail("ambiguous Flow receipt was not found", "unknown_receipt");
  const actions = [...new Set(input.designatedReconciliationActions)].sort();
  if (!actions.length || actions.some((action) => !action || action === receipt.tool)) {
    return fail("quarantine requires an explicit distinct reconciliation action", "reconciliation_not_designated");
  }
  if (
    receipt.status !== "reserved"
    || !receipt.dispatchStartedAt
    || input.worldReceipt.status !== "committed_after_error"
    || !input.worldReceipt.committed
    || input.worldReceipt.authoritative_result === undefined
    || !exactWorldFlowBinding(receipt, input.worldReceipt)
  ) {
    return fail("after-commit evidence does not match the dispatched Flow receipt", "ambiguous_evidence_mismatch");
  }
  const settled = settleFlowAction(input.state, {
    receiptId: receipt.id,
    status: "indeterminate",
    error: "authoritative effect committed but its provider-visible outcome requires readback",
  }, input.now);
  if ("error" in settled) return settled;
  const body: Omit<AmbiguityQuarantine, "evidenceHeadSha256"> = Object.freeze({
    schemaVersion: 1,
    status: "reconciliation_required",
    flowReceiptId: receipt.id,
    worldReceiptId: input.worldReceipt.receipt_id,
    step: receipt.step,
    action: receipt.tool,
    designatedReconciliationActions: Object.freeze(actions),
    authoritativeResult: structuredClone(input.worldReceipt.authoritative_result),
    authoritativeResultSha256: hashFlowValue(input.worldReceipt.authoritative_result),
    flowReceiptEvidenceSha256: hashFlowValue(receipt),
    worldReceiptEvidenceSha256: worldReceiptHash(input.worldReceipt),
    flowStateHeadSha256AtQuarantine: hashFlowValue(settled.state),
    capabilityEpoch: receipt.capabilityEpoch,
    createdAt: input.now,
  });
  return Object.freeze({
    state: settled.state,
    quarantine: Object.freeze({ ...body, evidenceHeadSha256: evidenceHead(body) }),
    replayed: false,
  });
}

function validateSuccessfulReadback(input: Readonly<{
  state: FlowExecutionState;
  quarantine: AmbiguityQuarantine;
  reconciliationFlowReceiptId: string;
  reconciliationWorldReceipt: WorldReceipt;
}>): FlowActionReceipt | RuntimeError {
  const flowReceipt = input.state.actionReceipts.find((candidate) =>
    candidate.id === input.reconciliationFlowReceiptId
  );
  const worldReceipt = input.reconciliationWorldReceipt;
  if (!flowReceipt) return fail("reconciliation Flow receipt was not found", "reconciliation_receipt_missing");
  if (
    !input.quarantine.designatedReconciliationActions.includes(flowReceipt.tool)
    || flowReceipt.tool !== worldReceipt.tool
    || flowReceipt.step !== input.quarantine.step
  ) {
    return fail("readback action is not designated for this ambiguity", "reconciliation_not_designated");
  }
  if (
    flowReceipt.status !== "succeeded"
    || flowReceipt.result === undefined
    || flowReceipt.resultHash !== hashFlowValue(flowReceipt.result)
    || !["succeeded", "deduplicated"].includes(worldReceipt.status)
    || worldReceipt.authoritative_result === undefined
    || !exactWorldFlowBinding(flowReceipt, worldReceipt)
    || !exactJsonEqual(flowReceipt.result, worldReceipt.authoritative_result)
  ) {
    return fail("reconciliation did not return successful authoritative evidence", "reconciliation_evidence_invalid");
  }
  if (!containsExactPriorResult(worldReceipt.authoritative_result, input.quarantine.authoritativeResult)) {
    return fail("readback does not contain the exact prior authoritative outcome", "reconciliation_outcome_mismatch");
  }
  return flowReceipt;
}

/** Promote only the exact prior result; the readback can prove it but cannot replace it. */
export function releaseAmbiguityQuarantine(input: Readonly<{
  state: FlowExecutionState;
  quarantine: AmbiguityQuarantine;
  reconciliationFlowReceiptId: string;
  reconciliationWorldReceipt: WorldReceipt;
  now: string;
}>): QuarantineTransition | RuntimeError {
  if (!canonicalIso(input.now)) return fail("release time must be canonical ISO-8601", "invalid_quarantine_time");
  const corrupt = quarantineIntegrityError(input.quarantine);
  if (corrupt) return corrupt;
  const evidence = validateSuccessfulReadback(input);
  if ("code" in evidence) return evidence;
  const q = input.quarantine;
  if (q.status === "released") {
    const original = input.state.actionReceipts.find((receipt) => receipt.id === q.flowReceiptId);
    if (
      q.reconciliationFlowReceiptId !== input.reconciliationFlowReceiptId
      || q.reconciliationWorldReceiptId !== input.reconciliationWorldReceipt.receipt_id
      || original?.status !== "succeeded"
      || original.reconciliationProofId !== q.reconciliationWorldReceiptId
      || original.result === undefined
      || !exactJsonEqual(original.result, q.authoritativeResult)
    ) {
      return fail("released quarantine replay changed its evidence", "reconciliation_replay_conflict");
    }
    return Object.freeze({ state: input.state, quarantine: q, replayed: true });
  }
  const promoted = promoteIndeterminateFlowAction(input.state, {
    receiptId: q.flowReceiptId,
    proofId: input.reconciliationWorldReceipt.receipt_id,
    result: q.authoritativeResult,
  }, input.now);
  if ("error" in promoted) return promoted;
  const releaseEvidenceSha256 = hashFlowValue({
    quarantineEvidenceHeadSha256: q.evidenceHeadSha256,
    reconciliationFlowReceiptSha256: hashFlowValue(evidence),
    reconciliationWorldReceiptSha256: worldReceiptHash(input.reconciliationWorldReceipt),
    releasedAuthoritativeResultSha256: q.authoritativeResultSha256,
  });
  const { evidenceHeadSha256: quarantineEvidenceHeadSha256, ...quarantineBody } = q;
  const body: Omit<AmbiguityQuarantine, "evidenceHeadSha256"> = {
    ...quarantineBody,
    status: "released",
    reconciliationFlowReceiptId: evidence.id,
    reconciliationWorldReceiptId: input.reconciliationWorldReceipt.receipt_id,
    releaseEvidenceSha256,
    flowStateHeadSha256AtRelease: hashFlowValue(promoted.state),
    releasedAt: input.now,
    quarantineEvidenceHeadSha256,
  };
  return Object.freeze({
    state: promoted.state,
    quarantine: Object.freeze({ ...body, evidenceHeadSha256: evidenceHead(body) }),
    replayed: false,
  });
}

/**
 * Provider projection intentionally omits raw Flow `available_tools`; callers
 * must attach only the separately computed provider-visible frontier.
 */
export function projectQuarantinedFlowState(
  flow: AgentFlow,
  state: FlowExecutionState,
  quarantines: readonly AmbiguityQuarantine[],
  providerVisibleSnapshotInput: ProviderCapabilitySnapshot,
): Readonly<Record<string, unknown>> {
  const byReceipt = new Map(quarantines.map((item) => [item.flowReceiptId, item]));
  if (byReceipt.size !== quarantines.length) throw new Error("duplicate ambiguity quarantine receipt");
  const corrupt = quarantines.find((item) => quarantineIntegrityError(item));
  if (corrupt) throw new Error("ambiguity quarantine evidence is corrupt");
  const summary = flowStateSummary(flow, state);
  const providerVisibleSnapshot = ProviderCapabilitySnapshotSchema.parse(providerVisibleSnapshotInput);
  if (providerVisibleSnapshot.capability_epoch !== state.capabilityEpoch) {
    throw new Error("provider-visible frontier is stale for the projected Flow state");
  }
  const providerVisibleFrontier = Object.freeze({
    gateway_version: providerVisibleSnapshot.gateway_version,
    scope: providerVisibleSnapshot.scope,
    capability_epoch: providerVisibleSnapshot.capability_epoch,
    actions: Object.freeze(providerVisibleSnapshot.actions.map((action) => Object.freeze({
      name: action.name,
      description: action.description,
      input_schema: action.input_schema,
      semantic_hash: action.semantic_hash,
    }))),
  });
  const { available_tools: _rawAvailableTools, ...providerState } = summary;
  void _rawAvailableTools;
  const actionReceipts = summary.action_receipts.map((receipt) => {
    const quarantine = byReceipt.get(receipt.id);
    if (!quarantine) return receipt;
    if (quarantine.status === "reconciliation_required") {
      if (receipt.status !== "indeterminate") throw new Error("active quarantine is not indeterminate in Flow state");
      return {
        ...receipt,
        status: "indeterminate",
        result_hash: undefined,
        reconciliation_required: true,
        retry_authority: false,
      };
    }
    const authoritative = state.actionReceipts.find((candidate) => candidate.id === receipt.id);
    if (
      !authoritative
      || receipt.status !== "succeeded"
      || authoritative.reconciliationProofId !== quarantine.reconciliationWorldReceiptId
      || authoritative.resultHash !== quarantine.authoritativeResultSha256
    ) {
      throw new Error("released quarantine is not bound to its promoted Flow receipt");
    }
    return {
      ...receipt,
      reconciliation_required: false,
      retry_authority: false,
      reconciled_by_receipt_id: quarantine.reconciliationWorldReceiptId,
    };
  });
  const releasedOutcomes = quarantines
    .filter((item) => item.status === "released")
    .map((item) => ({
      receipt_id: item.flowReceiptId,
      status: "succeeded",
      authoritative_result: structuredClone(item.authoritativeResult),
      result_sha256: item.authoritativeResultSha256,
      reconciliation_receipt_id: item.reconciliationWorldReceiptId,
    }));
  return Object.freeze({
    ...providerState,
    action_receipts: actionReceipts,
    provider_visible_frontier: providerVisibleFrontier,
    provider_visible_frontier_sha256: hashFlowValue(providerVisibleFrontier),
    ambiguity_quarantine_head_sha256: hashFlowValue(quarantines.map((item) => item.evidenceHeadSha256)),
    ...(releasedOutcomes.length ? { released_outcomes: releasedOutcomes } : {}),
  });
}
