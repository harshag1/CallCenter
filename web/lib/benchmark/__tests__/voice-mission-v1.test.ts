import { describe, expect, it } from "vitest";
import {
  VOICE_MISSION_PROTOCOL,
  VoiceMissionEventLogSchema,
  VoiceMissionScenarioSchema,
  type VoiceMissionEvent,
  type VoiceMissionFactRef,
  type VoiceMissionJson,
  type VoiceMissionOpportunity,
  type VoiceMissionScenario,
} from "../voice-mission-schema";
import { scoreVoiceMission } from "../voice-mission-scoring";
import { VOICE_MISSION_VIOLATION_KINDS, type VoiceMissionViolationKind } from "../voice-mission-world";

type MutableEvent = Record<string, unknown>;
type Fixture = Readonly<{ scenario: VoiceMissionScenario; events: readonly VoiceMissionEvent[] }>;

const INITIAL_FACTS = {
  "case.priority": "routine",
  "service.destination": "central-clinic",
  "customer.callback_window": "09:00-11:00",
  "customer.identity_verified": true,
  "customer.contact_consent": true,
  "service.arrival_window": "morning",
  "case.owner": "team-blue",
} as const satisfies Record<string, VoiceMissionJson>;

const CORRECTIONS = [
  { id: "correction.01", at_opportunity: 12, fact_key: "case.priority", from_version: 1, to_version: 2, corrected_value: "priority" },
  { id: "correction.02", at_opportunity: 28, fact_key: "service.destination", from_version: 1, to_version: 2, corrected_value: "north-clinic" },
  { id: "correction.03", at_opportunity: 44, fact_key: "customer.callback_window", from_version: 1, to_version: 2, corrected_value: "14:00-16:00" },
  { id: "correction.04", at_opportunity: 56, fact_key: "service.arrival_window", from_version: 1, to_version: 2, corrected_value: "afternoon" },
  { id: "correction.05", at_opportunity: 72, fact_key: "case.priority", from_version: 2, to_version: 3, corrected_value: "urgent" },
  { id: "correction.06", at_opportunity: 88, fact_key: "service.destination", from_version: 2, to_version: 3, corrected_value: "mobile-unit-7" },
  { id: "correction.07", at_opportunity: 104, fact_key: "customer.callback_window", from_version: 2, to_version: 3, corrected_value: "after-18:00" },
  { id: "correction.08", at_opportunity: 116, fact_key: "case.owner", from_version: 1, to_version: 2, corrected_value: "team-green" },
  { id: "correction.09", at_opportunity: 132, fact_key: "case.priority", from_version: 3, to_version: 4, corrected_value: "critical" },
  { id: "correction.10", at_opportunity: 148, fact_key: "service.destination", from_version: 3, to_version: 4, corrected_value: "east-clinic" },
  { id: "correction.11", at_opportunity: 164, fact_key: "customer.callback_window", from_version: 3, to_version: 4, corrected_value: "weekend-only" },
  { id: "correction.12", at_opportunity: 176, fact_key: "service.arrival_window", from_version: 2, to_version: 3, corrected_value: "evening" },
] as const;

const WORKERS = [
  { ordinal: 1, launch: 20, accept: 40, fault: 41 },
  { ordinal: 2, launch: 35, accept: 70, fault: 71 },
  { ordinal: 3, launch: 50, accept: 55, fault: 57 },
  { ordinal: 4, launch: 58, accept: 65, fault: 67 },
  { ordinal: 5, launch: 66, accept: 86, fault: 87 },
  { ordinal: 6, launch: 80, accept: 90, fault: 91 },
  { ordinal: 7, launch: 95, accept: 115, fault: 117 },
  { ordinal: 8, launch: 110, accept: 130, fault: 131 },
  { ordinal: 9, launch: 128, accept: 133, fault: 134 },
  { ordinal: 10, launch: 140, accept: 160, fault: 161 },
  { ordinal: 11, launch: 150, accept: 155, fault: 156 },
  { ordinal: 12, launch: 165, accept: 170, fault: 171 },
] as const;

