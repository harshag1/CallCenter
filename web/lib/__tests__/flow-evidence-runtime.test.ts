import { describe, expect, it } from "vitest";
import { AgentFlowSchema, type AgentFlow, type FlowOutputBinding } from "../flow";
import {
  FlowExecutionStateSchema,
  MAX_FLOW_ACTION_ARGUMENT_BYTES,
  MAX_FLOW_ACTION_ERROR_BYTES,
  MAX_FLOW_ACTION_RECEIPTS_PER_CALL,
  MAX_FLOW_ACTION_RESULT_BYTES,
  MAX_FLOW_HOT_STATE_BYTES,
  completeFlowStep,
  createFlowExecutionState,
  deriveFlowActionInvocationId,
  enterFlowStep,
  flowStateStorageBytes,
  hashFlowValue,
  markFlowActionDispatchStarted,
  proveIndeterminateFlowActionAbsent,
  promoteIndeterminateFlowAction,
  reserveFlowAction,
  resolveFlowBoundArguments,
  selectFlowTopic,
  settleFlowAction,
  type FlowExecutionState,
} from "../flow-runtime";

const TOPIC = "operations";
const STEP = "operations.execute";
const CASE_TOOL = "create_case";

function evidenceFlow(bindingOverrides: Partial<FlowOutputBinding> = {}): AgentFlow {
  return AgentFlowSchema.parse({
    schema_version: 2,
    always_tools: [],
    nodes: [
      { id: "entry", label: "Incoming call", kind: "incoming_call" },
      {
        id: TOPIC,
        label: "Operations",
        kind: "topic",
        steps: [{
          id: "execute",
          label: "Execute the request",
          instructions: "Execute and verify the requested operation.",
          tools: [CASE_TOOL, "tag_case", "notify_case"],
          required_outputs: ["case_id"],
          output_bindings: [{
            output: "case_id",
            tool: CASE_TOOL,
            result_path: "$.data.case.id",
            value_type: "string",
            ...bindingOverrides,
          }],
          action_policies: [
            { tool: CASE_TOOL, max_calls: 1, idempotency: "per_step" },
            {
              tool: "tag_case",
              max_calls: 3,
              idempotency: "per_arguments",
              bound_arguments: [{
                argument: "case_id",
                source: { kind: "receipt_result", tool: CASE_TOOL, result_path: "$.data.case.id" },
              }],
            },
            { tool: "notify_case", max_calls: 1, idempotency: "none" },
          ],
        }],
      },
    ],
    edges: [{ from: "entry", to: TOPIC }],
  });
}

function activeStep(flow = evidenceFlow()): FlowExecutionState {
  const selected = selectFlowTopic(flow, createFlowExecutionState("2026-07-10T00:00:00.000Z"), TOPIC);
  if ("error" in selected) throw new Error(selected.error);
  const entered = enterFlowStep(flow, selected, STEP, "2026-07-10T00:00:01.000Z");
  if ("error" in entered) throw new Error(entered.error);
  return entered.state;
}

const storageFlow = AgentFlowSchema.parse({
  schema_version: 2,
  always_tools: ["storage_action"],
  nodes: [
    { id: "entry", label: "Incoming call", kind: "incoming_call" },
    { id: "operations", label: "Operations", kind: "topic" },
  ],
  edges: [{ from: "entry", to: "operations" }],
});

function reserve(
  flow: AgentFlow,
  state: FlowExecutionState,
  receiptId: string,
  tool: string,
  actionArguments: Record<string, unknown>,
) {
  const reservation = reserveFlowAction(flow, state, {
    receiptId,
    invocationId: deriveFlowActionInvocationId(`test:${receiptId}`),
    tool,
    arguments: actionArguments,
    capabilityEpoch: state.capabilityEpoch,
  }, "2026-07-10T00:00:02.000Z");
  if ("error" in reservation) throw new Error(`${reservation.code}: ${reservation.error}`);
  return reservation;
}

function settle(
  state: FlowExecutionState,
  receiptId: string,
  status: "succeeded" | "failed" | "indeterminate",
  result?: unknown,
) {
  const receipt = state.actionReceipts.find((candidate) => candidate.id === receiptId);
  let dispatchState = state;
  if ((status === "succeeded" || status === "indeterminate") && receipt?.status === "reserved" && !receipt.dispatchStartedAt) {
    const marked = markFlowActionDispatchStarted(state, { receiptId }, "2026-07-10T00:00:02.500Z");
    if ("error" in marked) throw new Error(`${marked.code}: ${marked.error}`);
    dispatchState = marked.state;
  }
  const settlement = settleFlowAction(dispatchState, {
    receiptId,
    status,
    ...(result === undefined ? {} : { result }),
  }, "2026-07-10T00:00:03.000Z");
  if ("error" in settlement) throw new Error(`${settlement.code}: ${settlement.error}`);
  return settlement;
}

