import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { q } from "./db";
import { createPostgresConversationCallCoordinator } from "./conversation-call-coordinator-postgres";
import { createPostgresConversationRuntime } from "./conversation-runtime-postgres";
import {
  defineLiveConversationRoute,
  type LiveConversationRouteInput,
  type LiveConversationRouteResult,
} from "./live-conversation-route";
import type { AudibleTurn } from "./realtime-context-packet";
import {
  GovernedWorkerResultNotApplicableError,
  applyGovernedDurableConversationInboxMessage,
  applyGovernedDurableConversationTerminalMessage,
  claimDurableConversationInbox,
  ensureDurableVoiceConversation,
  loadDurableVoiceWorker,
} from "./voice-workers/store";

const runtime = createPostgresConversationRuntime();
const coordinator = createPostgresConversationCallCoordinator();

function deterministicUuid(domain: string, identity: string): string {
  const digest = createHash("sha256")
    .update(`hacc/live-conversation-route/${domain}/v1\0`, "utf8")
    .update(identity, "utf8")
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${digest.slice(18, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

async function deliverPendingWorkerResults(
  scope: Readonly<{ conversationId: string; organizationId: string }>,
): Promise<number> {
  const deliveryToken = randomUUID();
  const messages = await claimDurableConversationInbox({
    ...scope,
    deliveryToken,
    leaseMs: 30_000,
    maximumMessages: 16,
  });
  let accepted = 0;
  for (const message of messages) {
    if (!message.deliveryToken) throw new Error("claimed worker update lost its delivery lease");
    const loaded = await runtime.load(scope);
    const applicationId = deterministicUuid("application", message.id);
    const eventIdentity = createHash("sha256")
      .update("hacc/live-conversation-route/worker-result/v1\0", "utf8")
      .update(message.id, "utf8")
      .digest("hex");
    try {
      if (message.kind === "terminal") {
        await applyGovernedDurableConversationTerminalMessage({
          expectedHead: {
            sequence: loaded.state.eventCount,
            sha256: loaded.state.headHash,
          },
          conversationEvent: {
            idempotencyKey: `live-route-worker:${eventIdentity}`,
            eventId: `live-route-worker/${eventIdentity}`,
            occurredAtMs: Date.parse(message.createdAt),
          },
          organizationId: scope.organizationId,
          deliveryToken: message.deliveryToken,
          applicationId,
          message,
        });
      } else {
        const worker = await loadDurableVoiceWorker({
          workerId: message.workerId,
          ...scope,
        });
        if (!worker) throw new Error("claimed worker result lost its immutable succeeded worker");
        await applyGovernedDurableConversationInboxMessage({
          expectedHead: {
            sequence: loaded.state.eventCount,
            sha256: loaded.state.headHash,
          },
          conversationEvent: {
            idempotencyKey: `live-route-worker:${eventIdentity}`,
            eventId: `live-route-worker/${eventIdentity}`,
            occurredAtMs: Date.parse(worker.settledAt),
          },
          organizationId: scope.organizationId,
          deliveryToken: message.deliveryToken,
          applicationId,
          worker,
          message,
        });
      }
      accepted += 1;
    } catch (error) {
      // Deferred/superseded work is evidence, not a route failure and not
      // provider authority. Its inbox lease expires for a later applicable
      // goal; every other integrity or storage error fails provider routing.
      if (!(error instanceof GovernedWorkerResultNotApplicableError)) throw error;
    }
  }
  return accepted;
}

const route = defineLiveConversationRoute({
  runtime,
  coordinator: coordinator as unknown as Parameters<typeof defineLiveConversationRoute>[0]["coordinator"],
  ensureConversation: ensureDurableVoiceConversation,
  deliverPendingWorkerResults,
});

export async function recentAudibleTurnsForCall(callId: string): Promise<readonly AudibleTurn[]> {
  const rows = await q<{
    id: string | number;
    type: "user_said" | "agent_said";
    text: string;
    ts: Date | string;
  }>(
    `SELECT event.id, event.type, event.payload->>'text' AS text, event.ts
     FROM (
       SELECT id, type, payload, ts
       FROM call_events
       WHERE call_id = $1
         AND type IN ('user_said','agent_said')
         AND jsonb_typeof(payload) = 'object'
         AND jsonb_typeof(payload->'text') = 'string'
       ORDER BY id DESC
       LIMIT 128
     ) event
     ORDER BY event.id ASC`,
    [callId],
  );
  return Object.freeze(rows.flatMap((row): AudibleTurn[] => {
    const text = row.text.trim().slice(0, 8_192);
    const heardAtMs = new Date(row.ts).getTime();
    if (!text || !Number.isSafeInteger(heardAtMs) || heardAtMs < 0) return [];
    return [{
      turnId: `call-event-${row.id}`,
      speaker: row.type === "user_said" ? "caller" : "agent",
      text,
      deliveryEvidence: row.type === "user_said"
        ? "caller_input_transcript"
        : "provider_transcript_unverified_playback",
      heardAtMs,
    }];
  }));
}

export async function preparePostgresLiveConversationRoute(
  input: Omit<LiveConversationRouteInput, "recentAudibleTurns">,
): Promise<LiveConversationRouteResult> {
  return route.prepare({
    ...input,
    recentAudibleTurns: await recentAudibleTurnsForCall(input.callId),
  });
}
