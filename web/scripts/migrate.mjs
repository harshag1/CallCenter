// Author: Harsha Gundala
// migrate.mjs — applies web/migrations/*.sql in order, tracked in _migrations.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveDatabaseSslMode } from "../lib/database-ssl.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const nonBlankEnvironmentValue = (value) => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};
const runtimeUrl = nonBlankEnvironmentValue(process.env.DATABASE_URL)
  ?? nonBlankEnvironmentValue(process.env.SUPABASE_DB_URL);
const migrationUrl = nonBlankEnvironmentValue(process.env.MIGRATION_DATABASE_URL);
const leastPrivilegeRequired = process.env.NODE_ENV === "production"
  || process.env.DATABASE_ENFORCE_LEAST_PRIVILEGE === "true";
if (leastPrivilegeRequired && !migrationUrl) {
  throw new Error("MIGRATION_DATABASE_URL is required for production/least-privilege migrations");
}
const url = migrationUrl ?? runtimeUrl;
if (!url) throw new Error("MIGRATION_DATABASE_URL is not set (local development may fall back to DATABASE_URL or SUPABASE_DB_URL)");
if (leastPrivilegeRequired && runtimeUrl && url === runtimeUrl) {
  throw new Error("MIGRATION_DATABASE_URL must not reuse the application runtime connection string");
}

const sslMode = resolveDatabaseSslMode({
  connectionString: url,
  configuredMode: process.env.DATABASE_SSL,
  nodeEnv: process.env.NODE_ENV,
});
const caPath = join(root, "certs", "supabase-ca.crt");
const ssl = sslMode === "disable"
  ? false
  : {
      rejectUnauthorized: true,
      ...(process.env.DATABASE_CA_CERT
        ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, "\n") }
        : existsSync(caPath) ? { ca: readFileSync(caPath, "utf8") } : {}),
    };
const client = new pg.Client({ connectionString: url, ssl });
await client.connect();
const identity = (await client.query(
  `SELECT current_user,
          (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
          (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
          EXISTS (
            SELECT 1 FROM pg_auth_members membership
            JOIN pg_roles member ON member.oid = membership.member
            JOIN pg_roles granted ON granted.oid = membership.roleid
            WHERE member.rolname = current_user AND granted.rolname = 'hacc_backend'
          ) AS backend_member,
          EXISTS (
            SELECT 1 FROM pg_auth_members membership
            JOIN pg_roles member ON member.oid = membership.member
            JOIN pg_roles granted ON granted.oid = membership.roleid
            WHERE member.rolname = current_user AND granted.rolname = 'hacc_worker'
          ) AS worker_member`
)).rows[0];
if (
  identity.current_user === "hacc_runtime"
  || identity.current_user === "hacc_worker_runtime"
  || identity.backend_member
  || identity.worker_member
) {
  await client.end();
  throw new Error("migration connection must be a separate DDL owner, never an application or scheduler runtime role");
}
await client.query("CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
const applied = new Set((await client.query("SELECT name FROM _migrations")).rows.map((r) => r.name));

for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(f)) continue;
  process.stdout.write(`applying ${f}... `);
  await client.query("BEGIN");
  try {
    await client.query(readFileSync(join(dir, f), "utf8"));
    await client.query("INSERT INTO _migrations (name) VALUES ($1)", [f]);
    await client.query("COMMIT");
    console.log("ok");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("FAILED", e.message);
    process.exit(1);
  }
}
await client.end();
console.log("migrations up to date");
