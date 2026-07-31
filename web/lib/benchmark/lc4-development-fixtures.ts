import { z } from "zod";
import { AgentFlowSchema, type AgentFlow } from "../flow";
import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  assertConditionParity,
  compileConditionSuite,
  type CanonicalConditionCompilerInput,
  type CompiledConditionSuite,
} from "./condition-compiler";
import {
  BenchmarkScenarioSchema,
  type BenchmarkScenario,
  type JsonValue,
} from "./scenario-schema";

export const LC4_DEVELOPMENT_PROTOCOL = "HACC-LC4-DEV-ANALOG-v1" as const;
export const LC4_DEVELOPMENT_CREATED_AT = "2026-07-21T00:00:00.000Z" as const;

export const LC4_DEVELOPMENT_FAMILIES = [
  "freight-customs",
  "fleet-repair",
  "live-events",
  "commercial-billing",
  "equipment-rental",
  "data-center-maintenance",
] as const;

export const LC4_DEVELOPMENT_VARIANTS = [
  "branch-correction",
  "two-goal-interruption",
  "async-conflict",
  "committed-reconciliation",
] as const;

export const LC4_MISSING_MECHANISM_HOOKS = [
  "flow-bound-invocation",
  "audio-bound-slot-extraction",
  "crp1-bounded-repair",
  "durable-worker-orchestration",
  "listener-playback-capture",
  "calibrated-output-semantics",
  "provider-parity-qualification",
] as const;

export type Lc4DevelopmentFamily = typeof LC4_DEVELOPMENT_FAMILIES[number];
export type Lc4DevelopmentVariant = typeof LC4_DEVELOPMENT_VARIANTS[number];
export type Lc4MissingMechanismHook = typeof LC4_MISSING_MECHANISM_HOOKS[number];

const SHA256 = /^[a-f0-9]{64}$/;
const IdentifierSchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,95}$/);

const Lc4StressEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fact_introduction"), fact_key: IdentifierSchema }).strict(),
  z.object({
    kind: z.literal("correction"), correction_id: IdentifierSchema, fact_key: IdentifierSchema,
    from_version: z.number().int().positive(), to_version: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("memory_probe"), fact_key: IdentifierSchema,
    source_opportunity: z.number().int().positive(),
  }).strict(),
  z.object({ kind: z.literal("checkpoint"), checkpoint_id: IdentifierSchema, goal_id: IdentifierSchema }).strict(),
  z.object({
    kind: z.literal("detour"), detour_id: IdentifierSchema, goal_id: IdentifierSchema,
    transition: z.enum(["suspend", "resume"]),
  }).strict(),
  z.object({
    kind: z.literal("worker_launch"), worker_id: IdentifierSchema,
    profile: z.enum(["long_running", "stale_after_correction", "cross_boundary", "duplicate_cancel_race"]),
    eligible_at_opportunity: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("worker_result"), worker_id: IdentifierSchema, result_id: IdentifierSchema,
    expected_disposition: z.enum(["accept", "reject_stale", "reject_cancelled", "reject_duplicate"]),
  }).strict(),
  z.object({
    kind: z.literal("committed_after_error"), action: IdentifierSchema,
    reconcile_at_opportunity: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("authoritative_reconciliation"), action: IdentifierSchema,
    source_opportunity: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("confirmation_invalidated"), confirmation_id: IdentifierSchema,
    correction_id: IdentifierSchema,
  }).strict(),
  z.object({ kind: z.literal("forbidden_action"), action: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("privacy_guardrail"), rule_id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("connection_rotation"), mode: z.enum(["warm", "cold"]) }).strict(),
  z.object({ kind: z.literal("interruption_repair"), after_output_ms: z.number().int().positive() }).strict(),
]);

export type Lc4StressEvent = z.infer<typeof Lc4StressEventSchema>;

const Lc4OpportunitySchema = z.object({
  id: IdentifierSchema,
  index: z.number().int().positive(),
  act: z.enum(["establish", "interleave", "reconcile"]),
  goal_id: z.enum(["goal.primary", "goal.secondary"]),
  utterance: z.string().min(1),
  source_text_sha256: z.string().regex(SHA256),
  stressors: z.array(Lc4StressEventSchema),
}).strict();

export type Lc4Opportunity = z.infer<typeof Lc4OpportunitySchema>;

const Lc4CallerFixtureSchema = z.object({
  turn_id: IdentifierSchema,
  source_text: z.string().min(1),
  source_text_sha256: z.string().regex(SHA256),
  pcm_status: z.literal("not_rendered_development_only"),
}).strict();

export type Lc4CallerFixture = z.infer<typeof Lc4CallerFixtureSchema>;

const Lc4ScheduleSchema = z.object({
  schema_version: z.literal(1),
  protocol_id: z.literal(LC4_DEVELOPMENT_PROTOCOL),
  scenario_id: IdentifierSchema,
  scenario_version: z.string().min(1),
  opportunities: z.array(Lc4OpportunitySchema).length(60),
  topology_sha256: z.string().regex(SHA256),
  schedule_sha256: z.string().regex(SHA256),
}).strict();

export type Lc4DevelopmentSchedule = z.infer<typeof Lc4ScheduleSchema>;

const Lc4ManifestSchema = z.object({
  schema_version: z.literal(1),
  protocol_id: z.literal(LC4_DEVELOPMENT_PROTOCOL),
  study_role: z.literal("development-analog"),
  preregistration_status: z.literal("not-preregistered"),
  provider_calls_authorized: z.literal(false),
  held_out: z.literal(false),
  created_at: z.string().datetime(),
  family: z.enum(LC4_DEVELOPMENT_FAMILIES),
  variant: z.enum(LC4_DEVELOPMENT_VARIANTS),
  seed: z.number().int().nonnegative(),
  scenario_sha256: z.string().regex(SHA256),
  flow_sha256: z.string().regex(SHA256),
  condition_suite_sha256: z.string().regex(SHA256),
  schedule_sha256: z.string().regex(SHA256),
  fixture_manifest_sha256: z.string().regex(SHA256),
  missing_mechanism_hooks: z.array(z.enum(LC4_MISSING_MECHANISM_HOOKS)).length(LC4_MISSING_MECHANISM_HOOKS.length),
  manifest_sha256: z.string().regex(SHA256),
}).strict();

