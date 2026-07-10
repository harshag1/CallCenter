import { describe, expect, it } from "vitest";
import { AgentFlowSchema, topicNodes, validateAgentFlow } from "../flow";
import {
  allowedStepPaths,
  completeFlowStep,
  createFlowExecutionState,
  describeNextSteps,
  enterFlowStep,
  grantedTools,
  selectFlowTopic,
} from "../flow-runtime";

const deepFlow = AgentFlowSchema.parse({
  schema_version: 2,
  always_tools: ["end_call"],
  nodes: [
    { id: "entry", label: "Incoming call", kind: "incoming_call" },
    {
      id: "returns",
      label: "Start a return",
      kind: "topic",
      context: "Help the caller return an eligible order.",
      tools: ["lookup_order"],
      steps: [
        {
          id: "verify",
          label: "Verify order",
          instructions: "Ask for the order number and verify ownership.",
          tools: ["verify_customer"],
          required_outputs: ["order_id"],
          checkpoint: true,
          max_attempts: 2,
          on_failure: "returns.escalate",
          steps: [
            {
              id: "eligibility",
              label: "Check eligibility",
              instructions: "Check the return window and item condition.",
              tools: ["check_return_policy"],
              required_outputs: ["eligible"],
              transitions: [{
                to: "returns.refund",
                when: "eligible is true",
                condition: { output: "eligible", operator: "equals", value: true },
              }],
            },
          ],
        },
        {
          id: "refund",
          label: "Issue refund",
          instructions: "Confirm the amount and issue the refund.",
          tools: ["issue_refund"],
        },
        {
          id: "escalate",
          label: "Escalate verification",
          instructions: "Do not reveal account data; transfer to a human.",
        },
      ],
    },
    { id: "other", label: "Human help", kind: "fallback", support_number: "+15551234567" },
  ],
  edges: [
    { from: "entry", to: "returns" },
    { from: "entry", to: "other" },
  ],
});

