import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  GovernedWorkerResultNotApplicableError,
  type DurableConversationInboxMessage,
  type DurableVoiceWorker,
} from "../voice-workers/store";
import {
  GovernedWorkerCoordinator,
  GovernedWorkerRecipeRegistry,
  InMemoryGovernedWorkerOperationJournal,
  type GovernedWorkerAuthorityReceipt,
  type GovernedWorkerOperation,
} from "../voice-workers/coordinator";
import { createDurableStoreGovernedWorkerBackend } from "../voice-workers/store-coordinator-backend";
import {
  hashVoiceWorkerValue,
  prepareVoiceWorkerResult,
} from "../voice-workers/schema";
import type { VoiceToolExecutionContext } from "../voice-tools/types";

const ids = {
  conversation: "8916eb0a-5332-4f4c-a330-746c516e83b9",
  organization: "8916eb0a-5332-4f4c-a330-746c516e83ba",
  agent: "8916eb0a-5332-4f4c-a330-746c516e83bb",
  call: "8916eb0a-5332-4f4c-a330-746c516e83bc",
  worker: "8916eb0a-5332-5f4c-a330-746c516e83bd",
  message: "8916eb0a-5332-4f4c-a330-746c516e83be",
  delivery: "8916eb0a-5332-4f4c-a330-746c516e83bf",
};

const manifest = {
  v: 1 as const,
  mode: "read_only" as const,
  capabilities: ["membership.lookup"],
  networkOrigins: ["https://members.example.com/"],
};
const workerInput = {
  v: 1 as const,
  objective: "Read current membership terms.",
  context: { memberId: "MEM-42" },
  deliverable: "Return cited terms.",
};
const preparedResult = prepareVoiceWorkerResult({
  v: 1,
  facts: [],
  citations: [],
  proposedActions: [],
  summary: "The lookup completed.",
});

function context(operation: GovernedWorkerOperation, identity: string): VoiceToolExecutionContext {
  return {
    audience: operation === "deliverResult" || operation === "reconcile"
      ? "reconciliation"
      : "flow_action",
    invocationId: `invocation:${identity}`,
    idempotencyKey: `idempotency:${identity}`,
    receiptId: `receipt:${identity}`,
    runtimeDigest: "a".repeat(64),
  };
}

function authority(
  operation: GovernedWorkerOperation,
  execution: VoiceToolExecutionContext
): GovernedWorkerAuthorityReceipt {
  return {
    v: 1,
    receiptId: execution.receiptId!,
    invocationId: execution.invocationId!,
    runtimeDigest: execution.runtimeDigest!,
    organizationId: ids.organization,
    agentId: ids.agent,
    agentVersion: 4,
    callId: ids.call,
    conversationId: ids.conversation,
    conversationHeadSha256: "b".repeat(64),
    conversationRevision: 7,
    goalId: "membership_renewal",
    policyEpoch: 3,
    factDependencies: [],
    allowedOperations: [operation],
    allowedRecipeIds: ["membership.lookup"],
    issuedAt: "2026-07-28T16:59:00.000Z",
    expiresAt: "2026-07-28T17:01:00.000Z",
  };
}

function durableWorker(overrides: Partial<DurableVoiceWorker> = {}): DurableVoiceWorker {
  const authorityValue = {
    v: 1 as const,
    conversationId: ids.conversation,
    organizationId: ids.organization,
    agentId: ids.agent,
    agentVersion: 4,
    source: "voice_call" as const,
    sourceCallId: ids.call,
    conversationHeadSha256: "c".repeat(64),
    conversationRevision: 8,
    goalId: "membership_renewal",
    policyEpoch: 3,
    factDependencies: [],
    capabilityManifestSha256: hashVoiceWorkerValue(manifest),
  };
  return {
    id: ids.worker,
    conversationId: ids.conversation,
    organizationId: ids.organization,
    parentWorkerId: null,
    sourceCallId: ids.call,
    idempotencyKey: "worker-1",
    workerKind: "membership.lookup",
    authority: authorityValue,
    authoritySha256: hashVoiceWorkerValue(authorityValue),
    input: workerInput,
    inputSha256: hashVoiceWorkerValue(workerInput),
    capabilityManifest: manifest,
    capabilityManifestSha256: hashVoiceWorkerValue(manifest),
    status: "pending",
    ownerToken: null,
    leaseExpiresAt: null,
    dispatchStartedAt: null,
    cancellationEpoch: 0,
    claimedCancellationEpoch: null,
    checkpoint: null,
    checkpointSha256: null,
    result: null,
    resultSha256: null,
    error: null,
    createdAt: "2026-07-28T16:59:00.000Z",
    settledAt: null,
    ...overrides,
  };
}

function inbox(): DurableConversationInboxMessage {
  return {
    kind: "result",
    id: ids.message,
    conversationId: ids.conversation,
    workerId: ids.worker,
    sourceEventSha256: "d".repeat(64),
    result: preparedResult.result,
    resultSha256: preparedResult.resultSha256,
    deliveryToken: ids.delivery,
    deliveryLeaseExpiresAt: "2026-07-28T17:00:30.000Z",
    deliveryCount: 1,
    applicationId: null,
    appliedContextVersion: null,
    createdAt: "2026-07-28T17:00:00.000Z",
    appliedAt: null,
    acknowledgedAt: null,
  };
}

