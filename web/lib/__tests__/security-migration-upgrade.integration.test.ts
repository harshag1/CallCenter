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

integration("security migration upgrade boundary", () => {
  const database = `hacc_security_upgrade_${randomUUID().replaceAll("-", "")}`;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const legacyMcpId = randomUUID();
  let admin: Pool;
  let target: Pool;
  let migration017 = "";

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

    const migrationsUrl = new URL("../../migrations/", import.meta.url);
    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort();
    const preUpgrade = migrationNames.filter((name) => name < "017_");
    for (const name of preUpgrade) {
      const sql = await readFile(new URL(name, migrationsUrl), "utf8");
      await target.query("BEGIN");
      try {
        await target.query(sql);
        await target.query("COMMIT");
      } catch (error) {
        await target.query("ROLLBACK").catch(() => {});
        throw new Error(`pre-upgrade migration failed: ${name}`, { cause: error });
      }
    }

    await target.query(
      `INSERT INTO orgs (id, name)
       VALUES ($1, 'Legacy security upgrade'), ($2, 'Unrelated tenant')`,
      [orgId, otherOrgId]
    );
    await target.query(
      `INSERT INTO users (email, org_id) VALUES ('legacy@example.test', $1)`,
      [orgId]
    );
    // Before 017, these are replayable session bytes and unbound legacy vault
    // ciphertext. They are fixtures proving the release upgrade policy.
    await target.query(
      `INSERT INTO sessions_auth (token, email, expires_at)
       VALUES ($1, 'legacy@example.test', now() + interval '1 day')`,
      ["ab".repeat(32)]
    );
    await target.query(
      `INSERT INTO env_vars (org_id, name, value_encrypted)
       VALUES ($1, 'LEGACY_API_KEY', 'legacy-unbound-ciphertext')`,
      [orgId]
    );
    await target.query(
      `INSERT INTO mcp_servers
         (id, org_id, label, server_url, auth_header_encrypted, allowed_tools)
       VALUES ($1, $2, 'Legacy MCP', 'https://legacy-mcp.example.test/api',
               'legacy-unbound-ciphertext', NULL)`,
      [legacyMcpId, orgId]
    );

    migration017 = await readFile(new URL("017_context_bound_credentials_and_auth_sessions.sql", migrationsUrl), "utf8");
    await target.query(migration017);
  }, 30_000);

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

  it("revokes pre-hash sessions and preserves a versioned hash-only replacement", async () => {
    await expect(target.query(
      "SELECT 1 FROM sessions_auth WHERE email = 'legacy@example.test'"
    )).resolves.toMatchObject({ rowCount: 0 });

    await expect(target.query(
      `INSERT INTO sessions_auth (token, email, org_id, expires_at)
       VALUES ($1, 'legacy@example.test', $2, now() + interval '1 day')`,
      ["ef".repeat(32), orgId]
    )).rejects.toMatchObject({ code: "23502" });

    await expect(target.query(
      `INSERT INTO sessions_auth
         (token, token_hash_version, email, org_id, expires_at)
       VALUES ('not-a-sha256-digest', 1, 'legacy@example.test', $1, now() + interval '1 day')`,
      [orgId]
    )).rejects.toMatchObject({ code: "23514" });

    await expect(target.query(
      `INSERT INTO sessions_auth
         (token, token_hash_version, email, org_id, expires_at)
       VALUES ($1, 1, 'legacy@example.test', $2, now() + interval '1 day')`,
      ["de".repeat(32), otherOrgId]
    )).rejects.toMatchObject({ code: "23503" });

    const digest = "cd".repeat(32);
    await target.query(
      `INSERT INTO sessions_auth
         (token, token_hash_version, email, org_id, expires_at)
       VALUES ($1, 1, 'legacy@example.test', $2, now() + interval '1 day')`,
      [digest, orgId]
    );
    await expect(target.query(
      "SELECT token, token_hash_version, org_id FROM sessions_auth WHERE token = $1",
      [digest]
    )).resolves.toMatchObject({
      rows: [{ token: digest, token_hash_version: 1, org_id: orgId }],
    });
  });

  it("quarantines existing legacy credentials while rejecting every new unbound write", async () => {
    await expect(target.query(
      `SELECT name FROM env_vars WHERE org_id = $1 AND name = 'LEGACY_API_KEY'`,
      [orgId]
    )).resolves.toMatchObject({ rows: [{ name: "LEGACY_API_KEY" }] });
    await expect(target.query(
      "SELECT id FROM mcp_servers WHERE id = $1",
      [legacyMcpId]
    )).resolves.toMatchObject({ rows: [{ id: legacyMcpId }] });

    await expect(target.query(
      `INSERT INTO env_vars (org_id, name, value_encrypted)
       VALUES ($1, 'NEW_LEGACY_KEY', 'legacy-unbound-ciphertext')`,
      [orgId]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(target.query(
      `INSERT INTO mcp_servers
         (id, org_id, label, server_url, auth_header_encrypted, allowed_tools)
       VALUES ($1, $2, 'New legacy MCP', 'https://new-legacy.example.test/api',
               'legacy-unbound-ciphertext', NULL)`,
      [randomUUID(), orgId]
    )).rejects.toMatchObject({ code: "23514" });

    const constraints = await target.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
       FROM pg_constraint
       WHERE conname IN ('env_vars_context_bound_ciphertext', 'mcp_auth_context_bound_ciphertext')
       ORDER BY conname`
    );
    expect(constraints.rows).toEqual([
      { conname: "env_vars_context_bound_ciphertext", convalidated: false },
      { conname: "mcp_auth_context_bound_ciphertext", convalidated: false },
    ]);
  });

  it("reapplies without revoking a versioned session or weakening the credential checks", async () => {
    await target.query(migration017);
    await expect(target.query(
      "SELECT token_hash_version FROM sessions_auth WHERE email = 'legacy@example.test'"
    )).resolves.toMatchObject({ rows: [{ token_hash_version: 1 }] });
    await expect(target.query(
      `INSERT INTO env_vars (org_id, name, value_encrypted)
       VALUES ($1, 'REAPPLY_LEGACY_KEY', 'legacy-unbound-ciphertext')`,
      [orgId]
    )).rejects.toMatchObject({ code: "23514" });
  });
});