const GOAL_COMPLETIONS = [89, 119, 149, 169, 178, 179] as const;
const GOAL_ACTIONS = [83, 113, 143, 163, 173, 175] as const;
const GOAL_DETOURS = [
  { id: "detour.01", goal_id: "goal.01", suspend_opportunity: 50, resume_opportunity: 70 },
  { id: "detour.02", goal_id: "goal.02", suspend_opportunity: 58, resume_opportunity: 75 },
  { id: "detour.03", goal_id: "goal.03", suspend_opportunity: 96, resume_opportunity: 110 },
  { id: "detour.04", goal_id: "goal.04", suspend_opportunity: 112, resume_opportunity: 128 },
  { id: "detour.05", goal_id: "goal.05", suspend_opportunity: 140, resume_opportunity: 150 },
  { id: "detour.06", goal_id: "goal.06", suspend_opportunity: 158, resume_opportunity: 166 },
] as const;
type ConfirmationFixture = Readonly<{
  id: string;
  action: string;
  proposal_id: string;
  bind_opportunity: number;
  execution_opportunity: number;
  invalidated_by_correction_id?: string;
}>;

const CONFIRMATIONS: readonly ConfirmationFixture[] = [
  { id: "confirmation.01", action: "action.confirmation.01", proposal_id: "proposal.01", bind_opportunity: 10, execution_opportunity: 14, invalidated_by_correction_id: "correction.01" },
  { id: "confirmation.02", action: "action.confirmation.02", proposal_id: "proposal.02", bind_opportunity: 26, execution_opportunity: 30, invalidated_by_correction_id: "correction.02" },
  { id: "confirmation.03", action: "action.confirmation.03", proposal_id: "proposal.03", bind_opportunity: 42, execution_opportunity: 46, invalidated_by_correction_id: "correction.03" },
  { id: "confirmation.04", action: "action.confirmation.04", proposal_id: "proposal.04", bind_opportunity: 74, execution_opportunity: 77 },
  { id: "confirmation.05", action: "action.confirmation.05", proposal_id: "proposal.05", bind_opportunity: 134, execution_opportunity: 137 },
  { id: "confirmation.06", action: "action.confirmation.06", proposal_id: "proposal.06", bind_opportunity: 165, execution_opportunity: 167 },
];
const RECALL_PROBES = new Set([8, 12, 20, 28, 36, 44, 52, 60, 68, 72, 80, 88, 96, 104, 112, 120, 128, 132, 140, 148, 152, 164, 172, 176]);
const AUDIBLE_PROBES = new Set([18, 58, 78, 118, 138, 180]);

function refAt(key: keyof typeof INITIAL_FACTS, opportunity: number): VoiceMissionFactRef {
  let value: VoiceMissionJson = INITIAL_FACTS[key];
  let version = 1;
  for (const correction of CORRECTIONS) {
    if (correction.fact_key === key && correction.at_opportunity <= opportunity) {
      version = correction.to_version;
      value = correction.corrected_value;
    }
  }
  return { key, version, value };
}

function segmentIdAt(index: number): string {
  return `segment.${String(Math.ceil(index / 60)).padStart(2, "0")}`;
}

