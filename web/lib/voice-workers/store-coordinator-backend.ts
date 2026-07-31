import "server-only";

import {
  GovernedWorkerResultNotApplicableError,
  applyGovernedDurableConversationInboxMessage,
  requestDurableVoiceWorkerCancellation,
  spawnGovernedDurableVoiceWorker,
  type DurableConversationInboxMessage,
  type DurableConversationResultInboxMessage,
  type DurableVoiceWorker,
  type DurableVoiceWorkerDelivery,
} from "./store";
import {
  VoiceWorkerCheckpointSchema,
  deriveVoiceWorkerId,
  hashVoiceWorkerValue,
} from "./schema";
import {
  GovernedWorkerSnapshotSchema,
  type GovernedWorkerAuthorityReceipt,
  type GovernedWorkerBackend,
  type GovernedWorkerReconciliation,
  type GovernedWorkerSnapshot,
} from "./coordinator";

const TERMINAL_WORKER_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "indeterminate",
]);

function projectSnapshot(worker: DurableVoiceWorker): GovernedWorkerSnapshot {
  const checkpoint = worker.checkpoint === null
    ? null
    : VoiceWorkerCheckpointSchema.parse(worker.checkpoint);
  return GovernedWorkerSnapshotSchema.parse({
    id: worker.id,
    conversationId: worker.conversationId,
    organizationId: worker.organizationId,
    workerKind: worker.workerKind,
    status: worker.status,
    authoritySha256: worker.authoritySha256,
    inputSha256: worker.inputSha256,
    capabilityManifestSha256: worker.capabilityManifestSha256,
    cancellationEpoch: worker.cancellationEpoch,
    claimedCancellationEpoch: worker.claimedCancellationEpoch,
    leaseExpiresAt: worker.leaseExpiresAt,
    dispatchStartedAt: worker.dispatchStartedAt,
    checkpoint: checkpoint === null ? null : {
      phase: checkpoint.phase,
      progress: checkpoint.progress,
      checkpointSha256: worker.checkpointSha256,
    },
    resultSha256: worker.resultSha256,
    settledAt: worker.settledAt,
  });
}

function assertScope(
  worker: DurableVoiceWorker,
  authority: GovernedWorkerAuthorityReceipt,
  workerId?: string
): void {
  if ((workerId && worker.id !== workerId) ||
      worker.conversationId !== authority.conversationId ||
      worker.organizationId !== authority.organizationId ||
      worker.authority.agentId !== authority.agentId) {
    throw new Error("durable voice worker crossed its governed conversation scope");
  }
}

function succeededDeliveryProjection(worker: DurableVoiceWorker): DurableVoiceWorkerDelivery | null {
  if (worker.status !== "succeeded" || !worker.resultSha256 || !worker.settledAt) return null;
  return Object.freeze({
    id: worker.id,
    conversationId: worker.conversationId,
    organizationId: worker.organizationId,
    sourceCallId: worker.sourceCallId,
    authority: worker.authority,
    authoritySha256: worker.authoritySha256,
    status: "succeeded",
    resultSha256: worker.resultSha256,
    settledAt: worker.settledAt,
  });
}

function eventIdentity(
  authority: GovernedWorkerAuthorityReceipt,
  operation: string,
  idempotencyKey: string
) {
  const digest = hashVoiceWorkerValue({
    operation,
    conversationId: authority.conversationId,
    idempotencyKey,
  });
  return Object.freeze({
    idempotencyKey: `gw:${digest}`,
    eventId: `governed-worker/${operation}/${digest}`,
    occurredAtMs: Date.parse(authority.issuedAt),
  });
}

export type DurableStoreGovernedWorkerBackendDependencies = Readonly<{
  /**
   * Must enforce worker + organization + conversation scope in its query. The
   * adapter independently rechecks the returned immutable authority.
   */
  loadWorker(input: Readonly<{
    workerId: string;
    organizationId: string;
    conversationId: string;
  }>): Promise<DurableVoiceWorker | null>;
  /**
   * Claims exactly this message, or returns null. It must not lease unrelated
   * inbox rows while searching for the target.
   */
  claimInboxMessage(input: Readonly<{
    messageId: string;
    workerId: string;
    organizationId: string;
    conversationId: string;
  }>): Promise<DurableConversationInboxMessage | null>;
  /**
   * Recipe-specific authoritative read-back. Pre-dispatch lease loss may be
   * reclaimed; post-dispatch uncertainty stays indeterminate until this
   * function returns evidence proving a terminal outcome.
   */
  reconcileWorker(input: Readonly<{
    worker: DurableVoiceWorker;
    authority: GovernedWorkerAuthorityReceipt;
    idempotencyKey: string;
  }>): Promise<GovernedWorkerReconciliation & Readonly<{ worker: DurableVoiceWorker }>>;
  transitions?: Readonly<{
    spawn: typeof spawnGovernedDurableVoiceWorker;
    cancel: typeof requestDurableVoiceWorkerCancellation;
    deliver: typeof applyGovernedDurableConversationInboxMessage;
  }>;
}>;

/**
 * Concrete bridge from the provider-neutral coordinator to the checked-in
 * atomic PostgreSQL worker/conversation transitions.
 */
