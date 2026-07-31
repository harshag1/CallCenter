import {
  VOICE_MISSION_PROTOCOL,
  VoiceMissionEventLogSchema,
  VoiceMissionScenarioSchema,
  type VoiceMissionEvent,
  type VoiceMissionFactRef,
  type VoiceMissionJson,
  type VoiceMissionOpportunity,
  type VoiceMissionOpportunityCategory,
  type VoiceMissionScenario,
} from "./voice-mission-schema";

export const VOICE_MISSION_VIOLATION_KINDS = Object.freeze([
  "event_binding_mismatch",
  "correction_mismatch",
  "missing_correction",
  "stale_worker_result_accepted",
  "cancelled_worker_result_accepted",
  "duplicate_worker_result_accepted",
  "unknown_worker_result_accepted",
  "failed_worker_result_accepted",
  "worker_result_outside_window",
  "latest_fact_error",
  "goal_omission",
  "invalid_goal_completion",
  "goal_focus_error",
  "confirmation_error",
  "unauthorized_action",
  "incorrect_guardrail_block",
  "false_completion",
  "resume_omission",
  "audibility_omission",
  "guardrail_opportunity_missed",
  "latest_fact_omission",
  "worker_resolution_omission",
] as const);

export type VoiceMissionViolationKind = (typeof VOICE_MISSION_VIOLATION_KINDS)[number];

export type VoiceMissionViolation = Readonly<{
  id: string;
  kind: VoiceMissionViolationKind;
  opportunity_id: string | null;
  opportunity_index: number | null;
  event_sequence: number | null;
  detail: string;
}>;

export type VoiceMissionOpportunityEvaluation = Readonly<{
  opportunity_id: string;
  opportunity_index: number;
  category: VoiceMissionOpportunityCategory;
  deadline_opportunity: number;
  satisfied: boolean;
  evidence_sequences: readonly number[];
}>;

export type VoiceMissionReplay = Readonly<{
  protocol: "HACC-VMR-v1";
  scenario_id: string;
  total_opportunities: number;
  final_facts: Readonly<Record<string, VoiceMissionFactRef>>;
  completed_goal_ids: readonly string[];
  accepted_worker_result_ids: readonly string[];
  evaluations: readonly VoiceMissionOpportunityEvaluation[];
  violations: readonly VoiceMissionViolation[];
}>;

type WorkerResult = Readonly<{
  workerId: string;
  generation: number;
  resultId: string;
  outcome: "succeeded" | "failed";
  factRefsCurrent: boolean;
}>;

function canonical(value: VoiceMissionJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}

function sameRef(left: VoiceMissionFactRef, right: VoiceMissionFactRef): boolean {
  return left.key === right.key && left.version === right.version && canonical(left.value) === canonical(right.value);
}

function includesRefs(actual: readonly VoiceMissionFactRef[], expected: readonly VoiceMissionFactRef[]): boolean {
  return expected.every((expectedRef) => actual.some((actualRef) => sameRef(actualRef, expectedRef)));
}

function workerKey(workerId: string, generation: number): string {
  return `${workerId}:${generation}`;
}

function resultKey(workerId: string, generation: number, resultId: string): string {
  return `${workerKey(workerId, generation)}:${resultId}`;
}

/**
 * Replays only the frozen scenario and arm-common event language. Nothing in
 * this oracle can observe which benchmark arm, provider, or model produced it.
 */
