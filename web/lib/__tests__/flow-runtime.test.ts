import { describe, expect, it } from "vitest";
import { AgentFlowSchema, topicNodes, validateAgentFlow } from "../flow";
import {
  allowedStepPaths,
  completeFlowStep,
  createFlowExecutionState,
  describeNextSteps,
  enterFlowStep,
  flowStateSummary,
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
    expect(result.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      level: "warning",
      message: expect.stringContaining("model-authored rather than receipt-bound"),
    }));
  });

  it("reports dangling graph and step transitions", () => {
    const broken = structuredClone(deepFlow);
    broken.edges.push({ from: "missing", to: "returns" });
    broken.nodes[1].steps![0].transitions = [{ to: "returns.nope" }];
    const messages = validateAgentFlow(broken).diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toContain('unknown node "missing"');
    expect(messages).toContain('transition targets unknown step "returns.nope"');
  });

  it("rejects ambiguous path segments, unsafe output keys, and unreachable hidden steps", () => {
    const unsafe = structuredClone(deepFlow);
    unsafe.nodes[1].steps![0].id = "verify.account";
    unsafe.nodes[1].steps![0].required_outputs = ["constructor"];
    const messages = validateAgentFlow(unsafe).diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toContain("Flow v2 step ids must be 1-64 letters, numbers, underscores, or hyphens");
    expect(messages).toContain('unsafe output key "constructor"');

    const hidden = AgentFlowSchema.parse({
      schema_version: 2,
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        { id: "topic", label: "Topic", kind: "topic", steps: [
          { id: "visible", label: "Visible", instructions: "Visible.", entry: true },
          { id: "hidden", label: "Hidden", instructions: "Hidden.", entry: false },
        ] },
      ],
      edges: [{ from: "entry", to: "topic" }],
    });
    expect(validateAgentFlow(hidden).diagnostics).toContainEqual(expect.objectContaining({
      level: "error",
      path: "topic.hidden",
      message: "step is unreachable from every classified entry",
    }));
  });

  it("accepts transition-only topics without exposing them to initial classification", () => {
    expect(validateAgentFlow(crossTopicFlow).diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
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
    expect(flowStateSummary(deepFlow, parentDone.state)).toMatchObject({
      last_completed_step: "returns.verify",
      outputs: { "returns.verify": { order_id: "order_123" } },
    });

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

  it("does not allow reclassification to abandon a pending child or reopen a terminal flow", () => {
    const selected = selectFlowTopic(deepFlow, createFlowExecutionState(), "returns");
    if ("error" in selected) throw new Error(selected.error);
    const verify = enterFlowStep(deepFlow, selected, "returns.verify");
    if ("error" in verify) throw new Error(verify.error);
    const verified = completeFlowStep(deepFlow, verify.state, { outputs: { order_id: "order_123" } });
    if ("error" in verified) throw new Error(verified.error);
    expect(selectFlowTopic(deepFlow, verified.state, "other")).toMatchObject({
      code: "pending_flow_transition",
      allowed: ["returns.verify.eligibility"],
    });

    const eligibility = enterFlowStep(deepFlow, verified.state, "returns.verify.eligibility");
    if ("error" in eligibility) throw new Error(eligibility.error);
    const finished = completeFlowStep(deepFlow, eligibility.state, { outputs: { eligible: false } });
    if ("error" in finished) throw new Error(finished.error);
    expect(selectFlowTopic(deepFlow, finished.state, "returns")).toMatchObject({ code: "flow_finished" });
  });

  it("matches structured branch values canonically and never treats a missing value as not-equal", () => {
    const structured = AgentFlowSchema.parse({
      schema_version: 2,
      always_tools: [],
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        { id: "route", label: "Route", kind: "topic", steps: [
          { id: "capture", label: "Capture", instructions: "Capture.", transitions: [{
            to: "route.finish",
            condition: { output: "decision", operator: "equals", value: { code: 7, tags: ["a", "b"] } },
          }] },
          { id: "finish", label: "Finish", instructions: "Finish." },
        ] },
      ],
      edges: [{ from: "entry", to: "route" }],
    });
    const selected = selectFlowTopic(structured, createFlowExecutionState(), "route");
    if ("error" in selected) throw new Error(selected.error);
    const entered = enterFlowStep(structured, selected, "route.capture");
    if ("error" in entered) throw new Error(entered.error);
    const matched = completeFlowStep(structured, entered.state, {
      outputs: { decision: { tags: ["a", "b"], code: 7 } },
    });
    if ("error" in matched) throw new Error(matched.error);
    expect(matched.nextSteps).toEqual(["route.finish"]);

    const missingFlow = structuredClone(structured);
    missingFlow.nodes[1].steps![0].transitions![0].condition = {
      output: "missing",
      operator: "not_equals",
      value: "blocked",
    };
    const missingSelected = selectFlowTopic(missingFlow, createFlowExecutionState(), "route");
    if ("error" in missingSelected) throw new Error(missingSelected.error);
    const missingEntered = enterFlowStep(missingFlow, missingSelected, "route.capture");
    if ("error" in missingEntered) throw new Error(missingEntered.error);
    const missing = completeFlowStep(missingFlow, missingEntered.state, { outputs: {} });
    if ("error" in missing) throw new Error(missing.error);
    expect(missing.nextSteps).toEqual([]);
  });

  it("invalidates completed descendant outputs and checkpoints when a cycle re-enters an ancestor", () => {
    const cyclic = AgentFlowSchema.parse({
      schema_version: 2,
      always_tools: [],
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        { id: "work", label: "Work", kind: "topic", steps: [{
          id: "parent", label: "Parent", instructions: "Parent.", entry: true, checkpoint: true, steps: [{
            id: "child", label: "Child", instructions: "Child.", checkpoint: true, transitions: [{ to: "work.parent" }],
          }],
        }] },
      ],
      edges: [{ from: "entry", to: "work" }],
    });
    const selected = selectFlowTopic(cyclic, createFlowExecutionState(), "work");
    if ("error" in selected) throw new Error(selected.error);
    const parent = enterFlowStep(cyclic, selected, "work.parent");
    if ("error" in parent) throw new Error(parent.error);
    const parentDone = completeFlowStep(cyclic, parent.state, { outputs: { parent_revision: 1 } });
    if ("error" in parentDone) throw new Error(parentDone.error);
    const child = enterFlowStep(cyclic, parentDone.state, "work.parent.child");
    if ("error" in child) throw new Error(child.error);
    const childDone = completeFlowStep(cyclic, child.state, { outputs: { child_revision: 1 } });
    if ("error" in childDone) throw new Error(childDone.error);
    expect(childDone.nextSteps).toEqual(["work.parent"]);
    const reentered = enterFlowStep(cyclic, childDone.state, "work.parent");
    if ("error" in reentered) throw new Error(reentered.error);
    expect(reentered.state.completedSteps).toEqual([]);
    expect(reentered.state.outputs).toEqual({});
    expect(reentered.state.checkpoints).toEqual([]);
  });

  it("supports long successful cycles while keeping consecutive retry limits independent", () => {
    const repeatable = AgentFlowSchema.parse({
      schema_version: 2,
      always_tools: [],
      max_step_entries: 100,
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        { id: "work", label: "Work", kind: "topic", steps: [{
          id: "repeat",
          label: "Repeat",
          instructions: "Complete one repeatable unit.",
          entry: true,
          max_attempts: 2,
          transitions: [{ to: "work.repeat" }],
        }] },
      ],
      edges: [{ from: "entry", to: "work" }],
    });
    let state = selectFlowTopic(repeatable, createFlowExecutionState(), "work");
    if ("error" in state) throw new Error(state.error);
    for (let iteration = 1; iteration <= 25; iteration += 1) {
      const entered = enterFlowStep(repeatable, state, "work.repeat");
      if ("error" in entered) throw new Error(entered.error);
      expect(entered.state.attempts["work.repeat"]).toBe(1);
      expect(entered.state.stepEntries).toBe(iteration);
      const completed = completeFlowStep(repeatable, entered.state, {
        outputs: { iteration },
      });
      if ("error" in completed) throw new Error(completed.error);
      state = completed.state;
    }

    const retryOne = enterFlowStep(repeatable, state, "work.repeat");
    if ("error" in retryOne) throw new Error(retryOne.error);
    const retryTwo = enterFlowStep(repeatable, retryOne.state, "work.repeat");
    if ("error" in retryTwo) throw new Error(retryTwo.error);
    expect(retryTwo.state.attempts["work.repeat"]).toBe(2);
    expect(enterFlowStep(repeatable, retryTwo.state, "work.repeat")).toMatchObject({
      code: "attempt_limit",
    });
  });

  it("does not grant nested-step authority when a transition bypasses its parent", () => {
    const bypass = AgentFlowSchema.parse({
      schema_version: 2,
      always_tools: [],
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        { id: "work", label: "Work", kind: "topic", steps: [
          { id: "start", label: "Start", instructions: "Start.", entry: true, transitions: [{ to: "work.parent.child" }] },
          { id: "parent", label: "Parent", instructions: "Establish parent evidence.", entry: false, tools: ["parent_authority"], steps: [
            { id: "child", label: "Child", instructions: "Use parent evidence." },
          ] },
        ] },
      ],
      edges: [{ from: "entry", to: "work" }],
    });
    const selected = selectFlowTopic(bypass, createFlowExecutionState(), "work");
    if ("error" in selected) throw new Error(selected.error);
    const start = enterFlowStep(bypass, selected, "work.start");
    if ("error" in start) throw new Error(start.error);
    const completed = completeFlowStep(bypass, start.state, { outputs: {} });
    if ("error" in completed) throw new Error(completed.error);
    expect(completed.nextSteps).toEqual(["work.parent.child"]);
    expect(enterFlowStep(bypass, completed.state, "work.parent.child")).toMatchObject({
      code: "ancestor_step_incomplete",
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

  it("counts successful loop iterations toward the call-level step-entry circuit breaker", () => {
    const capped = AgentFlowSchema.parse({
      schema_version: 2,
      always_tools: [],
      max_step_entries: 2,
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        { id: "work", label: "Work", kind: "topic", steps: [{
          id: "repeat",
          label: "Repeat",
          instructions: "Repeat.",
          entry: true,
          transitions: [{ to: "work.repeat" }],
        }] },
      ],
      edges: [{ from: "entry", to: "work" }],
    });
    const selected = selectFlowTopic(capped, createFlowExecutionState(), "work");
    if ("error" in selected) throw new Error(selected.error);
    const first = enterFlowStep(capped, selected, "work.repeat");
    if ("error" in first) throw new Error(first.error);
    const firstDone = completeFlowStep(capped, first.state, { outputs: {} });
    if ("error" in firstDone) throw new Error(firstDone.error);
    const second = enterFlowStep(capped, firstDone.state, "work.repeat");
    if ("error" in second) throw new Error(second.error);
    const secondDone = completeFlowStep(capped, second.state, { outputs: {} });
    if ("error" in secondDone) throw new Error(secondDone.error);
    expect(enterFlowStep(capped, secondDone.state, "work.repeat")).toMatchObject({
      code: "flow_entry_limit",
    });
  });
});
