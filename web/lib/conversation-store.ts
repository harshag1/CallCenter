import "server-only";

import { createHash } from "node:crypto";
import { q, qOne } from "./db";
import {
  CONVERSATION_KERNEL_VERSION,
  GENESIS_HASH,
  ConversationEventDraftSchema,
  ConversationEventSchema,
  canonicalJson,
  foldConversation,
  validateConversationLog,
  type ConversationEvent,
  type ConversationEventDraft,
  type ConversationLog,
  type ConversationState,
} from "./conversation-kernel";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH_EVENTS = 64;
const MAX_BATCH_BYTES = 2_097_152;
const MAX_EVENT_BYTES = 32_768;
const LOAD_PAGE_SIZE = 1_024;

type ConversationEventRow = Readonly<{
  conversation_id: string;
  org_id: string;
  sequence: string | number;
  event_id: string;
  idempotency_key: string;
  occurred_at_ms: string | number;
  event_type: string;
  payload: unknown;
  previous_event_sha256: string;
  event_sha256: string;
  unsigned_event_text: string;
}>;

export type ConversationHead = Readonly<{
  sequence: number;
  sha256: string;
}>;

export type PersistedConversationEventInput = Readonly<{
  idempotencyKey: string;
  draft: ConversationEventDraft;
}>;

export class ConversationHeadConflictError extends Error {
  readonly code = "conversation_head_conflict" as const;

