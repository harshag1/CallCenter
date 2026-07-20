import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

integration("durable MCP provider invocation receipts", () => {
  const ids = {
    org: randomUUID(),
    agent: randomUUID(),
    call: randomUUID(),
    countQuotaCall: randomUUID(),
    byteQuotaCall: randomUUID(),
    rateQuotaCall: randomUUID(),
    resultQuotaCall: randomUUID(),
    reapplyCall: randomUUID(),
  };
  let modules: Awaited<ReturnType<typeof loadModules>>;

  async function loadModules() {
    if (databaseUrl) {
      process.env.DATABASE_URL = databaseUrl;
      process.env.DATABASE_SSL = "disable";
    }
    const [db, store] = await Promise.all([
      import("../db"),
      import("../mcp-invocation-store"),
    ]);
    return { db, store };
  }

  beforeAll(async () => {
    modules = await loadModules();
    await modules.db.q("INSERT INTO orgs (id,name) VALUES ($1,'MCP receipt test')", [ids.org]);
    await modules.db.q(
      "INSERT INTO agents (id,org_id,name,active_version) VALUES ($1,$2,'MCP receipt agent',1)",
      [ids.agent, ids.org]
    );
    for (const callId of [
      ids.call,
      ids.countQuotaCall,
      ids.byteQuotaCall,
      ids.rateQuotaCall,
      ids.resultQuotaCall,
      ids.reapplyCall,
    ]) {
      await modules.db.q(
        "INSERT INTO calls (id,agent_id,agent_version,direction) VALUES ($1,$2,1,'web')",
        [callId, ids.agent]
      );
    }
  });

  afterAll(async () => {
    if (!modules) return;
    await modules.db.q(
      "DELETE FROM calls WHERE id = ANY($1::uuid[])",
      [[
        ids.call,
        ids.countQuotaCall,
        ids.byteQuotaCall,
        ids.rateQuotaCall,
        ids.resultQuotaCall,
        ids.reapplyCall,
      ]]
    ).catch(() => undefined);
    await modules.db.q("DELETE FROM agents WHERE id=$1", [ids.agent]).catch(() => undefined);
    await modules.db.q("DELETE FROM orgs WHERE id=$1", [ids.org]).catch(() => undefined);
    await modules.db.getPool().end();
  });

  it("admits one executor, returns explicit pending, and replays one exact terminal result", async () => {
    const providerId = "mcp-provider:v1:" + "1".repeat(64);
    const input = { path: "membership.verify" };
    const identity = {
      callId: ids.call,
      providerInvocationId: providerId,
      logicalName: "enter_step",
      modelArguments: input,
      expectedCatalog: { catalog_digest: "a".repeat(64), capability_epoch: 1 },
    };
    const admissions = await Promise.all(Array.from({ length: 32 }, () =>
      modules.store.admitMcpToolInvocation(identity, { replayWaitMs: 0 })
    ));
    const owners = admissions.filter(
      (admission): admission is Extract<typeof admission, { execute: true }> => admission.execute
    );
    expect(owners).toHaveLength(1);
    expect(admissions.filter((admission) => !admission.execute)).toHaveLength(31);
    for (const admission of admissions.filter(
      (candidate): candidate is Extract<typeof candidate, { execute: false }> => !candidate.execute
    )) {
      expect(admission.result).toMatchObject({ code: "tool_invocation_pending" });
    }

    const terminal = {
      path: "membership.verify",
      capability_epoch: 2,
      revision: 7,
    };
    await expect(modules.store.settleMcpToolInvocation(owners[0], terminal))
      .resolves.toEqual(terminal);
    const replays = await Promise.all(Array.from({ length: 20 }, () =>
      modules.store.admitMcpToolInvocation(identity, { replayWaitMs: 0 })
    ));
    expect(replays.every((admission) => !admission.execute && admission.replayed)).toBe(true);
    expect(replays.map((admission) => !admission.execute && admission.result))
      .toEqual(Array.from({ length: 20 }, () => terminal));

    await expect(modules.store.admitMcpToolInvocation({
      ...identity,
      modelArguments: { path: "membership.changed" },
    }, { replayWaitMs: 0 })).resolves.toMatchObject({
      execute: false,
      result: { code: "provider_invocation_identity_conflict" },
    });
    await expect(modules.store.admitMcpToolInvocation({
      ...identity,
      expectedCatalog: { ...identity.expectedCatalog, catalog_digest: "b".repeat(64) },
    }, { replayWaitMs: 0 })).resolves.toMatchObject({
      execute: false,
      result: { code: "provider_invocation_identity_conflict" },
    });
    await expect(modules.store.admitMcpToolInvocation({
      ...identity,
      expectedCatalog: { ...identity.expectedCatalog, capability_epoch: 2 },
    }, { replayWaitMs: 0 })).resolves.toMatchObject({
      execute: false,
      result: { code: "provider_invocation_identity_conflict" },
    });
  });

  it("keeps terminal receipt identity and result immutable in PostgreSQL", async () => {
    const providerId = "mcp-provider:v1:" + "2".repeat(64);
    const admitted = await modules.store.admitMcpToolInvocation({
      callId: ids.call,
      providerInvocationId: providerId,
      logicalName: "classify",
      modelArguments: { topic: "membership" },
      expectedCatalog: { catalog_digest: "c".repeat(64), capability_epoch: 0 },
    }, { replayWaitMs: 0 });
    if (!admitted.execute) throw new Error("expected receipt owner");
    await modules.store.settleMcpToolInvocation(admitted, { ok: true });
    await expect(modules.db.q(
      "UPDATE mcp_tool_invocation_receipts SET result='{}'::jsonb WHERE id=$1",
      [admitted.receiptId]
    )).rejects.toThrow(/terminal MCP tool receipts are immutable/);
  });

  it("persists only provider-visible logical input and never private host authority", async () => {
    const providerId = "mcp-provider:v1:" + "3".repeat(64);
    const admitted = await modules.store.admitMcpToolInvocation({
      callId: ids.call,
      providerInvocationId: providerId,
      logicalName: "renew_membership",
      modelArguments: { membership_id: "m-1" },
      expectedCatalog: { catalog_digest: "d".repeat(64), capability_epoch: 7 },
    }, { replayWaitMs: 0 });
    if (!admitted.execute) throw new Error("expected receipt owner");
    const stored = await modules.db.qOne<{
      logical_name: string;
      model_arguments: Record<string, unknown>;
      active_catalog_digest: string;
      active_catalog_epoch: number;
    }>(
      `SELECT logical_name,model_arguments,active_catalog_digest,active_catalog_epoch
       FROM mcp_tool_invocation_receipts WHERE id=$1`,
      [admitted.receiptId]
    );
    expect(stored).toEqual({
      logical_name: "renew_membership",
      model_arguments: { membership_id: "m-1" },
      active_catalog_digest: "d".repeat(64),
      active_catalog_epoch: 7,
    });
    expect(JSON.stringify(stored)).not.toContain("capability_grant");
    await modules.store.settleMcpToolInvocation(admitted, { ok: true });
  });

  it("atomically admits only one fresh identity at the per-call lifetime boundary", async () => {
    await modules.db.q(
      `INSERT INTO mcp_call_invocation_quotas
         (call_id,receipt_count,model_argument_bytes,window_started_at,window_count)
       VALUES ($1,511,0,clock_timestamp(),0)`,
      [ids.countQuotaCall]
    );
    const attempts = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      modules.store.admitMcpToolInvocation({
        callId: ids.countQuotaCall,
        providerInvocationId: `mcp-provider:v1:count-${String(index).padStart(4, "0")}`,
        logicalName: "classify",
        modelArguments: { topic: `topic-${index}` },
        expectedCatalog: { catalog_digest: "e".repeat(64), capability_epoch: 0 },
      }, { replayWaitMs: 0 })
    ));
    const owners = attempts.filter(
      (candidate): candidate is Extract<typeof candidate, { execute: true }> => candidate.execute
    );
    expect(owners).toHaveLength(1);
    expect(attempts.filter((candidate) =>
      !candidate.execute &&
      (candidate.result as { code?: string }).code === "tool_invocation_quota_exceeded"
    )).toHaveLength(23);
    await modules.store.settleMcpToolInvocation(owners[0], { accepted: true });

    const quota = await modules.db.qOne<{
      receipt_count: number;
      persisted: number;
    }>(
      `SELECT quota.receipt_count,
              (SELECT count(*)::int FROM mcp_tool_invocation_receipts receipt
               WHERE receipt.call_id=quota.call_id) AS persisted
       FROM mcp_call_invocation_quotas quota WHERE quota.call_id=$1`,
      [ids.countQuotaCall]
    );
    expect(quota).toEqual({ receipt_count: 512, persisted: 1 });

    const ownerIndex = attempts.findIndex((candidate) => candidate.execute);
    await expect(modules.store.admitMcpToolInvocation({
      callId: ids.countQuotaCall,
      providerInvocationId: `mcp-provider:v1:count-${String(ownerIndex).padStart(4, "0")}`,
      logicalName: "classify",
      modelArguments: { topic: `topic-${ownerIndex}` },
      expectedCatalog: { catalog_digest: "e".repeat(64), capability_epoch: 0 },
    }, { replayWaitMs: 0 })).resolves.toMatchObject({
      execute: false,
      replayed: true,
      result: { accepted: true },
    });
  });

  it("enforces cumulative bytes, individual bytes, and a concurrency-safe rate window", async () => {
    await modules.db.q(
      `INSERT INTO mcp_call_invocation_quotas
         (call_id,receipt_count,model_argument_bytes,window_started_at,window_count)
       VALUES ($1,0,4194270,clock_timestamp(),0),
              ($2,0,0,clock_timestamp(),119)`,
      [ids.byteQuotaCall, ids.rateQuotaCall]
    );
    await expect(modules.store.admitMcpToolInvocation({
      callId: ids.byteQuotaCall,
      providerInvocationId: "mcp-provider:v1:cumulative-byte-limit",
      logicalName: "classify",
      modelArguments: { topic: "membership", padding: "x".repeat(128) },
      expectedCatalog: { catalog_digest: "f".repeat(64), capability_epoch: 0 },
    }, { replayWaitMs: 0 })).resolves.toMatchObject({
      execute: false,
      result: { code: "tool_invocation_quota_exceeded" },
    });
    await expect(modules.store.admitMcpToolInvocation({
      callId: ids.byteQuotaCall,
      providerInvocationId: "mcp-provider:v1:individual-byte-limit",
      logicalName: "classify",
      modelArguments: { padding: "x".repeat(33 * 1024) },
      expectedCatalog: { catalog_digest: "f".repeat(64), capability_epoch: 0 },
    }, { replayWaitMs: 0 })).resolves.toMatchObject({
      execute: false,
      result: { code: "tool_invocation_arguments_too_large" },
    });

    const rateAttempts = await Promise.all([0, 1].map((index) =>
      modules.store.admitMcpToolInvocation({
        callId: ids.rateQuotaCall,
        providerInvocationId: `mcp-provider:v1:rate-${index}`,
        logicalName: "classify",
        modelArguments: { topic: `rate-${index}` },
        expectedCatalog: { catalog_digest: "1".repeat(64), capability_epoch: 0 },
      }, { replayWaitMs: 0 })
    ));
    expect(rateAttempts.filter((candidate) => candidate.execute)).toHaveLength(1);
    expect(rateAttempts.filter((candidate) =>
      !candidate.execute &&
      (candidate.result as { code?: string }).code === "tool_invocation_rate_exceeded"
    )).toHaveLength(1);
    const rateOwner = rateAttempts.find(
      (candidate): candidate is Extract<typeof candidate, { execute: true }> => candidate.execute
    );
    if (!rateOwner) throw new Error("expected one rate-window owner");
    await modules.store.settleMcpToolInvocation(rateOwner, { accepted: true });
  });

  it("atomically replaces result reservations and preserves a bounded fallback at cumulative exhaustion", async () => {
    await modules.db.q(
      `INSERT INTO mcp_call_invocation_quotas
         (call_id,receipt_count,model_argument_bytes,result_bytes,window_started_at,window_count)
       VALUES ($1,0,0,33553000,clock_timestamp(),0)`,
      [ids.resultQuotaCall]
    );
    const identity = {
      callId: ids.resultQuotaCall,
      providerInvocationId: "mcp-provider:v1:result-storage-boundary",
      logicalName: "classify",
      modelArguments: { topic: "membership" },
      expectedCatalog: { catalog_digest: "2".repeat(64), capability_epoch: 0 },
    };
    const admitted = await modules.store.admitMcpToolInvocation(identity, { replayWaitMs: 0 });
    if (!admitted.execute) throw new Error("expected result-quota receipt owner");
    await expect(modules.store.settleMcpToolInvocation(
      admitted,
      { padding: "x".repeat(2_000) }
    )).resolves.toMatchObject({
      code: "tool_invocation_result_quota_exceeded",
    });
    const persisted = await modules.db.qOne<{
      status: string;
      result: { code?: string };
      total_bytes: string;
    }>(
      `SELECT receipt.status,receipt.result,
              (quota.model_argument_bytes + quota.result_bytes)::text AS total_bytes
       FROM mcp_tool_invocation_receipts receipt
       JOIN mcp_call_invocation_quotas quota ON quota.call_id=receipt.call_id
       WHERE receipt.call_id=$1`,
      [ids.resultQuotaCall]
    );
    expect(persisted).toMatchObject({
      status: "indeterminate",
      result: { code: "tool_invocation_result_quota_exceeded" },
    });
    expect(Number(persisted?.total_bytes)).toBeLessThanOrEqual(33_554_432);
    await expect(modules.store.admitMcpToolInvocation(identity, { replayWaitMs: 0 }))
      .resolves.toMatchObject({
        execute: false,
        replayed: true,
        result: { code: "tool_invocation_result_quota_exceeded" },
      });
  });

  it("keeps direct INSERT/UPDATE closed and function admission live after standalone 022 reapply", async () => {
    const migration022 = await readFile(
      new URL("../../migrations/022_mcp_tool_invocation_receipts.sql", import.meta.url),
      "utf8"
    );
    await modules.db.q(migration022);
    const privileges = await modules.db.qOne<{
      direct_insert: boolean;
      direct_update: boolean;
      admit_execute: boolean;
      settle_execute: boolean;
    }>(
      `SELECT has_table_privilege('hacc_backend','public.mcp_tool_invocation_receipts','INSERT')
                AS direct_insert,
              has_table_privilege('hacc_backend','public.mcp_tool_invocation_receipts','UPDATE')
                AS direct_update,
              has_function_privilege(
                'hacc_backend',
                'public.admit_mcp_tool_invocation(uuid,uuid,text,text,jsonb,text,text,integer,uuid,integer)',
                'EXECUTE'
              ) AS admit_execute,
              has_function_privilege(
                'hacc_backend',
                'public.settle_mcp_tool_invocation(uuid,uuid,text,jsonb,text,boolean)',
                'EXECUTE'
              ) AS settle_execute`
    );
    expect(privileges).toEqual({
      direct_insert: false,
      direct_update: false,
      admit_execute: true,
      settle_execute: true,
    });

    const identity = {
      callId: ids.reapplyCall,
      providerInvocationId: "mcp-provider:v1:standalone-022-reapply",
      logicalName: "classify",
      modelArguments: { topic: "membership" },
      expectedCatalog: { catalog_digest: "3".repeat(64), capability_epoch: 0 },
    };
    const admitted = await modules.store.admitMcpToolInvocation(identity, { replayWaitMs: 0 });
    if (!admitted.execute) throw new Error("expected post-reapply receipt owner");
    await expect(modules.store.settleMcpToolInvocation(admitted, { ok: true }))
      .resolves.toEqual({ ok: true });
    await expect(modules.store.admitMcpToolInvocation(identity, { replayWaitMs: 0 }))
      .resolves.toMatchObject({ execute: false, replayed: true, result: { ok: true } });

    const client = await modules.db.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DROP FUNCTION public.admit_mcp_tool_invocation(
           uuid,uuid,text,text,jsonb,text,text,integer,uuid,integer
         )`
      );
      await client.query(migration022);
      const damaged = await client.query<{ direct_insert: boolean; direct_update: boolean }>(
        `SELECT has_table_privilege(
                  'hacc_backend','public.mcp_tool_invocation_receipts','INSERT'
                ) AS direct_insert,
                has_table_privilege(
                  'hacc_backend','public.mcp_tool_invocation_receipts','UPDATE'
                ) AS direct_update`
      );
      expect(damaged.rows[0]).toEqual({ direct_insert: false, direct_update: false });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
