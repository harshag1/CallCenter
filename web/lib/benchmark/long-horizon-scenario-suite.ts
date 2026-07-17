import type { CanonicalConditionCompilerInput } from "./condition-compiler";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  FIELD_ESCALATION_CALLER_POLICY,
  FIELD_ESCALATION_TURN_COUNTS,
  FIELD_ESCALATION_VARIANT_METADATA,
  fieldEscalationCompilerInput,
  materializeFieldEscalationOraclePlan,
  materializeFieldEscalationScenario,
  type FieldEscalationTurnCount,
} from "./long-horizon-field-escalation";
import {
  HOME_HEALTH_COORDINATION_HORIZONS,
  HOME_HEALTH_COORDINATION_MEASUREMENT_LIMITATIONS,
  HOME_HEALTH_COORDINATION_METADATA,
  HOME_HEALTH_COORDINATION_VARIANTS,
  buildHomeHealthOracleInvocationPlan,
  homeHealthCoordinationCompilerInput,
  type HomeHealthCoordinationHorizon,
} from "./long-horizon-home-health";
import {
  LONG_HORIZON_TRAVEL_RUNNER_REQUIREMENTS,
  TRAVEL_LONG_HORIZON_TURN_COUNTS,
  materializeLongHorizonTravelScenario,
  type TravelLongHorizonTurnCount,
} from "./long-horizon-travel";
import { BenchmarkScenarioSchema, type BenchmarkScenario, type JsonValue } from "./scenario-schema";

export const LONG_HORIZON_FAMILIES = [
  "travel-disruption",
  "home-health-coordination",
  "field-service-escalation",
] as const;

export const LONG_HORIZON_TURN_COUNTS = [32, 64, 120] as const;

export type LongHorizonFamily = typeof LONG_HORIZON_FAMILIES[number];
export type LongHorizonTurnCount = typeof LONG_HORIZON_TURN_COUNTS[number];
export type LongHorizonStudyRole = "development" | "confirmatory-held-out";
export type LongHorizonExecutionEligibility =
  | "development-provider-eligible"
  | "confirmatory-provider-eligible"
  | "offline-stress-only";

export type LongHorizonOracleInvocation = Readonly<{
  invocationId: string;
  tool: string;
  arguments: Readonly<Record<string, JsonValue>>;
  turn: number;
  expectedReceiptStatus: "succeeded" | "failed_before_commit" | "committed_after_error";
}>;

export type LongHorizonScenarioTemplate = Readonly<{
  family: LongHorizonFamily;
  turnCount: LongHorizonTurnCount;
  studyRole: LongHorizonStudyRole;
  heldOut: boolean;
  resultsStatus: "not-run";
  scenario: BenchmarkScenario;
  compilerInput: CanonicalConditionCompilerInput;
  oracleInvocations: readonly LongHorizonOracleInvocation[];
  runnerRequirements: readonly string[];
  executionEligibility: LongHorizonExecutionEligibility;
}>;

