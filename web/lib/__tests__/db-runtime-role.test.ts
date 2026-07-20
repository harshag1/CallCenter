import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  assertSafeDatabaseRuntimeRole,
  createSafeDatabasePool,
  type DatabaseRuntimeRoleInspection,
} from "../db";

const safe: DatabaseRuntimeRoleInspection = Object.freeze({
  current_user: "hacc_runtime",
  superuser: false,
  bypassrls: false,
  backend_member: true,
  worker_member: false,
  unexpected_inherited_roles: [],
  has_direct_application_grants: false,
  inherits_application_owner: false,
});

describe("database runtime role boundary", () => {
  it("accepts only the exact non-owner backend runtime identity", () => {
    expect(() => assertSafeDatabaseRuntimeRole(safe, "hacc_runtime")).not.toThrow();
  });

  it.each([
    ["unexpected role", { current_user: "postgres" }],
    ["superuser", { superuser: true }],
    ["BYPASSRLS", { bypassrls: true }],
    ["missing backend membership", { backend_member: false }],
    ["worker membership", { worker_member: true }],
    ["inherited privileged role", { unexpected_inherited_roles: ["cluster_admin"] }],
    ["inherited predefined pg_read_all_data role", { unexpected_inherited_roles: ["pg_read_all_data"] }],
    ["inherited predefined pg_execute_server_program role", { unexpected_inherited_roles: ["pg_execute_server_program"] }],
    ["inherited unprivileged extra role", { unexpected_inherited_roles: ["extra_app_access"] }],
    ["direct application ACL grant", { has_direct_application_grants: true }],
    ["application-table ownership", { inherits_application_owner: true }],
  ])("rejects %s", (_label, patch) => {
    expect(() => assertSafeDatabaseRuntimeRole({ ...safe, ...patch }, "hacc_runtime"))
      .toThrow(/non-owner, non-bypass hacc_backend member/);
  });

  it("rejects an unsafe expected-role setting before comparing identities", () => {
    expect(() => assertSafeDatabaseRuntimeRole(safe, "hacc_runtime; SET ROLE postgres"))
      .toThrow(/lowercase PostgreSQL identifier/);
  });

  it("blocks both direct transactions and queries until the role audit passes", async () => {
    let releaseGuard!: () => void;
    const guard = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const rawConnect = vi.fn(async () => ({ release() {} }));
    const rawQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool = createSafeDatabasePool({
      connect: rawConnect,
      query: rawQuery,
      end: vi.fn(async () => undefined),
    } as unknown as Pool, () => guard);

    const connection = pool.connect();
    const query = pool.query("SELECT 1");
    await Promise.resolve();
    expect(rawConnect).not.toHaveBeenCalled();
    expect(rawQuery).not.toHaveBeenCalled();
    releaseGuard();
    await Promise.all([connection, query]);
    expect(rawConnect).toHaveBeenCalledOnce();
    expect(rawQuery).toHaveBeenCalledOnce();
  });

  it("never touches the raw pool when the centralized audit fails", async () => {
    const rawConnect = vi.fn();
    const rawQuery = vi.fn();
    const pool = createSafeDatabasePool({
      connect: rawConnect,
      query: rawQuery,
      end: vi.fn(async () => undefined),
    } as unknown as Pool, async () => { throw new Error("unsafe runtime role"); });

    await expect(pool.connect()).rejects.toThrow(/unsafe runtime role/);
    await expect(pool.query("SELECT 1")).rejects.toThrow(/unsafe runtime role/);
    expect(rawConnect).not.toHaveBeenCalled();
    expect(rawQuery).not.toHaveBeenCalled();
  });
});