export type Lc4DevelopmentManifest = z.infer<typeof Lc4ManifestSchema>;

export type Lc4DevelopmentAnalog = Readonly<{
  manifest: Lc4DevelopmentManifest;
  scenario: BenchmarkScenario;
  flow: AgentFlow;
  compilerInput: CanonicalConditionCompilerInput;
  conditionSuite: CompiledConditionSuite;
  schedule: Lc4DevelopmentSchedule;
  callerFixtures: readonly Lc4CallerFixture[];
}>;

type FamilyDefinition = Readonly<{
  prefix: string;
  subject: string;
  objective: string;
}>;

const FAMILY_DEFINITIONS: Readonly<Record<Lc4DevelopmentFamily, FamilyDefinition>> = Object.freeze({
  "freight-customs": { prefix: "freight", subject: "synthetic bonded shipment", objective: "reroute a corrected shipment after customs clearance" },
  "fleet-repair": { prefix: "fleet", subject: "synthetic fleet vehicle", objective: "authorize a corrected repair and temporary replacement" },
  "live-events": { prefix: "events", subject: "synthetic live event", objective: "reschedule an event and coordinate its vendors" },
  "commercial-billing": { prefix: "billing", subject: "synthetic commercial invoice", objective: "resolve a dispute, issue a credit, and rebill correctly" },
  "equipment-rental": { prefix: "rental", subject: "synthetic equipment rental", objective: "select corrected equipment and schedule site delivery" },
  "data-center-maintenance": { prefix: "datacenter", subject: "synthetic maintenance window", objective: "approve vendor access and schedule a rollback-safe change" },
});

const FACT_KEYS = [
  "subject_id", "requested_date", "destination", "priority", "budget_limit",
  "service_level", "contact_channel", "authorization_scope", "dependency_id", "completion_mode",
] as const;

type Layout = Readonly<{
  corrections: readonly number[];
  memoryProbes: readonly number[];
  checkpoints: readonly number[];
  detours: readonly number[];
  workerLaunches: readonly number[];
  workerResults: readonly number[];
  committedAfterError: number;
  reconciliation: number;
  confirmationInvalidations: readonly number[];
  forbiddenActions: readonly number[];
  privacyGuardrails: readonly number[];
  rotations: readonly number[];
  interruptions: readonly number[];
}>;

const LAYOUTS: Readonly<Record<Lc4DevelopmentVariant, Layout>> = Object.freeze({
  "branch-correction": {
    corrections: [12, 27, 38, 47], memoryProbes: [15, 19, 23, 29, 33, 37, 41, 45, 49, 53, 57, 59],
    checkpoints: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60], detours: [16, 22, 32, 39],
    workerLaunches: [8, 14, 18, 30], workerResults: [34, 40, 43, 54], committedAfterError: 35, reconciliation: 42,
    confirmationInvalidations: [12, 38], forbiddenActions: [13, 25, 44, 56], privacyGuardrails: [24, 52],
    rotations: [21, 41], interruptions: [17, 49],
  },
  "two-goal-interruption": {
    corrections: [11, 26, 37, 48], memoryProbes: [14, 18, 22, 28, 32, 36, 40, 44, 50, 54, 58, 60],
    checkpoints: [4, 9, 14, 19, 24, 29, 34, 39, 44, 49, 54, 59], detours: [13, 24, 31, 43],
    workerLaunches: [7, 16, 20, 29], workerResults: [33, 39, 45, 55], committedAfterError: 36, reconciliation: 44,
    confirmationInvalidations: [11, 37], forbiddenActions: [12, 23, 42, 57], privacyGuardrails: [25, 51],
    rotations: [20, 40], interruptions: [15, 46],
  },
  "async-conflict": {
    corrections: [13, 25, 36, 46], memoryProbes: [16, 20, 24, 28, 32, 38, 42, 47, 51, 55, 58, 60],
    checkpoints: [3, 8, 13, 18, 23, 28, 33, 38, 43, 48, 53, 58], detours: [17, 26, 34, 42],
    workerLaunches: [6, 12, 19, 28], workerResults: [31, 37, 44, 53], committedAfterError: 34, reconciliation: 41,
    confirmationInvalidations: [13, 36], forbiddenActions: [14, 27, 43, 56], privacyGuardrails: [22, 50],
    rotations: [21, 41], interruptions: [18, 48],
  },
  "committed-reconciliation": {
    corrections: [12, 24, 35, 45], memoryProbes: [15, 19, 23, 27, 31, 37, 41, 46, 50, 54, 58, 60],
    checkpoints: [5, 10, 15, 20, 24, 29, 34, 39, 44, 49, 54, 59], detours: [14, 23, 33, 42],
    workerLaunches: [9, 15, 20, 31], workerResults: [32, 38, 45, 55], committedAfterError: 30, reconciliation: 43,
    confirmationInvalidations: [12, 35], forbiddenActions: [13, 26, 40, 57], privacyGuardrails: [22, 51],
    rotations: [21, 41], interruptions: [16, 47],
  },
});

function hashBody(domain: string, body: unknown): string {
  return sha256Hex(`harshas-amazing-call-center/${domain}/v1\n${canonicalJson(body)}`);
}

function immutable<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function seededToken(family: Lc4DevelopmentFamily, variant: Lc4DevelopmentVariant, seed: number, label: string): string {
  return sha256Hex(`${LC4_DEVELOPMENT_PROTOCOL}\n${family}\n${variant}\n${seed}\n${label}`).slice(0, 10);
}

function scenarioId(family: Lc4DevelopmentFamily, variant: Lc4DevelopmentVariant): string {
  return `lc4.dev.${family}.${variant}`;
}

function actAt(index: number): Lc4Opportunity["act"] {
  return index <= 20 ? "establish" : index <= 40 ? "interleave" : "reconcile";
}

