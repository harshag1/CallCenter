import { describe, expect, it } from "vitest";
import { activeFlowContext, activeFlowControlDefinitions } from "../active-capability-flow";
import { AgentFlowSchema } from "../flow";
import {
  completeFlowStep,
  createFlowExecutionState,
  enterFlowStep,
  hashFlowValue,
  selectFlowTopic,
  type FlowExecutionState,
} from "../flow-runtime";

const flow = AgentFlowSchema.parse({
  schema_version: 2,
  tool_exposure: "gateway",
  always_tools: [],
  always_action_policies: [],
  nodes: [
    { id: "entry", label: "Incoming", kind: "incoming_call" },
    {
      id: "membership",
      label: "Membership",
      kind: "topic",
      context: "Membership status, renewal, and plan changes.",
      steps: [{
        id: "renew",
        label: "Renew membership",
        instructions: "Confirm that the caller wants to renew.",
        entry: true,
        steps: [{
          id: "verify_identity",
          label: "Verify identity",
          context: "Use the membership record, not caller assertions alone.",
          instructions: "Verify the member ID and postal code before any renewal action.",
          success_criteria: ["The membership record matches both fields."],
          required_outputs: ["member_id", "identity_verified"],
          max_attempts: 2,
          tools: ["lookup_membership"],
          action_policies: [{ tool: "lookup_membership", idempotency: "per_arguments", max_calls: 2 }],
        }],
      }],
    },
    {
      id: "returns",
      label: "Returns",
      kind: "topic",
      context: "Start or inspect a merchandise return.",
      steps: [{ id: "start", label: "Start return", instructions: "Ask for the order ID.", entry: true }],
    },
  ],
  edges: [
    { from: "entry", to: "membership" },
    { from: "entry", to: "returns" },
  ],
});

function expectState(value: FlowExecutionState | { error: string }): FlowExecutionState {
  if ("error" in value) throw new Error(value.error);
  return value;
}

function deepState(): FlowExecutionState {
  const selected = expectState(selectFlowTopic(flow, createFlowExecutionState("2026-01-01T00:00:00.000Z"), "membership"));
  const enteredParent = enterFlowStep(flow, selected, "membership.renew", "2026-01-01T00:00:01.000Z");
  if ("error" in enteredParent) throw new Error(enteredParent.error);
  const completedParent = completeFlowStep(flow, enteredParent.state, {
    path: "membership.renew",
    outputs: {},
  }, "2026-01-01T00:00:02.000Z");
  if ("error" in completedParent) throw new Error(completedParent.error);
  const enteredDeep = enterFlowStep(
    flow,
    completedParent.state,
    "membership.renew.verify_identity",
    "2026-01-01T00:00:03.000Z",
  );
  if ("error" in enteredDeep) throw new Error(enteredDeep.error);
  return enteredDeep.state;
}

describe("active Flow-v2 capability projection", () => {
  it("starts with only exact routing controls and topic context", () => {
    const state = createFlowExecutionState("2026-01-01T00:00:00.000Z");
    const controls = activeFlowControlDefinitions(flow, state);
    expect(controls.map((tool) => tool.name)).toEqual(["classify", "get_flow_state"]);
    expect(controls[0].inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        topic: { type: "string", enum: ["membership", "returns", "other"] },
      },
      required: ["topic"],
    });
    expect(activeFlowContext(flow, state)).toMatchObject({
      catalog_mode: "routing",
      status: "routing",
      routing_options: [
        { topic: "membership", label: "Membership" },
        { topic: "returns", label: "Returns" },
      ],
      completed_steps: [],
      durable_outputs: {},
    });
  });

  it("narrows transition and deep-step controls to paths the runtime will accept", () => {
    const selected = expectState(selectFlowTopic(
      flow,
      createFlowExecutionState("2026-01-01T00:00:00.000Z"),
      "membership",
    ));
    const transitionControls = activeFlowControlDefinitions(flow, selected);
    expect(transitionControls.map((tool) => tool.name)).toEqual(["enter_step", "get_flow_state"]);
    expect(transitionControls[0].inputSchema).toMatchObject({
      properties: { path: { enum: ["membership.renew"] } },
    });

    const deep = deepState();
    const deepControls = activeFlowControlDefinitions(flow, deep);
    expect(deepControls.map((tool) => tool.name)).toEqual([
      "complete_step",
      "enter_step",
      "get_flow_state",
    ]);
    expect(deepControls.find((tool) => tool.name === "complete_step")?.inputSchema).toMatchObject({
      properties: { path: { const: "membership.renew.verify_identity" } },
    });
    expect(deepControls.find((tool) => tool.name === "enter_step")?.inputSchema).toMatchObject({
      properties: { path: { enum: ["membership.renew.verify_identity"] } },
    });
    expect(activeFlowContext(flow, deep)).toMatchObject({
      catalog_mode: "step",
      topic: "membership",
      current_step: "membership.renew.verify_identity",
      attempt: 1,
      active_step: {
        instructions: "Verify the member ID and postal code before any renewal action.",
        required_outputs: ["member_id", "identity_verified"],
        max_attempts: 2,
      },
      completed_steps: ["membership.renew"],
      durable_outputs: { "membership.renew": {} },
    });
  });

  it("discloses reconcile_action only for exact indeterminate receipt ids", () => {
    const deep = deepState();
    const receiptId = "123e4567-e89b-12d3-a456-426614174000";
    const withReceipt: FlowExecutionState = {
      ...deep,
      actionReceipts: [{
        id: receiptId,
        idempotencyKey: "lookup-membership-once",
        step: deep.currentStep!,
        tool: "lookup_membership",
        capabilityEpoch: deep.capabilityEpoch,
        arguments: { member_id: "m-1" },
        argumentsHash: hashFlowValue({ member_id: "m-1" }),
        invocationId: "A".repeat(24),
        providerInvocationId: "provider-call-1",
        dispatchStartedAt: "2026-01-01T00:00:04.000Z",
        dispatchAttempt: 1,
        status: "indeterminate",
        reservedAt: "2026-01-01T00:00:03.500Z",
        settledAt: "2026-01-01T00:00:05.000Z",
      }],
    };
    const controls = activeFlowControlDefinitions(flow, withReceipt);
    expect(controls.map((tool) => tool.name)).toEqual([
      "complete_step",
      "get_flow_state",
      "reconcile_action",
    ]);
    expect(controls.find((tool) => tool.name === "reconcile_action")?.inputSchema).toMatchObject({
      properties: { receipt_id: { enum: [receiptId] } },
    });
    expect(activeFlowContext(flow, withReceipt)).toMatchObject({
      pending_action_receipts: [{ receipt_id: receiptId, status: "indeterminate" }],
    });
  });
});
