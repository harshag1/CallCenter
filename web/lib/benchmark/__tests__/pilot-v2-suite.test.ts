import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listStepRefs, validateAgentFlow } from "../../flow";
import { canonicalJson } from "../artifacts";
import {
  BENCHMARK_CONDITION_IDS,
  auditConditionParity,
  compileConditionSuite,
} from "../condition-compiler";
import { LONG_HORIZON_SCENARIO_SUITE } from "../long-horizon-scenario-suite";
import {
  PILOT_V2_CONDITION_TRUST,
  PILOT_V2_EXECUTION_MANIFEST_SHA256,
  PILOT_V2_DEVELOPMENT_SUITE,
  PILOT_V2_SUITE_SHA256,
  auditPilotV2CallerUniqueness,
  assertPilotV2ExecutionPolicy,
  authorizePilotV2ProviderRun,
} from "../pilot-v2-suite";
import type { PilotV2ScenarioTemplate } from "../pilot-v2-kit";
import {
  BenchmarkScenarioSchema,
  createToolWorld,
  evaluateScenarioWorld,
  executeTool,
  parseBoundToolWorldState,
  scenarioContentHash,
  valueAtPath,
  type ToolWorldState,
} from "../scenario-world";

function executeOracle(
  template: PilotV2ScenarioTemplate,
  omitInvocationId?: string
): ToolWorldState {
  let state = createToolWorld(template.scenario);
  for (const invocation of template.oracleInvocations) {
    if (invocation.invocationId === omitInvocationId) continue;
    const execution = executeTool(template.scenario, state, {
      invocation_id: invocation.invocationId,
      tool: invocation.tool,
      arguments: invocation.arguments,
      turn: invocation.turn,
    });
    if (!omitInvocationId) {
      expect(execution.receipt.status, `${template.family}/${invocation.invocationId}`).toBe(
        invocation.expectedReceiptStatus
      );
    }
    state = execution.state;
  }
  return state;
}

function callerPcm(template: PilotV2ScenarioTemplate, durationMs = 100) {
  const sampleRateHz = 16_000;
  const sampleCount = sampleRateHz * durationMs / 1_000;
  return template.scenario.caller.turns.map((turn, turnIndex) => {
    const data = new Uint8Array(sampleCount * 2);
    const view = new DataView(data.buffer);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      view.setInt16(sample * 2, (sample + turnIndex) % 2 === 0 ? 1_500 + turnIndex : -1_500 - turnIndex, true);
    }
    return {
      turnId: turn.id,
      audio: { encoding: "pcm16" as const, sampleRateHz, channels: 1 as const, data },
    };
  });
}

