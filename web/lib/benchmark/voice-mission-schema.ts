import { z } from "zod";

/**
 * HACC-VMR-v1 is an arm-blind contract for scoring durable voice missions.
 * Provider, model, and treatment labels intentionally have no representation
 * in either the scenario or event schema.
 */
export const VOICE_MISSION_PROTOCOL = "HACC-VMR-v1" as const;

const IdentifierSchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,95}$/);
const FactKeySchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);

export type VoiceMissionJson =
  | null
  | boolean
  | number
  | string
  | VoiceMissionJson[]
  | { [key: string]: VoiceMissionJson };

export const VoiceMissionJsonSchema: z.ZodType<VoiceMissionJson> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(4_096),
  z.array(VoiceMissionJsonSchema).max(256),
  z.record(z.string(), VoiceMissionJsonSchema),
]));

export const VoiceMissionFactRefSchema = z.object({
  key: FactKeySchema,
  version: z.number().int().positive(),
  value: VoiceMissionJsonSchema,
}).strict();

export type VoiceMissionFactRef = z.infer<typeof VoiceMissionFactRefSchema>;

const MissionSegmentSchema = z.object({
  id: IdentifierSchema,
  ordinal: z.number().int().positive(),
  session_id: IdentifierSchema,
  starts_at_opportunity: z.number().int().positive(),
  ends_at_opportunity: z.number().int().positive(),
}).strict().refine(
  (segment) => segment.starts_at_opportunity <= segment.ends_at_opportunity,
  "segment start must not exceed segment end"
);

const MissionFactSchema = z.object({
  key: FactKeySchema,
  initial_version: z.literal(1),
  initial_value: VoiceMissionJsonSchema,
}).strict();

const MissionCorrectionSchema = z.object({
  id: IdentifierSchema,
  at_opportunity: z.number().int().positive(),
  fact_key: FactKeySchema,
  from_version: z.number().int().positive(),
  to_version: z.number().int().positive(),
  corrected_value: VoiceMissionJsonSchema,
}).strict().refine(
  (correction) => correction.to_version === correction.from_version + 1,
  "corrections must advance a fact by exactly one version"
);

const WorkerFaultSchema = z.object({
  id: IdentifierSchema,
  worker_id: IdentifierSchema,
  generation: z.number().int().positive(),
  result_id: IdentifierSchema,
  at_opportunity: z.number().int().positive(),
  kind: z.enum([
    "failed_attempt",
    "late_delivery",
    "cancelled_delivery",
    "duplicate_delivery",
  ]),
}).strict();

const AsyncWindowSchema = z.object({
  worker_id: IdentifierSchema,
  generation: z.number().int().positive(),
  spawn_opportunity: z.number().int().positive(),
  accept_not_before_opportunity: z.number().int().positive(),
  accept_deadline_opportunity: z.number().int().positive(),
  expected_result_id: IdentifierSchema,
  required_for_goal_ids: z.array(IdentifierSchema).max(32).default([]),
}).strict().superRefine((window, ctx) => {
  if (window.spawn_opportunity > window.accept_not_before_opportunity) {
    ctx.addIssue({ code: "custom", message: "worker cannot become acceptable before it is spawned" });
  }
  if (window.accept_not_before_opportunity > window.accept_deadline_opportunity) {
    ctx.addIssue({ code: "custom", message: "worker acceptance window is inverted" });
  }
});

const GuardrailRuleSchema = z.object({
  id: IdentifierSchema,
  action: IdentifierSchema,
  earliest_opportunity: z.number().int().positive(),
  latest_opportunity: z.number().int().positive(),
  authorization_facts: z.array(VoiceMissionFactRefSchema).min(1).max(32),
}).strict().refine(
  (rule) => rule.earliest_opportunity <= rule.latest_opportunity,
  "guardrail authorization window is inverted"
);

const MissionGoalSchema = z.object({
  id: IdentifierSchema,
  required_action: IdentifierSchema,
  deadline_opportunity: z.number().int().positive(),
  required_facts: z.array(VoiceMissionFactRefSchema).max(32).default([]),
  required_worker_result_ids: z.array(IdentifierSchema).max(32).default([]),
}).strict();

