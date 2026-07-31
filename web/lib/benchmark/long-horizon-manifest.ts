import { validateAgentFlow } from "../flow";
import { canonicalJson, sha256Hex } from "./artifacts";
import { auditConditionParity, compileConditionSuite } from "./condition-compiler";
import {
  LONG_HORIZON_FAMILIES,
  LONG_HORIZON_REALISM_THRESHOLDS,
  LONG_HORIZON_SCENARIO_SUITE,
  measureLongHorizonRealism,
  type LongHorizonFamily,
  type LongHorizonExecutionEligibility,
} from "./long-horizon-scenario-suite";
import { createToolWorld, evaluateScenarioWorld, executeTool } from "./tool-world";

export type LongHorizonManifestRow = Readonly<{
  family: LongHorizonFamily;
  turns: number;
  tools: number;
  oracleCalls: number;
  receipts: number;
  effects: number;
  events: number;
  scenarioArtifactSha256: string;
  compiledSuiteArtifactSha256: string;
  semanticToolsSha256: string;
  executionEligibility: LongHorizonExecutionEligibility;
  uniqueUtterances: number;
  uniqueUtteranceRatio: number;
  developmentOverlapTurns: number;
  developmentOverlapRatio: number;
  confirmatoryRealismEligible: boolean;
}>;

const FAMILY_LABELS: Readonly<Record<LongHorizonFamily, string>> = {
  "travel-disruption": "Travel disruption",
  "home-health-coordination": "Home-health coordination",
  "field-service-escalation": "Field-service escalation",
};

/**
 * Rebuild every row from parsed source, compiled conditions, and a fully
 * replay-verified oracle. Any invalid fixture fails before Markdown is emitted.
 */
export function materializeLongHorizonManifestRows(): readonly LongHorizonManifestRow[] {
  return Object.freeze(LONG_HORIZON_SCENARIO_SUITE.map((source) => {
    const flowValidation = validateAgentFlow(source.compilerInput.flow);
    const flowErrors = flowValidation.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (flowErrors.length > 0) {
      throw new Error(`${source.scenario.id} has invalid Flow source: ${flowErrors.map((item) => item.message).join("; ")}`);
    }
    const compiled = compileConditionSuite(source.compilerInput);
    const parity = auditConditionParity(compiled);
    if (!parity.valid) {
      throw new Error(`${source.scenario.id} condition parity failed: ${parity.issues.map((item) => item.message).join("; ")}`);
    }

    let world = createToolWorld(source.scenario);
    for (const invocation of source.oracleInvocations) {
      const execution = executeTool(source.scenario, world, {
        invocation_id: invocation.invocationId,
        tool: invocation.tool,
        arguments: invocation.arguments,
        turn: invocation.turn,
      });
      if (execution.receipt.status !== invocation.expectedReceiptStatus) {
        throw new Error(
          `${source.scenario.id}/${invocation.invocationId} expected ${invocation.expectedReceiptStatus}, received ${execution.receipt.status}`
        );
      }
      world = execution.state;
    }
    const evaluation = evaluateScenarioWorld(source.scenario, world);
    const failures = [...evaluation.success, ...evaluation.safety].filter((assertion) => !assertion.passed);
    if (!evaluation.task_success || failures.length > 0) {
      throw new Error(`${source.scenario.id} oracle failed: ${failures.map((item) => item.assertion_id).join(", ")}`);
    }
    const realism = measureLongHorizonRealism(source);

    return Object.freeze({
      family: source.family,
      turns: source.turnCount,
      tools: source.scenario.tools.length,
      oracleCalls: source.oracleInvocations.length,
      receipts: world.receipts.length,
      effects: world.effects.length,
      events: world.events.length,
      scenarioArtifactSha256: sha256Hex(canonicalJson(source.scenario)),
      compiledSuiteArtifactSha256: sha256Hex(canonicalJson(compiled)),
      semanticToolsSha256: compiled.semanticToolsHash,
      executionEligibility: source.executionEligibility,
      uniqueUtterances: realism.uniqueUtterances,
      uniqueUtteranceRatio: realism.uniqueUtteranceRatio,
      developmentOverlapTurns: realism.developmentOverlapTurns,
      developmentOverlapRatio: realism.developmentOverlapRatio,
      confirmatoryRealismEligible: realism.confirmatoryEligible,
    });
  }));
}

