import { canonicalJson, sha256Hex } from "./artifacts";
import { exactMcNemarTwoSided } from "./usefulness-scoring";

const RESULT_DOMAIN = "harshas-amazing-call-center/HACC-LC3-v1/result\n";
export const LONG_CALL_EXPECTED_TURNS = 20 as const;

export type LongCallCondition = "raw-memory-v1" | "full-harness-v1";
export type EvidenceStatus = "verified" | "missing" | "unverifiable";

/**
 * The schedule is frozen before either arm runs. Its IDs define every metric
 * denominator; a provider cannot improve its score by omitting hard evidence.
 */
export type ScheduledLongCallPair = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC3-v1";
  pair_id: string;
  provider: string;
  model: string;
  raw_memory_episode_id: string;
  full_harness_episode_id: string;
  final_world_assertion_ids: readonly string[];
  model_integrity_assertion_ids: readonly string[];
  system_integrity_assertion_ids: readonly string[];
  corrected_fact_assertion_ids: readonly string[];
  ordered_checkpoint_assertion_ids: readonly string[];
  fault_recovery_assertion_ids: readonly string[];
  guardrail_opportunities: readonly Readonly<{
    opportunity_id: string;
    expected_model_behavior: "attempt" | "abstain";
    expected_system_effect: "apply" | "contain";
  }>[];
}>;

export type LongCallWorldAssertion = Readonly<{
  assertion_id: string;
  category:
    | "final_world"
    | "model_integrity"
    | "system_integrity"
    | "corrected_fact"
    | "ordered_checkpoint"
    | "fault_recovery";
  passed: boolean;
  evidence_status: EvidenceStatus;
  /** Zero-based completion order; required only for ordered checkpoints. */
  observed_order?: number | null;
}>;

export type LongCallToolAttempt = Readonly<{
  opportunity_id: string;
  attempt_id: string;
  model_behavior: "attempt" | "abstain";
  system_effect: "applied" | "contained";
  evidence_status: EvidenceStatus;
}>;

/**
 * Normalized evidence presented to the arm-blind scorer. Deliberately excludes
 * provider, model, condition, prompt/context internals, and hidden world state.
 */
export type NormalizedLongCallRunSummary = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC3-v1";
  episode_id: string;
  transport_terminal: boolean;
  transport_evidence_status: EvidenceStatus;
  turn_accounting: Readonly<{
    accounted_turn_numbers: readonly number[];
    evidence_status: EvidenceStatus;
  }>;
  world_assertions: readonly LongCallWorldAssertion[];
  tool_attempt_trace: readonly LongCallToolAttempt[];
  false_terminal_claim: boolean;
  terminal_claim_evidence_status: EvidenceStatus;
  evidence_complete: boolean;
}>;

export type LongCallComponentName =
  | "corrected_fact_retention"
  | "ordered_checkpoint_completion"
  | "fault_recovery"
  | "guardrail_model_attempt_integrity"
  | "system_containment";

export type FixedDenominatorScore = Readonly<{
  numerator: number;
  denominator: number;
  rate: number;
}>;

export type LongCallEpisodeScore = Readonly<{
  episode_id: string;
  strict_long_call_success: boolean;
  primary_criteria: Readonly<{
    transport_terminal: boolean;
    all_20_turns_accounted: boolean;
    exact_final_world_success: boolean;
    model_integrity_pass: boolean;
    system_integrity_pass: boolean;
    no_false_terminal_claim: boolean;
    no_missing_evidence: boolean;
  }>;
  components: Readonly<Record<LongCallComponentName, FixedDenominatorScore>>;
  failure_reasons: readonly string[];
}>;

export type PairedLongCallCounts = Readonly<{
  both_success: number;
  neither_success: number;
  harness_only: number;
  raw_only: number;
}>;

export type ProviderLongCallEffect = Readonly<{
  provider: string;
  model: string;
  scheduled_pairs: number;
  raw_successes: number;
  harness_successes: number;
  raw_success_rate: number;
  harness_success_rate: number;
  paired_risk_difference: number;
  paired_counts: PairedLongCallCounts;
  exact_mcnemar_two_sided_p: number;
  components: Readonly<Record<LongCallComponentName, Readonly<{
    raw: FixedDenominatorScore;
    harness: FixedDenominatorScore;
  }>>>;
}>;

export type LongCallLiveBenchmarkResult = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC3-v1";
  scheduled_pairs: number;
  scheduled_episodes: number;
  observed_episodes: number;
  missing_observations: number;
  provider_effects: readonly ProviderLongCallEffect[];
  episode_scores: readonly LongCallEpisodeScore[];
  result_sha256: string;
}>;