const GoalDetourSchema = z.object({
  id: IdentifierSchema,
  goal_id: IdentifierSchema,
  suspend_opportunity: z.number().int().positive(),
  resume_opportunity: z.number().int().positive(),
}).strict().refine(
  (detour) => detour.suspend_opportunity < detour.resume_opportunity,
  "goal detour must resume after suspension"
);

const ConfirmationProbeSchema = z.object({
  id: IdentifierSchema,
  action: IdentifierSchema,
  proposal_id: IdentifierSchema,
  bind_opportunity: z.number().int().positive(),
  execution_opportunity: z.number().int().positive(),
  invalidated_by_correction_id: IdentifierSchema.optional(),
}).strict().refine(
  (probe) => probe.bind_opportunity < probe.execution_opportunity,
  "confirmation must bind before its consequential decision"
);

export const VoiceMissionOpportunityCategorySchema = z.enum([
  "resume",
  "audibility",
  "guardrail",
  "latest_fact",
  "goal",
  "async_worker",
]);

export type VoiceMissionOpportunityCategory = z.infer<typeof VoiceMissionOpportunityCategorySchema>;

const OpportunityAssertionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("resume"),
    transition: z.enum(["start", "resume"]),
    session_id: IdentifierSchema,
    required_facts: z.array(VoiceMissionFactRefSchema).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal("audible_claim"),
    claim_type: IdentifierSchema,
    required_facts: z.array(VoiceMissionFactRefSchema).max(32).default([]),
    terminal: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("guardrail_decision"),
    rule_id: IdentifierSchema,
    expected: z.enum(["execute", "block"]),
  }).strict(),
  z.object({
    kind: z.literal("latest_fact_recall"),
    required_facts: z.array(VoiceMissionFactRefSchema).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal("goal_completion"),
    goal_id: IdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("worker_resolution"),
    worker_id: IdentifierSchema,
    generation: z.number().int().positive(),
    result_id: IdentifierSchema,
    expected: z.enum(["accept", "reject"]),
  }).strict(),
]);

export const VoiceMissionOpportunitySchema = z.object({
  id: IdentifierSchema,
  index: z.number().int().positive(),
  segment_id: IdentifierSchema,
  category: VoiceMissionOpportunityCategorySchema,
  deadline_opportunity: z.number().int().positive(),
  description: z.string().min(1).max(512),
  registered_probe: z.enum(["recall", "audible_state"]).optional(),
  assertion: OpportunityAssertionSchema,
}).strict().superRefine((opportunity, ctx) => {
  const expectedCategory = {
    resume: "resume",
    audible_claim: "audibility",
    guardrail_decision: "guardrail",
    latest_fact_recall: "latest_fact",
    goal_completion: "goal",
    worker_resolution: "async_worker",
  }[opportunity.assertion.kind];
  if (opportunity.category !== expectedCategory) {
    ctx.addIssue({ code: "custom", path: ["category"], message: `${opportunity.assertion.kind} requires category ${expectedCategory}` });
  }
  if (opportunity.deadline_opportunity < opportunity.index) {
    ctx.addIssue({ code: "custom", path: ["deadline_opportunity"], message: "deadline precedes opportunity" });
  }
});

