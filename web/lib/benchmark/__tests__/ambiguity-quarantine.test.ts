import { describe, expect, it } from "vitest";
import { AgentFlowSchema } from "../../flow";
import {
  deriveFlowActionInvocationId,
  enterFlowStep,
  markFlowActionDispatchStarted,
  reserveFlowAction,
  selectFlowTopic,
  settleFlowAction,
  type FlowExecutionState,
} from "../../flow-runtime";
import type { JsonValue, WorldReceipt } from "../scenario-schema";
import { ProviderCapabilitySnapshotSchema } from "../capability-gateway";
import {
  designatedReconciliationActionsForReceipt,
  projectQuarantinedFlowState,
  quarantineCommittedAfterError,
  releaseAmbiguityQuarantine,
  resolveAmbiguityInvocationArguments,
} from "../ambiguity-quarantine";

const reconciliation = {
  queryTool: "read_order_status",
  queryArguments: { invocation_id: { source: "invocation_id" as const } },
  committedWhen: [
    { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
    { resultPath: "terminal", equals: { source: "literal" as const, value: "committed" } },
  ],
  absentWhen: [
    { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
    { resultPath: "terminal", equals: { source: "literal" as const, value: "absent" } },
  ],
  authoritativeResultPath: "result",
  maxProofAttempts: 2,
};

const flow = AgentFlowSchema.parse({
  schema_version: 2,
  always_tools: [],
  nodes: [
    { id: "entry", label: "Incoming", kind: "incoming_call" },
    {
      id: "orders",
      label: "Orders",
      kind: "topic",
      steps: [{
        id: "commit_and_reconcile",
        label: "Commit and reconcile",
        instructions: "Commit once, then reconcile any ambiguous response.",
        entry: true,
        tools: ["commit_order", "read_order_status"],
        output_bindings: [
          { output: "receipt", tool: "read_order_status", result_path: "receipt", value_type: "string" },
        ],
        action_policies: [
          { tool: "commit_order", max_calls: 1, idempotency: "per_call_arguments", reconciliation },
          { tool: "read_order_status", max_calls: 3, idempotency: "per_call_arguments" },
        ],
      }],
    },
  ],
  edges: [{ from: "entry", to: "orders" }],
});

function activeState(): FlowExecutionState {
  const selected = selectFlowTopic(flow, {
    version: 2,
    status: "routing",
    nodeId: null,
    currentStep: null,
    completedSteps: [],
    stepEntries: 0,
    attempts: {},
    outputs: {},
    checkpoints: [],
    capabilityEpoch: 0,
    actionReceipts: [],
    revision: 0,
    updatedAt: "2026-07-21T12:00:00.000Z",
  }, "orders", "2026-07-21T12:00:01.000Z");
  if ("error" in selected) throw new Error(selected.error);
  const entered = enterFlowStep(flow, selected, "orders.commit_and_reconcile", "2026-07-21T12:00:02.000Z");
  if ("error" in entered) throw new Error(entered.error);
  return entered.state;
}

function reserveAndDispatch(
  state: FlowExecutionState,
  receiptId: string,
  tool: string,
  args: Record<string, JsonValue>,
  at: string,
) {
  const reserved = reserveFlowAction(flow, state, {
    receiptId,
    invocationId: deriveFlowActionInvocationId(receiptId),
    tool,
    arguments: args,
    capabilityEpoch: state.capabilityEpoch,
  }, at);
  if ("error" in reserved) throw new Error(reserved.error);
  const dispatched = markFlowActionDispatchStarted(reserved.state, { receiptId }, at);
  if ("error" in dispatched) throw new Error(dispatched.error);
  return dispatched.state;
}

function worldReceipt(input: Partial<WorldReceipt> & Pick<WorldReceipt, "receipt_id" | "tool" | "arguments" | "status" | "committed">): WorldReceipt {
  return {
    invocation_id: input.receipt_id.replace(/[^a-z0-9_.-]/g, ".").toLowerCase(),
    attempt: 1,
    turn: 12,
    semantic_key: `${input.tool}:order-7`,
    prerequisite_evidence: [],
    effect_ids: input.committed ? [`${input.receipt_id}:effect:1`] : [],
    visible_result: input.status === "committed_after_error" || input.status === "failed_before_commit"
      ? { ok: false, error: { code: "transport_timeout", message: "response unavailable", retriable: false } }
      : { ok: true, data: input.authoritative_result ?? null },
    tainted_result_paths: [],
    ...input,
  };
}

function quarantinedFixture(designatedReconciliationActions?: readonly string[]) {
  const arguments_ = { order_id: "order-7" };
  const flowReceiptId = "flow-commit-1";
  const state = reserveAndDispatch(
    activeState(), flowReceiptId, "commit_order", arguments_, "2026-07-21T12:00:03.000Z"
  );
  const rawWorldReceipt = worldReceipt({
    receipt_id: "world-commit-1",
    tool: "commit_order",
    arguments: arguments_,
    status: "committed_after_error",
    committed: true,
    authoritative_result: { receipt: "ORDER-RCPT-7" },
  });
  const transition = quarantineCommittedAfterError({
    state,
    flowReceiptId,
    worldReceipt: rawWorldReceipt,
    designatedReconciliationActions: designatedReconciliationActions
      ?? designatedReconciliationActionsForReceipt(flow, state, flowReceiptId),
    now: "2026-07-21T12:00:04.000Z",
  });
  if ("error" in transition) throw new Error(transition.error);
  return { ...transition, flowReceiptId, arguments_, rawWorldReceipt };
}

function successfulReadback(state: FlowExecutionState) {
  const receiptId = "flow-readback-1";
  const arguments_ = { order_id: "order-7" };
  const dispatched = reserveAndDispatch(
    state, receiptId, "read_order_status", arguments_, "2026-07-21T12:00:05.000Z"
  );
  const result = { status: "booked", receipt: "ORDER-RCPT-7" };
  const settled = settleFlowAction(dispatched, {
    receiptId,
    status: "succeeded",
    result,
  }, "2026-07-21T12:00:06.000Z");
  if ("error" in settled) throw new Error(settled.error);
  return {
    state: settled.state,
    flowReceiptId: receiptId,
    worldReceipt: worldReceipt({
      receipt_id: "world-readback-1",
      tool: "read_order_status",
      arguments: arguments_,
      status: "succeeded",
      committed: true,
      authoritative_result: result,
    }),
  };
}

function visibleSnapshot(state: FlowExecutionState) {
  return ProviderCapabilitySnapshotSchema.parse({
    gateway_version: 1,
    scope: "step:orders.commit_and_reconcile",
    capability_epoch: state.capabilityEpoch,
    actions: [{
      name: "flow.get_state",
      description: "Recover the exact provider-visible frontier.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      semantic_hash: "a".repeat(64),
      capability_grant: "g1.recovery",
    }, {
      name: "read_order_status",
      description: "Read authoritative order status.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      semantic_hash: "b".repeat(64),
      capability_grant: "g1.readback",
    }],
  });
}

describe("provider-neutral ambiguity quarantine", () => {
  it("rejects fabricated reconciliation without a mutation and leaves state unchanged", () => {
    const state = activeState();
    const before = JSON.stringify(state);
    expect(resolveAmbiguityInvocationArguments(
      flow,
      state,
      [],
      "read_order_status",
      { invocation_id: "fabricated-by-model" },
    )).toMatchObject({ code: "reconciliation_source_missing" });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("binds the original quarantined invocation across steps and rejects model overrides", () => {
    const fixture = quarantinedFixture();
    const original = fixture.state.actionReceipts.find((receipt) => receipt.id === fixture.flowReceiptId);
    if (!original?.invocationId) throw new Error("fixture lacks its server-generated invocation identity");
    const crossStepState: FlowExecutionState = {
      ...fixture.state,
      currentStep: "orders.follow_up",
    };
    const bound = resolveAmbiguityInvocationArguments(
      flow,
      crossStepState,
      [fixture.quarantine],
      "read_order_status",
      {},
    );
    if (!bound || "error" in bound) throw new Error(bound?.error ?? "binding was not detected");
    expect(bound.modelArguments).toEqual({});
    expect(bound.effectiveArguments).toEqual({ invocation_id: original.invocationId });
    expect(bound.evidence).toEqual([expect.objectContaining({
      argument: "invocation_id",
      source_kind: "ambiguity_original_invocation_id",
      source_receipt_id: fixture.flowReceiptId,
      quarantine_evidence_head_sha256: fixture.quarantine.evidenceHeadSha256,
    })]);
    expect(resolveAmbiguityInvocationArguments(
      flow,
      fixture.state,
      [fixture.quarantine],
      "read_order_status",
      { invocation_id: "fabricated-by-model" },
    )).toMatchObject({ code: "bound_argument_override" });
  });

  it("releases a real mutation through the exact host-bound reconciliation identity", () => {
    const fixture = quarantinedFixture();
    const bound = resolveAmbiguityInvocationArguments(
      flow,
      fixture.state,
      [fixture.quarantine],
      "read_order_status",
      {},
    );
    if (!bound || "error" in bound) throw new Error(bound?.error ?? "binding was not detected");
    const receiptId = "flow-host-bound-readback";
    const dispatched = reserveAndDispatch(
      fixture.state,
      receiptId,
      "read_order_status",
      bound.effectiveArguments as Record<string, JsonValue>,
      "2026-07-21T12:00:05.000Z",
    );
    const authoritativeResult: Record<string, JsonValue> = {
      invocation_id: bound.effectiveArguments.invocation_id as JsonValue,
      terminal: "committed",
      receipt: "ORDER-RCPT-7",
    };
    const settled = settleFlowAction(dispatched, {
      receiptId,
      status: "succeeded",
      result: authoritativeResult,
    }, "2026-07-21T12:00:06.000Z");
    if ("error" in settled) throw new Error(settled.error);
    const released = releaseAmbiguityQuarantine({
      state: settled.state,
      quarantine: fixture.quarantine,
      reconciliationFlowReceiptId: receiptId,
      reconciliationWorldReceipt: worldReceipt({
        receipt_id: "world-host-bound-readback",
        tool: "read_order_status",
        arguments: bound.effectiveArguments as Record<string, JsonValue>,
        status: "succeeded",
        committed: true,
        authoritative_result: authoritativeResult,
      }),
      now: "2026-07-21T12:00:07.000Z",
    });
    if ("error" in released) throw new Error(released.error);
    expect(released.quarantine.status).toBe("released");
    expect(released.state.actionReceipts.find((receipt) => receipt.id === fixture.flowReceiptId))
      .toMatchObject({ status: "succeeded", result: { receipt: "ORDER-RCPT-7" } });
  });

  it("fails closed when an explicit reconciliation contract is malformed", () => {
    const invalid = structuredClone(flow);
    const node = invalid.nodes.find((candidate) => candidate.id === "orders");
    if (!node || node.kind !== "topic" || !node.steps?.[0]?.action_policies?.[0]) {
      throw new Error("test flow shape changed");
    }
    node.steps[0].action_policies[0].reconciliation = {
      queryTool: "read_order_status",
      // A name alone is not an invocation-bound authoritative proof contract.
    };
    const state = reserveAndDispatch(
      activeState(), "flow-commit-invalid-policy", "commit_order", { order_id: "order-7" },
      "2026-07-21T12:00:03.000Z",
    );
    expect(() => designatedReconciliationActionsForReceipt(
      invalid, state, "flow-commit-invalid-policy",
    )).toThrow("invalid explicit reconciliation contract");
  });

  it("preserves the committed ToolWorld outcome but exposes indeterminate no-retry Flow state", () => {
    const fixture = quarantinedFixture();
    expect(fixture.rawWorldReceipt).toMatchObject({
      status: "committed_after_error",
      committed: true,
      authoritative_result: { receipt: "ORDER-RCPT-7" },
    });
    expect(fixture.state.actionReceipts[0]).toMatchObject({
      status: "indeterminate",
      tool: "commit_order",
    });
    expect(fixture.state.actionReceipts[0]).not.toHaveProperty("result");

    const projection = projectQuarantinedFlowState(
      flow, fixture.state, [fixture.quarantine], visibleSnapshot(fixture.state)
    );
    expect(projection).not.toHaveProperty("available_tools");
    expect(projection).not.toHaveProperty("released_outcomes");
    expect(projection.provider_visible_frontier).toMatchObject({
      actions: [{ name: "flow.get_state" }, { name: "read_order_status" }],
    });
    expect(JSON.stringify(projection.provider_visible_frontier)).not.toContain("capability_grant");
    expect(projection.action_receipts).toContainEqual(expect.objectContaining({
      id: fixture.flowReceiptId,
      status: "indeterminate",
      reconciliation_required: true,
      retry_authority: false,
      result_hash: undefined,
    }));
    expect(JSON.stringify(projection)).not.toContain("ORDER-RCPT-7");
  });

  it("does not grant a duplicate irreversible dispatch while quarantined", () => {
    const fixture = quarantinedFixture();
    const replay = reserveFlowAction(flow, fixture.state, {
      receiptId: "flow-commit-retry",
      invocationId: deriveFlowActionInvocationId("flow-commit-retry"),
      tool: "commit_order",
      arguments: fixture.arguments_,
      capabilityEpoch: fixture.state.capabilityEpoch,
    }, "2026-07-21T12:00:05.000Z");
    if ("error" in replay) throw new Error(replay.error);
    expect(replay).toMatchObject({ execute: false, replayed: false });
    expect(replay.receipt.id).toBe(fixture.flowReceiptId);
    expect(replay.receipt.status).toBe("indeterminate");
  });

  it("rejects a stale provider-visible frontier instead of falling back to raw Flow tools", () => {
    const fixture = quarantinedFixture();
    const stale = {
      ...visibleSnapshot(fixture.state),
      capability_epoch: fixture.state.capabilityEpoch - 1,
    };
    expect(() => projectQuarantinedFlowState(
      flow, fixture.state, [fixture.quarantine], stale
    )).toThrow(/provider-visible frontier is stale/);
  });

  it("releases only the exact prior outcome after successful designated readback", () => {
    const fixture = quarantinedFixture();
    const readback = successfulReadback(fixture.state);
    const released = releaseAmbiguityQuarantine({
      state: readback.state,
      quarantine: fixture.quarantine,
      reconciliationFlowReceiptId: readback.flowReceiptId,
      reconciliationWorldReceipt: readback.worldReceipt,
      now: "2026-07-21T12:00:07.000Z",
    });
    if ("error" in released) throw new Error(released.error);
    const original = released.state.actionReceipts.find((receipt) => receipt.id === fixture.flowReceiptId);
    expect(original).toMatchObject({
      status: "succeeded",
      result: { receipt: "ORDER-RCPT-7" },
      reconciliationProofId: "world-readback-1",
    });
    expect(original?.result).not.toEqual(readback.worldReceipt.authoritative_result);
    const projection = projectQuarantinedFlowState(
      flow, released.state, [released.quarantine], visibleSnapshot(released.state)
    );
    expect(projection.released_outcomes).toEqual([{
      receipt_id: fixture.flowReceiptId,
      status: "succeeded",
      authoritative_result: { receipt: "ORDER-RCPT-7" },
      result_sha256: fixture.quarantine.authoritativeResultSha256,
      reconciliation_receipt_id: "world-readback-1",
    }]);
  });

  it("keeps the original outcome quarantined when reconciliation fails", () => {
    const fixture = quarantinedFixture();
    const receiptId = "flow-readback-failed";
    const arguments_ = { order_id: "order-7" };
    const dispatched = reserveAndDispatch(
      fixture.state, receiptId, "read_order_status", arguments_, "2026-07-21T12:00:05.000Z"
    );
    const failed = settleFlowAction(dispatched, {
      receiptId,
      status: "failed",
      error: "status endpoint unavailable",
    }, "2026-07-21T12:00:06.000Z");
    if ("error" in failed) throw new Error(failed.error);
    const released = releaseAmbiguityQuarantine({
      state: failed.state,
      quarantine: fixture.quarantine,
      reconciliationFlowReceiptId: receiptId,
      reconciliationWorldReceipt: worldReceipt({
        receipt_id: "world-readback-failed",
        tool: "read_order_status",
        arguments: arguments_,
        status: "failed_before_commit",
        committed: false,
      }),
      now: "2026-07-21T12:00:07.000Z",
    });
    expect(released).toMatchObject({ code: "reconciliation_evidence_invalid" });
    expect(failed.state.actionReceipts.find((receipt) => receipt.id === fixture.flowReceiptId)?.status)
      .toBe("indeterminate");
  });

  it("replays an identical release without another Flow revision", () => {
    const fixture = quarantinedFixture();
    const readback = successfulReadback(fixture.state);
    const first = releaseAmbiguityQuarantine({
      state: readback.state,
      quarantine: fixture.quarantine,
      reconciliationFlowReceiptId: readback.flowReceiptId,
      reconciliationWorldReceipt: readback.worldReceipt,
      now: "2026-07-21T12:00:07.000Z",
    });
    if ("error" in first) throw new Error(first.error);
    const replay = releaseAmbiguityQuarantine({
      state: first.state,
      quarantine: first.quarantine,
      reconciliationFlowReceiptId: readback.flowReceiptId,
      reconciliationWorldReceipt: readback.worldReceipt,
      now: "2026-07-21T12:00:08.000Z",
    });
    if ("error" in replay) throw new Error(replay.error);
    expect(replay.replayed).toBe(true);
    expect(replay.state.revision).toBe(first.state.revision);
    expect(replay.quarantine).toBe(first.quarantine);
  });

  it("fails closed on undesignated or non-correlated readback evidence", () => {
    const fixture = quarantinedFixture(["different_readback"]);
    const readback = successfulReadback(fixture.state);
    expect(releaseAmbiguityQuarantine({
      state: readback.state,
      quarantine: fixture.quarantine,
      reconciliationFlowReceiptId: readback.flowReceiptId,
      reconciliationWorldReceipt: readback.worldReceipt,
      now: "2026-07-21T12:00:07.000Z",
    })).toMatchObject({ code: "reconciliation_not_designated" });
  });
});
