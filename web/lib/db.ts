// Author: Harsha Gundala
// db.ts — Postgres pool (verified TLS, optional custom/Supabase CA) + query helper.

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { loadDatabaseConnectionConfig } from "./database-connection";

const SAFE_ROLE = /^[a-z][a-z0-9_]{0,62}$/;

const globalForDb = globalThis as unknown as {
  __pool?: Pool;
  __safePool?: SafeDatabasePool;
  __databaseRuntimeRoleCheck?: Promise<void>;
};

export type SafeDatabasePool = Readonly<{
  connect(): Promise<PoolClient>;
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
}>;

export type DatabaseRuntimeRoleInspection = Readonly<{
  current_user: string;
  superuser: boolean;
  bypassrls: boolean;
  backend_member: boolean;
  worker_member: boolean;
  /** Every inherited role except the one exact application capability role. */
  unexpected_inherited_roles: readonly string[];
  /** Runtime authority must arrive through hacc_backend, never direct ACLs. */
  has_direct_application_grants: boolean;
  inherits_application_owner: boolean;
}>;

export function assertSafeDatabaseRuntimeRole(
  inspection: DatabaseRuntimeRoleInspection,
  expectedRole: string
): void {
  if (!SAFE_ROLE.test(expectedRole)) {
    throw new Error("DATABASE_RUNTIME_ROLE must be a lowercase PostgreSQL identifier");
  }
  if (
    inspection.current_user !== expectedRole
    || inspection.superuser
    || inspection.bypassrls
    || !inspection.backend_member
    || inspection.worker_member
    || inspection.unexpected_inherited_roles.length > 0
    || inspection.has_direct_application_grants
    || inspection.inherits_application_owner
  ) {
    throw new Error(
      "database runtime role is not the expected non-owner, non-bypass hacc_backend member"
    );
  }
}

function enforceLeastPrivilegeDatabaseRole(): boolean {
  return process.env.NODE_ENV === "production"
    || process.env.DATABASE_ENFORCE_LEAST_PRIVILEGE === "true";
}

function makePool(): Pool {
  const { connectionString, ssl } = loadDatabaseConnectionConfig();
  return new Pool({
    connectionString,
    ssl,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}

function getRawPool(): Pool {
  return globalForDb.__pool ?? (globalForDb.__pool = makePool());
}

/**
 * Wrap every query and transaction checkout in the same role audit. Keeping
 * the raw pg Pool private prevents direct `connect()` call sites from silently
 * bypassing the q()/qOne() guard.
 */
export function createSafeDatabasePool(
  rawPool: Pool,
  ensureSafeRole: () => Promise<void>
): SafeDatabasePool {
  return Object.freeze({
    async connect() {
      await ensureSafeRole();
      return rawPool.connect();
    },
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
      await ensureSafeRole();
      return rawPool.query<T>(text, params as never[]);
    },
    end() {
      return rawPool.end();
    },
  });
}

export function getPool(): SafeDatabasePool {
  if (!globalForDb.__safePool) {
    globalForDb.__safePool = createSafeDatabasePool(getRawPool(), ensureSafeDatabaseRuntimeRole);
  }
  return globalForDb.__safePool;
}

export async function ensureSafeDatabaseRuntimeRole(): Promise<void> {
  if (!enforceLeastPrivilegeDatabaseRole()) return;
  if (!globalForDb.__databaseRuntimeRoleCheck) {
    globalForDb.__databaseRuntimeRoleCheck = (async () => {
      const expectedRole = process.env.DATABASE_RUNTIME_ROLE ?? "hacc_runtime";
      if (!SAFE_ROLE.test(expectedRole)) {
        throw new Error("DATABASE_RUNTIME_ROLE must be a lowercase PostgreSQL identifier");
      }
      // Use the private raw pool for the inspection itself; the public pool
      // waits on this promise and therefore cannot recurse or race it.
      const result = await getRawPool().query<DatabaseRuntimeRoleInspection>(
        `SELECT current_user,
                current_role.rolsuper AS superuser,
                current_role.rolbypassrls AS bypassrls,
                pg_has_role(current_user, 'hacc_backend', 'member') AS backend_member,
                pg_has_role(current_user, 'hacc_worker', 'member') AS worker_member,
                COALESCE(ARRAY(
                  SELECT inherited.rolname::text FROM pg_roles inherited
                  WHERE inherited.rolname <> current_user
                    AND inherited.rolname <> 'hacc_backend'
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
                    AND pg_has_role(current_user, application_table.relowner, 'member')
                ) AS inherits_application_owner
         FROM pg_roles current_role
         WHERE current_role.rolname = current_user`
      );
      const inspection = result.rows[0];
      if (!inspection) throw new Error("database runtime role inspection returned no row");
      assertSafeDatabaseRuntimeRole(inspection, expectedRole);
    })();
  }
  return globalForDb.__databaseRuntimeRoleCheck;
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