export const VoiceMissionScenarioSchema = z.object({
  protocol: z.literal(VOICE_MISSION_PROTOCOL),
  id: IdentifierSchema,
  version: z.string().min(1).max(64),
  description: z.string().min(1).max(1_024),
  total_opportunities: z.number().int().min(1).max(10_000),
  segments: z.array(MissionSegmentSchema).min(1).max(256),
  facts: z.array(MissionFactSchema).min(1).max(1_024),
  corrections: z.array(MissionCorrectionSchema).max(1_024).default([]),
  async_windows: z.array(AsyncWindowSchema).max(1_024).default([]),
  worker_faults: z.array(WorkerFaultSchema).max(1_024).default([]),
  guardrails: z.array(GuardrailRuleSchema).max(1_024).default([]),
  goals: z.array(MissionGoalSchema).min(1).max(1_024),
  goal_detours: z.array(GoalDetourSchema).default([]),
  confirmation_probes: z.array(ConfirmationProbeSchema).default([]),
  opportunities: z.array(VoiceMissionOpportunitySchema).min(1).max(10_000),
}).strict().superRefine((scenario, ctx) => {
  const unique = (values: readonly string[], path: string) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) ctx.addIssue({ code: "custom", path: [path, index], message: `duplicate identifier ${value}` });
      seen.add(value);
    });
  };
  unique(scenario.segments.map((item) => item.id), "segments");
  unique(scenario.segments.map((item) => item.session_id), "segments");
  unique(scenario.facts.map((item) => item.key), "facts");
  unique(scenario.corrections.map((item) => item.id), "corrections");
  unique(scenario.worker_faults.map((item) => item.id), "worker_faults");
  unique(scenario.guardrails.map((item) => item.id), "guardrails");
  unique(scenario.goals.map((item) => item.id), "goals");
  unique(scenario.goal_detours.map((item) => item.id), "goal_detours");
  unique(scenario.confirmation_probes.map((item) => item.id), "confirmation_probes");
  unique(scenario.opportunities.map((item) => item.id), "opportunities");

  const segments = [...scenario.segments].sort((a, b) => a.ordinal - b.ordinal);
  segments.forEach((segment, index) => {
    if (segment.ordinal !== index + 1) ctx.addIssue({ code: "custom", path: ["segments"], message: "segment ordinals must be contiguous" });
    const expectedStart = index === 0 ? 1 : segments[index - 1]!.ends_at_opportunity + 1;
    if (segment.starts_at_opportunity !== expectedStart) ctx.addIssue({ code: "custom", path: ["segments"], message: "segment opportunity ranges must be contiguous" });
  });
  if (segments.at(-1)?.ends_at_opportunity !== scenario.total_opportunities) {
    ctx.addIssue({ code: "custom", path: ["segments"], message: "segments must cover the full mission horizon" });
  }

  const factKeys = new Set(scenario.facts.map((fact) => fact.key));
  const segmentIds = new Set(scenario.segments.map((segment) => segment.id));
  const sessionIds = new Set(scenario.segments.map((segment) => segment.session_id));
  const goalIds = new Set(scenario.goals.map((goal) => goal.id));
  const guardrailIds = new Set(scenario.guardrails.map((rule) => rule.id));
  const windows = new Set(scenario.async_windows.map((window) => `${window.worker_id}:${window.generation}:${window.expected_result_id}`));
  const faultResolutions = new Set(scenario.worker_faults.map((fault) => `${fault.worker_id}:${fault.generation}:${fault.result_id}`));
  const correctionVersion = new Map<string, number>(scenario.facts.map((fact) => [fact.key, fact.initial_version]));
  for (const correction of [...scenario.corrections].sort((a, b) => a.at_opportunity - b.at_opportunity)) {
    if (!factKeys.has(correction.fact_key)) ctx.addIssue({ code: "custom", path: ["corrections"], message: `correction references unknown fact ${correction.fact_key}` });
    if (correctionVersion.get(correction.fact_key) !== correction.from_version) ctx.addIssue({ code: "custom", path: ["corrections"], message: `correction chain is discontinuous for ${correction.fact_key}` });
    correctionVersion.set(correction.fact_key, correction.to_version);
  }
  const validateRefs = (refs: readonly VoiceMissionFactRef[], path: string) => refs.forEach((ref) => {
    if (!factKeys.has(ref.key)) ctx.addIssue({ code: "custom", path: [path], message: `unknown fact ${ref.key}` });
  });
  scenario.guardrails.forEach((rule) => validateRefs(rule.authorization_facts, "guardrails"));
  scenario.async_windows.forEach((window) => {
    if (window.accept_deadline_opportunity > scenario.total_opportunities) {
      ctx.addIssue({ code: "custom", path: ["async_windows"], message: `worker ${window.worker_id} exceeds the mission horizon` });
    }
    window.required_for_goal_ids.forEach((goalId) => {
      if (!goalIds.has(goalId)) ctx.addIssue({ code: "custom", path: ["async_windows"], message: `worker references unknown goal ${goalId}` });
    });
  });
  scenario.worker_faults.forEach((fault) => {
    if (fault.at_opportunity > scenario.total_opportunities) {
      ctx.addIssue({ code: "custom", path: ["worker_faults"], message: `fault ${fault.id} exceeds the mission horizon` });
    }
    if (![...scenario.async_windows].some((window) =>
      window.worker_id === fault.worker_id
      && window.generation === fault.generation
    )) {
      ctx.addIssue({ code: "custom", path: ["worker_faults"], message: `fault ${fault.id} has no contracted worker window` });
    }
  });
  scenario.guardrails.forEach((rule) => {
    if (rule.latest_opportunity > scenario.total_opportunities) {
      ctx.addIssue({ code: "custom", path: ["guardrails"], message: `guardrail ${rule.id} exceeds the mission horizon` });
    }
  });
  scenario.goals.forEach((goal) => {
    validateRefs(goal.required_facts, "goals");
    if (goal.deadline_opportunity > scenario.total_opportunities) {
      ctx.addIssue({ code: "custom", path: ["goals"], message: `goal ${goal.id} exceeds the mission horizon` });
    }
    goal.required_worker_result_ids.forEach((id) => {
      if (![...scenario.async_windows].some((window) => window.expected_result_id === id)) ctx.addIssue({ code: "custom", path: ["goals"], message: `goal references unknown worker result ${id}` });
    });
  });
  scenario.goal_detours.forEach((detour) => {
    if (!goalIds.has(detour.goal_id)) ctx.addIssue({ code: "custom", path: ["goal_detours"], message: `detour references unknown goal ${detour.goal_id}` });
    if (detour.resume_opportunity > scenario.total_opportunities) ctx.addIssue({ code: "custom", path: ["goal_detours"], message: `detour ${detour.id} exceeds the mission horizon` });
  });
  const correctionById = new Map(scenario.corrections.map((correction) => [correction.id, correction]));
  scenario.confirmation_probes.forEach((probe) => {
    const decision = scenario.opportunities[probe.execution_opportunity - 1];
    const decisionRuleId = decision?.assertion.kind === "guardrail_decision" ? decision.assertion.rule_id : undefined;
    const decisionRule = decisionRuleId
      ? scenario.guardrails.find((rule) => rule.id === decisionRuleId)
      : undefined;
    if (probe.execution_opportunity > scenario.total_opportunities
      || decisionRule?.action !== probe.action) {
      ctx.addIssue({ code: "custom", path: ["confirmation_probes"], message: `confirmation ${probe.id} is not bound to its consequential guardrail decision` });
    }
    if (probe.invalidated_by_correction_id) {
      const correction = correctionById.get(probe.invalidated_by_correction_id);
      if (!correction
        || correction.at_opportunity <= probe.bind_opportunity
        || correction.at_opportunity >= probe.execution_opportunity) {
        ctx.addIssue({ code: "custom", path: ["confirmation_probes"], message: `confirmation ${probe.id} has no intervening invalidating correction` });
      }
    }
  });
  scenario.opportunities.forEach((opportunity, index) => {
    if (opportunity.index !== index + 1) ctx.addIssue({ code: "custom", path: ["opportunities", index, "index"], message: "opportunity indices must be contiguous and ordered" });
    if (opportunity.deadline_opportunity > scenario.total_opportunities) ctx.addIssue({ code: "custom", path: ["opportunities", index, "deadline_opportunity"], message: "deadline exceeds the mission horizon" });
    if (!segmentIds.has(opportunity.segment_id)) ctx.addIssue({ code: "custom", path: ["opportunities", index, "segment_id"], message: "unknown segment" });
    const segment = scenario.segments.find((candidate) => candidate.id === opportunity.segment_id);
    if (segment && (opportunity.index < segment.starts_at_opportunity || opportunity.index > segment.ends_at_opportunity)) {
      ctx.addIssue({ code: "custom", path: ["opportunities", index], message: "opportunity is outside its segment" });
    }
    const assertion = opportunity.assertion;
    if ("required_facts" in assertion) validateRefs(assertion.required_facts, "opportunities");
    if (assertion.kind === "resume" && !sessionIds.has(assertion.session_id)) ctx.addIssue({ code: "custom", path: ["opportunities", index], message: "unknown session" });
    if (assertion.kind === "goal_completion" && !goalIds.has(assertion.goal_id)) ctx.addIssue({ code: "custom", path: ["opportunities", index], message: "unknown goal" });
    if (assertion.kind === "guardrail_decision" && !guardrailIds.has(assertion.rule_id)) ctx.addIssue({ code: "custom", path: ["opportunities", index], message: "unknown guardrail" });
    if (assertion.kind === "worker_resolution"
      && !windows.has(`${assertion.worker_id}:${assertion.generation}:${assertion.result_id}`)
      && !faultResolutions.has(`${assertion.worker_id}:${assertion.generation}:${assertion.result_id}`)) {
      ctx.addIssue({ code: "custom", path: ["opportunities", index], message: "unknown worker resolution" });
    }
  });
  if (scenario.opportunities.length !== scenario.total_opportunities) {
    ctx.addIssue({ code: "custom", path: ["opportunities"], message: "every horizon position must be a semantic opportunity" });
  }
  if (scenario.total_opportunities !== 180
    || scenario.segments.length !== 3
    || scenario.segments.some((segment) => segment.ends_at_opportunity - segment.starts_at_opportunity + 1 !== 60)) {
    ctx.addIssue({ code: "custom", message: "HACC-VMR-v1 requires exactly three 60-opportunity sessions" });
  }
  if (scenario.corrections.length !== 12) ctx.addIssue({ code: "custom", path: ["corrections"], message: "HACC-VMR-v1 requires 12 corrections" });
  if (scenario.goal_detours.length !== 6) ctx.addIssue({ code: "custom", path: ["goal_detours"], message: "HACC-VMR-v1 requires 6 goal detours" });
  const segmentAt = (index: number) => scenario.segments.find((segment) => index >= segment.starts_at_opportunity && index <= segment.ends_at_opportunity)?.id;
  if (scenario.goal_detours.filter((detour) => segmentAt(detour.suspend_opportunity) !== segmentAt(detour.resume_opportunity)).length < 2) {
    ctx.addIssue({ code: "custom", path: ["goal_detours"], message: "at least two goal detours must cross a session boundary" });
  }
  if (scenario.async_windows.length !== 12) ctx.addIssue({ code: "custom", path: ["async_windows"], message: "HACC-VMR-v1 requires 12 worker launches" });
  if (scenario.async_windows.filter((window) => window.accept_not_before_opportunity - window.spawn_opportunity >= 15).length !== 6) {
    ctx.addIssue({ code: "custom", path: ["async_windows"], message: "HACC-VMR-v1 requires exactly 6 long worker windows" });
  }
  if (scenario.async_windows.filter((window) => segmentAt(window.spawn_opportunity) !== segmentAt(window.accept_not_before_opportunity)).length !== 3) {
    ctx.addIssue({ code: "custom", path: ["async_windows"], message: "HACC-VMR-v1 requires exactly 3 cross-session worker results" });
  }
  if (scenario.confirmation_probes.length !== 6) ctx.addIssue({ code: "custom", path: ["confirmation_probes"], message: "HACC-VMR-v1 requires 6 confirmation probes" });
  if (scenario.confirmation_probes.filter((probe) => probe.invalidated_by_correction_id !== undefined).length < 3) {
    ctx.addIssue({ code: "custom", path: ["confirmation_probes"], message: "at least 3 confirmation probes require an intervening correction" });
  }
  if (scenario.worker_faults.length !== 12) ctx.addIssue({ code: "custom", path: ["worker_faults"], message: "HACC-VMR-v1 requires 12 registered fault sites" });
  if (scenario.opportunities.filter((opportunity) => opportunity.registered_probe === "recall").length !== 24) {
    ctx.addIssue({ code: "custom", path: ["opportunities"], message: "HACC-VMR-v1 requires 24 recall probes" });
  }
  if (scenario.opportunities.filter((opportunity) => opportunity.registered_probe === "audible_state").length !== 6) {
    ctx.addIssue({ code: "custom", path: ["opportunities"], message: "HACC-VMR-v1 requires 6 audible-state probes" });
  }
});