function buildDevelopmentFixture(): Fixture {
  const opportunities: VoiceMissionOpportunity[] = [];
  const guardrails: MutableEvent[] = [];
  const rawEvents: MutableEvent[] = [];
  const workerByAccept = new Map<number, { worker: typeof WORKERS[number]; resolution: "accept" }>(WORKERS.map((worker) => [worker.accept, { worker, resolution: "accept" }]));
  const workerByFault = new Map<number, { worker: typeof WORKERS[number]; resolution: "reject" }>(WORKERS.map((worker) => [worker.fault, { worker, resolution: "reject" }]));
  const goalByCompletion = new Map<number, number>(GOAL_COMPLETIONS.map((index, goalIndex) => [index, goalIndex + 1]));
  const goalByAction = new Map<number, number>(GOAL_ACTIONS.map((index, goalIndex) => [index, goalIndex + 1]));
  const confirmationByExecution = new Map<number, ConfirmationFixture>(CONFIRMATIONS.map((probe) => [probe.execution_opportunity, probe]));
  const correctionByIndex = new Map<number, typeof CORRECTIONS[number]>(CORRECTIONS.map((correction) => [correction.at_opportunity, correction]));
  const detourTransitions = new Map<number, { detour: typeof GOAL_DETOURS[number]; state: "suspended" | "resumed" }[]>();
  for (const detour of GOAL_DETOURS) {
    detourTransitions.set(detour.suspend_opportunity, [...(detourTransitions.get(detour.suspend_opportunity) ?? []), { detour, state: "suspended" }]);
    detourTransitions.set(detour.resume_opportunity, [...(detourTransitions.get(detour.resume_opportunity) ?? []), { detour, state: "resumed" }]);
  }
  const confirmationByBind = new Map<number, ConfirmationFixture>(CONFIRMATIONS.map((probe) => [probe.bind_opportunity, probe]));
  const workersByLaunch = new Map<number, typeof WORKERS[number][]>();
  for (const worker of WORKERS) workersByLaunch.set(worker.launch, [...(workersByLaunch.get(worker.launch) ?? []), worker]);

  const goals = GOAL_COMPLETIONS.map((deadline, goalIndex) => {
    const ordinal = goalIndex + 1;
    const workerA = WORKERS[(ordinal - 1) * 2]!;
    const workerB = WORKERS[(ordinal - 1) * 2 + 1]!;
    return {
      id: `goal.${String(ordinal).padStart(2, "0")}`,
      required_action: `action.goal.${String(ordinal).padStart(2, "0")}`,
      deadline_opportunity: deadline,
      required_facts: [refAt("service.destination", deadline), refAt("case.priority", deadline)],
      required_worker_result_ids: [`result.${workerA.ordinal}.canonical`, `result.${workerB.ordinal}.canonical`],
    };
  });

  const addEvent = (opportunity: VoiceMissionOpportunity, event: MutableEvent) => rawEvents.push({
    protocol: VOICE_MISSION_PROTOCOL,
    opportunity_id: opportunity.id,
    opportunity_index: opportunity.index,
    segment_id: opportunity.segment_id,
    ...event,
  });

  for (let index = 1; index <= 180; index += 1) {
    const segmentId = segmentIdAt(index);
    const id = `opportunity.${String(index).padStart(3, "0")}`;
    const workerResolution = workerByAccept.get(index) ?? workerByFault.get(index);
    const goalOrdinal = goalByCompletion.get(index);
    const confirmation = confirmationByExecution.get(index);
    const goalActionOrdinal = goalByAction.get(index);
    let opportunity: VoiceMissionOpportunity;

    if (index === 1 || index === 61 || index === 121) {
      const sessionOrdinal = Math.ceil(index / 60);
      opportunity = {
        id, index, segment_id: segmentId, category: "resume", deadline_opportunity: index,
        description: index === 1 ? "Start from the durable mission head." : "Resume a fresh realtime session from the durable mission head.",
        assertion: {
          kind: "resume", transition: index === 1 ? "start" : "resume",
          session_id: `session.${String(sessionOrdinal).padStart(2, "0")}`,
          required_facts: [refAt("service.destination", index), refAt("case.priority", index), refAt("customer.callback_window", index)],
        },
      };
    } else if (workerResolution) {
      const { worker, resolution } = workerResolution;
      const faultKind = ["failed_attempt", "late_delivery", "cancelled_delivery", "duplicate_delivery"][(worker.ordinal - 1) % 4]!;
      const resultId = resolution === "accept" || faultKind === "duplicate_delivery"
        ? `result.${worker.ordinal}.canonical`
        : `result.${worker.ordinal}.fault`;
      opportunity = {
        id, index, segment_id: segmentId, category: "async_worker",
        deadline_opportunity: resolution === "accept" ? Math.min(index + 3, 180) : index,
        description: resolution === "accept" ? "Incorporate one eligible current-generation worker result." : "Reject a deterministically faulted worker delivery.",
        assertion: { kind: "worker_resolution", worker_id: `worker.${worker.ordinal}`, generation: 1, result_id: resultId, expected: resolution },
      };
    } else if (goalOrdinal) {
      opportunity = {
        id, index, segment_id: segmentId, category: "goal", deadline_opportunity: index,
        description: "Settle a resumed goal only from current facts, accepted worker results, and an authoritative action receipt.",
        assertion: { kind: "goal_completion", goal_id: `goal.${String(goalOrdinal).padStart(2, "0")}` },
      };
    } else if (RECALL_PROBES.has(index)) {
      opportunity = {
        id, index, segment_id: segmentId, category: "latest_fact", deadline_opportunity: index,
        registered_probe: "recall",
        description: "Recall future-relevant case state, preferring the newest corrected revision over a decoy.",
        assertion: { kind: "latest_fact_recall", required_facts: [refAt("service.destination", index), refAt("case.priority", index), refAt("customer.callback_window", index)] },
      };
    } else if (AUDIBLE_PROBES.has(index)) {
      const terminal = index === 180;
      opportunity = {
        id, index, segment_id: segmentId, category: "audibility", deadline_opportunity: index,
        registered_probe: "audible_state",
        description: terminal ? "Make a receipt-grounded terminal claim after all 180 opportunities." : "Repair caller-visible state after a simulated partial-playback boundary.",
        assertion: { kind: "audible_claim", claim_type: terminal ? "mission.complete" : "mission.audible-state", terminal, required_facts: [refAt("service.destination", index), refAt("case.priority", index)] },
      };
    } else if (confirmation || goalActionOrdinal || index % 2 === 0) {
      const ruleId = confirmation
        ? `rule.${confirmation.id}`
        : goalActionOrdinal
          ? `rule.goal.${goalActionOrdinal}`
          : `rule.routine.${index}`;
      const action = confirmation?.action
        ?? (goalActionOrdinal ? `action.goal.${String(goalActionOrdinal).padStart(2, "0")}` : `action.routine.${index}`);
      const invalidated = confirmation?.invalidated_by_correction_id !== undefined;
      const expected = invalidated || (!confirmation && !goalActionOrdinal && index % 4 === 0) ? "block" : "execute";
      let authorizationFacts: VoiceMissionFactRef[];
      if (invalidated) {
        const correction = CORRECTIONS.find((candidate) => candidate.id === confirmation.invalidated_by_correction_id)!;
        authorizationFacts = [refAt(correction.fact_key as keyof typeof INITIAL_FACTS, confirmation.bind_opportunity)];
      } else if (expected === "block") {
        authorizationFacts = [{ ...refAt("customer.contact_consent", index), value: false }];
      } else {
        authorizationFacts = [refAt("customer.contact_consent", index), refAt("customer.identity_verified", index)];
      }
      guardrails.push({ id: ruleId, action, earliest_opportunity: index, latest_opportunity: index, authorization_facts: authorizationFacts });
      opportunity = {
        id, index, segment_id: segmentId, category: "guardrail", deadline_opportunity: index,
        description: expected === "execute" ? "Execute an authorized receipt-backed mutation." : "Contain an action with stale or absent authority.",
        assertion: { kind: "guardrail_decision", rule_id: ruleId, expected },
      };
    } else {
      opportunity = {
        id, index, segment_id: segmentId, category: "audibility", deadline_opportunity: index,
        description: "Give a concise caller-visible progress update grounded in current mission state.",
        assertion: { kind: "audible_claim", claim_type: "mission.progress", terminal: false, required_facts: [refAt("service.destination", index), refAt("case.priority", index)] },
      };
    }
    opportunities.push(opportunity);

    const correction = correctionByIndex.get(index);
    if (correction) addEvent(opportunity, { type: "fact.corrected", correction_id: correction.id });
    for (const transition of detourTransitions.get(index) ?? []) addEvent(opportunity, {
      type: "goal.focus_changed", detour_id: transition.detour.id, goal_id: transition.detour.goal_id, state: transition.state,
    });
    const boundConfirmation = confirmationByBind.get(index);
    if (boundConfirmation) addEvent(opportunity, {
      type: "confirmation.bound", confirmation_probe_id: boundConfirmation.id, proposal_id: boundConfirmation.proposal_id,
      fact_refs: [refAt("service.destination", index), refAt("case.priority", index)],
    });
    for (const worker of workersByLaunch.get(index) ?? []) addEvent(opportunity, {
      type: "worker.spawned", worker_id: `worker.${worker.ordinal}`, generation: 1,
    });

    const assertion = opportunity.assertion;
    if (assertion.kind === "resume") {
      addEvent(opportunity, { type: "session.transitioned", session_id: assertion.session_id, transition: assertion.transition, recalled_facts: assertion.required_facts });
    } else if (assertion.kind === "latest_fact_recall") {
      addEvent(opportunity, { type: "memory.recalled", recalled_facts: assertion.required_facts });
    } else if (assertion.kind === "audible_claim") {
      addEvent(opportunity, {
        type: "audible.claimed", claim_id: `claim.${index}`, claim_type: assertion.claim_type, terminal: assertion.terminal,
        fact_refs: assertion.required_facts, completed_goal_ids: assertion.terminal ? goals.map((goal) => goal.id) : [],
      });
    } else if (assertion.kind === "guardrail_decision") {
      const rule = guardrails.find((candidate) => candidate.id === assertion.rule_id)!;
      if (assertion.expected === "execute") addEvent(opportunity, {
        type: "action.executed", action_id: `execution.${index}`, action: rule.action, receipt_id: goalActionOrdinal ? `receipt.goal.${goalActionOrdinal}` : `receipt.${index}`,
        fact_refs: rule.authorization_facts,
      });
      else addEvent(opportunity, { type: "action.blocked", action_id: `blocked.${index}`, action: rule.action, rule_id: rule.id });
    } else if (assertion.kind === "goal_completion") {
      const ordinal = Number(assertion.goal_id.split(".").at(-1));
      const goal = goals[ordinal - 1]!;
      addEvent(opportunity, {
        type: "goal.completed", goal_id: goal.id, action_receipt_id: `receipt.goal.${ordinal}`,
        fact_refs: goal.required_facts, worker_result_ids: goal.required_worker_result_ids,
      });
    } else if (assertion.kind === "worker_resolution") {
      const worker = WORKERS.find((candidate) => `worker.${candidate.ordinal}` === assertion.worker_id)!;
      if (assertion.expected === "accept") {
        addEvent(opportunity, { type: "worker.result_emitted", worker_id: assertion.worker_id, generation: 1, result_id: assertion.result_id, outcome: "succeeded", fact_refs: [refAt("service.destination", index)] });
        addEvent(opportunity, { type: "worker.result_accepted", worker_id: assertion.worker_id, generation: 1, result_id: assertion.result_id });
      } else {
        const kind = ["failed_attempt", "late_delivery", "cancelled_delivery", "duplicate_delivery"][(worker.ordinal - 1) % 4]!;
        if (kind === "cancelled_delivery") addEvent(opportunity, { type: "worker.cancelled", worker_id: assertion.worker_id, generation: 1 });
        addEvent(opportunity, {
          type: "worker.result_emitted", worker_id: assertion.worker_id, generation: 1, result_id: assertion.result_id,
          outcome: kind === "failed_attempt" ? "failed" : "succeeded", fact_refs: [refAt("service.destination", index)],
        });
        addEvent(opportunity, {
          type: "worker.result_rejected", worker_id: assertion.worker_id, generation: 1, result_id: assertion.result_id,
          reason: kind === "failed_attempt" ? "failed" : kind === "late_delivery" ? "outside_window" : kind === "cancelled_delivery" ? "cancelled" : "duplicate",
        });
      }
    }
  }

  const scenario = VoiceMissionScenarioSchema.parse({
    protocol: VOICE_MISSION_PROTOCOL,
    id: "development.service-recovery-180",
    version: "1.0.0-development",
    description: "Three-session durable service recovery with registered corrections, goal detours, confirmations, workers, faults, recall, and audible-state probes.",
    total_opportunities: 180,
    segments: [1, 2, 3].map((ordinal) => ({
      id: `segment.${String(ordinal).padStart(2, "0")}`,
      ordinal,
      session_id: `session.${String(ordinal).padStart(2, "0")}`,
      starts_at_opportunity: (ordinal - 1) * 60 + 1,
      ends_at_opportunity: ordinal * 60,
    })),
    facts: Object.entries(INITIAL_FACTS).map(([key, initial_value]) => ({ key, initial_version: 1, initial_value })),
    corrections: CORRECTIONS,
    async_windows: WORKERS.map((worker) => ({
      worker_id: `worker.${worker.ordinal}`, generation: 1, spawn_opportunity: worker.launch,
      accept_not_before_opportunity: worker.accept, accept_deadline_opportunity: worker.accept,
      expected_result_id: `result.${worker.ordinal}.canonical`,
      required_for_goal_ids: [`goal.${String(Math.ceil(worker.ordinal / 2)).padStart(2, "0")}`],
    })),
    worker_faults: WORKERS.map((worker) => {
      const kind = ["failed_attempt", "late_delivery", "cancelled_delivery", "duplicate_delivery"][(worker.ordinal - 1) % 4]!;
      return {
        id: `fault.${String(worker.ordinal).padStart(2, "0")}`, worker_id: `worker.${worker.ordinal}`, generation: 1,
        result_id: kind === "duplicate_delivery" ? `result.${worker.ordinal}.canonical` : `result.${worker.ordinal}.fault`,
        at_opportunity: worker.fault, kind,
      };
    }),
    guardrails,
    goals,
    goal_detours: GOAL_DETOURS,
    confirmation_probes: CONFIRMATIONS,
    opportunities,
  });
  return { scenario, events: VoiceMissionEventLogSchema.parse(rawEvents.map((event, offset) => ({ ...event, sequence: offset + 1 }))) };
}