const crossTopicFlow = AgentFlowSchema.parse({
  schema_version: 2,
  nodes: [
    { id: "entry", label: "Incoming call", kind: "incoming_call" },
    {
      id: "intake",
      label: "Intake",
      kind: "topic",
      steps: [{
        id: "capture",
        label: "Capture request",
        instructions: "Capture and validate the request.",
        required_outputs: ["valid"],
        transitions: [{
          to: "fulfillment.execute",
          when: "the request is valid",
          condition: { output: "valid", operator: "equals", value: true },
        }],
      }],
    },
    {
      id: "fulfillment",
      label: "Fulfillment",
      kind: "topic",
      steps: [{ id: "execute", label: "Execute request", instructions: "Execute the validated request." }],
    },
  ],
  edges: [
    { from: "entry", to: "intake" },
    { from: "intake", to: "fulfillment" },
  ],
});
describe("flow v2 validation", () => {
  it("accepts arbitrarily nested, explicitly transitioned steps", () => {
    const result = validateAgentFlow(deepFlow);
    expect(result.flow).toBeDefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("reports dangling graph and step transitions", () => {
    const broken = structuredClone(deepFlow);
    broken.edges.push({ from: "missing", to: "returns" });
    broken.nodes[1].steps![0].transitions = [{ to: "returns.nope" }];
    const messages = validateAgentFlow(broken).diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toContain('unknown node "missing"');
    expect(messages).toContain('transition targets unknown step "returns.nope"');
  });

  it("accepts transition-only topics without exposing them to initial classification", () => {
    expect(validateAgentFlow(crossTopicFlow).diagnostics).toEqual([]);
    expect(topicNodes(crossTopicFlow).map((node) => node.id)).toEqual(["intake"]);
    expect(selectFlowTopic(crossTopicFlow, createFlowExecutionState(), "fulfillment")).toMatchObject({
      code: "transition_only_topic",
    });
  });
});

describe("flow v2 execution", () => {
  it("reveals tools only as the call enters deeper steps", () => {
    const initial = createFlowExecutionState("2026-07-09T00:00:00.000Z");
    const selected = selectFlowTopic(deepFlow, initial, "returns", "2026-07-09T00:00:01.000Z");
    if ("error" in selected) throw new Error(selected.error);
    expect(grantedTools(deepFlow, selected)).toEqual(["end_call", "lookup_order"]);

    const parent = enterFlowStep(deepFlow, selected, "returns.verify", "2026-07-09T00:00:02.000Z");
    if ("error" in parent) throw new Error(parent.error);
    expect(parent.availableTools).toEqual(["end_call", "lookup_order", "verify_customer"]);

    const parentDone = completeFlowStep(
      deepFlow,
      parent.state,
      { outputs: { order_id: "order_123" } },
      "2026-07-09T00:00:03.000Z"
    );
    if ("error" in parentDone) throw new Error(parentDone.error);
    expect(parentDone.nextSteps).toEqual(["returns.verify.eligibility"]);
    expect(parentDone.state.checkpoints).toEqual([{ step: "returns.verify", at: "2026-07-09T00:00:03.000Z" }]);
    expect(grantedTools(deepFlow, parentDone.state)).toEqual(["end_call", "lookup_order"]);

    const child = enterFlowStep(deepFlow, parentDone.state, "returns.verify.eligibility");
    if ("error" in child) throw new Error(child.error);
    expect(child.availableTools).toEqual([
      "end_call",
      "lookup_order",
      "verify_customer",
      "check_return_policy",
    ]);
  });

  it("refuses completion until required outputs are persisted", () => {
    const selected = selectFlowTopic(deepFlow, createFlowExecutionState(), "returns");
    if ("error" in selected) throw new Error(selected.error);
    const entered = enterFlowStep(deepFlow, selected, "returns.verify");
    if ("error" in entered) throw new Error(entered.error);
    expect(completeFlowStep(deepFlow, entered.state, { outputs: {} })).toMatchObject({
      code: "missing_outputs",
    });
  });

  it("prevents jumping into a nested step without entering its parent", () => {
    const selected = selectFlowTopic(deepFlow, createFlowExecutionState(), "returns");
    if ("error" in selected) throw new Error(selected.error);
    expect(enterFlowStep(deepFlow, selected, "returns.verify.eligibility")).toMatchObject({
      code: "step_not_reachable",
      allowed: ["returns.verify"],
    });
  });

  it("does not unlock children or later top-level targets before durable completion", () => {
    const selected = selectFlowTopic(deepFlow, createFlowExecutionState(), "returns");
    if ("error" in selected) throw new Error(selected.error);
    expect(allowedStepPaths(deepFlow, selected)).toEqual(["returns.verify"]);

    const entered = enterFlowStep(deepFlow, selected, "returns.verify");
    if ("error" in entered) throw new Error(entered.error);
    expect(allowedStepPaths(deepFlow, entered.state)).toEqual([]);
    expect(enterFlowStep(deepFlow, entered.state, "returns.verify.eligibility")).toMatchObject({
      code: "step_not_reachable",
      allowed: [],
    });
    expect(enterFlowStep(deepFlow, entered.state, "returns.refund")).toMatchObject({
      code: "step_not_reachable",
      allowed: [],
    });
  });

  it("unlocks a labeled failure path at the retry ceiling and excludes it after success", () => {
    const selected = selectFlowTopic(deepFlow, createFlowExecutionState(), "returns");
    if ("error" in selected) throw new Error(selected.error);
    const first = enterFlowStep(deepFlow, selected, "returns.verify");
    if ("error" in first) throw new Error(first.error);
    const retry = enterFlowStep(deepFlow, first.state, "returns.verify");
    if ("error" in retry) throw new Error(retry.error);
    expect(describeNextSteps(deepFlow, retry.state)).toEqual([
      expect.objectContaining({ path: "returns.escalate", kind: "failure" }),
    ]);

    const succeeded = completeFlowStep(deepFlow, retry.state, { outputs: { order_id: "order_123" } });
    if ("error" in succeeded) throw new Error(succeeded.error);
    expect(succeeded.nextSteps).toEqual(["returns.verify.eligibility"]);
  });

  it("enforces transition conditions against durable step outputs", () => {
    const reachEligibility = () => {
      const selected = selectFlowTopic(deepFlow, createFlowExecutionState(), "returns");
      if ("error" in selected) throw new Error(selected.error);
      const verify = enterFlowStep(deepFlow, selected, "returns.verify");
      if ("error" in verify) throw new Error(verify.error);
      const verified = completeFlowStep(deepFlow, verify.state, { outputs: { order_id: "order_123" } });
      if ("error" in verified) throw new Error(verified.error);
      const eligibility = enterFlowStep(deepFlow, verified.state, "returns.verify.eligibility");
      if ("error" in eligibility) throw new Error(eligibility.error);
      return eligibility.state;
    };

    const ineligible = completeFlowStep(deepFlow, reachEligibility(), { outputs: { eligible: false } });
    if ("error" in ineligible) throw new Error(ineligible.error);
    expect(ineligible.nextSteps).toEqual([]);
    expect(ineligible.state.status).toBe("completed");

    const eligible = completeFlowStep(deepFlow, reachEligibility(), { outputs: { eligible: true } });
    if ("error" in eligible) throw new Error(eligible.error);
    expect(eligible.nextSteps).toEqual(["returns.refund"]);
  });

  it("treats repeated completion as idempotent", () => {
    const selected = selectFlowTopic(deepFlow, createFlowExecutionState(), "returns");
    if ("error" in selected) throw new Error(selected.error);
    const entered = enterFlowStep(deepFlow, selected, "returns.verify");
    if ("error" in entered) throw new Error(entered.error);
    const first = completeFlowStep(deepFlow, entered.state, { outputs: { order_id: "order_123" } });
    if ("error" in first) throw new Error(first.error);
    const repeated = completeFlowStep(deepFlow, first.state, { path: "returns.verify", outputs: { order_id: "other" } });
    if ("error" in repeated) throw new Error(repeated.error);
    expect(repeated.state).toBe(first.state);
    expect(repeated.state.outputs["returns.verify"]).toEqual({ order_id: "order_123" });
  });

  it("supports guarded transitions across topic boundaries", () => {
    const selected = selectFlowTopic(crossTopicFlow, createFlowExecutionState(), "intake");
    if ("error" in selected) throw new Error(selected.error);
    const entered = enterFlowStep(crossTopicFlow, selected, "intake.capture");
    if ("error" in entered) throw new Error(entered.error);
    expect(enterFlowStep(crossTopicFlow, entered.state, "fulfillment.execute")).toMatchObject({
      code: "wrong_topic",
    });
    const completed = completeFlowStep(crossTopicFlow, entered.state, { outputs: { valid: true } });
    if ("error" in completed) throw new Error(completed.error);
    expect(describeNextSteps(crossTopicFlow, completed.state)).toEqual([
      expect.objectContaining({
        path: "fulfillment.execute",
        kind: "transition",
        when: "the request is valid",
      }),
    ]);
    const fulfillment = enterFlowStep(crossTopicFlow, completed.state, "fulfillment.execute");
    if ("error" in fulfillment) throw new Error(fulfillment.error);
    expect(fulfillment.state.nodeId).toBe("fulfillment");
  });

  it("does not allow reclassification to abandon an incomplete active step", () => {
    const selected = selectFlowTopic(deepFlow, createFlowExecutionState(), "returns");
    if ("error" in selected) throw new Error(selected.error);
    const entered = enterFlowStep(deepFlow, selected, "returns.verify");
    if ("error" in entered) throw new Error(entered.error);
    expect(selectFlowTopic(deepFlow, entered.state, "other")).toMatchObject({
      code: "active_step_incomplete",
    });
  });

  it("honors an optional call-level step-entry circuit breaker", () => {
    const capped = AgentFlowSchema.parse({ ...deepFlow, max_step_entries: 1 });
    const selected = selectFlowTopic(capped, createFlowExecutionState(), "returns");
    if ("error" in selected) throw new Error(selected.error);
    const first = enterFlowStep(capped, selected, "returns.verify");
    if ("error" in first) throw new Error(first.error);
    expect(enterFlowStep(capped, first.state, "returns.verify")).toMatchObject({
      code: "flow_entry_limit",
    });
  });
});
