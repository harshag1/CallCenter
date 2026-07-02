// Author: Harsha Gundala
// migrate.mjs — applies web/migrations/*.sql in order, tracked in _migrations.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error("SUPABASE_DB_URL not set");

const ca = readFileSync(join(root, "certs", "supabase-ca.crt"), "utf8");
const client = new pg.Client({ connectionString: url, ssl: { ca } });
await client.connect();
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
