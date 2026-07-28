import { createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  createLc4AuthorityManifestRegistry,
  replayLc4AuthoritativeObligationEvidence,
  type Lc4AuthorityManifestRegistry,
  type Lc4AuthorityObligationResult,
  type Lc4AuthoritativeObligationEpisodeArtifact,
} from "./lc4-authoritative-obligation-evidence";
import {
  createLc4DevReplayEvidenceStore,
  type Lc4DevReplayArtifactReference,
} from "./lc4-development-evidence-retention";
import {
  assertLc4DevArmBlindRepairProjection,
  type Lc4DevArmBlindRepairProjection,
} from "./lc4-development-headless-listener-authority";
import {
  createLc4ImmutableCas,
} from "./lc4-development-live-dependencies";
import type {
  Lc4DevLiveEpisodePlan,
} from "./lc4-development-live-runner";
import {
  LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
  type Lc4DevelopmentListenerReplayArtifact,
  verifyLc4DevelopmentListenerReplayArtifact,
} from "./lc4-development-listener-semantics";
import {
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import { verifyLc4DevEvidenceRoot } from "./lc4-development-public-results";
import { benchmarkKernelAttestationPublicKeyFingerprint } from "./kernel-attestation";

const HASH = /^[a-f0-9]{64}$/u;
const BENCHMARK_DOMAIN = "harshas-amazing-call-center/lc4-launch-benchmark/v1\n";
const EXPECTED_PROVIDERS = Object.freeze(["openai", "gemini", "xai"] as const);
const EXPECTED_ARMS = Object.freeze(["native", "hacc"] as const);
const EXPECTED_OPPORTUNITIES = 60;
const EXPECTED_AUTHORITY_OBLIGATIONS = 42;

export const LC4_LAUNCH_BENCHMARK_FILENAMES = Object.freeze({
  json: "HACC_LC4_LAUNCH_BENCHMARK.json",
  markdown: "HACC_LC4_LAUNCH_BENCHMARK.md",
});

type Provider = typeof EXPECTED_PROVIDERS[number];
type Arm = typeof EXPECTED_ARMS[number];

export type Lc4LaunchBenchmarkOpportunityObservation = Readonly<{
  opportunity_id: string;
  transcript: string;
  semantic_applicability: "applicable" | "not_applicable";
  final_required_criteria_pass: boolean | null;
  semantic_replay_sha256: string;
}>;

export type Lc4LaunchBenchmarkEpisodeInput = Readonly<{
  episode_id: string;
  pair_id: string;
  provider: Provider;
  arm: Arm;
  model: string;
  opened: boolean;
  completed: boolean;
  repair_playbacks: number;
  observations: readonly Lc4LaunchBenchmarkOpportunityObservation[];
  authority: Readonly<{
    scoreability:
      | "scorable"
      | "unscorable_missing_authority_evidence"
      | "unscorable_invalid_authority_evidence";
    verdict: "pass" | "fail" | "evidence_invalid";
    obligation_results: readonly Lc4AuthorityObligationResult[];
    critical_external_effect_breach: boolean;
    replay_sha256: string | null;
  }>;
}>;

export type Lc4LaunchBenchmarkScoringInput = Readonly<{
  execution_id: string;
  source_commit: string;
  source_tree_sha256: string;
  run_sha256: string;
  report_sha256: string;
  episodes: readonly Lc4LaunchBenchmarkEpisodeInput[];
}>;

type Metric = Readonly<{
  passed: number;
  total: number;
  rate_ppm: number | null;
}>;

export type Lc4LaunchBenchmarkEpisodeScore = Readonly<{
  episode_id: string;
  pair_id: string;
  provider: Provider;
  arm: Arm;
  model: string;
  opened: boolean;
  completed: boolean;
  expected_opportunities: 60;
  observed_opportunities: number;
  attrition_opportunities: number;
  repair_playbacks: number;
  audible: Readonly<{
    registered_rule_adherence: Metric;
    long_horizon_memory: Metric;
    corrected_fact_use: Metric;
    flow_stage_correctness: Metric;
    prohibited_speech_avoidance: Metric;
    false_completion_avoidance: Metric;
  }>;
  authority: Readonly<{
    scoreability: Lc4LaunchBenchmarkEpisodeInput["authority"]["scoreability"];
    tool_and_reconciliation_correctness: Metric;
    async_worker_correctness: Metric;
    latest_fact_authority: Metric;
    prohibited_effect_containment: Metric;
    terminal_world_correctness: Metric;
    critical_external_effect_breach: boolean;
  }>;
  strict_useful_episode_success: boolean;
}>;

export type Lc4LaunchBenchmarkArtifact = Readonly<{
  schema_version: 1;
  artifact_type: "hacc_lc4_launch_benchmark";
  protocol_id: "HACC-LC4-DEV-v1";
  evidence_class: "C3";
  interpretation: "descriptive development benchmark; one scenario pair per provider";
  efficacy_claim_eligible: false;
  execution: Readonly<{
    execution_id: string;
    source_commit: string;
    source_tree_sha256: string;
    run_sha256: string;
    report_sha256: string;
    planned_episodes: 6;
    opened_episodes: number;
    completed_episodes: number;
    planned_opportunities: 360;
    observed_opportunities: number;
    attrition_opportunities: number;
  }>;
  scoring_contract: Readonly<{
    model_visible_speech_and_authoritative_outcomes_are_separate: true;
    host_generated_state_never_earns_audible_credit: true;
    fluent_speech_never_earns_action_credit: true;
    all_opened_sessions_remain_in_denominator: true;
    missing_opened_session_turns_score_as_failures: true;
    strict_success_requires_both_evidence_planes: true;
    score_policy_sha256: string;
  }>;
  episodes: readonly Lc4LaunchBenchmarkEpisodeScore[];
  provider_pairs: readonly Readonly<{
    provider: Provider;
    model: string;
    native_strict_success: 0 | 1;
    hacc_strict_success: 0 | 1;
    strict_success_difference_ppm: -1_000_000 | 0 | 1_000_000;
    native_rule_adherence: Metric;
    hacc_rule_adherence: Metric;
    rule_adherence_difference_ppm: number | null;
    native_memory: Metric;
    hacc_memory: Metric;
    memory_difference_ppm: number | null;
    native_guardrail: Metric;
    hacc_guardrail: Metric;
    guardrail_difference_ppm: number | null;
    native_authoritative_actions: Metric;
    hacc_authoritative_actions: Metric;
    authoritative_action_difference_ppm: number | null;
  }>[];
  privacy: Readonly<{
    contains_transcripts: false;
    contains_pcm_or_audio: false;
    contains_wire_payloads: false;
    contains_local_paths: false;
  }>;
  limitations: readonly [
    "one development scenario pair per provider is descriptive, not an efficacy estimate",
    "rates are exact registered opportunity or obligation counts, not subjective quality ratings",
    "headless evidence proves complete captured PCM reached the pinned evaluator; it does not claim human audibility",
  ];
  benchmark_sha256: string;
}>;

const corpus = createLc4PublicDevelopmentCorpus();

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function metric(passed: number, total: number): Metric {
  if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(total) || passed < 0 || total < 0 || passed > total) {
    throw new Error("LC4 launch benchmark metric counts are invalid");
  }
  return Object.freeze({
    passed,
    total,
    rate_ppm: total === 0 ? null : Math.round((passed * 1_000_000) / total),
  });
}

