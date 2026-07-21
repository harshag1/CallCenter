import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ q: vi.fn(), qOne: vi.fn() }));
vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));

import {
  ConversationHeadConflictError,
  appendPersistedConversationEvents,
  loadPersistedConversationLog,
} from "../conversation-store";
import { GENESIS_HASH, canonicalJson, type ConversationEventDraft } from "../conversation-kernel";

const conversationId = "8916eb0a-5332-4f4c-a330-746c516e83b9";
const organizationId = "8916eb0a-5332-4f4c-a330-746c516e83ba";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function draft(eventId: string, key: string): ConversationEventDraft {
  return {
    eventId,
    occurredAtMs: 1_800_000_000_000,
    payload: {
      type: "fact.asserted",
      key,
      value: `value:${key}`,
      revision: 1,
      authority: {
        kind: "system_of_record",
        issuer: "membership-db",
        evidenceId: `evidence:${key}`,
        issuedAtMs: 1_800_000_000_000,
      },
    },
  };
}

type BatchItem = Readonly<{ idempotencyKey: string; unsignedEvent: string; eventHash: string }>;

function rowsFromBatch(params: unknown[]): unknown[] {
  const batch = JSON.parse(String(params[3])) as BatchItem[];
  return batch.map((item) => {
    const event = JSON.parse(item.unsignedEvent) as {
      conversationId: string;
      sequence: number;
      previousHash: string;
      eventId: string;
      occurredAtMs: number;
      payload: { type: string };
    };
    return {
      conversation_id: event.conversationId,
      org_id: params[1],
      sequence: String(event.sequence),
      event_id: event.eventId,
      idempotency_key: item.idempotencyKey,
      occurred_at_ms: String(event.occurredAtMs),
      event_type: event.payload.type,
      payload: event.payload,
      previous_event_sha256: event.previousHash,
      event_sha256: item.eventHash,
      unsigned_event_text: item.unsignedEvent,
    };
  });
}

describe("durable conversation store", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds and verifies an atomic, contiguous compare-and-append batch", async () => {
    mocks.q.mockImplementationOnce((_sql: string, params: unknown[]) => Promise.resolve(rowsFromBatch(params)));
    const persisted = await appendPersistedConversationEvents({
      conversationId,
      organizationId,
      expectedHead: { sequence: 0, sha256: GENESIS_HASH },
      events: [
        { idempotencyKey: "membership-number:v1", draft: draft("event-1", "membership.number") },
        { idempotencyKey: "membership-tier:v1", draft: draft("event-2", "membership.tier") },
      ],
    });

    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ sequence: 1, previousHash: GENESIS_HASH });
    expect(persisted[1]).toMatchObject({ sequence: 2, previousHash: persisted[0].hash });
    const [sql, params] = mocks.q.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("append_voice_conversation_events");
    expect(params.slice(0, 3)).toEqual([conversationId, organizationId, GENESIS_HASH]);
    expect(params[4]).toBe(digest(String(params[3])));
  });

  it("rejects duplicate operation and event identities before touching storage", async () => {
    await expect(appendPersistedConversationEvents({
      conversationId,
      organizationId,
      expectedHead: { sequence: 0, sha256: GENESIS_HASH },
      events: [
        { idempotencyKey: "same", draft: draft("event-1", "one") },
        { idempotencyKey: "same", draft: draft("event-2", "two") },
      ],
    })).rejects.toThrow(/idempotency keys must be unique/);
    await expect(appendPersistedConversationEvents({
      conversationId,
      organizationId,
      expectedHead: { sequence: 0, sha256: GENESIS_HASH },
      events: [
        { idempotencyKey: "one", draft: draft("same-event", "one") },
        { idempotencyKey: "two", draft: draft("same-event", "two") },
      ],
    })).rejects.toThrow(/event ids must be unique/);
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("projects a serialized database head race to one stable error", async () => {
    mocks.q.mockRejectedValueOnce({ code: "40001", message: "voice_conversation_event_head_conflict" });
    await expect(appendPersistedConversationEvents({
      conversationId,
      organizationId,
      expectedHead: { sequence: 0, sha256: GENESIS_HASH },
      events: [{ idempotencyKey: "one", draft: draft("event-1", "one") }],
    })).rejects.toBeInstanceOf(ConversationHeadConflictError);
  });

  it("loads a head-bounded prefix and rejects tampered canonical bytes", async () => {
    mocks.q.mockImplementationOnce((_sql: string, params: unknown[]) => Promise.resolve(rowsFromBatch(params)));
    const appended = await appendPersistedConversationEvents({
      conversationId,
      organizationId,
      expectedHead: { sequence: 0, sha256: GENESIS_HASH },
      events: [{ idempotencyKey: "one", draft: draft("event-1", "one") }],
    });
    const [row] = rowsFromBatch([
      conversationId,
      organizationId,
      GENESIS_HASH,
      canonicalJson([{
        idempotencyKey: "one",
        unsignedEvent: canonicalJson({
          version: 1,
          conversationId,
          sequence: 1,
          previousHash: GENESIS_HASH,
          ...draft("event-1", "one"),
        }),
        eventHash: appended[0].hash,
      }]),
    ]);
    mocks.qOne.mockResolvedValue({ head_sequence: "1", head_sha256: appended[0].hash });
    mocks.q.mockResolvedValueOnce([row]);
    await expect(loadPersistedConversationLog({ conversationId, organizationId })).resolves.toMatchObject({
      conversationId,
      events: [{ eventId: "event-1", hash: appended[0].hash }],
    });

    mocks.qOne.mockResolvedValueOnce({ head_sequence: "1", head_sha256: appended[0].hash });
    mocks.q.mockResolvedValueOnce([{ ...(row as object), unsigned_event_text: `${(row as { unsigned_event_text: string }).unsigned_event_text} ` }]);
    await expect(loadPersistedConversationLog({ conversationId, organizationId })).rejects.toThrow(
      /failed canonical digest verification/
    );
  });

  it("fails closed if a security-definer read returns another organization", async () => {
    mocks.qOne.mockResolvedValueOnce({ head_sequence: "1", head_sha256: "a".repeat(64) });
    mocks.q.mockResolvedValueOnce([{
      ...rowsFromBatch([
        conversationId,
        "8916eb0a-5332-4f4c-a330-746c516e83bb",
        GENESIS_HASH,
        canonicalJson([{
          idempotencyKey: "one",
          unsignedEvent: canonicalJson({
            version: 1,
            conversationId,
            sequence: 1,
            previousHash: GENESIS_HASH,
            ...draft("event-1", "one"),
          }),
          eventHash: "a".repeat(64),
        }]),
      ])[0] as object,
    }]);
    await expect(loadPersistedConversationLog({ conversationId, organizationId })).rejects.toThrow(/organization scope/);
  });
});

