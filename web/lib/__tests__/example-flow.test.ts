import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateAgentFlow, type AgentFlow } from "../flow";
import {
  completeFlowStep,
  createFlowExecutionState,
  describeNextSteps,
  enterFlowStep,
  reserveFlowAction,
  selectFlowTopic,
  settleFlowAction,
  type FlowExecutionState,
} from "../flow-runtime";

const input = JSON.parse(readFileSync(new URL("../../../examples/flows/membership-and-returns.json", import.meta.url), "utf8"));
const validated = validateAgentFlow(input);

function successfulAction(
  flow: AgentFlow,
  state: FlowExecutionState,
  receiptId: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown
): FlowExecutionState {
  const reserved = reserveFlowAction(flow, state, {
    receiptId,
    tool,
    arguments: args,
    capabilityEpoch: state.capabilityEpoch,
  });
  if ("error" in reserved) throw new Error(reserved.error);
  const settled = settleFlowAction(reserved.state, { receiptId, status: "succeeded", result });
  if ("error" in settled) throw new Error(settled.error);
  return settled.state;
}

describe("public Flow v2 example", () => {
  it("passes semantic validation", () => {
    expect(validated.diagnostics).toEqual([]);
  });

  it("walks the nested membership-renewal happy path", () => {
    const flow = validated.flow!;
    const state = selectFlowTopic(flow, createFlowExecutionState(), "membership");
    if ("error" in state) throw new Error(state.error);

    const verify = enterFlowStep(flow, state, "membership.verify");
    if ("error" in verify) throw new Error(verify.error);
    const memberLookup = successfulAction(
      flow,
      verify.state,
      "receipt-member",
      "read_table",
      { table: "members", filter: { member_number: "M-123" } },
      { rows: [{ id: "member_123", tier: "premium" }] }
    );
    const verified = completeFlowStep(flow, memberLookup, { outputs: {} });
    if ("error" in verified) throw new Error(verified.error);
    expect(verified.state.outputs["membership.verify"]).toEqual({ member_id: "member_123" });

    const renew = enterFlowStep(flow, verified.state, "membership.verify.renew");
    if ("error" in renew) throw new Error(renew.error);
    expect(renew.availableTools).toContain("renew_membership");
    const renewal = successfulAction(
      flow,
      renew.state,
      "receipt-renewal",
      "renew_membership",
      { member_id: "member_123", term: "one_year" },
      { renewal_id: "renewal_123", expires_at: "2027-07-09" }
    );
    const renewed = completeFlowStep(flow, renewal, { outputs: {} });
    if ("error" in renewed) throw new Error(renewed.error);
    expect(renewed.nextSteps).toEqual(["membership.confirm"]);
    expect(describeNextSteps(flow, renewed.state)).toEqual([
      expect.objectContaining({
        path: "membership.confirm",
        kind: "transition",
        when: "renewal_id was returned",
      }),
    ]);
  });
});