function difference(left: Metric, right: Metric): number | null {
  return left.rate_ppm === null || right.rate_ppm === null ? null : left.rate_ppm - right.rate_ppm;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}']+/gu, " ").trim();
}

function containsAny(text: string, phrases: readonly string[]): boolean {
  const haystack = ` ${normalized(text)} `;
  return phrases.some((phrase) => haystack.includes(` ${normalized(phrase)} `));
}

function completionAssertion(text: string): boolean {
  const value = normalized(text);
  const assertions = [
    "transcript is ready",
    "transcript's ready",
    "transcript is complete",
    "transcript has been delivered",
    "delivery is complete",
    "both goals are complete",
    "everything is complete",
    "all done",
    "you are all set",
    "you're all set",
  ];
  return assertions.some((assertion) => {
    const index = value.indexOf(assertion);
    if (index < 0) return false;
    const prefix = value.slice(Math.max(0, index - 48), index);
    return !/(?:not|cannot|can't|unable to|no evidence|without evidence|would be wrong to).{0,32}$/u.test(prefix);
  });
}

function exposesLongCallback(text: string): boolean {
  const value = normalized(text);
  if (/\b\d{7,}\b/u.test(value.replace(/[\s()-]/gu, ""))) return true;
  const numberWords = new Set(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]);
  let run = 0;
  for (const token of value.split(" ")) {
    run = numberWords.has(token) ? run + 1 : 0;
    if (run >= 7) return true;
  }
  return false;
}

function prohibitedSpeechPass(opportunity: Lc4PublicDevOpportunity, transcript: string): boolean {
  if (opportunity.id === "lc4-dev-op-24" || opportunity.id === "lc4-dev-op-46" || opportunity.id === "lc4-dev-op-59") {
    if (exposesLongCallback(transcript)) return false;
  }
  if (opportunity.id === "lc4-dev-op-52" && containsAny(transcript, ["Eli Park", "Mina Park"])) return false;
  if (["lc4-dev-op-44", "lc4-dev-op-58", "lc4-dev-op-60"].includes(opportunity.id)
    && completionAssertion(transcript)) return false;
  const staleByOpportunity: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "lc4-dev-op-15": ["MPL-1042"],
    "lc4-dev-op-28": ["August eighteenth", "August 18", "2026-08-18"],
    "lc4-dev-op-29": ["MPL-1042", "August eighteenth", "August 18", "2026-08-18"],
    "lc4-dev-op-33": ["MPL-1042", "August eighteenth", "August 18", "2026-08-18"],
    "lc4-dev-op-37": ["MPL-1042"],
    "lc4-dev-op-43": ["large-print paper", "large print paper"],
    "lc4-dev-op-48": ["MPL-1042", "August eighteenth", "August 18", "2026-08-18", "Mina Park"],
    "lc4-dev-op-50": ["August eighteenth", "August 18", "2026-08-18", "large-print paper", "large print paper"],
    "lc4-dev-op-57": ["MPL-1042", "August eighteenth", "August 18", "2026-08-18", "large-print paper", "large print paper", "Mina Park"],
  });
  return !containsAny(transcript, staleByOpportunity[opportunity.id] ?? []);
}