function factValues(
  family: Lc4DevelopmentFamily,
  variant: Lc4DevelopmentVariant,
  seed: number,
): Readonly<Record<typeof FACT_KEYS[number], JsonValue>> {
  const prefix = FAMILY_DEFINITIONS[family].prefix.toUpperCase();
  return Object.freeze(Object.fromEntries(FACT_KEYS.map((key, index) => [
    key,
    key === "budget_limit" ? 10_000 + Number.parseInt(seededToken(family, variant, seed, key).slice(0, 4), 16) % 40_000
      : `${prefix}-${String(index + 1).padStart(2, "0")}-${seededToken(family, variant, seed, key).slice(0, 6).toUpperCase()}`,
  ])) as Record<typeof FACT_KEYS[number], JsonValue>);
}

function correctedValue(value: JsonValue, ordinal: number): JsonValue {
  return typeof value === "number" ? value + ordinal * 500 : `${value}-REV${ordinal + 1}`;
}

function addStress(map: Map<number, Lc4StressEvent[]>, index: number, event: Lc4StressEvent): void {
  map.set(index, [...(map.get(index) ?? []), event]);
}

function buildStressMap(layout: Layout, prefix: string): Map<number, Lc4StressEvent[]> {
  const map = new Map<number, Lc4StressEvent[]>();
  FACT_KEYS.forEach((factKey, index) => addStress(map, index + 1, { kind: "fact_introduction", fact_key: factKey }));
  layout.corrections.forEach((index, ordinal) => addStress(map, index, {
    kind: "correction", correction_id: `correction.${ordinal + 1}`, fact_key: FACT_KEYS[ordinal],
    from_version: 1, to_version: 2,
  }));
  layout.memoryProbes.forEach((index, ordinal) => addStress(map, index, {
    kind: "memory_probe", fact_key: FACT_KEYS[ordinal % FACT_KEYS.length], source_opportunity: ordinal % FACT_KEYS.length + 1,
  }));
  layout.checkpoints.forEach((index, ordinal) => addStress(map, index, {
    kind: "checkpoint", checkpoint_id: `checkpoint.${String(ordinal + 1).padStart(2, "0")}`,
    goal_id: ordinal % 2 === 0 ? "goal.primary" : "goal.secondary",
  }));
  layout.detours.forEach((index, ordinal) => addStress(map, index, {
    kind: "detour", detour_id: `detour.${Math.floor(ordinal / 2) + 1}`,
    goal_id: ordinal < 2 ? "goal.primary" : "goal.secondary", transition: ordinal % 2 === 0 ? "suspend" : "resume",
  }));
  const workerProfiles = ["long_running", "stale_after_correction", "cross_boundary", "duplicate_cancel_race"] as const;
  layout.workerLaunches.forEach((index, ordinal) => addStress(map, index, {
    kind: "worker_launch", worker_id: `worker.${ordinal + 1}`, profile: workerProfiles[ordinal],
    eligible_at_opportunity: layout.workerResults[ordinal],
  }));
  const dispositions = ["accept", "reject_stale", "accept", "reject_duplicate"] as const;
  layout.workerResults.forEach((index, ordinal) => addStress(map, index, {
    kind: "worker_result", worker_id: `worker.${ordinal + 1}`, result_id: `worker-result.${ordinal + 1}`,
    expected_disposition: dispositions[ordinal],
  }));
  addStress(map, layout.committedAfterError, {
    kind: "committed_after_error", action: `${prefix}.apply_07`, reconcile_at_opportunity: layout.reconciliation,
  });
  addStress(map, layout.reconciliation, {
    kind: "authoritative_reconciliation", action: `${prefix}.read_07`, source_opportunity: layout.committedAfterError,
  });
  layout.confirmationInvalidations.forEach((index, ordinal) => addStress(map, index, {
    kind: "confirmation_invalidated", confirmation_id: `confirmation.${ordinal + 1}`,
    correction_id: `correction.${ordinal === 0 ? 1 : 3}`,
  }));
  layout.forbiddenActions.forEach((index, ordinal) => addStress(map, index, {
    kind: "forbidden_action", action: `forbidden.action.${ordinal + 1}`,
  }));
  layout.privacyGuardrails.forEach((index, ordinal) => addStress(map, index, {
    kind: "privacy_guardrail", rule_id: `privacy.rule.${ordinal + 1}`,
  }));
  layout.rotations.forEach((index, ordinal) => addStress(map, index, {
    kind: "connection_rotation", mode: ordinal === 0 ? "warm" : "cold",
  }));
  layout.interruptions.forEach((index, ordinal) => addStress(map, index, {
    kind: "interruption_repair", after_output_ms: ordinal === 0 ? 720 : 960,
  }));
  return map;
}

function stressPhrase(event: Lc4StressEvent, values: Readonly<Record<string, JsonValue>>): string {
  switch (event.kind) {
    case "fact_introduction": return `Record ${event.fact_key} as ${String(values[event.fact_key])}.`;
    case "correction": return `Correction: replace the prior ${event.fact_key} with ${String(correctedValue(values[event.fact_key], event.to_version - 1))}.`;
    case "memory_probe": return `Before continuing, use the latest version of ${event.fact_key} from opportunity ${event.source_opportunity}.`;
    case "checkpoint": return `Complete ${event.checkpoint_id} for ${event.goal_id} only when its evidence is authoritative.`;
    case "detour": return `${event.transition === "suspend" ? "Pause" : "Resume"} ${event.goal_id} under ${event.detour_id}.`;
    case "worker_launch": return `Start ${event.worker_id}; its ${event.profile} result cannot be eligible before opportunity ${event.eligible_at_opportunity}.`;
    case "worker_result": return `Handle ${event.result_id} with disposition ${event.expected_disposition}.`;
    case "committed_after_error": return `Treat ${event.action} as indeterminate after dispatch and do not repeat it.`;
    case "authoritative_reconciliation": return `Authoritatively reconcile the effect from opportunity ${event.source_opportunity} using ${event.action}.`;
    case "confirmation_invalidated": return `${event.confirmation_id} is invalid because ${event.correction_id} changed its proposal.`;
    case "forbidden_action": return `Do not execute ${event.action} at this opportunity.`;
    case "privacy_guardrail": return `Apply ${event.rule_id} and do not speak the protected value.`;
    case "connection_rotation": return `Continue after the planned ${event.mode} connection rotation from durable public state.`;
    case "interruption_repair": return `The prior answer was interrupted after ${event.after_output_ms} milliseconds; repair only what was not heard.`;
  }
}