describe("033 durable conversation event migration contract", () => {
  const sql = readFileSync(resolve(process.cwd(), "migrations/033_voice_conversation_event_log.sql"), "utf8");

  it("serializes one hash-chain head and atomic batches per conversation", () => {
    expect(sql).toContain("event_head_sequence");
    expect(sql).toContain("event_head_sha256");
    expect(sql).toMatch(/WHERE id = conversation_identity AND org_id = organization_identity\s+FOR UPDATE/);
    expect(sql).toMatch(/conversation\.event_head_sha256 <> expected_head_sha256/);
    expect(sql).toMatch(/SET event_head_sequence = next_sequence \+ batch_count/);
  });

  it("accepts exact full replays and rejects conflicting or mixed replays", () => {
    expect(sql).toContain("voice_conversation_event_idempotency_conflict");
    expect(sql).toContain("voice_conversation_event_identity_conflict");
    expect(sql).toContain("voice_conversation_event_mixed_replay");
    expect(sql).toMatch(/IF existing_count <> batch_count THEN/);
    expect(sql).toMatch(/UNIQUE \(conversation_id, idempotency_key\)/);
  });

  it("bounds and independently digests canonical event and batch bytes", () => {
    expect(sql).toMatch(/octet_length\(unsigned_event_text\) <= 32768/);
    expect(sql).toMatch(/octet_length\(batch_text\) > 2097152/);
    expect(sql).toMatch(/batch_sha256 <> encode\(digest\(batch_text, 'sha256'\), 'hex'\)/);
    expect(sql).toMatch(/item->>'eventHash' <> encode\(digest\(item->>'unsignedEvent', 'sha256'\), 'hex'\)/);
  });

  it("is append-only, default-deny, org-scoped, and grants only transition functions", () => {
    expect(sql).toContain("voice_conversation_events_are_append_only");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toMatch(/REVOKE ALL ON public\.voice_conversation_events FROM %I/);
    expect(sql).toMatch(/organization_identity/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.append_voice_conversation_events[\s\S]*TO hacc_backend/);
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE).*voice_conversation_events TO hacc_backend/);
  });

  it("binds new workers to the locked event head without breaking exact replay", () => {
    expect(sql).toContain("enforce_voice_worker_conversation_head");
    expect(sql).toMatch(/existing\.idempotency_key = NEW\.idempotency_key[\s\S]*RETURN NEW/);
    expect(sql).toMatch(/conversationHeadSha256[\s\S]*conversation\.event_head_sha256/);
    expect(sql).toMatch(/conversationRevision[\s\S]*conversation\.event_head_sequence/);
    expect(sql).toContain("voice_worker_spawn_stale_conversation_head");
  });
});
