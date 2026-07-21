import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

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

const integrationDatabaseUrl = process.env.CONVERSATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(integrationDatabaseUrl));

integration("033 conversation event database serialization", () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 32 });
  const ids = { org: randomUUID(), agent: randomUUID(), conversation: randomUUID() };

  function sqlBatch(
    head: Readonly<{ sequence: number; sha256: string }>,
    key: string,
    eventId: string,
    factKey: string
  ) {
    const unsignedEvent = canonicalJson({
      version: 1,
      conversationId: ids.conversation,
      sequence: head.sequence + 1,
      previousHash: head.sha256,
      ...draft(eventId, factKey),
    });
    const batchText = canonicalJson([{ idempotencyKey: key, unsignedEvent, eventHash: digest(unsignedEvent) }]);
    return { batchText, batchSha256: digest(batchText), eventHash: digest(unsignedEvent) };
  }

  beforeAll(async () => {
    await pool.query("INSERT INTO orgs(id,name) VALUES ($1,'Conversation log integration')", [ids.org]);
    await pool.query("INSERT INTO agents(id,org_id,name,active_version) VALUES ($1,$2,'Log agent',1)", [ids.agent, ids.org]);
    await pool.query(
      "INSERT INTO agent_versions(agent_id,version,instructions,created_by) VALUES ($1,1,'test','integration-test')",
      [ids.agent]
    );
    await pool.query("SELECT * FROM ensure_voice_conversation($1,$2,$3,1,NULL)", [
      ids.conversation,
      ids.org,
      ids.agent,
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("admits exactly one of 32 writers racing the same head, then replays it exactly", async () => {
    const attempts = Array.from({ length: 32 }, (_, index) => {
      const batch = sqlBatch({ sequence: 0, sha256: GENESIS_HASH }, `race:${index}`, `race-${index}`, `race.fact.${index}`);
      return { batch, promise: pool.query(
        "SELECT * FROM append_voice_conversation_events($1,$2,$3,$4,$5)",
        [ids.conversation, ids.org, GENESIS_HASH, batch.batchText, batch.batchSha256]
      ) };
    });
    const results = await Promise.allSettled(attempts.map(({ promise }) => promise));
    const winners = results.flatMap((result, index) => result.status === "fulfilled" ? [index] : []);
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "40001"))
      .toHaveLength(31);

    const winner = attempts[winners[0]].batch;
    const replay = await pool.query(
      "SELECT * FROM append_voice_conversation_events($1,$2,$3,$4,$5)",
      [ids.conversation, ids.org, GENESIS_HASH, winner.batchText, winner.batchSha256]
    );
    expect(replay.rows).toHaveLength(1);
    expect(replay.rows[0].event_sha256).toBe(winner.eventHash);
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM voice_conversation_events WHERE conversation_id=$1",
      [ids.conversation]
    );
    expect(count.rows[0].count).toBe("1");
  }, 20_000);

  it("rolls a malformed batch back atomically and denies cross-org reads", async () => {
    const headResult = await pool.query<{ head_sequence: string; head_sha256: string }>(
      "SELECT * FROM read_voice_conversation_head($1,$2)",
      [ids.conversation, ids.org]
    );
    const head = { sequence: Number(headResult.rows[0].head_sequence), sha256: headResult.rows[0].head_sha256 };
    const first = sqlBatch(head, "atomic:first", "atomic-first", "atomic.first");
    const firstItem = (JSON.parse(first.batchText) as BatchItem[])[0];
    const secondUnsigned = canonicalJson({
      version: 1,
      conversationId: ids.conversation,
      sequence: head.sequence + 2,
      previousHash: "f".repeat(64),
      ...draft("atomic-second", "atomic.second"),
    });
    const malformedText = canonicalJson([
      firstItem,
      { idempotencyKey: "atomic:second", unsignedEvent: secondUnsigned, eventHash: digest(secondUnsigned) },
    ]);
    await expect(pool.query(
      "SELECT * FROM append_voice_conversation_events($1,$2,$3,$4,$5)",
      [ids.conversation, ids.org, head.sha256, malformedText, digest(malformedText)]
    )).rejects.toMatchObject({ message: "voice_conversation_event_chain_invalid" });
    const after = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM voice_conversation_events WHERE conversation_id=$1",
      [ids.conversation]
    );
    expect(after.rows[0].count).toBe(String(head.sequence));
    const wrongOrg = await pool.query("SELECT * FROM load_voice_conversation_events($1,$2,0,$3,1024)", [
      ids.conversation,
      randomUUID(),
      head.sequence,
    ]);
    expect(wrongOrg.rows).toEqual([]);
  });
});
