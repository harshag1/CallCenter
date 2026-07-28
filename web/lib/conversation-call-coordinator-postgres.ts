import "server-only";

import { randomUUID } from "node:crypto";
import {
  defineConversationCallCoordinator,
  type ConversationCallActionAuthority,
  type ConversationCallWorkerStore,
} from "./conversation-call-coordinator";
import { createPostgresConversationRuntime } from "./conversation-runtime-postgres";
import {
  reserveGovernedFlowActionAtomic,
  type GovernedFlowActionArgs,
  type GovernedFlowActionResult,
} from "./flow-state-store";
import type { AgentFlow } from "./flow";
import {
  spawnGovernedDurableVoiceWorker,
  type DurableVoiceWorker,
  type GovernedVoiceWorkerSpawnAuthority,
} from "./voice-workers/store";

export type GovernedCallActionRequest = Readonly<{
  callId: string;
  flow: AgentFlow;
  arguments: Omit<GovernedFlowActionArgs, "receiptId" | "invocationId" | "ownerToken">;
}>;

export type GovernedCallActionResult =
  | GovernedFlowActionResult
  | Readonly<{ error: string; code: string }>;

export type GovernedCallWorkerRequest = Readonly<{
  workerKind: string;
  authority: GovernedVoiceWorkerSpawnAuthority;
  workerInput: unknown;
  capabilityManifest: unknown;
  sourceCallId?: string;
  parentWorkerId?: string;
}>;

export function createGovernedCallActionAuthority(): ConversationCallActionAuthority<
  GovernedCallActionRequest,
  GovernedCallActionResult
> {
  const authority: ConversationCallActionAuthority<GovernedCallActionRequest, GovernedCallActionResult> = {
    async reserve(input) {
      if (input.request.arguments.runtimeDigest !== input.conversation.state.currentFlowCheckpoint?.runtimeDigest) {
        throw new Error("action runtime digest does not match the durable Flow checkpoint");
      }
      if (input.request.arguments.capabilityEpoch !==
          input.conversation.state.currentFlowCheckpoint?.capabilityEpoch) {
        throw new Error("action capability epoch does not match the durable Flow checkpoint");
      }
      return reserveGovernedFlowActionAtomic(
        input.request.callId,
        input.request.flow,
        {
          ...input.request.arguments,
          receiptId: input.deterministicUuid,
          invocationId: input.idempotencyKey,
          // The receipt/invocation identities must replay deterministically.
          // The dispatch-owner token is a secret lease capability and must not
          // be derivable from public turn identities.
          ownerToken: randomUUID(),
        },
      );
    },
  };
  return Object.freeze(authority);
}

export function createGovernedCallWorkerStore(): ConversationCallWorkerStore<
  GovernedCallWorkerRequest,
  DurableVoiceWorker
> {
  const store: ConversationCallWorkerStore<GovernedCallWorkerRequest, DurableVoiceWorker> = {
    async spawn(input) {
      if (input.request.authority.conversationId !== input.scope.conversationId ||
          input.request.authority.organizationId !== input.scope.organizationId) {
        throw new Error("worker authority does not match the conversation coordinator scope");
      }
      const transition = await spawnGovernedDurableVoiceWorker({
        expectedHead: input.conversation.head,
        conversationEvent: {
          idempotencyKey: input.idempotencyKey,
          eventId: input.eventId,
          occurredAtMs: input.occurredAtMs,
        },
        workerIdempotencyKey: input.idempotencyKey,
        workerKind: input.request.workerKind,
        authority: input.request.authority,
        workerInput: input.request.workerInput,
        capabilityManifest: input.request.capabilityManifest,
        ...(input.request.sourceCallId ? { sourceCallId: input.request.sourceCallId } : {}),
        ...(input.request.parentWorkerId ? { parentWorkerId: input.request.parentWorkerId } : {}),
      });
      return Object.freeze({ event: transition.event, value: transition.worker });
    },
  };
  return Object.freeze(store);
}

/**
 * Production composition root. Routes can adopt this behind a feature flag
 * without changing the provider adapters or weakening their existing stores.
 */
export function createPostgresConversationCallCoordinator(options: Readonly<{
  maximumAttempts?: number;
}> = {}) {
  return defineConversationCallCoordinator({
    runtime: createPostgresConversationRuntime(options),
    actionAuthority: createGovernedCallActionAuthority(),
    workerStore: createGovernedCallWorkerStore(),
  });
}