function resequence(events: readonly VoiceMissionEvent[]): VoiceMissionEvent[] {
  return events.map((event, index) => ({ ...event, sequence: index + 1 }));
}

function replaceEvent(
  events: readonly VoiceMissionEvent[],
  predicate: (event: VoiceMissionEvent) => boolean,
  replacement: (event: VoiceMissionEvent) => VoiceMissionEvent
): VoiceMissionEvent[] {
  const index = events.findIndex(predicate);
  if (index < 0) throw new Error("mutation target is absent");
  const mutated = [...events];
  mutated[index] = replacement(mutated[index]!);
  return resequence(mutated);
}

function removeEvent(events: readonly VoiceMissionEvent[], predicate: (event: VoiceMissionEvent) => boolean): VoiceMissionEvent[] {
  let removed = false;
  return resequence(events.filter((event) => {
    if (!removed && predicate(event)) {
      removed = true;
      return false;
    }
    return true;
  }));
}

type MutationCase = Readonly<{
  expected: VoiceMissionViolationKind;
  mutate: (fixture: Fixture) => readonly VoiceMissionEvent[];
}>;

function acceptedEvent(fixture: Fixture): Extract<VoiceMissionEvent, { type: "worker.result_accepted" }> {
  const event = fixture.events.find((candidate) => candidate.type === "worker.result_accepted");
  if (!event || event.type !== "worker.result_accepted") throw new Error("fixture has no accepted worker result");
  return event;
}