function setup(initialWorker = durableWorker()) {
  let worker = initialWorker;
  const transitions = {
    spawn: vi.fn(async (input: unknown) => {
      void input;
      return { event: {} as never, worker };
    }),
    cancel: vi.fn(async (workerId: string, organizationId: string) => {
      void workerId;
      void organizationId;
      return worker;
    }),
    deliver: vi.fn(async (input: unknown) => {
      void input;
      return {
        event: {} as never,
        message: {} as never,
        decision: {} as never,
      };
    }),
  };
  const loadWorker = vi.fn(async () => worker);
  const claimInboxMessage = vi.fn(async () => inbox());
  const backend = createDurableStoreGovernedWorkerBackend({
    loadWorker,
    claimInboxMessage,
    reconcileWorker: vi.fn(async ({ worker: current }) => ({
      worker: current,
      disposition: "not_required" as const,
      evidenceSha256: null,
      reason: null,
    })),
    transitions,
  });
  const coordinator = new GovernedWorkerCoordinator({
    recipes: new GovernedWorkerRecipeRegistry([{
      id: "membership.lookup",
      workerKind: "membership.lookup",
      capabilityManifest: manifest,
    }]),
    backend,
    resolveAuthority: async ({ operation, context: execution }) => authority(operation, execution),
    journal: new InMemoryGovernedWorkerOperationJournal(),
    now: () => Date.parse("2026-07-28T17:00:00.000Z"),
  });
  return {
    coordinator,
    transitions,
    loadWorker,
    claimInboxMessage,
    set worker(value: DurableVoiceWorker) { worker = value; },
  };
}

const invocationScope = {
  callId: ids.call,
  agentId: ids.agent,
  orgId: ids.organization,
};

describe("durable store governed worker backend", () => {
  it("maps a spawn receipt to the atomic governed store transition", async () => {
    const fixture = setup();
    const execution = context("spawn", "spawn");
    const result = await fixture.coordinator.spawn({
      recipeId: "membership.lookup",
      input: workerInput,
    }, { scope: invocationScope, context: execution });

    expect(result.outcome.worker).toMatchObject({
      id: ids.worker,
      organizationId: ids.organization,
      workerKind: "membership.lookup",
    });
    expect(fixture.transitions.spawn).toHaveBeenCalledWith(expect.objectContaining({
      expectedHead: { sequence: 7, sha256: "b".repeat(64) },
      workerIdempotencyKey: execution.idempotencyKey,
      workerKind: "membership.lookup",
      sourceCallId: ids.call,
      authority: expect.objectContaining({
        organizationId: ids.organization,
        policyEpoch: 3,
        source: "voice_call",
      }),
    }));
    const transition = fixture.transitions.spawn.mock.calls[0]?.[0] as {
      conversationEvent: { idempotencyKey: string; occurredAtMs: number };
    };
    expect(transition.conversationEvent.idempotencyKey).toMatch(/^gw:[a-f0-9]{64}$/);
    expect(transition.conversationEvent.occurredAtMs).toBe(Date.parse("2026-07-28T16:59:00.000Z"));
  });

  it("does not append another cancellation transition for a terminal worker", async () => {
    const fixture = setup(durableWorker({
      status: "cancelled",
      cancellationEpoch: 1,
      settledAt: "2026-07-28T17:00:00.000Z",
    }));
    const result = await fixture.coordinator.cancel(
      { workerId: ids.worker },
      { scope: invocationScope, context: context("cancel", "terminal") }
    );

    expect(result.outcome.worker).toMatchObject({ status: "cancelled", cancellationEpoch: 1 });
    expect(fixture.transitions.cancel).not.toHaveBeenCalled();
  });

  it("returns a late-result deferral without applying or acknowledging the inbox message", async () => {
    const worker = durableWorker({
      status: "succeeded",
      result: preparedResult.result,
      resultSha256: preparedResult.resultSha256,
      settledAt: "2026-07-28T16:59:30.000Z",
    });
    const fixture = setup(worker);
    fixture.transitions.deliver.mockRejectedValue(new GovernedWorkerResultNotApplicableError({
      deliveryId: ids.message,
      workerId: ids.worker,
      eventId: "late-result-event",
      status: "deferred",
      reason: "an authoritative dependency fact changed while worker was running",
      appliedSequence: null,
      logicalHash: "e".repeat(64),
    }));

    const result = await fixture.coordinator.deliverResult(
      { workerId: ids.worker, messageId: ids.message },
      { scope: invocationScope, context: context("deliverResult", "late-result") }
    );

    expect(result.outcome).toMatchObject({
      disposition: "deferred",
      messageId: ids.message,
      conversationEventId: null,
      reason: expect.stringMatching(/dependency fact changed/),
    });
    expect(fixture.transitions.deliver).toHaveBeenCalledTimes(1);
    expect(fixture.claimInboxMessage).toHaveBeenCalledWith({
      messageId: ids.message,
      workerId: ids.worker,
      organizationId: ids.organization,
      conversationId: ids.conversation,
    });
  });
});
