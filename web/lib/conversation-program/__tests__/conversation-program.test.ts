import { describe, expect, it } from "vitest";
import {
  appendConversationProgramEvent,
  appendConversationProgramEvents,
  conversationProgramDigest,
  createConversationProgramLog,
  foldConversationProgram,
  validateConversationProgramLog,
  type ConversationProgramEventDraft,
  type ConversationProgramEventPayload,
  type ConversationProgramLog,
} from "../index";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const AT = "2026-08-02T19:00:00.000Z";

function draft(
  eventId: string,
  expectedRevision: number,
  payload: ConversationProgramEventPayload,
): ConversationProgramEventDraft {
  return { eventId, expectedRevision, occurredAt: AT, payload };
}

function append(
  log: ConversationProgramLog,
  eventId: string,
  payload: ConversationProgramEventPayload,
): ConversationProgramLog {
  return appendConversationProgramEvent(log, draft(eventId, log.events.length, payload));
}

function authority(kind: "caller" | "tool" | "policy" | "operator" | "system" = "caller") {
  return { kind, evidenceSha256: SHA_A } as const;
}

function baseProgram(): ConversationProgramLog {
  let log = createConversationProgramLog("call-001");
  log = append(log, "evt-001", {
    type: "fact.asserted", key: "member.tier", value: "silver", authority: authority(),
  });
  log = append(log, "evt-002", {
    type: "goal.opened", goalId: "return", description: "Return the caller's order",
  });
  log = append(log, "evt-003", { type: "goal.focused", goalId: "return" });
  log = append(log, "evt-004", {
    type: "capability_epoch.advanced", expectedEpoch: 1, epoch: 2,
    capabilities: ["orders.read", "returns.create"], reason: "return goal focused",
  });
  return log;
}