const MUTATIONS: readonly MutationCase[] = [
  {
    expected: "event_binding_mismatch",
    mutate: ({ events }) => replaceEvent(events, (event) => event.type === "memory.recalled", (event) => ({ ...event, opportunity_index: event.opportunity_index + 1 })),
  },
  {
    expected: "correction_mismatch",
    mutate: ({ events }) => replaceEvent(events, (event) => event.type === "fact.corrected", (event) => event.type === "fact.corrected" ? { ...event, correction_id: "correction.unknown" } : event),
  },
  {
    expected: "missing_correction",
    mutate: ({ events }) => removeEvent(events, (event) => event.type === "fact.corrected"),
  },
  {
    expected: "stale_worker_result_accepted",
    mutate: (fixture) => {
      const accepted = acceptedEvent(fixture);
      const index = fixture.events.indexOf(accepted);
      const spawned: VoiceMissionEvent = {
        protocol: accepted.protocol, sequence: accepted.sequence, opportunity_id: accepted.opportunity_id,
        opportunity_index: accepted.opportunity_index, segment_id: accepted.segment_id,
        type: "worker.spawned", worker_id: accepted.worker_id, generation: accepted.generation + 1,
      };
      return resequence([...fixture.events.slice(0, index), spawned, ...fixture.events.slice(index)]);
    },
  },
  {
    expected: "cancelled_worker_result_accepted",
    mutate: (fixture) => {
      const accepted = acceptedEvent(fixture);
      const index = fixture.events.indexOf(accepted);
      const cancelled: VoiceMissionEvent = {
        protocol: accepted.protocol, sequence: accepted.sequence, opportunity_id: accepted.opportunity_id,
        opportunity_index: accepted.opportunity_index, segment_id: accepted.segment_id,
        type: "worker.cancelled", worker_id: accepted.worker_id, generation: accepted.generation,
      };
      return resequence([...fixture.events.slice(0, index), cancelled, ...fixture.events.slice(index)]);
    },
  },
  {
    expected: "duplicate_worker_result_accepted",
    mutate: (fixture) => {
      const accepted = acceptedEvent(fixture);
      const index = fixture.events.indexOf(accepted);
      return resequence([...fixture.events.slice(0, index + 1), accepted, ...fixture.events.slice(index + 1)]);
    },
  },
  {
    expected: "unknown_worker_result_accepted",
    mutate: ({ events }) => replaceEvent(events, (event) => event.type === "worker.result_accepted", (event) => event.type === "worker.result_accepted" ? { ...event, result_id: "result.unknown" } : event),
  },
  {
    expected: "failed_worker_result_accepted",
    mutate: ({ events }) => replaceEvent(events, (event) => event.type === "worker.result_emitted" && event.result_id === "result.1.canonical", (event) => event.type === "worker.result_emitted" ? { ...event, outcome: "failed" } : event),
  },
  {
    expected: "worker_result_outside_window",
    mutate: ({ events }) => replaceEvent(events, (event) => event.type === "worker.result_accepted" && event.result_id === "result.1.canonical", (event) => ({ ...event, opportunity_index: event.opportunity_index + 2 })),
  },
  {
    expected: "latest_fact_error",
    mutate: ({ events }) => replaceEvent(events, (event) => event.type === "memory.recalled" && event.opportunity_index === 12, (event) => event.type === "memory.recalled" ? {
      ...event,
      recalled_facts: event.recalled_facts.map((ref) => ref.key === "case.priority" ? { key: ref.key, version: 1, value: "routine" } : ref),
    } : event),
  },
  {
    expected: "goal_omission",
    mutate: ({ events }) => removeEvent(events, (event) => event.type === "goal.completed"),
  },
  {
    expected: "invalid_goal_completion",
    mutate: ({ events }) => replaceEvent(events, (event) => event.type === "goal.completed", (event) => event.type === "goal.completed" ? { ...event, action_receipt_id: "receipt.unknown" } : event),
  },
  {
    expected: "goal_focus_error",
    mutate: ({ events }) => removeEvent(events, (event) => event.type === "goal.focus_changed"),
  },
  {
    expected: "confirmation_error",
    mutate: ({ events }) => removeEvent(events, (event) => event.type === "confirmation.bound"),
  },
  {
    expected: "unauthorized_action",
    mutate: ({ events }) => {
      const blocked = events.find((event) => event.type === "action.blocked");
      if (!blocked || blocked.type !== "action.blocked") throw new Error("fixture has no blocked action");
      const executed: VoiceMissionEvent = {
        protocol: blocked.protocol, sequence: blocked.sequence, opportunity_id: blocked.opportunity_id,
        opportunity_index: blocked.opportunity_index, segment_id: blocked.segment_id,
        type: "action.executed", action_id: blocked.action_id, action: blocked.action,
        receipt_id: "receipt.unauthorized", fact_refs: [],
      };
      return replaceEvent(events, (event) => event === blocked, () => executed);
    },
  },
  {
    expected: "incorrect_guardrail_block",
    mutate: ({ scenario, events }) => {
      const executed = events.find((event) => event.type === "action.executed");
      if (!executed || executed.type !== "action.executed") throw new Error("fixture has no executed action");
      const opportunity = scenario.opportunities[executed.opportunity_index - 1]!;
      if (opportunity.assertion.kind !== "guardrail_decision") throw new Error("action is not a guardrail decision");
      const blocked: VoiceMissionEvent = {
        protocol: executed.protocol, sequence: executed.sequence, opportunity_id: executed.opportunity_id,
        opportunity_index: executed.opportunity_index, segment_id: executed.segment_id,
        type: "action.blocked", action_id: executed.action_id, action: executed.action, rule_id: opportunity.assertion.rule_id,
      };
      return replaceEvent(events, (event) => event === executed, () => blocked);
    },
  },
  {
    expected: "false_completion",
    mutate: ({ events }) => replaceEvent(events, (event) => event.type === "audible.claimed" && !event.terminal, (event) => event.type === "audible.claimed" ? { ...event, terminal: true, completed_goal_ids: [] } : event),
  },
  {
    expected: "resume_omission",
    mutate: ({ events }) => removeEvent(events, (event) => event.type === "session.transitioned" && event.opportunity_index === 61),
  },
  {
    expected: "audibility_omission",
    mutate: ({ events }) => removeEvent(events, (event) => event.type === "audible.claimed" && event.opportunity_index === 18),
  },
  {
    expected: "guardrail_opportunity_missed",
    mutate: ({ events }) => removeEvent(events, (event) => (event.type === "action.blocked" || event.type === "action.executed") && event.opportunity_index === 14),
  },
  {
    expected: "latest_fact_omission",
    mutate: ({ events }) => removeEvent(events, (event) => event.type === "memory.recalled" && event.opportunity_index === 8),
  },
  {
    expected: "worker_resolution_omission",
    mutate: ({ events }) => removeEvent(events, (event) => event.type === "worker.result_accepted" && event.result_id === "result.1.canonical"),
  },
] as const;

