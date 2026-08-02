import assert from "node:assert/strict";
import test from "node:test";
import {
  HaccRuntimeError,
  createTestRuntime,
  defineAgent,
  defineFlow,
  defineScenario,
  defineTool,
} from "../dist/index.js";

function fixture() {
  const write = defineTool({
    name: "record.write",
    description: "Writes a deterministic fixture record.",
    effect: "write",
    execute: (input) => ({ saved: input }),
  });
  const hidden = defineTool({
    name: "admin.hidden",
    description: "Must not be available in the public step.",
    execute: () => ({ ok: true }),
  });
  const flow = defineFlow({
    id: "test-flow",
    version: "1",
    initial: "start",
    steps: [
      {
        id: "start",
        label: "Start",
        instructions: "Write once.",
        tools: ["record.write"],
        toolPolicies: [{ tool: "record.write", maxCalls: 1 }],
        requiredOutputs: ["result.saved"],
      },
    ],
  });
  return defineAgent({
    id: "test-agent",
    name: "Test",
    instructions: "Test deterministic scope.",
    flow,
    tools: [write, hidden],
  });
}

test("runtime denies tools outside the active capability frontier", async () => {
  const runtime = createTestRuntime({ agent: fixture(), now: () => 1 });
  await assert.rejects(
    runtime.invokeTool("admin.hidden", {}),
    (error) => error instanceof HaccRuntimeError && error.code === "tool_not_active",
  );
});

test("runtime enforces required outputs and per-step call limits", async () => {
  const runtime = createTestRuntime({ agent: fixture(), now: () => 1 });
  assert.throws(
    () => runtime.completeStep(),
    (error) => error instanceof HaccRuntimeError && error.code === "missing_required_output",
  );
  await runtime.invokeTool("record.write", { value: 1 });
  await assert.rejects(
    runtime.invokeTool("record.write", { value: 2 }),
    (error) => error instanceof HaccRuntimeError && error.code === "tool_call_limit",
  );
  assert.equal(runtime.completeStep({ result: { saved: true } }).currentStepId, null);
});

test("scenario assertions fail closed", async () => {
  const runtime = createTestRuntime({ agent: fixture(), now: () => 1 });
  const scenario = defineScenario({
    id: "wrong-step",
    description: "Intentionally names the wrong active step.",
    events: [{ type: "expect", step: "missing" }],
  });
  await assert.rejects(
    runtime.runScenario(scenario),
    (error) => error instanceof HaccRuntimeError && error.code === "scenario_assertion",
  );
});

test("flow definitions snapshot nested capability arrays", () => {
  const tools = ["record.write"];
  const steps = [{ id: "start", label: "Start", instructions: "Start.", tools }];
  const flow = defineFlow({ id: "immutable-flow", version: "1", initial: "start", steps });
  tools.push("admin.hidden");
  steps[0].label = "Mutated";
  assert.deepEqual(flow.steps[0].tools, ["record.write"]);
  assert.equal(flow.steps[0].label, "Start");
});
