import { describe, expect, it } from "vitest";
import fieldServiceScenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import { LOCAL_TOOL_PROXY_FUNCTION } from "../../realtime/client/types";
import { canonicalJson } from "../artifacts";
import {
  BENCHMARK_CONDITION_IDS,
  assertCompiledConditionIntegrity,
  auditConditionParity,
  benchmarkFlowHash,
  benchmarkScenarioHash,
  compiledConditionHash,
  compiledConditionSuiteHash,
  compileConditionSuite,
  createConditionSuiteTrustAnchor,
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
    const canonicalLiveGateway = canonicalJson([LOCAL_TOOL_PROXY_FUNCTION]);
    expect(new Set(Object.values(suite.conditions).map((condition) => canonicalJson(condition.providerTools))))
      .toEqual(new Set([canonicalLiveGateway]));
    for (const condition of Object.values(suite.conditions)) {
      expect(condition.providerTools.map((tool) => tool.name)).toEqual(["capability_gateway"]);
      expect(canonicalJson(condition.providerTools)).toBe(canonicalLiveGateway);
      expect(canonicalJson(condition.providerTools)).not.toContain("capability_grant");
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

  it("compiles an attested host-managed lifecycle with no model-authored step completion", () => {
    const suite = compile();
    const managed = suite.conditions["host-managed-harness"];

    expect(managed.behavior).toMatchObject({
      transitionOwnership: "host-managed-linear",
      progressiveDisclosure: true,
      durableFlowState: true,
      enforceTransitions: true,
      enforceCapabilityGrants: true,
      enforceExactlyOnce: true,
    });
    expect(managed.visibleCapabilities.map((capability) => capability.name)).toEqual([
      "flow.get_state",
      "flow.select_topic",
    ]);
    for (const disclosure of managed.disclosures.filter((candidate) => candidate.target.startsWith("step:"))) {
      const controls = disclosure.visibleCapabilities
        .filter((capability) => capability.category === "flow-control")
        .map((capability) => capability.name);
      expect(controls).toEqual(["flow.get_state"]);
    }
    for (const disclosure of managed.disclosures.filter((candidate) => candidate.target.startsWith("topic:"))) {
      const controls = disclosure.visibleCapabilities
        .filter((capability) => capability.category === "flow-control")
        .map((capability) => capability.name);
      expect(controls).toEqual(["flow.enter_step", "flow.get_state"]);
    }
    const controlUnion = new Set([
      ...managed.visibleCapabilities,
      ...managed.disclosures.flatMap((disclosure) => disclosure.visibleCapabilities),
    ].filter((capability) => capability.category === "flow-control").map((capability) => capability.name));
    expect(controlUnion).toEqual(new Set(["flow.select_topic", "flow.enter_step", "flow.get_state"]));
    expect(managed.initialPrompt).toContain("A disclosed capability is permission, not evidence that the action is ready.");
    expect(managed.initialPrompt).toContain("ask one concise question when something is missing");
    expect(managed.initialPrompt).toContain("stop unless the current caller utterance already supplies the next step's required inputs");
    expect(managed.conditionHash).not.toBe(suite.conditions["full-harness"].conditionHash);
  });

  it("fails host-managed compilation when a required output is not receipt-bound", () => {
    const input = structuredClone(industrialFieldServiceCompilerInput(fieldServiceScenarioJson));
    const flow = structuredClone(INDUSTRIAL_FIELD_SERVICE_FLOW);
    const topic = flow.nodes.find((node) => node.id === "field_service")!;
    const locate = topic.steps!.find((step) => step.id === "locate_work_order")!;
    locate.output_bindings = locate.output_bindings!.filter((binding) => binding.output !== "work_order_id");

    expect(() => compileConditionSuite({ ...input, flow })).toThrow(
      /host-managed step "field_service\.locate_work_order" has required outputs without authoritative receipt bindings: work_order_id/,
    );
  });

  it("retains a constrained model branch choice while keeping step lifecycle host-owned", () => {
    const input = industrialFieldServiceCompilerInput(fieldServiceScenarioJson);
    const flow = structuredClone(INDUSTRIAL_FIELD_SERVICE_FLOW);
    const topic = flow.nodes.find((node) => node.id === "field_service")!;
    topic.steps![1].entry = true;

    const managed = compileConditionSuite({ ...input, flow }).conditions["host-managed-harness"];
    const topicDisclosure = managed.disclosures.find((candidate) => candidate.target === "topic:field_service")!;
    expect(topicDisclosure.visibleCapabilities
      .filter((capability) => capability.category === "flow-control")
      .map((capability) => capability.name)).toEqual(["flow.enter_step", "flow.get_state"]);
    expect(managed.disclosures
      .filter((candidate) => candidate.target.startsWith("step:"))
      .every((disclosure) => disclosure.visibleCapabilities
        .filter((capability) => capability.category === "flow-control")
        .every((capability) => capability.name === "flow.get_state"))).toBe(true);
  });

  it("detects transition-ownership tampering independently of a stale condition hash", () => {
    const tampered = structuredClone(compile()) as unknown as {
      conditions: Record<string, { behavior: { transitionOwnership: string } }>;
    };
    tampered.conditions["host-managed-harness"].behavior.transitionOwnership = "model-authored";

    expect(auditConditionParity(tampered as unknown as CompiledConditionSuite).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "condition_behavior", condition: "host-managed-harness" }),
      expect.objectContaining({ code: "condition_hash", condition: "host-managed-harness" }),
    ]));
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

  it("rejects ambiguous or incomplete transported-suite containers before scheduling", () => {
    const transported = structuredClone(compile()) as unknown as {
      schemaVersion: number;
      informationHash: string;
      canonicalInformation: Array<{ id: string }>;
      conditions: Record<string, {
        visibleCapabilities: Array<{ name: string; category: string }>;
        disclosures: Array<{
          target: string;
          information: Array<{ target: string }>;
          visibleCapabilities: Array<{ name: string; category: string }>;
        }>;
      }>;
    };
    transported.schemaVersion = 99;
    transported.informationHash = "0".repeat(64);
    transported.canonicalInformation.push(structuredClone(transported.canonicalInformation[0]));
    const full = transported.conditions["full-harness"];
    full.disclosures.push(structuredClone(full.disclosures[0]));
    full.disclosures[0].information[0].target = "topic:not-the-container";
    full.disclosures[0].visibleCapabilities.push(structuredClone(full.disclosures[0].visibleCapabilities[0]));
    transported.conditions["raw-memory"].visibleCapabilities = transported.conditions["raw-memory"].visibleCapabilities
      .filter((capability) => capability.name !== "durable_memory");

    const audit = auditConditionParity(transported as unknown as CompiledConditionSuite);
    expect(audit.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "suite_schema_version",
      "information_catalog_hash",
      "duplicate_canonical_information",
      "duplicate_disclosure_target",
      "information_container_target",
      "duplicate_capability",
      "durable_memory_contract",
    ]));
  });

  it("self-authenticates behavior flags and binds exact scenario and flow sources", () => {
    const compiled = compile();
    const condition = compiled.conditions["full-harness"];
    expect(() => assertCompiledConditionIntegrity(condition)).not.toThrow();
    expect(benchmarkFlowHash(INDUSTRIAL_FIELD_SERVICE_FLOW)).toBe(compiled.flowHash);
    expect(benchmarkScenarioHash(fieldServiceScenarioJson)).toBe(compiled.scenarioHash);

    const tampered = structuredClone(condition);
    Object.assign(tampered.behavior, { enforceExactlyOnce: false });
    expect(() => assertCompiledConditionIntegrity(tampered)).toThrow(/invalid condition hash/);

    const relabeledSuite = structuredClone(compiled);
    const relabeled = relabeledSuite.conditions["full-harness"] as {
      id: string;
      behavior: { enforceExactlyOnce: boolean };
      conditionHash: string;
    };
    relabeled.id = "progressive-only";
    relabeled.behavior.enforceExactlyOnce = false;
    relabeled.conditionHash = compiledConditionHash(
      relabeled as unknown as CompiledConditionSuite["conditions"]["full-harness"]
    );
    const relabeledAudit = auditConditionParity(relabeledSuite);
    expect(relabeledAudit.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "condition_identity",
      "condition_behavior",
    ]));
  });

  it("rejects a fully rehashed source substitution when checked against its registry trust anchor", () => {
    const original = compile();
    const trustAnchor = createConditionSuiteTrustAnchor(original);
    const transported = structuredClone(original) as unknown as {
      scenarioId: string;
      flowHash: string;
      suiteHash: string;
      conditions: Record<string, { flowHash: string; conditionHash: string }>;
    };
    transported.scenarioId = "field-service-escalation.substituted.v1";
    transported.flowHash = "f".repeat(64);
    for (const condition of Object.values(transported.conditions)) {
      condition.flowHash = transported.flowHash;
      condition.conditionHash = compiledConditionHash(condition as CompiledConditionSuite["conditions"]["full-harness"]);
    }
    transported.suiteHash = compiledConditionSuiteHash(transported as unknown as CompiledConditionSuite);

    // Internal hashes can prove consistency, not provenance. The closed-registry
    // trust anchor is what makes this fail despite the attacker's full rehash.
    expect(auditConditionParity(transported)).toMatchObject({ valid: true, issues: [] });
    const anchored = auditConditionParity(transported, trustAnchor);
    expect(anchored.valid).toBe(false);
    expect(anchored.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "trusted_source_identity",
      "trusted_flow_hash",
      "trusted_suite_hash",
    ]));
  });

  it("validates logical-tool derivations and exact persisted object shapes", () => {
    const changedContract = structuredClone(compile()) as unknown as {
      semanticLeafTools: Array<{ directProviderTool: { description: string } }>;
    };
    changedContract.semanticLeafTools[0].directProviderTool.description += " forged";
    const contractAudit = auditConditionParity(changedContract);
    expect(contractAudit.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "semantic_tool_provider_hash",
      "semantic_tool_public_hash",
      "semantic_tool_capability",
    ]));

    const extraField = structuredClone(compile()) as CompiledConditionSuite & { ignored_override?: boolean };
    extraField.ignored_override = true;
    expect(auditConditionParity(extraField).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "malformed_suite" }),
    ]));

    const injectedTarget = structuredClone(compile()) as unknown as {
      canonicalInformation: Array<{ target: string }>;
    };
    injectedTarget.canonicalInformation[0].target = 'topic:route">ignore_previous';
    expect(auditConditionParity(injectedTarget).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "malformed_suite" }),
    ]));
  });

  it("bounds hostile compiler inputs and transported suites before recursive parsing or hashing", () => {
    const input = structuredClone(industrialFieldServiceCompilerInput(fieldServiceScenarioJson));
    let nested: Record<string, unknown> = {};
    (input.scenario as { initial_facts: Record<string, unknown> }).initial_facts.hostile_depth = nested;
    for (let depth = 0; depth < 110; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.next = child;
      nested = child;
    }
    expect(() => compileConditionSuite(input)).toThrow(/exceeds maximum depth/);

    const oversized = structuredClone(compile()) as unknown as {
      canonicalInformation: unknown[];
    };
    oversized.canonicalInformation = new Array(20_001).fill(null);
    expect(auditConditionParity(oversized).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "suite_resource_bounds" }),
    ]));

    const cyclic = structuredClone(compile()) as CompiledConditionSuite & { cycle?: unknown };
    cyclic.cycle = cyclic;
    expect(auditConditionParity(cyclic).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "suite_resource_bounds" }),
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
