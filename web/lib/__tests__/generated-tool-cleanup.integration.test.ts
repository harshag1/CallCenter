import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sweepGeneratedToolCleanup } from "../toolfactory/cleanup";

const adminDatabaseUrl = process.env.SECURITY_MIGRATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(adminDatabaseUrl));

function databaseUrl(base: string, database: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

integration("generated-tool cleanup migration and lease lifecycle", () => {
  const database = `hacc_tool_cleanup_${randomUUID().replaceAll("-", "")}`;
  const orgId = randomUUID();
  const toolId = randomUUID();
  const keyId = "tik_abcdefghijklmnop";
  const project = "original-prefix-v2-aaaaaaaaaaaaaaaaaaaa";
  let admin: Pool;
  let target: Pool;
  let migration019: string;

  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("missing integration database URL");
    admin = new Pool({ connectionString: adminDatabaseUrl, ssl: false, max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
    target = new Pool({
      connectionString: databaseUrl(adminDatabaseUrl, database),
      ssl: false,
      max: 4,
    });
    const migrationsUrl = new URL("../../migrations/", import.meta.url);
    const names = (await readdir(migrationsUrl))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort();
    expect(names).toContain("019_generated_tool_cleanup.sql");
    expect(names).toContain("020_call_bound_runtime_authority.sql");
    expect(names.indexOf("019_generated_tool_cleanup.sql")).toBeGreaterThan(
      names.indexOf("018_campaign_dispatch_quarantine.sql")
    );
    for (const name of names) {
      const sql = await readFile(new URL(name, migrationsUrl), "utf8");
      await target.query("BEGIN");
      try {
        await target.query(sql);
        await target.query("COMMIT");
      } catch (error) {
        await target.query("ROLLBACK").catch(() => {});
        throw new Error(`fresh migration failed: ${name}`, { cause: error });
      }
    }
    migration019 = await readFile(
      new URL("019_generated_tool_cleanup.sql", migrationsUrl),
      "utf8"
    );
    await target.query("INSERT INTO orgs (id, name) VALUES ($1, 'Cleanup org')", [orgId]);
    await target.query(
      `INSERT INTO tools
        (id, org_id, slug, description, input_schema, kind, source_code,
         deploy_status, env_var_names, created_by)
       VALUES ($1,$2,'cleanup-tool','Cleanup tool','{}','edge',$3,'draft','{}','test')`,
      [toolId, orgId, "async function run(input, env) { return input; }"]
    );
    await target.query(
      `INSERT INTO tool_invocation_revisions
        (key_id, tool_id, public_key, private_key_encrypted, deployment_project,
         description, input_schema, source_code, env_var_names, created_by, status)
       VALUES ($1,$2,$3,$4,$5,'Cleanup tool','{}',$6,'{}','test','deploying')`,
      [
        keyId,
        toolId,
        "p".repeat(64),
        "e".repeat(64),
        project,
        "async function run(input, env) { return input; }",
      ]
    );
  }, 60_000);

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

  it("does not race a normal deploying revision and preserves state on migration reapply", async () => {
    const before = (await target.query<{
      status: string;
      reason_code: string;
      attempts: number;
      grace_seconds: number;
    }>(
      `SELECT status, reason_code, attempts,
              extract(epoch FROM (next_attempt_at - created_at))::integer AS grace_seconds
       FROM hacc_private.generated_tool_cleanup_jobs WHERE key_id = $1`,
      [keyId]
    )).rows[0];
    expect(before).toMatchObject({
      status: "cleanup_required",
      reason_code: "staging",
      attempts: 0,
    });
    expect(before.grace_seconds).toBeGreaterThanOrEqual(599);
    await expect(target.query(
      `SELECT key_id FROM hacc_private.generated_tool_cleanup_jobs
       WHERE key_id = $1 AND status = 'cleanup_required' AND next_attempt_at <= now()`,
      [keyId]
    )).resolves.toMatchObject({ rowCount: 0 });

    await target.query(
      `UPDATE hacc_private.generated_tool_cleanup_jobs
       SET attempts = 3, updated_at = now() WHERE key_id = $1`,
      [keyId]
    );
    await target.query(migration019);
    await expect(target.query(
      `SELECT status, reason_code, attempts
       FROM hacc_private.generated_tool_cleanup_jobs WHERE key_id = $1`,
      [keyId]
    )).resolves.toMatchObject({
      rows: [{ status: "cleanup_required", reason_code: "staging", attempts: 3 }],
    });
  });

  it("rejects cross-org aliasing of one account-global project", async () => {
    const otherOrg = randomUUID();
    const otherTool = randomUUID();
    await target.query("INSERT INTO orgs (id, name) VALUES ($1, 'Other cleanup org')", [otherOrg]);
    await target.query(
      `INSERT INTO tools
        (id, org_id, slug, description, input_schema, kind, source_code,
         deploy_status, env_var_names, created_by)
       VALUES ($1,$2,'other-tool','Other tool','{}','edge',$3,'draft','{}','test')`,
      [otherTool, otherOrg, "async function run(input, env) { return input; }"]
    );
    await expect(target.query(
      `INSERT INTO tool_invocation_revisions
        (key_id, tool_id, public_key, private_key_encrypted, deployment_project,
         description, input_schema, source_code, env_var_names, created_by, status)
       VALUES ('tik_ponmlkjihgfedcba',$1,$2,$3,$4,'Other tool','{}',$5,'{}','test','deploying')`,
      [
        otherTool,
        "p".repeat(64),
        "e".repeat(64),
        project,
        "async function run(input, env) { return input; }",
      ]
    )).rejects.toMatchObject({ code: "23505" });
    await expect(target.query(
      "SELECT 1 FROM tool_invocation_revisions WHERE key_id = 'tik_ponmlkjihgfedcba'"
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("claims a due project once across concurrent sweepers", async () => {
    await target.query(
      `UPDATE hacc_private.generated_tool_cleanup_jobs
       SET reason_code = 'deploy_failed', attempts = 0, next_attempt_at = now(), updated_at = now()
       WHERE key_id = $1`,
      [keyId]
    );
    const cleanupProject = vi.fn().mockResolvedValue(undefined);
    const query = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await target.query<T>(sql, params)).rows;
    const results = await Promise.all([
      sweepGeneratedToolCleanup(1, { query, cleanupProject }),
      sweepGeneratedToolCleanup(1, { query, cleanupProject }),
    ]);
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.cleaned, 0)).toBe(1);
    expect(cleanupProject).toHaveBeenCalledTimes(1);
    await expect(target.query(
      "SELECT status, attempts FROM hacc_private.generated_tool_cleanup_jobs WHERE key_id = $1",
      [keyId]
    )).resolves.toMatchObject({ rows: [{ status: "cleaned", attempts: 1 }] });
  });

  it("terminalizes an abandoned eighth claim instead of stranding it in cleaning", async () => {
    await target.query(
      `UPDATE hacc_private.generated_tool_cleanup_jobs
       SET status = 'cleaning', attempts = 8,
           claim_token = $2, claimed_at = now() - interval '6 minutes',
           claim_expires_at = now() - interval '1 minute', cleaned_at = NULL,
           updated_at = now()
       WHERE key_id = $1`,
      [keyId, randomUUID()]
    );
    const cleanupProject = vi.fn();
    const query = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await target.query<T>(sql, params)).rows;
    await expect(sweepGeneratedToolCleanup(1, { query, cleanupProject })).resolves.toEqual({
      claimed: 0,
      cleaned: 0,
      cleanupRequired: 0,
    });
    expect(cleanupProject).not.toHaveBeenCalled();
    await expect(target.query(
      `SELECT status, attempts, claim_token, last_error_code
       FROM hacc_private.generated_tool_cleanup_jobs WHERE key_id = $1`,
      [keyId]
    )).resolves.toMatchObject({
      rows: [{
        status: "cleanup_required",
        attempts: 8,
        claim_token: null,
        last_error_code: "provider_cleanup_failed",
      }],
    });
  });
});
