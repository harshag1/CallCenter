import { canonicalJson, sha256Hex } from "./artifacts";
import type { ScheduledEpisodeCondition, ScheduledEpisodeRecord } from "./closed-loop-episode";
import { evaluateScenarioWorld, type ToolWorldState } from "./tool-world";

const RESULT_DOMAIN = "harshas-amazing-call-center/usefulness-result/v1\n";

export type EpisodeUsefulnessObservation = Readonly<{
  schema_version: 1;
  episode_id: string;
  pair_id: string;
  provider: string;
  model: string;
  condition: ScheduledEpisodeCondition;
  transport_terminal: boolean;
  world_outcome_pass: boolean;
  false_terminal_claim: boolean;
  spoken_policy_pass: boolean;
  within_limits: boolean;
  task_completion_pass: boolean;
  model_integrity_pass: boolean;
  system_integrity_pass: boolean;
  attempted_semantic_actions: number;
  semantic_opportunities: number;
  estimated_cost_usd: number | null;
  failure_class: string | null;
}>;

export type ProviderUsefulnessEffect = Readonly<{
  provider: string;
  model: string;
  scheduled_pairs: number;
  baseline_completions: number;
  harness_completions: number;
  baseline_completion_rate: number;
  harness_completion_rate: number;
  paired_risk_difference: number;
  both_completed: number;
  neither_completed: number;
  harness_only: number;
  baseline_only: number;
  exact_mcnemar_two_sided_p: number;
  baseline_transport_terminal_rate: number;
  harness_transport_terminal_rate: number;
  baseline_actions_per_opportunity: number | null;
  harness_actions_per_opportunity: number | null;
  action_rate_ratio: number | null;
}>;

export type UsefulnessExperimentResult = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-VTR-v1";
  scheduled_episodes: number;
  observed_episodes: number;
  missing_observations: number;
  provider_effects: readonly ProviderUsefulnessEffect[];
  result_sha256: string;
}>;

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function choose(n: number, kInput: number): number {
  const k = Math.min(kInput, n - kInput);
  let result = 1;
  for (let index = 1; index <= k; index += 1) result = result * (n - k + index) / index;
  return result;
}

/** Exact two-sided conditional McNemar p-value over discordant pairs. */
export function exactMcNemarTwoSided(harnessOnly: number, baselineOnly: number): number {
  assertCount(harnessOnly, "harnessOnly");
  assertCount(baselineOnly, "baselineOnly");
  const discordant = harnessOnly + baselineOnly;
  if (discordant === 0) return 1;
  const tail = Math.min(harnessOnly, baselineOnly);
  let cumulative = 0;
  for (let k = 0; k <= tail; k += 1) cumulative += choose(discordant, k) * 0.5 ** discordant;
  return Math.min(1, 2 * cumulative);
}

export function createEpisodeUsefulnessObservation(input: Readonly<{
  scheduled: ScheduledEpisodeRecord;
  scenario: unknown;
  world: ToolWorldState;
  transport_terminal: boolean;
  false_terminal_claim: boolean;
  spoken_policy_pass: boolean;
  within_limits: boolean;
  model_integrity_pass: boolean;
  attempted_semantic_actions: number;
  semantic_opportunities: number;
  estimated_cost_usd?: number | null;
  failure_class?: string | null;
}>): EpisodeUsefulnessObservation {
  assertCount(input.attempted_semantic_actions, "attempted_semantic_actions");
  assertCount(input.semantic_opportunities, "semantic_opportunities");
  if (
    input.estimated_cost_usd !== undefined
    && input.estimated_cost_usd !== null
    && (!Number.isFinite(input.estimated_cost_usd) || input.estimated_cost_usd < 0)
  ) throw new Error("estimated_cost_usd must be finite and non-negative");
  const worldEvaluation = evaluateScenarioWorld(input.scenario, input.world);
  const worldOutcomePass = worldEvaluation.success.every((assertion) => assertion.passed);
  const systemIntegrityPass = worldEvaluation.safety.every((assertion) => assertion.passed);
  const taskCompletionPass = input.transport_terminal
    && worldOutcomePass
    && !input.false_terminal_claim
    && input.spoken_policy_pass
    && input.within_limits;
  return Object.freeze({
    schema_version: 1,
    episode_id: input.scheduled.episode_id,
    pair_id: input.scheduled.pair_id,
    provider: input.scheduled.provider,
    model: input.scheduled.model,
    condition: input.scheduled.condition,
    transport_terminal: input.transport_terminal,
    world_outcome_pass: worldOutcomePass,
    false_terminal_claim: input.false_terminal_claim,
    spoken_policy_pass: input.spoken_policy_pass,
    within_limits: input.within_limits,
    task_completion_pass: taskCompletionPass,
    model_integrity_pass: input.model_integrity_pass,
    system_integrity_pass: systemIntegrityPass,
    attempted_semantic_actions: input.attempted_semantic_actions,
    semantic_opportunities: input.semantic_opportunities,
    estimated_cost_usd: input.estimated_cost_usd ?? null,
    failure_class: input.failure_class ?? null,
  });
}