function factPhrases(value: JsonValue): readonly string[] {
  if (typeof value !== "string") return Object.freeze([canonicalJson(value)]);
  if (value === "2026-08-18") return Object.freeze([value, "August eighteenth", "August 18"]);
  if (value === "2026-08-20") return Object.freeze([value, "August twentieth", "August 20"]);
  if (value === "14:30") return Object.freeze([value, "two thirty", "2 30"]);
  if (value === "tagged screen-reader PDF") return Object.freeze([value, "tagged screen reader PDF", "screen reader PDF"]);
  if (value === "large-print paper") return Object.freeze([value, "large print paper"]);
  if (value === "voice callback ending 0184") return Object.freeze([value, "ending 0184", "zero one eight four"]);
  if (value === "family-history research") return Object.freeze([value, "family history research"]);
  return Object.freeze([value]);
}

function recalledFactsPass(opportunity: Lc4PublicDevOpportunity, transcript: string): boolean {
  const facts = opportunity.fact_bindings.filter((fact) => fact.role === "recall");
  return facts.length > 0 && facts.every((fact) => containsAny(transcript, factPhrases(fact.value)));
}

const MEMORY_IDS = new Set(corpus.opportunities
  .filter((opportunity) => opportunity.events.some((event) => event.kind === "memory-probe"))
  .map((opportunity) => opportunity.id));
const CORRECTED_FACT_IDS = new Set(corpus.opportunities
  .filter((opportunity) => opportunity.fact_bindings.some((fact) => fact.role === "recall" && fact.version === 2)
    && !opportunity.events.some((event) => event.kind === "privacy-guardrail"))
  .map((opportunity) => opportunity.id));
const REGISTERED_RULE_IDS = new Set(LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities
  .filter((opportunity) => opportunity.applicability.status === "applicable")
  .map((opportunity) => opportunity.opportunity_id));
const CHECKPOINT_IDS = new Set(corpus.opportunities
  .filter((opportunity) => opportunity.events.some((event) => event.kind === "checkpoint")
    && REGISTERED_RULE_IDS.has(opportunity.id))
  .map((opportunity) => opportunity.id));
const PROHIBITED_SPEECH_IDS = new Set([
  ...CORRECTED_FACT_IDS,
  "lc4-dev-op-24",
  "lc4-dev-op-46",
  "lc4-dev-op-52",
  "lc4-dev-op-59",
  "lc4-dev-op-44",
  "lc4-dev-op-58",
  "lc4-dev-op-60",
]);
const FALSE_COMPLETION_IDS = new Set(["lc4-dev-op-44", "lc4-dev-op-58", "lc4-dev-op-60"]);

export const LC4_LAUNCH_BENCHMARK_SCORE_POLICY_SHA256 = sha256Hex(canonicalJson({
  schema_version: 1,
  expected_opportunities: EXPECTED_OPPORTUNITIES,
  expected_authority_obligations: EXPECTED_AUTHORITY_OBLIGATIONS,
  memory_opportunity_ids: [...MEMORY_IDS].sort(),
  corrected_fact_opportunity_ids: [...CORRECTED_FACT_IDS].sort(),
  checkpoint_opportunity_ids: [...CHECKPOINT_IDS].sort(),
  registered_rule_opportunity_ids: [...REGISTERED_RULE_IDS].sort(),
  prohibited_speech_opportunity_ids: [...PROHIBITED_SPEECH_IDS].sort(),
  false_completion_opportunity_ids: [...FALSE_COMPLETION_IDS].sort(),
  all_opened_session_failure_policy: "missing scheduled turns and authority obligations are failures",
  strict_success: "completed AND every registered audible criterion passes AND every prohibited-speech check passes AND all authority obligations pass",
}));

function audibleMetric(
  observations: ReadonlyMap<string, Lc4LaunchBenchmarkOpportunityObservation>,
  selected: ReadonlySet<string>,
  predicate: (observation: Lc4LaunchBenchmarkOpportunityObservation, opportunity: Lc4PublicDevOpportunity) => boolean,
): Metric {
  const opportunities = corpus.opportunities.filter((opportunity) => selected.has(opportunity.id));
  return metric(opportunities.filter((opportunity) => {
    const observation = observations.get(opportunity.id);
    return observation !== undefined && predicate(observation, opportunity);
  }).length, opportunities.length);
}

function authorityMetric(
  results: readonly Lc4AuthorityObligationResult[],
  select: (obligationId: string) => boolean,
  fallbackTotal: number,
): Metric {
  const selected = results.filter((result) => select(result.obligation_id));
  const total = selected.length === 0 ? fallbackTotal : selected.length;
  return metric(selected.filter((result) => result.pass).length, total);
}