export function renderLongHorizonManifest(): string {
  const rows = materializeLongHorizonManifestRows();
  const totals = rows.reduce((sum, row) => ({
    calls: sum.calls + row.oracleCalls,
    receipts: sum.receipts + row.receipts,
    effects: sum.effects + row.effects,
    events: sum.events + row.events,
  }), { calls: 0, receipts: 0, effects: 0, events: 0 });
  const lines = [
    "# Long-horizon template manifest",
    "",
    "Status: **fixture validation only; no provider runs and no model-performance results.** This file is rendered deterministically from the current parsed sources by `web/scripts/generate-long-horizon-manifest.ts`. Run it with `--check` after any scenario, schema, compiler, Flow, or ToolWorld change and before freezing a paid execution plan.",
    "",
    "Artifact hashes below are lowercase SHA-256 of canonical JSON (`sha256Hex(canonicalJson(value))`). They are artifact inventory hashes, distinct from each object’s domain-separated internal binding hash.",
    "",
    "| Family | Turns | Tools | Oracle calls | Receipts / effects / events | Scenario artifact SHA-256 | Compiled-suite artifact SHA-256 |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...rows.map((row) =>
      `| ${FAMILY_LABELS[row.family]} | ${row.turns} | ${row.tools} | ${row.oracleCalls} | ${row.receipts} / ${row.effects} / ${row.events} | \`${row.scenarioArtifactSha256}\` | \`${row.compiledSuiteArtifactSha256}\` |`
    ),
    "",
    "Semantic leaf-tool hashes are intentionally stable across 32/64/120 within each family:",
    "",
    ...LONG_HORIZON_FAMILIES.map((family) => {
      const hashes = new Set(rows.filter((row) => row.family === family).map((row) => row.semanticToolsSha256));
      if (hashes.size !== 1) throw new Error(`${family} semantic leaf-tool hash drifted across horizons`);
      return `- ${FAMILY_LABELS[family]}: \`${[...hashes][0]}\``;
    }),
    "",
    `Confirmatory realism gates require unique-utterance ratio ≥ ${LONG_HORIZON_REALISM_THRESHOLDS.minimumUniqueUtteranceRatio.toFixed(2)} and 64-turn development-overlap ratio ≤ ${LONG_HORIZON_REALISM_THRESHOLDS.maximumDevelopmentOverlapRatio.toFixed(2)}. These metrics are structural release gates, not model results:`,
    "",
    "| Family | Turns | Unique utterances | Unique ratio | 64-turn overlap turns | Overlap ratio | Execution eligibility | Confirmatory realism gate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...rows.map((row) =>
      `| ${FAMILY_LABELS[row.family]} | ${row.turns} | ${row.uniqueUtterances} | ${row.uniqueUtteranceRatio.toFixed(4)} | ${row.developmentOverlapTurns} | ${row.developmentOverlapRatio.toFixed(4)} | ${row.executionEligibility} | ${row.confirmatoryRealismEligible ? "pass" : "fail"} |`
    ),
    "",
    `The generator replayed ${totals.calls} oracle calls into ${totals.receipts} receipts, ${totals.effects} authoritative effects, and ${totals.events} bound events across all nine fixtures. Every expected receipt status matched; every oracle reached \`task_success=true\` with zero failed declared assertions; and every seven-arm parity audit passed. This proves only that the synthetic fixtures have coherent safe paths. It says nothing about model or harness performance.`,
    "",
    "The 32- and 64-turn variants are development fixtures and still require actual ordered frozen PCM bytes plus a session-feasibility envelope before provider execution; the authorization helper derives the audio binding and duration instead of accepting claims. The current 120-turn variants are classified `offline-stress-only`: they remain useful for deterministic local retention testing, but their uniqueness/overlap realism gate is red and `authorizeLongHorizonTemplateRun` refuses provider or confirmatory scheduling. A newly versioned, frozen scenario set is required before any C4/C5 claim.",
    "",
  ];
  return lines.join("\n");
}