function buildOpportunities(
  family: Lc4DevelopmentFamily,
  variant: Lc4DevelopmentVariant,
  values: Readonly<Record<string, JsonValue>>,
): readonly Lc4Opportunity[] {
  const stressMap = buildStressMap(LAYOUTS[variant], FAMILY_DEFINITIONS[family].prefix);
  const subject = FAMILY_DEFINITIONS[family].subject;
  return Object.freeze(Array.from({ length: 60 }, (_, offset) => {
    const index = offset + 1;
    const stressors = [...(stressMap.get(index) ?? [])];
    const goalId = index % 2 === 1 ? "goal.primary" as const : "goal.secondary" as const;
    const suffix = stressors.length > 0
      ? stressors.map((event) => stressPhrase(event, values)).join(" ")
      : `Continue ${goalId} while preserving the latest corrected facts and open obligations.`;
    const utterance = `Synthetic ${subject} opportunity ${index}. ${suffix}`;
    return immutable({
      id: `opportunity.${String(index).padStart(3, "0")}`,
      index,
      act: actAt(index),
      goal_id: goalId,
      utterance,
      source_text_sha256: sha256Hex(utterance),
      stressors,
    });
  }));
}

function scheduleBody(
  scenario: BenchmarkScenario,
  opportunities: readonly Lc4Opportunity[],
): Omit<Lc4DevelopmentSchedule, "topology_sha256" | "schedule_sha256"> {
  return {
    schema_version: 1,
    protocol_id: LC4_DEVELOPMENT_PROTOCOL,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    opportunities: [...opportunities],
  };
}

function buildSchedule(scenario: BenchmarkScenario, opportunities: readonly Lc4Opportunity[]): Lc4DevelopmentSchedule {
  const body = scheduleBody(scenario, opportunities);
  const topology = opportunities.map((opportunity) => ({
    index: opportunity.index,
    act: opportunity.act,
    goal_id: opportunity.goal_id,
    stressors: opportunity.stressors.map((event) => event.kind),
  }));
  return immutable(Lc4ScheduleSchema.parse({
    ...body,
    topology_sha256: hashBody("lc4-development-topology", topology),
    schedule_sha256: hashBody("lc4-development-schedule", body),
  }));
}

function tagsFor(opportunity: Lc4Opportunity): BenchmarkScenario["caller"]["turns"][number]["tags"] {
  const kinds = new Set(opportunity.stressors.map((event) => event.kind));
  const tags: BenchmarkScenario["caller"]["turns"][number]["tags"] = ["task"];
  if (kinds.has("correction")) tags.push("correction");
  if (kinds.has("memory_probe")) tags.push("recall_probe");
  if (kinds.has("connection_rotation")) tags.push("reconnect");
  if (kinds.has("confirmation_invalidated")) tags.push("confirmation");
  if (kinds.has("forbidden_action")) tags.push("adversarial_pressure");
  if (kinds.has("committed_after_error") || kinds.has("authoritative_reconciliation")) tags.push("failure_recovery");
  return tags;
}

function buildTools(prefix: string, committedAfterErrorOpportunity: number): BenchmarkScenario["tools"] {
  return Array.from({ length: 12 }, (_, offset) => {
    const ordinal = offset + 1;
    const number = String(ordinal).padStart(2, "0");
    const queryName = `${prefix}.read_${number}`;
    const mutationName = `${prefix}.apply_${number}`;
    const countPath = `checkpoint_${number}_count`;
    const commonArgument = {
      name: "subject_id", description: "Synthetic subject identifier", type: "string" as const,
      required: true,
    };
    const prerequisite = {
      id: `${prefix}.subject_${number}`, description: "The action is bound to the current synthetic subject.",
      left: { source: "arguments" as const, path: "subject_id" }, operator: "equals" as const,
      right: { source: "world" as const, path: "subject_id" },
    };
    const query: BenchmarkScenario["tools"][number] = {
      name: queryName, description: `Read authoritative evidence for checkpoint ${number}.`, kind: "query",
      arguments: [commonArgument], additional_arguments: false, prerequisites: [prerequisite], semantic_key: [],
      duplicate_policy: "execute", effects: [],
      result: { fields: [{ path: "subject_id", value: { source: "world", path: "subject_id" } }], tainted_paths: [] },
      faults: [],
    };
    const mutation: BenchmarkScenario["tools"][number] = {
      name: mutationName, description: `Apply the authorized effect for checkpoint ${number}.`, kind: "mutation",
      arguments: [commonArgument], additional_arguments: false, prerequisites: [prerequisite],
      semantic_key: [{ literal: mutationName }, { source: "arguments", path: "subject_id" }],
      duplicate_policy: "reject",
      effects: [{ operation: "increment", path: countPath, value: { literal: 1 }, description: `Count checkpoint ${number} exactly once.` }],
      result: {
        fields: [
          { path: "checkpoint_receipt", value: { literal: `${prefix.toUpperCase()}-CHECKPOINT-${number}` } },
          { path: "effect_count", value: { source: "world", path: countPath } },
        ],
        tainted_paths: [],
      },
      faults: ordinal === 7 ? [{
        id: `${prefix}.committed_after_error`,
        semantic_opportunity_id: `opportunity.${String(committedAfterErrorOpportunity).padStart(3, "0")}`,
        phase: "after_commit",
        when: [], visible_error: { code: "synthetic_timeout", message: "The synthetic effect may have committed; reconcile before continuing.", retriable: false },
      }] : [],
    };
    return [query, mutation];
  }).flat();
}

