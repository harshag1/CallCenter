import { describe, expect, it } from "vitest";
import {
  appendConversationEvents,
  createConversationLog,
  type ConversationEventDraft,
} from "../conversation-kernel";
import {
  defineConversationRuntime,
  type ConversationRuntimeEventStore,
} from "../conversation-runtime";

class Conflict extends Error {}

function fact(eventId: string, key: string, value: string): ConversationEventDraft {
  return {
    eventId,
    occurredAtMs: 1,
    payload: {
      type: "fact.asserted",
      key,
      value,
      revision: 1,
      authority: { kind: "system_of_record", issuer: "fixture", evidenceId: `${eventId}-evidence`, issuedAtMs: 1 },
    },
  };
}

function memoryStore(initial = createConversationLog("conversation-1")) {
  let log = initial;
  let forceConflict: (() => void) | null = null;
  const store: ConversationRuntimeEventStore = {
    async load() { return log; },
    async append({ expectedHead, events }) {
      forceConflict?.();
      forceConflict = null;
      const currentHead = log.events.at(-1)?.hash ?? "0".repeat(64);
      if (expectedHead.sequence !== log.events.length || expectedHead.sha256 !== currentHead) throw new Conflict();
      const next = appendConversationEvents(log, events.map(({ draft }) => draft));
      const appended = next.events.slice(log.events.length);
      log = next;
      return appended;
    },
  };
  return {
    store,
    read: () => log,
    conflictWith(event: ConversationEventDraft) {
      forceConflict = () => { log = appendConversationEvents(log, [event]); };
    },
  };
}

const scope = { conversationId: "conversation-1", organizationId: "8916eb0a-5332-4f4c-a330-746c516e83ba" };

describe("conversation runtime", () => {
  it("semantically validates and commits one planned batch", async () => {
    const memory = memoryStore();
    const runtime = defineConversationRuntime({ store: memory.store, isConflict: (error) => error instanceof Conflict });
    const result = await runtime.transact({
      scope,
      plan: () => ({ value: "ok", events: [{ idempotencyKey: "member-v1", draft: fact("member", "member.id", "M-1") }] }),
    });
    expect(result).toMatchObject({ value: "ok", attempts: 1, state: { eventCount: 1 } });
    expect(memory.read().events).toHaveLength(1);
  });

  it("reloads and replans against the winning head after a real CAS conflict", async () => {
    const memory = memoryStore();
    memory.conflictWith(fact("winner", "account.status", "active"));
    const runtime = defineConversationRuntime({ store: memory.store, isConflict: (error) => error instanceof Conflict });
    const observed: number[] = [];
    const result = await runtime.transact({
      scope,
      plan: ({ head }) => {
        observed.push(head.sequence);
        return { value: head.sequence, events: [{ idempotencyKey: "goal-v1", draft: {
          eventId: "goal", occurredAtMs: 2,
          payload: { type: "goal.activated", goalId: "support", description: "Resolve the account" },
        } }] };
      },
    });
    expect(observed).toEqual([0, 1]);
    expect(result.attempts).toBe(2);
    expect(result.value).toBe(1);
    expect(result.state.eventCount).toBe(2);
  });

  it("returns an exact event replay without issuing another store append", async () => {
    const initial = appendConversationEvents(createConversationLog("conversation-1"), [fact("member", "member.id", "M-1")]);
    const memory = memoryStore(initial);
    let appends = 0;
    const runtime = defineConversationRuntime({
      store: { ...memory.store, append: async (input) => { appends += 1; return memory.store.append(input); } },
      isConflict: (error) => error instanceof Conflict,
    });
    const result = await runtime.transact({
      scope,
      plan: () => ({ value: null, events: [{ idempotencyKey: "member-v1", draft: fact("member", "member.id", "M-1") }] }),
    });
    expect(result.events).toHaveLength(1);
    expect(appends).toBe(0);
  });

  it("rejects semantic invalidity before storage", async () => {
    const memory = memoryStore();
    const runtime = defineConversationRuntime({ store: memory.store, isConflict: (error) => error instanceof Conflict });
    await expect(runtime.transact({
      scope,
      plan: () => ({ value: null, events: [{ idempotencyKey: "complete-missing", draft: {
        eventId: "complete", occurredAtMs: 1,
        payload: { type: "goal.completed", goalId: "missing" },
      } }] }),
    })).rejects.toThrow(/not the active goal/);
    expect(memory.read().events).toHaveLength(0);
  });

  it("compiles packets from the same verified durable state", async () => {
    const initial = appendConversationEvents(createConversationLog("conversation-1"), [
      { eventId: "goal", occurredAtMs: 1, payload: { type: "goal.activated", goalId: "support", description: "Help" } },
    ]);
    const memory = memoryStore(initial);
    const runtime = defineConversationRuntime({ store: memory.store, isConflict: (error) => error instanceof Conflict });
    const compilePacket = runtime.compilePacket;
    const packet = await compilePacket({
      scope, capabilityCatalogDigest: "a".repeat(64), capabilityEpoch: 1,
      capabilities: [{ name: "lookup", description: "Look up account" }],
      recentAudibleTurns: [], byteBudget: 1_024,
    });
    expect(packet.value.authority.conversationHeadSha256).toBe(initial.events[0].hash);
    expect(packet.value.durable.currentGoal?.goalId).toBe("support");
  });
});