function failedMissingObservation(record: ScheduledEpisodeRecord): EpisodeUsefulnessObservation {
  return Object.freeze({
    schema_version: 1,
    episode_id: record.episode_id,
    pair_id: record.pair_id,
    provider: record.provider,
    model: record.model,
    condition: record.condition,
    transport_terminal: false,
    world_outcome_pass: false,
    false_terminal_claim: false,
    spoken_policy_pass: false,
    within_limits: false,
    task_completion_pass: false,
    model_integrity_pass: false,
    system_integrity_pass: false,
    attempted_semantic_actions: 0,
    semantic_opportunities: 0,
    estimated_cost_usd: null,
    failure_class: "missing_observation",
  });
}

function assertObservationMatchesSchedule(
  record: ScheduledEpisodeRecord,
  observation: EpisodeUsefulnessObservation,
): void {
  for (const field of ["episode_id", "pair_id", "provider", "model", "condition"] as const) {
    if (observation[field] !== record[field]) {
      throw new Error(`observation ${record.episode_id} has mismatched ${field}`);
    }
  }
  assertCount(observation.attempted_semantic_actions, `${record.episode_id}.attempted_semantic_actions`);
  assertCount(observation.semantic_opportunities, `${record.episode_id}.semantic_opportunities`);
  const derived = observation.transport_terminal
    && observation.world_outcome_pass
    && !observation.false_terminal_claim
    && observation.spoken_policy_pass
    && observation.within_limits;
  if (derived !== observation.task_completion_pass) {
    throw new Error(`observation ${record.episode_id} has a self-inconsistent task completion label`);
  }
}

function actionRate(observations: readonly EpisodeUsefulnessObservation[]): number | null {
  const opportunities = sum(observations.map((item) => item.semantic_opportunities));
  return opportunities === 0 ? null : sum(observations.map((item) => item.attempted_semantic_actions)) / opportunities;
}