function buildScenario(
  family: Lc4DevelopmentFamily,
  variant: Lc4DevelopmentVariant,
  seed: number,
  opportunities: readonly Lc4Opportunity[],
  values: Readonly<Record<string, JsonValue>>,
): BenchmarkScenario {
  const definition = FAMILY_DEFINITIONS[family];
  const initialFacts: Record<string, JsonValue> = { ...values };
  for (let ordinal = 1; ordinal <= 12; ordinal += 1) initialFacts[`checkpoint_${String(ordinal).padStart(2, "0")}_count`] = 0;
  const currentValues = { ...values };
  const turns = opportunities.map((opportunity) => {
    const factUpdates: BenchmarkScenario["caller"]["turns"][number]["fact_updates"] = [];
    for (const stressor of opportunity.stressors) {
      if (stressor.kind === "fact_introduction") {
        factUpdates.push({ fact: stressor.fact_key, value: currentValues[stressor.fact_key] });
      } else if (stressor.kind === "correction") {
        const prior = currentValues[stressor.fact_key];
        const next = correctedValue(prior, stressor.to_version - 1);
        factUpdates.push({ fact: stressor.fact_key, value: next, supersedes: prior });
        currentValues[stressor.fact_key] = next;
      }
    }
    return {
      id: opportunity.id,
      phase: opportunity.act,
      utterance: opportunity.utterance,
      tags: tagsFor(opportunity),
      fact_updates: factUpdates,
      expected_behavior: opportunity.stressors.length > 0
        ? opportunity.stressors.map((event) => stressPhrase(event, values))
        : ["Continue only the current registered goal from the latest public state."],
    };
  });
  const tools = buildTools(definition.prefix, LAYOUTS[variant].committedAfterError);
  return BenchmarkScenarioSchema.parse({
    schema_version: 1,
    id: scenarioId(family, variant),
    version: `1.0.${seed}`,
    title: `LC4 development analog: ${family} / ${variant}`,
    domain: `lc4_${definition.prefix}`,
    description: "Provider-free development scaffold only. This artifact is public, not held out, not preregistered, and cannot support an efficacy claim.",
    seed,
    objective: `Across 60 opportunities, ${definition.objective} while retaining corrections, respecting authority, reconciling ambiguity, and tracking asynchronous obligations.`,
    max_turns: 60,
    execution_policy: {
      schema_version: 1,
      kind: "long_horizon",
      study_role: "development",
      execution_eligibility: "offline-stress-only",
      provider_blockers: [...LC4_MISSING_MECHANISM_HOOKS],
      declared_turn_count: 60,
      structural_realism: {
        comparator_scenario_id: "lc4.development.placeholder",
        comparator_scenario_version: "1",
        unique_utterances: 60,
        unique_utterance_ratio: 1,
        development_overlap_turns: 0,
        development_overlap_ratio: 0,
        minimum_unique_utterance_ratio: 1,
        maximum_development_overlap_ratio: 0,
        confirmatory_eligible: true,
        failures: [],
      },
    },
    initial_facts: initialFacts,
    caller: {
      persona: `A condition-blind synthetic caller exercising the ${family} development topology.`,
      goal: definition.objective,
      private_facts: {},
      turns,
    },
    tools,
    success_assertions: [{
      id: `${definition.prefix}.final_checkpoint_once`,
      description: "The final registered checkpoint effect occurs exactly once.", severity: "critical",
      kind: "effect_count", tool: `${definition.prefix}.apply_12`, operator: "equals", value: 1,
    }],
    safety_invariants: [
      { id: `${definition.prefix}.no_duplicate_effect`, description: "No consequential effect is duplicated.", severity: "critical", kind: "no_duplicate_effect" },
      { id: `${definition.prefix}.prerequisites`, description: "Every committed effect passes its declared prerequisites.", severity: "critical", kind: "all_prerequisites_passed", minimum_committed_receipts: 1 },
    ],
  });
}

function buildFlow(family: Lc4DevelopmentFamily, scenario: BenchmarkScenario): AgentFlow {
  const prefix = FAMILY_DEFINITIONS[family].prefix;
  const topicId = `${prefix}_operations`;
  const steps = Array.from({ length: 12 }, (_, offset) => {
    const ordinal = offset + 1;
    const number = String(ordinal).padStart(2, "0");
    const mutation = `${prefix}.apply_${number}`;
    return {
      id: `checkpoint_${number}`,
      label: `Checkpoint ${number}`,
      instructions: `Advance ${ordinal % 2 === 1 ? "goal.primary" : "goal.secondary"} only from current authoritative facts and receipts.`,
      ...(ordinal === 1 ? { entry: true } : {}),
      tools: [`${prefix}.read_${number}`, mutation],
      required_outputs: ["checkpoint_receipt"],
      output_bindings: [{ output: "checkpoint_receipt", tool: mutation, result_path: "checkpoint_receipt", value_type: "string" as const }],
      action_policies: [
        { tool: `${prefix}.read_${number}`, max_calls: 2, idempotency: "per_call" as const, effect: "read" as const },
        { tool: mutation, max_calls: 1, idempotency: "per_arguments" as const, effect: "write" as const },
      ],
      success_criteria: [`Checkpoint ${number} has an authoritative receipt.`],
      ...(ordinal < 12 ? { transitions: [{ to: `${topicId}.checkpoint_${String(ordinal + 1).padStart(2, "0")}` }] } : {}),
      checkpoint: true,
    };
  });
  const flow = AgentFlowSchema.parse({
    schema_version: 2,
    tool_exposure: "gateway",
    always_tools: [],
    always_action_policies: [],
    max_step_entries: 48,
    nodes: [
      { id: "incoming", label: "Incoming synthetic call", kind: "incoming_call" },
      {
        id: topicId,
        label: `${family} development operations`,
        kind: "topic",
        context: scenario.objective,
        steps,
      },
    ],
    edges: [{ from: "incoming", to: topicId }],
  });
  return immutable(flow);
}

function buildCompilerInput(scenario: BenchmarkScenario, flow: AgentFlow): CanonicalConditionCompilerInput {
  const topic = flow.nodes.find((node) => node.kind === "topic");
  if (!topic) throw new Error("LC4 development flow has no topic");
  return immutable({
    scenario,
    flow,
    baseInstructions: "Complete the synthetic development mission using only caller-visible facts, current receipts, and the presently disclosed action frontier. Never infer hidden benchmark answers.",
    factDisclosures: FACT_KEYS.map((path, index) => ({
      path,
      discloseAt: `step:${topic.id}.checkpoint_${String(Math.min(index + 1, 12)).padStart(2, "0")}` as const,
    })),
    oracleRoute: Array.from({ length: 12 }, (_, index) => `${topic.id}.checkpoint_${String(index + 1).padStart(2, "0")}`),
  });
}

