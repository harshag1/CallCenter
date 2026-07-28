import { describe, expect, it, vi } from "vitest";
import {
  GOVERNED_WORKER_TOOL_NAMES,
  GovernedWorkerCoordinator,
  GovernedWorkerRecipeRegistry,
  InMemoryGovernedWorkerOperationJournal,
  createGovernedWorkerToolPack,
  type GovernedWorkerAuthorityReceipt,
  type GovernedWorkerBackend,
  type GovernedWorkerOperation,
  type GovernedWorkerSnapshot,
} from "../voice-workers/coordinator";
import type {
  VoiceToolExecutionContext,
  VoiceToolScope,
} from "../voice-tools/types";
import { composeVoiceToolPacks } from "../voice-tools/packs";
import { VoiceToolRegistry } from "../voice-tools/registry";

const ids = {
  conversation: "8916eb0a-5332-4f4c-a330-746c516e83b9",
  organization: "8916eb0a-5332-4f4c-a330-746c516e83ba",
  agent: "8916eb0a-5332-4f4c-a330-746c516e83bb",
  call: "8916eb0a-5332-4f4c-a330-746c516e83bc",
  worker: "8916eb0a-5332-5f4c-a330-746c516e83bd",
  message: "8916eb0a-5332-4f4c-a330-746c516e83be",
};

const nowMs = Date.parse("2026-07-28T17:00:00.000Z");
const scope: VoiceToolScope = {
  callId: ids.call,
  agentId: ids.agent,
  orgId: ids.organization,
};

const workerInput = {
  v: 1 as const,
  objective: "Check the caller's membership terms after the call continues.",
  context: { memberId: "MEM-42" },
  deliverable: "Return current terms with evidence.",
};

const recipes = new GovernedWorkerRecipeRegistry([{
  id: "membership.lookup",
  workerKind: "membership.lookup",
  capabilityManifest: {
    v: 1,
    mode: "read_only",
    capabilities: ["membership.lookup"],
    networkOrigins: ["https://members.example.com/"],
  },
}]);

function executionContext(
  operation: GovernedWorkerOperation,
  identity: string,
  audience: VoiceToolExecutionContext["audience"] =
    operation === "reconcile" || operation === "deliverResult" ? "reconciliation" : "flow_action"
): VoiceToolExecutionContext {
  return {
    audience,
    invocationId: `invocation:${identity}`,
    idempotencyKey: `idempotency:${identity}`,
    receiptId: `receipt:${identity}`,
    runtimeDigest: "a".repeat(64),
  };
}

function authority(
  operation: GovernedWorkerOperation,
  context: VoiceToolExecutionContext,
  policyEpoch = 3
): GovernedWorkerAuthorityReceipt {
  return {
    v: 1,
    receiptId: context.receiptId!,
    invocationId: context.invocationId!,
    runtimeDigest: context.runtimeDigest!,
    organizationId: ids.organization,
    agentId: ids.agent,
    agentVersion: 1,
    callId: ids.call,
    conversationId: ids.conversation,
    conversationHeadSha256: "b".repeat(64),
    conversationRevision: 12,
    goalId: "membership_renewal",
    policyEpoch,
    factDependencies: [{ key: "membership_tier", revision: 1 }],
    allowedOperations: [operation],
    allowedRecipeIds: ["membership.lookup"],
    issuedAt: "2026-07-28T16:59:00.000Z",
    expiresAt: "2026-07-28T17:01:00.000Z",
  };
}

function snapshot(overrides: Partial<GovernedWorkerSnapshot> = {}): GovernedWorkerSnapshot {
  return {
    id: ids.worker,
    conversationId: ids.conversation,
    organizationId: ids.organization,
    workerKind: "membership.lookup",
    status: "pending",
    authoritySha256: "c".repeat(64),
    inputSha256: "d".repeat(64),
    capabilityManifestSha256: "e".repeat(64),
    cancellationEpoch: 0,
    claimedCancellationEpoch: null,
    leaseExpiresAt: null,
    dispatchStartedAt: null,
    checkpoint: null,
    resultSha256: null,
    settledAt: null,
    ...overrides,
  };
}

