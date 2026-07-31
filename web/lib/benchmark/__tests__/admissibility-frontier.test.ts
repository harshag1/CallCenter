import { describe, expect, it } from "vitest";
import { computeAdmissibilityFrontier } from "../admissibility-frontier";
import { compileConditionSuite } from "../condition-compiler";
import { longUsefulnessTask } from "../long-call-live-experiment";
import { PILOT_V2_DEVELOPMENT_SUITE } from "../pilot-v2-suite";
import { createToolWorld, executeTool } from "../tool-world";

describe("host-managed admissibility frontier", () => {
  it("withholds future-turn actions, preserves argument checks, and emits no oracle values", () => {
    const task = longUsefulnessTask("museum");
    const condition = compileConditionSuite(task.compiler_input).conditions["host-managed-harness"];
    const oracle = PILOT_V2_DEVELOPMENT_SUITE.find((candidate) => candidate.family === "museum");
    if (!oracle) throw new Error("museum oracle is unavailable");
    let world = createToolWorld(task.scenario);
    for (const invocation of oracle.oracleInvocations.slice(0, 4)) {
      world = executeTool(task.scenario, world, {
        invocation_id: `frontier-${invocation.invocationId}`,
        tool: invocation.tool,
        arguments: invocation.arguments,
        turn: invocation.turn,
      }).state;
    }
    const target = "step:museum_case.recover_reversible_action_and_clearance";
    const before = computeAdmissibilityFrontier({
      condition,
      scenario: task.scenario,
      world,
      turn: 9,
      target,
      catalogMode: "target",
    });
    expect(before.capabilities.map((capability) => capability.name)).not.toContain("hold_bonded_courier");

    const after = computeAdmissibilityFrontier({
      condition,
      scenario: task.scenario,
      world,
      turn: 10,
      target,
      catalogMode: "target",
    });
    expect(after.capabilities.map((capability) => capability.name)).toContain("hold_bonded_courier");
    const hold = after.evidence.actions.find((action) => action.action === "hold_bonded_courier");
    expect(hold).toMatchObject({
      admissible: true,
      failed_host_prerequisite_ids: [],
    });
    expect(hold?.deferred_prerequisite_ids).toContain("action_code_matches");

    const encoded = JSON.stringify(after.evidence);
    expect(encoded).not.toContain("HOLD-CUR-52");
    expect(encoded).not.toContain("expected_reversible_action_code");
    expect(encoded).not.toContain(task.scenario.caller.turns[9].utterance);
  });
});
