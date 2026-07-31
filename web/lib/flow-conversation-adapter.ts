import { z } from "zod";
import {
  ConversationEventDraftSchema,
  canonicalJson,
  type ConversationEventDraft,
} from "./conversation-kernel";
import {
  FlowExecutionStateSchema,
  hashFlowValue,
  type FlowExecutionState,
} from "./flow-runtime";

const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export type FlowConversationCheckpointInput = Readonly<{
  eventId: string;
  occurredAtMs: number;
  goalId: string;
  runtimeDigest: string;
  state: FlowExecutionState;
}>;

/**
 * Projects the production Flow state into the conversation authority log.
 * The full Flow state remains in its dedicated store; this immutable checkpoint
 * is the cross-runtime binding used for recovery and stale-authority rejection.
 */
export function createFlowCheckpointEvent(input: FlowConversationCheckpointInput): ConversationEventDraft {
  const state = FlowExecutionStateSchema.parse(input.state);
  const eventId = IdSchema.parse(input.eventId);
  const goalId = IdSchema.parse(input.goalId);
  const runtimeDigest = HashSchema.parse(input.runtimeDigest);
  if (!Number.isSafeInteger(input.occurredAtMs) || input.occurredAtMs < 0) {
    throw new Error("flow checkpoint timestamp must be a safe non-negative integer");
  }

  const unresolvedActionIds = state.actionReceipts
    .filter(({ status }) => status === "reserved" || status === "indeterminate")
    .map(({ id }) => IdSchema.parse(id))
    .sort();
  if (unresolvedActionIds.length > 64) {
    throw new Error("flow checkpoint has more than 64 unresolved actions and cannot be safely projected");
  }

  return ConversationEventDraftSchema.parse({
    eventId,
    occurredAtMs: input.occurredAtMs,
    payload: {
      type: "flow.checkpoint_recorded" as const,
      goalId,
      runtimeDigest,
      flowRevision: state.revision,
      capabilityEpoch: state.capabilityEpoch,
      status: state.status,
      nodeId: state.nodeId,
      currentStep: state.currentStep,
      completedStepCount: state.completedSteps.length,
      unresolvedActionIds,
      stateDigest: hashFlowValue(state),
    },
  });
}

/** Stable idempotency identity for mirroring one Flow revision exactly once. */
export function flowCheckpointIdempotencyKey(input: Readonly<{
  goalId: string;
  runtimeDigest: string;
  state: FlowExecutionState;
}>): string {
  const state = FlowExecutionStateSchema.parse(input.state);
  const goalId = IdSchema.parse(input.goalId);
  const runtimeDigest = HashSchema.parse(input.runtimeDigest);
  return `flow-checkpoint:${goalId}:${state.revision}:${hashFlowValue({
    runtimeDigest,
    stateDigest: hashFlowValue(state),
    capabilityEpoch: state.capabilityEpoch,
  })}`;
}

/** Canonical checkpoint bytes are useful for audit manifests and external replay. */
export function canonicalFlowCheckpoint(input: FlowConversationCheckpointInput): string {
  return canonicalJson(createFlowCheckpointEvent(input));
}