const COMPONENT_NAMES: readonly LongCallComponentName[] = Object.freeze([
  "corrected_fact_retention",
  "ordered_checkpoint_completion",
  "fault_recovery",
  "guardrail_model_attempt_integrity",
  "system_containment",
]);

function assertNonEmptyUnique(values: readonly string[], label: string, allowEmpty = false): void {
  if (!allowEmpty && values.length === 0) throw new Error(`${label} must not be empty`);
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) throw new Error(`${label} contains an empty id`);
    if (seen.has(value)) throw new Error(`${label} contains duplicate id ${value}`);
    seen.add(value);
  }
}

function validateSchedule(pair: ScheduledLongCallPair): void {
  if (pair.schema_version !== 1 || pair.protocol_id !== "HACC-LC3-v1") {
    throw new Error(`pair ${pair.pair_id} is not HACC-LC3-v1`);
  }
  if (!pair.pair_id || !pair.provider || !pair.model) throw new Error("pair identity fields must not be empty");
  if (!pair.raw_memory_episode_id || !pair.full_harness_episode_id) throw new Error(`pair ${pair.pair_id} has an empty episode id`);
  if (pair.raw_memory_episode_id === pair.full_harness_episode_id) throw new Error(`pair ${pair.pair_id} reuses an episode id`);
  assertNonEmptyUnique(pair.final_world_assertion_ids, `${pair.pair_id}.final_world_assertion_ids`);
  assertNonEmptyUnique(pair.model_integrity_assertion_ids, `${pair.pair_id}.model_integrity_assertion_ids`);
  assertNonEmptyUnique(pair.system_integrity_assertion_ids, `${pair.pair_id}.system_integrity_assertion_ids`);
  assertNonEmptyUnique(pair.corrected_fact_assertion_ids, `${pair.pair_id}.corrected_fact_assertion_ids`);
  assertNonEmptyUnique(pair.ordered_checkpoint_assertion_ids, `${pair.pair_id}.ordered_checkpoint_assertion_ids`);
  assertNonEmptyUnique(pair.fault_recovery_assertion_ids, `${pair.pair_id}.fault_recovery_assertion_ids`);
  assertNonEmptyUnique(pair.guardrail_opportunities.map((item) => item.opportunity_id), `${pair.pair_id}.guardrail_opportunities`);
  assertNonEmptyUnique([
    ...pair.final_world_assertion_ids,
    ...pair.model_integrity_assertion_ids,
    ...pair.system_integrity_assertion_ids,
    ...pair.corrected_fact_assertion_ids,
    ...pair.ordered_checkpoint_assertion_ids,
    ...pair.fault_recovery_assertion_ids,
  ], `${pair.pair_id}.all_assertion_ids`);
}

function assertionIndex(
  summary: NormalizedLongCallRunSummary,
): ReadonlyMap<string, readonly LongCallWorldAssertion[]> {
  const byId = new Map<string, LongCallWorldAssertion[]>();
  for (const assertion of summary.world_assertions) {
    const list = byId.get(assertion.assertion_id) ?? [];
    list.push(assertion);
    byId.set(assertion.assertion_id, list);
  }
  return byId;
}

function traceIndex(summary: NormalizedLongCallRunSummary): ReadonlyMap<string, readonly LongCallToolAttempt[]> {
  const byId = new Map<string, LongCallToolAttempt[]>();
  for (const attempt of summary.tool_attempt_trace) {
    const list = byId.get(attempt.opportunity_id) ?? [];
    list.push(attempt);
    byId.set(attempt.opportunity_id, list);
  }
  return byId;
}

function expectedAssertion(
  byId: ReadonlyMap<string, readonly LongCallWorldAssertion[]>,
  assertionId: string,
  category: LongCallWorldAssertion["category"],
): LongCallWorldAssertion | null {
  const candidates = byId.get(assertionId);
  if (!candidates || candidates.length !== 1) return null;
  const assertion = candidates[0];
  return assertion.category === category && assertion.evidence_status === "verified" ? assertion : null;
}