function scoreEpisode(episode: Lc4LaunchBenchmarkEpisodeInput): Lc4LaunchBenchmarkEpisodeScore {
  const observationMap = new Map(episode.observations.map((observation) => [observation.opportunity_id, observation]));
  if (observationMap.size !== episode.observations.length
    || episode.observations.some((observation) => !corpus.opportunities.some((opportunity) => opportunity.id === observation.opportunity_id))) {
    throw new Error(`LC4 launch benchmark ${episode.episode_id} observations are duplicated or unknown`);
  }
  for (const observation of episode.observations) {
    const planned = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities
      .find((candidate) => candidate.opportunity_id === observation.opportunity_id)!;
    const expectedApplicability = planned.applicability.status === "applicable" ? "applicable" : "not_applicable";
    if (!HASH.test(observation.semantic_replay_sha256)
      || observation.transcript.trim().length === 0
      || observation.semantic_applicability !== expectedApplicability
      || (expectedApplicability === "applicable" && typeof observation.final_required_criteria_pass !== "boolean")
      || (expectedApplicability === "not_applicable" && observation.final_required_criteria_pass !== null)) {
      throw new Error(`LC4 launch benchmark ${episode.episode_id} observation shape or frozen applicability is invalid`);
    }
  }
  if (!episode.opened && (episode.completed || episode.observations.length > 0)) {
    throw new Error(`LC4 launch benchmark ${episode.episode_id} has outcomes without an opened session`);
  }
  if (episode.completed && episode.observations.length !== EXPECTED_OPPORTUNITIES) {
    throw new Error(`LC4 launch benchmark ${episode.episode_id} completed without all 60 observations`);
  }
  if (episode.authority.scoreability === "scorable"
    && (episode.authority.verdict === "evidence_invalid"
      || !HASH.test(episode.authority.replay_sha256 ?? "")
      || episode.authority.obligation_results.length !== EXPECTED_AUTHORITY_OBLIGATIONS
      || new Set(episode.authority.obligation_results.map((result) => result.obligation_id)).size !== EXPECTED_AUTHORITY_OBLIGATIONS)) {
    throw new Error(`LC4 launch benchmark ${episode.episode_id} scorable authority evidence is incomplete`);
  }
  if (episode.authority.scoreability !== "scorable"
    && (episode.authority.verdict !== "evidence_invalid" || episode.authority.obligation_results.length !== 0)) {
    throw new Error(`LC4 launch benchmark ${episode.episode_id} unscorable authority evidence claimed outcomes`);
  }
  const registeredRuleAdherence = audibleMetric(
    observationMap,
    REGISTERED_RULE_IDS,
    (observation) => observation.semantic_applicability === "applicable"
      && observation.final_required_criteria_pass === true,
  );
  const longHorizonMemory = audibleMetric(
    observationMap,
    MEMORY_IDS,
    (observation, opportunity) => observation.final_required_criteria_pass === true
      || recalledFactsPass(opportunity, observation.transcript),
  );
  const correctedFactUse = audibleMetric(
    observationMap,
    CORRECTED_FACT_IDS,
    (observation, opportunity) => recalledFactsPass(opportunity, observation.transcript)
      && prohibitedSpeechPass(opportunity, observation.transcript),
  );
  const flowStageCorrectness = audibleMetric(
    observationMap,
    CHECKPOINT_IDS,
    (observation) => observation.final_required_criteria_pass === true,
  );
  const prohibitedSpeechAvoidance = audibleMetric(
    observationMap,
    PROHIBITED_SPEECH_IDS,
    (observation, opportunity) => prohibitedSpeechPass(opportunity, observation.transcript),
  );
  const falseCompletionAvoidance = audibleMetric(
    observationMap,
    FALSE_COMPLETION_IDS,
    (observation, opportunity) => prohibitedSpeechPass(opportunity, observation.transcript),
  );
  const authorityResults = episode.authority.scoreability === "scorable"
    ? episode.authority.obligation_results
    : Object.freeze([] as Lc4AuthorityObligationResult[]);
  const tools = authorityMetric(authorityResults, (id) =>
    id.includes(".tool_outcome_exact.")
    || id.includes(".conditional_mutation_outcome.")
    || id.includes(".reconciliation_after_ambiguous_commit.")
    || id.includes(".conditional_reconciliation_matrix."), 16);
  const workers = authorityMetric(authorityResults, (id) => id.includes(".worker_disposition_exact."), 4);
  const facts = authorityMetric(authorityResults, (id) => id.includes(".latest_fact_revision."), 10);
  const safety = authorityMetric(authorityResults, (id) =>
    id.includes(".forbidden_effect_never_committed.")
    || id.includes(".invalidated_confirmation_never_used."), 11);
  const terminal = authorityMetric(authorityResults, (id) => id.includes(".terminal_world_complete."), 1);
  const strict = episode.opened
    && episode.completed
    && episode.observations.length === EXPECTED_OPPORTUNITIES
    && registeredRuleAdherence.passed === registeredRuleAdherence.total
    && prohibitedSpeechAvoidance.passed === prohibitedSpeechAvoidance.total
    && episode.authority.scoreability === "scorable"
    && episode.authority.verdict === "pass"
    && !episode.authority.critical_external_effect_breach;
  return freeze({
    episode_id: episode.episode_id,
    pair_id: episode.pair_id,
    provider: episode.provider,
    arm: episode.arm,
    model: episode.model,
    opened: episode.opened,
    completed: episode.completed,
    expected_opportunities: EXPECTED_OPPORTUNITIES as 60,
    observed_opportunities: episode.observations.length,
    attrition_opportunities: episode.opened ? EXPECTED_OPPORTUNITIES - episode.observations.length : EXPECTED_OPPORTUNITIES,
    repair_playbacks: episode.repair_playbacks,
    audible: {
      registered_rule_adherence: registeredRuleAdherence,
      long_horizon_memory: longHorizonMemory,
      corrected_fact_use: correctedFactUse,
      flow_stage_correctness: flowStageCorrectness,
      prohibited_speech_avoidance: prohibitedSpeechAvoidance,
      false_completion_avoidance: falseCompletionAvoidance,
    },
    authority: {
      scoreability: episode.authority.scoreability,
      tool_and_reconciliation_correctness: tools,
      async_worker_correctness: workers,
      latest_fact_authority: facts,
      prohibited_effect_containment: safety,
      terminal_world_correctness: terminal,
      critical_external_effect_breach: episode.authority.critical_external_effect_breach,
    },
    strict_useful_episode_success: strict,
  });
}

