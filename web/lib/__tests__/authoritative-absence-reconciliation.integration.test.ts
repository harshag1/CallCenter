import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminDatabaseUrl = process.env.SECURITY_MIGRATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(adminDatabaseUrl));
const RUNTIME_DIGEST = "1".repeat(64);
const POLICY_HASH = "2".repeat(64);
const QUERY_ARGUMENTS_HASH = "3".repeat(64);
const PREDICATE_HASH = "4".repeat(64);
const PROOF_RESULT_HASH = "5".repeat(64);

function databaseUrl(base: string, database: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

integration("authoritative absence and migration reapply", () => {
  const database = `hacc_absence_${randomUUID().replaceAll("-", "")}`;
  const ids = {
    org: randomUUID(),
    agent: randomUUID(),
    call: randomUUID(),
  };
  let admin: Pool;
  let target: Pool;
  let migration012: string;
  let migration026: string;

  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("missing integration database URL");
    admin = new Pool({ connectionString: adminDatabaseUrl, ssl: false, max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
    target = new Pool({
      connectionString: databaseUrl(adminDatabaseUrl, database),
      ssl: false,
      max: 2,
    });
    const migrationsUrl = new URL("../../migrations/", import.meta.url);
    const names = (await readdir(migrationsUrl))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort();
    expect(names).toContain("012_action_dispatch_reconciliation.sql");
    expect(names).toContain("026_authoritative_absence_reconciliation.sql");
    for (const name of names) {
      const sql = await readFile(new URL(name, migrationsUrl), "utf8");
      await target.query(sql);
      if (name === "012_action_dispatch_reconciliation.sql") migration012 = sql;
      if (name === "026_authoritative_absence_reconciliation.sql") migration026 = sql;
    }
    await target.query("INSERT INTO orgs (id,name) VALUES ($1,'Absence proof')", [ids.org]);
    await target.query(
      "INSERT INTO agents (id,org_id,name,active_version) VALUES ($1,$2,'Absence agent',1)",
      [ids.agent, ids.org]
    );
    await target.query(
      `INSERT INTO calls (id,agent_id,agent_version,direction,runtime_digest)
       VALUES ($1,$2,1,'web',$3)`,
      [ids.call, ids.agent, RUNTIME_DIGEST]
    );
  }, 120_000);

  afterAll(async () => {
    await target?.end().catch(() => undefined);
    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      } finally {
        await admin.end().catch(() => undefined);
      }
    }
  });

  async function createIndeterminateReceipt(
    client: Pool | PoolClient,
    options: { id?: string; invocation?: string; idempotency?: string } = {}
  ) {
    const id = options.id ?? randomUUID();
    const invocation = options.invocation ?? `I${randomUUID().replaceAll("-", "").slice(0, 23)}`;
    const idempotency = options.idempotency ?? randomUUID().replaceAll("-", "").repeat(2);
    await client.query(
      `INSERT INTO flow_action_receipts
        (id,call_id,runtime_digest,capability_epoch,step_path,step_attempt,tool,
         invocation_id,arguments,arguments_hash,idempotency_key,status,owner_token,
         dispatch_lease_expires_at,owner_heartbeat_at)
       VALUES ($1,$2,$3,1,'booking.commit',1,'reserve_slot',$4,
               '{"reservation_ref":"R-100"}'::jsonb,$5,$6,'reserved',$7,
               now() + interval '60 seconds',now())`,
      [id, ids.call, RUNTIME_DIGEST, invocation, "6".repeat(64), idempotency, randomUUID()]
    );
    await client.query(
      `UPDATE flow_action_receipts
       SET dispatch_started_at=clock_timestamp(), dispatch_attempt=1,
           delivery_state='unknown', owner_heartbeat_at=clock_timestamp(),
           dispatch_lease_expires_at=clock_timestamp() + interval '60 seconds'
       WHERE id=$1 AND call_id=$2`,
      [id, ids.call]
    );
    await client.query(
      `UPDATE flow_action_receipts
       SET status='indeterminate', error='{"code":"response_lost"}'::jsonb,
           delivery_state='unknown', settled_at=clock_timestamp()
       WHERE id=$1 AND call_id=$2`,
      [id, ids.call]
    );
    return { id, invocation, idempotency };
  }

  async function createQueryingProof(
    client: Pool | PoolClient,
    receiptId: string,
    attempt = 1,
    lease = "60 seconds"
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO flow_action_reconciliation_proofs
        (id,call_id,action_receipt_id,runtime_digest,policy_hash,attempt,query_tool,
         query_arguments,query_arguments_hash,predicate,predicate_hash,
         authoritative_result_path,status,owner_token,lease_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'lookup_reservation',
               '{"invocation_id":"server-derived"}'::jsonb,$7,
               '{"committedWhen":["invocation","committed"],"absentWhen":["invocation","absent"]}'::jsonb,
               $8,'result','querying',$9,clock_timestamp() + $10::interval)`,
      [
        id,
        ids.call,
        receiptId,
        RUNTIME_DIGEST,
        POLICY_HASH,
        attempt,
        QUERY_ARGUMENTS_HASH,
        PREDICATE_HASH,
        randomUUID(),
        lease,
      ]
    );
    return id;
  }

  async function proveAbsent(client: Pool | PoolClient, proofId: string, invocation: string) {
    await client.query(
      `UPDATE flow_action_reconciliation_proofs
       SET status='absent',
           proof_result=jsonb_build_object('invocation_id',$2::text,'terminal','absent'),
           proof_result_hash=$3, completed_at=clock_timestamp()
       WHERE id=$1`,
      [proofId, invocation, PROOF_RESULT_HASH]
    );
  }

  async function settleAbsent(client: Pool | PoolClient, receiptId: string, proofId: string) {
    await client.query(
      `UPDATE flow_action_receipts
       SET status='failed', result=NULL, result_hash=NULL,
           reconciliation_proof_id=$2, delivery_state='rejected',
           error='{"code":"authoritative_absence_proven"}'::jsonb,
           settled_at=clock_timestamp()
       WHERE id=$1 AND call_id=$3`,
      [receiptId, proofId, ids.call]
    );
  }

  async function rejected(
    client: PoolClient,
    sql: string,
    params: readonly unknown[],
    message: RegExp
  ) {
    const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    await expect(client.query(sql, [...params])).rejects.toThrow(message);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }

  it("preserves exact absence evidence across 012→026 reapply and keeps retry semantics live", async () => {
    const client = await target.connect();
    await client.query("BEGIN");
    try {
      const first = await createIndeterminateReceipt(client, {
        idempotency: "7".repeat(64),
      });
      const firstProof = await createQueryingProof(client, first.id);
      await proveAbsent(client, firstProof, first.invocation);

      await rejected(
        client,
        `UPDATE flow_action_receipts
         SET status='failed', reconciliation_proof_id=$2, delivery_state='rejected',
             error='{"code":"generic_failure"}'::jsonb, settled_at=clock_timestamp()
         WHERE id=$1`,
        [first.id, firstProof],
        /invalid authoritative-absence transition/
      );
      await settleAbsent(client, first.id, firstProof);

      // A terminal absence is not a success dedupe latch. A new invocation may reserve the same
      // semantic/idempotency key, while the uncertain invocation itself remains immutable.
      const retryId = randomUUID();
      await expect(client.query(
        `INSERT INTO flow_action_receipts
          (id,call_id,runtime_digest,capability_epoch,step_path,step_attempt,tool,
           invocation_id,arguments,arguments_hash,idempotency_key,status,owner_token,
           dispatch_lease_expires_at,owner_heartbeat_at)
         VALUES ($1,$2,$3,1,'booking.commit',1,'reserve_slot',$4,
                 '{"reservation_ref":"R-100"}'::jsonb,$5,$6,'reserved',$7,
                 now() + interval '60 seconds',now())`,
        [
          retryId,
          ids.call,
          RUNTIME_DIGEST,
          `R${randomUUID().replaceAll("-", "").slice(0, 23)}`,
          "6".repeat(64),
          first.idempotency,
          randomUUID(),
        ]
      )).resolves.toMatchObject({ rowCount: 1 });

      const before = (await client.query(
        `SELECT
           jsonb_build_object(
             'id',p.id,'call_id',p.call_id,'receipt_id',p.action_receipt_id,
             'runtime_digest',p.runtime_digest,'policy_hash',p.policy_hash,
             'predicate',p.predicate,'predicate_hash',p.predicate_hash,
             'status',p.status,'proof_result',p.proof_result,
             'proof_result_hash',p.proof_result_hash,
             'authoritative_result',p.authoritative_result,
             'authoritative_result_hash',p.authoritative_result_hash,
             'completed_at',p.completed_at
           ) AS proof,
           jsonb_build_object(
             'id',r.id,'status',r.status,'invocation_id',r.invocation_id,
             'arguments',r.arguments,'arguments_hash',r.arguments_hash,
             'idempotency_key',r.idempotency_key,'proof_id',r.reconciliation_proof_id,
             'delivery_state',r.delivery_state,'error',r.error,
             'result',r.result,'result_hash',r.result_hash,'settled_at',r.settled_at
           ) AS receipt
         FROM flow_action_reconciliation_proofs p
         JOIN flow_action_receipts r ON r.id=p.action_receipt_id
         WHERE p.id=$1`,
        [firstProof]
      )).rows[0];

      // Exact forward-compatibility gate: a later migration's terminal absence must survive a
      // manual/full-chain 012 reapply before 026 restores its own named constraints.
      await client.query(migration012);
      await client.query(migration026);

      const after = (await client.query(
        `SELECT
           jsonb_build_object(
             'id',p.id,'call_id',p.call_id,'receipt_id',p.action_receipt_id,
             'runtime_digest',p.runtime_digest,'policy_hash',p.policy_hash,
             'predicate',p.predicate,'predicate_hash',p.predicate_hash,
             'status',p.status,'proof_result',p.proof_result,
             'proof_result_hash',p.proof_result_hash,
             'authoritative_result',p.authoritative_result,
             'authoritative_result_hash',p.authoritative_result_hash,
             'completed_at',p.completed_at
           ) AS proof,
           jsonb_build_object(
             'id',r.id,'status',r.status,'invocation_id',r.invocation_id,
             'arguments',r.arguments,'arguments_hash',r.arguments_hash,
             'idempotency_key',r.idempotency_key,'proof_id',r.reconciliation_proof_id,
             'delivery_state',r.delivery_state,'error',r.error,
             'result',r.result,'result_hash',r.result_hash,'settled_at',r.settled_at
           ) AS receipt
         FROM flow_action_reconciliation_proofs p
         JOIN flow_action_receipts r ON r.id=p.action_receipt_id
         WHERE p.id=$1`,
        [firstProof]
      )).rows[0];
      expect(after).toEqual(before);

      const second = await createIndeterminateReceipt(client);
      const secondProof = await createQueryingProof(client, second.id);
      await proveAbsent(client, secondProof, second.invocation);
      await settleAbsent(client, second.id, secondProof);
      expect((await client.query(
        `SELECT r.status,r.delivery_state,r.error,p.status AS proof_status
         FROM flow_action_receipts r
         JOIN flow_action_reconciliation_proofs p ON p.id=r.reconciliation_proof_id
         WHERE r.id=$1`,
        [second.id]
      )).rows).toEqual([{
        status: "failed",
        delivery_state: "rejected",
        error: { code: "authoritative_absence_proven" },
        proof_status: "absent",
      }]);

      await rejected(
        client,
        "UPDATE flow_action_reconciliation_proofs SET predicate_hash=$2 WHERE id=$1",
        [secondProof, "f".repeat(64)],
        /immutable/
      );
      await rejected(
        client,
        "UPDATE flow_action_receipts SET delivery_state='unknown' WHERE id=$1",
        [second.id],
        /terminal flow action receipt is immutable/
      );

      const pending = await createIndeterminateReceipt(client);
      const mismatchProof = await createQueryingProof(client, pending.id);
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status='mismatch', proof_result='{"terminal":"pending"}'::jsonb,
             proof_result_hash=$2, completed_at=clock_timestamp()
         WHERE id=$1`,
        [mismatchProof, PROOF_RESULT_HASH]
      );
      await rejected(
        client,
        `UPDATE flow_action_receipts
         SET status='failed', reconciliation_proof_id=$2, delivery_state='rejected',
             error='{"code":"authoritative_absence_proven"}'::jsonb,
             settled_at=clock_timestamp()
         WHERE id=$1`,
        [pending.id, mismatchProof],
        /not backed by its exact authoritative-absence proof/
      );
      expect((await client.query(
        "SELECT status,reconciliation_proof_id FROM flow_action_receipts WHERE id=$1",
        [pending.id]
      )).rows).toEqual([{ status: "indeterminate", reconciliation_proof_id: null }]);

      const expiring = await createIndeterminateReceipt(client);
      const expiredProof = await createQueryingProof(client, expiring.id, 1, "20 milliseconds");
      await client.query("SELECT pg_sleep(0.04)");
      await rejected(
        client,
        `UPDATE flow_action_reconciliation_proofs
         SET status='absent', proof_result='{"terminal":"absent"}'::jsonb,
             proof_result_hash=$2, completed_at=clock_timestamp()
         WHERE id=$1`,
        [expiredProof, PROOF_RESULT_HASH],
        /expired flow reconciliation proof cannot become authoritative/
      );
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status='error', error='{"code":"lease_expired"}'::jsonb,
             completed_at=clock_timestamp()
         WHERE id=$1`,
        [expiredProof]
      );

      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }, 120_000);
});
