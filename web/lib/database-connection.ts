import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDatabaseSslMode } from "./database-ssl.mjs";

export type DatabaseConnectionConfig = Readonly<{
  connectionString: string;
  ssl: false | Readonly<{
    rejectUnauthorized: true;
    ca?: string;
  }>;
}>;

type DatabaseConnectionEnvironment = Readonly<{
  DATABASE_URL?: string;
  SUPABASE_DB_URL?: string;
  DATABASE_SSL?: string;
  DATABASE_CA_CERT?: string;
  NODE_ENV?: string;
}>;

type DatabaseConnectionInput = Readonly<{
  databaseUrl?: string;
  supabaseDatabaseUrl?: string;
  configuredMode?: string;
  databaseCaCert?: string;
  defaultSupabaseCaCert?: string;
  nodeEnv?: string;
}>;

function normalizedCa(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.replace(/\\n/g, "\n");
}

/**
 * Resolve a pg connection without allowing connection-string parameters to
 * weaken transport security. DATABASE_URL has the same precedence as the
 * application pool; SUPABASE_DB_URL remains a backwards-compatible fallback.
 *
 * The bundled Supabase CA is applied only when the Supabase-specific fallback
 * is selected. A stock DATABASE_URL can therefore use the platform trust store
 * (or DATABASE_CA_CERT) instead of being accidentally pinned to Supabase.
 */
export function resolveDatabaseConnectionConfig(
  input: DatabaseConnectionInput,
): DatabaseConnectionConfig {
  const usesStandardUrl = input.databaseUrl !== undefined;
  const connectionString = usesStandardUrl
    ? input.databaseUrl
    : input.supabaseDatabaseUrl;
  if (!connectionString) {
    throw new Error("DATABASE_URL or SUPABASE_DB_URL is required");
  }

  const sslMode = resolveDatabaseSslMode({
    connectionString,
    configuredMode: input.configuredMode,
    nodeEnv: input.nodeEnv,
  });
  if (sslMode === "disable") {
    return Object.freeze({ connectionString, ssl: false });
  }

  const ca = normalizedCa(input.databaseCaCert)
    ?? (!usesStandardUrl ? normalizedCa(input.defaultSupabaseCaCert) : undefined);
  return Object.freeze({
    connectionString,
    ssl: Object.freeze({
      rejectUnauthorized: true,
      ...(ca === undefined ? {} : { ca }),
    }),
  });
}

/**
 * Load the process-level database configuration for both pooled queries and
 * dedicated connections such as PostgreSQL LISTEN clients.
 */
export function loadDatabaseConnectionConfig(
  env: DatabaseConnectionEnvironment = process.env,
  cwd = process.cwd(),
): DatabaseConnectionConfig {
  const usesSupabaseFallback = env.DATABASE_URL === undefined
    && env.SUPABASE_DB_URL !== undefined;
  const defaultCaPath = join(cwd, "certs", "supabase-ca.crt");
  const defaultSupabaseCaCert = usesSupabaseFallback && existsSync(defaultCaPath)
    ? readFileSync(defaultCaPath, "utf8")
    : undefined;

  return resolveDatabaseConnectionConfig({
    databaseUrl: env.DATABASE_URL,
    supabaseDatabaseUrl: env.SUPABASE_DB_URL,
    configuredMode: env.DATABASE_SSL,
    databaseCaCert: env.DATABASE_CA_CERT,
    defaultSupabaseCaCert,
    nodeEnv: env.NODE_ENV,
  });
}