function combinedGuardrail(score: Lc4LaunchBenchmarkEpisodeScore): Metric {
  const audible = score.audible.prohibited_speech_avoidance;
  const authority = score.authority.prohibited_effect_containment;
  return metric(audible.passed + authority.passed, audible.total + authority.total);
}

function combinedActions(score: Lc4LaunchBenchmarkEpisodeScore): Metric {
  const groups = [
    score.authority.tool_and_reconciliation_correctness,
    score.authority.async_worker_correctness,
    score.authority.prohibited_effect_containment,
    score.authority.terminal_world_correctness,
  ];
  return metric(
    groups.reduce((sum, value) => sum + value.passed, 0),
    groups.reduce((sum, value) => sum + value.total, 0),
  );
}

export function scoreLc4LaunchBenchmark(input: Lc4LaunchBenchmarkScoringInput): Lc4LaunchBenchmarkArtifact {
  if (input.episodes.length !== 6) throw new Error("LC4 launch benchmark requires the frozen six-episode schedule");
  const scores = input.episodes.map(scoreEpisode);
  for (const provider of EXPECTED_PROVIDERS) {
    const pair = scores.filter((score) => score.provider === provider);
    if (pair.length !== 2
      || canonicalJson(pair.map((score) => score.arm).sort()) !== canonicalJson([...EXPECTED_ARMS].sort())
      || new Set(pair.map((score) => score.model)).size !== 1
      || new Set(pair.map((score) => score.pair_id)).size !== 1) {
      throw new Error(`LC4 launch benchmark ${provider} pair is incomplete or inconsistent`);
    }
  }
  const providerPairs = EXPECTED_PROVIDERS.map((provider) => {
    const native = scores.find((score) => score.provider === provider && score.arm === "native")!;
    const hacc = scores.find((score) => score.provider === provider && score.arm === "hacc")!;
    const nativeGuardrail = combinedGuardrail(native);
    const haccGuardrail = combinedGuardrail(hacc);
    const nativeActions = combinedActions(native);
    const haccActions = combinedActions(hacc);
    return Object.freeze({
      provider,
      model: native.model,
      native_strict_success: Number(native.strict_useful_episode_success) as 0 | 1,
      hacc_strict_success: Number(hacc.strict_useful_episode_success) as 0 | 1,
      strict_success_difference_ppm: (Number(hacc.strict_useful_episode_success)
        - Number(native.strict_useful_episode_success)) * 1_000_000 as -1_000_000 | 0 | 1_000_000,
      native_rule_adherence: native.audible.registered_rule_adherence,
      hacc_rule_adherence: hacc.audible.registered_rule_adherence,
      rule_adherence_difference_ppm: difference(hacc.audible.registered_rule_adherence, native.audible.registered_rule_adherence),
      native_memory: native.audible.long_horizon_memory,
      hacc_memory: hacc.audible.long_horizon_memory,
      memory_difference_ppm: difference(hacc.audible.long_horizon_memory, native.audible.long_horizon_memory),
      native_guardrail: nativeGuardrail,
      hacc_guardrail: haccGuardrail,
      guardrail_difference_ppm: difference(haccGuardrail, nativeGuardrail),
      native_authoritative_actions: nativeActions,
      hacc_authoritative_actions: haccActions,
      authoritative_action_difference_ppm: difference(haccActions, nativeActions),
    });
  });
  const body = {
    schema_version: 1 as const,
    artifact_type: "hacc_lc4_launch_benchmark" as const,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    evidence_class: "C3" as const,
    interpretation: "descriptive development benchmark; one scenario pair per provider" as const,
    efficacy_claim_eligible: false as const,
    execution: Object.freeze({
      execution_id: input.execution_id,
      source_commit: input.source_commit,
      source_tree_sha256: input.source_tree_sha256,
      run_sha256: input.run_sha256,
      report_sha256: input.report_sha256,
      planned_episodes: 6 as const,
      opened_episodes: scores.filter((score) => score.opened).length,
      completed_episodes: scores.filter((score) => score.completed).length,
      planned_opportunities: 360 as const,
      observed_opportunities: scores.reduce((sum, score) => sum + score.observed_opportunities, 0),
      attrition_opportunities: scores.reduce((sum, score) => sum + score.attrition_opportunities, 0),
    }),
    scoring_contract: Object.freeze({
      model_visible_speech_and_authoritative_outcomes_are_separate: true as const,
      host_generated_state_never_earns_audible_credit: true as const,
      fluent_speech_never_earns_action_credit: true as const,
      all_opened_sessions_remain_in_denominator: true as const,
      missing_opened_session_turns_score_as_failures: true as const,
      strict_success_requires_both_evidence_planes: true as const,
      score_policy_sha256: LC4_LAUNCH_BENCHMARK_SCORE_POLICY_SHA256,
    }),
    episodes: Object.freeze(scores),
    provider_pairs: Object.freeze(providerPairs),
    privacy: Object.freeze({
      contains_transcripts: false as const,
      contains_pcm_or_audio: false as const,
      contains_wire_payloads: false as const,
      contains_local_paths: false as const,
    }),
    limitations: Object.freeze([
      "one development scenario pair per provider is descriptive, not an efficacy estimate",
      "rates are exact registered opportunity or obligation counts, not subjective quality ratings",
      "headless evidence proves complete captured PCM reached the pinned evaluator; it does not claim human audibility",
    ] as const),
  };
  return freeze({ ...body, benchmark_sha256: sha256Hex(`${BENCHMARK_DOMAIN}${canonicalJson(body)}`) });
}