describe("pilot-v2 development suite", () => {
  it("materializes three independent 20-turn development pilot templates", () => {
    expect(PILOT_V2_DEVELOPMENT_SUITE).toHaveLength(3);
    expect(new Set(PILOT_V2_DEVELOPMENT_SUITE.map((template) => template.family))).toEqual(
      new Set(["museum", "campus", "water"])
    );
    expect(new Set(PILOT_V2_DEVELOPMENT_SUITE.map((template) => template.scenario.id)).size).toBe(3);

    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      expect(BenchmarkScenarioSchema.parse(template.scenario)).toEqual(template.scenario);
      expect(template.scenario.caller.turns).toHaveLength(20);
      expect(template.scenario.max_turns).toBe(20);
      expect(template.crossDomainSurfaces.length).toBeGreaterThanOrEqual(3);
      expect(template.heldOut).toBe(false);
      expect(template.studyRole).toBe("development");
      expect(template.pilotRole).toBe("development-pilot");
      expect(template.resultsStatus).toBe("not-run");
      expect(template.claimBoundary).toBe("pilot-design-only");
      expect(template.executionEligibility).toBe("offline-stress-only");
      expect(template.scenario.execution_policy).toMatchObject({
        study_role: "development",
        execution_eligibility: "offline-stress-only",
        provider_blockers: expect.arrayContaining([
          expect.stringMatching(/partial-playback interruption/),
          expect.stringMatching(/cold-reconnect/),
        ]),
        declared_turn_count: 20,
        structural_realism: {
          unique_utterance_ratio: 1,
          development_overlap_ratio: 0,
          confirmatory_eligible: false,
          failures: ["development fixture was designed and inspected before confirmatory preregistration"],
        },
      });
      expect(template.scenarioSha256).toBe(scenarioContentHash(template.scenario).slice(7));
    }
  });

  it("validates one generic Flow v2 per template with complete semantic-tool coverage", () => {
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      const validation = validateAgentFlow(template.flow);
      expect(validation.diagnostics.filter((diagnostic) => diagnostic.level === "error"), template.family).toEqual([]);
      expect(template.flow.schema_version).toBe(2);
      expect(template.flow.tool_exposure).toBe("gateway");
      expect(template.flow.always_tools).toEqual([]);
      expect(template.oracleRoute).toHaveLength(6);

      const attached = new Set(listStepRefs(template.flow).flatMap((step) => step.step.tools ?? []));
      const semantic = new Set(template.scenario.tools.map((tool) => tool.name));
      expect(attached, `${template.family}/flow-tool-coverage`).toEqual(semantic);
    }
  });

  it("compiles and parity-audits all six frozen conditions for every template", () => {
    let compiledConditionCount = 0;
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      const suite = compileConditionSuite(template.compilerInput);
      const trust = PILOT_V2_CONDITION_TRUST.find((record) => record.family === template.family);
      expect(trust).toBeDefined();
      expect(auditConditionParity(suite), template.family).toMatchObject({ valid: true, issues: [] });
      expect(Object.keys(suite.conditions).sort()).toEqual([...BENCHMARK_CONDITION_IDS].sort());
      expect(Object.values(suite.conditions)).toHaveLength(6);
      compiledConditionCount += Object.values(suite.conditions).length;

      for (const conditionId of BENCHMARK_CONDITION_IDS) {
        const condition = suite.conditions[conditionId];
        expect(condition.providerTools.map((tool) => tool.name), `${template.family}/${conditionId}`).toEqual([
          "capability_gateway",
        ]);
        expect(condition.semanticLeafTools.map((tool) => tool.name).sort()).toEqual(
          template.scenario.tools.map((tool) => tool.name).sort()
        );
        expect(trust?.conditionHashes[conditionId]).toBe(condition.conditionHash);
      }
      expect(trust).toMatchObject({
        sourceHash: suite.sourceHash,
        scenarioHash: suite.scenarioHash,
        flowHash: suite.flowHash,
        informationHash: suite.informationHash,
        semanticToolsHash: suite.semanticToolsHash,
        conditionSuiteHash: suite.suiteHash,
      });
    }
    expect(compiledConditionCount).toBe(18);
    expect(PILOT_V2_EXECUTION_MANIFEST_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not leak any string-valued caller-private future fact into any compiled provider-visible surface", () => {
    let leakChecks = 0;
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      expect(template.compilerInput.factDisclosures).toEqual([]);
      const suite = compileConditionSuite(template.compilerInput);
      const privateStrings = Object.values(template.scenario.caller.private_facts)
        .filter((value): value is string => typeof value === "string");
      expect(privateStrings.length, template.family).toBeGreaterThanOrEqual(9);
      for (const conditionId of BENCHMARK_CONDITION_IDS) {
        const condition = suite.conditions[conditionId];
        const providerVisibleSurface = canonicalJson({
          canonicalInformation: suite.canonicalInformation.map((unit) => ({
            kind: unit.kind,
            target: unit.target,
            payload: unit.payload,
          })),
          condition: {
            id: condition.id,
            initialPrompt: condition.initialPrompt,
            initialInformation: condition.initialInformation.map((unit) => unit.payload),
            visibleCapabilities: condition.visibleCapabilities.map((capability) => ({
              name: capability.name,
              description: capability.description,
              inputSchema: capability.inputSchema,
            })),
            providerTools: condition.providerTools,
            disclosures: condition.disclosures.map((disclosure) => ({
              target: disclosure.target,
              prompt: disclosure.prompt,
              information: disclosure.information.map((unit) => unit.payload),
              capabilities: disclosure.visibleCapabilities.map((capability) => ({
                name: capability.name,
                description: capability.description,
                inputSchema: capability.inputSchema,
              })),
            })),
          },
        }).toLocaleLowerCase("en-US");
        for (const privateValue of privateStrings) {
          leakChecks += 1;
          expect(
            providerVisibleSurface.includes(privateValue.toLocaleLowerCase("en-US")),
            `${template.family}/${conditionId}/private-future-value/${privateValue}`
          ).toBe(false);
        }
      }
    }
    expect(leakChecks).toBe(162);
  });

  it("has zero normalized caller-turn reuse internally or against the development corpus", () => {
    const developmentScenarios = LONG_HORIZON_SCENARIO_SUITE
      .filter((template) => template.studyRole === "development")
      .map((template) => template.scenario);
    expect(auditPilotV2CallerUniqueness(developmentScenarios)).toEqual({
      valid: true,
      pilotTurnCount: 60,
      uniquePilotTurnCount: 60,
      internalDuplicates: [],
      developmentOverlap: [],
    });
    expect(() => assertPilotV2ExecutionPolicy()).not.toThrow();
  });

  it("grows cumulative obligations at every checkpoint instead of padding turn count", () => {
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      expect(template.obligationCheckpoints.length).toBeGreaterThanOrEqual(8);
      for (let index = 1; index < template.obligationCheckpoints.length; index += 1) {
        const prior = new Set(template.obligationCheckpoints[index - 1].activeObligations);
        const current = new Set(template.obligationCheckpoints[index].activeObligations);
        expect(current.size, `${template.family}/checkpoint-${index}`).toBeGreaterThan(prior.size);
        expect([...prior].every((obligation) => current.has(obligation))).toBe(true);
      }
      for (const callerTurn of template.scenario.caller.turns) {
        expect(callerTurn.expected_behavior.length, `${template.family}/${callerTurn.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("freezes correction, partial-playback interruption, reconnect, and both fault semantics", () => {
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      const hooks = template.runnerHooks;
      expect(template.scenario.caller.turns[hooks.correction.turn - 1].tags).toContain("correction");
      expect(template.scenario.caller.turns[hooks.interruption.turn - 1].tags).toContain("failure_recovery");
      expect(template.scenario.caller.turns[hooks.reconnect.turn - 1].tags).toContain("reconnect");
      expect(hooks.interruption.injectAfterAssistantAudioMs).toBeGreaterThanOrEqual(500);
      expect(hooks.interruption.injectAfterAssistantAudioMs).toBeLessThanOrEqual(1_500);
      expect(hooks.deterministicFaults.map((fault) => fault.phase).sort()).toEqual([
        "after_commit",
        "before_commit",
      ]);
      expect(template.scenario.tools.find((tool) => tool.name === hooks.reconnect.disconnectAfterTool)?.kind).toBe("mutation");
    }
  });

  it("fits each complete audio script and response reserve inside a conservative ten-minute provider session", () => {
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      const design = template.audioDesign;
      expect(design.feasible, template.family).toBe(true);
      expect(design.requiredProviderSessionMs).toBeLessThanOrEqual(design.maximumProviderSessionMs);
      expect(design.longestCallerTurnMs).toBeLessThanOrEqual(30_000);
      expect(design.callerAudioDurationMs).toBeGreaterThan(0);
      expect(design.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("executes every oracle with exact before-commit and after-commit receipt semantics", () => {
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      const state = executeOracle(template);
      const evaluation = evaluateScenarioWorld(template.scenario, state);
      expect(state.receipts).toHaveLength(10);
      expect(state.receipts.filter((receipt) => receipt.status === "succeeded")).toHaveLength(8);
      expect(state.receipts.filter((receipt) => receipt.status === "failed_before_commit")).toHaveLength(1);
      expect(state.receipts.filter((receipt) => receipt.status === "committed_after_error")).toHaveLength(1);
      expect(evaluation.task_success, template.family).toBe(true);
      expect(evaluation.success.filter((assertion) => !assertion.passed)).toEqual([]);
      expect(evaluation.safety.filter((assertion) => !assertion.passed)).toEqual([]);
    }
  });

  it("makes every one of the thirty declared oracle calls endpoint-critical", () => {
    let omissions = 0;
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      for (const invocation of template.oracleInvocations) {
        omissions += 1;
        const state = executeOracle(template, invocation.invocationId);
        expect(
          evaluateScenarioWorld(template.scenario, state).task_success,
          `${template.family}/omit-${invocation.invocationId}`
        ).toBe(false);
      }
    }
    expect(omissions).toBe(30);
  });

  it("round-trips the durable world at the frozen reconnect boundary and completes without replay", () => {
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      const reconnectTool = template.runnerHooks.reconnect.disconnectAfterTool;
      let state = createToolWorld(template.scenario);
      let resumeIndex = 0;
      for (const [index, invocation] of template.oracleInvocations.entries()) {
        state = executeTool(template.scenario, state, {
          invocation_id: invocation.invocationId,
          tool: invocation.tool,
          arguments: invocation.arguments,
          turn: invocation.turn,
        }).state;
        if (invocation.tool === reconnectTool) {
          resumeIndex = index + 1;
          break;
        }
      }
      const restored = parseBoundToolWorldState(template.scenario, JSON.parse(JSON.stringify(state)));
      for (const path of template.runnerHooks.reconnect.expectedDurableFacts) {
        expect(valueAtPath(restored.facts, path), `${template.family}/${path}`).not.toBeNull();
        expect(valueAtPath(restored.facts, path), `${template.family}/${path}`).not.toBe(false);
      }
      state = restored;
      for (const invocation of template.oracleInvocations.slice(resumeIndex)) {
        state = executeTool(template.scenario, state, {
          invocation_id: invocation.invocationId,
          tool: invocation.tool,
          arguments: invocation.arguments,
          turn: invocation.turn,
        }).state;
      }
      expect(evaluateScenarioWorld(template.scenario, state).task_success, template.family).toBe(true);
      expect(state.effects.filter((effect) => effect.path === "reversible_action_count")).toHaveLength(1);
    }
  });

  it("rejects stale provisional subjects and scores a new-ID irreversible retry as endpoint failure", () => {
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      let state = createToolWorld(template.scenario);
      for (const invocation of template.oracleInvocations.slice(0, 2)) {
        state = executeTool(template.scenario, state, {
          invocation_id: invocation.invocationId,
          tool: invocation.tool,
          arguments: invocation.arguments,
          turn: invocation.turn,
        }).state;
      }
      const correction = template.oracleInvocations[2];
      const stale = executeTool(template.scenario, state, {
        invocation_id: `${template.family}.stale_subject`,
        tool: correction.tool,
        arguments: {
          ...correction.arguments,
          subject: template.scenario.initial_facts.provisional_subject,
        },
        turn: correction.turn,
      });
      expect(stale.receipt.status).toBe("rejected");
      expect(stale.state.effects.some((effect) => effect.tool === correction.tool)).toBe(false);

      const passing = executeOracle(template);
      const commit = template.oracleInvocations.find((invocation) =>
        invocation.tool === template.runnerHooks.deterministicFaults.find((fault) => fault.phase === "after_commit")?.tool
      );
      if (!commit) throw new Error(`missing ${template.family} irreversible commit`);
      const duplicate = executeTool(template.scenario, passing, {
        invocation_id: `${template.family}.blind_retry`,
        tool: commit.tool,
        arguments: commit.arguments,
        turn: 20,
      });
      expect(duplicate.receipt.status).toBe("deduplicated");
      expect(evaluateScenarioWorld(template.scenario, duplicate.state).task_success).toBe(false);
    }
  });

  it("pins the suite hash but refuses provider authorization while scheduler hooks remain blockers", () => {
    const digest = "a".repeat(64);
    const source = PILOT_V2_DEVELOPMENT_SUITE[0];
    const limits = {
      minimumResponseMsPerTurn: 1_800,
      setupAndTeardownReserveMs: 30_000,
      maxSessionMs: 10 * 60_000,
    };
    expect(PILOT_V2_SUITE_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => authorizePilotV2ProviderRun({
      family: "museum",
      protocolSha256: digest,
      runnerConfigSha256: digest,
      expectedSuiteSha256: PILOT_V2_SUITE_SHA256,
      callerPcm: callerPcm(source),
      limits,
    })).toThrow(/offline-stress-only/);
    expect(() => authorizePilotV2ProviderRun({
      family: "museum",
      protocolSha256: digest,
      runnerConfigSha256: digest,
      expectedSuiteSha256: "b".repeat(64),
      callerPcm: callerPcm(source),
      limits,
    })).toThrow(/suite hash mismatch/);
    expect(() => authorizePilotV2ProviderRun({
      family: "museum",
      protocolSha256: digest,
      runnerConfigSha256: digest,
      expectedSuiteSha256: PILOT_V2_SUITE_SHA256,
      callerPcm: [],
      limits,
    })).toThrow(/cover every scenario caller turn/);
  });

  it("keeps the pilot evidence document pinned to current suite, scenario, and caller-script hashes", () => {
    const evidence = readFileSync(
      resolve(process.cwd(), "../benchmarks/voice-long-horizon/scenarios/PILOT_V2_DEVELOPMENT.md"),
      "utf8"
    );
    expect(evidence).toContain(PILOT_V2_SUITE_SHA256);
    expect(evidence).toContain(PILOT_V2_EXECUTION_MANIFEST_SHA256);
    for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
      expect(evidence, `${template.family}/scenario`).toContain(template.scenarioSha256);
      expect(evidence, `${template.family}/script`).toContain(template.audioDesign.scriptSha256);
      expect(evidence, `${template.family}/claim-boundary`).toContain("not provider-run");
      const trust = PILOT_V2_CONDITION_TRUST.find((record) => record.family === template.family);
      if (!trust) throw new Error(`missing ${template.family} condition trust record`);
      expect(evidence).toContain(trust.sourceHash);
      expect(evidence).toContain(trust.flowHash);
      expect(evidence).toContain(trust.semanticToolsHash);
      expect(evidence).toContain(trust.conditionSuiteHash);
      for (const conditionHash of Object.values(trust.conditionHashes)) {
        expect(evidence).toContain(conditionHash);
      }
    }
  });
});
