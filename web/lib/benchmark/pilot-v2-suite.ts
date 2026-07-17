import { canonicalJson, sha256Hex } from "./artifacts";
import {
  BENCHMARK_CONDITION_IDS,
  auditConditionParity,
  compileConditionSuite,
  type BenchmarkConditionId,
  type CompiledConditionSuite,
} from "./condition-compiler";
import type { BenchmarkScenario } from "./scenario-schema";
import {
  LONG_HORIZON_SCENARIO_SUITE,
  assessScenarioProviderEligibility,
  type LongHorizonPcmTurn,
  type LongHorizonProviderExecutionLimits,
  type LongHorizonVerifiedAudioBudget,
} from "./long-horizon-scenario-suite";
import { PILOT_V2_CAMPUS_TEMPLATE } from "./pilot-v2-campus";
import {
  normalizePilotUtterance,
  pilotV2SuiteSha256,
  type PilotV2ScenarioTemplate,
} from "./pilot-v2-kit";
import { PILOT_V2_MUSEUM_TEMPLATE } from "./pilot-v2-museum";
import { PILOT_V2_WATER_TEMPLATE } from "./pilot-v2-water";

export const PILOT_V2_FAMILIES = Object.freeze(["museum", "campus", "water"] as const);
export type PilotV2Family = typeof PILOT_V2_FAMILIES[number];

export const PILOT_V2_DEVELOPMENT_SUITE: readonly PilotV2ScenarioTemplate[] = Object.freeze([
  PILOT_V2_MUSEUM_TEMPLATE,
  PILOT_V2_CAMPUS_TEMPLATE,
  PILOT_V2_WATER_TEMPLATE,
]);

export const PILOT_V2_SUITE_SHA256 = pilotV2SuiteSha256(PILOT_V2_DEVELOPMENT_SUITE);

export type PilotV2ConditionTrustRecord = Readonly<{
  family: string;
  scenarioId: string;
  sourceHash: string;
  scenarioHash: string;
  flowHash: string;
  informationHash: string;
  semanticToolsHash: string;
  conditionSuiteHash: string;
  conditionHashes: Readonly<Record<BenchmarkConditionId, string>>;
}>;

function compileAndAttest(template: PilotV2ScenarioTemplate): PilotV2ConditionTrustRecord {
  const suite = compileConditionSuite(template.compilerInput);
  const parity = auditConditionParity(suite);
  if (!parity.valid) {
    throw new Error(`pilot-v2 parity failed for ${template.family}: ${parity.issues.map((issue) => issue.message).join("; ")}`);
  }
  const conditionHashes = Object.fromEntries(BENCHMARK_CONDITION_IDS.map((conditionId) => [
    conditionId,
    suite.conditions[conditionId].conditionHash,
  ])) as Record<BenchmarkConditionId, string>;
  return Object.freeze({
    family: template.family,
    scenarioId: template.scenario.id,
    sourceHash: suite.sourceHash,
    scenarioHash: suite.scenarioHash,
    flowHash: suite.flowHash,
    informationHash: suite.informationHash,
    semanticToolsHash: suite.semanticToolsHash,
    conditionSuiteHash: suite.suiteHash,
    conditionHashes: Object.freeze(conditionHashes),
  });
}

export const PILOT_V2_CONDITION_TRUST: readonly PilotV2ConditionTrustRecord[] = Object.freeze(
  PILOT_V2_DEVELOPMENT_SUITE.map(compileAndAttest)
);

export const PILOT_V2_EXECUTION_MANIFEST_SHA256 = sha256Hex(canonicalJson({
  pilotSuiteSha256: PILOT_V2_SUITE_SHA256,
  conditionTrust: PILOT_V2_CONDITION_TRUST,
}));

export type PilotV2UniquenessAudit = Readonly<{
  valid: boolean;
  pilotTurnCount: number;
  uniquePilotTurnCount: number;
  internalDuplicates: readonly string[];
  developmentOverlap: readonly string[];
}>;

/**
 * Exact normalized-text containment is the frozen no-reuse rule. Semantic
 * similarity should be reported separately by an embedding or human audit;
 * it must not silently alter this deterministic artifact.
 */
export function auditPilotV2CallerUniqueness(
  developmentScenarios: readonly BenchmarkScenario[]
): PilotV2UniquenessAudit {
  const pilotTurns = PILOT_V2_DEVELOPMENT_SUITE.flatMap((template) =>
    template.scenario.caller.turns.map((turn) => normalizePilotUtterance(turn.utterance))
  );
  const developmentTurns = new Set(developmentScenarios.flatMap((scenario) =>
    scenario.caller.turns.map((turn) => normalizePilotUtterance(turn.utterance))
  ));
  const seen = new Set<string>();
  const internalDuplicates = new Set<string>();
  for (const utterance of pilotTurns) {
    if (seen.has(utterance)) internalDuplicates.add(utterance);
    seen.add(utterance);
  }
  const developmentOverlap = [...new Set(pilotTurns.filter((utterance) => developmentTurns.has(utterance)))];
  return Object.freeze({
    valid: internalDuplicates.size === 0 && developmentOverlap.length === 0,
    pilotTurnCount: pilotTurns.length,
    uniquePilotTurnCount: seen.size,
    internalDuplicates: Object.freeze([...internalDuplicates].sort()),
    developmentOverlap: Object.freeze(developmentOverlap.sort()),
  });
}

