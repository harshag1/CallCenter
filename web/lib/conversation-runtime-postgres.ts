import "server-only";

import {
  ConversationHeadConflictError,
  appendPersistedConversationEvents,
  loadPersistedConversationLog,
} from "./conversation-store";
import {
  defineConversationRuntime,
  type ConversationRuntimeEventStore,
} from "./conversation-runtime";

export const postgresConversationEventStore: ConversationRuntimeEventStore = Object.freeze({
  load: loadPersistedConversationLog,
  append: (input: Parameters<ConversationRuntimeEventStore["append"]>[0]) =>
    appendPersistedConversationEvents({
      ...input.scope,
      expectedHead: input.expectedHead,
      events: input.events,
    }),
});

export function createPostgresConversationRuntime(options: Readonly<{
  maximumAttempts?: number;
}> = {}) {
  return defineConversationRuntime({
    store: postgresConversationEventStore,
    isConflict: (error) => error instanceof ConversationHeadConflictError,
    ...options,
  });
}
