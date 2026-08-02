import { createHash } from "node:crypto";
import {
  CONVERSATION_PROGRAM_GENESIS_SHA256,
  CONVERSATION_PROGRAM_VERSION,
  ConversationProgramEventDraftSchema,
  ConversationProgramEventSchema,
  type ConversationProgramEvent,
  type ConversationProgramEventDraft,
  type ConversationProgramLog,
  type ProgramAuthority,
  type ProgramJson,
} from "./schema";

const MAX_EVENT_BYTES = 32 * 1_024;

export type ProgramGoalStatus = "queued" | "focused" | "suspended" | "completed";

export interface ProgramFact {
  readonly key: string;
  readonly value: ProgramJson;
  readonly revision: number;
  readonly authority: ProgramAuthority;
  readonly sequence: number;
}

export interface ProgramGoal {
  readonly goalId: string;
  readonly description: string;
  readonly status: ProgramGoalStatus;
  readonly openedSequence: number;
  readonly focusCount: number;
  readonly suspensionReason: string | null;
}

export interface ProgramFlowCheckpoint {
  readonly goalId: string;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly flowRevision: number;
  readonly capabilityEpoch: number;
  readonly status: "routing" | "active" | "completed" | "failed";
  readonly nodeId: string | null;
  readonly stepPath: string | null;
  readonly completedStepCount: number;
  readonly stateSha256: string;
  readonly sequence: number;
}

export interface ProgramObligation {
  readonly obligationId: string;
  readonly obligationType: string;
  readonly description: string;
  readonly owner: "agent" | "caller" | "human" | "system";
  readonly blocks: "goal_completion" | "program_completion" | "irreversible_actions";
  readonly goalId: string | null;
  readonly sourceId: string;
  readonly status: "open" | "satisfied" | "waived";
  readonly openedSequence: number;
  readonly settledSequence: number | null;
  readonly evidenceSha256: string | null;
}

export interface ProgramActionReservation {
  readonly reservationId: string;
  readonly goalId: string;
  readonly action: string;
  readonly argumentsSha256: string;
  readonly idempotencyKey: string;
  readonly capabilityEpoch: number;
  readonly authorityRevision: number;
  readonly reservedSequence: number;
  readonly status: "reserved" | "revoked" | "succeeded" | "failed" | "indeterminate" | "compensated";
  readonly receiptId: string | null;
}

export interface ProgramActionReceipt {
  readonly receiptId: string;
  readonly reservationId: string;
  readonly status: "succeeded" | "failed" | "indeterminate" | "compensated";
  readonly resultSha256: string | null;
  readonly evidenceSha256: string;
  readonly sequence: number;
}

export interface ProgramWorker {
  readonly workerId: string;
  readonly goalId: string;
  readonly purpose: string;
  readonly capabilityEpoch: number;
  readonly dependencies: readonly Readonly<{ key: string; revision: number }>[];
  readonly requiredForGoalCompletion: boolean;
  readonly spawnedSequence: number;
  readonly status: "running" | "delivered" | "superseded" | "cancelled";
}

export interface ProgramWorkerDelivery {
  readonly deliveryId: string;
  readonly workerId: string;
  readonly goalId: string;
  readonly resultSha256: string;
  readonly disposition: "accepted" | "rejected";
  readonly reason: string | null;
  readonly sequence: number;
}

export interface ProgramAudibilityFact {
  readonly responseId: string;
  readonly generatedThroughMs: number;
  readonly releasedThroughMs: number;
  readonly heardThroughMs: number;
  readonly unheardMs: number;
  readonly fullyHeard: boolean;
  readonly interrupted: boolean;
  readonly interruptionReason: string | null;
  readonly contentSha256: string;
  readonly generationEvidenceSha256: string;
  readonly releaseEvidenceSha256: string | null;
  readonly heardEvidenceSha256: string | null;
  readonly interruptionEvidenceSha256: string | null;
  readonly sequence: number;
}

