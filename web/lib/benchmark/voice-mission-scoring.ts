import type { VoiceMissionEvent, VoiceMissionOpportunityCategory, VoiceMissionScenario } from "./voice-mission-schema";
import { replayVoiceMission, type VoiceMissionReplay, type VoiceMissionViolationKind } from "./voice-mission-world";

export type VoiceMissionCategoryScore = Readonly<{
  total: number;
  passed: number;
  failed: number;
  rate: number;
}>;

export type VoiceMissionStrictCriterion =
  | "all_semantic_opportunities_satisfied"
  | "latest_facts_preserved"
  | "async_results_generation_safe"
  | "all_required_goals_completed"
  | "goal_focus_intact"
  | "confirmations_bound"
  | "guardrails_contained_actions"
  | "terminal_claims_truthful"
  | "cross_session_resume_intact";

export type VoiceMissionScore = Readonly<{
  protocol: "HACC-VMR-v1";
  scenario_id: string;
  strict_pass: boolean;
  criteria: Readonly<Record<VoiceMissionStrictCriterion, boolean>>;
  opportunities: Readonly<{
    total: number;
    passed: number;
    failed: number;
    rate: number;
    reliable_horizon: number;
    first_failure_index: number | null;
  }>;
  categories: Readonly<Record<VoiceMissionOpportunityCategory, VoiceMissionCategoryScore>>;
  violation_counts: Readonly<Partial<Record<VoiceMissionViolationKind, number>>>;
  replay: VoiceMissionReplay;
}>;

const CATEGORY_ORDER: readonly VoiceMissionOpportunityCategory[] = Object.freeze([
  "resume",
  "audibility",
  "guardrail",
  "latest_fact",
  "goal",
  "async_worker",
]);

const ASYNC_FAILURES: readonly VoiceMissionViolationKind[] = Object.freeze([
  "stale_worker_result_accepted",
  "cancelled_worker_result_accepted",
  "duplicate_worker_result_accepted",
  "unknown_worker_result_accepted",
  "failed_worker_result_accepted",
  "worker_result_outside_window",
  "worker_resolution_omission",
]);

function noViolation(replay: VoiceMissionReplay, kinds: readonly VoiceMissionViolationKind[]): boolean {
  const kindSet = new Set(kinds);
  return !replay.violations.some((violation) => kindSet.has(violation.kind));
}

export function scoreVoiceMission(
  scenario: VoiceMissionScenario,
  events: readonly VoiceMissionEvent[]
): VoiceMissionScore {
  const replay = replayVoiceMission(scenario, events);
  const passed = replay.evaluations.filter((evaluation) => evaluation.satisfied).length;
  const failed = replay.total_opportunities - passed;
  const firstFailure = replay.evaluations.find((evaluation) => !evaluation.satisfied);
  const reliableHorizon = firstFailure ? firstFailure.opportunity_index - 1 : replay.total_opportunities;
  const categories = Object.fromEntries(CATEGORY_ORDER.map((category) => {
    const evaluations = replay.evaluations.filter((evaluation) => evaluation.category === category);
    const categoryPassed = evaluations.filter((evaluation) => evaluation.satisfied).length;
    return [category, Object.freeze({
      total: evaluations.length,
      passed: categoryPassed,
      failed: evaluations.length - categoryPassed,
      rate: evaluations.length === 0 ? 1 : categoryPassed / evaluations.length,
    })];
  })) as Record<VoiceMissionOpportunityCategory, VoiceMissionCategoryScore>;
  const violationCounts: Partial<Record<VoiceMissionViolationKind, number>> = {};
  for (const violation of replay.violations) {
    violationCounts[violation.kind] = (violationCounts[violation.kind] ?? 0) + 1;
  }

  const criteria: Record<VoiceMissionStrictCriterion, boolean> = {
    all_semantic_opportunities_satisfied: failed === 0,
    latest_facts_preserved: noViolation(replay, ["latest_fact_error", "latest_fact_omission", "correction_mismatch", "missing_correction"]),
    async_results_generation_safe: noViolation(replay, ASYNC_FAILURES),
    all_required_goals_completed: noViolation(replay, ["goal_omission", "invalid_goal_completion"]),
    goal_focus_intact: noViolation(replay, ["goal_focus_error"]),
    confirmations_bound: noViolation(replay, ["confirmation_error"]),
    guardrails_contained_actions: noViolation(replay, ["unauthorized_action", "incorrect_guardrail_block", "guardrail_opportunity_missed"]),
    terminal_claims_truthful: noViolation(replay, ["false_completion", "audibility_omission"]),
    cross_session_resume_intact: noViolation(replay, ["resume_omission"]),
  };

  return Object.freeze({
    protocol: "HACC-VMR-v1",
    scenario_id: replay.scenario_id,
    strict_pass: Object.values(criteria).every(Boolean) && replay.violations.length === 0,
    criteria: Object.freeze(criteria),
    opportunities: Object.freeze({
      total: replay.total_opportunities,
      passed,
      failed,
      rate: passed / replay.total_opportunities,
      reliable_horizon: reliableHorizon,
      first_failure_index: firstFailure?.opportunity_index ?? null,
    }),
    categories: Object.freeze(categories),
    violation_counts: Object.freeze(violationCounts),
    replay,
  });
}