function requireExactOracleReceiptCoverage(
  scenario: BenchmarkScenario,
  invocations: readonly LongHorizonOracleInvocation[]
): BenchmarkScenario {
  const byTool = new Map<string, number>();
  const byToolStatus = new Map<string, { tool: string; status: LongHorizonOracleInvocation["expectedReceiptStatus"]; count: number }>();
  for (const invocation of invocations) {
    byTool.set(invocation.tool, (byTool.get(invocation.tool) ?? 0) + 1);
    const key = `${invocation.tool}\u0000${invocation.expectedReceiptStatus}`;
    const prior = byToolStatus.get(key);
    byToolStatus.set(key, {
      tool: invocation.tool,
      status: invocation.expectedReceiptStatus,
      count: (prior?.count ?? 0) + 1,
    });
  }
  const assertions = [
    ...[...byTool.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([tool, count]) => ({
      id: `${tool}.oracle_receipts.total`,
      description: `The strict endpoint contains exactly ${count} declared oracle receipt(s) for ${tool}.`,
      severity: "critical" as const,
      kind: "receipt_count" as const,
      tool,
      operator: "equals" as const,
      value: count,
    })),
    ...[...byToolStatus.values()].sort((left, right) =>
      `${left.tool}/${left.status}`.localeCompare(`${right.tool}/${right.status}`)
    ).map(({ tool, status, count }) => ({
      id: `${tool}.oracle_receipts.${status}`,
      description: `The strict endpoint contains exactly ${count} ${status} oracle receipt(s) for ${tool}.`,
      severity: "critical" as const,
      kind: "receipt_count" as const,
      tool,
      status,
      operator: "equals" as const,
      value: count,
    })),
  ];
  return BenchmarkScenarioSchema.parse({
    ...structuredClone(scenario),
    safety_invariants: [...structuredClone(scenario.safety_invariants), ...assertions],
  });
}

function travelTemplate(turnCount: TravelLongHorizonTurnCount): LongHorizonScenarioTemplate {
  const source = materializeLongHorizonTravelScenario(turnCount);
  const oracleInvocations = Object.freeze(source.oracleInvocations.map((invocation) => Object.freeze({
    invocationId: invocation.invocation_id,
    tool: invocation.tool,
    arguments: invocation.arguments,
    turn: invocation.turn,
    expectedReceiptStatus: invocation.expectedStatus,
  })));
  const scenario = requireExactOracleReceiptCoverage(source.scenario, oracleInvocations);
  return Object.freeze({
    family: "travel-disruption",
    turnCount,
    studyRole: source.metadata.evaluationTier,
    heldOut: source.metadata.heldOut,
    resultsStatus: "not-run",
    scenario,
    compilerInput: Object.freeze({ ...source.compilerInput, scenario }),
    oracleInvocations,
    runnerRequirements: Object.freeze(Object.values(LONG_HORIZON_TRAVEL_RUNNER_REQUIREMENTS)),
    executionEligibility: turnCount === 120 ? "offline-stress-only" : "development-provider-eligible",
  });
}

function homeHealthTemplate(turnCount: HomeHealthCoordinationHorizon): LongHorizonScenarioTemplate {
  const baseScenario = HOME_HEALTH_COORDINATION_VARIANTS[turnCount];
  const metadata = HOME_HEALTH_COORDINATION_METADATA.variants.find((variant) => variant.horizon === turnCount);
  if (!metadata) throw new Error(`missing home-health metadata for ${turnCount} turns`);
  const oracleInvocations = Object.freeze(buildHomeHealthOracleInvocationPlan(turnCount).map((invocation) => Object.freeze({
    invocationId: invocation.invocation_id,
    tool: invocation.tool,
    arguments: invocation.arguments,
    turn: invocation.turn,
    expectedReceiptStatus: invocation.expected,
  })));
  const scenario = requireExactOracleReceiptCoverage(baseScenario, oracleInvocations);
  return Object.freeze({
    family: "home-health-coordination",
    turnCount,
    studyRole: metadata.study_role,
    heldOut: metadata.held_out,
    resultsStatus: "not-run",
    scenario,
    compilerInput: homeHealthCoordinationCompilerInput(scenario),
    oracleInvocations,
    runnerRequirements: HOME_HEALTH_COORDINATION_MEASUREMENT_LIMITATIONS,
    executionEligibility: turnCount === 120 ? "offline-stress-only" : "development-provider-eligible",
  });
}