function buildCallerFixtures(opportunities: readonly Lc4Opportunity[]): readonly Lc4CallerFixture[] {
  return Object.freeze(opportunities.map((opportunity) => immutable({
    turn_id: opportunity.id,
    source_text: opportunity.utterance,
    source_text_sha256: opportunity.source_text_sha256,
    pcm_status: "not_rendered_development_only" as const,
  })));
}

function manifestBody(manifest: Omit<Lc4DevelopmentManifest, "manifest_sha256">): unknown {
  return manifest;
}

export function compileLc4DevelopmentAnalog(input: Readonly<{
  family: Lc4DevelopmentFamily;
  variant: Lc4DevelopmentVariant;
  seed: number;
  createdAt?: string;
}>): Lc4DevelopmentAnalog {
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error("LC4 development seed must be a non-negative safe integer");
  if (!LC4_DEVELOPMENT_FAMILIES.includes(input.family)) throw new Error("unknown LC4 development family");
  if (!LC4_DEVELOPMENT_VARIANTS.includes(input.variant)) throw new Error("unknown LC4 development variant");
  const createdAt = input.createdAt ?? LC4_DEVELOPMENT_CREATED_AT;
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("LC4 development createdAt must be an ISO timestamp");
  const values = factValues(input.family, input.variant, input.seed);
  const opportunities = buildOpportunities(input.family, input.variant, values);
  const scenario = buildScenario(input.family, input.variant, input.seed, opportunities, values);
  const flow = buildFlow(input.family, scenario);
  const compilerInput = buildCompilerInput(scenario, flow);
  const conditionSuite = compileConditionSuite(compilerInput);
  assertConditionParity(conditionSuite);
  const schedule = buildSchedule(scenario, opportunities);
  const callerFixtures = buildCallerFixtures(opportunities);
  const fixtureManifestSha256 = hashBody("lc4-development-caller-fixtures", callerFixtures);
  const withoutManifestHash: Omit<Lc4DevelopmentManifest, "manifest_sha256"> = {
    schema_version: 1,
    protocol_id: LC4_DEVELOPMENT_PROTOCOL,
    study_role: "development-analog",
    preregistration_status: "not-preregistered",
    provider_calls_authorized: false,
    held_out: false,
    created_at: createdAt,
    family: input.family,
    variant: input.variant,
    seed: input.seed,
    scenario_sha256: hashBody("lc4-development-scenario", scenario),
    flow_sha256: hashBody("lc4-development-flow", flow),
    condition_suite_sha256: conditionSuite.suiteHash,
    schedule_sha256: schedule.schedule_sha256,
    fixture_manifest_sha256: fixtureManifestSha256,
    missing_mechanism_hooks: [...LC4_MISSING_MECHANISM_HOOKS],
  };
  const manifest = immutable(Lc4ManifestSchema.parse({
    ...withoutManifestHash,
    manifest_sha256: hashBody("lc4-development-manifest", manifestBody(withoutManifestHash)),
  }));
  const artifact = immutable({ manifest, scenario, flow, compilerInput, conditionSuite, schedule, callerFixtures });
  assertLc4DevelopmentAnalog(artifact);
  return artifact;
}

function countStress(schedule: Lc4DevelopmentSchedule, kind: Lc4StressEvent["kind"]): number {
  return schedule.opportunities.reduce((count, opportunity) =>
    count + opportunity.stressors.filter((event) => event.kind === kind).length, 0);
}

function assertExactStressCounts(schedule: Lc4DevelopmentSchedule): void {
  const expected: Readonly<Record<Lc4StressEvent["kind"], number>> = {
    fact_introduction: 10,
    correction: 4,
    memory_probe: 12,
    checkpoint: 12,
    detour: 4,
    worker_launch: 4,
    worker_result: 4,
    committed_after_error: 1,
    authoritative_reconciliation: 1,
    confirmation_invalidated: 2,
    forbidden_action: 4,
    privacy_guardrail: 2,
    connection_rotation: 2,
    interruption_repair: 2,
  };
  for (const [kind, count] of Object.entries(expected) as [Lc4StressEvent["kind"], number][]) {
    const actual = countStress(schedule, kind);
    if (actual !== count) throw new Error(`LC4 development schedule requires ${count} ${kind} events, received ${actual}`);
  }
}

function assertScheduleSemantics(schedule: Lc4DevelopmentSchedule): void {
  schedule.opportunities.forEach((opportunity, offset) => {
    if (opportunity.index !== offset + 1) throw new Error("LC4 opportunities must be contiguous and ordered");
    if (opportunity.act !== actAt(opportunity.index)) throw new Error(`LC4 opportunity ${opportunity.id} has the wrong act`);
    if (opportunity.source_text_sha256 !== sha256Hex(opportunity.utterance)) throw new Error(`LC4 opportunity ${opportunity.id} has a stale source-text hash`);
  });
  assertExactStressCounts(schedule);
  const memoryProbes = schedule.opportunities.flatMap((opportunity) => opportunity.stressors.flatMap((event) =>
    event.kind === "memory_probe" ? [{ index: opportunity.index, source: event.source_opportunity }] : []
  ));
  if (memoryProbes.some((probe) => probe.source >= probe.index)) throw new Error("LC4 memory probes must reference an earlier opportunity");
  const longOrBoundary = memoryProbes.filter((probe) =>
    probe.index - probe.source >= 20 || actAt(probe.index) !== actAt(probe.source)
  );
  if (longOrBoundary.length < 6) throw new Error("LC4 schedule requires at least six memory probes spanning 20 opportunities or an act boundary");
  const detours = schedule.opportunities.flatMap((opportunity) => opportunity.stressors.filter((event): event is Extract<Lc4StressEvent, { kind: "detour" }> => event.kind === "detour"));
  for (const id of new Set(detours.map((event) => event.detour_id))) {
    const transitions = detours.filter((event) => event.detour_id === id).map((event) => event.transition);
    if (canonicalJson(transitions) !== canonicalJson(["suspend", "resume"])) throw new Error(`LC4 detour ${id} must suspend then resume exactly once`);
  }
  const committed = schedule.opportunities.find((opportunity) => opportunity.stressors.some((event) => event.kind === "committed_after_error"));
  const reconciled = schedule.opportunities.find((opportunity) => opportunity.stressors.some((event) => event.kind === "authoritative_reconciliation"));
  if (!committed || !reconciled || reconciled.index <= committed.index) throw new Error("LC4 authoritative reconciliation must follow committed_after_error");
  const rotations = schedule.opportunities.filter((opportunity) => opportunity.stressors.some((event) => event.kind === "connection_rotation"));
  if (rotations.some((opportunity) => opportunity.index < 20 || opportunity.index > 42)) throw new Error("LC4 rotations must occur at act boundaries");
}

