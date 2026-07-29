import { randomUUID } from "node:crypto";
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

async function rejectWithCode(
  pool: Pool,
  sql: string,
  params: readonly unknown[],
  code: string,
) {
  try {
    await pool.query(sql, [...params]);
    throw new Error(`expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

integration("outbound speech ASR authority migration", () => {
  const database = `hacc_asr_authority_${randomUUID().replaceAll("-", "")}`;
  const ids = {
    org: randomUUID(),
    otherOrg: randomUUID(),
    agent: randomUUID(),
    call: randomUUID(),
    authority: randomUUID(),
    claim: randomUUID(),
  };
  const claimedAt = "2026-07-28T20:00:00.000Z";
  const dispatchedAt = "2026-07-28T20:00:01.000Z";
  const terminalAt = "2026-07-28T20:00:02.000Z";
  const audioBytes = 96_000;
  const sampleRateHz = 24_000;
  const audioDurationMs = audioBytes * 500 / sampleRateHz;
  let admin: Pool;
  let target: Pool;
  let migration041 = "";

  async function insertClaimed(overrides: Readonly<Record<string, unknown>> = {}) {
    const row = {
      org_id: ids.org,
      call_id: ids.call,
      response_id: `response-${randomUUID()}`,
      authority_id: randomUUID(),
      provider: "openai",
      audio_sha256: "a".repeat(64),
      audio_bytes: audioBytes,
      sample_rate_hz: sampleRateHz,
      audio_duration_ms: audioDurationMs,
      reserved_micro_usd: 6000,
      funding_source: "tenant_openai_byok",
      claim_token: randomUUID(),
      state: "claimed",
      receipt_json: null,
      dispatched_at: null,
      terminal_at: null,
      failure_code: null,
      claimed_at: claimedAt,
      updated_at: claimedAt,
      ...overrides,
    };
    await target.query(
      `INSERT INTO hacc_private.outbound_speech_asr_authorities (
         org_id, call_id, response_id, authority_id, provider, audio_sha256,
         audio_bytes, sample_rate_hz, audio_duration_ms, reserved_micro_usd,
         funding_source, claim_token, state, receipt_json, dispatched_at,
         terminal_at, failure_code, claimed_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
       )`,
      [
        row.org_id,
        row.call_id,
        row.response_id,
        row.authority_id,
        row.provider,
        row.audio_sha256,
        row.audio_bytes,
        row.sample_rate_hz,
        row.audio_duration_ms,
        row.reserved_micro_usd,
        row.funding_source,
        row.claim_token,
        row.state,
        row.receipt_json,
        row.dispatched_at,
        row.terminal_at,
        row.failure_code,
        row.claimed_at,
        row.updated_at,
      ],
    );
    return row;
  }

  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("missing integration database URL");
    if (!/^[a-z0-9_]+$/.test(database)) throw new Error("unsafe disposable database name");
    admin = new Pool({ connectionString: adminDatabaseUrl, ssl: false, max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
    target = new Pool({
      connectionString: databaseUrl(adminDatabaseUrl, database),
      ssl: false,
      max: 2,
    });
    await target.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await target.query("CREATE EXTENSION IF NOT EXISTS vector");

    const migrationsUrl = new URL("../../migrations/", import.meta.url);
    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort();
    expect(migrationNames).toContain("041_outbound_speech_asr_authority.sql");
    for (const name of migrationNames) {
      const sql = await readFile(new URL(name, migrationsUrl), "utf8");
      await target.query("BEGIN");
      try {
        await target.query(sql);
        await target.query("COMMIT");
      } catch (error) {
        await target.query("ROLLBACK").catch(() => undefined);
        throw new Error(`migration failed: ${name}`, { cause: error });
      }
      if (name === "041_outbound_speech_asr_authority.sql") migration041 = sql;
    }

    await target.query(
      `INSERT INTO public.orgs (id, name)
       VALUES ($1, 'ASR authority tenant'), ($2, 'Unrelated tenant')`,
      [ids.org, ids.otherOrg],
    );
    await target.query(
      `INSERT INTO public.agents (id, org_id, name)
       VALUES ($1, $2, 'ASR authority agent')`,
      [ids.agent, ids.org],
    );
    await target.query(
      `INSERT INTO public.calls (id, agent_id, agent_version, direction)
       VALUES ($1, $2, 1, 'web')`,
      [ids.call, ids.agent],
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

  it("installs a private, indexed, cascading authority boundary", async () => {
    const boundary = (await target.query<{
      row_security: boolean;
      force_row_security: boolean;
      backend_policy: boolean;
      owner_policy: boolean;
      backend_read_write: boolean;
      backend_delete: boolean;
      api_access: boolean;
      cascading_foreign_keys: number;
      unresolved_index: boolean;
      call_index: boolean;
      org_day_index: boolean;
    }>(
      `SELECT
         relation.relrowsecurity AS row_security,
         relation.relforcerowsecurity AS force_row_security,
         EXISTS (
           SELECT 1 FROM pg_policies policy
           WHERE policy.schemaname = 'hacc_private'
             AND policy.tablename = 'outbound_speech_asr_authorities'
             AND policy.policyname = 'hacc_backend_all'
             AND policy.roles = ARRAY['hacc_backend']::name[]
             AND policy.qual = 'true'
             AND policy.with_check = 'true'
         ) AS backend_policy,
         EXISTS (
           SELECT 1 FROM pg_policies policy
           WHERE policy.schemaname = 'hacc_private'
             AND policy.tablename = 'outbound_speech_asr_authorities'
             AND policy.policyname = 'hacc_migration_owner_all'
             AND policy.roles = ARRAY[current_user]::name[]
             AND policy.qual = 'true'
             AND policy.with_check = 'true'
         ) AS owner_policy,
         has_table_privilege(
           'hacc_backend',
           'hacc_private.outbound_speech_asr_authorities',
           'SELECT'
         )
         AND has_table_privilege(
           'hacc_backend',
           'hacc_private.outbound_speech_asr_authorities',
           'INSERT'
         )
         AND has_table_privilege(
           'hacc_backend',
           'hacc_private.outbound_speech_asr_authorities',
           'UPDATE'
         ) AS backend_read_write,
         has_table_privilege(
           'hacc_backend',
           'hacc_private.outbound_speech_asr_authorities',
           'DELETE'
         )
         OR has_table_privilege(
           'hacc_backend',
           'hacc_private.outbound_speech_asr_authorities',
           'TRUNCATE'
         ) AS backend_delete,
         EXISTS (
           SELECT 1
           FROM pg_roles api_role
           WHERE api_role.rolname = ANY(
             ARRAY['anon', 'authenticated', 'service_role', 'hacc_worker']
           )
             AND (
               has_table_privilege(
                 api_role.oid,
                 'hacc_private.outbound_speech_asr_authorities',
                 'SELECT'
               )
               OR has_table_privilege(
                 api_role.oid,
                 'hacc_private.outbound_speech_asr_authorities',
                 'INSERT'
               )
               OR has_table_privilege(
                 api_role.oid,
                 'hacc_private.outbound_speech_asr_authorities',
                 'UPDATE'
               )
               OR has_table_privilege(
                 api_role.oid,
                 'hacc_private.outbound_speech_asr_authorities',
                 'DELETE'
               )
             )
         ) AS api_access,
         (
           SELECT count(*)::integer
           FROM pg_constraint constraint_catalog
           WHERE constraint_catalog.conrelid =
             'hacc_private.outbound_speech_asr_authorities'::regclass
             AND constraint_catalog.contype = 'f'
             AND constraint_catalog.confdeltype = 'c'
         ) AS cascading_foreign_keys,
         to_regclass(
           'hacc_private.idx_outbound_speech_asr_authorities_unresolved'
         ) IS NOT NULL AS unresolved_index,
         to_regclass(
           'hacc_private.idx_outbound_speech_asr_authorities_call'
         ) IS NOT NULL AS call_index,
         to_regclass(
           'hacc_private.idx_outbound_speech_asr_authorities_org_day'
         ) IS NOT NULL AS org_day_index
       FROM pg_class relation
       WHERE relation.oid =
         'hacc_private.outbound_speech_asr_authorities'::regclass`,
    )).rows[0];

    expect(boundary).toEqual({
      row_security: true,
      force_row_security: true,
      backend_policy: true,
      owner_policy: true,
      backend_read_write: true,
      backend_delete: false,
      api_access: false,
      cascading_foreign_keys: 2,
      unresolved_index: true,
      call_index: true,
      org_day_index: true,
    });

    await target.query("BEGIN");
    try {
      await target.query("SET LOCAL ROLE hacc_backend");
      await target.query(
        `INSERT INTO hacc_private.outbound_speech_asr_authorities (
           org_id, call_id, response_id, authority_id, provider, audio_sha256,
           audio_bytes, sample_rate_hz, audio_duration_ms, reserved_micro_usd,
           funding_source, claim_token, claimed_at, updated_at
         ) VALUES (
           $1,$2,'response-backend-policy',$3,'xai',$4,$5,$6,$7,6000,
           'tenant_openai_byok',$8,$9,$9
         )`,
        [
          ids.org,
          ids.call,
          randomUUID(),
          "d".repeat(64),
          audioBytes,
          sampleRateHz,
          audioDurationMs,
          randomUUID(),
          claimedAt,
        ],
      );
      await expect(target.query(
        `SELECT state
         FROM hacc_private.outbound_speech_asr_authorities
         WHERE response_id = 'response-backend-policy'`,
      )).resolves.toMatchObject({ rows: [{ state: "claimed" }] });
      await rejectWithCode(
        target,
        `DELETE FROM hacc_private.outbound_speech_asr_authorities
         WHERE response_id = 'response-backend-policy'`,
        [],
        "42501",
      );
    } finally {
      await target.query("ROLLBACK");
    }
  });

  it("binds a single funded claim to exact PCM and the call's tenant", async () => {
    const valid = await insertClaimed({
      response_id: "response-exact-pcm",
      authority_id: ids.authority,
      claim_token: ids.claim,
    });
    await expect(target.query(
      `SELECT provider, audio_sha256, audio_bytes, sample_rate_hz,
              audio_duration_ms::text, reserved_micro_usd, funding_source, state
       FROM hacc_private.outbound_speech_asr_authorities
       WHERE authority_id = $1`,
      [ids.authority],
    )).resolves.toMatchObject({
      rows: [{
        provider: "openai",
        audio_sha256: "a".repeat(64),
        audio_bytes: audioBytes,
        sample_rate_hz: sampleRateHz,
        audio_duration_ms: "2000.000000",
        reserved_micro_usd: 6000,
        funding_source: "tenant_openai_byok",
        state: "claimed",
      }],
    });

    await rejectWithCode(
      target,
      `INSERT INTO hacc_private.outbound_speech_asr_authorities (
         org_id, call_id, response_id, authority_id, provider, audio_sha256,
         audio_bytes, sample_rate_hz, audio_duration_ms, reserved_micro_usd,
         funding_source, claim_token, claimed_at, updated_at
       ) VALUES ($1,$2,$3,$4,'openai',$5,$6,$7,$8,6000,'tenant_openai_byok',$9,$10,$10)`,
      [
        ids.otherOrg,
        ids.call,
        "response-wrong-tenant",
        randomUUID(),
        "b".repeat(64),
        audioBytes,
        sampleRateHz,
        audioDurationMs,
        randomUUID(),
        claimedAt,
      ],
      "23514",
    );
    await rejectWithCode(
      target,
      `INSERT INTO hacc_private.outbound_speech_asr_authorities (
         org_id, call_id, response_id, authority_id, provider, audio_sha256,
         audio_bytes, sample_rate_hz, audio_duration_ms, reserved_micro_usd,
         funding_source, claim_token, claimed_at, updated_at
       ) VALUES ($1,$2,$3,$4,'openai',$5,$6,$7,$8,6000,'tenant_openai_byok',$9,$10,$10)`,
      [
        ids.org,
        ids.call,
        "response-duplicate-authority",
        valid.authority_id,
        "b".repeat(64),
        audioBytes,
        sampleRateHz,
        audioDurationMs,
        randomUUID(),
        claimedAt,
      ],
      "23505",
    );
    await rejectWithCode(
      target,
      `INSERT INTO hacc_private.outbound_speech_asr_authorities (
         org_id, call_id, response_id, authority_id, provider, audio_sha256,
         audio_bytes, sample_rate_hz, audio_duration_ms, reserved_micro_usd,
         funding_source, claim_token, claimed_at, updated_at
       ) VALUES ($1,$2,$3,$4,'openai',$5,$6,$7,$8,6000,'tenant_openai_byok',$9,$10,$10)`,
      [
        ids.org,
        ids.call,
        "response-duplicate-claim",
        randomUUID(),
        "b".repeat(64),
        audioBytes,
        sampleRateHz,
        audioDurationMs,
        valid.claim_token,
        claimedAt,
      ],
      "23505",
    );
  });

  it("rejects ambiguous audio, spend, receipt, and lifecycle shapes", async () => {
    const invalidRows = [
      { audio_sha256: "A".repeat(64) },
      { audio_bytes: 95_999 },
      { audio_bytes: 16_777_218, audio_duration_ms: 349_525.375 },
      { sample_rate_hz: 22_050, audio_duration_ms: audioBytes * 500 / 22_050 },
      { audio_duration_ms: audioDurationMs + 0.01 },
      { reserved_micro_usd: 5000 },
      { reserved_micro_usd: 12_001 },
      { funding_source: "unbounded_platform_credit" },
      { receipt_json: { text: "not settled" } },
      {
        state: "failed",
        dispatched_at: dispatchedAt,
        terminal_at: terminalAt,
        failure_code: "provider_outcome_unknown",
        updated_at: terminalAt,
      },
      {
        state: "indeterminate",
        dispatched_at: dispatchedAt,
        terminal_at: terminalAt,
        failure_code: "local_failure",
        updated_at: terminalAt,
      },
    ];
    for (const overrides of invalidRows) {
      try {
        await insertClaimed(overrides);
        throw new Error(`invalid ASR authority was admitted: ${JSON.stringify(overrides)}`);
      } catch (error) {
        expect(error).toMatchObject({ code: "23514" });
      }
    }

    const directSettlement = await insertClaimed({
      response_id: "response-direct-settlement",
    });
    await rejectWithCode(
      target,
      `UPDATE hacc_private.outbound_speech_asr_authorities
       SET state = 'settled',
           dispatched_at = $4,
           terminal_at = $5,
           receipt_json = '{"schemaVersion":1}'::jsonb,
           updated_at = $5
       WHERE org_id = $1 AND call_id = $2 AND response_id = $3`,
      [
        ids.org,
        ids.call,
        directSettlement.response_id,
        dispatchedAt,
        terminalAt,
      ],
      "P0001",
    );
  });

  it("permits only a monotonic dispatched-to-terminal transition", async () => {
    const row = await insertClaimed({
      response_id: "response-settled",
    });
    await target.query(
      `UPDATE hacc_private.outbound_speech_asr_authorities
       SET state = 'dispatched',
           dispatched_at = $4,
           updated_at = $4
       WHERE org_id = $1 AND call_id = $2 AND response_id = $3`,
      [ids.org, ids.call, row.response_id, dispatchedAt],
    );
    await target.query(
      `UPDATE hacc_private.outbound_speech_asr_authorities
       SET state = 'settled',
           terminal_at = $4,
           receipt_json = $5,
           updated_at = $4
       WHERE org_id = $1 AND call_id = $2 AND response_id = $3`,
      [
        ids.org,
        ids.call,
        row.response_id,
        terminalAt,
        JSON.stringify({
          schemaVersion: 1,
          audioSha256: row.audio_sha256,
          receiptSha256: "c".repeat(64),
        }),
      ],
    );

    await rejectWithCode(
      target,
      `UPDATE hacc_private.outbound_speech_asr_authorities
       SET state = 'failed',
           receipt_json = NULL,
           failure_code = 'late_relabel',
           updated_at = $4
       WHERE org_id = $1 AND call_id = $2 AND response_id = $3`,
      [ids.org, ids.call, row.response_id, "2026-07-28T20:00:03.000Z"],
      "P0001",
    );
    await rejectWithCode(
      target,
      `UPDATE hacc_private.outbound_speech_asr_authorities
       SET reserved_micro_usd = 12000,
           updated_at = $4
       WHERE org_id = $1 AND call_id = $2 AND response_id = $3`,
      [ids.org, ids.call, row.response_id, "2026-07-28T20:00:03.000Z"],
      "P0001",
    );
  });

  it("reapplies without rewriting a terminal authority or reopening grants", async () => {
    expect(migration041).not.toBe("");
    const before = (await target.query<{ snapshot: string }>(
      `SELECT row_to_json(authority)::text AS snapshot
       FROM (
         SELECT *
         FROM hacc_private.outbound_speech_asr_authorities
         WHERE response_id = 'response-settled'
       ) authority`,
    )).rows[0]?.snapshot;
    expect(before).toBeTruthy();

    await target.query(migration041);

    const after = (await target.query<{ snapshot: string }>(
      `SELECT row_to_json(authority)::text AS snapshot
       FROM (
         SELECT *
         FROM hacc_private.outbound_speech_asr_authorities
         WHERE response_id = 'response-settled'
       ) authority`,
    )).rows[0]?.snapshot;
    expect(after).toBe(before);
    expect(await target.query(
      `SELECT COALESCE((
         SELECT has_table_privilege(
           api_role.oid,
           'hacc_private.outbound_speech_asr_authorities',
           'SELECT'
         )
         FROM pg_roles api_role
         WHERE api_role.rolname = 'service_role'
       ), false) AS service_can_read`,
    )).toMatchObject({ rows: [{ service_can_read: false }] });
  });
});
