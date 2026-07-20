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

integration("recording consent authority upgrade", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const freshDatabase = `hacc_recording_fresh_${suffix}`;
  const upgradeDatabase = `hacc_recording_upgrade_${suffix}`;
  const ids = {
    org: randomUUID(),
    agent: randomUUID(),
    legacyCall: randomUUID(),
    validCall: randomUUID(),
    wrongReceiptCall: randomUUID(),
    rawConsentCall: randomUUID(),
    outboundCall: randomUUID(),
    overRetentionCall: randomUUID(),
    predatesConsentCall: randomUUID(),
    receiptOwnerCall: randomUUID(),
  };
  let admin: Pool;
  let fresh: Pool;
  let upgrade: Pool;
  let migration014 = "";
  let migration024 = "";
  let migration029 = "";
  let receiptGrantedAt = new Date(0);

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
    for (const pool of [fresh, upgrade]) {
      await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    }

    const migrationsUrl = new URL("../../migrations/", import.meta.url);
    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort();
    expect(migrationNames).toContain("029_recording_consent_authority_upgrade.sql");
    const migrations = await Promise.all(migrationNames.map(async (name) => ({
      name,
      sql: await readFile(new URL(name, migrationsUrl), "utf8"),
    })));
    const through013 = migrations.filter(({ name }) => name < "014_");
    const after013Before029 = migrations.filter(({ name }) => name >= "014_" && name < "029_");
    const only029 = migrations.filter(({ name }) => name.startsWith("029_"));
    const after029 = migrations.filter(({ name }) => name > "029_");
    migration014 = migrations.find(({ name }) => name.startsWith("014_"))?.sql ?? "";
    migration024 = migrations.find(({ name }) => name.startsWith("024_"))?.sql ?? "";
    migration029 = only029[0]?.sql ?? "";
    expect(migration014).not.toBe("");
    expect(migration024).not.toBe("");
    expect(migration029).not.toBe("");

    await apply(fresh, migrations, "fresh install");
    await apply(upgrade, through013, "legacy baseline");
    await upgrade.query("INSERT INTO orgs(id,name) VALUES ($1,'Recording upgrade tenant')", [ids.org]);
    await upgrade.query(
      "INSERT INTO agents(id,org_id,name) VALUES ($1,$2,'Recording upgrade agent')",
      [ids.agent, ids.org]
    );
    await upgrade.query(
      `INSERT INTO calls(id,agent_id,agent_version,direction,status,recording_path)
       VALUES ($1,$2,1,'web','completed',$3)`,
      [ids.legacyCall, ids.agent, `db:${ids.legacyCall}`]
    );
    await upgrade.query(
      `INSERT INTO call_recordings(call_id,mime,data,created_at)
       VALUES ($1,'audio/webm',decode('010203','hex'),now() - interval '3 days')`,
      [ids.legacyCall]
    );
    await apply(upgrade, after013Before029, "014 through 028 upgrade");

    const calls = [
      [ids.validCall, "web"],
      [ids.wrongReceiptCall, "web"],
      [ids.rawConsentCall, "web"],
      [ids.outboundCall, "outbound"],
      [ids.overRetentionCall, "web"],
      [ids.predatesConsentCall, "web"],
      [ids.receiptOwnerCall, "web"],
    ] as const;
    for (const [callId, direction] of calls) {
      await upgrade.query(
        `INSERT INTO calls(id,agent_id,agent_version,direction,status,recording_path)
         VALUES ($1,$2,1,$3,'completed',$4)`,
        [callId, ids.agent, direction, `db:${callId}`]
      );
    }

    const now = new Date();
    receiptGrantedAt = new Date(now.getTime() - 60_000);
    const uploadExpiresAt = new Date(receiptGrantedAt.getTime() + 2 * 60 * 60_000);
    const validReceipt = "a".repeat(64);
    const ownerReceipt = "b".repeat(64);
    const rawReceipt = "c".repeat(64);
    const outboundReceipt = "d".repeat(64);
    const overRetentionReceipt = "e".repeat(64);
    const predatesConsentReceipt = "f".repeat(64);
    const receipts = [
      [validReceipt, ids.validCall],
      [ownerReceipt, ids.receiptOwnerCall],
      [rawReceipt, ids.rawConsentCall],
      [outboundReceipt, ids.outboundCall],
      [overRetentionReceipt, ids.overRetentionCall],
      [predatesConsentReceipt, ids.predatesConsentCall],
    ] as const;
    for (const [receipt, callId] of receipts) {
      await upgrade.query(
        `INSERT INTO recording_consent_receipts(
           org_id,receipt_hmac_sha256,call_id,granted_at,notice_version,
           retention_days,upload_token_hash,upload_expires_at,created_at
         ) VALUES ($1,$2,$3,$4,'recording-v1',7,$5,$6,$7)`,
        [
          ids.org,
          receipt,
          callId,
          receiptGrantedAt.toISOString(),
          createHash("sha256").update(`${receipt}:upload`).digest("hex"),
          uploadExpiresAt.toISOString(),
          now.toISOString(),
        ]
      );
    }

    const insertRecording = async (
      callId: string,
      receipt: string | null,
      options: {
        consentId?: string | null;
        grantedAt?: Date;
        retainedDays?: number;
        createdAt?: Date;
      } = {}
    ) => {
      const boundGrant = options.grantedAt ?? receiptGrantedAt;
      const retainedDays = options.retainedDays ?? 7;
      const createdAt = options.createdAt ?? now;
      await upgrade.query(
        `INSERT INTO call_recordings(
           call_id,mime,data,created_at,consent_id,consent_receipt_hmac_sha256,
           consent_granted_at,consent_notice_version,retained_until,byte_length,sha256
         ) VALUES (
           $1,'audio/webm',decode('040506','hex'),$6,$2,$3,$4,'recording-v1',
           $4::timestamptz + make_interval(days => $5),3,
           encode(digest(decode('040506','hex'),'sha256'),'hex')
         )`,
        [
          callId,
          options.consentId ?? null,
          receipt,
          boundGrant.toISOString(),
          retainedDays,
          createdAt.toISOString(),
        ]
      );
    };
    await insertRecording(ids.validCall, validReceipt);
    await insertRecording(ids.wrongReceiptCall, ownerReceipt);
    await insertRecording(ids.rawConsentCall, rawReceipt, { consentId: randomUUID() });
    await insertRecording(ids.outboundCall, outboundReceipt);
    await insertRecording(ids.overRetentionCall, overRetentionReceipt, { retainedDays: 8 });
    await insertRecording(ids.predatesConsentCall, predatesConsentReceipt, {
      createdAt: new Date(receiptGrantedAt.getTime() - 60 * 60_000),
    });
    await apply(upgrade, only029, "029 consent authority upgrade");
    await apply(upgrade, after029, "post-029 forward upgrade");
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

  it("installs the exact non-null receipt boundary on a fresh database", async () => {
    const boundary = (await fresh.query<{
      hmac_not_null: boolean;
      granted_not_null: boolean;
      notice_not_null: boolean;
      foreign_key: boolean;
      raw_id_check: boolean;
      authority_trigger: boolean;
    }>(
      `SELECT
         (SELECT attnotnull FROM pg_attribute
          WHERE attrelid='call_recordings'::regclass
            AND attname='consent_receipt_hmac_sha256') AS hmac_not_null,
         (SELECT attnotnull FROM pg_attribute
          WHERE attrelid='call_recordings'::regclass
            AND attname='consent_granted_at') AS granted_not_null,
         (SELECT attnotnull FROM pg_attribute
          WHERE attrelid='call_recordings'::regclass
            AND attname='consent_notice_version') AS notice_not_null,
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid='call_recordings'::regclass
             AND conname='call_recordings_consent_receipt_fk'
             AND contype='f' AND convalidated
         ) AS foreign_key,
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid='call_recordings'::regclass
             AND conname='call_recordings_raw_consent_id_absent'
             AND contype='c' AND convalidated
         ) AS raw_id_check,
         EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid='call_recordings'::regclass
             AND tgname='trg_enforce_call_recording_consent_authority'
             AND NOT tgisinternal
         ) AS authority_trigger`
    )).rows[0];
    expect(boundary).toEqual({
      hmac_not_null: true,
      granted_not_null: true,
      notice_not_null: true,
      foreign_key: true,
      raw_id_check: true,
      authority_trigger: true,
    });
  });

  it("purges every legacy or mismatched audio payload and retains only hash evidence", async () => {
    const recordings = await upgrade.query<{ call_id: string }>(
      "SELECT call_id FROM call_recordings ORDER BY call_id"
    );
    expect(recordings.rows).toEqual([{ call_id: ids.validCall }]);

    const purgedIds = [
      ids.legacyCall,
      ids.wrongReceiptCall,
      ids.rawConsentCall,
      ids.outboundCall,
      ids.overRetentionCall,
      ids.predatesConsentCall,
    ];
    const deletions = await upgrade.query<{
      call_id: string;
      reason: string;
      actor: string;
      byte_length: string;
      sha256: string;
    }>(
      `SELECT call_id,reason,actor,byte_length::text,sha256
       FROM call_recording_deletions
       WHERE call_id=ANY($1::uuid[])
       ORDER BY call_id`,
      [purgedIds]
    );
    expect(deletions.rowCount).toBe(6);
    for (const deletion of deletions.rows) {
      expect(deletion).toMatchObject({
        reason: "user_deleted",
        actor: "migration_029_consent_authority_upgrade",
        byte_length: "3",
      });
      expect(deletion.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect((await upgrade.query(
      `SELECT count(*)::integer AS uncleared
       FROM calls WHERE id=ANY($1::uuid[]) AND recording_path IS NOT NULL`,
      [purgedIds]
    )).rows[0]?.uncleared).toBe(0);
  });

  it("rejects every post-upgrade receipt substitution and raw identifier", async () => {
    const base = {
      callId: ids.wrongReceiptCall,
      receipt: "b".repeat(64),
      grantedAt: receiptGrantedAt,
    };
    const insertSql = `INSERT INTO call_recordings(
        call_id,mime,data,consent_id,consent_receipt_hmac_sha256,
        consent_granted_at,consent_notice_version,retained_until,byte_length,sha256
      ) VALUES (
        $1,'audio/webm',decode('070809','hex'),$2,$3,$4,$5,
        $4::timestamptz + make_interval(days => $6),3,
        encode(digest(decode('070809','hex'),'sha256'),'hex')
      )`;
    await expect(upgrade.query(insertSql, [
      base.callId, null, base.receipt, base.grantedAt.toISOString(), "recording-v1", 7,
    ])).rejects.toThrow(/exact durable web consent receipt/);
    await expect(upgrade.query(insertSql, [
      ids.rawConsentCall,
      randomUUID(),
      "c".repeat(64),
      base.grantedAt.toISOString(),
      "recording-v1",
      7,
    ])).rejects.toThrow(/raw recording consent identifiers are forbidden/);
    await expect(upgrade.query(insertSql, [
      ids.outboundCall,
      null,
      "d".repeat(64),
      base.grantedAt.toISOString(),
      "recording-v1",
      7,
    ])).rejects.toThrow(/exact durable web consent receipt/);
    await expect(upgrade.query(insertSql, [
      ids.overRetentionCall,
      null,
      "e".repeat(64),
      base.grantedAt.toISOString(),
      "recording-v1",
      8,
    ])).rejects.toThrow(/retention exceeds/);
    await expect(upgrade.query(
      `INSERT INTO call_recordings(
         call_id,mime,data,created_at,consent_receipt_hmac_sha256,
         consent_granted_at,consent_notice_version,retained_until,byte_length,sha256
       ) VALUES (
         $1,'audio/webm',decode('070809','hex'),$2,$3,$4,'recording-v1',
         $4::timestamptz + interval '7 days',3,
         encode(digest(decode('070809','hex'),'sha256'),'hex')
       )`,
      [
        ids.predatesConsentCall,
        new Date(receiptGrantedAt.getTime() - 60 * 60_000).toISOString(),
        "f".repeat(64),
        receiptGrantedAt.toISOString(),
      ]
    )).rejects.toThrow(/predates its consent authority/);
    await expect(upgrade.query(
      `UPDATE call_recordings
       SET consent_receipt_hmac_sha256=$2 WHERE call_id=$1`,
      [ids.validCall, "b".repeat(64)]
    )).rejects.toThrow(/exact durable web consent receipt/);
  });

  it("reapplies 014, 024, and 029 without restoring audio or weakening authority", async () => {
    const before = (await upgrade.query<{
      recording_count: number;
      deletion_count: number;
      deletion_hash: string;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM call_recordings) AS recording_count,
         (SELECT count(*)::integer FROM call_recording_deletions
          WHERE actor='migration_029_consent_authority_upgrade') AS deletion_count,
         (SELECT encode(digest(string_agg(
             call_id::text || ':' || sha256, '' ORDER BY call_id
           ),'sha256'),'hex')
          FROM call_recording_deletions
          WHERE actor='migration_029_consent_authority_upgrade') AS deletion_hash`
    )).rows[0];
    await upgrade.query("BEGIN");
    try {
      await upgrade.query(migration014);
      await upgrade.query(migration024);
      await upgrade.query(migration029);
      await upgrade.query("COMMIT");
    } catch (error) {
      await upgrade.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    const after = (await upgrade.query(
      `SELECT
         (SELECT count(*)::integer FROM call_recordings) AS recording_count,
         (SELECT count(*)::integer FROM call_recording_deletions
          WHERE actor='migration_029_consent_authority_upgrade') AS deletion_count,
         (SELECT encode(digest(string_agg(
             call_id::text || ':' || sha256, '' ORDER BY call_id
           ),'sha256'),'hex')
          FROM call_recording_deletions
          WHERE actor='migration_029_consent_authority_upgrade') AS deletion_hash`
    )).rows[0];
    expect(after).toEqual(before);
    expect(after).toMatchObject({ recording_count: 1, deletion_count: 6 });
  });
});