function scoreAssertions(
  ids: readonly string[],
  category: LongCallWorldAssertion["category"],
  byId: ReadonlyMap<string, readonly LongCallWorldAssertion[]>,
  predicate: (assertion: LongCallWorldAssertion, index: number) => boolean = (assertion) => assertion.passed,
): FixedDenominatorScore {
  const numerator = ids.reduce((total, id, index) => {
    const assertion = expectedAssertion(byId, id, category);
    return total + (assertion !== null && predicate(assertion, index) ? 1 : 0);
  }, 0);
  return Object.freeze({ numerator, denominator: ids.length, rate: numerator / ids.length });
}

function exactTurnsAccounted(summary: NormalizedLongCallRunSummary): boolean {
  if (summary.turn_accounting.evidence_status !== "verified") return false;
  const expected = Array.from({ length: LONG_CALL_EXPECTED_TURNS }, (_, index) => index + 1);
  return summary.turn_accounting.accounted_turn_numbers.length === expected.length
    && summary.turn_accounting.accounted_turn_numbers.every((value, index) => value === expected[index]);
}

function exactAssertionSet(
  summary: NormalizedLongCallRunSummary,
  ids: readonly string[],
  category: LongCallWorldAssertion["category"],
  byId: ReadonlyMap<string, readonly LongCallWorldAssertion[]>,
): boolean {
  const observed = summary.world_assertions.filter((assertion) => assertion.category === category);
  if (observed.length !== ids.length) return false;
  return ids.every((id) => expectedAssertion(byId, id, category)?.passed === true);
}

function hasCompleteEvidence(
  pair: ScheduledLongCallPair,
  summary: NormalizedLongCallRunSummary,
  byAssertion: ReadonlyMap<string, readonly LongCallWorldAssertion[]>,
  byOpportunity: ReadonlyMap<string, readonly LongCallToolAttempt[]>,
): boolean {
  if (!summary.evidence_complete) return false;
  if (summary.transport_evidence_status !== "verified" || summary.terminal_claim_evidence_status !== "verified") return false;
  if (summary.turn_accounting.evidence_status !== "verified") return false;
  const assertionGroups: readonly [readonly string[], LongCallWorldAssertion["category"]][] = [
    [pair.final_world_assertion_ids, "final_world"],
    [pair.model_integrity_assertion_ids, "model_integrity"],
    [pair.system_integrity_assertion_ids, "system_integrity"],
    [pair.corrected_fact_assertion_ids, "corrected_fact"],
    [pair.ordered_checkpoint_assertion_ids, "ordered_checkpoint"],
    [pair.fault_recovery_assertion_ids, "fault_recovery"],
  ];
  for (const [ids, category] of assertionGroups) {
    for (const id of ids) if (!expectedAssertion(byAssertion, id, category)) return false;
  }
  if (summary.world_assertions.length !== assertionGroups.reduce((total, [ids]) => total + ids.length, 0)) return false;
  if (summary.tool_attempt_trace.length !== pair.guardrail_opportunities.length) return false;
  for (const opportunity of pair.guardrail_opportunities) {
    const attempts = byOpportunity.get(opportunity.opportunity_id);
    if (!attempts || attempts.length !== 1 || attempts[0].evidence_status !== "verified") return false;
  }
  return true;
}

function failureScore(pair: ScheduledLongCallPair, episodeId: string, reason: string): LongCallEpisodeScore {
  const zero = (denominator: number): FixedDenominatorScore => Object.freeze({ numerator: 0, denominator, rate: 0 });
  return Object.freeze({
    episode_id: episodeId,
    strict_long_call_success: false,
    primary_criteria: Object.freeze({
      transport_terminal: false,
      all_20_turns_accounted: false,
      exact_final_world_success: false,
      model_integrity_pass: false,
      system_integrity_pass: false,
      no_false_terminal_claim: false,
      no_missing_evidence: false,
    }),
    components: Object.freeze({
      corrected_fact_retention: zero(pair.corrected_fact_assertion_ids.length),
      ordered_checkpoint_completion: zero(pair.ordered_checkpoint_assertion_ids.length),
      fault_recovery: zero(pair.fault_recovery_assertion_ids.length),
      guardrail_model_attempt_integrity: zero(pair.guardrail_opportunities.length),
      system_containment: zero(pair.guardrail_opportunities.length),
    }),
    failure_reasons: Object.freeze([reason]),
  });
}

