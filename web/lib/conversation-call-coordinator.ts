import { createHash } from "node:crypto";
import {
  ConversationEventPayloadSchema,
  canonicalJson,
  foldConversation,
  type ConversationEvent,
  type ConversationEventPayload,
  type ConversationState,
} from "./conversation-kernel";
import {
  createFlowCheckpointEvent,
  type FlowConversationCheckpointInput,
} from "./flow-conversation-adapter";
import type {
  ConversationRuntime,
  ConversationRuntimeHead,
  ConversationRuntimeScope,
  ConversationTransactionResult,
  PlannedConversationEvent,
} from "./conversation-runtime";
import type {
  AudibleTurn,
  CompiledRealtimeContextPacket,
  RealtimePacketCapability,
} from "./realtime-context-packet";

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_OPERATIONS_PER_PHASE = 64;

export type ConversationCallDurableOperation = Readonly<{
  operationId: string;
  payload: ConversationEventPayload;
  occurredAtMs?: number;
}>;

export type ConversationCallFlowCheckpoint = Omit<
  FlowConversationCheckpointInput,
  "eventId" | "occurredAtMs"
> & Readonly<{ operationId: string; occurredAtMs?: number }>;

export type ConversationCallActionOperation<TRequest> = Readonly<{
  operationId: string;
  request: TRequest;
}>;

export type ConversationCallWorkerOperation<TRequest> = Readonly<{
  operationId: string;
  occurredAtMs?: number;
  request: TRequest;
}>;

export type ConversationCallOperationAuthority = Readonly<{
  scope: ConversationRuntimeScope;
  turnId: string;
  operationId: string;
  idempotencyKey: string;
  deterministicUuid: string;
  conversation: Readonly<{
    head: ConversationRuntimeHead;
    state: ConversationState;
  }>;
}>;

export interface ConversationCallActionAuthority<TRequest, TResult> {
  /**
   * Admit or reject an action. Implementations must reserve authority only;
   * dispatch remains a separate crash-aware boundary.
   */
  reserve(input: ConversationCallOperationAuthority & Readonly<{ request: TRequest }>): Promise<TResult>;
}

export interface ConversationCallWorkerStore<TRequest, TResult> {
  /**
   * Persist the worker and the supplied worker.spawned event as one idempotent
   * transition. The returned event must be present in the shared conversation
   * log before this promise resolves.
   */
  spawn(input: ConversationCallOperationAuthority & Readonly<{
    eventId: string;
    occurredAtMs: number;
    request: TRequest;
  }>): Promise<Readonly<{ event: ConversationEvent; value: TResult }>>;
}

export type ConversationCallTurn<TActionRequest, TWorkerRequest> = Readonly<{
  scope: ConversationRuntimeScope;
  turnId: string;
  occurredAtMs: number;
  durableEvents?: readonly ConversationCallDurableOperation[];
  flowCheckpoint?: ConversationCallFlowCheckpoint;
  actions?: readonly ConversationCallActionOperation<TActionRequest>[];
  workers?: readonly ConversationCallWorkerOperation<TWorkerRequest>[];
  packet: Readonly<{
    capabilityCatalogDigest: string;
    capabilityEpoch: number;
    capabilities: readonly RealtimePacketCapability[];
    recentAudibleTurns: readonly AudibleTurn[];
    byteBudget: number;
  }>;
}>;

export type ConversationCallActionOutcome<TResult> = Readonly<{
  operationId: string;
  idempotencyKey: string;
  deterministicUuid: string;
  value: TResult;
}>;

export type ConversationCallWorkerOutcome<TResult> = Readonly<{
  operationId: string;
  idempotencyKey: string;
  deterministicUuid: string;
  event: ConversationEvent;
  disposition: "spawned" | "replayed";
  value?: TResult;
}>;

export type ConversationCallTurnResult<TActionResult, TWorkerResult> = Readonly<{
  turnId: string;
  planDigest: string;
  durable: ConversationTransactionResult<null>;
  actions: readonly ConversationCallActionOutcome<TActionResult>[];
  workers: readonly ConversationCallWorkerOutcome<TWorkerResult>[];
  packet: CompiledRealtimeContextPacket;
}>;

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function assertOperationId(value: string, label: string): void {
  if (!OPERATION_ID.test(value)) throw new Error(`${label} must be a bounded operation identity`);
}

function assertUniqueOperations(
  operations: readonly Readonly<{ operationId: string }>[],
  label: string,
): void {
  if (operations.length > MAX_OPERATIONS_PER_PHASE) {
    throw new Error(`${label} cannot exceed ${MAX_OPERATIONS_PER_PHASE} operations`);
  }
  for (const operation of operations) assertOperationId(operation.operationId, `${label} operationId`);
  const identities = operations.map(({ operationId }) => operationId);
  if (new Set(identities).size !== identities.length) {
    throw new Error(`${label} operation identities must be unique`);
  }
}

