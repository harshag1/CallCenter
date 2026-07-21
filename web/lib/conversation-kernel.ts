import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Event-log-first conversation memory for long-running voice sessions.
 *
 * The model never owns durable state. Every projection is rebuilt from the
 * append-only log, while model summaries remain advisory and cannot assert or
 * correct authoritative facts.
 */

export const CONVERSATION_KERNEL_VERSION = 1 as const;
export const GENESIS_HASH = "0".repeat(64);

const MAX_EVENT_BYTES = 32_768;
const MAX_JSON_VALUE_BYTES = 4_096;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 4_096;
const MAX_FACTS_PER_DELIVERY = 32;
const MAX_ADVISORIES_PER_DELIVERY = 16;
const MAX_DEPENDENCIES_PER_WORKER = 64;
const MAX_UNRESOLVED_FLOW_ACTIONS = 64;
const MAX_INVARIANTS = 64;
const MIN_CONTEXT_BYTES = 256;
const MAX_CONTEXT_BYTES = 65_536;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** JSON canonicalization used by both event hashes and logical-delivery hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 128 && entries.every(([key, item]) =>
    key.length <= MAX_ID_LENGTH && isJsonValue(item, depth + 1));
}

const JsonValueSchema = z.unknown().superRefine((value, ctx) => {
  if (!isJsonValue(value)) {
    ctx.addIssue({ code: "custom", message: "must be bounded JSON with depth <= 8" });
    return;
  }
  if (utf8Bytes(canonicalJson(value)) > MAX_JSON_VALUE_BYTES) {
    ctx.addIssue({ code: "custom", message: `JSON value exceeds ${MAX_JSON_VALUE_BYTES} bytes` });
  }
}).transform((value) => value as JsonValue);