function fieldServiceTemplate(turnCount: FieldEscalationTurnCount): LongHorizonScenarioTemplate {
  const source = materializeFieldEscalationScenario(turnCount);
  const metadata = FIELD_ESCALATION_VARIANT_METADATA[turnCount];
  const oracleInvocations = Object.freeze(materializeFieldEscalationOraclePlan(turnCount).map((invocation) => Object.freeze({
    invocationId: invocation.invocationId,
    tool: invocation.tool,
    arguments: invocation.arguments,
    turn: invocation.turn,
    expectedReceiptStatus: invocation.expectedReceiptStatus,
  })));
  const scenario = requireExactOracleReceiptCoverage(source.scenario, oracleInvocations);
  return Object.freeze({
    family: "field-service-escalation",
    turnCount,
    studyRole: metadata.evaluationUse,
    heldOut: metadata.heldOut,
    resultsStatus: "not-run",
    scenario,
    compilerInput: fieldEscalationCompilerInput(scenario),
    oracleInvocations,
    runnerRequirements: FIELD_ESCALATION_CALLER_POLICY.measurementLimitations,
    executionEligibility: turnCount === 120 ? "offline-stress-only" : "development-provider-eligible",
  });
}

function materializeRawLongHorizonTemplate(
  family: LongHorizonFamily,
  turnCount: LongHorizonTurnCount
): LongHorizonScenarioTemplate {
  if (family === "travel-disruption") return travelTemplate(turnCount as TravelLongHorizonTurnCount);
  if (family === "home-health-coordination") return homeHealthTemplate(turnCount as HomeHealthCoordinationHorizon);
  return fieldServiceTemplate(turnCount as FieldEscalationTurnCount);
}

function assertSourceCounts(): void {
  const expected = LONG_HORIZON_TURN_COUNTS.join(",");
  for (const source of [
    TRAVEL_LONG_HORIZON_TURN_COUNTS,
    HOME_HEALTH_COORDINATION_HORIZONS,
    FIELD_ESCALATION_TURN_COUNTS,
  ]) {
    if (source.join(",") !== expected) {
      throw new Error(`long-horizon source count drift: expected ${expected}, received ${source.join(",")}`);
    }
  }
}

assertSourceCounts();

export type ConfirmatoryFreezeBundle = Readonly<{
  preregistrationHash: string;
  conditionSuiteHash: string;
  audioFixtureHash: string;
  runnerConfigHash: string;
}>;

export const LONG_HORIZON_REALISM_THRESHOLDS = Object.freeze({
  minimumUniqueUtteranceRatio: 0.8,
  maximumDevelopmentOverlapRatio: 0.25,
});

export type LongHorizonRealismMetrics = Readonly<{
  uniqueUtterances: number;
  uniqueUtteranceRatio: number;
  developmentOverlapTurns: number;
  developmentOverlapRatio: number;
  confirmatoryEligible: boolean;
  failures: readonly string[];
}>;