function operationDigest(
  scope: ConversationRuntimeScope,
  turnId: string,
  phase: string,
  operationId: string,
): string {
  return digest({
    schemaVersion: 1,
    scope,
    turnId,
    phase,
    operationId,
  });
}

function eventIdentity(
  scope: ConversationRuntimeScope,
  turnId: string,
  phase: string,
  operationId: string,
): string {
  return `cc-${operationDigest(scope, turnId, phase, operationId)}`;
}

function operationAuthority(
  input: Readonly<{
    scope: ConversationRuntimeScope;
    turnId: string;
    phase: string;
    operationId: string;
    state: ConversationState;
  }>,
): ConversationCallOperationAuthority {
  const sha256 = operationDigest(input.scope, input.turnId, input.phase, input.operationId);
  return Object.freeze({
    scope: input.scope,
    turnId: input.turnId,
    operationId: input.operationId,
    idempotencyKey: `cc:${sha256}`,
    deterministicUuid: [
      sha256.slice(0, 8),
      sha256.slice(8, 12),
      `5${sha256.slice(13, 16)}`,
      `${((Number.parseInt(sha256.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${sha256.slice(18, 20)}`,
      sha256.slice(20, 32),
    ].join("-"),
    conversation: Object.freeze({
      head: Object.freeze({
        sequence: input.state.eventCount,
        sha256: input.state.headHash,
      }),
      state: input.state,
    }),
  });
}

function planDigest<TActionRequest, TWorkerRequest>(
  input: ConversationCallTurn<TActionRequest, TWorkerRequest>,
): string {
  return digest({
    schemaVersion: 1,
    scope: input.scope,
    turnId: input.turnId,
    occurredAtMs: input.occurredAtMs,
    durableEvents: (input.durableEvents ?? []).map(({ operationId, payload, occurredAtMs }) => ({
      operationId,
      payload,
      occurredAtMs: occurredAtMs ?? input.occurredAtMs,
    })),
    flowCheckpoint: input.flowCheckpoint ? {
      ...input.flowCheckpoint,
      occurredAtMs: input.flowCheckpoint.occurredAtMs ?? input.occurredAtMs,
    } : null,
    actions: (input.actions ?? []).map(({ operationId, request }) => ({ operationId, request })),
    workers: (input.workers ?? []).map(({ operationId, occurredAtMs, request }) => ({
      operationId,
      occurredAtMs: occurredAtMs ?? input.occurredAtMs,
      request,
    })),
    packet: input.packet,
  });
}

/**
 * Coordinates one host-authority turn without making a model or provider the
 * owner of durable state.
 *
 * Phase order is fixed:
 * 1. append caller/host facts and the Flow checkpoint in one kernel batch;
 * 2. reserve action authority (never dispatch the leaf action here);
 * 3. atomically append each worker.spawned transition;
 * 4. compile the provider-neutral packet from the resulting durable head.
 *
 * Every identity is derived from scope + turn + phase + operation. Retrying
 * after any crash therefore replays the same event, action reservation, or
 * worker spawn. A same-identity mutation is rejected by the underlying stores.
 */
export function defineConversationCallCoordinator<
  TActionRequest = never,
  TActionResult = never,
  TWorkerRequest = never,
  TWorkerResult = never,
