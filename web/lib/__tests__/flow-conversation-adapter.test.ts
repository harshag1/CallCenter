import { describe, expect, it } from "vitest";
import {
  appendConversationEvents,
  createConversationLog,
  foldConversation,
  projectConversationContext,
} from "../conversation-kernel";
import {
  canonicalFlowCheckpoint,
  createFlowCheckpointEvent,
  flowCheckpointIdempotencyKey,
} from "../flow-conversation-adapter";
import { createFlowExecutionState, hashFlowValue, type FlowExecutionState } from "../flow-runtime";

const runtimeDigest = "a".repeat(64);

function activeState(overrides: Partial<FlowExecutionState> = {}): FlowExecutionState {
  return {
    ...createFlowExecutionState("2026-07-21T12:00:00.000Z"),
    status: "active",
    nodeId: "membership",
    currentStep: "membership.lookup",
    capabilityEpoch: 2,
    revision: 4,
    ...overrides,
  };
}

function goalEvent() {
  return {
    eventId: "goal-membership",
    occurredAtMs: 1,
    payload: { type: "goal.activated" as const, goalId: "membership", description: "Resolve membership" },
  };
}

describe("Flow conversation adapter", () => {
  it("binds a compact Flow checkpoint to the active goal and mandatory context", () => {
    const state = activeState();
    const checkpoint = createFlowCheckpointEvent({
      eventId: "flow-membership-r4",
      occurredAtMs: 2,
      goalId: "membership",
      runtimeDigest,
      state,
    });
    const log = appendConversationEvents(createConversationLog("conversation-1"), [goalEvent(), checkpoint]);
    const folded = foldConversation(log);

    expect(folded.currentFlowCheckpoint).toMatchObject({
      goalId: "membership",
      flowRevision: 4,
      capabilityEpoch: 2,
      currentStep: "membership.lookup",
    });
    expect(projectConversationContext(folded, 2_048).value.currentFlowCheckpoint).toEqual(
      expect.objectContaining({ flowRevision: 4, runtimeDigest })
    );
    expect(canonicalFlowCheckpoint({
      eventId: "flow-membership-r4",
      occurredAtMs: 2,
      goalId: "membership",
      runtimeDigest,
      state,
    })).toContain('"flowRevision":4');
  });

  it("tracks unresolved receipts without projecting result bodies or arguments", () => {
    const secretArguments = { memberNumber: "secret" };
    const state = activeState({
      actionReceipts: [{
        id: "receipt-1",
        idempotencyKey: "lookup-v1",
        step: "membership.lookup",
        tool: "lookup_member",
        capabilityEpoch: 2,
        arguments: secretArguments,
        argumentsHash: hashFlowValue(secretArguments),
        status: "indeterminate",
        reservedAt: "2026-07-21T12:00:00.000Z",
        dispatchStartedAt: "2026-07-21T12:00:01.000Z",
        dispatchAttempt: 1,
        settledAt: "2026-07-21T12:00:02.000Z",
      }],
    });
    const checkpoint = createFlowCheckpointEvent({
      eventId: "flow-membership-r4",
      occurredAtMs: 2,
      goalId: "membership",
      runtimeDigest,
      state,
    });
    expect(checkpoint.payload).toMatchObject({ unresolvedActionIds: ["receipt-1"] });
    expect(JSON.stringify(checkpoint)).not.toContain("secret");
  });

  it("rejects runtime swaps, stale revisions, backward epochs, and wrong-goal checkpoints", () => {
    const first = createFlowCheckpointEvent({
      eventId: "flow-r4", occurredAtMs: 2, goalId: "membership", runtimeDigest, state: activeState(),
    });
    const base = appendConversationEvents(createConversationLog("conversation-1"), [goalEvent(), first]);
    const cases = [
      createFlowCheckpointEvent({
        eventId: "flow-runtime-swap", occurredAtMs: 3, goalId: "membership",
        runtimeDigest: "b".repeat(64), state: activeState({ revision: 5 }),
      }),
      createFlowCheckpointEvent({
        eventId: "flow-stale", occurredAtMs: 3, goalId: "membership",
        runtimeDigest, state: activeState({ revision: 4 }),
      }),
      createFlowCheckpointEvent({
        eventId: "flow-epoch-back", occurredAtMs: 3, goalId: "membership",
        runtimeDigest, state: activeState({ revision: 5, capabilityEpoch: 1 }),
      }),
    ];
    expect(() => appendConversationEvents(base, [cases[0]])).toThrow(/runtime digest/);
    expect(() => appendConversationEvents(base, [cases[1]])).toThrow(/revision/);
    expect(() => appendConversationEvents(base, [cases[2]])).toThrow(/epoch/);

    const wrongGoal = createFlowCheckpointEvent({
      eventId: "flow-wrong-goal", occurredAtMs: 3, goalId: "returns", runtimeDigest, state: activeState({ revision: 5 }),
    });
    expect(() => appendConversationEvents(base, [wrongGoal])).toThrow(/current goal/);
  });

  it("does not allow a terminal Flow checkpoint to be reopened", () => {
    const terminal = createFlowCheckpointEvent({
      eventId: "flow-complete",
      occurredAtMs: 2,
      goalId: "membership",
      runtimeDigest,
      state: activeState({ status: "completed", currentStep: null, revision: 5 }),
    });
    const log = appendConversationEvents(createConversationLog("conversation-1"), [goalEvent(), terminal]);
    const reopened = createFlowCheckpointEvent({
      eventId: "flow-reopened",
      occurredAtMs: 3,
      goalId: "membership",
      runtimeDigest,
      state: activeState({ revision: 6 }),
    });
    expect(() => appendConversationEvents(log, [reopened])).toThrow(/terminal flow checkpoint/);
  });

  it("derives a revision and content-bound idempotency identity", () => {
    const state = activeState();
    const first = flowCheckpointIdempotencyKey({ goalId: "membership", runtimeDigest, state });
    expect(first).toBe(flowCheckpointIdempotencyKey({ goalId: "membership", runtimeDigest, state }));
    expect(first).not.toBe(flowCheckpointIdempotencyKey({
      goalId: "membership", runtimeDigest, state: activeState({ revision: 5 }),
    }));
  });
});