  constructor() {
    super("the durable conversation head advanced before this append");
    this.name = "ConversationHeadConflictError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertScopeId(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`${label} must be a UUID`);
}

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is not a safe non-negative integer`);
  return parsed;
}

function projectEventRow(
  row: ConversationEventRow,
  expectedScope: Readonly<{ conversationId: string; organizationId: string }>
): ConversationEvent {
  if (row.conversation_id !== expectedScope.conversationId || row.org_id !== expectedScope.organizationId) {
    throw new Error("durable conversation event escaped its requested organization scope");
  }
  const sequence = safeInteger(row.sequence, "conversation event sequence");
  const occurredAtMs = safeInteger(row.occurred_at_ms, "conversation event timestamp");
  const unsigned = {
    version: CONVERSATION_KERNEL_VERSION,
    conversationId: row.conversation_id,
    sequence,
    previousHash: row.previous_event_sha256,
    eventId: row.event_id,
    occurredAtMs,
    payload: row.payload,
  } as const;
  const canonical = canonicalJson(unsigned);
  if (canonical !== row.unsigned_event_text || sha256(canonical) !== row.event_sha256) {
    throw new Error(`durable conversation event ${row.event_id} failed canonical digest verification`);
  }
  if (
    typeof row.payload !== "object"
    || row.payload === null
    || !("type" in row.payload)
    || row.event_type !== (row.payload as { type?: unknown }).type
  ) {
    throw new Error(`durable conversation event ${row.event_id} has an invalid type projection`);
  }
  return ConversationEventSchema.parse({ ...unsigned, hash: row.event_sha256 });
}

function assertHead(head: ConversationHead): void {
  if (!Number.isSafeInteger(head.sequence) || head.sequence < 0 || !HASH.test(head.sha256)) {
    throw new Error("expected conversation head is invalid");
  }
  if (head.sequence === 0 && head.sha256 !== GENESIS_HASH) {
    throw new Error("an empty conversation must use the genesis hash");
  }
}

export async function loadConversationHead(input: Readonly<{
  conversationId: string;
  organizationId: string;
}>): Promise<ConversationHead> {
  assertScopeId(input.conversationId, "conversationId");
  assertScopeId(input.organizationId, "organizationId");
  const row = await qOne<{ head_sequence: string | number; head_sha256: string }>(
    "SELECT * FROM read_voice_conversation_head($1,$2)",
    [input.conversationId, input.organizationId]
  );
  if (!row) throw new Error("durable voice conversation was not found in the requested organization");
  const head = Object.freeze({
    sequence: safeInteger(row.head_sequence, "conversation head sequence"),
    sha256: row.head_sha256,
  });
  assertHead(head);
  return head;
}

/**
 * Compare-and-appends one atomic event batch. The sequence is part of each
 * event hash, so callers retain both fields of the head they projected from.
 * A database-serialized exact retry returns the original rows; a changed retry
 * or a competing append fails closed.
 */
export async function appendPersistedConversationEvents(input: Readonly<{
  conversationId: string;
  organizationId: string;
  expectedHead: ConversationHead;
  events: readonly PersistedConversationEventInput[];
}>): Promise<readonly ConversationEvent[]> {
  assertScopeId(input.conversationId, "conversationId");
  assertScopeId(input.organizationId, "organizationId");
  assertHead(input.expectedHead);
  if (input.events.length < 1 || input.events.length > MAX_BATCH_EVENTS) {
    throw new Error(`conversation append batch must contain 1 to ${MAX_BATCH_EVENTS} events`);
  }
  const idempotencyKeys = new Set<string>();
  const eventIds = new Set<string>();
  let rollingHash = input.expectedHead.sha256;
  const expectedEvents: ConversationEvent[] = [];
  const batch = input.events.map((candidate, index) => {
    if (
      !candidate.idempotencyKey
      || Buffer.byteLength(candidate.idempotencyKey, "utf8") > 256
      || idempotencyKeys.has(candidate.idempotencyKey)
    ) throw new Error("conversation event idempotency keys must be unique and contain 1 to 256 UTF-8 bytes");
    idempotencyKeys.add(candidate.idempotencyKey);
    const draft = ConversationEventDraftSchema.parse(candidate.draft);
    if (eventIds.has(draft.eventId)) throw new Error("conversation event ids must be unique within an append batch");
    eventIds.add(draft.eventId);
    const unsigned = {
      version: CONVERSATION_KERNEL_VERSION,
      conversationId: input.conversationId,
      sequence: input.expectedHead.sequence + index + 1,
      previousHash: rollingHash,
      ...draft,
    } as const;
    const unsignedEvent = canonicalJson(unsigned);
    const eventHash = sha256(unsignedEvent);
    const event = ConversationEventSchema.parse({ ...unsigned, hash: eventHash });
    if (Buffer.byteLength(canonicalJson(event), "utf8") > MAX_EVENT_BYTES) {
      throw new Error(`conversation event ${event.eventId} exceeds ${MAX_EVENT_BYTES} bytes`);
    }
    rollingHash = eventHash;
    expectedEvents.push(event);
    return { idempotencyKey: candidate.idempotencyKey, unsignedEvent, eventHash };
  });
  const batchText = canonicalJson(batch);
  if (Buffer.byteLength(batchText, "utf8") > MAX_BATCH_BYTES) {
    throw new Error(`conversation append batch exceeds ${MAX_BATCH_BYTES} bytes`);
  }

  let rows: ConversationEventRow[];
  try {
    rows = await q<ConversationEventRow>(
      "SELECT * FROM append_voice_conversation_events($1,$2,$3,$4,$5)",
      [
        input.conversationId,
        input.organizationId,
        input.expectedHead.sha256,
        batchText,
        sha256(batchText),
      ]
    );
  } catch (error) {
    const databaseError = error as { code?: string; message?: string };
    if (databaseError.code === "40001" || databaseError.message === "voice_conversation_event_head_conflict") {
      throw new ConversationHeadConflictError();
    }
    throw error;
  }
  if (rows.length !== expectedEvents.length) throw new Error("conversation append returned an incomplete durable batch");
  const persisted = rows.map((row) => projectEventRow(row, input));
  if (canonicalJson(persisted) !== canonicalJson(expectedEvents)) {
    throw new Error("conversation append returned events different from the requested batch");
  }
  return Object.freeze(persisted);
}

/** Loads a stable prefix captured by one durable head read, then verifies it. */
export async function loadPersistedConversationLog(input: Readonly<{
  conversationId: string;
  organizationId: string;
}>): Promise<ConversationLog> {
  const head = await loadConversationHead(input);
  const events: ConversationEvent[] = [];
  while (events.length < head.sequence) {
    const rows = await q<ConversationEventRow>(
      "SELECT * FROM load_voice_conversation_events($1,$2,$3,$4,$5)",
      [input.conversationId, input.organizationId, events.length, head.sequence, LOAD_PAGE_SIZE]
    );
    if (rows.length === 0) throw new Error("durable conversation event log ended before its captured head");
    events.push(...rows.map((row) => projectEventRow(row, input)));
    if (rows.length > LOAD_PAGE_SIZE || events.length > head.sequence) {
      throw new Error("durable conversation event read exceeded its captured head");
    }
  }
  const log: ConversationLog = Object.freeze({
    version: CONVERSATION_KERNEL_VERSION,
    conversationId: input.conversationId,
    events: Object.freeze(events),
  });
  validateConversationLog(log);
  if ((events.at(-1)?.hash ?? GENESIS_HASH) !== head.sha256) {
    throw new Error("durable conversation event prefix does not match its captured head hash");
  }
  return log;
}

export async function loadPersistedConversationState(input: Readonly<{
  conversationId: string;
  organizationId: string;
}>): Promise<ConversationState> {
  return foldConversation(await loadPersistedConversationLog(input));
}