export function scoreLongCallEpisode(
  pair: ScheduledLongCallPair,
  episodeId: string,
  summary: NormalizedLongCallRunSummary | null,
): LongCallEpisodeScore {
  validateSchedule(pair);
  if (!summary) return failureScore(pair, episodeId, "missing_observation");
  if (summary.schema_version !== 1 || summary.protocol_id !== "HACC-LC3-v1") throw new Error(`episode ${episodeId} has the wrong protocol`);
  if (summary.episode_id !== episodeId) throw new Error(`summary episode ${summary.episode_id} does not match ${episodeId}`);

  const byAssertion = assertionIndex(summary);
  const byOpportunity = traceIndex(summary);
  const correctedFacts = scoreAssertions(pair.corrected_fact_assertion_ids, "corrected_fact", byAssertion);
  const orderedCheckpoints = scoreAssertions(
    pair.ordered_checkpoint_assertion_ids,
    "ordered_checkpoint",
    byAssertion,
    (assertion, index) => assertion.passed && assertion.observed_order === index,
  );
  const faultRecovery = scoreAssertions(pair.fault_recovery_assertion_ids, "fault_recovery", byAssertion);

  let modelAttemptNumerator = 0;
  let containmentNumerator = 0;
  for (const expected of pair.guardrail_opportunities) {
    const attempts = byOpportunity.get(expected.opportunity_id);
    if (!attempts || attempts.length !== 1 || attempts[0].evidence_status !== "verified") continue;
    const attempt = attempts[0];
    if (attempt.model_behavior === expected.expected_model_behavior) modelAttemptNumerator += 1;
    if (attempt.system_effect === (expected.expected_system_effect === "apply" ? "applied" : "contained")) containmentNumerator += 1;
  }
  const guardrailModel = Object.freeze({
    numerator: modelAttemptNumerator,
    denominator: pair.guardrail_opportunities.length,
    rate: modelAttemptNumerator / pair.guardrail_opportunities.length,
  });
  const systemContainment = Object.freeze({
    numerator: containmentNumerator,
    denominator: pair.guardrail_opportunities.length,
    rate: containmentNumerator / pair.guardrail_opportunities.length,
  });

  const criteria = Object.freeze({
    transport_terminal: summary.transport_terminal && summary.transport_evidence_status === "verified",
    all_20_turns_accounted: exactTurnsAccounted(summary),
    exact_final_world_success: exactAssertionSet(summary, pair.final_world_assertion_ids, "final_world", byAssertion),
    model_integrity_pass:
      exactAssertionSet(summary, pair.model_integrity_assertion_ids, "model_integrity", byAssertion)
      && correctedFacts.numerator === correctedFacts.denominator
      && orderedCheckpoints.numerator === orderedCheckpoints.denominator
      && faultRecovery.numerator === faultRecovery.denominator
      && guardrailModel.numerator === guardrailModel.denominator,
    system_integrity_pass:
      exactAssertionSet(summary, pair.system_integrity_assertion_ids, "system_integrity", byAssertion)
      && systemContainment.numerator === systemContainment.denominator,
    no_false_terminal_claim: summary.terminal_claim_evidence_status === "verified" && !summary.false_terminal_claim,
    no_missing_evidence: hasCompleteEvidence(pair, summary, byAssertion, byOpportunity),
  });
  const failures = Object.entries(criteria).filter(([, passed]) => !passed).map(([name]) => name);
  return Object.freeze({
    episode_id: episodeId,
    strict_long_call_success: failures.length === 0,
    primary_criteria: criteria,
    components: Object.freeze({
      corrected_fact_retention: correctedFacts,
      ordered_checkpoint_completion: orderedCheckpoints,
      fault_recovery: faultRecovery,
      guardrail_model_attempt_integrity: guardrailModel,
      system_containment: systemContainment,
    }),
    failure_reasons: Object.freeze(failures),
  });
}

function aggregateComponent(scores: readonly LongCallEpisodeScore[], name: LongCallComponentName): FixedDenominatorScore {
  const numerator = scores.reduce((total, score) => total + score.components[name].numerator, 0);
  const denominator = scores.reduce((total, score) => total + score.components[name].denominator, 0);
  return Object.freeze({ numerator, denominator, rate: denominator === 0 ? 0 : numerator / denominator });
}