export function pilotV2Template(family: PilotV2Family): PilotV2ScenarioTemplate {
  const found = PILOT_V2_DEVELOPMENT_SUITE.find((template) => template.family === family);
  if (!found) throw new Error(`missing pilot-v2 template for ${family}`);
  return found;
}

export function compilePilotV2ConditionSuite(family: PilotV2Family): CompiledConditionSuite {
  return compileConditionSuite(pilotV2Template(family).compilerInput);
}

function developmentScenarios(): readonly BenchmarkScenario[] {
  return LONG_HORIZON_SCENARIO_SUITE
    .filter((template) => template.studyRole === "development")
    .map((template) => template.scenario);
}

/** Recompute the metrics bound into every pilot scenario before trusting it. */
export function assertPilotV2ExecutionPolicy(): void {
  const development = developmentScenarios();
  const audit = auditPilotV2CallerUniqueness(development);
  if (!audit.valid) throw new Error("pilot-v2 caller corpus overlaps development or itself");
  const developmentTurns = new Set(development.flatMap((scenario) =>
    scenario.caller.turns.map((turn) => normalizePilotUtterance(turn.utterance))
  ));
  for (const template of PILOT_V2_DEVELOPMENT_SUITE) {
    const utterances = template.scenario.caller.turns.map((turn) => normalizePilotUtterance(turn.utterance));
    const uniqueUtterances = new Set(utterances).size;
    const overlap = utterances.filter((utterance) => developmentTurns.has(utterance)).length;
    const expected = {
      schema_version: 1,
      kind: "long_horizon",
      study_role: "development",
      execution_eligibility: "offline-stress-only",
      provider_blockers: [
        "paid scheduler does not yet execute the frozen partial-playback interruption hook",
        "paid scheduler does not yet execute and attest the frozen cold-reconnect hook",
      ],
      declared_turn_count: utterances.length,
      structural_realism: {
        comparator_scenario_id: "long-horizon-development-corpus",
        comparator_scenario_version: "1",
        unique_utterances: uniqueUtterances,
        unique_utterance_ratio: uniqueUtterances / utterances.length,
        development_overlap_turns: overlap,
        development_overlap_ratio: overlap / utterances.length,
        minimum_unique_utterance_ratio: 0.8,
        maximum_development_overlap_ratio: 0.25,
        confirmatory_eligible: false,
        failures: ["development fixture was designed and inspected before confirmatory preregistration"],
      },
    };
    if (canonicalJson(template.scenario.execution_policy) !== canonicalJson(expected)) {
      throw new Error(`${template.scenario.id} hash-bound execution policy differs from the recomputed pilot corpus`);
    }
  }
}

export type PilotV2ProviderRunGate = Readonly<{
  family: PilotV2Family;
  protocolSha256: string;
  runnerConfigSha256: string;
  expectedSuiteSha256: string;
  callerPcm: readonly LongHorizonPcmTurn[];
  limits: LongHorizonProviderExecutionLimits;
}>;

export type PilotV2ProviderRunAuthorization = Readonly<{
  family: PilotV2Family;
  scenarioId: string;
  scenarioSha256: string;
  suiteSha256: string;
  protocolSha256: string;
  runnerConfigSha256: string;
  audioBudget: LongHorizonVerifiedAudioBudget;
  authorizationSha256: string;
}>;

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * A design-feasible template is not automatically authorized for a paid run.
 * The caller audio, transport runner, and protocol must be frozen externally,
 * and the caller must pin the exact suite hash exported above.
 */
export function authorizePilotV2ProviderRun(gate: PilotV2ProviderRunGate): PilotV2ProviderRunAuthorization {
  assertPilotV2ExecutionPolicy();
  for (const [name, value] of [
    ["protocolSha256", gate.protocolSha256],
    ["runnerConfigSha256", gate.runnerConfigSha256],
    ["expectedSuiteSha256", gate.expectedSuiteSha256],
  ] as const) {
    if (!SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  if (gate.expectedSuiteSha256 !== PILOT_V2_SUITE_SHA256) {
    throw new Error(`pilot-v2 suite hash mismatch: expected ${PILOT_V2_SUITE_SHA256}`);
  }
  const template = pilotV2Template(gate.family);
  const eligibility = assessScenarioProviderEligibility(template.scenario, gate.callerPcm, gate.limits);
  if (!eligibility.eligible) {
    throw new Error(`pilot-v2 provider execution ineligible: ${eligibility.failures.join("; ")}`);
  }
  const withoutHash = {
    family: gate.family,
    scenarioId: template.scenario.id,
    scenarioSha256: template.scenarioSha256,
    suiteSha256: PILOT_V2_SUITE_SHA256,
    protocolSha256: gate.protocolSha256,
    runnerConfigSha256: gate.runnerConfigSha256,
    audioBudget: eligibility.budget,
  };
  return Object.freeze({
    ...withoutHash,
    authorizationSha256: sha256Hex(`harshas-amazing-call-center/pilot-v2-authorization/v1\n${canonicalJson(withoutHash)}`),
  });
}
