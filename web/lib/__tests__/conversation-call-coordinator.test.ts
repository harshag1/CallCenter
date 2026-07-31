import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendConversationEvents,
  canonicalJson,
  createConversationLog,
  type ConversationEventDraft,
  type ConversationEventPayload,
} from "../conversation-kernel";
import {
  defineConversationCallCoordinator,
  type ConversationCallActionAuthority,
  type ConversationCallTurn,
  type ConversationCallWorkerStore,
} from "../conversation-call-coordinator";
import {
  defineConversationRuntime,
  type ConversationRuntime,
  type ConversationRuntimeEventStore,
} from "../conversation-runtime";

class Conflict extends Error {}

function memoryRuntime(conversationId: string): Readonly<{
  runtime: ConversationRuntime;
  appendCount: () => number;
}> {
  let log = createConversationLog(conversationId);
  let appends = 0;
  const store: ConversationRuntimeEventStore = {
    async load(scope) {
      if (scope.conversationId !== conversationId) throw new Error("wrong conversation");
      return log;
    },
    async append({ expectedHead, events }) {
      const head = log.events.at(-1)?.hash ?? "0".repeat(64);
      if (expectedHead.sequence !== log.events.length || expectedHead.sha256 !== head) throw new Conflict();
      const next = appendConversationEvents(log, events.map(({ draft }) => draft));
      const appended = next.events.slice(log.events.length);
      log = next;
      appends += 1;
      return appended;
    },
  };
  return Object.freeze({
    runtime: defineConversationRuntime({ store, isConflict: (error) => error instanceof Conflict }),
    appendCount: () => appends,
  });
}

type ActionRequest = Readonly<{ tool: string; arguments: Readonly<Record<string, unknown>> }>;
type WorkerRequest = Readonly<{
  workerKind: string;
  purpose: string;
  dependencies: readonly Readonly<{ key: string; revision: number }>[];
}>;

function actionAuthority() {
  const reservations = new Map<string, string>();
  let newReservations = 0;
  const authority: ConversationCallActionAuthority<ActionRequest, Readonly<{
    decision: "allow";
    receiptId: string;
    replayed: boolean;
  }>> = {
    async reserve(input) {
      const bytes = canonicalJson(input.request);
      const prior = reservations.get(input.idempotencyKey);
      if (prior !== undefined && prior !== bytes) throw new Error("conflicting action replay");
      if (prior === undefined) {
        reservations.set(input.idempotencyKey, bytes);
        newReservations += 1;
      }
      return Object.freeze({
        decision: "allow",
        receiptId: input.deterministicUuid,
        replayed: prior !== undefined,
      });
    },
  };
  return Object.freeze({ authority, newReservations: () => newReservations });
}

function workerStore(
  runtime: ConversationRuntime,
  options: Readonly<{ crashAfterFirstCommit?: boolean }> = {},
) {
  let calls = 0;
  let crashed = false;
  const store: ConversationCallWorkerStore<WorkerRequest, Readonly<{ workerId: string }>> = {
    async spawn(input) {
      calls += 1;
      const workerId = `worker-${input.deterministicUuid}`;
      const payload: ConversationEventPayload = {
        type: "worker.spawned",
        workerId,
        goalId: input.conversation.state.currentGoal?.goalId ?? "missing",
        purpose: input.request.purpose,
        policyEpoch: input.conversation.state.policy.epoch,
        dependencies: [...input.request.dependencies],
      };
      const transition = await runtime.transact({
        scope: input.scope,
        plan: () => ({
          value: null,
          events: [{
            idempotencyKey: input.idempotencyKey,
            draft: { eventId: input.eventId, occurredAtMs: input.occurredAtMs, payload },
          }],
        }),
      });
      const event = transition.events.find(({ eventId }) => eventId === input.eventId);
      if (!event) throw new Error("fixture worker transition lost its event");
      if (options.crashAfterFirstCommit && !crashed) {
        crashed = true;
        throw new Error("simulated process crash after atomic worker commit");
      }
      return Object.freeze({ event, value: Object.freeze({ workerId }) });
    },
  };
  return Object.freeze({ store, calls: () => calls });
}

function fixture(): ConversationCallTurn<ActionRequest, WorkerRequest> {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), "../examples/conversation-coordinator/membership-renewal-turn.json"),
    "utf8",
  )) as ConversationCallTurn<ActionRequest, WorkerRequest>;
}

