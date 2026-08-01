import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlowExecutionStateSchema, hashFlowValue } from "../flow-runtime";

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));
const migrationSql = readFileSync(
  fileURLToPath(new URL("../../migrations/012_action_dispatch_reconciliation.sql", import.meta.url)),
  "utf8"
);

integration("action migration semantic reapply", () => {
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

  it("does not reinterpret a current reservation or rewrite its flow revision", async () => {
    const ids = {
      org: randomUUID(),
      agent: randomUUID(),
      call: randomUUID(),
      receipt: randomUUID(),
      owner: randomUUID(),
    };
    const at = "2026-07-16T18:30:00.000Z";
    const runtimeDigest = "1".repeat(64);
    const invocationId = "A".repeat(24);
    const argumentsHash = hashFlowValue({});
    const state = {
      version: 2,
      status: "routing",
      nodeId: null,
      currentStep: null,
      completedSteps: [],
      attempts: {},
      outputs: {},
      checkpoints: [],
      capabilityEpoch: 0,
      actionReceipts: [{
        id: ids.receipt,
        idempotencyKey: "2".repeat(64),
        step: "always",
        tool: "read_only_probe",
        capabilityEpoch: 0,
        arguments: {},
        argumentsHash,
        invocationId,
        status: "reserved",
        reservedAt: at,
      }],
      revision: 5,
      updatedAt: at,
    };
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO orgs (id,name) VALUES ($1,'Migration reapply')", [ids.org]);
      await client.query(
        "INSERT INTO agents (id,org_id,name,active_version) VALUES ($1,$2,'Migration agent',1)",
        [ids.agent, ids.org]
      );
      await client.query(
        `INSERT INTO calls (id,agent_id,agent_version,direction,runtime_digest)
         VALUES ($1,$2,1,'web',$3)`,
        [ids.call, ids.agent, runtimeDigest]
      );
      await client.query(
        "INSERT INTO flow_runs (call_id,state,revision,updated_at) VALUES ($1,$2,5,$3)",
        [ids.call, JSON.stringify(state), at]
      );
      await client.query(
        `INSERT INTO flow_action_receipts
          (id,call_id,runtime_digest,capability_epoch,step_path,step_attempt,tool,
           invocation_id,arguments,arguments_hash,idempotency_key,status,owner_token,
           dispatch_lease_expires_at,owner_heartbeat_at,reserved_at)
         VALUES ($1,$2,$3,0,'always',0,'read_only_probe',$4,'{}',$5,$6,'reserved',$7,
                 now() + interval '60 seconds',now(),$8)`,
        [
          ids.receipt, ids.call, runtimeDigest, invocationId,
          argumentsHash, "2".repeat(64), ids.owner, at,
        ]
      );

      await client.query(migrationSql);

      const receipt = (await client.query<{
        status: string;
        dispatch_started_at: Date | null;
        dispatch_attempt: number;
      }>(
        "SELECT status,dispatch_started_at,dispatch_attempt FROM flow_action_receipts WHERE id=$1",
        [ids.receipt]
      )).rows[0];
      expect(receipt).toEqual({ status: "reserved", dispatch_started_at: null, dispatch_attempt: 0 });

      const run = (await client.query<{ state: unknown; revision: number }>(
        "SELECT state,revision FROM flow_runs WHERE call_id=$1",
        [ids.call]
      )).rows[0];
      expect(run.revision).toBe(5);
      expect(FlowExecutionStateSchema.parse(run.state)).toEqual(state);
    } finally {
      await client.query("ROLLBACK");
    }
  }, 30_000);

  it("repairs offset and impossible embedded timestamps from typed ledger authority", async () => {
    const ids = {
      org: randomUUID(),
      agent: randomUUID(),
      call: randomUUID(),
      receipt: randomUUID(),
      owner: randomUUID(),
    };
    const runtimeDigest = "3".repeat(64);
    const invocationId = "B".repeat(24);
    const argumentsHash = hashFlowValue({ slot: "10:00" });
    const result = { reservation_id: "r-1" };
    const resultHash = hashFlowValue(result);
    const reservedAt = "2026-07-16T18:30:00.123Z";
    const dispatchStartedAt = "2026-07-16T18:31:00.456Z";
    const settledAt = "2026-07-16T18:32:00.789Z";
    const stateUpdatedAt = "2026-07-16T20:00:00.321Z";
    const state = {
      version: 2,
      status: "routing",
      nodeId: null,
      currentStep: null,
      completedSteps: [],
      attempts: {},
      outputs: {},
      checkpoints: [],
      capabilityEpoch: 0,
      actionReceipts: [{
        id: ids.receipt,
        idempotencyKey: "4".repeat(64),
        step: "always",
        tool: "reserve_slot",
        capabilityEpoch: 0,
        arguments: { slot: "10:00" },
        argumentsHash,
        invocationId,
        status: "succeeded",
        result,
        resultHash,
        reservedAt: "2026-07-16T11:30:00.123-07:00",
        dispatchStartedAt: "2026-02-31T18:31:00+00:00",
        dispatchAttempt: 1,
        settledAt: "2026-07-16T18:32:00.789+00:00",
      }],
      revision: 2,
      updatedAt: "2026-07-16T13:00:00.321-07:00",
    };
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO orgs (id,name) VALUES ($1,'Timestamp repair')", [ids.org]);
      await client.query(
        "INSERT INTO agents (id,org_id,name,active_version) VALUES ($1,$2,'Timestamp agent',1)",
        [ids.agent, ids.org]
      );
      await client.query(
        `INSERT INTO calls (id,agent_id,agent_version,direction,runtime_digest)
         VALUES ($1,$2,1,'web',$3)`,
        [ids.call, ids.agent, runtimeDigest]
      );
      await client.query(
        "INSERT INTO flow_runs (call_id,state,revision,updated_at) VALUES ($1,$2,2,$3)",
        [ids.call, JSON.stringify(state), stateUpdatedAt]
      );
      await client.query(
        `INSERT INTO flow_action_receipts
          (id,call_id,runtime_digest,capability_epoch,step_path,step_attempt,tool,
           invocation_id,arguments,arguments_hash,idempotency_key,status,owner_token,
           dispatch_lease_expires_at,owner_heartbeat_at,reserved_at)
         VALUES ($1,$2,$3,0,'always',0,'reserve_slot',$4,$5,$6,$7,'reserved',$8,
                 now() + interval '60 seconds',now(),$9)`,
        [
          ids.receipt, ids.call, runtimeDigest, invocationId,
          JSON.stringify({ slot: "10:00" }), argumentsHash, "4".repeat(64),
          ids.owner, reservedAt,
        ]
      );
      await client.query(
        `UPDATE flow_action_receipts
         SET dispatch_started_at=$2, dispatch_attempt=1, delivery_state='unknown'
         WHERE id=$1`,
        [ids.receipt, dispatchStartedAt]
      );
      await client.query(
        `UPDATE flow_action_receipts
         SET status='succeeded', result=$2, result_hash=$3,
             delivery_state='committed', settled_at=$4
         WHERE id=$1`,
        [ids.receipt, JSON.stringify(result), resultHash, settledAt]
      );

      await client.query(migrationSql);
      const first = (await client.query<{ state: unknown; revision: number }>(
        "SELECT state,revision FROM flow_runs WHERE call_id=$1",
        [ids.call]
      )).rows[0];
      const parsed = FlowExecutionStateSchema.parse(first.state);
      expect(first.revision).toBe(3);
      expect(parsed.updatedAt).toBe(stateUpdatedAt);
      expect(parsed.actionReceipts[0]).toMatchObject({
        reservedAt,
        dispatchStartedAt,
        settledAt,
      });

      await client.query(migrationSql);
      const second = (await client.query<{ state: unknown; revision: number }>(
        "SELECT state,revision FROM flow_runs WHERE call_id=$1",
        [ids.call]
      )).rows[0];
      expect(second.revision).toBe(3);
      expect(second.state).toEqual(first.state);
    } finally {
      await client.query("ROLLBACK");
    }
  }, 30_000);

  it("canonicalizes an empty flow state's offset timestamp exactly once", async () => {
    const ids = { org: randomUUID(), agent: randomUUID(), call: randomUUID() };
    const stateUpdatedAt = "2026-07-16T20:00:00.321Z";
    const state = {
      version: 2,
      status: "routing",
      nodeId: null,
      currentStep: null,
      completedSteps: [],
      attempts: {},
      outputs: {},
      checkpoints: [],
      capabilityEpoch: 0,
      actionReceipts: [],
      revision: 7,
      updatedAt: "2026-07-16T13:00:00.321-07:00",
    };
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO orgs (id,name) VALUES ($1,'Empty state repair')", [ids.org]);
      await client.query(
        "INSERT INTO agents (id,org_id,name,active_version) VALUES ($1,$2,'Empty state agent',1)",
        [ids.agent, ids.org]
      );
      await client.query(
        `INSERT INTO calls (id,agent_id,agent_version,direction,runtime_digest)
         VALUES ($1,$2,1,'web',$3)`,
        [ids.call, ids.agent, "5".repeat(64)]
      );
      await client.query(
        "INSERT INTO flow_runs (call_id,state,revision,updated_at) VALUES ($1,$2,7,$3)",
        [ids.call, JSON.stringify(state), stateUpdatedAt]
      );

      await client.query(migrationSql);
      const first = (await client.query<{ state: unknown; revision: number }>(
        "SELECT state,revision FROM flow_runs WHERE call_id=$1",
        [ids.call]
      )).rows[0];
      const parsed = FlowExecutionStateSchema.parse(first.state);
      expect(first.revision).toBe(8);
      expect(parsed.updatedAt).toBe(stateUpdatedAt);
      expect(parsed.actionReceipts).toEqual([]);

      await client.query(migrationSql);
      const second = (await client.query<{ state: unknown; revision: number }>(
        "SELECT state,revision FROM flow_runs WHERE call_id=$1",
        [ids.call]
      )).rows[0];
      expect(second).toEqual(first);
    } finally {
      await client.query("ROLLBACK");
    }
  }, 30_000);

  it("fails closed when a prerelease authority index name hides a weaker definition", async () => {
    await client.query("BEGIN");
    try {
      await client.query("DROP INDEX idx_flow_action_expired_owners");
      await client.query(
        "CREATE INDEX idx_flow_action_expired_owners ON flow_action_receipts(call_id)"
      );
      await expect(client.query(migrationSql)).rejects.toThrow(
        /authority index idx_flow_action_expired_owners has unexpected definition/
      );
    } finally {
      await client.query("ROLLBACK");
    }
  }, 30_000);
});
