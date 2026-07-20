import { describe, expect, it } from "vitest";
import { validateAgentFlow } from "../../flow";
import {
  auditConditionParity,
  compileConditionSuite,
} from "../condition-compiler";
import {
  LONG_HORIZON_FAMILIES,
  LONG_HORIZON_SCENARIO_SUITE,
  LONG_HORIZON_TURN_COUNTS,
  assessLongHorizonProviderEligibility,
  assertLongHorizonExecutionPolicy,
  authorizeLongHorizonTemplateRun,
  measureLongHorizonRealism,
  type LongHorizonFamily,
  type LongHorizonScenarioTemplate,
} from "../long-horizon-scenario-suite";
import { renderLongHorizonManifest } from "../long-horizon-manifest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BenchmarkScenarioSchema,
  createToolWorld,
  evaluateScenarioWorld,
  executeTool,
  type ToolWorldState,
} from "../scenario-world";

function template(family: LongHorizonFamily, turnCount: 32 | 64 | 120) {
  const found = LONG_HORIZON_SCENARIO_SUITE.find(
    (candidate) => candidate.family === family && candidate.turnCount === turnCount
  );
  if (!found) throw new Error(`missing ${family}/${turnCount} template`);
  return found;
}

function executeOracle(source: LongHorizonScenarioTemplate): ToolWorldState {
  let state = createToolWorld(source.scenario);
  for (const invocation of source.oracleInvocations) {
    const execution = executeTool(source.scenario, state, {
      invocation_id: invocation.invocationId,
      tool: invocation.tool,
      arguments: invocation.arguments,
      turn: invocation.turn,
    });
    expect(execution.receipt.status, `${source.scenario.id}/${invocation.tool}`).toBe(
      invocation.expectedReceiptStatus
    );
    state = execution.state;
  }
  return state;
}

function executeOracleWithoutTool(
  source: LongHorizonScenarioTemplate,
  omittedTool: string
): ToolWorldState {
  let state = createToolWorld(source.scenario);
  for (const invocation of source.oracleInvocations) {
    if (invocation.tool === omittedTool) continue;
    state = executeTool(source.scenario, state, {
      invocation_id: invocation.invocationId,
      tool: invocation.tool,
      arguments: invocation.arguments,
      turn: invocation.turn,
    }).state;
  }
  return state;
}

function primarySubject(family: LongHorizonFamily): string {
  if (family === "travel-disruption") return "booking_reference";
  if (family === "home-health-coordination") return "case_id";
  return "incident_id";
}

function callerPcm(source: LongHorizonScenarioTemplate, durationMsPerTurn = 100) {
  const sampleRateHz = 16_000;
  const sampleCount = sampleRateHz * durationMsPerTurn / 1_000;
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) throw new Error("test PCM duration is not sample-aligned");
  return source.scenario.caller.turns.map((turn, turnIndex) => {
    const data = new Uint8Array(sampleCount * 2);
    const view = new DataView(data.buffer);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      view.setInt16(sample * 2, (sample + turnIndex) % 2 === 0 ? 2_000 + turnIndex : -2_000 - turnIndex, true);
    }
    return Object.freeze({
      turnId: turn.id,
      audio: Object.freeze({ encoding: "pcm16" as const, sampleRateHz, channels: 1 as const, data }),
    });
  });
}