const IdSchema = z.string().min(1).max(MAX_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const TextSchema = z.string().min(1).max(MAX_TEXT_LENGTH);
const NonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const PositiveIntegerSchema = z.number().int().positive().safe();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const AuthorityStampSchema = z.object({
  kind: z.enum(["system_of_record", "human_verified", "cryptographic_attestation"]),
  issuer: IdSchema,
  evidenceId: IdSchema,
  issuedAtMs: NonNegativeIntegerSchema,
}).strict();

export type AuthorityStamp = z.infer<typeof AuthorityStampSchema>;

const FactAssertedSchema = z.object({
  type: z.literal("fact.asserted"),
  key: IdSchema,
  value: JsonValueSchema,
  revision: z.literal(1),
  authority: AuthorityStampSchema,
}).strict();

const FactCorrectedSchema = z.object({
  type: z.literal("fact.corrected"),
  key: IdSchema,
  value: JsonValueSchema,
  expectedRevision: PositiveIntegerSchema,
  revision: PositiveIntegerSchema,
  authority: AuthorityStampSchema,
}).strict();

const GoalActivatedSchema = z.object({
  type: z.literal("goal.activated"),
  goalId: IdSchema,
  description: TextSchema,
}).strict();

const GoalCompletedSchema = z.object({
  type: z.literal("goal.completed"),
  goalId: IdSchema,
}).strict();

const GoalSuspendedSchema = z.object({
  type: z.literal("goal.suspended"),
  goalId: IdSchema,
  reason: TextSchema,
}).strict();

const GoalResumedSchema = z.object({
  type: z.literal("goal.resumed"),
  goalId: IdSchema,
}).strict();

const CommitmentOpenedSchema = z.object({
  type: z.literal("commitment.opened"),
  commitmentId: IdSchema,
  goalId: IdSchema,
  description: TextSchema,
}).strict();

const CommitmentResolvedSchema = z.object({
  type: z.literal("commitment.resolved"),
  commitmentId: IdSchema,
  resolution: TextSchema,
}).strict();

const InvariantSchema = z.object({
  invariantId: IdSchema,
  text: TextSchema,
}).strict();

const PolicyAdvancedSchema = z.object({
  type: z.literal("policy.advanced"),
  epoch: PositiveIntegerSchema,
  invariants: z.array(InvariantSchema).max(MAX_INVARIANTS),
}).strict().superRefine((policy, ctx) => {
  if (new Set(policy.invariants.map(({ invariantId }) => invariantId)).size !== policy.invariants.length) {
    ctx.addIssue({ code: "custom", message: "policy invariants must have unique ids" });
  }
});

const FlowCheckpointRecordedSchema = z.object({
  type: z.literal("flow.checkpoint_recorded"),
  goalId: IdSchema,
  runtimeDigest: HashSchema,
  flowRevision: NonNegativeIntegerSchema,
  capabilityEpoch: NonNegativeIntegerSchema,
  status: z.enum(["routing", "active", "completed", "failed"]),
  nodeId: TextSchema.nullable(),
  currentStep: TextSchema.nullable(),
  completedStepCount: NonNegativeIntegerSchema,
  unresolvedActionIds: z.array(IdSchema).max(MAX_UNRESOLVED_FLOW_ACTIONS),
  stateDigest: HashSchema,
}).strict().superRefine((checkpoint, ctx) => {
  if (new Set(checkpoint.unresolvedActionIds).size !== checkpoint.unresolvedActionIds.length) {
    ctx.addIssue({ code: "custom", message: "unresolved flow action ids must be unique" });
  }
  if (checkpoint.status === "routing" && (checkpoint.nodeId !== null || checkpoint.currentStep !== null)) {
    ctx.addIssue({ code: "custom", message: "routing flow checkpoint cannot retain a node or step" });
  }
  if (checkpoint.status === "active" && checkpoint.nodeId === null) {
    ctx.addIssue({ code: "custom", message: "active flow checkpoint requires a node" });
  }
  if ((checkpoint.status === "completed" || checkpoint.status === "failed") && checkpoint.currentStep !== null) {
    ctx.addIssue({ code: "custom", message: "terminal flow checkpoint cannot retain an active step" });
  }
});

const FactDependencySchema = z.object({
  key: IdSchema,
  revision: PositiveIntegerSchema,
}).strict();

const WorkerSpawnedSchema = z.object({
  type: z.literal("worker.spawned"),
  workerId: IdSchema,
  goalId: IdSchema,
  purpose: TextSchema,
  policyEpoch: NonNegativeIntegerSchema,
  dependencies: z.array(FactDependencySchema).max(MAX_DEPENDENCIES_PER_WORKER),
}).strict().superRefine((worker, ctx) => {
  if (new Set(worker.dependencies.map(({ key }) => key)).size !== worker.dependencies.length) {
    ctx.addIssue({ code: "custom", message: "worker dependencies must have unique fact keys" });
  }
});

const WorkerCancelledSchema = z.object({
  type: z.literal("worker.cancelled"),
  workerId: IdSchema,
  reason: TextSchema,
}).strict();

const WorkerFactSchema = z.object({
  key: IdSchema,
  value: JsonValueSchema,
  evidenceId: IdSchema,
}).strict();

const WorkerAdvisorySchema = z.object({
  episodeId: IdSchema,
  text: TextSchema,
}).strict();

const WorkerResultDeliveredSchema = z.object({
  type: z.literal("worker.result_delivered"),
  deliveryId: IdSchema,
  workerId: IdSchema,
  goalId: IdSchema,
  policyEpoch: NonNegativeIntegerSchema,
  dependencyFactRevisions: z.array(FactDependencySchema).max(MAX_DEPENDENCIES_PER_WORKER),
  facts: z.array(WorkerFactSchema).max(MAX_FACTS_PER_DELIVERY),
  advisories: z.array(WorkerAdvisorySchema).max(MAX_ADVISORIES_PER_DELIVERY),
}).strict().superRefine((result, ctx) => {
  if (new Set(result.dependencyFactRevisions.map(({ key }) => key)).size !== result.dependencyFactRevisions.length) {
    ctx.addIssue({ code: "custom", message: "delivery dependencies must have unique fact keys" });
  }
  if (new Set(result.facts.map(({ key }) => key)).size !== result.facts.length) {
    ctx.addIssue({ code: "custom", message: "delivery facts must have unique keys" });
  }
  if (new Set(result.advisories.map(({ episodeId }) => episodeId)).size !== result.advisories.length) {
    ctx.addIssue({ code: "custom", message: "delivery advisories must have unique episode ids" });
  }
});

const AdvisoryRecordedSchema = z.object({
  type: z.literal("advisory.recorded"),
  episodeId: IdSchema,
  summary: TextSchema,
}).strict();

export const ConversationEventPayloadSchema = z.discriminatedUnion("type", [
  FactAssertedSchema,
  FactCorrectedSchema,
  GoalActivatedSchema,
  GoalCompletedSchema,
  GoalSuspendedSchema,
  GoalResumedSchema,
  CommitmentOpenedSchema,
  CommitmentResolvedSchema,
  PolicyAdvancedSchema,
  FlowCheckpointRecordedSchema,
  WorkerSpawnedSchema,
  WorkerCancelledSchema,
  WorkerResultDeliveredSchema,
  AdvisoryRecordedSchema,
]);

export type ConversationEventPayload = z.infer<typeof ConversationEventPayloadSchema>;

export const ConversationEventDraftSchema = z.object({
  eventId: IdSchema,
  occurredAtMs: NonNegativeIntegerSchema,
  payload: ConversationEventPayloadSchema,
}).strict();

export type ConversationEventDraft = z.input<typeof ConversationEventDraftSchema>;

export const ConversationEventSchema = ConversationEventDraftSchema.extend({
  version: z.literal(CONVERSATION_KERNEL_VERSION),
  conversationId: IdSchema,
  sequence: PositiveIntegerSchema,
  previousHash: HashSchema,
  hash: HashSchema,
}).strict();

export type ConversationEvent = z.infer<typeof ConversationEventSchema>;

export interface ConversationLog {
  readonly version: typeof CONVERSATION_KERNEL_VERSION;
  readonly conversationId: string;
  readonly events: readonly ConversationEvent[];
}

export interface AuthoritativeFact {
  readonly key: string;
  readonly value: JsonValue;
  readonly revision: number;
  readonly authority: AuthorityStamp;
  readonly sequence: number;
}

export interface ConversationGoal {
  readonly goalId: string;
  readonly description: string;
  readonly activatedSequence: number;
  readonly status: "active" | "completed" | "suspended";
}

export interface ConversationCommitment {
  readonly commitmentId: string;
  readonly goalId: string;
  readonly description: string;
  readonly openedSequence: number;
  readonly resolution: string | null;
  readonly resolvedSequence: number | null;
}

export interface WorkerRecord {
  readonly workerId: string;
  readonly goalId: string;
  readonly purpose: string;
  readonly policyEpoch: number;
  readonly dependencies: readonly z.infer<typeof FactDependencySchema>[];
  readonly spawnedSequence: number;
  readonly status: "running" | "completed" | "cancelled";
}

export interface WorkerDeliveryRecord {
  readonly deliveryId: string;
  readonly workerId: string;
  readonly eventId: string;
  readonly status: "accepted" | "deferred" | "rejected" | "duplicate";
  readonly reason: string | null;
  readonly appliedSequence: number | null;
  readonly logicalHash: string;
}

export interface AcceptedWorkerFact {
  readonly key: string;
  readonly value: JsonValue;
  readonly evidenceId: string;
  readonly workerId: string;
  readonly deliveryId: string;
  readonly goalId: string;
  readonly policyEpoch: number;
  readonly dependencyFactRevisions: readonly z.infer<typeof FactDependencySchema>[];
  readonly acceptedSequence: number;
}

export interface AdvisoryEpisode {
  readonly episodeId: string;
  readonly text: string;
  readonly source: "model" | "worker";
  readonly sequence: number;
}

export interface FlowCheckpointRecord {
  readonly goalId: string;
  readonly runtimeDigest: string;
  readonly flowRevision: number;
  readonly capabilityEpoch: number;
  readonly status: "routing" | "active" | "completed" | "failed";
  readonly nodeId: string | null;
  readonly currentStep: string | null;
  readonly completedStepCount: number;
  readonly unresolvedActionIds: readonly string[];
  readonly stateDigest: string;
  readonly sequence: number;
}

export interface ConversationState {
  readonly facts: readonly AuthoritativeFact[];
  readonly goals: readonly ConversationGoal[];
  readonly currentGoal: ConversationGoal | null;
  readonly commitments: readonly ConversationCommitment[];
  readonly policy: { readonly epoch: number; readonly invariants: readonly z.infer<typeof InvariantSchema>[] };
  readonly flowCheckpoints: readonly FlowCheckpointRecord[];
  readonly currentFlowCheckpoint: FlowCheckpointRecord | null;
  readonly workers: readonly WorkerRecord[];
  readonly deliveries: readonly WorkerDeliveryRecord[];
  readonly acceptedWorkerFacts: readonly AcceptedWorkerFact[];
  readonly advisories: readonly AdvisoryEpisode[];
  readonly headHash: string;
  readonly eventCount: number;
}

type MutableGoal = Omit<ConversationGoal, "status"> & { status: ConversationGoal["status"] };
type MutableCommitment = Omit<ConversationCommitment, "resolution" | "resolvedSequence"> & {
  resolution: string | null;
  resolvedSequence: number | null;
};
type MutableWorker = Omit<WorkerRecord, "status"> & { status: WorkerRecord["status"] };

interface MutableState {
  facts: Map<string, AuthoritativeFact>;
  goals: Map<string, MutableGoal>;
  currentGoalId: string | null;
  commitments: Map<string, MutableCommitment>;
  policy: { epoch: number; invariants: z.infer<typeof InvariantSchema>[] };
  flowCheckpoints: Map<string, FlowCheckpointRecord>;
  workers: Map<string, MutableWorker>;
  deliveries: WorkerDeliveryRecord[];
  logicalDeliveries: Map<string, { hash: string; status: "accepted" | "deferred" | "rejected" }>;
  acceptedWorkerFacts: AcceptedWorkerFact[];
  advisories: AdvisoryEpisode[];
}

function emptyMutableState(): MutableState {
  return {
    facts: new Map(),
    goals: new Map(),
    currentGoalId: null,
    commitments: new Map(),
    policy: { epoch: 0, invariants: [] },
    flowCheckpoints: new Map(),
    workers: new Map(),
    deliveries: [],
    logicalDeliveries: new Map(),
    acceptedWorkerFacts: [],
    advisories: [],
  };
}

function eventHash(event: Omit<ConversationEvent, "hash">): string {
  return sha256(canonicalJson(event));
}

export function createConversationLog(conversationId: string): ConversationLog {
  const parsedId = IdSchema.parse(conversationId);
  return Object.freeze({ version: CONVERSATION_KERNEL_VERSION, conversationId: parsedId, events: Object.freeze([]) });
}

/** Validates schema, contiguous sequence, conversation binding, and every hash link. */
export function validateConversationLog(log: ConversationLog): void {
  if (log.version !== CONVERSATION_KERNEL_VERSION) throw new Error("unsupported conversation log version");
  const conversationId = IdSchema.parse(log.conversationId);
  let previousHash = GENESIS_HASH;
  const eventIds = new Set<string>();
  for (const [index, candidate] of log.events.entries()) {
    const event = ConversationEventSchema.parse(candidate);
    if (event.conversationId !== conversationId) throw new Error(`event ${event.eventId} belongs to another conversation`);
    if (event.sequence !== index + 1) throw new Error(`event ${event.eventId} has a non-contiguous sequence`);
    if (event.previousHash !== previousHash) throw new Error(`event ${event.eventId} breaks the hash chain`);
    if (eventIds.has(event.eventId)) throw new Error(`duplicate event id ${event.eventId} exists in the log`);
    eventIds.add(event.eventId);
    const { hash, ...unsigned } = event;
    if (eventHash(unsigned) !== hash) throw new Error(`event ${event.eventId} has an invalid hash`);
    previousHash = hash;
  }
}

/**
 * Appends an event, or returns the same log for an identical replay. A replay
 * with the same id but different bytes is an integrity error.
 */
export function appendConversationEvent(log: ConversationLog, input: ConversationEventDraft): ConversationLog {
  return appendConversationEvents(log, [input]);
}

/** Validates/folds the existing prefix once, then atomically appends a batch. */
export function appendConversationEvents(
  log: ConversationLog,
  inputs: readonly ConversationEventDraft[]
): ConversationLog {
  validateConversationLog(log);
  const state = emptyMutableState();
  for (const event of log.events) applyEvent(state, event);
  const events = [...log.events];
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  let appended = false;
  for (const input of inputs) {
    const draft = ConversationEventDraftSchema.parse(input);
    const existing = eventsById.get(draft.eventId);
    if (existing) {
      const replay = { eventId: existing.eventId, occurredAtMs: existing.occurredAtMs, payload: existing.payload };
      if (canonicalJson(replay) !== canonicalJson(draft)) throw new Error(`conflicting replay for event ${draft.eventId}`);
      continue;
    }
    const previousHash = events.at(-1)?.hash ?? GENESIS_HASH;
    const unsigned = {
      version: CONVERSATION_KERNEL_VERSION,
      conversationId: log.conversationId,
      sequence: events.length + 1,
      previousHash,
      ...draft,
    } as const;
    const event = ConversationEventSchema.parse({ ...unsigned, hash: eventHash(unsigned) });
    if (utf8Bytes(canonicalJson(event)) > MAX_EVENT_BYTES) throw new Error(`event exceeds ${MAX_EVENT_BYTES} bytes`);
    // Semantic invalidity fails at the write boundary, before the batch is exposed.
    applyEvent(state, event);
    events.push(Object.freeze(event));
    eventsById.set(event.eventId, event);
    appended = true;
  }
  return appended ? Object.freeze({ ...log, events: Object.freeze(events) }) : log;
}

function dependenciesMatch(
  expected: readonly z.infer<typeof FactDependencySchema>[],
  actual: readonly z.infer<typeof FactDependencySchema>[]
): boolean {
  const normalize = (items: readonly z.infer<typeof FactDependencySchema>[]) => [...items]
    .sort((left, right) => compareCodeUnits(left.key, right.key));
  return canonicalJson(normalize(expected)) === canonicalJson(normalize(actual));
}

function applyEvent(state: MutableState, event: ConversationEvent): void {
  const payload = event.payload;
  switch (payload.type) {
    case "fact.asserted": {
      if (state.facts.has(payload.key)) throw new Error(`fact ${payload.key} already exists; use fact.corrected`);
      state.facts.set(payload.key, {
        key: payload.key, value: payload.value, revision: 1, authority: payload.authority, sequence: event.sequence,
      });
      return;
    }
    case "fact.corrected": {
      const prior = state.facts.get(payload.key);
      if (!prior) throw new Error(`cannot correct missing fact ${payload.key}`);
      if (prior.revision !== payload.expectedRevision || payload.revision !== prior.revision + 1) {
        throw new Error(`fact ${payload.key} correction revision is stale or non-contiguous`);
      }
      state.facts.set(payload.key, {
        key: payload.key, value: payload.value, revision: payload.revision,
        authority: payload.authority, sequence: event.sequence,
      });
      return;
    }
    case "goal.activated": {
      if (state.goals.has(payload.goalId)) throw new Error(`goal ${payload.goalId} already exists`);
      if (state.currentGoalId) {
        const prior = state.goals.get(state.currentGoalId);
        if (prior && prior.status === "active") prior.status = "suspended";
      }
      state.goals.set(payload.goalId, {
        goalId: payload.goalId, description: payload.description,
        activatedSequence: event.sequence, status: "active",
      });
      state.currentGoalId = payload.goalId;
      return;
    }
    case "goal.completed": {
      const goal = state.goals.get(payload.goalId);
      if (!goal || goal.status !== "active" || state.currentGoalId !== payload.goalId) {
        throw new Error(`goal ${payload.goalId} is not the active goal`);
      }
      goal.status = "completed";
      state.currentGoalId = null;
      return;
    }
    case "goal.suspended": {
      const goal = state.goals.get(payload.goalId);
      if (!goal || goal.status !== "active" || state.currentGoalId !== payload.goalId) {
        throw new Error(`goal ${payload.goalId} is not the active goal`);
      }
      goal.status = "suspended";
      state.currentGoalId = null;
      return;
    }
    case "goal.resumed": {
      const goal = state.goals.get(payload.goalId);
      if (!goal || goal.status !== "suspended") throw new Error(`goal ${payload.goalId} is not suspended`);
      if (state.currentGoalId) throw new Error(`cannot resume goal ${payload.goalId} while another goal is active`);
      goal.status = "active";
      state.currentGoalId = payload.goalId;
      return;
    }
    case "commitment.opened": {
      if (state.commitments.has(payload.commitmentId)) throw new Error(`commitment ${payload.commitmentId} already exists`);
      if (!state.goals.has(payload.goalId)) throw new Error(`commitment references missing goal ${payload.goalId}`);
      state.commitments.set(payload.commitmentId, {
        commitmentId: payload.commitmentId, goalId: payload.goalId, description: payload.description,
        openedSequence: event.sequence, resolution: null, resolvedSequence: null,
      });
      return;
    }
    case "commitment.resolved": {
      const commitment = state.commitments.get(payload.commitmentId);
      if (!commitment || commitment.resolution !== null) throw new Error(`commitment ${payload.commitmentId} is not open`);
      commitment.resolution = payload.resolution;
      commitment.resolvedSequence = event.sequence;
      return;
    }
    case "policy.advanced": {
      if (payload.epoch !== state.policy.epoch + 1) throw new Error("policy epoch must advance exactly once");
      state.policy = { epoch: payload.epoch, invariants: payload.invariants };
      return;
    }
    case "flow.checkpoint_recorded": {
      if (payload.goalId !== state.currentGoalId) {
        throw new Error("flow checkpoint must bind to the current goal");
      }
      const prior = state.flowCheckpoints.get(payload.goalId);
      if (prior) {
        if (prior.status === "completed" || prior.status === "failed") {
          throw new Error("terminal flow checkpoint cannot advance");
        }
        if (payload.runtimeDigest !== prior.runtimeDigest) {
          throw new Error("flow runtime digest cannot change within a goal");
        }
        if (payload.flowRevision <= prior.flowRevision) {
          throw new Error("flow revision must advance monotonically");
        }
        if (payload.capabilityEpoch < prior.capabilityEpoch) {
          throw new Error("flow capability epoch cannot move backwards");
        }
      }
      state.flowCheckpoints.set(payload.goalId, {
        goalId: payload.goalId,
        runtimeDigest: payload.runtimeDigest,
        flowRevision: payload.flowRevision,
        capabilityEpoch: payload.capabilityEpoch,
        status: payload.status,
        nodeId: payload.nodeId,
        currentStep: payload.currentStep,
        completedStepCount: payload.completedStepCount,
        unresolvedActionIds: Object.freeze([...payload.unresolvedActionIds]),
        stateDigest: payload.stateDigest,
        sequence: event.sequence,
      });
      return;
    }
    case "worker.spawned": {
      if (state.workers.has(payload.workerId)) throw new Error(`worker ${payload.workerId} already exists`);
      if (state.currentGoalId !== payload.goalId) throw new Error("worker must bind to the current goal");
      if (payload.policyEpoch !== state.policy.epoch) throw new Error("worker must bind to the current policy epoch");
      for (const dependency of payload.dependencies) {
        if (state.facts.get(dependency.key)?.revision !== dependency.revision) {
          throw new Error(`worker dependency ${dependency.key} is not current`);
        }
      }
      state.workers.set(payload.workerId, {
        workerId: payload.workerId, goalId: payload.goalId, purpose: payload.purpose,
        policyEpoch: payload.policyEpoch, dependencies: payload.dependencies,
        spawnedSequence: event.sequence, status: "running",
      });
      return;
    }
    case "worker.cancelled": {
      const worker = state.workers.get(payload.workerId);
      if (!worker || worker.status !== "running") throw new Error(`worker ${payload.workerId} is not running`);
      worker.status = "cancelled";
      return;
    }
    case "worker.result_delivered": {
      const logicalHash = sha256(canonicalJson(payload));
      const priorDelivery = state.logicalDeliveries.get(payload.deliveryId);
      if (priorDelivery) {
        if (priorDelivery.hash !== logicalHash) throw new Error(`delivery ${payload.deliveryId} replay changed content`);
        if (priorDelivery.status !== "deferred") {
          state.deliveries.push({
            deliveryId: payload.deliveryId, workerId: payload.workerId, eventId: event.eventId,
            status: "duplicate", reason: "logical delivery already reached a terminal decision", appliedSequence: null, logicalHash,
          });
          return;
        }
      }
      const worker = state.workers.get(payload.workerId);
      let status: WorkerDeliveryRecord["status"] = "accepted";
      let reason: string | null = null;
      if (!worker || worker.status !== "running") {
        status = "rejected";
        reason = "worker is missing or not running";
      } else if (payload.goalId !== worker.goalId) {
        status = "rejected";
        reason = "delivery goal differs from its worker contract";
      } else if (state.goals.get(worker.goalId)?.status === "suspended") {
        status = "deferred";
        reason = "worker goal is suspended";
      } else if (payload.goalId !== state.currentGoalId) {
        status = "rejected";
        reason = "worker goal is no longer active";
      } else if (payload.policyEpoch !== worker.policyEpoch || payload.policyEpoch !== state.policy.epoch) {
        status = "deferred";
        reason = "policy epoch changed while worker was running";
      } else if (!dependenciesMatch(payload.dependencyFactRevisions, worker.dependencies)) {
        status = "rejected";
        reason = "delivery dependency declaration differs from spawn contract";
      } else if (worker.dependencies.some(({ key, revision }) => state.facts.get(key)?.revision !== revision)) {
        status = "deferred";
        reason = "an authoritative dependency fact changed while worker was running";
      }
      const applied = status === "accepted";
      state.logicalDeliveries.set(payload.deliveryId, { hash: logicalHash, status });
      state.deliveries.push({
        deliveryId: payload.deliveryId, workerId: payload.workerId, eventId: event.eventId,
        status, reason, appliedSequence: applied ? event.sequence : null, logicalHash,
      });
      if (!applied || !worker) return;
      worker.status = "completed";
      for (const fact of payload.facts) {
        state.acceptedWorkerFacts.push({
          ...fact,
          workerId: payload.workerId,
          deliveryId: payload.deliveryId,
          goalId: payload.goalId,
          policyEpoch: payload.policyEpoch,
          dependencyFactRevisions: payload.dependencyFactRevisions,
          acceptedSequence: event.sequence,
        });
      }
      for (const advisory of payload.advisories) {
        state.advisories.push({
          episodeId: advisory.episodeId, text: advisory.text, source: "worker", sequence: event.sequence,
        });
      }
      return;
    }
    case "advisory.recorded": {
      state.advisories.push({
        episodeId: payload.episodeId, text: payload.summary, source: "model", sequence: event.sequence,
      });
      return;
    }
  }
}

/** Deterministically folds all current state from the validated event history. */
export function foldConversation(log: ConversationLog): ConversationState {
  validateConversationLog(log);
  const state = emptyMutableState();
  for (const event of log.events) applyEvent(state, event);
  const sortById = <T>(getId: (value: T) => string) => (left: T, right: T) => compareCodeUnits(getId(left), getId(right));
  const goals = [...state.goals.values()].sort(sortById(({ goalId }) => goalId));
  const flowCheckpoints = [...state.flowCheckpoints.values()].sort(sortById(({ goalId }) => goalId));
  return Object.freeze({
    facts: Object.freeze([...state.facts.values()].sort(sortById(({ key }) => key))),
    goals: Object.freeze(goals),
    currentGoal: state.currentGoalId ? goals.find(({ goalId }) => goalId === state.currentGoalId) ?? null : null,
    commitments: Object.freeze([...state.commitments.values()].sort(sortById(({ commitmentId }) => commitmentId))),
    policy: Object.freeze({ epoch: state.policy.epoch, invariants: Object.freeze([...state.policy.invariants]) }),
    flowCheckpoints: Object.freeze(flowCheckpoints),
    currentFlowCheckpoint: state.currentGoalId
      ? flowCheckpoints.find(({ goalId }) => goalId === state.currentGoalId) ?? null
      : null,
    workers: Object.freeze([...state.workers.values()].sort(sortById(({ workerId }) => workerId))),
    deliveries: Object.freeze([...state.deliveries]),
    acceptedWorkerFacts: Object.freeze([...state.acceptedWorkerFacts]),
    advisories: Object.freeze([...state.advisories]),
    headHash: log.events.at(-1)?.hash ?? GENESIS_HASH,
    eventCount: log.events.length,
  });
}

export interface ContextProjection {
  readonly schemaVersion: 1;
  readonly policyEpoch: number;
  readonly invariants: readonly z.infer<typeof InvariantSchema>[];
  readonly authoritativeFacts: readonly Pick<AuthoritativeFact, "key" | "value" | "revision">[];
  readonly currentGoal: Pick<ConversationGoal, "goalId" | "description"> | null;
  readonly currentFlowCheckpoint: Pick<FlowCheckpointRecord,
    "goalId" | "runtimeDigest" | "flowRevision" | "capabilityEpoch" | "status" |
    "nodeId" | "currentStep" | "completedStepCount" | "unresolvedActionIds" | "stateDigest"
  > | null;
  readonly openCommitments: readonly Pick<ConversationCommitment, "commitmentId" | "goalId" | "description">[];
  readonly currentGoalWorkers: readonly Pick<WorkerRecord, "workerId" | "purpose" | "status">[];
  readonly acceptedWorkerFacts: readonly Pick<AcceptedWorkerFact, "key" | "value" | "evidenceId" | "workerId">[];
  readonly recentAdvisoryEpisodes: readonly Pick<AdvisoryEpisode, "episodeId" | "text" | "source">[];
}

export interface ProjectedContext {
  readonly value: ContextProjection;
  readonly serialized: string;
  readonly byteLength: number;
}

export class ContextProjectionOverflowError extends Error {
  readonly code = "context_overflow" as const;
  readonly byteBudget: number;
  readonly requiredControlBytes: number;

  constructor(byteBudget: number, requiredControlBytes: number) {
    super(`mandatory conversation control state requires ${requiredControlBytes} bytes, exceeding budget ${byteBudget}`);
    this.name = "ContextProjectionOverflowError";
    this.byteBudget = byteBudget;
    this.requiredControlBytes = requiredControlBytes;
  }
}

function projectionBytes(value: ContextProjection): number {
  return utf8Bytes(canonicalJson(value));
}

/**
 * Produces a byte-bounded deterministic context view. Priority is invariant
 * policy, authoritative facts, current goal, open commitments, accepted worker
 * facts, then newest advisory summaries. No summary can enter the facts section.
 */
export function projectConversationContext(state: ConversationState, byteBudget: number): ProjectedContext {
  if (!Number.isSafeInteger(byteBudget) || byteBudget < MIN_CONTEXT_BYTES || byteBudget > MAX_CONTEXT_BYTES) {
    throw new Error(`context byte budget must be an integer from ${MIN_CONTEXT_BYTES} to ${MAX_CONTEXT_BYTES}`);
  }
  const projection: {
    schemaVersion: 1;
    policyEpoch: number;
    invariants: z.infer<typeof InvariantSchema>[];
    authoritativeFacts: Pick<AuthoritativeFact, "key" | "value" | "revision">[];
    currentGoal: Pick<ConversationGoal, "goalId" | "description"> | null;
    currentFlowCheckpoint: ContextProjection["currentFlowCheckpoint"];
    openCommitments: Pick<ConversationCommitment, "commitmentId" | "goalId" | "description">[];
    currentGoalWorkers: Pick<WorkerRecord, "workerId" | "purpose" | "status">[];
    acceptedWorkerFacts: Pick<AcceptedWorkerFact, "key" | "value" | "evidenceId" | "workerId">[];
    recentAdvisoryEpisodes: Pick<AdvisoryEpisode, "episodeId" | "text" | "source">[];
  } = {
    schemaVersion: 1,
    policyEpoch: state.policy.epoch,
    invariants: [],
    authoritativeFacts: [],
    currentGoal: null,
    currentFlowCheckpoint: null,
    openCommitments: [],
    currentGoalWorkers: [],
    acceptedWorkerFacts: [],
    recentAdvisoryEpisodes: [],
  };
  if (projectionBytes(projection) > byteBudget) throw new Error("context byte budget is too small for the kernel envelope");

  // Mandatory control state is atomic: omission would be silent guardrail loss.
  projection.invariants.push(...state.policy.invariants);
  projection.authoritativeFacts.push(...state.facts.map((fact) => ({
    key: fact.key, value: fact.value, revision: fact.revision,
  })));
  if (state.currentGoal) {
    projection.currentGoal = { goalId: state.currentGoal.goalId, description: state.currentGoal.description };
  }
  if (state.currentFlowCheckpoint) {
    const checkpoint = state.currentFlowCheckpoint;
    projection.currentFlowCheckpoint = {
      goalId: checkpoint.goalId,
      runtimeDigest: checkpoint.runtimeDigest,
      flowRevision: checkpoint.flowRevision,
      capabilityEpoch: checkpoint.capabilityEpoch,
      status: checkpoint.status,
      nodeId: checkpoint.nodeId,
      currentStep: checkpoint.currentStep,
      completedStepCount: checkpoint.completedStepCount,
      unresolvedActionIds: checkpoint.unresolvedActionIds,
      stateDigest: checkpoint.stateDigest,
    };
  }
  projection.openCommitments.push(...state.commitments
    .filter(({ resolution }) => resolution === null)
    .sort((left, right) => left.openedSequence - right.openedSequence || compareCodeUnits(left.commitmentId, right.commitmentId))
    .map((commitment) => ({
      commitmentId: commitment.commitmentId, goalId: commitment.goalId, description: commitment.description,
    })));
  if (state.currentGoal) {
    projection.currentGoalWorkers.push(...state.workers
      .filter(({ goalId }) => goalId === state.currentGoal?.goalId)
      .map(({ workerId, purpose, status }) => ({ workerId, purpose, status })));
  }
  const requiredControlBytes = projectionBytes(projection);
  if (requiredControlBytes > byteBudget) {
    throw new ContextProjectionOverflowError(byteBudget, requiredControlBytes);
  }

  const tryOptionalMutation = (apply: () => void, undo: () => void): void => {
    apply();
    if (projectionBytes(projection) > byteBudget) undo();
  };
  const latestWorkerFactByKey = new Map<string, AcceptedWorkerFact>();
  for (const fact of state.acceptedWorkerFacts) {
    const remainsCurrent = fact.goalId === state.currentGoal?.goalId &&
      fact.policyEpoch === state.policy.epoch &&
      fact.dependencyFactRevisions.every(({ key, revision }) =>
        state.facts.find((authoritative) => authoritative.key === key)?.revision === revision);
    if (remainsCurrent) latestWorkerFactByKey.set(fact.key, fact);
  }
  for (const fact of [...latestWorkerFactByKey.values()]
    .sort((left, right) => right.acceptedSequence - left.acceptedSequence || compareCodeUnits(left.key, right.key))) {
    const item = { key: fact.key, value: fact.value, evidenceId: fact.evidenceId, workerId: fact.workerId };
    tryOptionalMutation(() => projection.acceptedWorkerFacts.push(item), () => { projection.acceptedWorkerFacts.pop(); });
  }
  for (const episode of [...state.advisories]
    .sort((left, right) => right.sequence - left.sequence || compareCodeUnits(left.episodeId, right.episodeId))) {
    const item = { episodeId: episode.episodeId, text: episode.text, source: episode.source };
    tryOptionalMutation(() => projection.recentAdvisoryEpisodes.push(item), () => { projection.recentAdvisoryEpisodes.pop(); });
  }
  const serialized = canonicalJson(projection);
  return Object.freeze({ value: Object.freeze(projection), serialized, byteLength: utf8Bytes(serialized) });
}