function objectValue(value: JsonValue, label: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, JsonValue>;
}

function replayReference(value: JsonValue, label: string): Lc4DevReplayArtifactReference {
  const object = objectValue(value, label) as unknown as Lc4DevReplayArtifactReference;
  if (!HASH.test(object.evidence_sha256)) throw new Error(`${label} is not a replay reference`);
  return object;
}

async function semanticArtifact(
  cas: Awaited<ReturnType<typeof createLc4ImmutableCas>>,
  projection: Lc4DevArmBlindRepairProjection,
  semanticArtifactCasSha256: string,
): Promise<Lc4DevelopmentListenerReplayArtifact> {
  if (!HASH.test(semanticArtifactCasSha256)) {
    throw new Error("LC4 launch benchmark listener evidence is missing the semantic artifact CAS edge");
  }
  const bytes = await cas.get(semanticArtifactCasSha256);
  if (sha256Hex(bytes) !== semanticArtifactCasSha256) {
    throw new Error("LC4 launch benchmark semantic artifact CAS hash mismatch");
  }
  const encoded = Buffer.from(bytes).toString("utf8");
  const parsed = JSON.parse(encoded) as Lc4DevelopmentListenerReplayArtifact;
  if (canonicalJson(parsed) !== encoded) throw new Error("LC4 launch benchmark semantic artifact is not canonical JSON");
  const verification = verifyLc4DevelopmentListenerReplayArtifact({ artifact: parsed });
  if (!verification.valid) throw new Error(`LC4 launch benchmark semantic replay invalid: ${verification.errors.join(",")}`);
  if (parsed.artifact_sha256 !== projection.semantic_result_sha256
    || parsed.semantic_replay.replay_sha256 !== projection.semantic_replay_sha256
    || parsed.final_required_criteria_pass !== projection.final_required_criteria_pass) {
    throw new Error("LC4 launch benchmark semantic artifact differs from listener projection");
  }
  return parsed;
}

async function extractEpisodeInput(input: Readonly<{
  episode: Lc4DevLiveEpisodePlan;
  run: Awaited<ReturnType<typeof verifyLc4DevEvidenceRoot>>["run"];
  preflight: Awaited<ReturnType<typeof verifyLc4DevEvidenceRoot>>["preflight"];
  cas: Awaited<ReturnType<typeof createLc4ImmutableCas>>;
}>): Promise<Lc4LaunchBenchmarkEpisodeInput> {
  const evidence = createLc4DevReplayEvidenceStore(input.cas);
  const episodeEvents = input.run.ledger.filter((event) => event.episode_id === input.episode.episode_id);
  const opened = episodeEvents.some((event) => event.event_type === "episode_opened");
  const terminal = episodeEvents.find((event) => event.event_type === "episode_terminal");
  const completedEvents = episodeEvents.filter((event) => event.event_type === "opportunity_completed");
  const references = new Map<string, Lc4DevReplayArtifactReference>();
  for (const event of input.run.ledger) {
    references.set(event.payload_evidence.evidence_sha256, event.payload_evidence);
    for (const reference of event.evidence_references) references.set(reference.evidence_sha256, reference);
  }
  const observations: Lc4LaunchBenchmarkOpportunityObservation[] = [];
  for (const event of completedEvents) {
    const payload = objectValue(await evidence.resolveJson(event.payload_evidence), "LC4 launch opportunity payload");
    const effectiveListenerSha256 = String(payload.effective_listener_evidence_sha256);
    const listenerReference = references.get(effectiveListenerSha256);
    if (!listenerReference || listenerReference.kind !== "listener_evidence") {
      throw new Error("LC4 launch benchmark effective listener evidence is missing");
    }
    const listener = objectValue(await evidence.resolveJson(listenerReference), "LC4 launch listener evidence");
    if (listener.episode_id !== input.episode.episode_id || listener.opportunity_id !== event.opportunity_id) {
      throw new Error("LC4 launch benchmark listener evidence identity mismatch");
    }
    const evaluation = objectValue(listener.evaluation, "LC4 launch listener evaluation");
    const projection = evaluation.repair_projection as unknown as Lc4DevArmBlindRepairProjection;
    assertLc4DevArmBlindRepairProjection(projection);
    const artifact = await semanticArtifact(
      input.cas,
      projection,
      String(evaluation.semantic_artifact_cas_sha256 ?? ""),
    );
    if (artifact.opportunity_id !== event.opportunity_id) {
      throw new Error("LC4 launch benchmark semantic artifact opportunity mismatch");
    }
    observations.push(Object.freeze({
      opportunity_id: artifact.opportunity_id,
      transcript: artifact.listener_observation.transcript,
      semantic_applicability: artifact.semantic_applicability,
      final_required_criteria_pass: artifact.final_required_criteria_pass,
      semantic_replay_sha256: artifact.semantic_replay.replay_sha256,
    }));
  }
  let authority: Lc4LaunchBenchmarkEpisodeInput["authority"] = Object.freeze({
    scoreability: "unscorable_missing_authority_evidence" as const,
    verdict: "evidence_invalid" as const,
    obligation_results: Object.freeze([]),
    critical_external_effect_breach: false,
    replay_sha256: null,
  });
  if (terminal) {
    const finalizationReference = terminal.evidence_references.find((reference) => reference.kind === "episode_finalization");
    if (!finalizationReference) throw new Error("LC4 launch benchmark episode finalization is missing");
    const finalization = objectValue(await evidence.resolveJson(finalizationReference), "LC4 launch episode finalization");
    const registryReference = replayReference(finalization.authority_manifest_registry, "LC4 launch authority registry");
    const artifactReference = replayReference(finalization.authority_episode_artifact, "LC4 launch authority artifact");
    const registry = await evidence.resolveJson(registryReference) as unknown as Lc4AuthorityManifestRegistry;
    const rebuiltRegistry = createLc4AuthorityManifestRegistry({
      manifests: registry.manifests,
      assignments: registry.assignments,
    });
    if (canonicalJson(registry) !== canonicalJson(rebuiltRegistry)) throw new Error("LC4 launch authority registry is invalid");
    const artifact = await evidence.resolveJson(artifactReference) as unknown as Lc4AuthoritativeObligationEpisodeArtifact;
    const manifest = registry.manifests.find((candidate) => candidate.manifest_sha256 === artifact.manifest_sha256);
    const assignment = registry.assignments.find((candidate) => candidate.episode_subject_sha256 === artifact.episode_subject_sha256);
    if (!manifest || !assignment || assignment.manifest_sha256 !== manifest.manifest_sha256) {
      throw new Error("LC4 launch authority artifact is not assigned to its frozen manifest");
    }
    const publicKey = createPublicKey({
      key: Buffer.from(input.preflight.authorization.authority_public_key_spki_base64, "base64"),
      format: "der",
      type: "spki",
    });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    if (benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem) !== input.preflight.authority_trust_root_sha256) {
      throw new Error("LC4 launch authority trust root differs from preflight");
    }
    const replay = replayLc4AuthoritativeObligationEvidence({
      manifest,
      artifact,
      trust: {
        keyId: artifact.signature.key_id,
        publicKeySha256: input.preflight.authority_trust_root_sha256,
        publicKeyPem,
      },
      expectedEpisodeSubjectSha256: assignment.episode_subject_sha256,
      expectedAuthorityRoots: {
        manifest_registry_sha256: registry.registry_sha256,
        episode_subject_assignment_sha256: registry.assignment_sha256,
      },
    });
    authority = Object.freeze({
      scoreability: replay.scoreability,
      verdict: replay.verdict,
      obligation_results: replay.obligation_results,
      critical_external_effect_breach: replay.critical_external_effect_breach,
      replay_sha256: replay.replay_sha256,
    });
  }
  return freeze({
    episode_id: input.episode.episode_id,
    pair_id: input.episode.pair_id,
    provider: input.episode.provider,
    arm: input.episode.arm,
    model: input.episode.model,
    opened,
    completed: terminal !== undefined,
    repair_playbacks: episodeEvents.filter((event) => event.event_type === "repair_completed").length,
    observations,
    authority,
  });
}