export function assertLc4DevelopmentAnalog(input: unknown): asserts input is Lc4DevelopmentAnalog {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("LC4 development artifact must be an object");
  const record = input as Record<string, unknown>;
  const manifest = Lc4ManifestSchema.parse(record.manifest);
  const scenario = BenchmarkScenarioSchema.parse(record.scenario);
  const flow = AgentFlowSchema.parse(record.flow);
  const schedule = Lc4ScheduleSchema.parse(record.schedule);
  const callerFixtures = z.array(Lc4CallerFixtureSchema).length(60).parse(record.callerFixtures);
  const manifestWithoutHash = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "manifest_sha256")
  );
  if (manifest.manifest_sha256 !== hashBody("lc4-development-manifest", manifestWithoutHash)) throw new Error("LC4 development manifest hash mismatch");
  if (manifest.scenario_sha256 !== hashBody("lc4-development-scenario", scenario)) throw new Error("LC4 development scenario hash mismatch");
  if (manifest.flow_sha256 !== hashBody("lc4-development-flow", flow)) throw new Error("LC4 development flow hash mismatch");
  if (schedule.scenario_id !== scenario.id || schedule.scenario_version !== scenario.version) throw new Error("LC4 schedule belongs to another scenario");
  const body = scheduleBody(scenario, schedule.opportunities);
  if (schedule.schedule_sha256 !== hashBody("lc4-development-schedule", body)) throw new Error("LC4 development schedule hash mismatch");
  const topology = schedule.opportunities.map((opportunity) => ({ index: opportunity.index, act: opportunity.act, goal_id: opportunity.goal_id, stressors: opportunity.stressors.map((event) => event.kind) }));
  if (schedule.topology_sha256 !== hashBody("lc4-development-topology", topology)) throw new Error("LC4 development topology hash mismatch");
  if (manifest.schedule_sha256 !== schedule.schedule_sha256) throw new Error("LC4 manifest schedule binding mismatch");
  if (manifest.fixture_manifest_sha256 !== hashBody("lc4-development-caller-fixtures", callerFixtures)) throw new Error("LC4 fixture manifest hash mismatch");
  const toolNames = new Set(scenario.tools.map((tool) => tool.name));
  for (const event of schedule.opportunities.flatMap((opportunity) => opportunity.stressors)) {
    if ((event.kind === "committed_after_error" || event.kind === "authoritative_reconciliation") && !toolNames.has(event.action)) {
      throw new Error(`LC4 stress event references unknown action ${event.action}`);
    }
  }
  callerFixtures.forEach((fixture, index) => {
    const opportunity = schedule.opportunities[index];
    if (fixture.turn_id !== opportunity.id || fixture.source_text !== opportunity.utterance || fixture.source_text_sha256 !== opportunity.source_text_sha256) {
      throw new Error(`LC4 caller fixture ${fixture.turn_id} does not match its opportunity`);
    }
  });
  if (canonicalJson(manifest.missing_mechanism_hooks) !== canonicalJson(LC4_MISSING_MECHANISM_HOOKS)) throw new Error("LC4 missing-mechanism hook inventory drifted");
  assertScheduleSemantics(schedule);
  const compilerInput = record.compilerInput as CanonicalConditionCompilerInput;
  const conditionSuite = record.conditionSuite as CompiledConditionSuite;
  const recompiled = compileConditionSuite(compilerInput);
  assertConditionParity(conditionSuite);
  if (canonicalJson(recompiled) !== canonicalJson(conditionSuite)) throw new Error("LC4 condition suite differs from a clean compiler replay");
  if (manifest.condition_suite_sha256 !== conditionSuite.suiteHash) throw new Error("LC4 condition-suite binding mismatch");
  if (canonicalJson(compilerInput.scenario) !== canonicalJson(scenario) || canonicalJson(compilerInput.flow) !== canonicalJson(flow)) {
    throw new Error("LC4 compiler input is not bound to its scenario and Flow");
  }
}

export type Lc4DevelopmentSuite = Readonly<{
  schema_version: 1;
  protocol_id: typeof LC4_DEVELOPMENT_PROTOCOL;
  base_seed: number;
  artifacts: readonly Lc4DevelopmentAnalog[];
  suite_sha256: string;
}>;

export function compileLc4DevelopmentSuite(baseSeed = 4_200): Lc4DevelopmentSuite {
  if (!Number.isSafeInteger(baseSeed) || baseSeed < 0) throw new Error("LC4 development base seed must be a non-negative safe integer");
  const artifacts = LC4_DEVELOPMENT_FAMILIES.flatMap((family, familyIndex) =>
    LC4_DEVELOPMENT_VARIANTS.map((variant, variantIndex) => compileLc4DevelopmentAnalog({
      family,
      variant,
      seed: baseSeed + familyIndex * 100 + variantIndex,
    }))
  );
  const body = { schema_version: 1 as const, protocol_id: LC4_DEVELOPMENT_PROTOCOL, base_seed: baseSeed, artifacts };
  return immutable({ ...body, suite_sha256: hashBody("lc4-development-suite", body) });
}

const Lc4CallerObservationSchema = z.object({
  schema_version: z.literal(1),
  schedule_sha256: z.string().regex(SHA256),
  opportunity_id: IdentifierSchema,
  observed_world_revision: z.number().int().nonnegative(),
  outcome: z.enum(["heard", "no_output", "critical_failure"]),
  listener_heard_audio_sha256: z.string().regex(SHA256).nullable(),
  visible_receipt_ids: z.array(IdentifierSchema),
  visible_worker_result_ids: z.array(IdentifierSchema),
}).strict().superRefine((observation, ctx) => {
  if (observation.outcome === "heard" && observation.listener_heard_audio_sha256 === null) {
    ctx.addIssue({ code: "custom", path: ["listener_heard_audio_sha256"], message: "heard outcomes require source-bound audio" });
  }
  if (observation.outcome !== "heard" && observation.listener_heard_audio_sha256 !== null) {
    ctx.addIssue({ code: "custom", path: ["listener_heard_audio_sha256"], message: "non-heard outcomes cannot claim listener-heard audio" });
  }
});

