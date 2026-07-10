// Author: Harsha Gundala
// db.ts — Postgres pool (pinned Supabase CA, strict TLS) + query helper.

import { Pool, type QueryResultRow } from "pg";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const globalForDb = globalThis as unknown as { __pool?: Pool };

function makePool(): Pool {
  const connectionString = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error("DATABASE_URL or SUPABASE_DB_URL is required");
  const sslMode = process.env.DATABASE_SSL ?? (process.env.SUPABASE_DB_URL ? "verify-full" : "disable");
  const defaultCaPath = join(process.cwd(), "certs", "supabase-ca.crt");
  const ssl = sslMode === "disable"
    ? false
    : {
        rejectUnauthorized: true,
        ...(process.env.DATABASE_CA_CERT
          ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, "\n") }
          : existsSync(defaultCaPath) ? { ca: readFileSync(defaultCaPath, "utf8") } : {}),
      };
  return new Pool({
    connectionString,
    ssl,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}

export function getPool(): Pool {
  return globalForDb.__pool ?? (globalForDb.__pool = makePool());
}

export async function q<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as never[]);
  return res.rows;
}

export async function qOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}
