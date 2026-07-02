// Author: Harsha Gundala
// db.ts — Postgres pool (pinned Supabase CA, strict TLS) + query helper.

import { Pool, type QueryResultRow } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const globalForDb = globalThis as unknown as { __pool?: Pool };

function makePool(): Pool {
  const ca = readFileSync(join(process.cwd(), "certs", "supabase-ca.crt"), "utf8");
  return new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { ca },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}

export const pool: Pool = globalForDb.__pool ?? (globalForDb.__pool = makePool());

export async function q<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

export async function qOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}
