import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateAgentFlow } from "../flow";
import { completeFlowStep, createFlowExecutionState, describeNextSteps, enterFlowStep, selectFlowTopic } from "../flow-runtime";

const input = JSON.parse(readFileSync(new URL("../../../examples/flows/membership-and-returns.json", import.meta.url), "utf8"));
const validated = validateAgentFlow(input);

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
    const verified = completeFlowStep(flow, verify.state, { outputs: { member_id: "member_123" } });
    if ("error" in verified) throw new Error(verified.error);

    const renew = enterFlowStep(flow, verified.state, "membership.verify.renew");
    if ("error" in renew) throw new Error(renew.error);
    expect(renew.availableTools).toContain("renew_membership");
    const renewed = completeFlowStep(flow, renew.state, {
      outputs: { renewal_id: "renewal_123", expires_at: "2027-07-09" },
    });
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