function calculateLongHorizonRealism(
  template: LongHorizonScenarioTemplate,
  development: LongHorizonScenarioTemplate
): LongHorizonRealismMetrics {
  const utterances = template.scenario.caller.turns.map((turn) => turn.utterance);
  const uniqueUtterances = new Set(utterances).size;
  const developmentUtterances = new Set(development.scenario.caller.turns.map((turn) => turn.utterance));
  const developmentOverlapTurns = utterances.filter((utterance) => developmentUtterances.has(utterance)).length;
  const uniqueUtteranceRatio = uniqueUtterances / utterances.length;
  const developmentOverlapRatio = developmentOverlapTurns / utterances.length;
  const failures: string[] = [];
  if (uniqueUtteranceRatio < LONG_HORIZON_REALISM_THRESHOLDS.minimumUniqueUtteranceRatio) {
    failures.push(
      `unique utterance ratio ${uniqueUtteranceRatio.toFixed(4)} is below ${LONG_HORIZON_REALISM_THRESHOLDS.minimumUniqueUtteranceRatio.toFixed(4)}`
    );
  }
  if (developmentOverlapRatio > LONG_HORIZON_REALISM_THRESHOLDS.maximumDevelopmentOverlapRatio) {
    failures.push(
      `development overlap ratio ${developmentOverlapRatio.toFixed(4)} exceeds ${LONG_HORIZON_REALISM_THRESHOLDS.maximumDevelopmentOverlapRatio.toFixed(4)}`
    );
  }
  if (template.executionEligibility === "offline-stress-only") {
    failures.push("template is classified offline-stress-only pending a newly versioned provider-realistic caller set");
  }
  return Object.freeze({
    uniqueUtterances,
    uniqueUtteranceRatio,
    developmentOverlapTurns,
    developmentOverlapRatio,
    confirmatoryEligible: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

function expectedExecutionPolicy(
  template: LongHorizonScenarioTemplate,
  development: LongHorizonScenarioTemplate,
  realism: LongHorizonRealismMetrics
) {
  return Object.freeze({
    schema_version: 1 as const,
    kind: "long_horizon" as const,
    study_role: template.studyRole,
    execution_eligibility: template.executionEligibility,
    declared_turn_count: template.turnCount,
    structural_realism: Object.freeze({
      comparator_scenario_id: development.scenario.id,
      comparator_scenario_version: development.scenario.version,
      unique_utterances: realism.uniqueUtterances,
      unique_utterance_ratio: realism.uniqueUtteranceRatio,
      development_overlap_turns: realism.developmentOverlapTurns,
      development_overlap_ratio: realism.developmentOverlapRatio,
      minimum_unique_utterance_ratio: LONG_HORIZON_REALISM_THRESHOLDS.minimumUniqueUtteranceRatio,
      maximum_development_overlap_ratio: LONG_HORIZON_REALISM_THRESHOLDS.maximumDevelopmentOverlapRatio,
      confirmatory_eligible: realism.confirmatoryEligible,
      failures: realism.failures,
    }),
  });
}

function bindExecutionPolicy(
  template: LongHorizonScenarioTemplate,
  development: LongHorizonScenarioTemplate
): LongHorizonScenarioTemplate {
  const realism = calculateLongHorizonRealism(template, development);
  const scenario = BenchmarkScenarioSchema.parse({
    ...structuredClone(template.scenario),
    execution_policy: expectedExecutionPolicy(template, development, realism),
  });
  return Object.freeze({
    ...template,
    scenario,
    compilerInput: Object.freeze({ ...template.compilerInput, scenario }),
  });
}

/** Materialize one strict, hash-bound template including execution policy. */
export function materializeLongHorizonTemplate(
  family: LongHorizonFamily,
  turnCount: LongHorizonTurnCount
): LongHorizonScenarioTemplate {
  const raw = materializeRawLongHorizonTemplate(family, turnCount);
  const development = materializeRawLongHorizonTemplate(family, 64);
  return bindExecutionPolicy(raw, development);
}

export const LONG_HORIZON_SCENARIO_SUITE: readonly LongHorizonScenarioTemplate[] = Object.freeze(
  LONG_HORIZON_FAMILIES.flatMap((family) =>
    LONG_HORIZON_TURN_COUNTS.map((turnCount) => materializeLongHorizonTemplate(family, turnCount))
  )
);

export function measureLongHorizonRealism(template: LongHorizonScenarioTemplate): LongHorizonRealismMetrics {
  const development = LONG_HORIZON_SCENARIO_SUITE.find((candidate) =>
    candidate.family === template.family && candidate.turnCount === 64
  );
  if (!development) throw new Error(`missing 64-turn realism comparator for ${template.family}`);
  return calculateLongHorizonRealism(template, development);
}

/**
 * Recompute every cross-scenario metric and compare it to the policy bound into
 * the canonical scenario. Registries and runners should call this before
 * trusting `execution_eligibility`.
 */
export function assertLongHorizonExecutionPolicy(template: LongHorizonScenarioTemplate): void {
  const development = LONG_HORIZON_SCENARIO_SUITE.find((candidate) =>
    candidate.family === template.family && candidate.turnCount === 64
  );
  if (!development) throw new Error(`missing 64-turn realism comparator for ${template.family}`);
  const realism = calculateLongHorizonRealism(template, development);
  const expected = expectedExecutionPolicy(template, development, realism);
  const parsed = BenchmarkScenarioSchema.parse(template.scenario);
  if (!parsed.execution_policy) throw new Error(`${template.scenario.id} has no hash-bound execution policy`);
  if (canonicalJson(parsed.execution_policy) !== canonicalJson(expected)) {
    throw new Error(`${template.scenario.id} hash-bound execution policy differs from recomputed structural metrics`);
  }
}

export type LongHorizonProviderExecutionLimits = Readonly<{
  minimumResponseMsPerTurn: number;
  setupAndTeardownReserveMs: number;
  maxSessionMs: number;
}>;

export type LongHorizonPcmTurn = Readonly<{
  turnId: string;
  audio: Readonly<{
    encoding: "pcm16";
    sampleRateHz: number;
    channels: 1;
    data: Uint8Array;
  }>;
}>;

export type LongHorizonVerifiedAudioBudget = Readonly<{
  audioFixtureBindingSha256: string;
  verifiedAudioBindingSha256: string;
  sampleRateHz: number;
  callerAudioDurationMs: number;
  callerAudioByteLength: number;
  minimumResponseMsPerTurn: number;
  setupAndTeardownReserveMs: number;
  maxSessionMs: number;
}>;

export type LongHorizonProviderEligibility = Readonly<{
  eligible: boolean;
  requiredSessionMs: number;
  remainingSessionMs: number;
  failures: readonly string[];
  budget: LongHorizonVerifiedAudioBudget;
}>;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const VERIFIED_AUDIO_BINDING_DOMAIN = "harshas-amazing-call-center/long-horizon-verified-audio/v1\n";

function assertProviderExecutionLimits(limits: LongHorizonProviderExecutionLimits): void {
  for (const [name, value] of [
    ["minimumResponseMsPerTurn", limits.minimumResponseMsPerTurn],
    ["setupAndTeardownReserveMs", limits.setupAndTeardownReserveMs],
    ["maxSessionMs", limits.maxSessionMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  }
  if (limits.minimumResponseMsPerTurn === 0) throw new Error("minimumResponseMsPerTurn must be positive");
  if (limits.maxSessionMs === 0) throw new Error("maxSessionMs must be positive");
}

/**
 * Re-read every selected PCM payload and derive duration/hash evidence from
 * bytes. No caller-authored duration or audio hash is accepted by this gate.
 */
export function assessLongHorizonProviderEligibility(
  template: LongHorizonScenarioTemplate,
  callerPcm: readonly LongHorizonPcmTurn[],
  limits: LongHorizonProviderExecutionLimits
): LongHorizonProviderEligibility {
  assertLongHorizonExecutionPolicy(template);
  return assessScenarioProviderEligibility(template.scenario, callerPcm, limits);
}

/**
 * Generic verified-PCM/session gate shared by every strict benchmark scenario.
 * Suite-specific callers must recompute their own cross-scenario execution
 * policy before calling this byte-level boundary.
 */
export function assessScenarioProviderEligibility(
  scenario: BenchmarkScenario,
  callerPcm: readonly LongHorizonPcmTurn[],
  limits: LongHorizonProviderExecutionLimits
): LongHorizonProviderEligibility {
  assertProviderExecutionLimits(limits);
  const parsedScenario = BenchmarkScenarioSchema.parse(scenario);
  if (!parsedScenario.execution_policy) {
    throw new Error(`${parsedScenario.id} has no hash-bound execution policy`);
  }
  const scenarioHash = sha256Hex(canonicalJson(parsedScenario));
  if (!Array.isArray(callerPcm)) {
    throw new Error("provider execution requires actual caller PCM bytes; hash/duration claims are not accepted");
  }
  if (callerPcm.length !== parsedScenario.caller.turns.length) {
    throw new Error("caller PCM must cover every scenario caller turn exactly once");
  }

  let callerAudioDurationMs = 0;
  let callerAudioByteLength = 0;
  let sessionSampleRateHz: number | null = null;
  const verifiedTurns = callerPcm.map((turn, index) => {
    const expected = parsedScenario.caller.turns[index];
    if (turn.turnId !== expected.id) {
      throw new Error(`caller PCM turn ${index + 1} does not match ${expected.id}`);
    }
    const audio = turn.audio;
    if (
      audio.encoding !== "pcm16"
      || audio.channels !== 1
      || !Number.isSafeInteger(audio.sampleRateHz)
      || audio.sampleRateHz <= 0
      || !(audio.data instanceof Uint8Array)
      || audio.data.byteLength === 0
      || audio.data.byteLength % 2 !== 0
    ) {
      throw new Error(`caller audio ${expected.id} must be non-empty, complete mono PCM16`);
    }
    if (sessionSampleRateHz === null) sessionSampleRateHz = audio.sampleRateHz;
    if (audio.sampleRateHz !== sessionSampleRateHz) {
      throw new Error(`caller audio ${expected.id} changes sample rate within one realtime session`);
    }
    const payloadHash = sha256Hex(audio.data);
    const sampleCount = audio.data.byteLength / 2;
    callerAudioByteLength += audio.data.byteLength;
    callerAudioDurationMs += sampleCount / audio.sampleRateHz * 1_000;
    if (!Number.isSafeInteger(callerAudioByteLength) || !Number.isFinite(callerAudioDurationMs)) {
      throw new Error("caller PCM aggregate exceeds numeric bounds");
    }
    return Object.freeze({
      ordinal: index + 1,
      callerTurnId: turn.turnId,
      sha256: payloadHash,
      byteLength: audio.data.byteLength,
      sampleCount,
      sampleRateHz: audio.sampleRateHz,
    });
  });
  const verifiedAudioBindingSha256 = sha256Hex(`${VERIFIED_AUDIO_BINDING_DOMAIN}${canonicalJson({
    scenarioId: parsedScenario.id,
    scenarioVersion: parsedScenario.version,
    scenarioSha256: scenarioHash,
    turns: verifiedTurns,
  })}`);
  const requiredSessionMs = Math.ceil(
    callerAudioDurationMs
    + limits.setupAndTeardownReserveMs
    + parsedScenario.caller.turns.length * limits.minimumResponseMsPerTurn
  );
  const remainingSessionMs = limits.maxSessionMs - requiredSessionMs;
  const failures: string[] = [];
  if (parsedScenario.execution_policy.execution_eligibility === "offline-stress-only") {
    failures.push(`${parsedScenario.id} is classified offline-stress-only`);
  }
  if (remainingSessionMs < 0) {
    failures.push(
      `verified caller PCM plus minimum response budget requires ${requiredSessionMs}ms, exceeding maxSessionMs ${limits.maxSessionMs}`
    );
  }
  const budget = Object.freeze({
    audioFixtureBindingSha256: verifiedAudioBindingSha256,
    verifiedAudioBindingSha256,
    sampleRateHz: sessionSampleRateHz!,
    callerAudioDurationMs,
    callerAudioByteLength,
    ...limits,
  });
  return Object.freeze({
    eligible: failures.length === 0,
    requiredSessionMs,
    remainingSessionMs,
    failures: Object.freeze(failures),
    budget,
  });
}

export type LongHorizonProviderRunRequest = Readonly<{
  purpose: "development" | "confirmatory";
  callerPcm: readonly LongHorizonPcmTurn[];
  limits: LongHorizonProviderExecutionLimits;
  freezeBundle?: ConfirmatoryFreezeBundle;
}>;

export type LongHorizonOfflineRunRequest = Readonly<{
  purpose: "offline-stress";
}>;

export type LongHorizonRunRequest = LongHorizonProviderRunRequest | LongHorizonOfflineRunRequest;

export type LongHorizonRunAuthorization = Readonly<{
  scenarioId: string;
  scenarioVersion: string;
  family: LongHorizonFamily;
  turnCount: LongHorizonTurnCount;
  purpose: "development" | "confirmatory" | "offline-stress";
  freezeBundle: ConfirmatoryFreezeBundle | null;
  providerSessionBudget: LongHorizonVerifiedAudioBudget | null;
  authorizationHash: string;
}>;

/**
 * One metadata authorization boundary for schedulers. It binds strict scenario
 * policy, actual verified PCM bytes, provider limits, and (for confirmatory
 * evidence) the complete freeze bundle. The paid runner must include the
 * returned authorization hash in its execution plan; this function opens no
 * provider connection and authorizes no spend by itself.
 */
export function authorizeLongHorizonTemplateRun(
  template: LongHorizonScenarioTemplate,
  request: LongHorizonRunRequest
): LongHorizonRunAuthorization {
  assertLongHorizonExecutionPolicy(template);
  const purpose = request.purpose;
  const policy = template.scenario.execution_policy!;
  let providerSessionBudget: LongHorizonVerifiedAudioBudget | null = null;
  let freezeBundle: ConfirmatoryFreezeBundle | null = null;

  if (purpose === "offline-stress") {
    if (policy.execution_eligibility !== "offline-stress-only") {
      throw new Error(`${template.scenario.id} is provider eligible and is not an offline-only stress fixture`);
    }
  } else {
    const providerEligibility = assessLongHorizonProviderEligibility(
      template,
      request.callerPcm,
      request.limits
    );
    if (!providerEligibility.eligible) {
      throw new Error(`provider execution ineligible: ${providerEligibility.failures.join("; ")}`);
    }
    providerSessionBudget = providerEligibility.budget;
  }
  if (template.heldOut) {
    if (purpose === "offline-stress") {
      // The source-visible 120-turn fixtures remain useful for deterministic
      // offline retention stress while their realism gate is red.
    } else if (purpose !== "confirmatory") {
      throw new Error(`${template.scenario.id} is confirmatory-held-out and cannot be used for development tuning`);
    }
    if (purpose === "confirmatory" && policy.execution_eligibility !== "confirmatory-provider-eligible") {
      throw new Error(`confirmatory realism gate failed: ${policy.structural_realism.failures.join("; ")}`);
    }
    if (purpose === "confirmatory" && !request.freezeBundle) {
      throw new Error("confirmatory execution requires frozen preregistration, condition-suite, audio-fixture, and runner-config hashes");
    }
    freezeBundle = request.purpose === "confirmatory" ? request.freezeBundle ?? null : null;
    for (const [label, hash] of Object.entries(freezeBundle ?? {})) {
      if (!SHA256_HEX.test(hash)) throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
    }
    if (
      purpose === "confirmatory"
      && freezeBundle?.audioFixtureHash !== providerSessionBudget?.audioFixtureBindingSha256
    ) {
      throw new Error("confirmatory audioFixtureHash must equal the verified PCM-byte binding hash");
    }
  } else if (purpose !== "development") {
    throw new Error(`${template.scenario.id} is a development template and cannot be represented as confirmatory evidence`);
  } else if (policy.execution_eligibility !== "development-provider-eligible") {
    throw new Error(`${template.scenario.id} is not eligible for provider development execution`);
  }

  const withoutHash = {
    scenarioId: template.scenario.id,
    scenarioVersion: template.scenario.version,
    family: template.family,
    turnCount: template.turnCount,
    purpose,
    executionPolicy: policy,
    freezeBundle,
    providerSessionBudget,
  };
  return Object.freeze({
    ...withoutHash,
    authorizationHash: sha256Hex(`long-horizon-run-authorization.v1\n${canonicalJson(withoutHash)}`),
  });
}