describe("ConversationProgram reducer", () => {
  it("composes flow, mission, effects, workers, and audibility into one canonical projection", () => {
    let log = baseProgram();
    log = appendConversationProgramEvents(log, [
      draft("evt-005", 4, {
        type: "flow.checkpoint_recorded", goalId: "return", flowId: "commerce-returns",
        flowVersion: "1.0.0", flowRevision: 1, capabilityEpoch: 2, status: "active",
        nodeId: "eligibility", stepPath: "return.eligibility", completedStepCount: 0, stateSha256: SHA_A,
      }),
      draft("evt-006", 5, {
        type: "obligation.opened", obligationId: "ob-confirm", obligationType: "caller_confirmation",
        description: "Confirm the return destination", owner: "agent", blocks: "goal_completion",
        goalId: "return", sourceId: "flow:return.eligibility",
      }),
      draft("evt-007", 6, {
        type: "worker.spawned", workerId: "worker-policy", goalId: "return",
        purpose: "Fetch current return policy", capabilityEpoch: 2,
        dependencies: [{ key: "member.tier", revision: 1 }],
      }),
      draft("evt-008", 7, {
        type: "worker.delivery_recorded", deliveryId: "delivery-policy", workerId: "worker-policy",
        goalId: "return", capabilityEpoch: 2,
        dependencyFactRevisions: [{ key: "member.tier", revision: 1 }], resultSha256: SHA_B,
      }),
      draft("evt-009", 8, {
        type: "action.reserved", reservationId: "reservation-return", goalId: "return",
        action: "returns.create", argumentsSha256: SHA_B, idempotencyKey: "return:order-42",
        capabilityEpoch: 2, authorityRevision: 8,
      }),
      draft("evt-010", 9, {
        type: "action.receipt_recorded", receiptId: "receipt-return",
        reservationId: "reservation-return", status: "succeeded",
        resultSha256: SHA_C, evidenceSha256: SHA_B,
      }),
      draft("evt-011", 10, {
        type: "audibility.response_registered", responseId: "response-confirmation",
        generatedThroughMs: 2_000, contentSha256: SHA_C, evidenceSha256: SHA_A,
      }),
      draft("evt-012", 11, {
        type: "audibility.released_through", responseId: "response-confirmation",
        throughMs: 1_500, evidenceSha256: SHA_B,
      }),
      draft("evt-013", 12, {
        type: "audibility.heard_through", responseId: "response-confirmation",
        throughMs: 900, evidenceSha256: SHA_C,
      }),
      draft("evt-014", 13, {
        type: "audibility.interrupted", responseId: "response-confirmation",
        heardThroughMs: 1_000, reason: "caller barge-in", evidenceSha256: SHA_C,
      }),
      draft("evt-015", 14, {
        type: "obligation.settled", obligationId: "ob-confirm",
        disposition: "satisfied", evidenceSha256: SHA_A,
      }),
      draft("evt-016", 15, { type: "goal.completed", goalId: "return" }),
    ]);

    const state = foldConversationProgram(log);
    expect(state.revision).toBe(16);
    expect(state.focusedGoal).toBeNull();
    expect(state.goals).toEqual([expect.objectContaining({ goalId: "return", status: "completed", focusCount: 1 })]);
    expect(state.flowCheckpoints[0]).toMatchObject({ flowRevision: 1, capabilityEpoch: 2 });
    expect(state.obligations[0]).toMatchObject({ status: "satisfied", settledSequence: 15 });
    expect(state.capabilityEpoch).toBe(3);
    expect(state.capabilityGoalId).toBeNull();
    expect(state.capabilities).toEqual([]);
    expect(state.actionReservations[0]).toMatchObject({ status: "succeeded", receiptId: "receipt-return" });
    expect(state.actionReceipts[0]).toMatchObject({ reservationId: "reservation-return", resultSha256: SHA_C });
    expect(state.workers[0]).toMatchObject({ status: "delivered" });
    expect(state.workerDeliveries[0]).toMatchObject({ disposition: "accepted", reason: null });
    expect(state.audibilityFacts[0]).toMatchObject({
      generatedThroughMs: 2_000, releasedThroughMs: 1_500, heardThroughMs: 1_000,
      unheardMs: 1_000, fullyHeard: false, interrupted: true,
    });
    expect(Object.isFrozen(log.events)).toBe(true);
    expect(Object.isFrozen(state.actionReservations[0])).toBe(true);
  });

  it("rejects stale program and fact revisions without exposing partial batch state", () => {
    const log = baseProgram();
    expect(() => appendConversationProgramEvent(log, draft("stale-program", 2, {
      type: "fact.asserted", key: "order.id", value: "42", authority: authority(),
    }))).toThrow("stale program revision");

    expect(() => appendConversationProgramEvents(log, [
      draft("good-first", 4, {
        type: "fact.corrected", key: "member.tier", value: "gold",
        expectedFactRevision: 1, authority: authority("operator"),
      }),
      draft("stale-second", 5, {
        type: "fact.corrected", key: "member.tier", value: "platinum",
        expectedFactRevision: 1, authority: authority("operator"),
      }),
    ])).toThrow("fact member.tier correction is stale");

    const unchanged = foldConversationProgram(log);
    expect(unchanged.revision).toBe(4);
    expect(unchanged.facts[0]).toMatchObject({ value: "silver", revision: 1 });
  });

  it("rejects stale worker delivery authority while retaining it as immutable evidence", () => {
    let log = baseProgram();
    log = append(log, "worker-spawn", {
      type: "worker.spawned", workerId: "worker-1", goalId: "return", purpose: "Check policy",
      capabilityEpoch: 2, dependencies: [{ key: "member.tier", revision: 1 }],
    });
    log = append(log, "caller-correction", {
      type: "fact.corrected", key: "member.tier", value: "gold",
      expectedFactRevision: 1, authority: authority("caller"),
    });
    log = append(log, "worker-delivery", {
      type: "worker.delivery_recorded", deliveryId: "delivery-1", workerId: "worker-1",
      goalId: "return", capabilityEpoch: 2,
      dependencyFactRevisions: [{ key: "member.tier", revision: 1 }], resultSha256: SHA_B,
    });

    const state = foldConversationProgram(log);
    expect(state.facts[0]).toMatchObject({ value: "gold", revision: 2 });
    expect(state.workerDeliveries[0]).toMatchObject({
      disposition: "rejected", reason: "dependency fact revision changed",
    });
    expect(state.workers[0].status).toBe("superseded");
  });

  it("suspends replaced goals and invalidates prior capability epochs", () => {
    let log = baseProgram();
    log = append(log, "goal-membership", {
      type: "goal.opened", goalId: "membership", description: "Explain membership",
    });
    log = append(log, "focus-membership", { type: "goal.focused", goalId: "membership" });
    log = append(log, "capabilities-membership", {
      type: "capability_epoch.advanced", expectedEpoch: 3, epoch: 4,
      capabilities: ["membership.read"], reason: "membership goal focused",
    });

    const state = foldConversationProgram(log);
    expect(state.focusedGoal?.goalId).toBe("membership");
    expect(state.goals.find(({ goalId }) => goalId === "return")).toMatchObject({
      status: "suspended", suspensionReason: "focus_replaced:membership",
    });
    expect(() => append(log, "stale-action", {
      type: "action.reserved", reservationId: "old-return", goalId: "membership",
      action: "returns.create", argumentsSha256: SHA_A, idempotencyKey: "old-return",
      capabilityEpoch: 2, authorityRevision: log.events.length,
    })).toThrow("capability epoch is stale");
  });

  it("converges to the same digest after crash serialization and rejects log tampering", () => {
    let log = baseProgram();
    log = append(log, "fact-corrected", {
      type: "fact.corrected", key: "member.tier", value: "gold",
      expectedFactRevision: 1, authority: authority("operator"),
    });
    const beforeCrash = foldConversationProgram(log);
    const recovered = JSON.parse(JSON.stringify(log)) as ConversationProgramLog;
    const afterCrash = foldConversationProgram(recovered);
    expect(conversationProgramDigest(afterCrash)).toBe(conversationProgramDigest(beforeCrash));
    expect(afterCrash).toEqual(beforeCrash);

    const retried = appendConversationProgramEvent(recovered, draft("fact-corrected", 4, {
      type: "fact.corrected", key: "member.tier", value: "gold",
      expectedFactRevision: 1, authority: authority("operator"),
    }));
    expect(retried).toBe(recovered);

    const tampered = JSON.parse(JSON.stringify(log)) as {
      schemaVersion: 1;
      programId: string;
      events: Array<Record<string, unknown>>;
    };
    (tampered.events[0].payload as Record<string, unknown>).value = "tampered";
    expect(() => validateConversationProgramLog(tampered as unknown as ConversationProgramLog))
      .toThrow("invalid digest");
  });

  it("replays a 1,000-event correction history to the identical canonical digest", () => {
    let log = createConversationProgramLog("long-call-replay");
    const events: ConversationProgramEventDraft[] = [draft("long-0001", 0, {
      type: "fact.asserted", key: "caller.preference", value: 1, authority: authority(),
    })];
    for (let revision = 1; revision < 1_000; revision += 1) {
      events.push(draft(`long-${String(revision + 1).padStart(4, "0")}`, revision, {
        type: "fact.corrected", key: "caller.preference", value: revision + 1,
        expectedFactRevision: revision, authority: authority(revision % 2 ? "caller" : "operator"),
      }));
    }
    log = appendConversationProgramEvents(log, events);
    const live = foldConversationProgram(log);
    const crashRecovered = foldConversationProgram(
      JSON.parse(JSON.stringify(log)) as ConversationProgramLog,
    );
    expect(crashRecovered.facts[0]).toMatchObject({ value: 1_000, revision: 1_000 });
    expect(crashRecovered.revision).toBe(1_000);
    expect(conversationProgramDigest(crashRecovered)).toBe(conversationProgramDigest(live));
  });

  it("does not let terminal speech or effects advance twice", () => {
    let log = baseProgram();
    log = append(log, "reserve", {
      type: "action.reserved", reservationId: "reservation-1", goalId: "return",
      action: "returns.create", argumentsSha256: SHA_A, idempotencyKey: "once",
      capabilityEpoch: 2, authorityRevision: 4,
    });
    log = append(log, "receipt", {
      type: "action.receipt_recorded", receiptId: "receipt-1", reservationId: "reservation-1",
      status: "indeterminate", resultSha256: null, evidenceSha256: SHA_B,
    });
    expect(() => append(log, "second-receipt", {
      type: "action.receipt_recorded", receiptId: "receipt-2", reservationId: "reservation-1",
      status: "failed", resultSha256: null, evidenceSha256: SHA_C,
    })).toThrow("is not unsettled");

    log = append(log, "response", {
      type: "audibility.response_registered", responseId: "response-1",
      generatedThroughMs: 1_000, contentSha256: SHA_A, evidenceSha256: SHA_B,
    });
    log = append(log, "released", {
      type: "audibility.released_through", responseId: "response-1", throughMs: 700, evidenceSha256: SHA_B,
    });
    log = append(log, "interrupted", {
      type: "audibility.interrupted", responseId: "response-1", heardThroughMs: 400,
      reason: "caller correction", evidenceSha256: SHA_C,
    });
    expect(() => append(log, "late-playback", {
      type: "audibility.heard_through", responseId: "response-1", throughMs: 500, evidenceSha256: SHA_C,
    })).toThrow("cannot advance caller playback");
  });
});
