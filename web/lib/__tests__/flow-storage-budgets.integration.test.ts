import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));
const migrationSql = readFileSync(
  fileURLToPath(new URL("../../migrations/031_flow_action_storage_budgets.sql", import.meta.url)),
  "utf8"
);

integration("Flow v2 durable storage budgets", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl, ssl: false });
    await client.connect();
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  });

  async function createCall() {
    const ids = { org: randomUUID(), agent: randomUUID(), call: randomUUID() };
    await client.query("INSERT INTO orgs(id,name) VALUES ($1,'Flow budget test')", [ids.org]);
    await client.query(
      "INSERT INTO agents(id,org_id,name,active_version) VALUES ($1,$2,'Flow budget agent',1)",
      [ids.agent, ids.org]
    );
    await client.query(
      `INSERT INTO calls(id,agent_id,agent_version,direction,runtime_digest)
       VALUES ($1,$2,1,'web',$3)`,
      [ids.call, ids.agent, "1".repeat(64)]
    );
    return ids;
  }

  async function expectRejected(sql: string, params: readonly unknown[], message: RegExp) {
    await client.query("SAVEPOINT rejected_flow_budget");
    await expect(client.query(sql, [...params])).rejects.toThrow(message);
    await client.query("ROLLBACK TO SAVEPOINT rejected_flow_budget");
    await client.query("RELEASE SAVEPOINT rejected_flow_budget");
  }

  it("atomically caps a multi-row adversarial call at 512 receipts and reapplies from ledger truth", async () => {
    await client.query("BEGIN");
    try {
      const ids = await createCall();
      const values: string[] = [];
      const params: unknown[] = [];
      const owner = randomUUID();
      for (let index = 0; index < 512; index += 1) {
        const offset = params.length;
        values.push(
          `($${offset + 1},$${offset + 2},$${offset + 3},0,'always',0,'bounded_action',`
          + `$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},'reserved',$${offset + 8},`
          + `now() + interval '60 seconds',now())`
        );
        params.push(
          randomUUID(),
          ids.call,
          "1".repeat(64),
          index.toString(36).padStart(24, "A"),
          JSON.stringify({ index }),
          index.toString(16).padStart(64, "0"),
          (index + 1).toString(16).padStart(64, "0"),
          owner
        );
      }
      await client.query(
        `INSERT INTO flow_action_receipts
          (id,call_id,runtime_digest,capability_epoch,step_path,step_attempt,tool,
           invocation_id,arguments,arguments_hash,idempotency_key,status,owner_token,
           dispatch_lease_expires_at,owner_heartbeat_at)
         VALUES ${values.join(",")}`,
        params
      );
      const quota = (await client.query<{
        receipt_count: number;
        argument_bytes: string;
        result_bytes: string;
      }>(
        `SELECT receipt_count,argument_bytes::text,result_bytes::text
         FROM flow_action_storage_quotas WHERE call_id=$1`,
        [ids.call]
      )).rows[0];
      expect(quota.receipt_count).toBe(512);
      expect(Number(quota.argument_bytes)).toBeGreaterThan(0);
      expect(quota.result_bytes).toBe("0");

      await expectRejected(
        `INSERT INTO flow_action_receipts
          (id,call_id,runtime_digest,capability_epoch,step_path,step_attempt,tool,
           invocation_id,arguments,arguments_hash,idempotency_key,status,owner_token,
           dispatch_lease_expires_at,owner_heartbeat_at)
         VALUES ($1,$2,$3,0,'always',0,'bounded_action',$4,'{}',$5,$6,'reserved',$7,
                 now() + interval '60 seconds',now())`,
        [
          randomUUID(), ids.call, "1".repeat(64), "Z".repeat(24),
          "a".repeat(64), "b".repeat(64), owner,
        ],
        /flow_action_receipt_quota_exceeded/
      );

      await client.query(migrationSql);
      const reapplied = (await client.query<{ receipt_count: number }>(
        "SELECT receipt_count FROM flow_action_storage_quotas WHERE call_id=$1",
        [ids.call]
      )).rows[0];
      expect(reapplied.receipt_count).toBe(512);
    } finally {
      await client.query("ROLLBACK");
    }
  }, 30_000);

  it("rejects oversized arguments, results, and duplicated hot state without partial accounting", async () => {
    await client.query("BEGIN");
    try {
      const ids = await createCall();
      const receipt = randomUUID();
      const owner = randomUUID();
      await expectRejected(
        `INSERT INTO flow_action_receipts
          (id,call_id,runtime_digest,capability_epoch,step_path,step_attempt,tool,
           invocation_id,arguments,arguments_hash,idempotency_key,status,owner_token,
           dispatch_lease_expires_at,owner_heartbeat_at)
         VALUES ($1,$2,$3,0,'always',0,'bounded_action',$4,$5,$6,$7,'reserved',$8,
                 now() + interval '60 seconds',now())`,
        [
          randomUUID(), ids.call, "1".repeat(64), "X".repeat(24),
          JSON.stringify({ value: "x".repeat(32 * 1024) }),
          "a".repeat(64), "b".repeat(64), owner,
        ],
        /flow_action_arguments_too_large|flow_action_arguments_storage_bounded/
      );
      expect((await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM flow_action_storage_quotas WHERE call_id=$1",
        [ids.call]
      )).rows[0].count).toBe(0);

      await client.query(
        `INSERT INTO flow_action_receipts
          (id,call_id,runtime_digest,capability_epoch,step_path,step_attempt,tool,
           invocation_id,arguments,arguments_hash,idempotency_key,status,owner_token,
           dispatch_lease_expires_at,owner_heartbeat_at)
         VALUES ($1,$2,$3,0,'always',0,'bounded_action',$4,'{}',$5,$6,'reserved',$7,
                 now() + interval '60 seconds',now())`,
        [
          receipt, ids.call, "1".repeat(64), "Y".repeat(24),
          "c".repeat(64), "d".repeat(64), owner,
        ]
      );
      await client.query(
        `UPDATE flow_action_receipts
         SET dispatch_started_at=now(),dispatch_attempt=1,delivery_state='unknown'
         WHERE id=$1`,
        [receipt]
      );
      await expectRejected(
        `UPDATE flow_action_receipts
         SET status='succeeded',result=$2,result_hash=$3,delivery_state='committed',settled_at=now()
         WHERE id=$1`,
        [receipt, JSON.stringify({ value: "x".repeat(64 * 1024) }), "e".repeat(64)],
        /flow_action_result_too_large|flow_action_result_storage_bounded/
      );
      expect((await client.query<{ status: string; result: unknown }>(
        "SELECT status,result FROM flow_action_receipts WHERE id=$1",
        [receipt]
      )).rows[0]).toEqual({ status: "reserved", result: null });
      await expectRejected(
        `UPDATE flow_action_receipts
         SET status='failed',error=$2,delivery_state='rejected',settled_at=now()
         WHERE id=$1`,
        [receipt, JSON.stringify({ message: "x".repeat(16 * 1024) })],
        /flow_action_error_too_large|flow_action_error_storage_bounded/
      );
      expect((await client.query<{ status: string; error: unknown }>(
        "SELECT status,error FROM flow_action_receipts WHERE id=$1",
        [receipt]
      )).rows[0]).toEqual({ status: "reserved", error: null });

      const oversizedState = {
        version: 2,
        status: "routing",
        nodeId: null,
        currentStep: null,
        completedSteps: [],
        attempts: {},
        outputs: { adversarial: "x".repeat(8 * 1024 * 1024) },
        checkpoints: [],
        capabilityEpoch: 0,
        actionReceipts: [],
        revision: 0,
        updatedAt: new Date().toISOString(),
      };
      await expectRejected(
        "INSERT INTO flow_runs(call_id,state,revision) VALUES ($1,$2,0)",
        [ids.call, JSON.stringify(oversizedState)],
        /flow_run_hot_state_storage_bounded/
      );
    } finally {
      await client.query("ROLLBACK");
    }
  }, 30_000);
});