describe("ConversationCallCoordinator", () => {
  it("executes a provider-neutral durable turn and packet fixture end to end", async () => {
    const turn = fixture();
    const memory = memoryRuntime(turn.scope.conversationId);
    const actions = actionAuthority();
    const workers = workerStore(memory.runtime);
    const coordinator = defineConversationCallCoordinator({
      runtime: memory.runtime,
      actionAuthority: actions.authority,
      workerStore: workers.store,
    });

    const result = await coordinator.runTurn(turn);

    expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.actions).toEqual([
      expect.objectContaining({
        operationId: "lookup-membership",
        value: expect.objectContaining({ decision: "allow", replayed: false }),
      }),
    ]);
    expect(result.workers).toEqual([
      expect.objectContaining({
        operationId: "research-renewal-options",
        disposition: "spawned",
        value: expect.objectContaining({ workerId: expect.stringMatching(/^worker-/) }),
      }),
    ]);
    expect(result.packet.value).toMatchObject({
      authority: {
        conversationRevision: 5,
        policyEpoch: 1,
        capabilityEpoch: 2,
        capabilityCatalogDigest: "b".repeat(64),
      },
      durable: {
        currentGoal: { goalId: "membership-renewal" },
        currentFlowCheckpoint: {
          flowRevision: 3,
          currentStep: "membership.lookup",
        },
        currentGoalWorkers: [expect.objectContaining({ status: "running" })],
      },
      capabilities: [{ name: "capability_gateway" }],
      recentAudibleTurns: [expect.objectContaining({ turnId: "caller-001" })],
    });
    expect(actions.newReservations()).toBe(1);
    expect(workers.calls()).toBe(1);
    expect(memory.appendCount()).toBe(2);
  });

  it("recovers from a crash after worker commit without duplicating any authority", async () => {
    const turn = fixture();
    const memory = memoryRuntime(turn.scope.conversationId);
    const actions = actionAuthority();
    const workers = workerStore(memory.runtime, { crashAfterFirstCommit: true });
    const coordinator = defineConversationCallCoordinator({
      runtime: memory.runtime,
      actionAuthority: actions.authority,
      workerStore: workers.store,
    });

    await expect(coordinator.runTurn(turn)).rejects.toThrow(/simulated process crash/);
    const recovered = await coordinator.runTurn(turn);

    expect(recovered.actions[0]).toMatchObject({ value: { replayed: true } });
    expect(recovered.workers[0]).toMatchObject({
      operationId: "research-renewal-options",
      disposition: "replayed",
      value: expect.objectContaining({ workerId: expect.stringMatching(/^worker-/) }),
    });
    expect(recovered.packet.value.authority.conversationRevision).toBe(5);
    expect(actions.newReservations()).toBe(1);
    expect(workers.calls()).toBe(2);
    expect(memory.appendCount()).toBe(2);
  });

  it("rejects mutation of a replayed turn operation instead of silently appending it", async () => {
    const original = fixture();
    const memory = memoryRuntime(original.scope.conversationId);
    const coordinator = defineConversationCallCoordinator({ runtime: memory.runtime });
    const durableOnly = { ...original, actions: [], workers: [] };
    await coordinator.runTurn(durableOnly);

    const mutated = {
      ...durableOnly,
      durableEvents: durableOnly.durableEvents?.map((event) =>
        event.operationId === "member-id"
          ? {
              ...event,
              payload: {
                ...event.payload,
                value: "MEM-99",
              } as ConversationEventPayload,
            }
          : event),
    };
    await expect(coordinator.runTurn(mutated)).rejects.toThrow(/conflicting replay/);
    expect(memory.appendCount()).toBe(1);
  });

  it("revalidates the full worker request on replay instead of trusting an existing event id", async () => {
    const original = fixture();
    const memory = memoryRuntime(original.scope.conversationId);
    const actions = actionAuthority();
    const workers = workerStore(memory.runtime);
    const coordinator = defineConversationCallCoordinator({
      runtime: memory.runtime,
      actionAuthority: actions.authority,
      workerStore: workers.store,
    });
    await coordinator.runTurn(original);

    const mutated = {
      ...original,
      workers: original.workers?.map((worker) => ({
        ...worker,
        request: {
          ...worker.request,
          purpose: "A different request under the same operation identity.",
        },
      })),
    };
    await expect(coordinator.runTurn(mutated)).rejects.toThrow(/conflicting replay/);
    expect(workers.calls()).toBe(2);
  });

  it("supports action-only turns against an already durable Flow checkpoint", async () => {
    const initial = fixture();
    const memory = memoryRuntime(initial.scope.conversationId);
    const bootstrap = defineConversationCallCoordinator({ runtime: memory.runtime });
    await bootstrap.runTurn({ ...initial, actions: [], workers: [] });
    const actions = actionAuthority();
    const coordinator = defineConversationCallCoordinator({
      runtime: memory.runtime,
      actionAuthority: actions.authority,
    });

    const result = await coordinator.runTurn({
      ...initial,
      turnId: "turn-002",
      durableEvents: [],
      flowCheckpoint: undefined,
      workers: [],
    });

    expect(result.durable).toMatchObject({ attempts: 0, events: [] });
    expect(result.actions[0]).toMatchObject({ value: { decision: "allow" } });
    expect(result.packet.value.authority.conversationRevision).toBe(4);
    expect(memory.appendCount()).toBe(1);
  });

  it("fails closed when a worker store resolves without the shared event becoming durable", async () => {
    const turn = fixture();
    const memory = memoryRuntime(turn.scope.conversationId);
    const coordinator = defineConversationCallCoordinator<ActionRequest, never, WorkerRequest, null>({
      runtime: memory.runtime,
      actionAuthority: { reserve: async () => { throw new Error("unused"); } },
      workerStore: {
        async spawn(input) {
          const forged: ConversationEventDraft = {
            eventId: input.eventId,
            occurredAtMs: input.occurredAtMs,
            payload: {
              type: "worker.spawned",
              workerId: "worker-forged",
              goalId: "membership-renewal",
              purpose: input.request.purpose,
              policyEpoch: 0,
              dependencies: [],
            },
          };
          const isolated = appendConversationEvents(
            createConversationLog(input.scope.conversationId),
            [{
              eventId: "goal-isolated",
              occurredAtMs: 1,
              payload: {
                type: "goal.activated",
                goalId: "membership-renewal",
                description: "isolated",
              },
            }, forged],
          );
          return { event: isolated.events.at(-1)!, value: null };
        },
      },
    });

    await expect(coordinator.runTurn({ ...turn, actions: [] })).rejects.toThrow(
      /resolved before its conversation event became durable/,
    );
  });
});
