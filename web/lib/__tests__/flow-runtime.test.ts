import { describe, expect, it } from "vitest";
import { AgentFlowSchema, validateAgentFlow } from "../flow";
import {
  completeFlowStep,
  createFlowExecutionState,
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
          steps: [
            {
              id: "eligibility",
              label: "Check eligibility",
              instructions: "Check the return window and item condition.",
              tools: ["check_return_policy"],
              required_outputs: ["eligible"],
              transitions: [{ to: "returns.refund", when: "eligible is true" }],
            },
          ],
        },
        {
          id: "refund",
          label: "Issue refund",
          instructions: "Confirm the amount and issue the refund.",
          tools: ["issue_refund"],
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
      allowed: ["returns.verify", "returns.refund"],
    });
  });
});
