import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { GENESIS_HASH, canonicalJson, type ConversationEventDraft } from "../conversation-kernel";

const integrationDatabaseUrl = process.env.CONVERSATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(integrationDatabaseUrl));

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

integration("033 conversation event database serialization", () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 32 });
  const ids = { org: randomUUID(), agent: randomUUID(), conversation: randomUUID() };

  function sqlBatch(
    head: Readonly<{ sequence: number; sha256: string }>,
    key: string,
    eventId: string,
    factKey: string,
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
      [ids.agent],
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
        [ids.conversation, ids.org, GENESIS_HASH, batch.batchText, batch.batchSha256],
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
      [ids.conversation, ids.org, GENESIS_HASH, winner.batchText, winner.batchSha256],
    );
    expect(replay.rows).toHaveLength(1);
    expect(replay.rows[0].event_sha256).toBe(winner.eventHash);
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM voice_conversation_events WHERE conversation_id=$1",
      [ids.conversation],
    );
    expect(count.rows[0].count).toBe("1");
  }, 20_000);

  it("rolls a malformed batch back atomically and denies cross-org reads", async () => {
    const headResult = await pool.query<{ head_sequence: string; head_sha256: string }>(
      "SELECT * FROM read_voice_conversation_head($1,$2)",
      [ids.conversation, ids.org],
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
      [ids.conversation, ids.org, head.sha256, malformedText, digest(malformedText)],
    )).rejects.toMatchObject({ message: "voice_conversation_event_chain_invalid" });
    const after = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM voice_conversation_events WHERE conversation_id=$1",
      [ids.conversation],
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