>(input: Readonly<{
  runtime: ConversationRuntime;
  actionAuthority?: ConversationCallActionAuthority<TActionRequest, TActionResult>;
  workerStore?: ConversationCallWorkerStore<TWorkerRequest, TWorkerResult>;
}>) {
  return Object.freeze({
    async runTurn(
      turn: ConversationCallTurn<TActionRequest, TWorkerRequest>,
    ): Promise<ConversationCallTurnResult<TActionResult, TWorkerResult>> {
      assertOperationId(turn.turnId, "turnId");
      if (!Number.isSafeInteger(turn.occurredAtMs) || turn.occurredAtMs < 0) {
        throw new Error("turn timestamp must be a safe non-negative integer");
      }
      if (!turn.scope.conversationId || !turn.scope.organizationId) {
        throw new Error("conversation coordinator requires conversation and organization scope");
      }

      const durableEvents = turn.durableEvents ?? [];
      const actions = turn.actions ?? [];
      const workers = turn.workers ?? [];
      assertUniqueOperations(durableEvents, "durable event");
      assertUniqueOperations(actions, "action");
      assertUniqueOperations(workers, "worker");
      if (turn.flowCheckpoint) assertOperationId(turn.flowCheckpoint.operationId, "flow checkpoint operationId");
      if (actions.length > 0 && !input.actionAuthority) {
        throw new Error("conversation turn requested actions without an action authority");
      }
      if (workers.length > 0 && !input.workerStore) {
        throw new Error("conversation turn requested workers without a worker store");
      }

      const plannedEvents: PlannedConversationEvent[] = durableEvents.map((operation) => ({
        idempotencyKey: `cc:${operationDigest(turn.scope, turn.turnId, "event", operation.operationId)}`,
        draft: {
          eventId: eventIdentity(turn.scope, turn.turnId, "event", operation.operationId),
          occurredAtMs: operation.occurredAtMs ?? turn.occurredAtMs,
          payload: ConversationEventPayloadSchema.parse(operation.payload) as ConversationEventPayload,
        },
      }));
      if (turn.flowCheckpoint) {
        const checkpoint = turn.flowCheckpoint;
        const eventId = eventIdentity(turn.scope, turn.turnId, "flow", checkpoint.operationId);
        plannedEvents.push({
          idempotencyKey: `cc:${operationDigest(turn.scope, turn.turnId, "flow", checkpoint.operationId)}`,
          draft: createFlowCheckpointEvent({
            eventId,
            occurredAtMs: checkpoint.occurredAtMs ?? turn.occurredAtMs,
            goalId: checkpoint.goalId,
            runtimeDigest: checkpoint.runtimeDigest,
            state: checkpoint.state,
          }),
        });
      }
      const durable: ConversationTransactionResult<null> = plannedEvents.length > 0
        ? await input.runtime.transact({
            scope: turn.scope,
            plan: () => ({ value: null, events: plannedEvents }),
          })
        : await input.runtime.load(turn.scope).then(({ log, state }) => Object.freeze({
            value: null,
            log,
            state,
            events: Object.freeze([]),
            attempts: 0,
          }));

      const actionOutcomes: ConversationCallActionOutcome<TActionResult>[] = [];
      let currentState = durable.state;
      for (const action of actions) {
        const authority = operationAuthority({
          scope: turn.scope,
          turnId: turn.turnId,
          phase: "action",
          operationId: action.operationId,
          state: currentState,
        });
        const value = await input.actionAuthority!.reserve({ ...authority, request: action.request });
        actionOutcomes.push(Object.freeze({
          operationId: action.operationId,
          idempotencyKey: authority.idempotencyKey,
          deterministicUuid: authority.deterministicUuid,
          value,
        }));
      }

      const workerOutcomes: ConversationCallWorkerOutcome<TWorkerResult>[] = [];
      for (const worker of workers) {
        const workerEventId = eventIdentity(turn.scope, turn.turnId, "worker", worker.operationId);
        const loaded = await input.runtime.load(turn.scope);
        currentState = loaded.state;
        const existing = loaded.log.events.find(({ eventId }) => eventId === workerEventId);
        if (existing && existing.payload.type !== "worker.spawned") {
          throw new Error(`worker replay event ${workerEventId} is not a worker.spawned event`);
        }
        // Governed worker stores accept exact retries against the original
        // pre-event head even when later events exist. Reconstruct that prefix
        // so the store can validate the whole immutable request instead of the
        // coordinator trusting the event type alone.
        const authorityState = existing
          ? foldConversation(Object.freeze({
              ...loaded.log,
              events: Object.freeze(loaded.log.events.slice(0, existing.sequence - 1)),
            }))
          : currentState;
        const authority = operationAuthority({
          scope: turn.scope,
          turnId: turn.turnId,
          phase: "worker",
          operationId: worker.operationId,
          state: authorityState,
        });
        const transition = await input.workerStore!.spawn({
          ...authority,
          eventId: workerEventId,
          occurredAtMs: worker.occurredAtMs ?? turn.occurredAtMs,
          request: worker.request,
        });
        if (transition.event.eventId !== workerEventId ||
            transition.event.conversationId !== turn.scope.conversationId) {
          throw new Error("worker store returned an event outside its deterministic turn authority");
        }
        if (existing && transition.event.hash !== existing.hash) {
          throw new Error("worker store accepted a conflicting replay");
        }
        const afterSpawn = await input.runtime.load(turn.scope);
        const persisted = afterSpawn.log.events.find(({ eventId }) => eventId === workerEventId);
        if (!persisted || persisted.hash !== transition.event.hash) {
          throw new Error("worker store resolved before its conversation event became durable");
        }
        currentState = afterSpawn.state;
        workerOutcomes.push(Object.freeze({
          operationId: worker.operationId,
          idempotencyKey: authority.idempotencyKey,
          deterministicUuid: authority.deterministicUuid,
          event: transition.event,
          disposition: existing ? "replayed" : "spawned",
          value: transition.value,
        }));
      }

      const packet = await input.runtime.compilePacket({
        scope: turn.scope,
        ...turn.packet,
      });
      return Object.freeze({
        turnId: turn.turnId,
        planDigest: planDigest(turn),
        durable,
        actions: Object.freeze(actionOutcomes),
        workers: Object.freeze(workerOutcomes),
        packet,
      });
    },
  });
}

export type ConversationCallCoordinator<
  TActionRequest = never,
  TActionResult = never,
  TWorkerRequest = never,
  TWorkerResult = never,
> = ReturnType<typeof defineConversationCallCoordinator<
  TActionRequest,
  TActionResult,
  TWorkerRequest,
  TWorkerResult
>>;
