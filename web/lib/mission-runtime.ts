import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const ID = /^[a-z][a-z0-9_.:-]{1,127}$/;
const TOOL = /^[a-z][a-z0-9_.-]{1,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const CONTINUATION_DOMAIN = "harshas-amazing-call-center/mission-continuation/v1";
const STATE_DOMAIN = "harshas-amazing-call-center/mission-state/v1\n";
const EVENT_DOMAIN = "harshas-amazing-call-center/mission-event/v1\n";
const PROPOSAL_DOMAIN = "harshas-amazing-call-center/mission-proposal/v1\n";

export const MissionJsonSchema: z.ZodType<MissionJson> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(MissionJsonSchema),
  z.record(z.string(), MissionJsonSchema),
]));

export type MissionJson = null | boolean | number | string | MissionJson[] | { [key: string]: MissionJson };
export type FactAuthority = "caller" | "tool" | "policy" | "operator" | "system";
export type ActionRisk = "read" | "reversible" | "consequential" | "irreversible";
export type GoalStatus = "queued" | "active" | "suspended" | "completed" | "abandoned";

const FactPredicateSchema = z.object({
  kind: z.literal("fact"),
  fact_id: z.string().regex(ID),
  operator: z.enum(["exists", "equals", "not_equals", "in"]),
  value: MissionJsonSchema.optional(),
  authorities: z.array(z.enum(["caller", "tool", "policy", "operator", "system"])).min(1).max(5).optional(),
}).strict().superRefine((predicate, ctx) => {
  if (predicate.operator !== "exists" && predicate.value === undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: `${predicate.operator} requires value` });
  }
  if (predicate.operator === "in" && !Array.isArray(predicate.value)) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "in requires an array value" });
  }
});

const ReceiptPredicateSchema = z.object({
  kind: z.literal("receipt"),
  action: z.string().regex(TOOL),
  status: z.literal("succeeded"),
  scope: z.enum(["goal", "mission"]).default("goal"),
}).strict();

const ObligationPredicateSchema = z.object({
  kind: z.literal("obligation"),
  obligation_type: z.string().regex(ID),
  status: z.literal("satisfied"),
  scope: z.enum(["goal", "mission"]).default("goal"),
}).strict();

export const MissionPredicateSchema = z.discriminatedUnion("kind", [
  FactPredicateSchema,
  ReceiptPredicateSchema,
  ObligationPredicateSchema,
]);
export type MissionPredicate = z.infer<typeof MissionPredicateSchema>;

export const MissionObligationTemplateSchema = z.object({
  type: z.string().regex(ID),
  description: z.string().min(1).max(1_000),
  owner: z.enum(["agent", "caller", "human", "system"]),
  blocks: z.enum(["goal_completion", "mission_completion", "irreversible_actions"]),
}).strict();
export type MissionObligationTemplate = z.infer<typeof MissionObligationTemplateSchema>;

export const MissionCapabilitySchema = z.object({
  name: z.string().regex(TOOL),
  description: z.string().min(1).max(2_000),
  risk: z.enum(["read", "reversible", "consequential", "irreversible"]),
  goals: z.array(z.string().regex(ID)).min(1).max(256),
  prerequisites: z.array(MissionPredicateSchema).max(256).default([]),
  confirmation: z.object({
    prompt: z.string().min(1).max(1_000),
    accepted_values: z.array(MissionJsonSchema).min(1).max(32),
    authorities: z.array(z.enum(["caller", "operator"])).min(1).max(2),
  }).strict().optional(),
  idempotency: z.enum(["per_arguments", "per_goal", "none"]).default("per_arguments"),
  opens_obligations: z.array(MissionObligationTemplateSchema).max(64).default([]),
  satisfies_obligation_types: z.array(z.string().regex(ID)).max(64).default([]),
  saga: z.object({
    group: z.string().regex(ID),
    compensation_action: z.string().regex(TOOL).optional(),
  }).strict().optional(),
}).strict();
export type MissionCapability = z.infer<typeof MissionCapabilitySchema>;

export const MissionGoalSchema = z.object({
  id: z.string().regex(ID),
  label: z.string().min(1).max(256),
  entry: z.boolean().default(false),
  required: z.boolean().default(false),
  depends_on: z.array(z.string().regex(ID)).max(256).default([]),
  capabilities: z.array(z.string().regex(TOOL)).max(1_024).default([]),
  completion: z.array(MissionPredicateSchema).max(256).default([]),
  allowed_detours: z.array(z.string().regex(ID)).max(256).default([]),
}).strict();
export type MissionGoal = z.infer<typeof MissionGoalSchema>;

