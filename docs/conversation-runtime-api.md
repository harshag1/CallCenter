# Durable conversation runtime API

This is the current provider-neutral integration surface for long conversations. The provider remains responsible for speech transport; the application owns conversation authority.

## Build a runtime

`defineConversationRuntime` accepts any event store implementing `load` and compare-and-append `append`. PostgreSQL deployments can adapt the checked-in verified store functions directly:

```ts
import {
  ConversationHeadConflictError,
  appendPersistedConversationEvents,
  loadPersistedConversationLog,
} from "@/lib/conversation-store";
import { defineConversationRuntime } from "@/lib/conversation-runtime";

export const runtime = defineConversationRuntime({
  store: {
    load: loadPersistedConversationLog,
    append: appendPersistedConversationEvents,
  },
  isConflict: (error) => error instanceof ConversationHeadConflictError,
  maximumAttempts: 8,
});
```

`runtime.transact` loads and verifies the current log, folds its state, asks the caller to plan 1–64 idempotent events, validates the candidate semantic transitions, and compare-and-appends them. A competing writer causes a bounded reload and replan. An exact retry returns the original event instead of appending twice.

## Compile realtime context

```ts
const packet = await runtime.compilePacket({
  scope: { conversationId, organizationId },
  capabilityCatalogDigest,
  capabilityEpoch,
  capabilities,
  recentAudibleTurns,
  byteBudget: 8_192,
});
```

The compiler preserves mandatory policy, corrected facts, goals, commitments, the current Flow checkpoint, worker status, and host-derived capabilities before trimming recent caller-heard turns. If mandatory state cannot fit, it returns typed `context_overflow`; it never silently removes a blocker.

## Bind an existing Flow

Use `createFlowCheckpointEvent` and `flowCheckpointIdempotencyKey` from `@/lib/flow-conversation-adapter` inside `runtime.transact`. The conversation fold rejects checkpoint events that change runtime identity, move revision or capability epoch backward, target the wrong goal, or reopen a terminal Flow.

## Admit an action

Use `reserveGovernedFlowActionAtomic` from `@/lib/flow-state-store`. It locks the active call and Flow state, evaluates the supplied policy against the exact state digest/revision/epoch, database time, durable prior dispatch count, arguments, facts, receipts, and readback confirmation, then persists append-only evidence. The conversation coordinator also supplies the host-derived conversation and organization scope: migration `036` locks the call's unique conversation attachment and records the complete action authority under the deterministic action identity in that same transaction. A retry must match the call, conversation, organization, invocation, and canonical digests of the policy, arguments, facts, receipts, and confirmation. Only an `allow` decision can reserve an action receipt.

The returned public policy object exposes decision and binding digests, not the underlying evidence hashes. Callers should still use the existing dispatch-start and settlement APIs; post-dispatch policy evaluation is currently a pure kernel and has not yet replaced the live MCP settlement path.

## Spawn durable work

Use `spawnGovernedDurableVoiceWorker` and `applyGovernedDurableConversationInboxMessage` from `@/lib/voice-workers/store`. Spawn atomically appends `worker.spawned` and creates the job bound to the resulting conversation head. Result application first folds the current conversation state; a stale, superseded, or conflicting result is deferred/rejected without touching the database transition. An accepted result event and inbox acknowledgement commit together.

Worker executors use the lower-level claim, heartbeat, checkpoint, settle, and cancellation functions. Capabilities are immutable manifests; executors do not receive arbitrary conversation authority.

## Current release boundary

The live browser/MCP path now:

1. mirrors Flow checkpoints into the conversation log;
2. compiles and injects a bounded packet on session creation/reconnect and
   refreshes it after MCP calls;
3. spawns `launch_task` work through an immutable, active-catalog-derived
   read-only worker manifest;
4. rechecks worker results against current dependencies before exactly-once
   application; and
5. labels transcripts and worker/model output as untrusted advisory data.

Flow v2 receipts still own live action reservations. General governed action
admission and a unified production repair controller remain non-default. The
optional browser speech gate covers exact phrases/secrets and does not establish
general spoken safety or PSTN playback.

Provider adapters should depend on this surface. None of these primitives should depend on provider-owned conversation history.