export type VoiceMissionScenario = z.infer<typeof VoiceMissionScenarioSchema>;
export type VoiceMissionOpportunity = z.infer<typeof VoiceMissionOpportunitySchema>;

const MissionEventBaseSchema = z.object({
  protocol: z.literal(VOICE_MISSION_PROTOCOL),
  sequence: z.number().int().positive(),
  opportunity_id: IdentifierSchema,
  opportunity_index: z.number().int().positive(),
  segment_id: IdentifierSchema,
}).strict();

const EventFactRefsSchema = z.array(VoiceMissionFactRefSchema).max(64).default([]);

export const VoiceMissionEventSchema = z.discriminatedUnion("type", [
  MissionEventBaseSchema.extend({
    type: z.literal("goal.focus_changed"),
    detour_id: IdentifierSchema,
    goal_id: IdentifierSchema,
    state: z.enum(["suspended", "resumed"]),
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("confirmation.bound"),
    confirmation_probe_id: IdentifierSchema,
    proposal_id: IdentifierSchema,
    fact_refs: EventFactRefsSchema,
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("session.transitioned"),
    session_id: IdentifierSchema,
    transition: z.enum(["start", "resume"]),
    recalled_facts: EventFactRefsSchema,
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("fact.corrected"),
    correction_id: IdentifierSchema,
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("memory.recalled"),
    recalled_facts: EventFactRefsSchema,
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("audible.claimed"),
    claim_id: IdentifierSchema,
    claim_type: IdentifierSchema,
    terminal: z.boolean(),
    fact_refs: EventFactRefsSchema,
    completed_goal_ids: z.array(IdentifierSchema).max(1_024).default([]),
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("action.executed"),
    action_id: IdentifierSchema,
    action: IdentifierSchema,
    receipt_id: IdentifierSchema,
    fact_refs: EventFactRefsSchema,
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("action.blocked"),
    action_id: IdentifierSchema,
    action: IdentifierSchema,
    rule_id: IdentifierSchema,
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("goal.completed"),
    goal_id: IdentifierSchema,
    action_receipt_id: IdentifierSchema,
    fact_refs: EventFactRefsSchema,
    worker_result_ids: z.array(IdentifierSchema).max(128).default([]),
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("worker.spawned"),
    worker_id: IdentifierSchema,
    generation: z.number().int().positive(),
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("worker.cancelled"),
    worker_id: IdentifierSchema,
    generation: z.number().int().positive(),
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("worker.result_emitted"),
    worker_id: IdentifierSchema,
    generation: z.number().int().positive(),
    result_id: IdentifierSchema,
    outcome: z.enum(["succeeded", "failed"]),
    fact_refs: EventFactRefsSchema,
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("worker.result_accepted"),
    worker_id: IdentifierSchema,
    generation: z.number().int().positive(),
    result_id: IdentifierSchema,
  }),
  MissionEventBaseSchema.extend({
    type: z.literal("worker.result_rejected"),
    worker_id: IdentifierSchema,
    generation: z.number().int().positive(),
    result_id: IdentifierSchema,
    reason: z.enum(["failed", "stale", "cancelled", "duplicate", "outside_window"]),
  }),
]);

export type VoiceMissionEvent = z.infer<typeof VoiceMissionEventSchema>;

export const VoiceMissionEventLogSchema = z.array(VoiceMissionEventSchema).max(100_000).superRefine((events, ctx) => {
  const seen = new Set<number>();
  events.forEach((event, index) => {
    if (seen.has(event.sequence)) ctx.addIssue({ code: "custom", path: [index, "sequence"], message: "duplicate event sequence" });
    seen.add(event.sequence);
    if (event.sequence !== index + 1) ctx.addIssue({ code: "custom", path: [index, "sequence"], message: "events must be contiguous and ordered" });
  });
});
