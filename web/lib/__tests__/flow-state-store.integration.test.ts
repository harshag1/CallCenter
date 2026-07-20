import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CallRuntimeSnapshotSchema, callRuntimeDigest } from "../call-runtime-snapshot";
import { AgentFlowSchema } from "../flow";
import {
  completeFlowStep,
  deriveFlowActionInvocationId,
  enterFlowStep,
  selectFlowTopic,
} from "../flow-runtime";
import type { AtomicActionReservation } from "../flow-state-store";

vi.mock("server-only", () => ({}));

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

integration("atomic Flow v2 action persistence", () => {
  const ids = {
    org: randomUUID(),
    agent: randomUUID(),
    call: randomUUID(),
  };
  const flow = AgentFlowSchema.parse({
    schema_version: 2,
    always_tools: [],
    nodes: [
      { id: "entry", label: "Incoming call", kind: "incoming_call" },
      {
        id: "operations",
        label: "Operations",
        kind: "topic",
        steps: [{
          id: "execute",
          label: "Execute",
          instructions: "Execute once.",
          entry: true,
          tools: ["commit_operation"],
          transitions: [{ to: "operations.finalize" }],
          action_policies: [{
            tool: "commit_operation",
            max_calls: 1,
            idempotency: "per_call_arguments",
          }],
        }, {
          id: "finalize",
          label: "Finalize",
          instructions: "Reuse the exact committed result; never dispatch it twice.",
          entry: false,
          tools: ["commit_operation"],
          action_policies: [{
            tool: "commit_operation",
            max_calls: 1,
            idempotency: "per_call_arguments",
          }],
        }],
      },
    ],
    edges: [{ from: "entry", to: "operations" }],
  });
  const runtimeSnapshot = CallRuntimeSnapshotSchema.parse({
    v: 2,
    agentVersion: 1,
    namedFlowId: null,
    flow,
    instructions: "Test exact atomic action persistence.",
    codeRevision: "flow-state-store-integration-test",
    toolManifest: [],
    extensionManifest: [{
      name: "commit_operation",
      description: "Commit one test operation.",
      implementationDigest: "1".repeat(64),
      admissionScopeDigest: "a".repeat(64),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation_id: { type: "string" },
          amount: { type: "number" },
        },
        required: ["operation_id", "amount"],
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation_id: { type: "string" },
          committed: { type: "boolean" },
        },
        required: ["operation_id", "committed"],
      },
      effect: "write",
    }],
    externalMcpManifest: [],
    environment: {
      internetEnabled: false,
      allowedDomains: [],
      docsReady: false,
      datasetSlugs: [],
      holdMusic: false,
    },
    createdAt: "2026-07-16T12:00:00.000Z",
  });
  const runtimeDigest = callRuntimeDigest(runtimeSnapshot);
  let modules: Awaited<ReturnType<typeof loadModules>>;

  async function loadModules() {
    if (databaseUrl) {
      process.env.DATABASE_URL = databaseUrl;
      process.env.DATABASE_SSL = "disable";
    }
    const [db, store, mcp] = await Promise.all([
      import("../db"),
      import("../flow-state-store"),
      import("../mcp"),
    ]);
    return { db, store, mcp };
  }

  beforeAll(async () => {
    modules = await loadModules();
    await modules.db.q("INSERT INTO orgs (id, name) VALUES ($1,'Flow integration test')", [ids.org]);
    await modules.db.q(
      "INSERT INTO agents (id, org_id, name, active_version) VALUES ($1,$2,'Test agent',1)",
      [ids.agent, ids.org]
    );
    await modules.db.q(
      `INSERT INTO agent_versions (agent_id, version, instructions, flow, created_by)
       VALUES ($1,1,'test',$2,'integration-test')`,
      [ids.agent, JSON.stringify(flow)]
    );
    await modules.db.q(
      `INSERT INTO calls
        (id, agent_id, agent_version, direction, runtime_snapshot, runtime_digest)
       VALUES ($1,$2,1,'web',$3,$4)`,
      [ids.call, ids.agent, JSON.stringify(runtimeSnapshot), runtimeDigest]
    );
    await modules.store.withLockedFlowState(ids.call, (state) => {
      const selected = selectFlowTopic(flow, state, "operations");
      if ("error" in selected) throw new Error(selected.error);
      return { state: selected, value: null };
    });
    await modules.store.withLockedFlowState(ids.call, (state) => {
      const entered = enterFlowStep(flow, state, "operations.execute");
      if ("error" in entered) throw new Error(entered.error);
      return { state: entered.state, value: null };
    });
  });

  afterAll(async () => {
    if (!modules) return;
    await modules.db.q("DELETE FROM calls WHERE id = $1", [ids.call]).catch(() => {});
    await modules.db.q("DELETE FROM agents WHERE id = $1", [ids.agent]).catch(() => {});
    await modules.db.q("DELETE FROM orgs WHERE id = $1", [ids.org]).catch(() => {});
    await modules.db.getPool().end();
  });

  it("admits exactly one owner across concurrent identical reservations", async () => {
    const current = await modules.store.loadFlowState(ids.call);
    const stableInvocationId = deriveFlowActionInvocationId(`${ids.call}:operation-1`);
    const reservations = await Promise.all(Array.from({ length: 50 }, () =>
      modules.store.reserveFlowActionAtomic(ids.call, flow, {
        receiptId: randomUUID(),
        invocationId: stableInvocationId,
        ownerToken: randomUUID(),
        runtimeDigest,
        tool: "commit_operation",
        arguments: { operation_id: "operation-1", amount: 42 },
        capabilityEpoch: current.capabilityEpoch,
      })
    ));
    const successful = reservations.filter(
      (result): result is AtomicActionReservation => !("error" in result)
    );
    expect(successful).toHaveLength(50);
    expect(successful.filter((result) => result.execute)).toHaveLength(1);
    expect(new Set(successful.map((result) => result.receipt.id)).size).toBe(1);

    const persisted = await modules.store.loadFlowState(ids.call);
    expect(persisted.actionReceipts).toHaveLength(1);
    const rows = await modules.db.q<{ count: string }>(
      "SELECT count(*)::text AS count FROM flow_action_receipts WHERE call_id = $1",
      [ids.call]
    );
    expect(rows[0].count).toBe("1");

    const owner = successful.find((result) => result.execute);
    if (!owner?.ownerToken) throw new Error("reservation owner token was not returned");
    const marked = await modules.store.markFlowActionDispatchStartedAtomic(ids.call, {
      receiptId: owner.receipt.id,
      ownerToken: owner.ownerToken,
      runtimeDigest,
    });
    if ("error" in marked) throw new Error(marked.error);
    expect(marked.receipt.dispatchStartedAt).toBeTruthy();
    const settled = await modules.store.settleFlowActionAtomic(ids.call, {
      receiptId: owner.receipt.id,
      ownerToken: owner.ownerToken,
      status: "succeeded",
      result: { operation_id: "operation-1", committed: true },
      deliveryState: "committed",
    });
    if ("error" in settled) throw new Error(settled.error);
    expect(settled.receipt.status).toBe("succeeded");

    const replayState = await modules.store.loadFlowState(ids.call);
    const replays = await Promise.all(Array.from({ length: 25 }, () =>
      modules.store.reserveFlowActionAtomic(ids.call, flow, {
        receiptId: randomUUID(),
        invocationId: stableInvocationId,
        ownerToken: randomUUID(),
        runtimeDigest,
        tool: "commit_operation",
        arguments: { amount: 42, operation_id: "operation-1" },
        capabilityEpoch: replayState.capabilityEpoch,
      })
    ));
    expect(replays.every((result) => !("error" in result) && !result.execute && result.replayed)).toBe(true);
    expect(new Set(replays.flatMap((result) => "error" in result ? [] : [result.receipt.id])).size).toBe(1);

    const beforeNoop = await modules.store.loadFlowState(ids.call);
    const noop = await modules.store.withLockedFlowState(ids.call, (state) => ({ state, value: state.revision }));
    expect(noop.state.revision).toBe(beforeNoop.revision);
    expect(noop.value).toBe(beforeNoop.revision);
  }, 20_000);

  it("rehydrates an exact replay from the immutable ledger after hot-state compaction", async () => {
    await modules.store.withLockedFlowState(ids.call, (state) => {
      const completed = completeFlowStep(flow, state, { outputs: {} });
      if ("error" in completed) throw new Error(completed.error);
      return { state: completed.state, value: null };
    });
    await modules.store.withLockedFlowState(ids.call, (state) => {
      const entered = enterFlowStep(flow, state, "operations.finalize");
      if ("error" in entered) throw new Error(entered.error);
      return { state: entered.state, value: null };
    });
    const compacted = await modules.store.loadFlowState(ids.call);
    expect(compacted.actionReceipts[0]).toMatchObject({
      status: "succeeded",
      argumentsCompacted: true,
      resultCompacted: true,
    });
    expect(compacted.actionReceipts[0]).not.toHaveProperty("arguments");
    expect(compacted.actionReceipts[0]).not.toHaveProperty("result");

    const replay = await modules.store.reserveFlowActionAtomic(ids.call, flow, {
      receiptId: randomUUID(),
      invocationId: deriveFlowActionInvocationId(`${ids.call}:operation-1-replay`),
      ownerToken: randomUUID(),
      runtimeDigest,
      tool: "commit_operation",
      arguments: { amount: 42, operation_id: "operation-1" },
      capabilityEpoch: compacted.capabilityEpoch,
    });
    if ("error" in replay) throw new Error(replay.error);
    expect(replay).toMatchObject({
      execute: false,
      replayed: true,
      receipt: {
        status: "succeeded",
        result: { operation_id: "operation-1", committed: true },
      },
    });
    expect(replay.receipt).not.toHaveProperty("resultCompacted");

    const stillCompacted = await modules.store.loadFlowState(ids.call);
    expect(stillCompacted.actionReceipts[0]).not.toHaveProperty("result");
    expect(stillCompacted.actionReceipts[0]).toMatchObject({ resultCompacted: true });
    expect(stillCompacted.revision).toBe(compacted.revision);
  });

  it("revokes scoped tool authority as soon as the call is no longer active", async () => {
    const scope = { callId: ids.call, agentId: ids.agent, orgId: ids.org };
    await expect(modules.mcp.listToolsFor(scope)).resolves.toBeInstanceOf(Array);
    await modules.db.q("UPDATE calls SET status = 'completed', ended_at = now() WHERE id = $1", [ids.call]);
    await expect(modules.mcp.listToolsFor(scope)).rejects.toThrow(/authority is no longer active/);
  });
});