function fixture() {
  let worker = snapshot();
  let spawnPolicyEpoch = 0;
  let currentPolicyEpoch = 3;
  let cancellationTransitions = 0;
  let resultAcknowledgements = 0;

  const calls = {
    spawn: vi.fn(async ({ authority: receipt }: Parameters<GovernedWorkerBackend["spawn"]>[0]) => {
      spawnPolicyEpoch = receipt.policyEpoch;
      return worker;
    }),
    status: vi.fn(async () => worker),
    cancel: vi.fn(async () => {
      if (!["succeeded", "failed", "cancelled", "indeterminate"].includes(worker.status)) {
        cancellationTransitions += 1;
        worker = snapshot({
          ...worker,
          status: worker.status === "pending" ? "cancelled" : "cancel_requested",
          cancellationEpoch: worker.cancellationEpoch + 1,
          settledAt: worker.status === "pending" ? "2026-07-28T17:00:00.000Z" : worker.settledAt,
        });
      }
      return worker;
    }),
    reconcile: vi.fn(async () => {
      if (worker.status === "running" && worker.dispatchStartedAt && worker.leaseExpiresAt &&
          Date.parse(worker.leaseExpiresAt) <= nowMs) {
        worker = snapshot({
          ...worker,
          status: "indeterminate",
          leaseExpiresAt: null,
          settledAt: "2026-07-28T17:00:00.000Z",
        });
        return {
          worker,
          disposition: "indeterminate" as const,
          evidenceSha256: "f".repeat(64),
          reason: "executor lease expired after the external dispatch boundary",
        };
      }
      return {
        worker,
        disposition: "not_required" as const,
        evidenceSha256: null,
        reason: null,
      };
    }),
    deliverResult: vi.fn(async ({ messageId }: Parameters<GovernedWorkerBackend["deliverResult"]>[0]) => {
      if (spawnPolicyEpoch !== currentPolicyEpoch) {
        return {
          worker,
          messageId,
          disposition: "deferred" as const,
          resultSha256: "1".repeat(64),
          conversationEventId: null,
          conversationEventSha256: null,
          reason: "worker result was produced under a stale policy epoch",
        };
      }
      resultAcknowledgements += 1;
      return {
        worker,
        messageId,
        disposition: "accepted" as const,
        resultSha256: "1".repeat(64),
        conversationEventId: "worker-result-event",
        conversationEventSha256: "2".repeat(64),
        reason: null,
      };
    }),
  } satisfies GovernedWorkerBackend;

  const resolveAuthority = vi.fn(async (request: {
    operation: GovernedWorkerOperation;
    context: VoiceToolExecutionContext;
  }) => authority(request.operation, request.context, currentPolicyEpoch));
  const coordinator = new GovernedWorkerCoordinator({
    recipes,
    backend: calls,
    resolveAuthority,
    journal: new InMemoryGovernedWorkerOperationJournal(),
    now: () => nowMs,
  });
  return {
    coordinator,
    calls,
    resolveAuthority,
    get worker() { return worker; },
    set worker(value: GovernedWorkerSnapshot) { worker = value; },
    get cancellationTransitions() { return cancellationTransitions; },
    get resultAcknowledgements() { return resultAcknowledgements; },
    set currentPolicyEpoch(value: number) { currentPolicyEpoch = value; },
  };
}