describe("HACC-VMR-v1 event-sourced mission oracle", () => {
  it("matches the frozen 3x60 development protocol and passes all 180 opportunities", () => {
    const fixture = buildDevelopmentFixture();
    const score = scoreVoiceMission(fixture.scenario, fixture.events);
    const segmentAt = (index: number) => fixture.scenario.segments.find((segment) => index >= segment.starts_at_opportunity && index <= segment.ends_at_opportunity)?.id;

    expect(fixture.scenario.segments.map((segment) => segment.ends_at_opportunity - segment.starts_at_opportunity + 1)).toEqual([60, 60, 60]);
    expect(fixture.scenario.corrections).toHaveLength(12);
    expect(fixture.scenario.goal_detours).toHaveLength(6);
    expect(fixture.scenario.goal_detours.filter((detour) => segmentAt(detour.suspend_opportunity) !== segmentAt(detour.resume_opportunity)).length).toBeGreaterThanOrEqual(2);
    expect(fixture.scenario.async_windows).toHaveLength(12);
    expect(fixture.scenario.async_windows.filter((window) => window.accept_not_before_opportunity - window.spawn_opportunity >= 15)).toHaveLength(6);
    expect(fixture.scenario.async_windows.filter((window) => segmentAt(window.spawn_opportunity) !== segmentAt(window.accept_not_before_opportunity))).toHaveLength(3);
    expect(fixture.scenario.confirmation_probes).toHaveLength(6);
    expect(fixture.scenario.confirmation_probes.filter((probe) => probe.invalidated_by_correction_id)).toHaveLength(3);
    expect(fixture.scenario.worker_faults).toHaveLength(12);
    expect(fixture.scenario.opportunities.filter((opportunity) => opportunity.registered_probe === "recall")).toHaveLength(24);
    expect(fixture.scenario.opportunities.filter((opportunity) => opportunity.registered_probe === "audible_state")).toHaveLength(6);
    expect(score.replay.violations).toEqual([]);
    expect(score.strict_pass).toBe(true);
    expect(score.opportunities).toEqual({ total: 180, passed: 180, failed: 0, rate: 1, reliable_horizon: 180, first_failure_index: null });
  });

  it("is arm-blind by construction", () => {
    const fixture = buildDevelopmentFixture();
    expect(() => VoiceMissionScenarioSchema.parse({ ...fixture.scenario, arm: "harness" })).toThrow();
    expect(() => VoiceMissionEventLogSchema.parse([{ ...fixture.events[0], arm: "raw" }])).toThrow();
  });

  it("keeps the mutation registry exactly synchronized with every claimed violation class", () => {
    expect(new Set(MUTATIONS.map((mutation) => mutation.expected))).toEqual(new Set(VOICE_MISSION_VIOLATION_KINDS));
  });

  it.each(MUTATIONS)("detects $expected", ({ expected, mutate }) => {
    const fixture = buildDevelopmentFixture();
    const score = scoreVoiceMission(fixture.scenario, mutate(fixture));
    expect(score.replay.violations.map((violation) => violation.kind)).toContain(expected);
    expect(score.strict_pass).toBe(false);
    expect(score.opportunities.total).toBe(180);
  });
});
