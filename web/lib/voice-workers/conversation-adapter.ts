import {
  type ConversationEventPayload,
  type JsonValue,
} from "../conversation-kernel";
import {
  VoiceWorkerResultSchema,
  VoiceWorkerSpawnAuthoritySchema,
  hashVoiceWorkerValue,
  type VoiceWorkerInput,
} from "./schema";

type WorkerForConversationAdapter = Readonly<{
  id: string;
  conversationId: string;
  authority: unknown;
  input: VoiceWorkerInput;
}>;

type WorkerResultForConversationAdapter = Readonly<{
  id: string;
  conversationId: string;
  authority: unknown;
  resultSha256?: string | null;
}>;

type InboxForConversationAdapter = Readonly<{
  id: string;
  conversationId: string;
  workerId: string;
  result: unknown;
  resultSha256: string;
}>;

/**
 * Converts immutable database authority into the kernel's worker contract.
 * Goal, policy and dependency scope always come from host-authored authority,
 * never from the worker result or realtime model.
 */
export function workerSpawnedConversationPayload(
  worker: WorkerForConversationAdapter,
): Extract<ConversationEventPayload, { type: "worker.spawned" }> {
  const authority = VoiceWorkerSpawnAuthoritySchema.parse(worker.authority);
  if (authority.conversationId !== worker.conversationId) {
    throw new Error("worker conversation does not match its immutable authority");
  }
  return {
    type: "worker.spawned",
    workerId: worker.id,
    goalId: authority.goalId,
    purpose: worker.input.objective,
    policyEpoch: authority.policyEpoch,
    dependencies: authority.factDependencies,
  };
}

/**
 * Produces a delivery proposal for the event-sourced kernel. The kernel still
 * decides accept/defer/reject against current goal, fact and policy revisions.
 * Proposed actions and citations remain cold evidence; they are never promoted
 * into executable authority or model-visible control state here.
 */
export function workerResultConversationPayload(
  worker: WorkerResultForConversationAdapter,
  message: InboxForConversationAdapter,
): Extract<ConversationEventPayload, { type: "worker.result_delivered" }> {
  const authority = VoiceWorkerSpawnAuthoritySchema.parse(worker.authority);
  const result = VoiceWorkerResultSchema.parse(message.result);
  const resultSha256 = hashVoiceWorkerValue(result);
  if (worker.id !== message.workerId || worker.conversationId !== message.conversationId ||
      authority.conversationId !== message.conversationId) {
    throw new Error("worker result is bound to another conversation or worker");
  }
  if (resultSha256 !== message.resultSha256 ||
      (worker.resultSha256 !== null && worker.resultSha256 !== undefined && worker.resultSha256 !== resultSha256)) {
    throw new Error("worker result digest does not match durable evidence");
  }
  return {
    type: "worker.result_delivered",
    deliveryId: message.id,
    workerId: worker.id,
    goalId: authority.goalId,
    policyEpoch: authority.policyEpoch,
    dependencyFactRevisions: authority.factDependencies,
    facts: result.facts.map((fact) => ({
      key: fact.key,
      value: fact.value as JsonValue,
      evidenceId: fact.citationIds[0] ?? `result-${resultSha256.slice(0, 24)}`,
    })),
    advisories: [{
      episodeId: `worker-${worker.id}`,
      // The full summary remains in private immutable worker evidence. Kernel
      // advisories have a stricter 4,096-character contract, so projection
      // cannot turn a valid 8,192-character result into a poison inbox row.
      text: result.summary.slice(0, 4_096),
    }],
  };
}
