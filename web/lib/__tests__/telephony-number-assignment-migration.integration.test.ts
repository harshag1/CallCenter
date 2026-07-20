import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminDatabaseUrl = process.env.SECURITY_MIGRATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(adminDatabaseUrl));

function databaseUrl(base: string, database: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function rejectWithCode(pool: Pool, sql: string, params: readonly unknown[], code: string) {
  try {
    await pool.query(sql, [...params]);
    throw new Error(`expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

integration("telephony number assignment authority migration", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const freshDatabase = `hacc_number_fresh_${suffix}`;
  const upgradeDatabase = `hacc_number_upgrade_${suffix}`;
  const ids = {
    validOrg: randomUUID(),
    otherOrg: randomUUID(),
    validAgent: randomUUID(),
    duplicateA: randomUUID(),
    duplicateB: randomUUID(),
    invalidSingle: randomUUID(),
    invalidDuplicateA: randomUUID(),
    invalidDuplicateB: randomUUID(),
    invalidLeadingZero: randomUUID(),
    invalidWhitespace: randomUUID(),
    invalidOverlength: randomUUID(),
    invalidTrailingNewline: randomUUID(),
    reservedNull: randomUUID(),
    concurrentA: randomUUID(),
    concurrentB: randomUUID(),
    provisioningExecution: randomUUID(),
    nullReservationExecution: randomUUID(),
  };
  const validNumber = "+14155550101";
  const duplicateNumber = "+14155550102";
  const invalidSingleNumber = "1415-not-e164";
  const invalidDuplicateNumber = "duplicate-invalid";
  const invalidLeadingZeroNumber = "+04155550123";
  const invalidWhitespaceNumber = " +14155550123";
  const invalidOverlengthNumber = "9".repeat(5_000);
  const invalidTrailingNewlineNumber = "+14155550123\n";
  let admin: Pool;
  let fresh: Pool;
  let upgrade: Pool;
  let migration027 = "";

  async function apply(
    pool: Pool,
    migrations: readonly { name: string; sql: string }[],
    phase: string
  ) {
    for (const migration of migrations) {
      await pool.query("BEGIN");
      try {
        await pool.query(migration.sql);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK").catch(() => undefined);
        throw new Error(`${phase} failed at ${migration.name}`, { cause: error });
      }
    }
  }

  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("missing integration database URL");
    admin = new Pool({ connectionString: adminDatabaseUrl, ssl: false, max: 1 });
    await admin.query(`CREATE DATABASE "${freshDatabase}"`);
    await admin.query(`CREATE DATABASE "${upgradeDatabase}"`);
    fresh = new Pool({
      connectionString: databaseUrl(adminDatabaseUrl, freshDatabase),
      ssl: false,
      max: 2,
    });
    upgrade = new Pool({
      connectionString: databaseUrl(adminDatabaseUrl, upgradeDatabase),
      ssl: false,
      max: 2,
    });
    await fresh.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await fresh.query("CREATE EXTENSION IF NOT EXISTS vector");
    await upgrade.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await upgrade.query("CREATE EXTENSION IF NOT EXISTS vector");

    const migrationsUrl = new URL("../../migrations/", import.meta.url);
    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort();
    expect(migrationNames).toContain("027_telephony_number_assignment_authority.sql");
    const migrations = await Promise.all(migrationNames.map(async (name) => ({
      name,
      sql: await readFile(new URL(name, migrationsUrl), "utf8"),
    })));
    const through026 = migrations.filter(({ name }) => name < "027_");
    const only027 = migrations.filter(({ name }) => name.startsWith("027_"));
    const after027 = migrations.filter(({ name }) => name > "027_");
    migration027 = only027[0]?.sql ?? "";
    expect(migration027).not.toBe("");

    await apply(fresh, migrations, "fresh install");
    await apply(upgrade, through026, "pre-027 upgrade setup");

    await upgrade.query(
      `INSERT INTO orgs (id, name) VALUES
        ($1, 'Valid number tenant'),
        ($2, 'Other number tenant')`,
      [ids.validOrg, ids.otherOrg]
    );
    await upgrade.query(
      `INSERT INTO operator_action_executions (
         id, org_id, actor_email, capability, idempotency_key, arguments_sha256,
         status, estimated_units, estimated_micro_usd, result,
         dispatch_started_at, settled_at
       ) VALUES
       (
         $1, $2, 'migration-test@example.test', 'provision_phone_number',
         'number-migration-upgrade-proof', $3, 'succeeded', 1, 1000,
         '{"phone_number":"manual-reconciliation-required"}'::jsonb,
         now(), now()
       ),
       (
         $4, $2, 'migration-test@example.test', 'provision_phone_number',
         'number-migration-null-reservation-proof', $3, 'succeeded', 1, 1000,
         '{"phone_number":"reservation-remains-live"}'::jsonb,
         now(), now()
       )`,
      [
        ids.provisioningExecution,
        ids.validOrg,
        "a".repeat(64),
        ids.nullReservationExecution,
      ]
    );
    const agents = [
      [ids.validAgent, ids.validOrg, "Valid unique", validNumber, null],
      [ids.duplicateA, ids.validOrg, "Duplicate A", duplicateNumber, null],
      [ids.duplicateB, ids.otherOrg, "Duplicate B", duplicateNumber, null],
      [
        ids.invalidSingle,
        ids.validOrg,
        "Invalid single",
        invalidSingleNumber,
        ids.provisioningExecution,
      ],
      [
        ids.invalidDuplicateA,
        ids.validOrg,
        "Invalid duplicate A",
        invalidDuplicateNumber,
        null,
      ],
      [
        ids.invalidDuplicateB,
        ids.otherOrg,
        "Invalid duplicate B",
        invalidDuplicateNumber,
        null,
      ],
      [ids.invalidLeadingZero, ids.validOrg, "Invalid leading zero", invalidLeadingZeroNumber, null],
      [ids.invalidWhitespace, ids.validOrg, "Invalid whitespace", invalidWhitespaceNumber, null],
      [ids.invalidOverlength, ids.validOrg, "Invalid overlength", invalidOverlengthNumber, null],
      [
        ids.invalidTrailingNewline,
        ids.validOrg,
        "Invalid trailing newline",
        invalidTrailingNewlineNumber,
        null,
      ],
      [
        ids.reservedNull,
        ids.validOrg,
        "Reserved without a provider number",
        null,
        ids.nullReservationExecution,
      ],
    ] as const;
    for (const [id, orgId, name, phoneNumber, provisioningExecution] of agents) {
      await upgrade.query(
        `INSERT INTO agents (
           id, org_id, name, phone_number, phone_number_provisioning_execution_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [id, orgId, name, phoneNumber, provisioningExecution]
      );
    }
    await apply(upgrade, only027, "027 upgrade");
    await apply(upgrade, after027, "post-027 forward upgrade");
  }, 120_000);

  afterAll(async () => {
    await fresh?.end().catch(() => undefined);
    await upgrade?.end().catch(() => undefined);
    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${freshDatabase}"`);
        await admin.query(`DROP DATABASE IF EXISTS "${upgradeDatabase}"`);
      } finally {
        await admin.end().catch(() => undefined);
      }
    }
  });

  it("installs cleanly on a fresh database and reapplies without changing authority", async () => {
    expect((await fresh.query(
      "SELECT 1 FROM hacc_private.telephony_number_assignment_quarantines"
    )).rowCount).toBe(0);

    const boundary = (await fresh.query<{
      e164_constraint: boolean;
      unique_index: boolean;
      row_security: boolean;
      force_row_security: boolean;
      backend_deny_policy: boolean;
      owner_policy: boolean;
      backend_has_privilege: boolean;
      api_has_privilege: boolean;
      foreign_key_count: number;
      immutable_trigger: boolean;
      no_truncate_trigger: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid='public.agents'::regclass
             AND conname='agents_phone_number_e164_shape'
             AND contype='c' AND convalidated
         ) AS e164_constraint,
         EXISTS (
           SELECT 1
           FROM pg_class index_relation
           JOIN pg_index index_catalog ON index_catalog.indexrelid=index_relation.oid
           WHERE index_relation.oid='public.uq_agents_phone_number_authority'::regclass
             AND index_catalog.indrelid='public.agents'::regclass
             AND index_catalog.indisunique
             AND index_catalog.indisvalid
             AND index_catalog.indisready
             AND index_catalog.indnatts=1
             AND index_catalog.indpred IS NOT NULL
             AND pg_get_indexdef(index_relation.oid, 1, true)='phone_number'
         ) AS unique_index,
         relation.relrowsecurity AS row_security,
         relation.relforcerowsecurity AS force_row_security,
         EXISTS (
           SELECT 1 FROM pg_policies policy
           WHERE policy.schemaname='hacc_private'
             AND policy.tablename='telephony_number_assignment_quarantines'
             AND policy.policyname='hacc_backend_all'
             AND policy.roles=ARRAY['hacc_backend']::name[]
             AND policy.qual='false' AND policy.with_check='false'
         ) AS backend_deny_policy,
         EXISTS (
           SELECT 1 FROM pg_policies policy
           WHERE policy.schemaname='hacc_private'
             AND policy.tablename='telephony_number_assignment_quarantines'
             AND policy.policyname='hacc_migration_owner_all'
             AND policy.roles=ARRAY[current_user]::name[]
             AND policy.qual='true' AND policy.with_check='true'
         ) AS owner_policy,
         has_table_privilege('hacc_backend',
           'hacc_private.telephony_number_assignment_quarantines', 'SELECT')
         OR has_table_privilege('hacc_backend',
           'hacc_private.telephony_number_assignment_quarantines', 'INSERT')
         OR has_table_privilege('hacc_backend',
           'hacc_private.telephony_number_assignment_quarantines', 'UPDATE')
         OR has_table_privilege('hacc_backend',
           'hacc_private.telephony_number_assignment_quarantines', 'DELETE')
         OR has_table_privilege('hacc_backend',
           'hacc_private.telephony_number_assignment_quarantines', 'TRUNCATE')
           AS backend_has_privilege,
         EXISTS (
           SELECT 1
           FROM pg_roles api_role
           WHERE api_role.rolname = ANY(
             ARRAY['anon','authenticated','service_role','hacc_worker']
           ) AND (
               has_table_privilege(api_role.oid,
                 'hacc_private.telephony_number_assignment_quarantines', 'SELECT')
               OR has_table_privilege(api_role.oid,
                 'hacc_private.telephony_number_assignment_quarantines', 'INSERT')
               OR has_table_privilege(api_role.oid,
                 'hacc_private.telephony_number_assignment_quarantines', 'UPDATE')
               OR has_table_privilege(api_role.oid,
                 'hacc_private.telephony_number_assignment_quarantines', 'DELETE')
               OR has_table_privilege(api_role.oid,
                 'hacc_private.telephony_number_assignment_quarantines', 'TRUNCATE')
             )
         ) AS api_has_privilege,
         (
           SELECT count(*)::integer
           FROM pg_constraint
           WHERE conrelid='hacc_private.telephony_number_assignment_quarantines'::regclass
             AND contype='f'
         ) AS foreign_key_count,
         EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid='hacc_private.telephony_number_assignment_quarantines'::regclass
             AND tgname='trg_telephony_number_quarantine_immutable'
             AND NOT tgisinternal
         ) AS immutable_trigger,
         EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid='hacc_private.telephony_number_assignment_quarantines'::regclass
             AND tgname='trg_telephony_number_quarantine_no_truncate'
             AND NOT tgisinternal
         ) AS no_truncate_trigger
       FROM pg_class relation
       WHERE relation.oid='hacc_private.telephony_number_assignment_quarantines'::regclass`
    )).rows[0];
    expect(boundary).toEqual({
      e164_constraint: true,
      unique_index: true,
      row_security: true,
      force_row_security: true,
      backend_deny_policy: true,
      owner_policy: true,
      backend_has_privilege: false,
      api_has_privilege: false,
      foreign_key_count: 0,
      immutable_trigger: true,
      no_truncate_trigger: true,
    });

    await fresh.query(migration027);
    expect((await fresh.query(
      "SELECT 1 FROM hacc_private.telephony_number_assignment_quarantines"
    )).rowCount).toBe(0);
  });

  it("quarantines every invalid or duplicate participant without selecting a tenant winner", async () => {
    const assignments = await upgrade.query<{
      id: string;
      phone_number: string | null;
      phone_number_provisioning_execution_id: string | null;
    }>(
      `SELECT id, phone_number, phone_number_provisioning_execution_id
       FROM agents ORDER BY id`
    );
    const byId = new Map(assignments.rows.map((row) => [row.id, row]));
    expect(byId.get(ids.validAgent)?.phone_number).toBe(validNumber);
    for (const agentId of [
      ids.duplicateA,
      ids.duplicateB,
      ids.invalidSingle,
      ids.invalidDuplicateA,
      ids.invalidDuplicateB,
      ids.invalidLeadingZero,
      ids.invalidWhitespace,
      ids.invalidOverlength,
      ids.invalidTrailingNewline,
    ]) {
      expect(byId.get(agentId)?.phone_number).toBeNull();
      expect(byId.get(agentId)?.phone_number_provisioning_execution_id).toBeNull();
    }
    expect(byId.get(ids.reservedNull)).toMatchObject({
      phone_number: null,
      phone_number_provisioning_execution_id: ids.nullReservationExecution,
    });

    const evidence = await upgrade.query<{
      agent_id: string;
      org_id: string;
      phone_number: string;
      phone_number_sha256: string;
      assignment_sha256: string;
      phone_number_provisioning_execution_id: string | null;
      reason: string;
      assignment_count: number;
      incident_sha256: string;
    }>(
      `SELECT agent_id, org_id, phone_number,
              phone_number_sha256, assignment_sha256,
              phone_number_provisioning_execution_id, reason,
              assignment_count, incident_sha256
       FROM hacc_private.telephony_number_assignment_quarantines
       ORDER BY reason, agent_id`
    );
    expect(evidence.rowCount).toBe(9);
    expect(evidence.rows.map((row) => row.reason).sort()).toEqual([
      "duplicate_assignment",
      "duplicate_assignment",
      "invalid_e164",
      "invalid_e164",
      "invalid_e164",
      "invalid_e164",
      "invalid_e164",
      "invalid_e164_and_duplicate_assignment",
      "invalid_e164_and_duplicate_assignment",
    ]);
    for (const row of evidence.rows) {
      expect(row.incident_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.phone_number_sha256).toBe(
        createHash("sha256").update(row.phone_number, "utf8").digest("hex")
      );
      expect(row.assignment_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(evidence.rows.find((row) => row.agent_id === ids.invalidSingle)).toMatchObject({
      org_id: ids.validOrg,
      phone_number: invalidSingleNumber,
      phone_number_provisioning_execution_id: ids.provisioningExecution,
      reason: "invalid_e164",
      assignment_count: 1,
    });
    const duplicateAgentIds = new Set<string>([ids.duplicateA, ids.duplicateB]);
    const duplicateEvidence = evidence.rows.filter((row) =>
      duplicateAgentIds.has(row.agent_id)
    );
    expect(new Set(duplicateEvidence.map((row) => row.assignment_sha256)).size).toBe(1);
    for (const row of duplicateEvidence) {
      expect(row).toMatchObject({
        phone_number: duplicateNumber,
        reason: "duplicate_assignment",
        assignment_count: 2,
      });
    }
    expect(evidence.rows.find((row) => row.agent_id === ids.invalidOverlength)?.phone_number)
      .toHaveLength(5_000);
  });

  it("rejects future invalid/duplicate assignments and keeps quarantine evidence immutable", async () => {
    await rejectWithCode(
      upgrade,
      "UPDATE agents SET phone_number='not-e164' WHERE id=$1",
      [ids.duplicateA],
      "23514"
    );
    await rejectWithCode(
      upgrade,
      "UPDATE agents SET phone_number=$2 WHERE id=$1",
      [ids.duplicateA, validNumber],
      "23505"
    );
    await expect(upgrade.query(
      `UPDATE hacc_private.telephony_number_assignment_quarantines
       SET reason=reason WHERE agent_id=$1`,
      [ids.invalidSingle]
    )).rejects.toThrow(/append-only/);
    await expect(upgrade.query(
      `DELETE FROM hacc_private.telephony_number_assignment_quarantines
       WHERE agent_id=$1`,
      [ids.invalidSingle]
    )).rejects.toThrow(/append-only/);
    await expect(upgrade.query(
      "TRUNCATE hacc_private.telephony_number_assignment_quarantines"
    )).rejects.toThrow(/append-only/);

    await upgrade.query(
      `INSERT INTO agents (id,org_id,name,phone_number) VALUES
         ($1,$3,'Minimum E.164','+1234567'),
         ($2,$3,'Maximum E.164','+123456789012345')`,
      [randomUUID(), randomUUID(), ids.validOrg]
    );
    await upgrade.query(
      `INSERT INTO agents (id,org_id,name,phone_number) VALUES
         ($1,$3,'Concurrent A',NULL),
         ($2,$3,'Concurrent B',NULL)`,
      [ids.concurrentA, ids.concurrentB, ids.validOrg]
    );
    const first = await upgrade.connect();
    const second = await upgrade.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await first.query(
        "UPDATE agents SET phone_number='+14155550999' WHERE id=$1",
        [ids.concurrentA]
      );
      const competingAssignment = second.query(
        "UPDATE agents SET phone_number='+14155550999' WHERE id=$1",
        [ids.concurrentB]
      );
      await first.query("COMMIT");
      await expect(competingAssignment).rejects.toMatchObject({ code: "23505" });
      await second.query("ROLLBACK");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
    expect((await upgrade.query(
      `SELECT count(*)::integer AS assigned
       FROM agents WHERE phone_number='+14155550999'`
    )).rows[0]?.assigned).toBe(1);
  });

  it("reapplies without duplicating evidence or restoring removed assignments", async () => {
    const before = await upgrade.query<{
      evidence_count: number;
      evidence_sha256: string;
    }>(
      `SELECT count(*)::integer AS evidence_count,
              encode(digest(string_agg(incident_sha256, '' ORDER BY incident_sha256), 'sha256'), 'hex')
                AS evidence_sha256
       FROM hacc_private.telephony_number_assignment_quarantines`
    );
    await upgrade.query(migration027);
    const after = await upgrade.query<{
      evidence_count: number;
      evidence_sha256: string;
    }>(
      `SELECT count(*)::integer AS evidence_count,
              encode(digest(string_agg(incident_sha256, '' ORDER BY incident_sha256), 'sha256'), 'hex')
                AS evidence_sha256
       FROM hacc_private.telephony_number_assignment_quarantines`
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]?.evidence_count).toBe(9);
    expect((await upgrade.query(
      "SELECT phone_number FROM agents WHERE id=$1",
      [ids.validAgent]
    )).rows[0]?.phone_number).toBe(validNumber);
    expect((await upgrade.query(
      `SELECT 1 FROM agents
       WHERE id = ANY($1::uuid[]) AND phone_number IS NOT NULL`,
      [[
        ids.duplicateA,
        ids.duplicateB,
        ids.invalidSingle,
        ids.invalidDuplicateA,
        ids.invalidDuplicateB,
        ids.invalidLeadingZero,
        ids.invalidWhitespace,
        ids.invalidOverlength,
        ids.invalidTrailingNewline,
      ]]
    )).rowCount).toBe(0);
  });
});