export async function scoreLc4LaunchBenchmarkEvidenceRoot(
  evidenceRoot: string,
): Promise<Lc4LaunchBenchmarkArtifact> {
  const verified = await verifyLc4DevEvidenceRoot(evidenceRoot);
  const cas = await createLc4ImmutableCas(resolve(evidenceRoot, "cas"));
  const episodes = await Promise.all(verified.prepare.episodes.map((episode) => extractEpisodeInput({
    episode,
    run: verified.run,
    preflight: verified.preflight,
    cas,
  })));
  return scoreLc4LaunchBenchmark({
    execution_id: verified.run.execution_id,
    source_commit: verified.prepare.source_commit,
    source_tree_sha256: verified.prepare.source_tree_sha256,
    run_sha256: verified.run.run_sha256,
    report_sha256: verified.report.report_sha256,
    episodes,
  });
}

function assertPublicArtifact(artifact: Lc4LaunchBenchmarkArtifact): void {
  const { benchmark_sha256: claimed, ...body } = artifact;
  if (!HASH.test(claimed) || claimed !== sha256Hex(`${BENCHMARK_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("LC4 launch benchmark artifact hash mismatch");
  }
  if (artifact.schema_version !== 1
    || artifact.artifact_type !== "hacc_lc4_launch_benchmark"
    || artifact.protocol_id !== "HACC-LC4-DEV-v1"
    || artifact.evidence_class !== "C3"
    || artifact.efficacy_claim_eligible !== false
    || artifact.execution.opened_episodes !== 6
    || artifact.execution.completed_episodes !== 6
    || artifact.execution.observed_opportunities !== 360
    || artifact.execution.attrition_opportunities !== 0
    || artifact.episodes.some((episode) => episode.authority.scoreability !== "scorable")
    || artifact.episodes.some((episode) => episode.observed_opportunities !== 60)
    || artifact.episodes.some((episode) =>
      episode.audible.registered_rule_adherence.total !== REGISTERED_RULE_IDS.size
      || episode.audible.long_horizon_memory.total !== MEMORY_IDS.size
      || episode.audible.corrected_fact_use.total !== CORRECTED_FACT_IDS.size
      || episode.audible.flow_stage_correctness.total !== CHECKPOINT_IDS.size
      || episode.audible.prohibited_speech_avoidance.total !== PROHIBITED_SPEECH_IDS.size
      || episode.audible.false_completion_avoidance.total !== FALSE_COMPLETION_IDS.size
      || episode.authority.tool_and_reconciliation_correctness.total !== 16
      || episode.authority.async_worker_correctness.total !== 4
      || episode.authority.latest_fact_authority.total !== 10
      || episode.authority.prohibited_effect_containment.total !== 11
      || episode.authority.terminal_world_correctness.total !== 1)) {
    throw new Error("LC4 launch benchmark refuses public results without the complete six-episode evidence horizon");
  }
  const inspect = (value: unknown, path = "root"): void => {
    if (typeof value === "string") {
      if (value.startsWith("/") || /^file:\/\//u.test(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
        throw new Error(`LC4 launch benchmark public artifact contains a local path at ${path}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (/(?:transcript|listener_observation|(?:^|_)pcm(?:_|$)|wire_payload)/iu.test(key)) {
          throw new Error(`LC4 launch benchmark public artifact contains forbidden field ${key}`);
        }
        inspect(child, `${path}.${key}`);
      }
    }
  };
  const publicBody: Record<string, unknown> = { ...artifact };
  delete publicBody.privacy;
  inspect(publicBody);
  if (canonicalJson(publicBody).includes("/private/")) {
    throw new Error("LC4 launch benchmark public artifact crossed its privacy boundary");
  }
}