export interface ConversationProgramProjection {
  readonly schemaVersion: typeof CONVERSATION_PROGRAM_VERSION;
  readonly programId: string;
  readonly revision: number;
  readonly headSha256: string;
  readonly facts: readonly ProgramFact[];
  readonly goals: readonly ProgramGoal[];
  readonly focusedGoal: ProgramGoal | null;
  readonly flowCheckpoints: readonly ProgramFlowCheckpoint[];
  readonly obligations: readonly ProgramObligation[];
  readonly capabilityEpoch: number;
  readonly capabilityGoalId: string | null;
  readonly capabilities: readonly string[];
  readonly actionReservations: readonly ProgramActionReservation[];
  readonly actionReceipts: readonly ProgramActionReceipt[];
  readonly workers: readonly ProgramWorker[];
  readonly workerDeliveries: readonly ProgramWorkerDelivery[];
  readonly audibilityFacts: readonly ProgramAudibilityFact[];
}

type MutableGoal = Omit<ProgramGoal, "status" | "focusCount" | "suspensionReason"> & {
  status: ProgramGoalStatus;
  focusCount: number;
  suspensionReason: string | null;
};
type MutableObligation = Omit<ProgramObligation, "status" | "settledSequence" | "evidenceSha256"> & {
  status: ProgramObligation["status"];
  settledSequence: number | null;
  evidenceSha256: string | null;
};
type MutableReservation = Omit<ProgramActionReservation, "status" | "receiptId"> & {
  status: ProgramActionReservation["status"];
  receiptId: string | null;
};
type MutableWorker = Omit<ProgramWorker, "status"> & { status: ProgramWorker["status"] };
type MutableAudibility = Omit<ProgramAudibilityFact,
  "unheardMs" | "fullyHeard" | "releasedThroughMs" | "heardThroughMs" | "interrupted" |
  "interruptionReason" | "releaseEvidenceSha256" | "heardEvidenceSha256" |
  "interruptionEvidenceSha256" | "sequence"
> & {
  releasedThroughMs: number;
  heardThroughMs: number;
  interrupted: boolean;
  interruptionReason: string | null;
  releaseEvidenceSha256: string | null;
  heardEvidenceSha256: string | null;
  interruptionEvidenceSha256: string | null;
  sequence: number;
};

interface MutableProjection {
  facts: Map<string, ProgramFact>;
  goals: Map<string, MutableGoal>;
  focusedGoalId: string | null;
  flowCheckpoints: Map<string, ProgramFlowCheckpoint>;
  obligations: Map<string, MutableObligation>;
  capabilityEpoch: number;
  capabilityGoalId: string | null;
  capabilities: string[];
  reservations: Map<string, MutableReservation>;
  idempotencyKeys: Map<string, string>;
  receipts: Map<string, ProgramActionReceipt>;
  workers: Map<string, MutableWorker>;
  deliveries: Map<string, ProgramWorkerDelivery>;
  audibility: Map<string, MutableAudibility>;
}

function emptyProjection(): MutableProjection {
  return {
    facts: new Map(), goals: new Map(), focusedGoalId: null, flowCheckpoints: new Map(),
    obligations: new Map(), capabilityEpoch: 0, capabilityGoalId: null, capabilities: [], reservations: new Map(),
    idempotencyKeys: new Map(), receipts: new Map(), workers: new Map(), deliveries: new Map(),
    audibility: new Map(),
  };
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** RFC-8785-like canonical JSON for the bounded JSON subset used by this reducer. */
export function canonicalProgramJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical program JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalProgramJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareIds).map((key) => {
      if (record[key] === undefined) throw new Error("canonical program JSON rejects undefined");
      return `${JSON.stringify(key)}:${canonicalProgramJson(record[key])}`;
    }).join(",")}}`;
  }
  throw new Error(`canonical program JSON rejects ${typeof value}`);
}

function sha256(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\n${canonicalProgramJson(value)}`, "utf8")
    .digest("hex");
}

