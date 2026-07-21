import {
  appendConversationEvents,
  canonicalJson,
  foldConversation,
  type ConversationEvent,
  type ConversationEventDraft,
  type ConversationLog,
  type ConversationState,
} from "./conversation-kernel";
import {
  compileRealtimeContextPacket,
  type AudibleTurn,
  type CompiledRealtimeContextPacket,
  type RealtimePacketCapability,
} from "./realtime-context-packet";

export type ConversationRuntimeScope = Readonly<{
  conversationId: string;
  organizationId: string;
}>;

export type ConversationRuntimeHead = Readonly<{ sequence: number; sha256: string }>;

export type PlannedConversationEvent = Readonly<{
  idempotencyKey: string;
  draft: ConversationEventDraft;
}>;

export interface ConversationRuntimeEventStore {
  load(scope: ConversationRuntimeScope): Promise<ConversationLog>;
  append(input: Readonly<{
    scope: ConversationRuntimeScope;
    expectedHead: ConversationRuntimeHead;
    events: readonly PlannedConversationEvent[];
  }>): Promise<readonly ConversationEvent[]>;
}

export type ConversationTransactionContext = Readonly<{
  scope: ConversationRuntimeScope;
  log: ConversationLog;
  state: ConversationState;
  head: ConversationRuntimeHead;
  attempt: number;
}>;

export type ConversationTransactionResult<T> = Readonly<{
  value: T;
  log: ConversationLog;
  state: ConversationState;
  events: readonly ConversationEvent[];
  attempts: number;
}>;

function headOf(log: ConversationLog): ConversationRuntimeHead {
  return Object.freeze({
    sequence: log.events.length,
    sha256: log.events.at(-1)?.hash ?? "0".repeat(64),
  });
}

function replayDraft(event: ConversationEvent): ConversationEventDraft {
  return { eventId: event.eventId, occurredAtMs: event.occurredAtMs, payload: event.payload };
}

function normalizePlan(log: ConversationLog, plan: readonly PlannedConversationEvent[]): Readonly<{
  newEvents: readonly PlannedConversationEvent[];
  replayedEvents: readonly ConversationEvent[];
}> {
  if (plan.length < 1 || plan.length > 64) throw new Error("conversation transaction must plan 1 to 64 events");
  const keys = plan.map(({ idempotencyKey }) => idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error("conversation transaction idempotency keys must be unique");
  const eventIds = plan.map(({ draft }) => draft.eventId);
  if (new Set(eventIds).size !== eventIds.length) throw new Error("conversation transaction event ids must be unique");
  const byId = new Map(log.events.map((event) => [event.eventId, event]));
  const newEvents: PlannedConversationEvent[] = [];
  const replayedEvents: ConversationEvent[] = [];
  for (const event of plan) {
    const existing = byId.get(event.draft.eventId);
    if (!existing) {
      newEvents.push(event);
      continue;
    }
    if (canonicalJson(replayDraft(existing)) !== canonicalJson(event.draft)) {
      throw new Error(`conflicting replay for event ${event.draft.eventId}`);
    }
    replayedEvents.push(existing);
  }
  return Object.freeze({ newEvents: Object.freeze(newEvents), replayedEvents: Object.freeze(replayedEvents) });
}

export function defineConversationRuntime(input: Readonly<{
  store: ConversationRuntimeEventStore;
  isConflict: (error: unknown) => boolean;
  maximumAttempts?: number;
}>) {
  const maximumAttempts = input.maximumAttempts ?? 8;
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 32) {
    throw new Error("conversation runtime maximum attempts must be 1 to 32");
  }

  const load = async (scope: ConversationRuntimeScope): Promise<Readonly<{
    log: ConversationLog;
    state: ConversationState;
  }>> => {
    const log = await input.store.load(scope);
    return Object.freeze({ log, state: foldConversation(log) });
  };

  return Object.freeze({
    load,

    async transact<T>(options: Readonly<{
      scope: ConversationRuntimeScope;
      plan: (context: ConversationTransactionContext) =>
        Promise<Readonly<{ value: T; events: readonly PlannedConversationEvent[] }>> |
        Readonly<{ value: T; events: readonly PlannedConversationEvent[] }>;
    }>): Promise<ConversationTransactionResult<T>> {
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const log = await input.store.load(options.scope);
        const state = foldConversation(log);
        const head = headOf(log);
        const planned = await options.plan(Object.freeze({ scope: options.scope, log, state, head, attempt }));
        const normalized = normalizePlan(log, planned.events);
        if (normalized.newEvents.length === 0) {
          return Object.freeze({
            value: planned.value,
            log,
            state,
            events: normalized.replayedEvents,
            attempts: attempt,
          });
        }

        // Validate semantic transitions before exposing them to the durable store.
        const candidate = appendConversationEvents(log, normalized.newEvents.map(({ draft }) => draft));
        const expectedSuffix = candidate.events.slice(log.events.length);
        try {
          const persisted = await input.store.append({
            scope: options.scope,
            expectedHead: head,
            events: normalized.newEvents,
          });
          if (canonicalJson(persisted) !== canonicalJson(expectedSuffix)) {
            throw new Error("conversation event store returned a different semantic batch");
          }
          return Object.freeze({
            value: planned.value,
            log: candidate,
            state: foldConversation(candidate),
            events: Object.freeze([...normalized.replayedEvents, ...persisted]),
            attempts: attempt,
          });
        } catch (error) {
          if (!input.isConflict(error) || attempt === maximumAttempts) throw error;
        }
      }
      throw new Error("conversation transaction retry loop exhausted");
    },

    async compilePacket(options: Readonly<{
      scope: ConversationRuntimeScope;
      capabilityCatalogDigest: string;
      capabilityEpoch: number;
      capabilities: readonly RealtimePacketCapability[];
      recentAudibleTurns: readonly AudibleTurn[];
      byteBudget: number;
    }>): Promise<CompiledRealtimeContextPacket> {
      const { state } = await load(options.scope);
      return compileRealtimeContextPacket({ ...options, state });
    },
  });
}

export type ConversationRuntime = ReturnType<typeof defineConversationRuntime>;