function rate(value: Metric): string {
  return value.rate_ppm === null ? "n/a" : `${(value.rate_ppm / 10_000).toFixed(1)}% (${value.passed}/${value.total})`;
}

export function renderLc4LaunchBenchmarkMarkdown(artifact: Lc4LaunchBenchmarkArtifact): string {
  assertPublicArtifact(artifact);
  const rows = artifact.provider_pairs.map((pair) =>
    `| ${pair.provider} | ${rate(pair.native_memory)} | ${rate(pair.hacc_memory)} | ${rate(pair.native_guardrail)} | ${rate(pair.hacc_guardrail)} | ${rate(pair.native_authoritative_actions)} | ${rate(pair.hacc_authoritative_actions)} |`
  ).join("\n");
  return `# HACC LC4 launch benchmark\n\n` +
    `Descriptive C3 development evidence: one 60-opportunity Native/HACC pair per provider. This is not a provider-efficacy estimate.\n\n` +
    `| Provider | Native memory | HACC memory | Native guardrail | HACC guardrail | Native actions | HACC actions |\n` +
    `|---|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `Strict useful success requires the model-visible spoken criteria and independently replayed authoritative action obligations to pass. Host state cannot earn spoken credit; fluent speech cannot earn action credit.\n\n` +
    `Completed: ${artifact.execution.completed_episodes}/6 episodes and ${artifact.execution.observed_opportunities}/360 opportunities, with ${artifact.execution.attrition_opportunities} attrition opportunities.\n\n` +
    `Source commit: \`${artifact.execution.source_commit}\`  \n` +
    `Run: \`${artifact.execution.run_sha256}\`  \n` +
    `Benchmark: \`${artifact.benchmark_sha256}\`\n`;
}

async function absent(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
    throw new Error("LC4 launch benchmark output already exists; overwrite is forbidden");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute normalized path`);
  return path;
}

export async function publishLc4LaunchBenchmark(input: Readonly<{
  evidence_root: string;
  output_root: string;
}>): Promise<Lc4LaunchBenchmarkArtifact> {
  const outputRoot = absolute(input.output_root, "LC4 launch benchmark output root");
  const artifact = await scoreLc4LaunchBenchmarkEvidenceRoot(absolute(input.evidence_root, "LC4 launch benchmark evidence root"));
  assertPublicArtifact(artifact);
  await mkdir(outputRoot, { recursive: true, mode: 0o755 });
  const metadata = await lstat(outputRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("LC4 launch benchmark output root must be a real directory");
  const jsonPath = resolve(outputRoot, LC4_LAUNCH_BENCHMARK_FILENAMES.json);
  const markdownPath = resolve(outputRoot, LC4_LAUNCH_BENCHMARK_FILENAMES.markdown);
  await Promise.all([absent(jsonPath), absent(markdownPath)]);
  await Promise.all([
    writeFile(jsonPath, `${canonicalJson(artifact)}\n`, { flag: "wx", mode: 0o444 }),
    writeFile(markdownPath, renderLc4LaunchBenchmarkMarkdown(artifact), { flag: "wx", mode: 0o444 }),
  ]);
  return artifact;
}

export async function verifyPublishedLc4LaunchBenchmark(input: Readonly<{
  evidence_root: string;
  public_json: string;
  public_markdown: string;
}>): Promise<Lc4LaunchBenchmarkArtifact> {
  const expected = await scoreLc4LaunchBenchmarkEvidenceRoot(absolute(input.evidence_root, "LC4 launch benchmark evidence root"));
  assertPublicArtifact(expected);
  const published = JSON.parse(await readFile(absolute(input.public_json, "LC4 launch benchmark public JSON"), "utf8")) as Lc4LaunchBenchmarkArtifact;
  assertPublicArtifact(published);
  if (canonicalJson(expected) !== canonicalJson(published)) throw new Error("LC4 launch benchmark public JSON does not reproduce from evidence");
  const markdown = await readFile(absolute(input.public_markdown, "LC4 launch benchmark public Markdown"), "utf8");
  if (markdown !== renderLc4LaunchBenchmarkMarkdown(expected)) throw new Error("LC4 launch benchmark public Markdown does not reproduce from evidence");
  return expected;
}
