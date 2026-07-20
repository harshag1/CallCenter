import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminDatabaseUrl = process.env.SECURITY_MIGRATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(adminDatabaseUrl));
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function databaseUrl(base: string, database: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function authorityManifest(input: Readonly<{
  callId?: string;
  orgId: string;
  executionId: string;
}>): Record<string, unknown> {
  return {
    v: 1,
    capability: "schedule_call",
    ...(input.callId ? { callId: input.callId } : {}),
    orgId: input.orgId,
    operatorExecutionId: input.executionId,
    operatorArgumentsSha256: SHA_A,
    runtimeDigest: SHA_B,
    targetSetSha256: null,
    agentVersion: 1,
    flowId: null,
    campaignId: null,
  };
}

integration("call-bound scheduled runtime authority migration", () => {
  const database = `hacc_call_authority_${randomUUID().replaceAll("-", "")}`;
  const orgId = randomUUID();
  const agentId = randomUUID();
  const executionId = randomUUID();
  const legacyPendingId = randomUUID();
  const legacyDispatchedId = randomUUID();
  let admin: Pool;
  let target: Pool;
  let migration020 = "";

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
    expect(names).toContain("020_call_bound_runtime_authority.sql");
    for (const name of names.filter((candidate) => candidate < "020_")) {
      await target.query(await readFile(new URL(name, migrationsUrl), "utf8"));
    }

    // Recreate the exact executable-authority shape deployed by the original 013 migration.
    // This allows real old pending/dialing rows to exist before applying the upgrade.
    await target.query(
      `ALTER TABLE scheduled_calls
         DROP CONSTRAINT scheduled_calls_executable_authority_valid;
       ALTER TABLE scheduled_calls
         ADD CONSTRAINT scheduled_calls_executable_authority_valid CHECK (
           status NOT IN ('pending', 'dialing') OR (
             operator_execution_id IS NOT NULL
             AND operator_arguments_sha256 IS NOT NULL
             AND runtime_snapshot IS NOT NULL
             AND jsonb_typeof(runtime_snapshot) = 'object'
             AND runtime_digest IS NOT NULL
             AND agent_version > 0
             AND authority_manifest = jsonb_build_object(
               'v', 1,
               'capability', authority_manifest->'capability',
               'orgId', org_id::text,
               'operatorExecutionId', operator_execution_id::text,
               'operatorArgumentsSha256', operator_arguments_sha256,
               'runtimeDigest', runtime_digest,
               'targetSetSha256', 'null'::jsonb,
               'agentVersion', agent_version,
               'flowId', 'null'::jsonb,
               'campaignId', 'null'::jsonb
             )
           )
         )`
    );

    await target.query("INSERT INTO orgs (id, name) VALUES ($1, 'Call authority upgrade')", [orgId]);
    await target.query(
      `INSERT INTO users (email, org_id, operator_role)
       VALUES ('operator@example.test', $1, 'operator')`,
      [orgId]
    );
    await target.query(
      `INSERT INTO agents (id, org_id, name, active_version)
       VALUES ($1,$2,'Call-bound agent',1)`,
      [agentId, orgId]
    );
    await target.query(
      `INSERT INTO agent_versions
         (agent_id, version, instructions, voice, flow, created_by)
       VALUES ($1,1,'Be helpful.','alloy','{"nodes":[],"edges":[]}','operator@example.test')`,
      [agentId]
    );
    await target.query(
      `INSERT INTO operator_action_executions
         (id, org_id, actor_email, capability, idempotency_key, arguments_sha256,
          status, estimated_units, estimated_micro_usd, result,
          dispatch_started_at, settled_at)
       VALUES ($1,$2,'operator@example.test','schedule_call','upgrade-proof-0001',$3,
               'succeeded',1,1,'{}',now(),now())`,
      [executionId, orgId, SHA_A]
    );
    for (const id of [legacyPendingId, legacyDispatchedId]) {
      await target.query(
        `INSERT INTO scheduled_calls
           (id, org_id, agent_id, agent_version, to_number, run_at, status, created_by,
            operator_execution_id, operator_arguments_sha256, runtime_snapshot,
            runtime_digest, authority_manifest)
         VALUES ($1,$2,$3,1,'+14155550123',now(),'pending','upgrade-test',
                 $4,$5,'{"v":2}',$6,$7)`,
        [
          id,
          orgId,
          agentId,
          executionId,
          SHA_A,
          SHA_B,
          authorityManifest({ orgId, executionId }),
        ]
      );
    }
    await target.query(
      `INSERT INTO calls
         (id, scheduled_call_id, agent_id, agent_version, direction, status,
          from_number, to_number, metadata, runtime_snapshot, runtime_digest)
       VALUES ($1,$1,$2,1,'outbound','dialing','+14155550000','+14155550123','{}',
               '{"v":2}',$3)`,
      [legacyDispatchedId, agentId, SHA_B]
    );
    await target.query(
      `UPDATE scheduled_calls
       SET status = 'dialing', claim_token = $2, claimed_at = now(),
           claim_lease_expires_at = now() + interval '1 minute',
           dispatch_started_at = now(), completed_call_id = id
       WHERE id = $1`,
      [legacyDispatchedId, randomUUID()]
    );

    migration020 = await readFile(
      new URL("020_call_bound_runtime_authority.sql", migrationsUrl),
      "utf8"
    );
    await target.query(migration020);
  }, 90_000);

  afterAll(async () => {
    await target?.end().catch(() => {});
    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      } finally {
        await admin.end().catch(() => {});
      }
    }
  });

  it("quarantines every pre-call-bound executable row instead of asserting false authority", async () => {
    const statuses = await target.query<{ id: string; status: string }>(
      "SELECT id, status FROM scheduled_calls WHERE id = ANY($1)",
      [[legacyPendingId, legacyDispatchedId]]
    );
    expect(new Map(statuses.rows.map((row) => [row.id, row.status]))).toEqual(new Map([
      [legacyPendingId, "canceled"],
      [legacyDispatchedId, "indeterminate"],
    ]));
  });

  it("accepts only an exact callId-bound authority manifest on fresh executable rows", async () => {
    const validId = randomUUID();
    const invalidId = randomUUID();
    const insert = (id: string, manifest: Record<string, unknown>) => target.query(
      `INSERT INTO scheduled_calls
         (id, org_id, agent_id, agent_version, to_number, run_at, status, created_by,
          operator_execution_id, operator_arguments_sha256, runtime_snapshot,
          runtime_digest, authority_manifest)
       VALUES ($1,$2,$3,1,'+14155550124',now(),'pending','fresh-test',
               $4,$5,'{"v":2}',$6,$7)`,
      [id, orgId, agentId, executionId, SHA_A, SHA_B, manifest]
    );
    await expect(insert(invalidId, authorityManifest({ orgId, executionId })))
      .rejects.toMatchObject({ code: "23514" });
    await expect(insert(validId, authorityManifest({ callId: validId, orgId, executionId })))
      .resolves.toMatchObject({ rowCount: 1 });

    const constraint = await target.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
       WHERE conrelid = 'scheduled_calls'::regclass
         AND conname = 'scheduled_calls_executable_authority_valid'`
    );
    expect(constraint.rows).toEqual([{ convalidated: true }]);

    await target.query(migration020);
    await expect(target.query("SELECT status FROM scheduled_calls WHERE id = $1", [validId]))
      .resolves.toMatchObject({ rows: [{ status: "pending" }] });
  });
});
