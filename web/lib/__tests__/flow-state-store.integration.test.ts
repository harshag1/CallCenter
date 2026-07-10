import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentFlowSchema } from "../flow";
import { enterFlowStep, selectFlowTopic } from "../flow-runtime";
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
          tools: ["commit_operation"],
          action_policies: [{
            tool: "commit_operation",
            max_calls: 1,
            idempotency: "per_arguments",
          }],
        }],
      },
    ],
    edges: [{ from: "entry", to: "operations" }],
  });
  let modules: Awaited<ReturnType<typeof loadModules>>;

  async function loadModules() {
    if (databaseUrl) {
      process.env.DATABASE_URL = databaseUrl;
      process.env.DATABASE_SSL = "disable";
    }
    const [db, store] = await Promise.all([import("../db"), import("../flow-state-store")]);
    return { db, store };
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
      "INSERT INTO calls (id, agent_id, agent_version, direction) VALUES ($1,$2,1,'web')",
      [ids.call, ids.agent]
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
    const reservations = await Promise.all(Array.from({ length: 50 }, () =>
      modules.store.reserveFlowActionAtomic(ids.call, flow, {
        receiptId: randomUUID(),
        ownerToken: randomUUID(),
        runtimeDigest: "a".repeat(64),
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
        ownerToken: randomUUID(),
        runtimeDigest: "a".repeat(64),
        tool: "commit_operation",
        arguments: { amount: 42, operation_id: "operation-1" },
        capabilityEpoch: replayState.capabilityEpoch,
      })
    ));
    expect(replays.every((result) => !("error" in result) && !result.execute && result.replayed)).toBe(true);
    expect(new Set(replays.flatMap((result) => "error" in result ? [] : [result.receipt.id])).size).toBe(1);
  }, 20_000);
});