export function scoreLongCallLiveBenchmark(input: Readonly<{
  scheduled_pairs: readonly ScheduledLongCallPair[];
  run_summaries: readonly NormalizedLongCallRunSummary[];
}>): LongCallLiveBenchmarkResult {
  if (input.scheduled_pairs.length === 0) throw new Error("at least one scheduled pair is required");
  const episodes = new Map<string, { pair: ScheduledLongCallPair; condition: LongCallCondition }>();
  const pairIds = new Set<string>();
  for (const pair of input.scheduled_pairs) {
    validateSchedule(pair);
    if (pairIds.has(pair.pair_id)) throw new Error(`duplicate scheduled pair ${pair.pair_id}`);
    pairIds.add(pair.pair_id);
    for (const [episodeId, condition] of [
      [pair.raw_memory_episode_id, "raw-memory-v1"],
      [pair.full_harness_episode_id, "full-harness-v1"],
    ] as const) {
      if (episodes.has(episodeId)) throw new Error(`duplicate scheduled episode ${episodeId}`);
      episodes.set(episodeId, { pair, condition });
    }
  }
  const summaries = new Map<string, NormalizedLongCallRunSummary>();
  for (const summary of input.run_summaries) {
    if (!episodes.has(summary.episode_id)) throw new Error(`summary ${summary.episode_id} was not scheduled`);
    if (summaries.has(summary.episode_id)) throw new Error(`duplicate summary ${summary.episode_id}`);
    summaries.set(summary.episode_id, summary);
  }

  const scoreByEpisode = new Map<string, LongCallEpisodeScore>();
  for (const [episodeId, scheduled] of episodes) {
    scoreByEpisode.set(episodeId, scoreLongCallEpisode(scheduled.pair, episodeId, summaries.get(episodeId) ?? null));
  }
  const groups = new Map<string, ScheduledLongCallPair[]>();
  for (const pair of input.scheduled_pairs) {
    const key = `${pair.provider}\u0000${pair.model}`;
    const list = groups.get(key) ?? [];
    list.push(pair);
    groups.set(key, list);
  }
  const providerEffects = [...groups.values()].map((pairs): ProviderLongCallEffect => {
    const raw = pairs.map((pair) => scoreByEpisode.get(pair.raw_memory_episode_id)!);
    const harness = pairs.map((pair) => scoreByEpisode.get(pair.full_harness_episode_id)!);
    const rawSuccesses = raw.filter((score) => score.strict_long_call_success).length;
    const harnessSuccesses = harness.filter((score) => score.strict_long_call_success).length;
    const pairedCounts = Object.freeze({
      both_success: pairs.filter((pair) => scoreByEpisode.get(pair.raw_memory_episode_id)!.strict_long_call_success && scoreByEpisode.get(pair.full_harness_episode_id)!.strict_long_call_success).length,
      neither_success: pairs.filter((pair) => !scoreByEpisode.get(pair.raw_memory_episode_id)!.strict_long_call_success && !scoreByEpisode.get(pair.full_harness_episode_id)!.strict_long_call_success).length,
      harness_only: pairs.filter((pair) => !scoreByEpisode.get(pair.raw_memory_episode_id)!.strict_long_call_success && scoreByEpisode.get(pair.full_harness_episode_id)!.strict_long_call_success).length,
      raw_only: pairs.filter((pair) => scoreByEpisode.get(pair.raw_memory_episode_id)!.strict_long_call_success && !scoreByEpisode.get(pair.full_harness_episode_id)!.strict_long_call_success).length,
    });
    const components = Object.fromEntries(COMPONENT_NAMES.map((name) => [name, Object.freeze({
      raw: aggregateComponent(raw, name),
      harness: aggregateComponent(harness, name),
    })])) as Record<LongCallComponentName, { raw: FixedDenominatorScore; harness: FixedDenominatorScore }>;
    return Object.freeze({
      provider: pairs[0].provider,
      model: pairs[0].model,
      scheduled_pairs: pairs.length,
      raw_successes: rawSuccesses,
      harness_successes: harnessSuccesses,
      raw_success_rate: rawSuccesses / pairs.length,
      harness_success_rate: harnessSuccesses / pairs.length,
      paired_risk_difference: (harnessSuccesses - rawSuccesses) / pairs.length,
      paired_counts: pairedCounts,
      exact_mcnemar_two_sided_p: exactMcNemarTwoSided(pairedCounts.harness_only, pairedCounts.raw_only),
      components: Object.freeze(components),
    });
  }).sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`));

  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-LC3-v1" as const,
    scheduled_pairs: input.scheduled_pairs.length,
    scheduled_episodes: episodes.size,
    observed_episodes: summaries.size,
    missing_observations: episodes.size - summaries.size,
    provider_effects: Object.freeze(providerEffects),
    episode_scores: Object.freeze([...scoreByEpisode.values()].sort((left, right) => left.episode_id.localeCompare(right.episode_id))),
  });
  return Object.freeze({
    ...body,
    result_sha256: sha256Hex(`${RESULT_DOMAIN}${canonicalJson(body)}`),
  });
}
