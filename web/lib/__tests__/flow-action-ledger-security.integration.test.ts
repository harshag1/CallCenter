import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

integration("flow action ledger database authority", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl, ssl: false });
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });

  async function rejected(sql: string, params: readonly unknown[], message: RegExp) {
    await client.query("SAVEPOINT rejected_ledger_mutation");
    await expect(client.query(sql, [...params])).rejects.toThrow(message);
    await client.query("ROLLBACK TO SAVEPOINT rejected_ledger_mutation");
    await client.query("RELEASE SAVEPOINT rejected_ledger_mutation");
  }

  it("fences proof insertion, exact promotion, terminal mutation, and parent erasure", async () => {
    const ids = {
      org: randomUUID(),
      agent: randomUUID(),
      call: randomUUID(),
      receiptA: randomUUID(),
      receiptB: randomUUID(),
      proof: randomUUID(),
      forgedProof: randomUUID(),
      expiredProof: randomUUID(),
    };
    const runtimeDigest = "1".repeat(64);
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO orgs (id,name) VALUES ($1,'Ledger security')", [ids.org]);
      await client.query(
        "INSERT INTO agents (id,org_id,name,active_version) VALUES ($1,$2,'Ledger agent',1)",
        [ids.agent, ids.org]
      );
      await client.query(
        `INSERT INTO calls (id,agent_id,agent_version,direction,runtime_digest)
         VALUES ($1,$2,1,'web',$3)`,
        [ids.call, ids.agent, runtimeDigest]
      );

      for (const [index, receiptId] of [ids.receiptA, ids.receiptB].entries()) {
        await client.query(
          `INSERT INTO flow_action_receipts
            (id,call_id,runtime_digest,capability_epoch,step_path,step_attempt,tool,
             invocation_id,arguments,arguments_hash,idempotency_key,status,owner_token,
             dispatch_lease_expires_at,owner_heartbeat_at)
           VALUES ($1,$2,$3,1,'booking.commit',1,'reserve_slot',$4,'{}',$5,$6,
                   'reserved',$7,now() + interval '60 seconds',now())`,
          [
            receiptId,
            ids.call,
            runtimeDigest,
            `${index === 0 ? "A" : "B"}`.repeat(24),
            `${index + 2}`.repeat(64),
            `${index + 4}`.repeat(64),
            randomUUID(),
          ]
        );
        await client.query(
          `UPDATE flow_action_receipts
           SET dispatch_started_at=now(), dispatch_attempt=1, delivery_state='unknown',
               owner_heartbeat_at=now(), dispatch_lease_expires_at=now() + interval '60 seconds'
           WHERE id=$1 AND call_id=$2`,
          [receiptId, ids.call]
        );
        await client.query(
          `UPDATE flow_action_receipts
           SET status='indeterminate', error='{"message":"lost"}'::jsonb,
               delivery_state='unknown', settled_at=now()
           WHERE id=$1 AND call_id=$2`,
          [receiptId, ids.call]
        );
      }

      await rejected(
        `INSERT INTO flow_action_reconciliation_proofs
          (id,call_id,action_receipt_id,runtime_digest,policy_hash,attempt,query_tool,
           query_arguments,query_arguments_hash,predicate,predicate_hash,
           authoritative_result_path,status,owner_token,lease_expires_at,
           proof_result,proof_result_hash,authoritative_result,authoritative_result_hash,completed_at)
         VALUES ($1,$2,$3,$4,$5,1,'lookup','{}',$6,'[]',$7,'result','committed',$8,
                 now() + interval '60 seconds','{}',$9,'{}',$10,now())`,
        [
          ids.forgedProof, ids.call, ids.receiptB, runtimeDigest, "7".repeat(64),
          "8".repeat(64), "9".repeat(64), randomUUID(), "a".repeat(64), "b".repeat(64),
        ],
        /must begin in querying state/
      );

      await rejected(
        `INSERT INTO flow_action_reconciliation_proofs
          (id,call_id,action_receipt_id,runtime_digest,policy_hash,attempt,query_tool,
           query_arguments,query_arguments_hash,predicate,predicate_hash,
           authoritative_result_path,status,owner_token,lease_expires_at)
         VALUES ($1,$2,$3,$4,$5,1,'lookup','{}',$6,'[]',$7,'result','querying',$8,
                 clock_timestamp() - interval '1 second')`,
        [
          ids.expiredProof, ids.call, ids.receiptB, runtimeDigest, "7".repeat(64),
          "8".repeat(64), "9".repeat(64), randomUUID(),
        ],
        /lease must be live at admission/
      );

      const expiredOwner = randomUUID();
      await client.query(
        `INSERT INTO flow_action_reconciliation_proofs
          (id,call_id,action_receipt_id,runtime_digest,policy_hash,attempt,query_tool,
           query_arguments,query_arguments_hash,predicate,predicate_hash,
           authoritative_result_path,status,owner_token,lease_expires_at)
         VALUES ($1,$2,$3,$4,$5,1,'lookup','{}',$6,'[]',$7,'result','querying',$8,
                 clock_timestamp() + interval '20 milliseconds')`,
        [
          ids.expiredProof, ids.call, ids.receiptB, runtimeDigest, "7".repeat(64),
          "8".repeat(64), "9".repeat(64), expiredOwner,
        ]
      );
      await client.query("SELECT pg_sleep(0.04)");
      await rejected(
        `UPDATE flow_action_reconciliation_proofs
         SET status='mismatch', proof_result='{"terminal":"absent"}'::jsonb,
             proof_result_hash=$2, completed_at=clock_timestamp()
         WHERE id=$1`,
        [ids.expiredProof, "a".repeat(64)],
        /expired flow reconciliation proof cannot become authoritative/
      );
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status='error', error='{"code":"lease_expired"}'::jsonb,
             completed_at=clock_timestamp()
         WHERE id=$1`,
        [ids.expiredProof]
      );

      const proofOwner = randomUUID();
      await client.query(
        `INSERT INTO flow_action_reconciliation_proofs
          (id,call_id,action_receipt_id,runtime_digest,policy_hash,attempt,query_tool,
           query_arguments,query_arguments_hash,predicate,predicate_hash,
           authoritative_result_path,status,owner_token,lease_expires_at)
         VALUES ($1,$2,$3,$4,$5,1,'lookup','{}',$6,'[]',$7,'result','querying',$8,
                 now() + interval '60 seconds')`,
        [
          ids.proof, ids.call, ids.receiptA, runtimeDigest, "7".repeat(64),
          "8".repeat(64), "9".repeat(64), proofOwner,
        ]
      );
      await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status='committed', proof_result='{"terminal":"committed"}'::jsonb,
             proof_result_hash=$2, authoritative_result='{"ok":true}'::jsonb,
             authoritative_result_hash=$3, completed_at=now()
         WHERE id=$1`,
        [ids.proof, "a".repeat(64), "b".repeat(64)]
      );

      await rejected(
        `UPDATE flow_action_receipts
         SET status='succeeded', result='{"ok":true}'::jsonb, result_hash=$2,
             reconciliation_proof_id=$3, delivery_state='committed', error=NULL, settled_at=now()
         WHERE id=$1`,
        [ids.receiptB, "b".repeat(64), ids.proof],
        /not backed by its exact committed proof/
      );
      await client.query(
        `UPDATE flow_action_receipts
         SET status='succeeded', result='{"ok":true}'::jsonb, result_hash=$2,
             reconciliation_proof_id=$3, delivery_state='committed', error=NULL, settled_at=now()
         WHERE id=$1`,
        [ids.receiptA, "b".repeat(64), ids.proof]
      );
      await rejected(
        "UPDATE flow_action_receipts SET delivery_state='not_sent' WHERE id=$1",
        [ids.receiptA],
        /terminal flow action receipt is immutable/
      );
      await rejected(
        "UPDATE flow_action_receipts SET arguments_hash='not-a-hash' WHERE id=$1",
        [ids.receiptB],
        /authority is immutable/
      );
      await rejected(
        "DELETE FROM flow_action_receipts WHERE id=$1",
        [ids.receiptB],
        /cannot be deleted while their call exists/
      );
      await rejected(
        "DELETE FROM flow_action_reconciliation_proofs WHERE id=$1",
        [ids.proof],
        /immutable/
      );

      await client.query("DELETE FROM calls WHERE id=$1", [ids.call]);
      expect((await client.query(
        "SELECT count(*)::int AS count FROM flow_action_receipts WHERE call_id=$1",
        [ids.call]
      )).rows[0].count).toBe(0);
      expect((await client.query(
        "SELECT count(*)::int AS count FROM flow_action_reconciliation_proofs WHERE call_id=$1",
        [ids.call]
      )).rows[0].count).toBe(0);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
