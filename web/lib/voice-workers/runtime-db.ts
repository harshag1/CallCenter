import "server-only";

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { resolveDatabaseConnectionConfig } from "../database-connection";

const SAFE_ROLE = /^[a-z][a-z0-9_]{0,62}$/;

type WorkerPool = Readonly<{
  connect(): Promise<PoolClient>;
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
}>;

export type WorkerRuntimeRoleInspection = Readonly<{
  current_user: string;
  superuser: boolean;
  bypassrls: boolean;
  voice_worker_member: boolean;
  dialer_worker_member: boolean;
  backend_member: boolean;
  unexpected_inherited_roles: readonly string[];
  has_direct_application_grants: boolean;
  inherits_application_owner: boolean;
}>;

const globalForWorkerDb = globalThis as unknown as {
  __voiceWorkerPool?: Pool;
  __safeVoiceWorkerPool?: WorkerPool;
  __voiceWorkerRoleCheck?: Promise<void>;
};

export function assertSafeWorkerRuntimeRole(
  inspection: WorkerRuntimeRoleInspection,
  expectedRole: string,
): void {
  if (!SAFE_ROLE.test(expectedRole)) {
    throw new Error("WORKER_DATABASE_RUNTIME_ROLE must be a lowercase PostgreSQL identifier");
  }
  if (
    inspection.current_user !== expectedRole
    || inspection.superuser
    || inspection.bypassrls
    || !inspection.voice_worker_member
    || inspection.dialer_worker_member
    || inspection.backend_member
    || inspection.unexpected_inherited_roles.length > 0
    || inspection.has_direct_application_grants
    || inspection.inherits_application_owner
  ) {
    throw new Error(
      "worker database runtime is not the expected isolated hacc_voice_worker member",
    );
  }
}

function makeWorkerPool(): Pool {
  const workerUrl = process.env.WORKER_DATABASE_URL;
  if (!workerUrl) {
    throw new Error(
      "WORKER_DATABASE_URL is required for durable governed-worker execution",
    );
  }
  const { connectionString, ssl } = resolveDatabaseConnectionConfig({
    databaseUrl: workerUrl,
    configuredMode: process.env.DATABASE_SSL,
    databaseCaCert: process.env.DATABASE_CA_CERT,
    nodeEnv: process.env.NODE_ENV,
  });
  return new Pool({
    connectionString,
    ssl,
    max: 3,
    idleTimeoutMillis: 30_000,
  });
}

function rawWorkerPool(): Pool {
  return globalForWorkerDb.__voiceWorkerPool
    ?? (globalForWorkerDb.__voiceWorkerPool = makeWorkerPool());
}

async function ensureSafeWorkerRuntimeRole(): Promise<void> {
  if (!globalForWorkerDb.__voiceWorkerRoleCheck) {
    globalForWorkerDb.__voiceWorkerRoleCheck = (async () => {
      const expectedRole = process.env.WORKER_DATABASE_RUNTIME_ROLE
        ?? "hacc_voice_worker_runtime";
      if (!SAFE_ROLE.test(expectedRole)) {
        throw new Error(
          "WORKER_DATABASE_RUNTIME_ROLE must be a lowercase PostgreSQL identifier",
        );
      }
      const result = await rawWorkerPool().query<WorkerRuntimeRoleInspection>(
        `SELECT current_user,
                current_role.rolsuper AS superuser,
                current_role.rolbypassrls AS bypassrls,
                pg_has_role(current_user, 'hacc_voice_worker', 'member') AS voice_worker_member,
                pg_has_role(current_user, 'hacc_worker', 'member') AS dialer_worker_member,
                pg_has_role(current_user, 'hacc_backend', 'member') AS backend_member,
                COALESCE(ARRAY(
                  SELECT inherited.rolname::text
                  FROM pg_roles inherited
                  WHERE inherited.rolname <> current_user
                    AND inherited.rolname <> 'hacc_voice_worker'
                    AND pg_has_role(current_user, inherited.oid, 'member')
                  ORDER BY inherited.rolname
                ), ARRAY[]::text[]) AS unexpected_inherited_roles,
                EXISTS (
                  SELECT 1
                  FROM pg_class object
                  JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
                  CROSS JOIN LATERAL aclexplode(object.relacl) acl
                  WHERE object.relacl IS NOT NULL
                    AND namespace.nspname IN ('public','hacc_private','agent_data')
                    AND acl.grantee = current_role.oid
                  UNION ALL
                  SELECT 1
                  FROM pg_namespace namespace
                  CROSS JOIN LATERAL aclexplode(namespace.nspacl) acl
                  WHERE namespace.nspacl IS NOT NULL
                    AND namespace.nspname IN ('public','hacc_private','agent_data')
                    AND acl.grantee = current_role.oid
                  UNION ALL
                  SELECT 1
                  FROM pg_proc procedure
                  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
                  CROSS JOIN LATERAL aclexplode(procedure.proacl) acl
                  WHERE procedure.proacl IS NOT NULL
                    AND namespace.nspname IN ('public','hacc_private','agent_data')
                    AND acl.grantee = current_role.oid
                ) AS has_direct_application_grants,
                EXISTS (
                  SELECT 1
                  FROM pg_class application_table
                  JOIN pg_namespace namespace ON namespace.oid = application_table.relnamespace
                  WHERE application_table.relkind IN ('r','p')
                    AND namespace.nspname IN ('public','hacc_private','agent_data')
                    AND application_table.relname <> '_migrations'
                    AND pg_has_role(
                      current_user,
                      application_table.relowner,
                      'member'
                    )
                ) AS inherits_application_owner
         FROM pg_roles current_role
         WHERE current_role.rolname = current_user`,
      );
      const inspection = result.rows[0];
      if (!inspection) {
        throw new Error("worker database role inspection returned no row");
      }
      assertSafeWorkerRuntimeRole(inspection, expectedRole);
    })();
  }
  return globalForWorkerDb.__voiceWorkerRoleCheck;
}

function workerPool(): WorkerPool {
  if (!globalForWorkerDb.__safeVoiceWorkerPool) {
    const raw = rawWorkerPool();
    globalForWorkerDb.__safeVoiceWorkerPool = Object.freeze({
      async connect() {
        await ensureSafeWorkerRuntimeRole();
        return raw.connect();
      },
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        params: unknown[] = [],
      ) {
        await ensureSafeWorkerRuntimeRole();
        return raw.query<T>(text, params as never[]);
      },
      end() {
        return raw.end();
      },
    });
  }
  return globalForWorkerDb.__safeVoiceWorkerPool;
}

export async function workerQ<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await workerPool().query<T>(text, params);
  return result.rows;
}

export async function workerQOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await workerQ<T>(text, params);
  return rows[0] ?? null;
}