describe("governed worker coordinator", () => {
  it("coalesces concurrent duplicate spawn and rejects changed bytes under the same identity", async () => {
    const setup = fixture();
    const context = executionContext("spawn", "spawn-1");
    const command = {
      recipeId: "membership.lookup",
      input: workerInput,
    };
    const [first, duplicate] = await Promise.all([
      setup.coordinator.spawn(command, { scope, context }),
      setup.coordinator.spawn(command, { scope, context }),
    ]);

    expect(setup.calls.spawn).toHaveBeenCalledTimes(1);
    expect([first.replayed, duplicate.replayed].sort()).toEqual([false, true]);
    expect(first.receiptSha256).toBe(duplicate.receiptSha256);
    expect(first.outcome.worker?.id).toBe(ids.worker);
    expect(first.receipt).toMatchObject({
      operation: "spawn",
      authorityReceiptId: context.receiptId,
      idempotencyKey: context.idempotencyKey,
      workerId: ids.worker,
    });

    await expect(setup.coordinator.spawn({
      ...command,
      input: { ...workerInput, objective: "A conflicting objective." },
    }, { scope, context })).rejects.toThrow(/idempotency key was reused/);
    expect(setup.calls.spawn).toHaveBeenCalledTimes(1);
  });

  it("quarantines post-dispatch lease loss as indeterminate without spawning or dispatching again", async () => {
    const setup = fixture();
    await setup.coordinator.spawn({
      recipeId: "membership.lookup",
      input: workerInput,
    }, { scope, context: executionContext("spawn", "lease-spawn") });
    setup.worker = snapshot({
      status: "running",
      leaseExpiresAt: "2026-07-28T16:59:59.000Z",
      dispatchStartedAt: "2026-07-28T16:58:00.000Z",
      claimedCancellationEpoch: 0,
    });

    const reconciled = await setup.coordinator.reconcile(
      { workerId: ids.worker },
      { scope, context: executionContext("reconcile", "lease-reconcile") }
    );

    expect(reconciled.outcome).toMatchObject({
      disposition: "indeterminate",
      worker: { id: ids.worker, status: "indeterminate" },
      reason: expect.stringMatching(/after the external dispatch boundary/),
    });
    expect(setup.calls.spawn).toHaveBeenCalledTimes(1);
    expect(setup.calls.reconcile).toHaveBeenCalledTimes(1);
  });

  it("makes duplicate cancellation one transition and leaves terminal workers unchanged", async () => {
    const setup = fixture();
    setup.worker = snapshot({
      status: "running",
      leaseExpiresAt: "2026-07-28T17:00:30.000Z",
      claimedCancellationEpoch: 0,
    });
    const context = executionContext("cancel", "cancel-1");

    const first = await setup.coordinator.cancel({ workerId: ids.worker }, { scope, context });
    const replay = await setup.coordinator.cancel({ workerId: ids.worker }, { scope, context });
    expect(first.outcome.worker).toMatchObject({ status: "cancel_requested", cancellationEpoch: 1 });
    expect(replay.replayed).toBe(true);
    expect(setup.cancellationTransitions).toBe(1);
    expect(setup.calls.cancel).toHaveBeenCalledTimes(1);

    setup.worker = snapshot({
      ...setup.worker,
      status: "cancelled",
      settledAt: "2026-07-28T17:00:01.000Z",
    });
    const terminal = await setup.coordinator.cancel(
      { workerId: ids.worker },
      { scope, context: executionContext("cancel", "cancel-after-terminal") }
    );
    expect(terminal.outcome.worker).toMatchObject({ status: "cancelled", cancellationEpoch: 1 });
    expect(setup.cancellationTransitions).toBe(1);
  });

  it("defers a late result under newer policy and never acknowledges it, including on replay", async () => {
    const setup = fixture();
    setup.currentPolicyEpoch = 2;
    await setup.coordinator.spawn({
      recipeId: "membership.lookup",
      input: workerInput,
    }, { scope, context: executionContext("spawn", "result-spawn") });
    setup.worker = snapshot({
      status: "succeeded",
      resultSha256: "1".repeat(64),
      settledAt: "2026-07-28T17:00:00.000Z",
    });
    setup.currentPolicyEpoch = 3;
    const context = executionContext("deliverResult", "late-result");

    const first = await setup.coordinator.deliverResult(
      { workerId: ids.worker, messageId: ids.message },
      { scope, context }
    );
    const replay = await setup.coordinator.deliverResult(
      { workerId: ids.worker, messageId: ids.message },
      { scope, context }
    );

    expect(first.outcome).toMatchObject({
      disposition: "deferred",
      conversationEventId: null,
      reason: expect.stringMatching(/stale policy epoch/),
    });
    expect(replay.replayed).toBe(true);
    expect(setup.calls.deliverResult).toHaveBeenCalledTimes(1);
    expect(setup.resultAcknowledgements).toBe(0);
  });

  it("fails before backend I/O for the wrong audience or a substituted authority receipt", async () => {
    const setup = fixture();
    const direct = executionContext("spawn", "wrong-audience", "direct");
    await expect(setup.coordinator.spawn({
      recipeId: "membership.lookup",
      input: workerInput,
    }, { scope, context: direct })).rejects.toThrow(/not allowed for the direct audience/);
    expect(setup.resolveAuthority).not.toHaveBeenCalled();
    expect(setup.calls.spawn).not.toHaveBeenCalled();

    const context = executionContext("spawn", "substituted-receipt");
    setup.resolveAuthority.mockResolvedValue({
      ...authority("spawn", context),
      organizationId: "another-organization",
    });
    await expect(setup.coordinator.spawn({
      recipeId: "membership.lookup",
      input: workerInput,
    }, { scope, context })).rejects.toThrow(/does not match the gateway invocation/);
    expect(setup.calls.spawn).not.toHaveBeenCalled();
  });

  it("exports a five-primitive provider-neutral tool pack with recipe-pinned spawn schema", () => {
    const setup = fixture();
    const pack = createGovernedWorkerToolPack({
      coordinator: setup.coordinator,
      version: "1.0.0",
    });

    expect(pack.id).toBe("hacc.governed-workers");
    expect(pack.tools.map(({ name }) => name)).toEqual(Object.values(GOVERNED_WORKER_TOOL_NAMES));
    expect(pack.tools.find(({ name }) => name === GOVERNED_WORKER_TOOL_NAMES.spawn)?.inputSchema)
      .toMatchObject({
        properties: {
          recipeId: { enum: ["membership.lookup"] },
        },
      });
    expect(pack.tools.find(({ name }) => name === GOVERNED_WORKER_TOOL_NAMES.status)?.effect).toBe("read");
    expect(pack.tools.filter(({ effect }) => effect === "write")).toHaveLength(4);
    expect(() => new VoiceToolRegistry(composeVoiceToolPacks([pack]))).not.toThrow();
  });
});