function eventDigest(event: Omit<ConversationProgramEvent, "eventSha256">): string {
  return sha256("hacc/conversation-program-event/v1", event);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function dependenciesEqual(
  left: readonly Readonly<{ key: string; revision: number }>[],
  right: readonly Readonly<{ key: string; revision: number }>[],
): boolean {
  const normalized = (items: readonly Readonly<{ key: string; revision: number }>[]) =>
    [...items].sort((a, b) => compareIds(a.key, b.key));
  return canonicalProgramJson(normalized(left)) === canonicalProgramJson(normalized(right));
}

function requireFocusedGoal(state: MutableProjection, goalId: string, purpose: string): MutableGoal {
  const goal = state.goals.get(goalId);
  if (!goal || goal.status !== "focused" || state.focusedGoalId !== goalId) {
    throw new Error(`${purpose} requires focused goal ${goalId}`);
  }
  return goal;
}

function revokeReservedActions(state: MutableProjection): void {
  for (const reservation of state.reservations.values()) {
    if (reservation.status === "reserved") reservation.status = "revoked";
  }
}

/** Every focus boundary revokes the previous dynamic frontier before another event can run. */
function invalidateCapabilityFrontier(state: MutableProjection): void {
  revokeReservedActions(state);
  state.capabilityEpoch += 1;
  state.capabilityGoalId = null;
  state.capabilities = [];
}

/** Facts are conservative authority inputs until the capability compiler records dependencies. */
function invalidateActiveFrontierForFactMutation(state: MutableProjection): void {
  if (state.capabilityGoalId !== null || state.capabilities.length > 0) invalidateCapabilityFrontier(state);
}

function supersedeWorkersDependingOnFact(state: MutableProjection, key: string): void {
  for (const worker of state.workers.values()) {
    if ((worker.status === "running" || worker.status === "delivered") &&
        worker.dependencies.some((dependency) => dependency.key === key)) {
      worker.status = "superseded";
    }
  }
}

function applyEvent(state: MutableProjection, event: ConversationProgramEvent): void {
  if (event.expectedRevision !== event.sequence - 1) {
    throw new Error(`event ${event.eventId} has a stale program revision`);
  }
  const payload = event.payload;
  switch (payload.type) {
    case "fact.asserted": {
      if (state.facts.has(payload.key)) throw new Error(`fact ${payload.key} already exists; correct it instead`);
      state.facts.set(payload.key, {
        key: payload.key, value: payload.value, revision: 1, authority: payload.authority, sequence: event.sequence,
      });
      invalidateActiveFrontierForFactMutation(state);
      return;
    }
    case "fact.corrected": {
      const current = state.facts.get(payload.key);
      if (!current) throw new Error(`cannot correct missing fact ${payload.key}`);
      if (payload.expectedFactRevision !== current.revision) {
        throw new Error(`fact ${payload.key} correction is stale`);
      }
      state.facts.set(payload.key, {
        key: payload.key, value: payload.value, revision: current.revision + 1,
        authority: payload.authority, sequence: event.sequence,
      });
      supersedeWorkersDependingOnFact(state, payload.key);
      invalidateActiveFrontierForFactMutation(state);
      return;
    }
    case "goal.opened": {
      if (state.goals.has(payload.goalId)) throw new Error(`goal ${payload.goalId} already exists`);
      state.goals.set(payload.goalId, {
        goalId: payload.goalId, description: payload.description, status: "queued",
        openedSequence: event.sequence, focusCount: 0, suspensionReason: null,
      });
      return;
    }
    case "goal.focused": {
      const target = state.goals.get(payload.goalId);
      if (!target || (target.status !== "queued" && target.status !== "suspended")) {
        throw new Error(`goal ${payload.goalId} is not focusable`);
      }
      if (state.focusedGoalId) {
        const previous = state.goals.get(state.focusedGoalId)!;
        previous.status = "suspended";
        previous.suspensionReason = `focus_replaced:${payload.goalId}`;
      }
      target.status = "focused";
      target.focusCount += 1;
      target.suspensionReason = null;
      state.focusedGoalId = payload.goalId;
      invalidateCapabilityFrontier(state);
      return;
    }
    case "goal.suspended": {
      const goal = requireFocusedGoal(state, payload.goalId, "goal suspension");
      goal.status = "suspended";
      goal.suspensionReason = payload.reason;
      state.focusedGoalId = null;
      invalidateCapabilityFrontier(state);
      return;
    }
    case "goal.completed": {
      const goal = requireFocusedGoal(state, payload.goalId, "goal completion");
      const blocker = [...state.obligations.values()].find((obligation) =>
        obligation.status === "open" &&
        (obligation.goalId === null || obligation.goalId === payload.goalId));
      if (blocker) throw new Error(`goal ${payload.goalId} is blocked by obligation ${blocker.obligationId}`);
      const checkpoint = state.flowCheckpoints.get(payload.goalId);
      if (checkpoint && checkpoint.status !== "completed") {
        throw new Error(`goal ${payload.goalId} has a non-terminal-success flow checkpoint`);
      }
      if (checkpoint && checkpoint.capabilityEpoch !== state.capabilityEpoch) {
        throw new Error(`goal ${payload.goalId} flow checkpoint capability epoch is stale`);
      }
      const unresolvedEffect = [...state.reservations.values()].find((reservation) =>
        reservation.goalId === payload.goalId &&
        (reservation.status === "reserved" || reservation.status === "indeterminate"));
      if (unresolvedEffect) {
        throw new Error(`goal ${payload.goalId} has unresolved effect ${unresolvedEffect.reservationId}`);
      }
      const incompleteWorker = [...state.workers.values()].find((worker) =>
        worker.goalId === payload.goalId && worker.requiredForGoalCompletion && worker.status !== "delivered");
      if (incompleteWorker) {
        throw new Error(`goal ${payload.goalId} has incomplete required worker ${incompleteWorker.workerId}`);
      }
      goal.status = "completed";
      goal.suspensionReason = null;
      state.focusedGoalId = null;
      invalidateCapabilityFrontier(state);
      return;
    }
    case "flow.checkpoint_recorded": {
      requireFocusedGoal(state, payload.goalId, "flow checkpoint");
      if (payload.capabilityEpoch !== state.capabilityEpoch) {
        throw new Error("flow checkpoint capability epoch is stale");
      }
      const current = state.flowCheckpoints.get(payload.goalId);
      if (current) {
        if (current.status === "completed" || current.status === "failed") {
          throw new Error("terminal flow checkpoint cannot advance");
        }
        if (current.flowId !== payload.flowId || current.flowVersion !== payload.flowVersion) {
          throw new Error("flow identity cannot change within a goal");
        }
        if (payload.flowRevision <= current.flowRevision) throw new Error("flow revision must increase");
      }
      state.flowCheckpoints.set(payload.goalId, {
        goalId: payload.goalId, flowId: payload.flowId, flowVersion: payload.flowVersion,
        flowRevision: payload.flowRevision, capabilityEpoch: payload.capabilityEpoch,
        status: payload.status, nodeId: payload.nodeId, stepPath: payload.stepPath,
        completedStepCount: payload.completedStepCount, stateSha256: payload.stateSha256,
        sequence: event.sequence,
      });
      return;
    }
    case "obligation.opened": {
      if (state.obligations.has(payload.obligationId)) throw new Error(`obligation ${payload.obligationId} already exists`);
      if (payload.goalId !== null && !state.goals.has(payload.goalId)) {
        throw new Error(`obligation references missing goal ${payload.goalId}`);
      }
      state.obligations.set(payload.obligationId, {
        obligationId: payload.obligationId, obligationType: payload.obligationType,
        description: payload.description, owner: payload.owner, blocks: payload.blocks,
        goalId: payload.goalId, sourceId: payload.sourceId, status: "open",
        openedSequence: event.sequence, settledSequence: null, evidenceSha256: null,
      });
      return;
    }
    case "obligation.settled": {
      const obligation = state.obligations.get(payload.obligationId);
      if (!obligation || obligation.status !== "open") {
        throw new Error(`obligation ${payload.obligationId} is not open`);
      }
      obligation.status = payload.disposition;
      obligation.settledSequence = event.sequence;
      obligation.evidenceSha256 = payload.evidenceSha256;
      return;
    }
    case "capability_epoch.advanced": {
      if (state.focusedGoalId === null) throw new Error("capabilities require a focused goal");
      if (payload.expectedEpoch !== state.capabilityEpoch || payload.epoch !== state.capabilityEpoch + 1) {
        throw new Error("capability epoch is stale or non-contiguous");
      }
      revokeReservedActions(state);
      state.capabilityEpoch = payload.epoch;
      state.capabilityGoalId = state.focusedGoalId;
      state.capabilities = [...payload.capabilities].sort(compareIds);
      return;
    }
    case "action.reserved": {
      requireFocusedGoal(state, payload.goalId, "action reservation");
      if (payload.authorityRevision !== event.expectedRevision) {
        throw new Error("action reservation authority revision is stale");
      }
      if (payload.capabilityEpoch !== state.capabilityEpoch) {
        throw new Error("action reservation capability epoch is stale");
      }
      if (state.capabilityGoalId !== payload.goalId) throw new Error("action capability frontier belongs to another goal");
      if (!state.capabilities.includes(payload.action)) throw new Error(`action ${payload.action} is not currently capable`);
      if (state.reservations.has(payload.reservationId)) throw new Error(`reservation ${payload.reservationId} already exists`);
      const priorReservation = state.idempotencyKeys.get(payload.idempotencyKey);
      if (priorReservation) throw new Error(`idempotency key already belongs to reservation ${priorReservation}`);
      state.reservations.set(payload.reservationId, {
        reservationId: payload.reservationId, goalId: payload.goalId, action: payload.action,
        argumentsSha256: payload.argumentsSha256, idempotencyKey: payload.idempotencyKey,
        capabilityEpoch: payload.capabilityEpoch, authorityRevision: payload.authorityRevision,
        reservedSequence: event.sequence, status: "reserved", receiptId: null,
      });
      state.idempotencyKeys.set(payload.idempotencyKey, payload.reservationId);
      return;
    }
    case "action.receipt_recorded": {
      if (state.receipts.has(payload.receiptId)) throw new Error(`receipt ${payload.receiptId} already exists`);
      const reservation = state.reservations.get(payload.reservationId);
      if (!reservation || reservation.status !== "reserved") {
        throw new Error(`reservation ${payload.reservationId} is not unsettled`);
      }
      reservation.status = payload.status;
      reservation.receiptId = payload.receiptId;
      state.receipts.set(payload.receiptId, {
        receiptId: payload.receiptId, reservationId: payload.reservationId, status: payload.status,
        resultSha256: payload.resultSha256, evidenceSha256: payload.evidenceSha256, sequence: event.sequence,
      });
      return;
    }
    case "worker.spawned": {
      requireFocusedGoal(state, payload.goalId, "worker spawn");
      if (state.workers.has(payload.workerId)) throw new Error(`worker ${payload.workerId} already exists`);
      if (payload.capabilityEpoch !== state.capabilityEpoch) throw new Error("worker capability epoch is stale");
      if (state.capabilityGoalId !== payload.goalId) throw new Error("worker capability frontier belongs to another goal");
      for (const dependency of payload.dependencies) {
        if (state.facts.get(dependency.key)?.revision !== dependency.revision) {
          throw new Error(`worker dependency ${dependency.key} is stale`);
        }
      }
      state.workers.set(payload.workerId, {
        workerId: payload.workerId, goalId: payload.goalId, purpose: payload.purpose,
        capabilityEpoch: payload.capabilityEpoch, dependencies: Object.freeze([...payload.dependencies]),
        requiredForGoalCompletion: payload.requiredForGoalCompletion,
        spawnedSequence: event.sequence, status: "running",
      });
      return;
    }
    case "worker.delivery_recorded": {
      if (state.deliveries.has(payload.deliveryId)) throw new Error(`delivery ${payload.deliveryId} already exists`);
      const worker = state.workers.get(payload.workerId);
      let reason: string | null = null;
      if (!worker || worker.status !== "running") reason = "worker is missing or no longer running";
      else if (payload.goalId !== worker.goalId) reason = "goal binding changed";
      else if (state.goals.get(worker.goalId)?.status !== "focused" || state.focusedGoalId !== worker.goalId) {
        reason = "worker goal is no longer focused";
      } else if (payload.capabilityEpoch !== worker.capabilityEpoch || payload.capabilityEpoch !== state.capabilityEpoch) {
        reason = "capability epoch changed";
      } else if (state.capabilityGoalId !== payload.goalId) {
        reason = "capability frontier belongs to another goal";
      } else if (!dependenciesEqual(payload.dependencyFactRevisions, worker.dependencies)) {
        reason = "dependency declaration changed";
      } else if (worker.dependencies.some(({ key, revision }) => state.facts.get(key)?.revision !== revision)) {
        reason = "dependency fact revision changed";
      }
      const disposition = reason === null ? "accepted" : "rejected";
      state.deliveries.set(payload.deliveryId, {
        deliveryId: payload.deliveryId, workerId: payload.workerId, goalId: payload.goalId,
        resultSha256: payload.resultSha256, disposition, reason, sequence: event.sequence,
      });
      if (worker) worker.status = disposition === "accepted" ? "delivered" : "superseded";
      return;
    }
    case "worker.cancelled": {
      const worker = state.workers.get(payload.workerId);
      if (!worker || worker.status !== "running") throw new Error(`worker ${payload.workerId} is not running`);
      worker.status = "cancelled";
      return;
    }
    case "audibility.response_registered": {
      if (state.audibility.has(payload.responseId)) throw new Error(`response ${payload.responseId} already exists`);
      state.audibility.set(payload.responseId, {
        responseId: payload.responseId, generatedThroughMs: payload.generatedThroughMs,
        releasedThroughMs: 0, heardThroughMs: 0, interrupted: false, interruptionReason: null,
        contentSha256: payload.contentSha256, generationEvidenceSha256: payload.evidenceSha256,
        releaseEvidenceSha256: null, heardEvidenceSha256: null, interruptionEvidenceSha256: null,
        sequence: event.sequence,
      });
      return;
    }
    case "audibility.released_through": {
      const response = state.audibility.get(payload.responseId);
      if (!response) throw new Error(`response ${payload.responseId} is not registered`);
      if (response.interrupted) throw new Error("interrupted response cannot release more audio");
      if (payload.throughMs < response.releasedThroughMs || payload.throughMs > response.generatedThroughMs) {
        throw new Error("released audio boundary is non-monotonic or exceeds generation");
      }
      response.releasedThroughMs = payload.throughMs;
      response.releaseEvidenceSha256 = payload.evidenceSha256;
      response.sequence = event.sequence;
      return;
    }
    case "audibility.heard_through": {
      const response = state.audibility.get(payload.responseId);
      if (!response) throw new Error(`response ${payload.responseId} is not registered`);
      if (response.interrupted) throw new Error("interrupted response cannot advance caller playback");
      if (payload.throughMs < response.heardThroughMs || payload.throughMs > response.releasedThroughMs) {
        throw new Error("heard audio boundary is non-monotonic or exceeds released audio");
      }
      response.heardThroughMs = payload.throughMs;
      response.heardEvidenceSha256 = payload.evidenceSha256;
      response.sequence = event.sequence;
      return;
    }
    case "audibility.interrupted": {
      const response = state.audibility.get(payload.responseId);
      if (!response) throw new Error(`response ${payload.responseId} is not registered`);
      if (response.interrupted) throw new Error("response is already interrupted");
      if (payload.heardThroughMs < response.heardThroughMs || payload.heardThroughMs > response.releasedThroughMs) {
        throw new Error("interruption heard boundary must be within released audio");
      }
      response.heardThroughMs = payload.heardThroughMs;
      response.heardEvidenceSha256 = payload.evidenceSha256;
      response.interrupted = true;
      response.interruptionReason = payload.reason;
      response.interruptionEvidenceSha256 = payload.evidenceSha256;
      response.sequence = event.sequence;
      return;
    }
  }
}

export function createConversationProgramLog(programId: string): ConversationProgramLog {
  const probe = ConversationProgramEventSchema.shape.programId.parse(programId);
  return freezeDeep({ schemaVersion: CONVERSATION_PROGRAM_VERSION, programId: probe, events: [] });
}

export function validateConversationProgramLog(log: ConversationProgramLog): void {
  if (log.schemaVersion !== CONVERSATION_PROGRAM_VERSION) throw new Error("unsupported conversation program version");
  const programId = ConversationProgramEventSchema.shape.programId.parse(log.programId);
  const seen = new Set<string>();
  let previousSha256 = CONVERSATION_PROGRAM_GENESIS_SHA256;
  const state = emptyProjection();
  for (const [index, candidate] of log.events.entries()) {
    const event = ConversationProgramEventSchema.parse(candidate);
    if (event.programId !== programId) throw new Error(`event ${event.eventId} belongs to another program`);
    if (event.sequence !== index + 1) throw new Error(`event ${event.eventId} has a non-contiguous sequence`);
    if (event.previousSha256 !== previousSha256) throw new Error(`event ${event.eventId} breaks the hash chain`);
    if (seen.has(event.eventId)) throw new Error(`duplicate event id ${event.eventId}`);
    const { eventSha256, ...unsigned } = event;
    if (eventDigest(unsigned) !== eventSha256) throw new Error(`event ${event.eventId} has an invalid digest`);
    applyEvent(state, event);
    seen.add(event.eventId);
    previousSha256 = eventSha256;
  }
}

export function appendConversationProgramEvent(
  log: ConversationProgramLog,
  draft: ConversationProgramEventDraft,
): ConversationProgramLog {
  return appendConversationProgramEvents(log, [draft]);
}

export function appendConversationProgramEvents(
  log: ConversationProgramLog,
  drafts: readonly ConversationProgramEventDraft[],
): ConversationProgramLog {
  validateConversationProgramLog(log);
  const state = emptyProjection();
  for (const event of log.events) applyEvent(state, event);
  const events = [...log.events];
  const byId = new Map(events.map((event) => [event.eventId, event]));
  let appended = false;
  for (const input of drafts) {
    const draft = ConversationProgramEventDraftSchema.parse(input);
    const existing = byId.get(draft.eventId);
    if (existing) {
      const priorDraft = {
        eventId: existing.eventId, expectedRevision: existing.expectedRevision,
        occurredAt: existing.occurredAt, payload: existing.payload,
      };
      if (canonicalProgramJson(priorDraft) !== canonicalProgramJson(draft)) {
        throw new Error(`conflicting replay for event ${draft.eventId}`);
      }
      continue;
    }
    if (draft.expectedRevision !== events.length) {
      throw new Error(`stale program revision: expected ${events.length}, received ${draft.expectedRevision}`);
    }
    const unsigned = {
      schemaVersion: CONVERSATION_PROGRAM_VERSION,
      programId: log.programId,
      sequence: events.length + 1,
      previousSha256: events.at(-1)?.eventSha256 ?? CONVERSATION_PROGRAM_GENESIS_SHA256,
      ...draft,
    } as const;
    const event = ConversationProgramEventSchema.parse({ ...unsigned, eventSha256: eventDigest(unsigned) });
    if (Buffer.byteLength(canonicalProgramJson(event), "utf8") > MAX_EVENT_BYTES) {
      throw new Error(`event ${event.eventId} exceeds ${MAX_EVENT_BYTES} bytes`);
    }
    applyEvent(state, event);
    const frozen = freezeDeep(event);
    events.push(frozen);
    byId.set(event.eventId, frozen);
    appended = true;
  }
  return appended
    ? freezeDeep({ schemaVersion: CONVERSATION_PROGRAM_VERSION, programId: log.programId, events })
    : log;
}

export function foldConversationProgram(log: ConversationProgramLog): ConversationProgramProjection {
  validateConversationProgramLog(log);
  const state = emptyProjection();
  for (const event of log.events) applyEvent(state, event);
  const by = <T>(key: (item: T) => string) => (left: T, right: T) => compareIds(key(left), key(right));
  const goals = [...state.goals.values()].sort(by(({ goalId }) => goalId));
  const audibilityFacts = [...state.audibility.values()]
    .sort(by(({ responseId }) => responseId))
    .map((response): ProgramAudibilityFact => ({
      ...response,
      unheardMs: response.generatedThroughMs - response.heardThroughMs,
      fullyHeard: response.heardThroughMs === response.generatedThroughMs,
    }));
  return freezeDeep({
    schemaVersion: CONVERSATION_PROGRAM_VERSION,
    programId: log.programId,
    revision: log.events.length,
    headSha256: log.events.at(-1)?.eventSha256 ?? CONVERSATION_PROGRAM_GENESIS_SHA256,
    facts: [...state.facts.values()].sort(by(({ key }) => key)),
    goals,
    focusedGoal: state.focusedGoalId ? goals.find(({ goalId }) => goalId === state.focusedGoalId) ?? null : null,
    flowCheckpoints: [...state.flowCheckpoints.values()].sort(by(({ goalId }) => goalId)),
    obligations: [...state.obligations.values()].sort(by(({ obligationId }) => obligationId)),
    capabilityEpoch: state.capabilityEpoch,
    capabilityGoalId: state.capabilityGoalId,
    capabilities: [...state.capabilities],
    actionReservations: [...state.reservations.values()].sort(by(({ reservationId }) => reservationId)),
    actionReceipts: [...state.receipts.values()].sort(by(({ receiptId }) => receiptId)),
    workers: [...state.workers.values()].sort(by(({ workerId }) => workerId)),
    workerDeliveries: [...state.deliveries.values()].sort(by(({ deliveryId }) => deliveryId)),
    audibilityFacts,
  });
}

/** Stable digest used to prove crash/replay convergence of the complete canonical projection. */
export function conversationProgramDigest(
  value: ConversationProgramProjection | ConversationProgramLog,
): string {
  const projection = "events" in value ? foldConversationProgram(value) : value;
  return sha256("hacc/conversation-program-projection/v1", projection);
}