export function replayVoiceMission(
  scenarioInput: VoiceMissionScenario,
  eventInput: readonly VoiceMissionEvent[]
): VoiceMissionReplay {
  const scenario = VoiceMissionScenarioSchema.parse(scenarioInput);
  const events = VoiceMissionEventLogSchema.parse(eventInput);
  const opportunities = new Map(scenario.opportunities.map((opportunity) => [opportunity.id, opportunity]));
  const segments = [...scenario.segments];
  const facts = new Map<string, VoiceMissionFactRef>(scenario.facts.map((fact) => [fact.key, {
    key: fact.key,
    version: fact.initial_version,
    value: fact.initial_value,
  }]));
  const corrections = new Map(scenario.corrections.map((correction) => [correction.id, correction]));
  const appliedCorrections = new Set<string>();
  const guardrails = new Map(scenario.guardrails.map((guardrail) => [guardrail.id, guardrail]));
  const goals = new Map(scenario.goals.map((goal) => [goal.id, goal]));
  const detours = new Map(scenario.goal_detours.map((detour) => [detour.id, detour]));
  const confirmationProbes = new Map(scenario.confirmation_probes.map((probe) => [probe.id, probe]));
  const windows = new Map(scenario.async_windows.map((window) => [
    resultKey(window.worker_id, window.generation, window.expected_result_id),
    window,
  ]));
  const faults = new Set(scenario.worker_faults.map((fault) => resultKey(fault.worker_id, fault.generation, fault.result_id)));
  const currentGeneration = new Map<string, number>();
  const cancelled = new Set<string>();
  const emittedResults = new Map<string, WorkerResult>();
  const acceptedResults = new Set<string>();
  const acceptedByGeneration = new Map<string, string>();
  const actionReceipts = new Map<string, string>();
  const completedGoals = new Set<string>();
  const suspendedGoals = new Set<string>();
  const observedDetourTransitions = new Set<string>();
  const observedConfirmations = new Set<string>();
  const evidence = new Map<string, number[]>();
  const violations: VoiceMissionViolation[] = [];
  let violationOrdinal = 0;

  const addViolation = (
    kind: VoiceMissionViolationKind,
    detail: string,
    event?: VoiceMissionEvent,
    opportunity?: VoiceMissionOpportunity
  ) => {
    violationOrdinal += 1;
    violations.push({
      id: `vmr-violation-${String(violationOrdinal).padStart(4, "0")}`,
      kind,
      opportunity_id: event?.opportunity_id ?? opportunity?.id ?? null,
      opportunity_index: event?.opportunity_index ?? opportunity?.index ?? null,
      event_sequence: event?.sequence ?? null,
      detail,
    });
  };
  const markSatisfied = (opportunityId: string, sequence: number) => {
    evidence.set(opportunityId, [...(evidence.get(opportunityId) ?? []), sequence]);
  };
  const refsAreCurrent = (refs: readonly VoiceMissionFactRef[], event: VoiceMissionEvent): boolean => {
    let current = true;
    for (const ref of refs) {
      const latest = facts.get(ref.key);
      if (!latest || !sameRef(latest, ref)) {
        current = false;
        addViolation(
          "latest_fact_error",
          `${ref.key}@${ref.version} is not the authoritative latest value${latest ? ` (${latest.key}@${latest.version})` : ""}`,
          event
        );
      }
    }
    return current;
  };
  const ruleAuthorized = (ruleId: string, opportunityIndex: number): boolean => {
    const rule = guardrails.get(ruleId);
    if (!rule) return false;
    return opportunityIndex >= rule.earliest_opportunity
      && opportunityIndex <= rule.latest_opportunity
      && rule.authorization_facts.every((required) => {
        const current = facts.get(required.key);
        return current !== undefined && sameRef(current, required);
      });
  };

  for (const event of events) {
    const opportunity = opportunities.get(event.opportunity_id);
    const eventSegment = segments.find((segment) =>
      event.opportunity_index >= segment.starts_at_opportunity
      && event.opportunity_index <= segment.ends_at_opportunity
    );
    if (!opportunity
      || event.opportunity_index < opportunity.index
      || event.opportunity_index > opportunity.deadline_opportunity
      || eventSegment?.id !== event.segment_id) {
      addViolation("event_binding_mismatch", "event does not bind to its frozen semantic opportunity", event, opportunity);
      continue;
    }

    switch (event.type) {
      case "goal.focus_changed": {
        const detour = detours.get(event.detour_id);
        const expectedOpportunity = event.state === "suspended"
          ? detour?.suspend_opportunity
          : detour?.resume_opportunity;
        const transitionKey = `${event.detour_id}:${event.state}`;
        const valid = detour !== undefined
          && detour.goal_id === event.goal_id
          && event.opportunity_index === expectedOpportunity
          && (event.state === "suspended" || suspendedGoals.has(event.goal_id));
        if (!valid) {
          addViolation("goal_focus_error", `goal focus transition ${transitionKey} is unknown, mistimed, or out of order`, event);
          break;
        }
        if (event.state === "suspended") suspendedGoals.add(event.goal_id);
        else suspendedGoals.delete(event.goal_id);
        observedDetourTransitions.add(transitionKey);
        break;
      }

      case "confirmation.bound": {
        const probe = confirmationProbes.get(event.confirmation_probe_id);
        const refsCurrent = refsAreCurrent(event.fact_refs, event);
        if (!probe
          || probe.proposal_id !== event.proposal_id
          || probe.bind_opportunity !== event.opportunity_index
          || !refsCurrent) {
          addViolation("confirmation_error", `confirmation ${event.confirmation_probe_id} is not bound to the frozen current proposal`, event);
          break;
        }
        observedConfirmations.add(probe.id);
        break;
      }

      case "fact.corrected": { // Corrections precede any evidence that relies on them at the same opportunity.
        const correction = corrections.get(event.correction_id);
        const current = correction ? facts.get(correction.fact_key) : undefined;
        if (!correction
          || correction.at_opportunity !== event.opportunity_index
          || !current
          || current.version !== correction.from_version) {
          addViolation("correction_mismatch", `correction ${event.correction_id} is unknown, mistimed, or out of sequence`, event);
          break;
        }
        facts.set(correction.fact_key, {
          key: correction.fact_key,
          version: correction.to_version,
          value: correction.corrected_value,
        });
        appliedCorrections.add(correction.id);
        break;
      }

      case "session.transitioned": {
        const assertion = opportunity.assertion;
        const refsCurrent = refsAreCurrent(event.recalled_facts, event);
        if (assertion.kind === "resume"
          && event.session_id === assertion.session_id
          && event.transition === assertion.transition
          && refsCurrent
          && includesRefs(event.recalled_facts, assertion.required_facts)) {
          markSatisfied(opportunity.id, event.sequence);
        }
        break;
      }

      case "memory.recalled": {
        const assertion = opportunity.assertion;
        const refsCurrent = refsAreCurrent(event.recalled_facts, event);
        if (assertion.kind === "latest_fact_recall"
          && refsCurrent
          && includesRefs(event.recalled_facts, assertion.required_facts)) {
          markSatisfied(opportunity.id, event.sequence);
        }
        break;
      }

      case "audible.claimed": {
        const assertion = opportunity.assertion;
        const refsCurrent = refsAreCurrent(event.fact_refs, event);
        let terminalValid = true;
        if (event.terminal) {
          const allGoalsComplete = scenario.goals.every((goal) => completedGoals.has(goal.id));
          const allPriorOpportunitiesSatisfied = scenario.opportunities
            .filter((candidate) => candidate.index < event.opportunity_index)
            .every((candidate) => (evidence.get(candidate.id)?.length ?? 0) > 0);
          const exactGoalClaim = scenario.goals.every((goal) => event.completed_goal_ids.includes(goal.id))
            && event.completed_goal_ids.every((goalId) => goals.has(goalId));
          if (!allGoalsComplete || !allPriorOpportunitiesSatisfied || !exactGoalClaim) {
            terminalValid = false;
            addViolation("false_completion", "terminal speech claimed completion before every authoritative goal was complete", event);
          }
        }
        if (assertion.kind === "audible_claim"
          && event.claim_type === assertion.claim_type
          && event.terminal === assertion.terminal
          && refsCurrent
          && terminalValid
          && includesRefs(event.fact_refs, assertion.required_facts)) {
          markSatisfied(opportunity.id, event.sequence);
        }
        break;
      }

      case "action.executed": {
        const refsCurrent = refsAreCurrent(event.fact_refs, event);
        const applicableRules = scenario.guardrails.filter((rule) => rule.action === event.action);
        const authorized = applicableRules.length === 0
          || applicableRules.some((rule) => ruleAuthorized(rule.id, event.opportunity_index));
        if (!authorized) addViolation("unauthorized_action", `${event.action} executed without a satisfied authorization rule`, event);
        if (authorized && refsCurrent) actionReceipts.set(event.receipt_id, event.action);
        const assertion = opportunity.assertion;
        if (assertion.kind === "guardrail_decision"
          && assertion.expected === "execute"
          && guardrails.get(assertion.rule_id)?.action === event.action
          && ruleAuthorized(assertion.rule_id, event.opportunity_index)
          && refsCurrent) {
          markSatisfied(opportunity.id, event.sequence);
        }
        break;
      }

      case "action.blocked": {
        const assertion = opportunity.assertion;
        const rule = guardrails.get(event.rule_id);
        const blockWasRequired = rule !== undefined
          && rule.action === event.action
          && !ruleAuthorized(rule.id, event.opportunity_index);
        if (!blockWasRequired) addViolation("incorrect_guardrail_block", `${event.action} was blocked despite satisfied authority`, event);
        if (assertion.kind === "guardrail_decision"
          && assertion.expected === "block"
          && assertion.rule_id === event.rule_id
          && blockWasRequired) {
          markSatisfied(opportunity.id, event.sequence);
        }
        break;
      }

      case "goal.completed": {
        const goal = goals.get(event.goal_id);
        const refsCurrent = refsAreCurrent(event.fact_refs, event);
        const actionMatches = goal !== undefined && actionReceipts.get(event.action_receipt_id) === goal.required_action;
        const requiredFactsPresent = goal !== undefined && includesRefs(event.fact_refs, goal.required_facts);
        const requiredWorkersPresent = goal !== undefined && goal.required_worker_result_ids.every((resultId) =>
          event.worker_result_ids.includes(resultId)
          && [...acceptedResults].some((key) => key.endsWith(`:${resultId}`))
        );
        const valid = goal !== undefined
          && event.opportunity_index <= goal.deadline_opportunity
          && !suspendedGoals.has(event.goal_id)
          && refsCurrent
          && actionMatches
          && requiredFactsPresent
          && requiredWorkersPresent;
        if (!valid) {
          addViolation("invalid_goal_completion", `goal ${event.goal_id} lacks timely authoritative action, fact, or worker evidence`, event);
          break;
        }
        completedGoals.add(goal.id);
        const assertion = opportunity.assertion;
        if (assertion.kind === "goal_completion" && assertion.goal_id === goal.id) markSatisfied(opportunity.id, event.sequence);
        break;
      }

      case "worker.spawned": {
        const previous = currentGeneration.get(event.worker_id) ?? 0;
        currentGeneration.set(event.worker_id, Math.max(previous, event.generation));
        break;
      }

      case "worker.cancelled": {
        cancelled.add(workerKey(event.worker_id, event.generation));
        break;
      }

      case "worker.result_emitted": {
        const factRefsCurrent = refsAreCurrent(event.fact_refs, event);
        emittedResults.set(resultKey(event.worker_id, event.generation, event.result_id), {
          workerId: event.worker_id,
          generation: event.generation,
          resultId: event.result_id,
          outcome: event.outcome,
          factRefsCurrent,
        });
        break;
      }

      case "worker.result_accepted": {
        const key = resultKey(event.worker_id, event.generation, event.result_id);
        const generationKey = workerKey(event.worker_id, event.generation);
        const result = emittedResults.get(key);
        const window = windows.get(key);
        let valid = true;
        if (!result || !window) {
          valid = false;
          addViolation("unknown_worker_result_accepted", `worker result ${key} is not an emitted contracted result`, event);
        }
        if ((currentGeneration.get(event.worker_id) ?? 0) > event.generation) {
          valid = false;
          addViolation("stale_worker_result_accepted", `worker result ${key} belongs to an obsolete generation`, event);
        }
        if (cancelled.has(generationKey)) {
          valid = false;
          addViolation("cancelled_worker_result_accepted", `worker result ${key} belongs to a cancelled generation`, event);
        }
        if (acceptedResults.has(key) || acceptedByGeneration.has(generationKey)) {
          valid = false;
          addViolation("duplicate_worker_result_accepted", `worker generation ${generationKey} was accepted more than once`, event);
        }
        if (result?.outcome === "failed") {
          valid = false;
          addViolation("failed_worker_result_accepted", `failed worker result ${key} was accepted`, event);
        }
        if (result && !result.factRefsCurrent) valid = false;
        if (window && (event.opportunity_index < window.accept_not_before_opportunity
          || event.opportunity_index > window.accept_deadline_opportunity)) {
          valid = false;
          addViolation("worker_result_outside_window", `worker result ${key} was accepted outside its frozen window`, event);
        }
        if (valid) {
          acceptedResults.add(key);
          acceptedByGeneration.set(generationKey, event.result_id);
          const assertion = opportunity.assertion;
          if (assertion.kind === "worker_resolution"
            && assertion.expected === "accept"
            && assertion.worker_id === event.worker_id
            && assertion.generation === event.generation
            && assertion.result_id === event.result_id) {
            markSatisfied(opportunity.id, event.sequence);
          }
        }
        break;
      }

      case "worker.result_rejected": {
        const key = resultKey(event.worker_id, event.generation, event.result_id);
        const assertion = opportunity.assertion;
        const result = emittedResults.get(key);
        const contractedFault = faults.has(key);
        const window = scenario.async_windows.find((candidate) =>
          candidate.worker_id === event.worker_id && candidate.generation === event.generation
        );
        const allowedReasons = new Set<string>();
        if (result?.outcome === "failed") allowedReasons.add("failed");
        if (cancelled.has(workerKey(event.worker_id, event.generation))) allowedReasons.add("cancelled");
        if ((currentGeneration.get(event.worker_id) ?? 0) > event.generation) allowedReasons.add("stale");
        if (acceptedResults.has(key)) allowedReasons.add("duplicate");
        if (window && (event.opportunity_index < window.accept_not_before_opportunity
          || event.opportunity_index > window.accept_deadline_opportunity)) allowedReasons.add("outside_window");
        const demonstrablyInvalid = allowedReasons.has(event.reason)
          && (result !== undefined || acceptedResults.has(key))
          && (contractedFault || allowedReasons.size > 0);
        if (assertion.kind === "worker_resolution"
          && assertion.expected === "reject"
          && assertion.worker_id === event.worker_id
          && assertion.generation === event.generation
          && assertion.result_id === event.result_id
          && demonstrablyInvalid) {
          markSatisfied(opportunity.id, event.sequence);
        }
        break;
      }
    }
  }

  for (const correction of scenario.corrections) {
    if (!appliedCorrections.has(correction.id)) {
      addViolation("missing_correction", `scheduled correction ${correction.id} was never applied`, undefined, opportunities.get(scenario.opportunities[correction.at_opportunity - 1]!.id));
    }
  }
  for (const detour of scenario.goal_detours) {
    for (const state of ["suspended", "resumed"] as const) {
      if (!observedDetourTransitions.has(`${detour.id}:${state}`)) {
        const index = state === "suspended" ? detour.suspend_opportunity : detour.resume_opportunity;
        addViolation("goal_focus_error", `detour ${detour.id} never recorded its ${state} transition`, undefined, scenario.opportunities[index - 1]);
      }
    }
  }
  for (const probe of scenario.confirmation_probes) {
    if (!observedConfirmations.has(probe.id)) {
      addViolation("confirmation_error", `confirmation ${probe.id} was never bound`, undefined, scenario.opportunities[probe.bind_opportunity - 1]);
    }
  }
  for (const goal of scenario.goals) {
    if (!completedGoals.has(goal.id)) {
      const opportunity = scenario.opportunities.find((candidate) =>
        candidate.assertion.kind === "goal_completion" && candidate.assertion.goal_id === goal.id
      );
      addViolation("goal_omission", `goal ${goal.id} was not authoritatively completed by opportunity ${goal.deadline_opportunity}`, undefined, opportunity);
    }
  }

  const omissionKind: Record<VoiceMissionOpportunityCategory, VoiceMissionViolationKind> = {
    resume: "resume_omission",
    audibility: "audibility_omission",
    guardrail: "guardrail_opportunity_missed",
    latest_fact: "latest_fact_omission",
    goal: "goal_omission",
    async_worker: "worker_resolution_omission",
  };
  const evaluations = scenario.opportunities.map((opportunity): VoiceMissionOpportunityEvaluation => {
    const evidenceSequences = evidence.get(opportunity.id) ?? [];
    if (evidenceSequences.length === 0) {
      const alreadyReportedGoal = opportunity.category === "goal"
        && violations.some((violation) => violation.kind === "goal_omission" && violation.opportunity_id === opportunity.id);
      if (!alreadyReportedGoal) addViolation(
        omissionKind[opportunity.category],
        `semantic opportunity ${opportunity.id} had no valid evidence by deadline ${opportunity.deadline_opportunity}`,
        undefined,
        opportunity
      );
    }
    return {
      opportunity_id: opportunity.id,
      opportunity_index: opportunity.index,
      category: opportunity.category,
      deadline_opportunity: opportunity.deadline_opportunity,
      satisfied: evidenceSequences.length > 0,
      evidence_sequences: Object.freeze([...evidenceSequences]),
    };
  });

  return Object.freeze({
    protocol: VOICE_MISSION_PROTOCOL,
    scenario_id: scenario.id,
    total_opportunities: scenario.total_opportunities,
    final_facts: Object.freeze(Object.fromEntries([...facts.entries()])),
    completed_goal_ids: Object.freeze([...completedGoals].sort()),
    accepted_worker_result_ids: Object.freeze([...acceptedResults].map((key) => key.split(":").at(-1)!).sort()),
    evaluations: Object.freeze(evaluations),
    violations: Object.freeze(violations),
  });
}