describe("flow action evidence", () => {
  it("resolves host-bound arguments only from one successful current-step receipt", () => {
    const flow = evidenceFlow();
    const reserved = reserve(flow, activeStep(flow), "case-source", CASE_TOOL, { customer: "C-7" });
    const succeeded = settle(reserved.state, "case-source", "succeeded", {
      data: { case: { id: "CASE-42" } },
    });
    const resolved = resolveFlowBoundArguments(flow, succeeded.state, "tag_case", { tag: "urgent" });
    if ("error" in resolved) throw new Error(`${resolved.code}: ${resolved.error}`);
    expect(resolved.modelArguments).toEqual({ tag: "urgent" });
    expect(resolved.effectiveArguments).toEqual({ tag: "urgent", case_id: "CASE-42" });
    expect(resolved.evidence).toEqual([expect.objectContaining({
      argument: "case_id",
      source_kind: "receipt_result",
      source_tool: CASE_TOOL,
      source_step: STEP,
      source_receipt_id: "case-source",
      result_path: "$.data.case.id",
      source_receipt_result_hash: succeeded.receipt.resultHash,
    })]);
    expect(resolveFlowBoundArguments(flow, succeeded.state, "tag_case", {
      tag: "urgent",
      case_id: "MODEL-OVERRIDE",
    })).toMatchObject({ code: "bound_argument_override" });
  });

  it("fails closed for missing, failed, and stale receipt authorities", () => {
    const flow = evidenceFlow();
    const active = activeStep(flow);
    expect(resolveFlowBoundArguments(flow, active, "tag_case", { tag: "urgent" }))
      .toMatchObject({ code: "missing_bound_argument_source" });

    const failedReservation = reserve(flow, active, "case-failed", CASE_TOOL, { customer: "C-7" });
    const failed = settle(failedReservation.state, "case-failed", "failed");
    expect(resolveFlowBoundArguments(flow, failed.state, "tag_case", { tag: "urgent" }))
      .toMatchObject({ code: "missing_bound_argument_source" });

    const successReservation = reserve(flow, active, "case-stale", CASE_TOOL, { customer: "C-7" });
    const succeeded = settle(successReservation.state, "case-stale", "succeeded", {
      data: { case: { id: "CASE-42" } },
    });
    const staleState = FlowExecutionStateSchema.parse({
      ...succeeded.state,
      capabilityEpoch: succeeded.state.capabilityEpoch + 1,
    });
    expect(resolveFlowBoundArguments(flow, staleState, "tag_case", { tag: "urgent" }))
      .toMatchObject({ code: "stale_bound_argument_source" });
  });

  it("rejects oversized action payloads before mutating durable state", () => {
    const state = createFlowExecutionState();
    expect(reserveFlowAction(storageFlow, state, {
      receiptId: "oversized-arguments",
      invocationId: deriveFlowActionInvocationId("oversized-arguments"),
      tool: "storage_action",
      arguments: { value: "x".repeat(MAX_FLOW_ACTION_ARGUMENT_BYTES) },
      capabilityEpoch: state.capabilityEpoch,
    })).toMatchObject({ code: "action_arguments_too_large" });
    expect(state.actionReceipts).toEqual([]);

    const reserved = reserve(storageFlow, state, "oversized-result", "storage_action", {});
    const dispatched = markFlowActionDispatchStarted(reserved.state, { receiptId: reserved.receipt.id });
    if ("error" in dispatched) throw new Error(dispatched.error);
    expect(settleFlowAction(dispatched.state, {
      receiptId: reserved.receipt.id,
      status: "succeeded",
      result: { value: "x".repeat(MAX_FLOW_ACTION_RESULT_BYTES) },
    })).toMatchObject({ code: "action_result_too_large" });
    expect(dispatched.state.actionReceipts[0]).toMatchObject({ status: "reserved" });
    expect(settleFlowAction(dispatched.state, {
      receiptId: reserved.receipt.id,
      status: "failed",
      error: "x".repeat(MAX_FLOW_ACTION_ERROR_BYTES),
    })).toMatchObject({ code: "action_error_too_large" });
    expect(dispatched.state.actionReceipts[0]).toMatchObject({ status: "reserved" });
  });

  it("admits 512 fresh receipts, rejects the 513th, and keeps exact replay free", () => {
    let state = createFlowExecutionState();
    let first: ReturnType<typeof reserveFlowAction> | undefined;
    for (let index = 0; index < MAX_FLOW_ACTION_RECEIPTS_PER_CALL; index += 1) {
      const reserved = reserveFlowAction(storageFlow, state, {
        receiptId: `bounded-receipt-${index}`,
        invocationId: deriveFlowActionInvocationId(`bounded-receipt-${index}`),
        tool: "storage_action",
        arguments: { index },
        capabilityEpoch: state.capabilityEpoch,
      });
      if ("error" in reserved) throw new Error(`${reserved.code}: ${reserved.error}`);
      first ??= reserved;
      state = reserved.state;
    }
    expect(state.actionReceipts).toHaveLength(MAX_FLOW_ACTION_RECEIPTS_PER_CALL);
    expect(reserveFlowAction(storageFlow, state, {
      receiptId: "bounded-receipt-overflow",
      invocationId: deriveFlowActionInvocationId("bounded-receipt-overflow"),
      tool: "storage_action",
      arguments: { overflow: true },
      capabilityEpoch: state.capabilityEpoch,
    })).toMatchObject({ code: "flow_receipt_quota_exceeded" });
    if (!first || "error" in first) throw new Error("first receipt was not admitted");
    expect(reserveFlowAction(storageFlow, state, {
      receiptId: first.receipt.id,
      invocationId: first.receipt.invocationId!,
      tool: first.receipt.tool,
      arguments: first.receipt.arguments!,
      capabilityEpoch: state.capabilityEpoch,
    })).toMatchObject({ execute: false, receipt: { id: first.receipt.id } });
  });

  it("rejects a hot state over 8 MiB before adding another durable receipt", () => {
    const state = createFlowExecutionState();
    state.outputs = { adversarial: { blob: "x".repeat(MAX_FLOW_HOT_STATE_BYTES) } };
    expect(flowStateStorageBytes(state)).toBeGreaterThan(MAX_FLOW_HOT_STATE_BYTES);
    expect(reserveFlowAction(storageFlow, state, {
      receiptId: "hot-state-overflow",
      invocationId: deriveFlowActionInvocationId("hot-state-overflow"),
      tool: "storage_action",
      arguments: {},
      capabilityEpoch: state.capabilityEpoch,
    })).toMatchObject({ code: "flow_state_storage_quota_exceeded" });
    expect(state.actionReceipts).toEqual([]);
  });

  it("compacts completed replay payloads while preserving exact evidence and bound outputs", () => {
    const flow = evidenceFlow();
    const reservation = reserve(flow, activeStep(flow), "compact-case", CASE_TOOL, { member: "m-1" });
    const succeeded = settle(
      reservation.state,
      reservation.receipt.id,
      "succeeded",
      { data: { case: { id: "case-compact" } }, verbose: "x".repeat(8_000) },
    );
    const completed = completeFlowStep(flow, succeeded.state, {});
    if ("error" in completed) throw new Error(completed.error);

    expect(completed.state.outputs[STEP]).toEqual({ case_id: "case-compact" });
    expect(completed.state.actionReceipts[0]).toMatchObject({
      id: reservation.receipt.id,
      status: "succeeded",
      argumentsHash: hashFlowValue({ member: "m-1" }),
      argumentsBytes: expect.any(Number),
      argumentsCompacted: true,
      resultHash: hashFlowValue({ data: { case: { id: "case-compact" } }, verbose: "x".repeat(8_000) }),
      resultBytes: expect.any(Number),
      resultCompacted: true,
    });
    expect(completed.state.actionReceipts[0]).not.toHaveProperty("arguments");
    expect(completed.state.actionReceipts[0]).not.toHaveProperty("result");
    expect(FlowExecutionStateSchema.parse(completed.state)).toEqual(completed.state);
    expect(flowStateStorageBytes(completed.state)).toBeLessThan(flowStateStorageBytes(succeeded.state));
  });

  it("derives stable, opaque, fixed-width downstream invocation identities", () => {
    const first = deriveFlowActionInvocationId("call-1:provider-call-9");
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(deriveFlowActionInvocationId("call-1:provider-call-9")).toBe(first);
    expect(deriveFlowActionInvocationId("call-2:provider-call-9")).not.toBe(first);
    expect(() => deriveFlowActionInvocationId("")).toThrow(/1 to 2048/);
  });

  it("replays one provider delivery identity but rejects changed semantics", () => {
    const flow = evidenceFlow();
    const state = activeStep(flow);
    const first = reserveFlowAction(flow, state, {
      receiptId: "server-generated-invocation-1",
      invocationId: deriveFlowActionInvocationId("provider-session-1:tool-call-9"),
      providerInvocationId: "provider-session-1:tool-call-9",
      tool: CASE_TOOL,
      arguments: { member: "m-1" },
      capabilityEpoch: state.capabilityEpoch,
    });
    if ("error" in first) throw new Error(first.error);
    expect(first.receipt).toMatchObject({
      invocationId: deriveFlowActionInvocationId("provider-session-1:tool-call-9"),
      providerInvocationId: "provider-session-1:tool-call-9",
    });

    const exact = reserveFlowAction(flow, first.state, {
      receiptId: "different-server-candidate",
      invocationId: deriveFlowActionInvocationId("provider-session-1:tool-call-9"),
      providerInvocationId: "provider-session-1:tool-call-9",
      tool: CASE_TOOL,
      arguments: { member: "m-1" },
      capabilityEpoch: first.state.capabilityEpoch,
    });
    expect(exact).toMatchObject({ execute: false, receipt: { id: "server-generated-invocation-1" } });
    expect(reserveFlowAction(flow, first.state, {
      receiptId: "different-server-candidate",
      invocationId: deriveFlowActionInvocationId("provider-session-1:tool-call-9"),
      providerInvocationId: "provider-session-1:tool-call-9",
      tool: CASE_TOOL,
      arguments: { member: "m-2" },
      capabilityEpoch: first.state.capabilityEpoch,
    })).toMatchObject({ code: "invocation_identity_conflict" });
  });

  it("records a one-way dispatch boundary and promotes ambiguity only through proof", () => {
    const flow = evidenceFlow();
    const reserved = reserve(flow, activeStep(flow), "dispatch-boundary", CASE_TOOL, { member: "m-1" });
    const marked = markFlowActionDispatchStarted(reserved.state, { receiptId: reserved.receipt.id });
    if ("error" in marked) throw new Error(marked.error);
    expect(marked.receipt).toMatchObject({ dispatchAttempt: 1 });
    expect(markFlowActionDispatchStarted(marked.state, { receiptId: reserved.receipt.id })).toMatchObject({
      code: "dispatch_already_started",
    });
    const ambiguous = settle(marked.state, reserved.receipt.id, "indeterminate");
    const promoted = promoteIndeterminateFlowAction(ambiguous.state, {
      receiptId: reserved.receipt.id,
      proofId: "proof-1",
      result: { data: { case: { id: "case-read-back" } } },
    });
    if ("error" in promoted) throw new Error(promoted.error);
    expect(promoted.receipt).toMatchObject({
      status: "succeeded",
      reconciliationProofId: "proof-1",
      result: { data: { case: { id: "case-read-back" } } },
    });
    expect(promoteIndeterminateFlowAction(promoted.state, {
      receiptId: reserved.receipt.id,
      proofId: "proof-2",
      result: {},
    })).toMatchObject({ code: "receipt_not_indeterminate" });
  });

  it("makes only an exact authoritative-absence proof retry-safe", () => {
    const flow = evidenceFlow();
    const reserved = reserve(flow, activeStep(flow), "absence-original", CASE_TOOL, { member: "m-1" });
    const marked = markFlowActionDispatchStarted(reserved.state, { receiptId: reserved.receipt.id });
    if ("error" in marked) throw new Error(marked.error);
    const ambiguous = settle(marked.state, reserved.receipt.id, "indeterminate");

    const absent = proveIndeterminateFlowActionAbsent(ambiguous.state, {
      receiptId: reserved.receipt.id,
      proofId: "proof-absent",
    });
    if ("error" in absent) throw new Error(absent.error);
    expect(absent.receipt).toMatchObject({
      status: "failed",
      reconciliationProofId: "proof-absent",
      error: expect.stringContaining("not committed"),
    });
    expect(FlowExecutionStateSchema.parse(absent.state)).toEqual(absent.state);

    const retry = reserveFlowAction(flow, absent.state, {
      receiptId: "absence-retry",
      invocationId: deriveFlowActionInvocationId("absence-retry"),
      tool: CASE_TOOL,
      arguments: { member: "m-1" },
      capabilityEpoch: absent.state.capabilityEpoch,
    });
    expect(retry).toMatchObject({ execute: true, receipt: { status: "reserved" } });
    expect(proveIndeterminateFlowActionAbsent(absent.state, {
      receiptId: reserved.receipt.id,
      proofId: "proof-rewrite",
    })).toMatchObject({ code: "receipt_not_indeterminate" });
  });

  it("requires a dispatch boundary and makes terminal settlement exactly replayable", () => {
    const flow = evidenceFlow();
    const reserved = reserve(flow, activeStep(flow), "exact-settlement", CASE_TOOL, { member: "m-1" });
    expect(settleFlowAction(reserved.state, {
      receiptId: reserved.receipt.id,
      status: "succeeded",
      result: { ok: true },
    })).toMatchObject({ code: "dispatch_not_started" });
    const dispatched = markFlowActionDispatchStarted(reserved.state, { receiptId: reserved.receipt.id });
    if ("error" in dispatched) throw new Error(dispatched.error);
    const succeeded = settleFlowAction(dispatched.state, {
      receiptId: reserved.receipt.id,
      status: "succeeded",
      result: { ok: true },
    });
    if ("error" in succeeded) throw new Error(succeeded.error);
    const replay = settleFlowAction(succeeded.state, {
      receiptId: reserved.receipt.id,
      status: "succeeded",
      result: { ok: true },
    });
    if ("error" in replay) throw new Error(replay.error);
    expect(replay.state).toBe(succeeded.state);
    expect(settleFlowAction(succeeded.state, {
      receiptId: reserved.receipt.id,
      status: "failed",
      error: "rewrite",
    })).toMatchObject({ code: "receipt_settlement_conflict" });
  });

  it("rejects receipt-id and downstream-id reuse with changed semantics", () => {
    const flow = evidenceFlow();
    const state = activeStep(flow);
    const first = reserve(flow, state, "stable-receipt", CASE_TOOL, { member: "m-1" });
    expect(reserveFlowAction(flow, first.state, {
      receiptId: "stable-receipt",
      invocationId: deriveFlowActionInvocationId("different-downstream-identity"),
      tool: CASE_TOOL,
      arguments: { member: "m-1" },
      capabilityEpoch: first.state.capabilityEpoch,
    })).toMatchObject({ code: "receipt_identity_conflict" });
    expect(reserveFlowAction(flow, first.state, {
      receiptId: "different-receipt",
      invocationId: first.receipt.invocationId!,
      tool: CASE_TOOL,
      arguments: { member: "m-2" },
      capabilityEpoch: first.state.capabilityEpoch,
    })).toMatchObject({ code: "invocation_identity_conflict" });
  });

  it("deduplicates always-available effects across capability-epoch transitions", () => {
    const flow = AgentFlowSchema.parse({
      ...evidenceFlow(),
      always_tools: ["request_recall"],
      always_action_policies: [{
        tool: "request_recall",
        max_calls: 2,
        idempotency: "per_call_arguments",
      }],
    });
    const initial = createFlowExecutionState();
    const first = reserve(flow, initial, "recall-routing", "request_recall", {
      to_number: "+15551234567",
      run_at: "2026-07-10T20:00:00.000Z",
    });
    const succeeded = settle(first.state, first.receipt.id, "succeeded", { scheduled_id: "scheduled-1" });
    const selected = selectFlowTopic(flow, succeeded.state, TOPIC);
    if ("error" in selected) throw new Error(selected.error);
    expect(selected.capabilityEpoch).toBe(succeeded.state.capabilityEpoch + 1);

    const replay = reserveFlowAction(flow, selected, {
      receiptId: "recall-after-transition",
      invocationId: deriveFlowActionInvocationId("test:recall-after-transition"),
      tool: "request_recall",
      arguments: {
        run_at: "2026-07-10T20:00:00.000Z",
        to_number: "+15551234567",
      },
      capabilityEpoch: selected.capabilityEpoch,
    });
    if ("error" in replay) throw new Error(replay.error);
    expect(replay).toMatchObject({
      execute: false,
      replayed: true,
      receipt: { id: "recall-routing", result: { scheduled_id: "scheduled-1" } },
    });
  });

  it("hashes semantically identical arguments identically regardless of object key order", () => {
    const first = {
      z: 7,
      nested: { beta: true, alpha: ["one", { y: 2, x: 1 }] },
      a: null,
    };
    const reordered = {
      a: null,
      nested: { alpha: ["one", { x: 1, y: 2 }], beta: true },
      z: 7,
    };

    expect(hashFlowValue(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashFlowValue(first)).toBe(hashFlowValue(reordered));
    expect(hashFlowValue({ values: [1, 2] })).not.toBe(hashFlowValue({ values: [2, 1] }));
  });

  it("changes capability epochs only for topic, enter, retry, and completion transitions", () => {
    const flow = evidenceFlow();
    const initial = createFlowExecutionState("2026-07-10T00:00:00.000Z");
    expect(initial.capabilityEpoch).toBe(0);

    const selected = selectFlowTopic(flow, initial, TOPIC, "2026-07-10T00:00:01.000Z");
    if ("error" in selected) throw new Error(selected.error);
    expect(selected.capabilityEpoch).toBe(1);
    expect(selectFlowTopic(flow, selected, TOPIC)).toBe(selected);

    const entered = enterFlowStep(flow, selected, STEP, "2026-07-10T00:00:02.000Z");
    if ("error" in entered) throw new Error(entered.error);
    expect(entered.state.capabilityEpoch).toBe(2);

    const reservation = reserve(flow, entered.state, "receipt-before-retry", CASE_TOOL, { member: "m-1" });
    expect(reservation.state.capabilityEpoch).toBe(2);
    expect(reservation.state.revision).toBe(entered.state.revision + 1);

    const settlement = settle(
      reservation.state,
      reservation.receipt.id,
      "succeeded",
      { data: { case: { id: "case-before-retry" } } },
    );
    expect(settlement.state.capabilityEpoch).toBe(2);
    expect(settlement.state.revision).toBe(reservation.state.revision + 2);

    const retried = enterFlowStep(flow, settlement.state, STEP, "2026-07-10T00:00:04.000Z");
    if ("error" in retried) throw new Error(retried.error);
    expect(retried.state.capabilityEpoch).toBe(3);

    const currentReservation = reserve(flow, retried.state, "receipt-after-retry", CASE_TOOL, { member: "m-1" });
    expect(currentReservation.receipt.idempotencyKey).not.toBe(reservation.receipt.idempotencyKey);
    const currentSettlement = settle(
      currentReservation.state,
      currentReservation.receipt.id,
      "succeeded",
      { data: { case: { id: "case-after-retry" } } },
    );
    expect(currentSettlement.state.capabilityEpoch).toBe(3);

    const completed = completeFlowStep(flow, currentSettlement.state, {}, "2026-07-10T00:00:05.000Z");
    if ("error" in completed) throw new Error(completed.error);
    expect(completed.state.capabilityEpoch).toBe(4);
  });

  it("reuses call-scoped authoritative evidence when the same step is retried", () => {
    const flow = evidenceFlow();
    const topic = flow.nodes.find((node) => node.id === TOPIC)!;
    const step = topic.steps!.find((candidate) => candidate.id === "execute")!;
    step.action_policies = step.action_policies!.map((policy) =>
      policy.tool === CASE_TOOL
        ? { ...policy, idempotency: "per_call_arguments" as const }
        : policy
    );

    const first = reserve(flow, activeStep(flow), "case-first-attempt", CASE_TOOL, { member: "m-1" });
    const succeeded = settle(first.state, first.receipt.id, "succeeded", {
      data: { case: { id: "case-call-scoped" } },
    });
    const retried = enterFlowStep(flow, succeeded.state, STEP, "2026-07-10T00:00:04.000Z");
    if ("error" in retried) throw new Error(retried.error);

    const replay = reserve(flow, retried.state, "case-retry-attempt", CASE_TOOL, { member: "m-1" });
    expect(replay).toMatchObject({
      execute: false,
      replayed: true,
      receipt: { id: "case-first-attempt" },
    });
    const completed = completeFlowStep(flow, replay.state, { outputs: {} });
    if ("error" in completed) throw new Error(completed.error);
    expect(completed.state.outputs[STEP]).toEqual({ case_id: "case-call-scoped" });
  });

  it("fails closed when multiple successful intents could satisfy one output binding", () => {
    const flow = evidenceFlow();
    const topic = flow.nodes.find((node) => node.id === TOPIC)!;
    const step = topic.steps!.find((candidate) => candidate.id === "execute")!;
    step.action_policies = step.action_policies!.map((policy) =>
      policy.tool === CASE_TOOL
        ? { ...policy, max_calls: 2, idempotency: "per_arguments" as const }
        : policy
    );

    const first = reserve(flow, activeStep(flow), "case-account-a", CASE_TOOL, { account: "A" });
    const firstSettled = settle(first.state, first.receipt.id, "succeeded", {
      data: { case: { id: "case-for-A" } },
    });
    const second = reserve(flow, firstSettled.state, "case-account-b", CASE_TOOL, { account: "B" });
    const secondSettled = settle(second.state, second.receipt.id, "succeeded", {
      data: { case: { id: "case-for-B" } },
    });

    expect(completeFlowStep(flow, secondSettled.state, { outputs: {} })).toMatchObject({
      code: "ambiguous_action_evidence",
    });
  });

  it.each(["reserved", "indeterminate"] as const)(
    "cannot rotate away from %s action evidence before settlement or reconciliation",
    (status) => {
      const flow = evidenceFlow();
      const first = reserve(flow, activeStep(flow), `case-${status}`, CASE_TOOL, { member: "m-1" });
      const state = status === "reserved"
        ? first.state
        : settle(first.state, first.receipt.id, "indeterminate").state;

      expect(enterFlowStep(flow, state, STEP)).toMatchObject({
        code: "pending_action_evidence",
        allowed: [],
      });
      expect(completeFlowStep(flow, state, { outputs: {} })).toMatchObject({
        code: "pending_action_evidence",
      });
      expect(state.actionReceipts).toContainEqual(expect.objectContaining({
        id: `case-${status}`,
        status,
      }));
    }
  );

  it("rejects action reservations carrying a stale capability epoch without mutating state", () => {
    const flow = evidenceFlow();
    const state = activeStep(flow);

    expect(reserveFlowAction(flow, state, {
      receiptId: "stale-receipt",
      invocationId: deriveFlowActionInvocationId("test:stale-receipt"),
      tool: CASE_TOOL,
      arguments: { member: "m-1" },
      capabilityEpoch: state.capabilityEpoch - 1,
    })).toMatchObject({ code: "stale_capability" });
    expect(state.actionReceipts).toEqual([]);
  });

  it("deduplicates per-step actions across different receipt IDs and arguments", () => {
    const flow = evidenceFlow();
    const first = reserve(flow, activeStep(flow), "case-receipt-1", CASE_TOOL, { member: "m-1" });
    expect(first).toMatchObject({ execute: true, replayed: false });

    const whileReserved = reserveFlowAction(flow, first.state, {
      receiptId: "case-receipt-2",
      invocationId: deriveFlowActionInvocationId("test:case-receipt-2"),
      tool: CASE_TOOL,
      arguments: { member: "different-member" },
      capabilityEpoch: first.state.capabilityEpoch,
    });
    if ("error" in whileReserved) throw new Error(whileReserved.error);
    expect(whileReserved).toMatchObject({
      execute: false,
      replayed: false,
      receipt: { id: "case-receipt-1" },
    });
    expect(whileReserved.state).toBe(first.state);

    const succeeded = settle(
      first.state,
      first.receipt.id,
      "succeeded",
      { data: { case: { id: "case-1" } } },
    );
    const afterSuccess = reserveFlowAction(flow, succeeded.state, {
      receiptId: "case-receipt-3",
      invocationId: deriveFlowActionInvocationId("test:case-receipt-3"),
      tool: CASE_TOOL,
      arguments: { member: "another-member" },
      capabilityEpoch: succeeded.state.capabilityEpoch,
    });
    if ("error" in afterSuccess) throw new Error(afterSuccess.error);
    expect(afterSuccess).toMatchObject({
      execute: false,
      replayed: true,
      receipt: { id: "case-receipt-1", status: "succeeded" },
    });
  });

  it("deduplicates per-arguments actions by canonical arguments while admitting distinct arguments", () => {
    const flow = evidenceFlow();
    const first = reserve(flow, activeStep(flow), "tag-receipt-1", "tag_case", {
      metadata: { priority: 1, source: "voice" },
      tags: ["urgent", "member"],
    });

    const reordered = reserveFlowAction(flow, first.state, {
      receiptId: "tag-receipt-2",
      invocationId: deriveFlowActionInvocationId("test:tag-receipt-2"),
      tool: "tag_case",
      arguments: {
        tags: ["urgent", "member"],
        metadata: { source: "voice", priority: 1 },
      },
      capabilityEpoch: first.state.capabilityEpoch,
    });
    if ("error" in reordered) throw new Error(reordered.error);
    expect(reordered).toMatchObject({ execute: false, receipt: { id: "tag-receipt-1" } });

    const distinct = reserveFlowAction(flow, first.state, {
      receiptId: "tag-receipt-3",
      invocationId: deriveFlowActionInvocationId("test:tag-receipt-3"),
      tool: "tag_case",
      arguments: {
        tags: ["member", "urgent"],
        metadata: { source: "voice", priority: 1 },
      },
      capabilityEpoch: first.state.capabilityEpoch,
    });
    if ("error" in distinct) throw new Error(distinct.error);
    expect(distinct).toMatchObject({ execute: true, replayed: false, receipt: { id: "tag-receipt-3" } });
    expect(distinct.receipt.idempotencyKey).not.toBe(first.receipt.idempotencyKey);
  });

  it("enforces per-step action call limits but permits a retry after definitive failure", () => {
    const flow = evidenceFlow();
    const first = reserve(flow, activeStep(flow), "notice-receipt-1", "notify_case", { channel: "sms" });

    expect(reserveFlowAction(flow, first.state, {
      receiptId: "notice-receipt-2",
      invocationId: deriveFlowActionInvocationId("test:notice-receipt-2"),
      tool: "notify_case",
      arguments: { channel: "email" },
      capabilityEpoch: first.state.capabilityEpoch,
    })).toMatchObject({ code: "action_call_limit" });

    const failed = settle(first.state, first.receipt.id, "failed", { provider: "unavailable" });
    const retry = reserveFlowAction(flow, failed.state, {
      receiptId: "notice-receipt-3",
      invocationId: deriveFlowActionInvocationId("test:notice-receipt-3"),
      tool: "notify_case",
      arguments: { channel: "email" },
      capabilityEpoch: failed.state.capabilityEpoch,
    });
    if ("error" in retry) throw new Error(retry.error);
    expect(retry).toMatchObject({ execute: true, receipt: { id: "notice-receipt-3" } });
  });

  it("auto-populates bound durable outputs only from a successful authoritative receipt", () => {
    const flow = evidenceFlow();
    const initial = activeStep(flow);
    const reservation = reserve(flow, initial, "case-success", CASE_TOOL, { member: "m-1" });
    const settlement = settle(
      reservation.state,
      reservation.receipt.id,
      "succeeded",
      { data: { case: { id: "case-authoritative" } } },
    );

    const completed = completeFlowStep(flow, settlement.state, { outputs: { model_note: "caller confirmed" } });
    if ("error" in completed) throw new Error(completed.error);
    expect(completed.state.outputs[STEP]).toEqual({
      model_note: "caller confirmed",
      case_id: "case-authoritative",
    });
    expect(completed.state.status).toBe("completed");
    expect(settlement.receipt.resultHash).toBe(hashFlowValue({ data: { case: { id: "case-authoritative" } } }));
  });

  it.each([
    ["reserved", undefined],
    ["failed", { provider: "declined" }],
    ["indeterminate", { provider: "timed_out_after_dispatch" }],
  ] as const)("rejects %s receipts as bound-output evidence", (status, result) => {
    const flow = evidenceFlow();
    const reservation = reserve(flow, activeStep(flow), `case-${status}`, CASE_TOOL, { member: "m-1" });
    const state = status === "reserved"
      ? reservation.state
      : settle(reservation.state, reservation.receipt.id, status, result).state;

    expect(completeFlowStep(flow, state, { outputs: { case_id: "fabricated" } })).toMatchObject({
      code: status === "failed" ? "missing_action_evidence" : "pending_action_evidence",
    });
  });

  it("rejects succeeded evidence from an obsolete step-attempt epoch", () => {
    const flow = evidenceFlow();
    const reservation = reserve(flow, activeStep(flow), "case-old-epoch", CASE_TOOL, { member: "m-1" });
    const succeeded = settle(
      reservation.state,
      reservation.receipt.id,
      "succeeded",
      { data: { case: { id: "case-old" } } },
    );
    const retried = enterFlowStep(flow, succeeded.state, STEP);
    if ("error" in retried) throw new Error(retried.error);
    expect(retried.state.capabilityEpoch).toBe(succeeded.state.capabilityEpoch + 1);

    expect(completeFlowStep(flow, retried.state, { outputs: { case_id: "case-old" } })).toMatchObject({
      code: "missing_action_evidence",
    });
  });

  it("rejects a model-authored bound output that contradicts the receipt", () => {
    const flow = evidenceFlow();
    const reservation = reserve(flow, activeStep(flow), "case-mismatch", CASE_TOOL, { member: "m-1" });
    const succeeded = settle(
      reservation.state,
      reservation.receipt.id,
      "succeeded",
      { data: { case: { id: "case-authoritative" } } },
    );

    expect(completeFlowStep(flow, succeeded.state, { outputs: { case_id: "case-fabricated" } })).toMatchObject({
      code: "bound_output_mismatch",
    });
    expect(succeeded.state.completedSteps).toEqual([]);
  });

  it("rejects receipt values that violate the binding's declared type", () => {
    const flow = evidenceFlow();
    const reservation = reserve(flow, activeStep(flow), "case-wrong-type", CASE_TOOL, { member: "m-1" });
    const succeeded = settle(
      reservation.state,
      reservation.receipt.id,
      "succeeded",
      { data: { case: { id: 42 } } },
    );

    expect(completeFlowStep(flow, succeeded.state, {})).toMatchObject({ code: "receipt_output_type" });
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects unsafe %s segments in receipt result paths",
    (segment) => {
      const flow = evidenceFlow({ result_path: `$.data.${segment}.polluted` });
      const reservation = reserve(flow, activeStep(flow), `case-path-${segment}`, CASE_TOOL, { member: "m-1" });
      const succeeded = settle(
        reservation.state,
        reservation.receipt.id,
        "succeeded",
        { data: { safe: "value" } },
      );

      expect(completeFlowStep(flow, succeeded.state, {})).toMatchObject({ code: "missing_receipt_output" });
    },
  );

  it("hydrates old persisted flow state with safe evidence-ledger defaults", () => {
    const current = createFlowExecutionState("2026-07-09T23:59:59.000Z");
    const oldPersistedState: Record<string, unknown> = { ...current };
    delete oldPersistedState.capabilityEpoch;
    delete oldPersistedState.actionReceipts;

    const hydrated = FlowExecutionStateSchema.parse(oldPersistedState);
    expect(hydrated.capabilityEpoch).toBe(0);
    expect(hydrated.actionReceipts).toEqual([]);

    const selected = selectFlowTopic(evidenceFlow(), hydrated, TOPIC);
    if ("error" in selected) throw new Error(selected.error);
    expect(selected.capabilityEpoch).toBe(1);
  });

  it("rejects persisted receipt evidence whose canonical hashes were modified", () => {
    const flow = evidenceFlow();
    const reserved = reserve(flow, activeStep(flow), "tamper-evidence", CASE_TOOL, { member: "m-1" });
    const tampered = structuredClone(reserved.state);
    tampered.actionReceipts[0].arguments = { member: "attacker" };
    expect(FlowExecutionStateSchema.safeParse(tampered).success).toBe(false);
  });
});