describe("long-horizon scenario suite", () => {
  it("materializes nine explicitly labeled, not-run templates at exact horizons", () => {
    expect(LONG_HORIZON_SCENARIO_SUITE).toHaveLength(9);
    expect(new Set(LONG_HORIZON_SCENARIO_SUITE.map((source) => source.scenario.id)).size).toBe(9);

    for (const family of LONG_HORIZON_FAMILIES) {
      for (const turnCount of LONG_HORIZON_TURN_COUNTS) {
        const source = template(family, turnCount);
        expect(BenchmarkScenarioSchema.parse(source.scenario)).toEqual(source.scenario);
        expect(source.scenario.caller.turns).toHaveLength(turnCount);
        expect(source.scenario.max_turns).toBe(turnCount);
        expect(new Set(source.scenario.caller.turns.map((turn) => turn.id)).size).toBe(turnCount);
        const terminalPhase = source.scenario.caller.turns.at(-1)?.phase;
        expect(terminalPhase).toBe(
          family === "home-health-coordination" ? "finalize_notify" : "completion"
        );
        expect(source.resultsStatus).toBe("not-run");
        expect(source.runnerRequirements.length).toBeGreaterThan(0);
        expect(source.heldOut).toBe(turnCount === 120);
        expect(source.studyRole).toBe(turnCount === 120 ? "confirmatory-held-out" : "development");
      }
    }
  });

  it("compiles all six arms with valid parity and stable semantic tools within each family", () => {
    const semanticHashes = new Map<LongHorizonFamily, string>();
    for (const source of LONG_HORIZON_SCENARIO_SUITE) {
      const validation = validateAgentFlow(source.compilerInput.flow);
      expect(validation.diagnostics.filter((diagnostic) => diagnostic.level === "error"), source.scenario.id).toEqual([]);

      const suite = compileConditionSuite(source.compilerInput);
      expect(auditConditionParity(suite), source.scenario.id).toMatchObject({ valid: true, issues: [] });
      for (const condition of Object.values(suite.conditions)) {
        expect(condition.providerTools.map((tool) => tool.name)).toEqual(["capability_gateway"]);
      }
      const prior = semanticHashes.get(source.family);
      if (prior) expect(suite.semanticToolsHash, source.scenario.id).toBe(prior);
      semanticHashes.set(source.family, suite.semanticToolsHash);
    }
  });

  it("contains correction, recall, pressure, injection, reconnect, failure, and duplicate-effect stress", () => {
    const requiredTags = [
      "task",
      "correction",
      "recall_probe",
      "adversarial_pressure",
      "injection_probe",
      "failure_recovery",
      "reconnect",
      "confirmation",
    ] as const;
    for (const family of LONG_HORIZON_FAMILIES) {
      const source = template(family, 32);
      const tags = new Set(source.scenario.caller.turns.flatMap((turn) => turn.tags));
      for (const tag of requiredTags) expect(tags.has(tag), `${family}/${tag}`).toBe(true);

      const taintKinds = new Set(source.scenario.tools.flatMap((tool) =>
        tool.result.tainted_paths.map((taint) => taint.kind)
      ));
      expect(taintKinds).toEqual(new Set(["prompt_injection", "counterfeit_receipt"]));
      expect(source.scenario.tools.some((tool) => tool.faults.some((fault) => fault.phase === "before_commit"))).toBe(true);
      expect(source.scenario.tools.some((tool) => tool.faults.some((fault) => fault.phase === "after_commit"))).toBe(true);
      expect(source.scenario.tools.some((tool) => tool.kind === "mutation" && tool.duplicate_policy === "execute")).toBe(true);
      expect(source.scenario.safety_invariants.some((assertion) => assertion.kind === "all_prerequisites_passed" && !assertion.tool)).toBe(true);
    }
  });

  it("binds every subject-bearing tool to the authoritative world subject", () => {
    for (const source of LONG_HORIZON_SCENARIO_SUITE) {
      const subject = primarySubject(source.family);
      for (const tool of source.scenario.tools.filter((candidate) =>
        candidate.arguments.some((argument) => argument.name === subject)
      )) {
        const isBound = tool.prerequisites.some((predicate) =>
          "source" in predicate.left
          && predicate.left.source === "arguments"
          && predicate.left.path === subject
          && predicate.right !== undefined
          && "source" in predicate.right
          && predicate.right.source === "world"
          && predicate.right.path === subject
        );
        expect(isBound, `${source.scenario.id}/${tool.name}/${subject}`).toBe(true);
      }
    }
  });

  it("executes a deterministic strict-passing oracle for every family and horizon", () => {
    for (const source of LONG_HORIZON_SCENARIO_SUITE) {
      const state = executeOracle(source);
      const evaluation = evaluateScenarioWorld(source.scenario, state);
      expect(evaluation.task_success, source.scenario.id).toBe(true);
      expect(evaluation.success.filter((assertion) => !assertion.passed)).toEqual([]);
      expect(evaluation.safety.filter((assertion) => !assertion.passed)).toEqual([]);
    }
  }, 30_000);

  it("fails closed when the authoritative post-timeout recovery read-back is omitted", () => {
    const recoveryReadbacks: Readonly<Record<LongHorizonFamily, {
      readonly tool: string;
      readonly assertionId: string;
    }>> = {
      "travel-disruption": {
        tool: "get_recovery_booking_status",
        assertionId: "status_readback_once",
      },
      "home-health-coordination": {
        tool: "get_home_visit_status",
        assertionId: "schedule_readback_once",
      },
      "field-service-escalation": {
        tool: "get_robot_incident_status",
        assertionId: "restart_status_readback_once",
      },
    };

    for (const family of LONG_HORIZON_FAMILIES) {
      const source = template(family, 32);
      const recovery = recoveryReadbacks[family];
      expect(source.oracleInvocations.filter((call) => call.tool === recovery.tool)).toHaveLength(1);

      const state = executeOracleWithoutTool(source, recovery.tool);
      const evaluation = evaluateScenarioWorld(source.scenario, state);
      expect(evaluation.task_success, `${family}/omitted-${recovery.tool}`).toBe(false);
      expect(
        evaluation.safety.find((assertion) => assertion.assertion_id === recovery.assertionId),
        `${family}/${recovery.assertionId}`
      ).toMatchObject({ passed: false });
      expect(
        state.receipts.some((receipt) => receipt.tool === recovery.tool && receipt.status === "succeeded"),
        `${family}/no-authoritative-readback-receipt`
      ).toBe(false);
    }
  });

  it("rejects future-knowledge execution and scores a new-ID irreversible duplicate as failure", () => {
    for (const family of LONG_HORIZON_FAMILIES) {
      const source = template(family, 32);
      const irreversible = source.scenario.tools.find((tool) =>
        tool.kind === "mutation" && tool.faults.some((fault) => fault.phase === "after_commit")
      );
      if (!irreversible) throw new Error(`missing irreversible action for ${family}`);
      const planned = source.oracleInvocations.find((invocation) => invocation.tool === irreversible.name);
      if (!planned) throw new Error(`missing irreversible oracle action for ${family}`);

      const early = executeTool(source.scenario, createToolWorld(source.scenario), {
        invocation_id: `early_${family.replaceAll("-", "_")}`,
        tool: irreversible.name,
        arguments: planned.arguments,
        turn: 1,
      });
      expect(early.receipt.status, `${family}/early`).toBe("rejected");
      expect(early.state.effects).toEqual([]);

      const passingState = executeOracle(source);
      const duplicate = executeTool(source.scenario, passingState, {
        invocation_id: `duplicate_${family.replaceAll("-", "_")}`,
        tool: irreversible.name,
        arguments: planned.arguments,
        turn: source.turnCount,
      });
      expect(duplicate.receipt.duplicate_of_receipt_id, family).toBeDefined();
      expect(evaluateScenarioWorld(source.scenario, duplicate.state).task_success, family).toBe(false);
    }
  }, 30_000);

  it("binds home-health faults to the first admitted intent so delaying cannot select an easier world", () => {
    const source = template("home-health-coordination", 32);
    const outage = source.oracleInvocations.find((call) => call.tool === "hold_home_visit_slot");
    if (!outage) throw new Error("missing home-health hold outage invocation");
    let state = createToolWorld(source.scenario);
    for (const invocation of source.oracleInvocations) {
      if (invocation.tool === "hold_home_visit_slot") continue;
      if (invocation.turn >= outage.turn) break;
      state = executeTool(source.scenario, state, {
        invocation_id: invocation.invocationId,
        tool: invocation.tool,
        arguments: invocation.arguments,
        turn: invocation.turn,
      }).state;
    }

    const delayedFirst = executeTool(source.scenario, state, {
      invocation_id: "delayed_hold_first",
      tool: outage.tool,
      arguments: outage.arguments,
      turn: outage.turn + 2,
    });
    expect(delayedFirst.receipt.status).toBe("failed_before_commit");
    expect(delayedFirst.state.facts.hold_count).toBe(0);

    const delayedRetry = executeTool(source.scenario, delayedFirst.state, {
      invocation_id: "delayed_hold_retry",
      tool: outage.tool,
      arguments: outage.arguments,
      turn: outage.turn + 2,
    });
    expect(delayedRetry.receipt.status).toBe("succeeded");
    expect(delayedRetry.state.facts.hold_count).toBe(1);
    expect(delayedRetry.state.events.filter((event) =>
      event.type === "tool.fault_injected" && event.tool === "hold_home_visit_slot"
    )).toHaveLength(1);
  });

  it("does not disclose future private target values through compiled treatment prompts", () => {
    const privateTargets: Readonly<Record<LongHorizonFamily, readonly string[]>> = {
      "travel-disruption": ["Q7M4LP", "482913", "Mina Priya Shah", "SFO", "OAK", "18000", "14680", "ALT-SFO-317", "AUTH-912"],
      "home-health-coordination": ["AC-118", "6384", "AUTH-772", "71 Birch Street", "2026-08-21", "13:00-15:00", "SLOT-82113", "VIS-HH4729-82113", "metoprolol"],
      "field-service-escalation": ["FS-9127", "FE-418", "6209", "CELL-9A", "CELL-9B", "E-442", "LOT-740", "SAF-909", "RESTART-SAF-909", "DRV-18", "DM18-7742"],
    };
    for (const family of LONG_HORIZON_FAMILIES) {
      const suite = compileConditionSuite(template(family, 32).compilerInput);
      const rendered = JSON.stringify(suite.conditions);
      for (const target of privateTargets[family]) {
        expect(rendered.includes(target), `${family} leaked ${target}`).toBe(false);
      }
    }
  });

  it("exposes decoy-rich categorical vocabularies without preselecting the caller's later choice", () => {
    const source = template("home-health-coordination", 32);
    const expectedChoices = [
      ["record_visit_logistics", "contact_channel", "sms"],
      ["record_visit_logistics", "accessibility_service", "captioned_phone"],
      ["request_clinician_callback", "queue", "licensed_clinician_same_day"],
      ["record_coordination_consent", "scope", "appointment_logistics_sms_only"],
    ] as const;
    for (const [toolName, argumentName, selectedValue] of expectedChoices) {
      const argument = source.scenario.tools.find((tool) => tool.name === toolName)
        ?.arguments.find((candidate) => candidate.name === argumentName);
      expect(argument?.enum, `${toolName}.${argumentName}`).toContain(selectedValue);
      expect(argument?.enum?.length, `${toolName}.${argumentName}/decoys`).toBeGreaterThanOrEqual(3);
      expect(new Set(argument?.enum).size, `${toolName}.${argumentName}/unique`).toBe(argument?.enum?.length);
    }
  });

  it("stretches evidence-to-action lag and uses distinct confirmatory interference banks", () => {
    const phaseGap = (source: LongHorizonScenarioTemplate, first: string, second: string) => {
      const left = source.scenario.caller.turns.findIndex((turn) => turn.phase === first);
      const right = source.scenario.caller.turns.findIndex((turn) => turn.phase === second);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeGreaterThan(left);
      return right - left;
    };
    const fieldGaps = [
      phaseGap(template("field-service-escalation", 32), "asset_correction", "restart_authorization"),
      phaseGap(template("field-service-escalation", 64), "asset_correction", "restart_authorization"),
      phaseGap(template("field-service-escalation", 120), "asset_correction", "restart_authorization"),
    ];
    expect(fieldGaps[0]).toBeLessThan(fieldGaps[1]);
    expect(fieldGaps[1]).toBeLessThan(fieldGaps[2]);
    expect(phaseGap(template("home-health-coordination", 32), "address_correction", "booking_authorization"))
      .toBeLessThan(phaseGap(template("home-health-coordination", 120), "address_correction", "booking_authorization"));

    const fieldDevelopment = new Set(template("field-service-escalation", 64).scenario.caller.turns
      .filter((turn) => turn.phase.startsWith("stress_"))
      .map((turn) => turn.utterance));
    const fieldConfirmatory = template("field-service-escalation", 120).scenario.caller.turns
      .filter((turn) => turn.phase.startsWith("stress_"))
      .map((turn) => turn.utterance);
    expect(fieldConfirmatory.some((utterance) => fieldDevelopment.has(utterance))).toBe(false);

    const homeDevelopment = new Set(template("home-health-coordination", 64).scenario.caller.turns
      .filter((turn) => turn.phase.startsWith("interference_"))
      .map((turn) => turn.utterance));
    const homeConfirmatory = template("home-health-coordination", 120).scenario.caller.turns
      .filter((turn) => turn.phase.startsWith("holdout_"))
      .map((turn) => turn.utterance);
    expect(homeConfirmatory.length).toBeGreaterThan(0);
    expect(homeConfirmatory.some((utterance) => homeDevelopment.has(utterance))).toBe(false);
  });

  it("binds execution policy and actual PCM bytes while failing closed on ineligible or unfrozen runs", () => {
    const digest = "a".repeat(64);
    const fittingLimits = {
      minimumResponseMsPerTurn: 1_000,
      setupAndTeardownReserveMs: 10_000,
      maxSessionMs: 15 * 60_000,
    };
    const development = template("travel-disruption", 32);
    expect(() => assertLongHorizonExecutionPolicy(development)).not.toThrow();
    const developmentPcm = callerPcm(development);
    const developmentAuthorization = authorizeLongHorizonTemplateRun(development, {
      purpose: "development",
      callerPcm: developmentPcm,
      limits: fittingLimits,
    });
    expect(developmentAuthorization).toMatchObject({ purpose: "development" });
    expect(developmentAuthorization.providerSessionBudget).toMatchObject({
      callerAudioDurationMs: 3_200,
      callerAudioByteLength: 102_400,
      sampleRateHz: 16_000,
    });
    expect(developmentAuthorization.providerSessionBudget?.verifiedAudioBindingSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => authorizeLongHorizonTemplateRun(development, {
      purpose: "confirmatory",
      callerPcm: developmentPcm,
      limits: fittingLimits,
    })).toThrow(/development template/);
    expect(() => authorizeLongHorizonTemplateRun(development, {
      purpose: "development",
      callerPcm: developmentPcm,
      limits: { ...fittingLimits, maxSessionMs: 1 },
    })).toThrow(/exceeding maxSessionMs/);
    expect(() => authorizeLongHorizonTemplateRun(development, {
      purpose: "development",
      callerPcm: undefined,
      limits: fittingLimits,
    } as never)).toThrow(/actual caller PCM bytes/);

    const confirmatory = template("travel-disruption", 120);
    expect(confirmatory.executionEligibility).toBe("offline-stress-only");
    expect(() => authorizeLongHorizonTemplateRun(confirmatory, {
      purpose: "confirmatory",
      callerPcm: callerPcm(confirmatory, 20),
      limits: fittingLimits,
      freezeBundle: {
        preregistrationHash: digest,
        conditionSuiteHash: digest,
        audioFixtureHash: digest,
        runnerConfigHash: digest,
      },
    })).toThrow(/offline-stress-only/);
    const offline = authorizeLongHorizonTemplateRun(confirmatory, { purpose: "offline-stress" });
    expect(offline.authorizationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(offline.providerSessionBudget).toBeNull();
    expect(assessLongHorizonProviderEligibility(confirmatory, callerPcm(confirmatory, 20), fittingLimits))
      .toMatchObject({ eligible: false });

    const novelTurns = confirmatory.scenario.caller.turns.map((turn, index) => ({
      ...turn,
      utterance: `Frozen held-out utterance ${index + 1}: independent obligation ${index + 1}.`,
    }));
    const syntheticBase = {
      ...confirmatory,
      executionEligibility: "confirmatory-provider-eligible" as const,
      scenario: BenchmarkScenarioSchema.parse({
        ...structuredClone(confirmatory.scenario),
        caller: { ...structuredClone(confirmatory.scenario.caller), turns: novelTurns },
        execution_policy: {
          ...structuredClone(confirmatory.scenario.execution_policy),
          execution_eligibility: "confirmatory-provider-eligible",
          structural_realism: {
            ...structuredClone(confirmatory.scenario.execution_policy?.structural_realism),
            unique_utterances: 120,
            unique_utterance_ratio: 1,
            development_overlap_turns: 0,
            development_overlap_ratio: 0,
            confirmatory_eligible: true,
            failures: [],
          },
        },
      }),
    };
    const synthetic = Object.freeze({
      ...syntheticBase,
      compilerInput: Object.freeze({ ...syntheticBase.compilerInput, scenario: syntheticBase.scenario }),
    });
    expect(() => assertLongHorizonExecutionPolicy(synthetic)).not.toThrow();
    const syntheticPcm = callerPcm(synthetic, 20);
    const audioBudget = assessLongHorizonProviderEligibility(synthetic, syntheticPcm, fittingLimits).budget;
    expect(() => authorizeLongHorizonTemplateRun(synthetic, {
      purpose: "confirmatory",
      callerPcm: syntheticPcm,
      limits: fittingLimits,
    })).toThrow(/requires frozen preregistration/);
    expect(() => authorizeLongHorizonTemplateRun(synthetic, {
      purpose: "confirmatory",
      callerPcm: syntheticPcm,
      limits: fittingLimits,
      freezeBundle: {
        preregistrationHash: "invalid",
        conditionSuiteHash: digest,
        audioFixtureHash: audioBudget.audioFixtureBindingSha256,
        runnerConfigHash: digest,
      },
    })).toThrow(/preregistrationHash/);
    expect(() => authorizeLongHorizonTemplateRun(synthetic, {
      purpose: "confirmatory",
      callerPcm: syntheticPcm,
      limits: fittingLimits,
      freezeBundle: {
        preregistrationHash: digest,
        conditionSuiteHash: digest,
        audioFixtureHash: "b".repeat(64),
        runnerConfigHash: digest,
      },
    })).toThrow(/PCM-byte binding/);
    expect(authorizeLongHorizonTemplateRun(synthetic, {
      purpose: "confirmatory",
      callerPcm: syntheticPcm,
      limits: fittingLimits,
      freezeBundle: {
        preregistrationHash: digest,
        conditionSuiteHash: digest,
        audioFixtureHash: audioBudget.audioFixtureBindingSha256,
        runnerConfigHash: digest,
      },
    }).purpose).toBe("confirmatory");
  });

  it("requires exact declared oracle receipt coverage and keeps every 120-turn realism gate red", () => {
    for (const source of LONG_HORIZON_SCENARIO_SUITE) {
      const expectedByTool = new Map<string, number>();
      for (const call of source.oracleInvocations) {
        expectedByTool.set(call.tool, (expectedByTool.get(call.tool) ?? 0) + 1);
      }
      const totalAssertions = source.scenario.safety_invariants.filter((assertion) =>
        assertion.kind === "receipt_count" && assertion.id.endsWith(".oracle_receipts.total")
      );
      expect(totalAssertions).toHaveLength(expectedByTool.size);
      for (const assertion of totalAssertions) {
        if (assertion.kind !== "receipt_count") continue;
        expect(assertion).toMatchObject({ operator: "equals", value: expectedByTool.get(assertion.tool) });
      }
      if (source.turnCount === 120) {
        const realism = measureLongHorizonRealism(source);
        expect(realism.confirmatoryEligible, source.scenario.id).toBe(false);
        expect(realism.failures.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the generated manifest byte-current with replayed oracle evidence", () => {
    // Rendering already materializes, compiles, parity-checks, and oracle-replays
    // every row. Assert against that single result instead of doing the full
    // validation pass twice in one test.
    const rendered = renderLongHorizonManifest();
    const dataRows = rendered.split("\n").filter((line) =>
      line.startsWith("| Travel disruption |")
      || line.startsWith("| Home-health coordination |")
      || line.startsWith("| Field-service escalation |")
    );
    expect(dataRows).toHaveLength(18);
    expect(rendered).toContain(
      "The generator replayed 147 oracle calls into 147 receipts, 312 authoritative effects, and 1752 bound events"
    );
    const checkedIn = readFileSync(resolve(
      process.cwd(),
      "../benchmarks/voice-long-horizon/scenarios/LONG_HORIZON_MANIFEST.md"
    ), "utf8");
    expect(checkedIn).toBe(rendered);
  }, 30_000);
});