export function scoreUsefulnessExperiment(input: Readonly<{
  scheduled: readonly ScheduledEpisodeRecord[];
  observations: readonly EpisodeUsefulnessObservation[];
}>): UsefulnessExperimentResult {
  if (input.scheduled.length === 0) throw new Error("at least one scheduled episode is required");
  const scheduledById = new Map<string, ScheduledEpisodeRecord>();
  for (const record of input.scheduled) {
    if (scheduledById.has(record.episode_id)) throw new Error(`duplicate scheduled episode ${record.episode_id}`);
    scheduledById.set(record.episode_id, record);
  }
  const observedById = new Map<string, EpisodeUsefulnessObservation>();
  for (const observation of input.observations) {
    const record = scheduledById.get(observation.episode_id);
    if (!record) throw new Error(`observation ${observation.episode_id} was not scheduled`);
    if (observedById.has(observation.episode_id)) throw new Error(`duplicate observation ${observation.episode_id}`);
    assertObservationMatchesSchedule(record, observation);
    observedById.set(observation.episode_id, observation);
  }
  const complete = input.scheduled.map((record) => observedById.get(record.episode_id) ?? failedMissingObservation(record));
  const byPair = new Map<string, EpisodeUsefulnessObservation[]>();
  for (const observation of complete) {
    const values = byPair.get(observation.pair_id) ?? [];
    values.push(observation);
    byPair.set(observation.pair_id, values);
  }
  const providerGroups = new Map<string, Array<readonly [EpisodeUsefulnessObservation, EpisodeUsefulnessObservation]>>();
  for (const [pairId, values] of byPair) {
    if (values.length !== 2) throw new Error(`pair ${pairId} must contain exactly two scheduled conditions`);
    const baseline = values.find((value) => value.condition === "raw-memory-v1");
    const harness = values.find((value) => value.condition === "full-harness-v1");
    if (!baseline || !harness) throw new Error(`pair ${pairId} must contain raw-memory-v1 and full-harness-v1`);
    if (baseline.provider !== harness.provider || baseline.model !== harness.model) {
      throw new Error(`pair ${pairId} crosses provider or model strata`);
    }
    const key = `${baseline.provider}\u0000${baseline.model}`;
    const pairs = providerGroups.get(key) ?? [];
    pairs.push(Object.freeze([baseline, harness]));
    providerGroups.set(key, pairs);
  }
  const providerEffects = [...providerGroups.values()].map((pairs): ProviderUsefulnessEffect => {
    const baseline = pairs.map((pair) => pair[0]);
    const harness = pairs.map((pair) => pair[1]);
    const baselineCompletions = baseline.filter((item) => item.task_completion_pass).length;
    const harnessCompletions = harness.filter((item) => item.task_completion_pass).length;
    const bothCompleted = pairs.filter(([left, right]) => left.task_completion_pass && right.task_completion_pass).length;
    const neitherCompleted = pairs.filter(([left, right]) => !left.task_completion_pass && !right.task_completion_pass).length;
    const harnessOnly = pairs.filter(([left, right]) => !left.task_completion_pass && right.task_completion_pass).length;
    const baselineOnly = pairs.filter(([left, right]) => left.task_completion_pass && !right.task_completion_pass).length;
    const baselineActionRate = actionRate(baseline);
    const harnessActionRate = actionRate(harness);
    return Object.freeze({
      provider: baseline[0].provider,
      model: baseline[0].model,
      scheduled_pairs: pairs.length,
      baseline_completions: baselineCompletions,
      harness_completions: harnessCompletions,
      baseline_completion_rate: baselineCompletions / pairs.length,
      harness_completion_rate: harnessCompletions / pairs.length,
      paired_risk_difference: (harnessCompletions - baselineCompletions) / pairs.length,
      both_completed: bothCompleted,
      neither_completed: neitherCompleted,
      harness_only: harnessOnly,
      baseline_only: baselineOnly,
      exact_mcnemar_two_sided_p: exactMcNemarTwoSided(harnessOnly, baselineOnly),
      baseline_transport_terminal_rate: baseline.filter((item) => item.transport_terminal).length / pairs.length,
      harness_transport_terminal_rate: harness.filter((item) => item.transport_terminal).length / pairs.length,
      baseline_actions_per_opportunity: baselineActionRate,
      harness_actions_per_opportunity: harnessActionRate,
      action_rate_ratio: baselineActionRate === null || baselineActionRate === 0 || harnessActionRate === null
        ? null
        : harnessActionRate / baselineActionRate,
    });
  }).sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`));
  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-VTR-v1" as const,
    scheduled_episodes: input.scheduled.length,
    observed_episodes: input.observations.length,
    missing_observations: input.scheduled.length - input.observations.length,
    provider_effects: Object.freeze(providerEffects),
  });
  return Object.freeze({
    ...body,
    result_sha256: sha256Hex(`${RESULT_DOMAIN}${canonicalJson(body)}`),
  });
}
