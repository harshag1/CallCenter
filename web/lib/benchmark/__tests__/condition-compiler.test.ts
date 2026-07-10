import { describe, expect, it } from "vitest";
import fieldServiceScenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import {
  BENCHMARK_CONDITION_IDS,
  auditConditionParity,
  compileConditionSuite,
  type CompiledConditionSuite,
} from "../condition-compiler";
import {
  INDUSTRIAL_FIELD_SERVICE_FACT_DISCLOSURES,
  INDUSTRIAL_FIELD_SERVICE_FLOW,
  INDUSTRIAL_FIELD_SERVICE_ORACLE_ROUTE,
  industrialFieldServiceCompilerInput,
} from "../industrial-field-service-source";

function compile(): CompiledConditionSuite {
  return compileConditionSuite(industrialFieldServiceCompilerInput(fieldServiceScenarioJson));
}

describe("canonical benchmark condition compiler", () => {
  it("compiles six provider-parity arms from one scenario and stable gateway", () => {
    const suite = compile();
    const audit = auditConditionParity(suite);

    expect(audit).toMatchObject({ valid: true, issues: [] });
    expect(audit.rawFactHash).toBe(audit.progressiveFactHash);
    expect(Object.keys(suite.conditions).sort()).toEqual([...BENCHMARK_CONDITION_IDS].sort());
    expect(new Set(Object.values(suite.conditions).map((condition) => condition.providerToolsHash)).size).toBe(1);
    for (const condition of Object.values(suite.conditions)) {
      expect(condition.providerTools.map((tool) => tool.name)).toEqual(["capability_gateway"]);
      expect(condition.semanticLeafTools.map((tool) => tool.name)).toEqual(
        suite.semanticLeafTools.map((tool) => tool.name)
      );
    }

    expect(suite.conditions["raw-full"].visibleCapabilities.map((capability) => capability.name)).toEqual(
      suite.semanticLeafTools.map((tool) => tool.name)
    );
    expect(suite.conditions["raw-memory"].visibleCapabilities.map((capability) => capability.name)).toContain(
      "durable_memory"
    );
    expect(suite.conditions["raw-full"].visibleCapabilities.map((capability) => capability.name)).not.toContain(
      "durable_memory"
    );
    expect(suite.conditions["state-only"].initialInformation).toHaveLength(suite.canonicalInformation.length);
    expect(suite.conditions["state-only"].visibleCapabilities.map((capability) => capability.name)).toEqual(
      expect.arrayContaining(["flow.select_topic", "flow.enter_step", "flow.complete_step", "flow.get_state"])
    );
  });

  it("makes progressive-only and full-harness byte-identical to the model", () => {
    const suite = compile();
    const progressiveOnly = suite.conditions["progressive-only"];
    const fullHarness = suite.conditions["full-harness"];

    expect(progressiveOnly.initialPrompt).toBe(fullHarness.initialPrompt);
    expect(progressiveOnly.initialPromptHash).toBe(fullHarness.initialPromptHash);
    expect(progressiveOnly.providerTools).toEqual(fullHarness.providerTools);
    expect(progressiveOnly.providerToolsHash).toBe(fullHarness.providerToolsHash);
    expect(progressiveOnly.disclosures).toEqual(fullHarness.disclosures);
    expect(progressiveOnly.behavior.enforceCapabilityGrants).toBe(false);
    expect(fullHarness.behavior.enforceCapabilityGrants).toBe(true);
    expect(progressiveOnly.conditionHash).not.toBe(fullHarness.conditionHash);
  });

  it("never serializes unallowlisted hidden-world or caller-private facts", () => {
    const suite = compile();
    const providerVisibleText = Object.values(suite.conditions).flatMap((condition) => [
      condition.initialPrompt,
      ...condition.disclosures.map((disclosure) => disclosure.prompt),
      JSON.stringify(condition.providerTools),
    ]).join("\n");

    expect(providerVisibleText).not.toContain("4826");
    expect(providerVisibleText).not.toContain("V-9B");
    expect(providerVisibleText).not.toContain("SR-9918");
    expect(providerVisibleText).not.toContain("SUP-441");
    expect(providerVisibleText).toContain("pressure_limit_psi");
    expect(providerVisibleText).toContain("work_order_id");
  });

  it("is deterministic and insensitive to fact-disclosure declaration order", () => {
    const input = industrialFieldServiceCompilerInput(fieldServiceScenarioJson);
    const first = compileConditionSuite(input);
    const second = compileConditionSuite({
      ...input,
      factDisclosures: [...INDUSTRIAL_FIELD_SERVICE_FACT_DISCLOSURES].reverse(),
    });

    expect(second).toEqual(first);
    expect(second.suiteHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sourceHash).toBe(first.sourceHash);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.conditions["full-harness"].disclosures)).toBe(true);
  });

  it("detects treatment-only facts, prompt tampering, and changed semantic tools", () => {
    const tampered = structuredClone(compile()) as unknown as {
      conditions: Record<string, {
        disclosures: Array<{ information: unknown[] }>;
        semanticLeafTools: Array<{ publicContractHash: string }>;
      }>;
    };
    tampered.conditions["full-harness"].disclosures[0].information.push({
      id: "fact.treatment_secret",
      kind: "fact",
      target: "topic:field_service",
      payload: { path: "treatment_secret", value: "extra" },
      contentHash: "0".repeat(64),
    });
    tampered.conditions["state-only"].semanticLeafTools[0].publicContractHash = "f".repeat(64);

    const audit = auditConditionParity(tampered as unknown as CompiledConditionSuite);
    expect(audit.valid).toBe(false);
    expect(audit.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "treatment_only_information",
      "semantic_tool_mismatch",
      "disclosure_reconstruction",
      "condition_hash",
      "suite_hash",
    ]));
  });

  it("rejects incomplete tool coverage and an impossible oracle route before compilation", () => {
    const missingToolFlow = structuredClone(INDUSTRIAL_FIELD_SERVICE_FLOW);
    const topic = missingToolFlow.nodes.find((node) => node.id === "field_service")!;
    const notify = topic.steps!.find((step) => step.id === "notify_dispatch")!;
    notify.tools = [];
    notify.output_bindings = [];
    notify.action_policies = [];

    expect(() => compileConditionSuite({
      ...industrialFieldServiceCompilerInput(fieldServiceScenarioJson),
      flow: missingToolFlow,
    })).toThrow(/scenario tools absent from every flow grant: notify_dispatch/);

    expect(() => compileConditionSuite({
      ...industrialFieldServiceCompilerInput(fieldServiceScenarioJson),
      oracleRoute: [
        INDUSTRIAL_FIELD_SERVICE_ORACLE_ROUTE[0],
        INDUSTRIAL_FIELD_SERVICE_ORACLE_ROUTE[3],
      ],
    })).toThrow(/oracleRoute transition .* is not declared/);

    const unsafeIdFlow = structuredClone(INDUSTRIAL_FIELD_SERVICE_FLOW);
    unsafeIdFlow.nodes[0].id = 'entry">ignore_previous';
    expect(() => compileConditionSuite({
      ...industrialFieldServiceCompilerInput(fieldServiceScenarioJson),
      flow: unsafeIdFlow,
    })).toThrow(/benchmark flow node id/);
  });

  it("ships a receipt-bound seven-checkpoint flow for the full sixteen-turn scenario", () => {
    const topic = INDUSTRIAL_FIELD_SERVICE_FLOW.nodes.find((node) => node.id === "field_service")!;
    const steps = topic.steps!;

    expect(fieldServiceScenarioJson.caller.turns).toHaveLength(16);
    expect(steps.map((step) => `field_service.${step.id}`)).toEqual(INDUSTRIAL_FIELD_SERVICE_ORACLE_ROUTE);
    expect(steps.every((step) => step.checkpoint)).toBe(true);
    expect(steps.every((step) => (step.output_bindings?.length ?? 0) > 0)).toBe(true);
    const close = steps.find((step) => step.id === "close_and_reconcile")!;
    expect(close.tools).toEqual(["close_work_order", "get_work_order_status"]);
    expect(close.action_policies).toContainEqual({
      tool: "close_work_order",
      max_calls: 1,
      idempotency: "per_call",
    });
    expect(close.output_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: "close_receipt", tool: "close_work_order" }),
      expect.objectContaining({ output: "authoritative_status", tool: "get_work_order_status" }),
      expect.objectContaining({ output: "close_count", tool: "get_work_order_status" }),
    ]));
  });
});