export const MissionDefinitionSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(ID),
  version: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  global_capabilities: z.array(z.string().regex(TOOL)).max(1_024).default([]),
  goals: z.array(MissionGoalSchema).min(1).max(256),
  capabilities: z.array(MissionCapabilitySchema).min(1).max(1_024),
}).strict().superRefine((definition, ctx) => {
  const unique = (values: readonly string[], path: (string | number)[], label: string) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) ctx.addIssue({ code: "custom", path: [...path, index], message: `duplicate ${label} ${value}` });
      seen.add(value);
    }
  };
  unique(definition.goals.map((goal) => goal.id), ["goals"], "goal");
  unique(definition.capabilities.map((capability) => capability.name), ["capabilities"], "capability");
  unique(definition.global_capabilities, ["global_capabilities"], "global capability");
  const goals = new Set(definition.goals.map((goal) => goal.id));
  const capabilities = new Set(definition.capabilities.map((capability) => capability.name));
  const capabilityByName = new Map(definition.capabilities.map((capability) => [capability.name, capability]));
  definition.goals.forEach((goal, index) => {
    unique(goal.depends_on, ["goals", index, "depends_on"], "dependency");
    unique(goal.capabilities, ["goals", index, "capabilities"], "goal capability");
    unique(goal.allowed_detours, ["goals", index, "allowed_detours"], "detour");
    for (const dependency of goal.depends_on) if (!goals.has(dependency)) {
      ctx.addIssue({ code: "custom", path: ["goals", index, "depends_on"], message: `unknown goal ${dependency}` });
    }
    for (const detour of goal.allowed_detours) if (!goals.has(detour) || detour === goal.id) {
      ctx.addIssue({ code: "custom", path: ["goals", index, "allowed_detours"], message: `invalid detour ${detour}` });
    }
    for (const capability of goal.capabilities) {
      const contract = capabilityByName.get(capability);
      if (!contract) {
        ctx.addIssue({ code: "custom", path: ["goals", index, "capabilities"], message: `unknown capability ${capability}` });
      } else if (!contract.goals.includes(goal.id)) {
        ctx.addIssue({ code: "custom", path: ["goals", index, "capabilities"], message: `${capability} does not grant goal ${goal.id}` });
      }
    }
  });
  const dependencies = new Map(definition.goals.map((goal) => [goal.id, goal.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (goalId: string): boolean => {
    if (visiting.has(goalId)) return true;
    if (visited.has(goalId)) return false;
    visiting.add(goalId);
    const cyclic = (dependencies.get(goalId) ?? []).some(visit);
    visiting.delete(goalId);
    visited.add(goalId);
    return cyclic;
  };
  for (const [index, item] of definition.goals.entries()) {
    if (visit(item.id)) ctx.addIssue({ code: "custom", path: ["goals", index, "depends_on"], message: "goal dependency graph contains a cycle" });
  }
  for (const capability of definition.capabilities) {
    const capabilityIndex = definition.capabilities.indexOf(capability);
    unique(capability.goals, ["capabilities", capabilityIndex, "goals"], "capability goal");
    unique(
      capability.opens_obligations.map((obligation) => obligation.type),
      ["capabilities", capabilityIndex, "opens_obligations"],
      "opened obligation type"
    );
    unique(
      capability.satisfies_obligation_types,
      ["capabilities", capabilityIndex, "satisfies_obligation_types"],
      "satisfied obligation type"
    );
    for (const goal of capability.goals) if (!goals.has(goal)) {
      ctx.addIssue({ code: "custom", path: ["capabilities"], message: `${capability.name} references unknown goal ${goal}` });
    }
    if (capability.saga?.compensation_action && !capabilities.has(capability.saga.compensation_action)) {
      ctx.addIssue({ code: "custom", path: ["capabilities"], message: `${capability.name} has unknown compensation action` });
    } else if (capability.saga?.compensation_action) {
      const compensation = capabilityByName.get(capability.saga.compensation_action);
      if (compensation?.risk === "irreversible") {
        ctx.addIssue({ code: "custom", path: ["capabilities"], message: `${capability.name} compensation cannot itself be irreversible` });
      }
    }
  }
  for (const name of definition.global_capabilities) if (!capabilities.has(name)) {
    ctx.addIssue({ code: "custom", path: ["global_capabilities"], message: `unknown global capability ${name}` });
  }
});
export type MissionDefinition = z.infer<typeof MissionDefinitionSchema>;

export type MissionFact = Readonly<{
  fact_id: string;
  revision: number;
  value: MissionJson;
  authority: FactAuthority;
  evidence_id: string;
  recorded_at: string;
  supersedes_revision: number | null;
}>;

export type MissionObligation = Readonly<{
  obligation_id: string;
  type: string;
  description: string;
  owner: "agent" | "caller" | "human" | "system";
  blocks: "goal_completion" | "mission_completion" | "irreversible_actions";
  scope_goal_id: string | null;
  source_receipt_id: string | null;
  compensation_action: string | null;
  status: "open" | "satisfied" | "waived";
  opened_revision: number;
  settled_revision: number | null;
  evidence_id: string | null;
}>;

export type MissionProposal = Readonly<{
  proposal_id: string;
  proposal_digest: string;
  goal_id: string;
  action: string;
  arguments: Readonly<Record<string, MissionJson>>;
  arguments_hash: string;
  idempotency_key: string;
  risk: ActionRisk;
  status: "proposed" | "authorized" | "settled" | "revoked" | "indeterminate";
  proposed_revision: number;
  authorized_revision: number | null;
  authorized_epoch: number | null;
  confirmation_evidence_id: string | null;
  compensation_obligation_id: string | null;
  receipt_id: string | null;
}>;

export type MissionReceipt = Readonly<{
  receipt_id: string;
  proposal_id: string;
  goal_id: string;
  action: string;
  arguments_hash: string;
  idempotency_key: string;
  status: "succeeded" | "failed" | "indeterminate" | "compensated";
  result: MissionJson | null;
  result_hash: string | null;
  settled_revision: number;
}>;

export type MissionEvent = Readonly<{
  sequence: number;
  revision: number;
  type: string;
  at: string;
  payload: MissionJson;
  state_head_hash: string;
  previous_event_hash: string | null;
  event_hash: string;
}>;

export type MissionState = Readonly<{
  schema_version: 1;
  mission_id: string;
  mission_version: string;
  definition_hash: string;
  status: "active" | "completed" | "failed";
  revision: number;
  capability_epoch: number;
  goals: Readonly<Record<string, Readonly<{ status: GoalStatus; activation_count: number }>>>;
  focus_stack: readonly string[];
  facts: Readonly<Record<string, MissionFact>>;
  obligations: readonly MissionObligation[];
  proposals: readonly MissionProposal[];
  receipts: readonly MissionReceipt[];
  events: readonly MissionEvent[];
}>;

export type MissionCapabilityDecision = Readonly<{
  action: string;
  allowed: boolean;
  reason: string;
  goal_id: string | null;
  risk: ActionRisk;
  capability_epoch: number;
  prerequisites: readonly Readonly<{ predicate: MissionPredicate; passed: boolean }>[];
  compensation_obligation_id: string | null;
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function validateJsonBounds(value: unknown, label: string, maxBytes: number): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 20_000) throw new Error(`${label} exceeds the 20000-node JSON limit`);
    if (current.depth > 32) throw new Error(`${label} exceeds the 32-level JSON depth limit`);
    if (current.value && typeof current.value === "object") {
      const children = Array.isArray(current.value)
        ? current.value
        : Object.values(current.value as Record<string, unknown>);
      for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  if (Buffer.byteLength(canonicalJson(value), "utf8") > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte canonical JSON limit`);
  }
}

function assertExternalId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !EXTERNAL_ID.test(value)) throw new Error(`${label} is not a safe bounded identifier`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function immutable<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function definitionHash(definition: MissionDefinition): string {
  return sha256(`harshas-amazing-call-center/mission-definition/v1\n${canonicalJson(definition)}`);
}

export function missionStateDigest(state: MissionState): string {
  return sha256(`${STATE_DOMAIN}${canonicalJson(state)}`);
}

function stateHeadHash(state: Omit<MissionState, "events"> | MissionState): string {
  const head = Object.fromEntries(Object.entries(state).filter(([key]) => key !== "events"));
  return sha256(`harshas-amazing-call-center/mission-state-head/v1\n${canonicalJson(head)}`);
}

function currentGoalId(state: MissionState): string | null {
  return state.focus_stack.at(-1) ?? null;
}

function appendEvent(
  state: MissionState,
  type: string,
  payload: MissionJson,
  at: string,
  patch: Partial<Omit<MissionState, "events" | "revision">>,
  rotateCapabilities = false
): MissionState {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== at) {
    throw new Error("mission event time must be a canonical ISO-8601 instant");
  }
  const lastTimestamp = state.events.at(-1)?.at;
  if (lastTimestamp && timestamp < Date.parse(lastTimestamp)) {
    throw new Error("mission event time cannot move backwards");
  }
  const revision = state.revision + 1;
  const previous = state.events.at(-1)?.event_hash ?? null;
  const nextHead = {
    ...state,
    ...patch,
    revision,
    capability_epoch: rotateCapabilities ? state.capability_epoch + 1 : state.capability_epoch,
  };
  const body = {
    sequence: state.events.length + 1,
    revision,
    type,
    at,
    payload,
    state_head_hash: stateHeadHash(nextHead),
    previous_event_hash: previous,
  };
  const event: MissionEvent = { ...body, event_hash: sha256(`${EVENT_DOMAIN}${canonicalJson(body)}`) };
  return immutable({
    ...nextHead,
    events: [...state.events, event],
  });
}

function requireDefinition(definitionInput: unknown, state?: MissionState): MissionDefinition {
  const definition = MissionDefinitionSchema.parse(definitionInput);
  validateJsonBounds(definition, "mission definition", 1_048_576);
  if (state && (
    state.mission_id !== definition.id
    || state.mission_version !== definition.version
    || state.definition_hash !== definitionHash(definition)
  )) throw new Error("mission state is not bound to this exact definition");
  return definition;
}

function goal(definition: MissionDefinition, goalId: string): MissionGoal {
  const found = definition.goals.find((candidate) => candidate.id === goalId);
  if (!found) throw new Error(`unknown mission goal ${goalId}`);
  return found;
}

function capability(definition: MissionDefinition, action: string): MissionCapability {
  const found = definition.capabilities.find((candidate) => candidate.name === action);
  if (!found) throw new Error(`unknown mission capability ${action}`);
  return found;
}

function evaluatePredicate(state: MissionState, predicate: MissionPredicate, goalId: string | null): boolean {
  if (predicate.kind === "fact") {
    const fact = state.facts[predicate.fact_id];
    if (!fact) return false;
    if (predicate.authorities && !predicate.authorities.includes(fact.authority)) return false;
    if (predicate.operator === "exists") return true;
    if (predicate.operator === "equals") return canonicalJson(fact.value) === canonicalJson(predicate.value);
    if (predicate.operator === "not_equals") return canonicalJson(fact.value) !== canonicalJson(predicate.value);
    return Array.isArray(predicate.value)
      && predicate.value.some((candidate) => canonicalJson(candidate) === canonicalJson(fact.value));
  }
  if (predicate.kind === "receipt") {
    return state.receipts.some((receipt) => receipt.action === predicate.action
      && receipt.status === "succeeded"
      && (predicate.scope === "mission" || receipt.goal_id === goalId));
  }
  return state.obligations.some((obligation) =>
    obligation.type === predicate.obligation_type
    && obligation.status === predicate.status
    && (predicate.scope === "mission" || obligation.scope_goal_id === goalId)
  );
}

function assertStateIntegrity(state: MissionState): void {
  if (!SHA256.test(state.definition_hash)) throw new Error("mission state definition hash is invalid");
  let previous: string | null = null;
  for (const [index, event] of state.events.entries()) {
    const body = {
      sequence: event.sequence,
      revision: event.revision,
      type: event.type,
      at: event.at,
      payload: event.payload,
      state_head_hash: event.state_head_hash,
      previous_event_hash: event.previous_event_hash,
    };
    if (
      event.sequence !== index + 1
      || event.revision !== index + 1
      || event.previous_event_hash !== previous
      || event.event_hash !== sha256(`${EVENT_DOMAIN}${canonicalJson(body)}`)
    ) throw new Error(`mission event ${index + 1} failed hash-chain verification`);
    previous = event.event_hash;
  }
  if (state.revision !== state.events.length) throw new Error("mission revision differs from its event ledger");
  if (state.events.at(-1)?.state_head_hash !== stateHeadHash(state)) {
    throw new Error("mission materialized state differs from the final event state head");
  }
  for (const goalId of state.focus_stack) {
    const status = state.goals[goalId]?.status;
    const isTop = goalId === currentGoalId(state);
    if ((isTop && status !== "active") || (!isTop && status !== "suspended")) {
      throw new Error("mission focus stack and goal statuses disagree");
    }
  }
}

export function createMissionState(definitionInput: unknown, at = new Date().toISOString()): MissionState {
  const definition = requireDefinition(definitionInput);
  const goals = Object.fromEntries(definition.goals.map((candidate) => [
    candidate.id,
    { status: "queued" as const, activation_count: 0 },
  ]));
  const initial: MissionState = {
    schema_version: 1,
    mission_id: definition.id,
    mission_version: definition.version,
    definition_hash: definitionHash(definition),
    status: "active",
    revision: 0,
    capability_epoch: 0,
    goals,
    focus_stack: [],
    facts: {},
    obligations: [],
    proposals: [],
    receipts: [],
    events: [],
  };
  return appendEvent(initial, "mission.created", { definition_hash: initial.definition_hash }, at, {}, true);
}

export function activateMissionGoal(
  definitionInput: unknown,
  stateInput: MissionState,
  input: Readonly<{ goal_id: string; mode: "root" | "detour"; at?: string }>
): MissionState {
  assertStateIntegrity(stateInput);
  const definition = requireDefinition(definitionInput, stateInput);
  const selected = goal(definition, input.goal_id);
  if (stateInput.status !== "active") throw new Error("mission is not active");
  if (!selected.depends_on.every((dependency) => stateInput.goals[dependency]?.status === "completed")) {
    throw new Error(`goal ${selected.id} has incomplete dependencies`);
  }
  const current = currentGoalId(stateInput);
  if (input.mode === "root" && !selected.entry) throw new Error(`goal ${selected.id} is not a root entry goal`);
  if (input.mode === "root" && current) throw new Error("a root goal cannot replace an active goal; use a declared detour");
  if (input.mode === "detour") {
    if (!current) throw new Error("detour requires an active goal");
    if (!goal(definition, current).allowed_detours.includes(selected.id)) {
      throw new Error(`goal ${selected.id} is not an allowed detour from ${current}`);
    }
  }
  if (!["queued", "suspended"].includes(stateInput.goals[selected.id].status)) {
    throw new Error(`goal ${selected.id} cannot be activated from ${stateInput.goals[selected.id].status}`);
  }
  const goals = structuredClone(stateInput.goals) as Record<string, { status: GoalStatus; activation_count: number }>;
  if (current) goals[current] = { ...goals[current], status: "suspended" };
  goals[selected.id] = { status: "active", activation_count: goals[selected.id].activation_count + 1 };
  return appendEvent(stateInput, "mission.goal_activated", {
    goal_id: selected.id,
    mode: input.mode,
    suspended_goal_id: current,
  }, input.at ?? new Date().toISOString(), {
    goals,
    focus_stack: [...stateInput.focus_stack, selected.id],
  }, true);
}

export function recordMissionFact(
  definitionInput: unknown,
  stateInput: MissionState,
  input: Readonly<{
    fact_id: string;
    value: MissionJson;
    authority: FactAuthority;
    evidence_id: string;
    supersedes_revision?: number;
    at?: string;
  }>
): MissionState {
  assertStateIntegrity(stateInput);
  requireDefinition(definitionInput, stateInput);
  if (!ID.test(input.fact_id)) throw new Error("mission fact id is invalid");
  assertExternalId(input.evidence_id, "mission fact evidence_id");
  if (!["caller", "tool", "policy", "operator", "system"].includes(input.authority)) {
    throw new Error("mission fact authority is invalid");
  }
  const value = MissionJsonSchema.parse(input.value);
  validateJsonBounds(value, "mission fact value", 65_536);
  const prior = stateInput.facts[input.fact_id];
  const sameValue = prior ? canonicalJson(prior.value) === canonicalJson(value) : false;
  if (prior) {
    if (input.supersedes_revision !== prior.revision) throw new Error("fact correction must supersede the current exact revision");
    if (sameValue && prior.authority === input.authority) throw new Error("fact revision cannot be a no-op");
  } else if (input.supersedes_revision !== undefined) {
    throw new Error("a new fact cannot supersede a missing revision");
  }
  const revision = (prior?.revision ?? 0) + 1;
  const fact: MissionFact = {
    fact_id: input.fact_id,
    revision,
    value,
    authority: input.authority,
    evidence_id: input.evidence_id,
    recorded_at: input.at ?? new Date().toISOString(),
    supersedes_revision: prior?.revision ?? null,
  };
  const proposals = stateInput.proposals.map((proposal) =>
    proposal.status === "authorized" || proposal.status === "proposed"
      ? { ...proposal, status: "revoked" as const }
      : proposal
  );
  const eventType = !prior
    ? "mission.fact_recorded"
    : sameValue
      ? "mission.fact_authority_changed"
      : "mission.fact_corrected";
  return appendEvent(stateInput, eventType, fact as unknown as MissionJson, fact.recorded_at, {
    facts: { ...stateInput.facts, [input.fact_id]: fact },
    proposals,
  }, true);
}

export function openMissionObligation(
  definitionInput: unknown,
  stateInput: MissionState,
  input: Readonly<{
    obligation_id?: string;
    type: string;
    description: string;
    owner: MissionObligation["owner"];
    blocks: MissionObligation["blocks"];
    scope_goal_id?: string;
    source_receipt_id?: string;
    compensation_action?: string;
    at?: string;
  }>
): MissionState {
  assertStateIntegrity(stateInput);
  const definition = requireDefinition(definitionInput, stateInput);
  if (!ID.test(input.type) || !input.description.trim()) throw new Error("mission obligation is invalid");
  if (input.scope_goal_id) goal(definition, input.scope_goal_id);
  if (input.compensation_action) capability(definition, input.compensation_action);
  const obligationId = input.obligation_id ?? `obl:${randomUUID()}`;
  assertExternalId(obligationId, "mission obligation_id");
  if (stateInput.obligations.some((item) => item.obligation_id === obligationId)) throw new Error("duplicate obligation id");
  const obligation: MissionObligation = {
    obligation_id: obligationId,
    type: input.type,
    description: input.description,
    owner: input.owner,
    blocks: input.blocks,
    scope_goal_id: input.scope_goal_id ?? currentGoalId(stateInput),
    source_receipt_id: input.source_receipt_id ?? null,
    compensation_action: input.compensation_action ?? null,
    status: "open",
    opened_revision: stateInput.revision + 1,
    settled_revision: null,
    evidence_id: null,
  };
  return appendEvent(stateInput, "mission.obligation_opened", obligation as unknown as MissionJson, input.at ?? new Date().toISOString(), {
    obligations: [...stateInput.obligations, obligation],
  }, true);
}

export function availableMissionCapabilities(
  definitionInput: unknown,
  stateInput: MissionState
): readonly MissionCapabilityDecision[] {
  assertStateIntegrity(stateInput);
  const definition = requireDefinition(definitionInput, stateInput);
  const current = currentGoalId(stateInput);
  const focused = current ? goal(definition, current) : null;
  const names = new Set([...(definition.global_capabilities ?? []), ...(focused?.capabilities ?? [])]);
  for (const obligation of stateInput.obligations) {
    if (obligation.status === "open" && obligation.compensation_action) names.add(obligation.compensation_action);
  }
  return immutable([...names].sort().map((name): MissionCapabilityDecision => {
    const item = capability(definition, name);
    const compensation = stateInput.obligations.find((obligation) =>
      obligation.status === "open" && obligation.compensation_action === name
    );
    const goalAllowed = current !== null && item.goals.includes(current);
    const globallyAllowed = definition.global_capabilities.includes(name);
    const compensationAllowed = Boolean(compensation);
    const prerequisites = item.prerequisites.map((predicate) => ({
      predicate,
      passed: evaluatePredicate(stateInput, predicate, current),
    }));
    const blockedObligation = item.risk === "irreversible" && stateInput.obligations.some((obligation) =>
      obligation.status === "open" && obligation.blocks === "irreversible_actions"
        && (!obligation.scope_goal_id || obligation.scope_goal_id === current)
    );
    const allowed = stateInput.status === "active"
      && (goalAllowed || globallyAllowed || compensationAllowed)
      && prerequisites.every((result) => result.passed)
      && !blockedObligation;
    const reason = stateInput.status !== "active"
      ? "mission_not_active"
      : !(goalAllowed || globallyAllowed || compensationAllowed)
        ? "not_in_focused_authority"
        : !prerequisites.every((result) => result.passed)
          ? "prerequisite_missing"
          : blockedObligation
            ? "blocking_obligation"
            : "allowed";
    return {
      action: name,
      allowed,
      reason,
      goal_id: current,
      risk: item.risk,
      capability_epoch: stateInput.capability_epoch,
      prerequisites,
      compensation_obligation_id: compensation?.obligation_id ?? null,
    };
  }));
}

function idempotencyKey(
  item: MissionCapability,
  goalId: string,
  argumentsHash: string
): string {
  const body = item.idempotency === "per_goal"
    ? { action: item.name, goal_id: goalId }
    : item.idempotency === "per_arguments"
      ? { action: item.name, goal_id: goalId, arguments_hash: argumentsHash }
      : { action: item.name, goal_id: goalId, nonce: randomUUID() };
  return sha256(`${PROPOSAL_DOMAIN}${canonicalJson(body)}`);
}

export type ProposeMissionActionResult = Readonly<{
  state: MissionState;
  proposal: MissionProposal;
  confirmation_challenge: Readonly<{
    proposal_id: string;
    proposal_digest: string;
    prompt: string;
    accepted_values: readonly MissionJson[];
  }> | null;
  replayed_receipt: MissionReceipt | null;
}>;

export function proposeMissionAction(
  definitionInput: unknown,
  stateInput: MissionState,
  input: Readonly<{ action: string; arguments: Readonly<Record<string, MissionJson>>; proposal_id?: string; at?: string }>
): ProposeMissionActionResult {
  assertStateIntegrity(stateInput);
  const definition = requireDefinition(definitionInput, stateInput);
  const item = capability(definition, input.action);
  const decision = availableMissionCapabilities(definition, stateInput).find((candidate) => candidate.action === input.action);
  if (!decision?.allowed || !decision.goal_id) throw new Error(`mission capability ${input.action} denied: ${decision?.reason ?? "not_disclosed"}`);
  const args = z.record(z.string().max(256), MissionJsonSchema).parse(input.arguments);
  validateJsonBounds(args, "mission action arguments", 262_144);
  const argumentsHash = sha256(canonicalJson(args));
  const key = idempotencyKey(item, decision.goal_id, argumentsHash);
  const replayed = item.idempotency === "none"
    ? null
    : stateInput.receipts.find((receipt) => receipt.idempotency_key === key && receipt.status === "succeeded") ?? null;
  if (replayed) {
    const proposal = stateInput.proposals.find((candidate) => candidate.proposal_id === replayed.proposal_id);
    if (!proposal) throw new Error("successful receipt is missing its proposal");
    return Object.freeze({ state: stateInput, proposal, confirmation_challenge: null, replayed_receipt: replayed });
  }
  const proposalId = input.proposal_id ?? `prp:${randomUUID()}`;
  assertExternalId(proposalId, "mission proposal_id");
  if (stateInput.proposals.some((proposal) => proposal.proposal_id === proposalId)) throw new Error("duplicate proposal id");
  const proposedRevision = stateInput.revision + 1;
  const proposalBody = {
    proposal_id: proposalId,
    goal_id: decision.goal_id,
    action: item.name,
    arguments_hash: argumentsHash,
    idempotency_key: key,
    compensation_obligation_id: decision.compensation_obligation_id,
    capability_epoch: stateInput.capability_epoch,
    proposed_revision: proposedRevision,
  };
  const proposalDigest = sha256(`${PROPOSAL_DOMAIN}${canonicalJson(proposalBody)}`);
  const needsConfirmation = Boolean(item.confirmation);
  const proposal: MissionProposal = {
    proposal_id: proposalId,
    proposal_digest: proposalDigest,
    goal_id: decision.goal_id,
    action: item.name,
    arguments: args,
    arguments_hash: argumentsHash,
    idempotency_key: key,
    risk: item.risk,
    status: needsConfirmation ? "proposed" : "authorized",
    proposed_revision: proposedRevision,
    authorized_revision: needsConfirmation ? null : proposedRevision,
    authorized_epoch: needsConfirmation ? null : stateInput.capability_epoch,
    confirmation_evidence_id: null,
    compensation_obligation_id: decision.compensation_obligation_id,
    receipt_id: null,
  };
  const state = appendEvent(stateInput, "mission.action_proposed", proposalBody as unknown as MissionJson, input.at ?? new Date().toISOString(), {
    proposals: [...stateInput.proposals, proposal],
  });
  return immutable({
    state,
    proposal,
    confirmation_challenge: item.confirmation ? {
      proposal_id: proposalId,
      proposal_digest: proposalDigest,
      prompt: item.confirmation.prompt,
      accepted_values: item.confirmation.accepted_values,
    } : null,
    replayed_receipt: null,
  });
}

export function authorizeMissionAction(
  definitionInput: unknown,
  stateInput: MissionState,
  input: Readonly<{
    proposal_id: string;
    proposal_digest: string;
    evidence_id: string;
    authority: "caller" | "operator";
    value: MissionJson;
    observed_after_revision: number;
    at?: string;
  }>
): MissionState {
  assertStateIntegrity(stateInput);
  const definition = requireDefinition(definitionInput, stateInput);
  const proposal = stateInput.proposals.find((candidate) => candidate.proposal_id === input.proposal_id);
  if (!proposal || proposal.status !== "proposed") throw new Error("mission proposal is not awaiting confirmation");
  if (proposal.proposal_digest !== input.proposal_digest) throw new Error("confirmation is not bound to the exact proposal");
  const item = capability(definition, proposal.action);
  if (!item.confirmation) throw new Error("mission proposal does not require confirmation");
  assertExternalId(input.evidence_id, "mission confirmation evidence_id");
  if (
    input.observed_after_revision <= proposal.proposed_revision
    || input.observed_after_revision > stateInput.revision + 1
  ) throw new Error("confirmation was not observed after the proposal");
  if (!item.confirmation.authorities.includes(input.authority)) throw new Error("confirmation authority is not accepted");
  const value = MissionJsonSchema.parse(input.value);
  validateJsonBounds(value, "mission confirmation value", 65_536);
  if (!item.confirmation.accepted_values.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) {
    throw new Error("confirmation value is not accepted");
  }
  if (proposal.goal_id !== currentGoalId(stateInput)) throw new Error("proposal goal is no longer focused");
  const proposals = stateInput.proposals.map((candidate): MissionProposal => candidate.proposal_id === proposal.proposal_id
    ? {
        ...candidate,
        status: "authorized",
        authorized_revision: stateInput.revision + 1,
        authorized_epoch: stateInput.capability_epoch,
        confirmation_evidence_id: input.evidence_id,
      }
    : candidate);
  return appendEvent(stateInput, "mission.action_authorized", {
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    evidence_id: input.evidence_id,
    authority: input.authority,
    value,
  }, input.at ?? new Date().toISOString(), { proposals });
}

function satisfyObligations(
  obligations: readonly MissionObligation[],
  types: readonly string[],
  goalId: string,
  revision: number,
  receiptId: string
): MissionObligation[] {
  return obligations.map((obligation) => obligation.status === "open"
    && obligation.scope_goal_id === goalId
    && types.includes(obligation.type)
    ? { ...obligation, status: "satisfied" as const, settled_revision: revision, evidence_id: receiptId }
    : obligation);
}

export function settleMissionAction(
  definitionInput: unknown,
  stateInput: MissionState,
  input: Readonly<{
    proposal_id: string;
    receipt_id: string;
    status: "succeeded" | "failed" | "indeterminate" | "compensated";
    result?: MissionJson;
    at?: string;
  }>
): MissionState {
  assertStateIntegrity(stateInput);
  const definition = requireDefinition(definitionInput, stateInput);
  const proposal = stateInput.proposals.find((candidate) => candidate.proposal_id === input.proposal_id);
  if (!proposal || proposal.status !== "authorized") throw new Error("mission action is not authorized for settlement");
  if (proposal.goal_id !== currentGoalId(stateInput)) throw new Error("mission action goal is no longer focused");
  if (proposal.authorized_epoch !== stateInput.capability_epoch) throw new Error("mission action authority was revoked by a newer state revision");
  assertExternalId(input.receipt_id, "mission receipt_id");
  if (stateInput.receipts.some((receipt) => receipt.receipt_id === input.receipt_id)) {
    throw new Error("mission receipt id is empty or duplicated");
  }
  const item = capability(definition, proposal.action);
  const result = input.result === undefined ? null : MissionJsonSchema.parse(input.result);
  validateJsonBounds(result, "mission action result", 1_048_576);
  const settledRevision = stateInput.revision + 1;
  const receipt: MissionReceipt = {
    receipt_id: input.receipt_id,
    proposal_id: proposal.proposal_id,
    goal_id: proposal.goal_id,
    action: proposal.action,
    arguments_hash: proposal.arguments_hash,
    idempotency_key: proposal.idempotency_key,
    status: input.status,
    result,
    result_hash: result === null ? null : sha256(canonicalJson(result)),
    settled_revision: settledRevision,
  };
  let receipts = [...stateInput.receipts];
  let obligations = [...stateInput.obligations];
  if (input.status === "succeeded" || input.status === "compensated") {
    obligations = satisfyObligations(
      obligations,
      item.satisfies_obligation_types,
      proposal.goal_id,
      settledRevision,
      receipt.receipt_id
    );
    for (const template of item.opens_obligations) {
      obligations.push({
        obligation_id: `obl:${receipt.receipt_id}:${template.type}`,
        type: template.type,
        description: template.description,
        owner: template.owner,
        blocks: template.blocks,
        scope_goal_id: proposal.goal_id,
        source_receipt_id: receipt.receipt_id,
        compensation_action: null,
        status: "open",
        opened_revision: settledRevision,
        settled_revision: null,
        evidence_id: null,
      });
    }
  }
  if ((input.status === "failed" || input.status === "indeterminate") && item.saga) {
    const priorSagaReceipts = stateInput.receipts.filter((candidate) => {
      const priorCapability = definition.capabilities.find((entry) => entry.name === candidate.action);
      return candidate.status === "succeeded"
        && priorCapability?.saga?.group === item.saga?.group
        && Boolean(priorCapability?.saga?.compensation_action);
    });
    for (const prior of priorSagaReceipts) {
      const priorCapability = capability(definition, prior.action);
      const compensationAction = priorCapability.saga?.compensation_action;
      if (!compensationAction) continue;
      const obligationId = `obl:compensate:${prior.receipt_id}`;
      if (!obligations.some((obligation) => obligation.obligation_id === obligationId)) {
        obligations.push({
          obligation_id: obligationId,
          type: `compensate:${prior.action}`,
          description: `Compensate ${prior.action} after ${item.name} did not complete safely.`,
          owner: "system",
          blocks: "mission_completion",
          scope_goal_id: proposal.goal_id,
          source_receipt_id: prior.receipt_id,
          compensation_action: compensationAction,
          status: "open",
          opened_revision: settledRevision,
          settled_revision: null,
          evidence_id: null,
        });
      }
    }
  }
  if (input.status === "compensated") {
    if (!proposal.compensation_obligation_id) {
      throw new Error("compensated settlement is not bound to a compensation obligation");
    }
    obligations = obligations.map((obligation) =>
      obligation.status === "open"
        && obligation.obligation_id === proposal.compensation_obligation_id
        && obligation.compensation_action === proposal.action
        ? { ...obligation, status: "satisfied" as const, settled_revision: settledRevision, evidence_id: receipt.receipt_id }
        : obligation
    );
    const compensated = obligations.find((obligation) =>
      obligation.obligation_id === proposal.compensation_obligation_id
    );
    if (!compensated?.source_receipt_id) throw new Error("compensation obligation has no source receipt");
    receipts = receipts.map((prior) => prior.receipt_id === compensated.source_receipt_id
      ? { ...prior, status: "compensated" as const }
      : prior);
  }
  const proposals = stateInput.proposals.map((candidate): MissionProposal => candidate.proposal_id === proposal.proposal_id
    ? {
        ...candidate,
        status: input.status === "indeterminate" ? "indeterminate" : "settled",
        receipt_id: receipt.receipt_id,
      }
    : candidate);
  return appendEvent(stateInput, "mission.action_settled", receipt as unknown as MissionJson, input.at ?? new Date().toISOString(), {
    proposals,
    receipts: [...receipts, receipt],
    obligations,
  }, true);
}

export function completeMissionGoal(
  definitionInput: unknown,
  stateInput: MissionState,
  input: Readonly<{ goal_id: string; at?: string }>
): MissionState {
  assertStateIntegrity(stateInput);
  const definition = requireDefinition(definitionInput, stateInput);
  const selected = goal(definition, input.goal_id);
  if (currentGoalId(stateInput) !== selected.id || stateInput.goals[selected.id].status !== "active") {
    throw new Error("only the focused active goal can complete");
  }
  const failed = selected.completion.filter((predicate) => !evaluatePredicate(stateInput, predicate, selected.id));
  if (failed.length) throw new Error(`goal ${selected.id} is missing ${failed.length} completion predicates`);
  const blocking = stateInput.obligations.filter((obligation) => obligation.status === "open"
    && obligation.blocks === "goal_completion"
    && (!obligation.scope_goal_id || obligation.scope_goal_id === selected.id));
  if (blocking.length) throw new Error(`goal ${selected.id} has ${blocking.length} open obligations`);
  const goals = structuredClone(stateInput.goals) as Record<string, { status: GoalStatus; activation_count: number }>;
  goals[selected.id] = { ...goals[selected.id], status: "completed" };
  const stack = stateInput.focus_stack.slice(0, -1);
  const resumed = stack.at(-1) ?? null;
  if (resumed) goals[resumed] = { ...goals[resumed], status: "active" };
  return appendEvent(stateInput, "mission.goal_completed", {
    goal_id: selected.id,
    resumed_goal_id: resumed,
  }, input.at ?? new Date().toISOString(), { goals, focus_stack: stack }, true);
}

export function abandonMissionGoal(
  definitionInput: unknown,
  stateInput: MissionState,
  input: Readonly<{ goal_id: string; reason: string; evidence_id: string; at?: string }>
): MissionState {
  assertStateIntegrity(stateInput);
  const definition = requireDefinition(definitionInput, stateInput);
  const selected = goal(definition, input.goal_id);
  if (selected.required) throw new Error(`required goal ${selected.id} cannot be abandoned`);
  if (currentGoalId(stateInput) !== selected.id || stateInput.goals[selected.id].status !== "active") {
    throw new Error("only the focused active goal can be abandoned");
  }
  if (!input.reason.trim() || input.reason.length > 1_000) throw new Error("goal abandonment requires a bounded reason");
  assertExternalId(input.evidence_id, "goal abandonment evidence_id");
  const unresolved = stateInput.obligations.filter((obligation) =>
    obligation.status === "open" && obligation.scope_goal_id === selected.id
  );
  if (unresolved.length) throw new Error(`goal ${selected.id} has unresolved obligations and cannot be abandoned`);
  if (stateInput.proposals.some((proposal) =>
    proposal.goal_id === selected.id && ["proposed", "authorized", "indeterminate"].includes(proposal.status)
  )) throw new Error(`goal ${selected.id} has unresolved actions and cannot be abandoned`);
  const goals = structuredClone(stateInput.goals) as Record<string, { status: GoalStatus; activation_count: number }>;
  goals[selected.id] = { ...goals[selected.id], status: "abandoned" };
  const stack = stateInput.focus_stack.slice(0, -1);
  const resumed = stack.at(-1) ?? null;
  if (resumed) goals[resumed] = { ...goals[resumed], status: "active" };
  return appendEvent(stateInput, "mission.goal_abandoned", {
    goal_id: selected.id,
    reason: input.reason,
    evidence_id: input.evidence_id,
    resumed_goal_id: resumed,
  }, input.at ?? new Date().toISOString(), { goals, focus_stack: stack }, true);
}

export function completeMission(
  definitionInput: unknown,
  stateInput: MissionState,
  at = new Date().toISOString()
): MissionState {
  assertStateIntegrity(stateInput);
  const definition = requireDefinition(definitionInput, stateInput);
  const incomplete = definition.goals.filter((candidate) => candidate.required && stateInput.goals[candidate.id].status !== "completed");
  if (incomplete.length) throw new Error(`mission has incomplete required goals: ${incomplete.map((item) => item.id).join(", ")}`);
  if (stateInput.focus_stack.length || Object.values(stateInput.goals).some((item) => item.status === "active" || item.status === "suspended")) {
    throw new Error("mission still has an active or suspended goal");
  }
  const obligations = stateInput.obligations.filter((obligation) => obligation.status === "open");
  if (obligations.length) throw new Error(`mission has ${obligations.length} open completion obligations`);
  if (stateInput.proposals.some((proposal) => ["proposed", "authorized", "indeterminate"].includes(proposal.status))) {
    throw new Error("mission has unresolved action proposals");
  }
  return appendEvent(stateInput, "mission.completed", {
    completed_goals: Object.entries(stateInput.goals).filter(([, value]) => value.status === "completed").map(([id]) => id),
  }, at, { status: "completed", focus_stack: [] }, true);
}

export type MissionContinuationClaims = Readonly<{
  typ: "mission-continuation";
  v: 1;
  subject_id: string;
  mission_id: string;
  mission_version: string;
  state_digest: string;
  from_channel: string;
  to_channels: readonly string[];
  issued_at: number;
  expires_at: number;
  nonce: string;
}>;

export function issueMissionContinuation(input: Readonly<{
  state: MissionState;
  subject_id: string;
  from_channel: string;
  to_channels: readonly string[];
  secret: string;
  ttl_seconds?: number;
  now_ms?: number;
  nonce?: string;
}>): Readonly<{ token: string; claims: MissionContinuationClaims }> {
  assertStateIntegrity(input.state);
  if (input.secret.length < 32) throw new Error("mission continuation secret must be at least 32 characters");
  assertExternalId(input.subject_id, "mission continuation subject_id");
  const channelPattern = /^[a-z][a-z0-9_.:-]{0,63}$/;
  if (
    !channelPattern.test(input.from_channel)
    || input.to_channels.length < 1
    || input.to_channels.length > 16
    || input.to_channels.some((channel) => !channelPattern.test(channel))
  ) throw new Error("mission continuation channels are invalid");
  const ttl = input.ttl_seconds ?? 15 * 60;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 60 * 60) throw new Error("mission continuation TTL must be 1..86400 seconds");
  const now = Math.floor((input.now_ms ?? Date.now()) / 1_000);
  const nonce = input.nonce ?? randomUUID();
  assertExternalId(nonce, "mission continuation nonce");
  const claims: MissionContinuationClaims = immutable({
    typ: "mission-continuation",
    v: 1,
    subject_id: input.subject_id,
    mission_id: input.state.mission_id,
    mission_version: input.state.mission_version,
    state_digest: missionStateDigest(input.state),
    from_channel: input.from_channel,
    to_channels: [...new Set(input.to_channels)].sort(),
    issued_at: now,
    expires_at: now + ttl,
    nonce,
  });
  const body = Buffer.from(canonicalJson(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", input.secret).update(CONTINUATION_DOMAIN).update("\n").update(body).digest("base64url");
  return immutable({ token: `${body}.${signature}`, claims });
}

export function verifyMissionContinuation(input: Readonly<{
  token: string;
  state: MissionState;
  subject_id: string;
  target_channel: string;
  secret: string;
  now_ms?: number;
}>): Readonly<{ ok: true; claims: MissionContinuationClaims } | { ok: false; code: string }> {
  try {
    assertStateIntegrity(input.state);
    const [body, encoded, extra] = input.token.split(".");
    if (!body || !encoded || extra) return { ok: false, code: "malformed" };
    const actual = Buffer.from(encoded, "base64url");
    if (actual.toString("base64url") !== encoded) return { ok: false, code: "invalid_signature" };
    const expected = createHmac("sha256", input.secret).update(CONTINUATION_DOMAIN).update("\n").update(body).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, code: "invalid_signature" };
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MissionContinuationClaims;
    const now = Math.floor((input.now_ms ?? Date.now()) / 1_000);
    if (
      claims.typ !== "mission-continuation"
      || claims.v !== 1
      || !EXTERNAL_ID.test(claims.subject_id)
      || !Array.isArray(claims.to_channels)
      || claims.to_channels.length < 1
      || claims.to_channels.length > 16
      || !claims.to_channels.every((channel) => typeof channel === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/.test(channel))
      || !EXTERNAL_ID.test(claims.nonce)
      || !SHA256.test(claims.state_digest)
    ) return { ok: false, code: "invalid_claims" };
    if (claims.expires_at <= now || claims.issued_at > now + 30 || claims.expires_at - claims.issued_at > 86_400) {
      return { ok: false, code: "expired" };
    }
    if (
      claims.subject_id !== input.subject_id
      || claims.mission_id !== input.state.mission_id
      || claims.mission_version !== input.state.mission_version
      || claims.state_digest !== missionStateDigest(input.state)
      || !claims.to_channels.includes(input.target_channel)
    ) return { ok: false, code: "scope_mismatch" };
    return immutable({ ok: true as const, claims });
  } catch {
    return { ok: false, code: "invalid" };
  }
}

export function verifyMissionState(definitionInput: unknown, stateInput: MissionState): Readonly<{ valid: boolean; errors: readonly string[] }> {
  const errors: string[] = [];
  try {
    assertStateIntegrity(stateInput);
    const definition = requireDefinition(definitionInput, stateInput);
    for (const [goalId, value] of Object.entries(stateInput.goals)) {
      if (!definition.goals.some((candidate) => candidate.id === goalId)) errors.push(`state has unknown goal ${goalId}`);
      if (!Number.isInteger(value.activation_count) || value.activation_count < 0) errors.push(`goal ${goalId} activation count is invalid`);
    }
    if (Object.keys(stateInput.goals).length !== definition.goals.length) errors.push("state goal catalog is incomplete");
    if (new Set(stateInput.obligations.map((item) => item.obligation_id)).size !== stateInput.obligations.length) {
      errors.push("obligation ids are not unique");
    }
    if (new Set(stateInput.proposals.map((item) => item.proposal_id)).size !== stateInput.proposals.length) {
      errors.push("proposal ids are not unique");
    }
    if (new Set(stateInput.receipts.map((item) => item.receipt_id)).size !== stateInput.receipts.length) {
      errors.push("receipt ids are not unique");
    }
    for (const receipt of stateInput.receipts) {
      const proposal = stateInput.proposals.find((candidate) => candidate.proposal_id === receipt.proposal_id);
      if (!proposal || proposal.receipt_id !== receipt.receipt_id) errors.push(`receipt ${receipt.receipt_id} is not bijective with its proposal`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return immutable({ valid: errors.length === 0, errors });
}