export function createDurableStoreGovernedWorkerBackend(
  dependencies: DurableStoreGovernedWorkerBackendDependencies
): GovernedWorkerBackend {
  const transitions = dependencies.transitions ?? {
    spawn: spawnGovernedDurableVoiceWorker,
    cancel: requestDurableVoiceWorkerCancellation,
    deliver: applyGovernedDurableConversationInboxMessage,
  };

  return Object.freeze({
    async spawn(input) {
      const result = await transitions.spawn({
        expectedHead: {
          sequence: input.authority.conversationRevision,
          sha256: input.authority.conversationHeadSha256,
        },
        conversationEvent: eventIdentity(input.authority, "spawn", input.idempotencyKey),
        workerIdempotencyKey: input.idempotencyKey,
        workerKind: input.recipe.workerKind,
        authority: {
          v: 1,
          conversationId: input.authority.conversationId,
          organizationId: input.authority.organizationId,
          agentId: input.authority.agentId,
          agentVersion: input.authority.agentVersion,
          source: "voice_call",
          sourceCallId: input.authority.callId,
          goalId: input.authority.goalId,
          policyEpoch: input.authority.policyEpoch,
          factDependencies: input.authority.factDependencies,
        },
        workerInput: input.workerInput,
        capabilityManifest: input.recipe.capabilityManifest,
        sourceCallId: input.authority.callId,
      });
      assertScope(result.worker, input.authority);
      if (result.worker.capabilityManifestSha256 !== input.recipe.capabilityManifestSha256) {
        throw new Error("spawned worker returned a different capability manifest");
      }
      return projectSnapshot(result.worker);
    },

    async status(input) {
      const worker = await dependencies.loadWorker({
        workerId: input.workerId,
        organizationId: input.authority.organizationId,
        conversationId: input.authority.conversationId,
      });
      if (!worker) return null;
      assertScope(worker, input.authority, input.workerId);
      return projectSnapshot(worker);
    },

    async cancel(input) {
      const current = await dependencies.loadWorker({
        workerId: input.workerId,
        organizationId: input.authority.organizationId,
        conversationId: input.authority.conversationId,
      });
      if (!current) throw new Error("durable voice worker was not found");
      assertScope(current, input.authority, input.workerId);
      const worker = TERMINAL_WORKER_STATUSES.has(current.status)
        ? current
        : await transitions.cancel(input.workerId, input.authority.organizationId);
      assertScope(worker, input.authority, input.workerId);
      return projectSnapshot(worker);
    },

    async reconcile(input) {
      const worker = await dependencies.loadWorker({
        workerId: input.workerId,
        organizationId: input.authority.organizationId,
        conversationId: input.authority.conversationId,
      });
      if (!worker) throw new Error("durable voice worker was not found");
      assertScope(worker, input.authority, input.workerId);
      const result = await dependencies.reconcileWorker({
        worker,
        authority: input.authority,
        idempotencyKey: input.idempotencyKey,
      });
      assertScope(result.worker, input.authority, input.workerId);
      return Object.freeze({
        worker: projectSnapshot(result.worker),
        disposition: result.disposition,
        evidenceSha256: result.evidenceSha256,
        reason: result.reason,
      });
    },

    async deliverResult(input) {
      const worker = await dependencies.loadWorker({
        workerId: input.workerId,
        organizationId: input.authority.organizationId,
        conversationId: input.authority.conversationId,
      });
      if (!worker) throw new Error("durable voice worker was not found");
      assertScope(worker, input.authority, input.workerId);
      const message = await dependencies.claimInboxMessage({
        messageId: input.messageId,
        workerId: input.workerId,
        organizationId: input.authority.organizationId,
        conversationId: input.authority.conversationId,
      });
      if (!message) {
        return Object.freeze({
          worker: projectSnapshot(worker),
          messageId: input.messageId,
          disposition: "not_ready" as const,
          resultSha256: worker.resultSha256,
          conversationEventId: null,
          conversationEventSha256: null,
          reason: "no claimable immutable result is ready",
        });
      }
      if (message.workerId !== worker.id || message.conversationId !== worker.conversationId ||
          message.id !== input.messageId || !message.deliveryToken) {
        throw new Error("claimed worker result crossed scope or lacks a delivery lease");
      }
      const deliveryWorker = succeededDeliveryProjection(worker);
      if (message.kind !== "result" || !deliveryWorker) {
        return Object.freeze({
          worker: projectSnapshot(worker),
          messageId: input.messageId,
          disposition: "not_ready" as const,
          resultSha256: worker.resultSha256,
          conversationEventId: null,
          conversationEventSha256: null,
          reason: "the claimed update is not an applicable succeeded worker result",
        });
      }
      const resultMessage: DurableConversationResultInboxMessage = message;
      const conversationEvent = eventIdentity(
        input.authority,
        `deliver/${message.id}`,
        input.idempotencyKey
      );
      try {
        const applied = await transitions.deliver({
          expectedHead: {
            sequence: input.authority.conversationRevision,
            sha256: input.authority.conversationHeadSha256,
          },
          conversationEvent,
          organizationId: input.authority.organizationId,
          deliveryToken: message.deliveryToken,
          applicationId: deriveVoiceWorkerId(
            input.authority.conversationId,
            `result-application:${input.idempotencyKey}`
          ),
          worker: deliveryWorker,
          message: resultMessage,
        });
        return Object.freeze({
          worker: projectSnapshot(worker),
          messageId: message.id,
          disposition: "accepted" as const,
          resultSha256: resultMessage.resultSha256,
          conversationEventId: applied.event.eventId,
          conversationEventSha256: applied.event.hash,
          reason: null,
        });
      } catch (error) {
        if (!(error instanceof GovernedWorkerResultNotApplicableError)) throw error;
        return Object.freeze({
          worker: projectSnapshot(worker),
          messageId: message.id,
          disposition: error.decision.status,
          resultSha256: resultMessage.resultSha256,
          conversationEventId: null,
          conversationEventSha256: null,
          reason: error.decision.reason ?? "conversation policy did not accept the worker result",
        });
      }
    },
  });
}