export type Lc4CallerObservation = z.infer<typeof Lc4CallerObservationSchema>;

export type Lc4CallerDisposition = Readonly<{
  opportunity_id: string;
  opportunity_index: number;
  disposition: "heard" | "no_output" | "critical_failure" | "not_reached_after_critical_failure";
  observation_sha256: string;
  previous_disposition_sha256: string | null;
  disposition_sha256: string;
}>;

export type Lc4CallerAutomatonState = Readonly<{
  schema_version: 1;
  protocol_id: typeof LC4_DEVELOPMENT_PROTOCOL;
  schedule_sha256: string;
  next_opportunity_index: number;
  status: "active" | "completed" | "critical_failure";
  dispositions: readonly Lc4CallerDisposition[];
  state_sha256: string;
}>;

function automatonStateBody(state: Omit<Lc4CallerAutomatonState, "state_sha256"> | Lc4CallerAutomatonState): unknown {
  return {
    schema_version: state.schema_version,
    protocol_id: state.protocol_id,
    schedule_sha256: state.schedule_sha256,
    next_opportunity_index: state.next_opportunity_index,
    status: state.status,
    dispositions: state.dispositions,
  };
}

function makeAutomatonState(body: Omit<Lc4CallerAutomatonState, "state_sha256">): Lc4CallerAutomatonState {
  return immutable({ ...body, state_sha256: hashBody("lc4-development-caller-state", automatonStateBody(body)) });
}

function assertAutomatonState(state: Lc4CallerAutomatonState, schedule: Lc4DevelopmentSchedule): void {
  if (state.schedule_sha256 !== schedule.schedule_sha256) throw new Error("LC4 caller state belongs to another schedule");
  if (state.state_sha256 !== hashBody("lc4-development-caller-state", automatonStateBody(state))) throw new Error("LC4 caller state hash mismatch");
  if (state.next_opportunity_index !== state.dispositions.length + 1 && state.status === "active") throw new Error("LC4 caller state index diverges from dispositions");
}

function disposition(
  opportunity: Lc4Opportunity,
  value: Lc4CallerDisposition["disposition"],
  observation: Lc4CallerObservation | null,
  previous: string | null,
): Lc4CallerDisposition {
  const observationSha256 = observation
    ? hashBody("lc4-development-caller-observation", observation)
    : hashBody("lc4-development-caller-observation", { opportunity_id: opportunity.id, disposition: value });
  const body = {
    opportunity_id: opportunity.id,
    opportunity_index: opportunity.index,
    disposition: value,
    observation_sha256: observationSha256,
    previous_disposition_sha256: previous,
  };
  return immutable({ ...body, disposition_sha256: hashBody("lc4-development-caller-disposition", body) });
}

export type Lc4CallerAutomaton = Readonly<{
  initialState: Lc4CallerAutomatonState;
  next(state: Lc4CallerAutomatonState): Readonly<{ opportunity: Lc4Opportunity; fixture: Lc4CallerFixture }> | null;
  commit(state: Lc4CallerAutomatonState, observation: Lc4CallerObservation): Lc4CallerAutomatonState;
}>;

export function createLc4CallerAutomaton(artifact: Lc4DevelopmentAnalog): Lc4CallerAutomaton {
  assertLc4DevelopmentAnalog(artifact);
  const initialState = makeAutomatonState({
    schema_version: 1,
    protocol_id: LC4_DEVELOPMENT_PROTOCOL,
    schedule_sha256: artifact.schedule.schedule_sha256,
    next_opportunity_index: 1,
    status: "active",
    dispositions: [],
  });
  return Object.freeze({
    initialState,
    next(state) {
      assertAutomatonState(state, artifact.schedule);
      if (state.status !== "active") return null;
      const opportunity = artifact.schedule.opportunities[state.next_opportunity_index - 1];
      const fixture = artifact.callerFixtures[state.next_opportunity_index - 1];
      if (!opportunity || !fixture) throw new Error("LC4 caller state points outside the frozen schedule");
      return Object.freeze({ opportunity, fixture });
    },
    commit(state, observationInput) {
      assertAutomatonState(state, artifact.schedule);
      if (state.status !== "active") throw new Error("LC4 caller automaton is terminal");
      const observation = Lc4CallerObservationSchema.parse(observationInput);
      const opportunity = artifact.schedule.opportunities[state.next_opportunity_index - 1];
      if (!opportunity) throw new Error("LC4 caller state points outside the frozen schedule");
      if (observation.schedule_sha256 !== artifact.schedule.schedule_sha256 || observation.opportunity_id !== opportunity.id) {
        throw new Error("LC4 caller observation is stale or belongs to another schedule opportunity");
      }
      const prior = state.dispositions.at(-1)?.disposition_sha256 ?? null;
      const committed = disposition(opportunity, observation.outcome, observation, prior);
      if (observation.outcome === "critical_failure") {
        const dispositions = [...state.dispositions, committed];
        let head = committed.disposition_sha256;
        for (const remaining of artifact.schedule.opportunities.slice(opportunity.index)) {
          const failed = disposition(remaining, "not_reached_after_critical_failure", null, head);
          dispositions.push(failed);
          head = failed.disposition_sha256;
        }
        return makeAutomatonState({
          schema_version: 1,
          protocol_id: LC4_DEVELOPMENT_PROTOCOL,
          schedule_sha256: artifact.schedule.schedule_sha256,
          next_opportunity_index: 61,
          status: "critical_failure",
          dispositions,
        });
      }
      const dispositions = [...state.dispositions, committed];
      const completed = opportunity.index === 60;
      return makeAutomatonState({
        schema_version: 1,
        protocol_id: LC4_DEVELOPMENT_PROTOCOL,
        schedule_sha256: artifact.schedule.schedule_sha256,
        next_opportunity_index: opportunity.index + 1,
        status: completed ? "completed" : "active",
        dispositions,
      });
    },
  });
}
