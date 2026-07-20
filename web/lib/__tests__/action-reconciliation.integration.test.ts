import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentFlowSchema } from "../flow";
import {
  CallRuntimeSnapshotSchema,
  callRuntimeDigest,
} from "../call-runtime-snapshot";
import {
  deriveFlowActionInvocationId,
  enterFlowStep,
  selectFlowTopic,
} from "../flow-runtime";

vi.mock("server-only", () => ({}));

const queryExecutions = vi.hoisted(() => ({ count: 0 }));
vi.mock("../voice-tools", async () => {
  const actual = await vi.importActual<typeof import("../voice-tools")>("../voice-tools");
  return {
    ...actual,
    voiceToolExtensions: {
      definitions: vi.fn(async () => []),
      executePinned: vi.fn(async (
        name: string,
        args: Record<string, unknown>,
        _scope: unknown,
        pinned: { name: string },
        context: { audience: string; runtimeDigest?: string }
      ) => {
        if (name !== "lookup_reservation" || pinned.name !== name ||
            context.audience !== "reconciliation" || !context.runtimeDigest) {
          return { error: "invalid pinned reconciliation execution" };
        }
        queryExecutions.count += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          invocation_id: args.invocation_id,
          terminal: "committed",
          result: { reservation_id: "R-100", status: "committed" },
        };
      }),
    },
  };
});

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

const actionOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reservation_id: { type: "string" },
    status: { const: "committed" },
  },
  required: ["reservation_id", "status"],
};
const reconciliation = {
  queryTool: "lookup_reservation",
  queryArguments: {
    invocation_id: { source: "invocation_id" as const },
    organization_id: { source: "organization_id" as const },
    reservation_ref: { source: "action_argument" as const, path: "reservation_ref" },
  },
  committedWhen: [
    { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
    { resultPath: "terminal", equals: { source: "literal" as const, value: "committed" } },
  ],
  absentWhen: [
    { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
    { resultPath: "terminal", equals: { source: "literal" as const, value: "absent" } },
  ],
  authoritativeResultPath: "result",
  maxProofAttempts: 3,
};
const extensionManifest = [
  {
    name: "reserve_slot",
    description: "Reserve one slot.",
    implementationDigest: "1".repeat(64),
    admissionScopeDigest: "a".repeat(64),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { reservation_ref: { type: "string" } },
      required: ["reservation_ref"],
    },
    outputSchema: actionOutputSchema,
    effect: "write" as const,
    reconciliation,
  },
  {
    name: "lookup_reservation",
    description: "Read one reservation by the gateway invocation identity.",
    implementationDigest: "2".repeat(64),
    admissionScopeDigest: "a".repeat(64),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        invocation_id: { type: "string" },
        organization_id: { type: "string" },
        reservation_ref: { type: "string" },
      },
      required: ["invocation_id", "organization_id", "reservation_ref"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        invocation_id: { type: "string" },
        terminal: { enum: ["committed", "absent"] },
        result: actionOutputSchema,
      },
      required: ["invocation_id", "terminal", "result"],
    },
    effect: "read" as const,
  },
];
const flow = AgentFlowSchema.parse({
  schema_version: 2,
  tool_exposure: "gateway",
  always_tools: [],
  nodes: [
    { id: "entry", label: "Entry", kind: "incoming_call" },
    {
      id: "booking",
      label: "Booking",
      kind: "topic",
      steps: [{
        id: "commit",
        label: "Commit",
        instructions: "Commit once.",
        tools: ["reserve_slot"],
        action_policies: [{ tool: "reserve_slot", max_calls: 1, idempotency: "per_arguments" }],
      }],
    },
  ],
  edges: [{ from: "entry", to: "booking" }],
});

integration("atomic indeterminate-action reconciliation", () => {
  const ids = {
    org: randomUUID(),
    agent: randomUUID(),
    call: randomUUID(),
    receipt: randomUUID(),
    owner: randomUUID(),
  };
  const snapshot = CallRuntimeSnapshotSchema.parse({
    v: 2,
    agentVersion: 1,
    namedFlowId: null,
    flow,
    instructions: "Test exact reconciliation.",
    codeRevision: "integration-test",
    toolManifest: [],
    extensionManifest,
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
  const digest = callRuntimeDigest(snapshot);
  let modules: {
    db: typeof import("../db");
    store: typeof import("../flow-state-store");
    mcp: typeof import("../mcp");
  };

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.DATABASE_SSL = "disable";
    process.env.MCP_GATEWAY_SECRET = "integration-mcp-secret-at-least-32-bytes";
    modules = {
      db: await import("../db"),
      store: await import("../flow-state-store"),
      mcp: await import("../mcp"),
    };
    await modules.db.q("INSERT INTO orgs (id, name) VALUES ($1,'Reconciliation integration')", [ids.org]);
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
      [ids.call, ids.agent, JSON.stringify(snapshot), digest]
    );
    await modules.store.withLockedFlowState(ids.call, (state) => {
      const selected = selectFlowTopic(flow, state, "booking");
      if ("error" in selected) throw new Error(selected.error);
      return { state: selected, value: null };
    });
    await modules.store.withLockedFlowState(ids.call, (state) => {
      const entered = enterFlowStep(flow, state, "booking.commit");
      if ("error" in entered) throw new Error(entered.error);
      return { state: entered.state, value: null };
    });
    const current = await modules.store.loadFlowState(ids.call);
    const reserved = await modules.store.reserveFlowActionAtomic(ids.call, flow, {
      receiptId: ids.receipt,
      invocationId: deriveFlowActionInvocationId(`${ids.call}:${ids.receipt}`),
      ownerToken: ids.owner,
      runtimeDigest: digest,
      tool: "reserve_slot",
      arguments: { reservation_ref: "R-100" },
      capabilityEpoch: current.capabilityEpoch,
      providerInvocationId: "provider-call-1",
    });
    if ("error" in reserved || !reserved.execute) throw new Error("action was not reserved");
    const marked = await modules.store.markFlowActionDispatchStartedAtomic(ids.call, {
      receiptId: ids.receipt,
      ownerToken: ids.owner,
      runtimeDigest: digest,
    });
    if ("error" in marked) throw new Error(marked.error);
    const indeterminate = await modules.store.settleFlowActionAtomic(ids.call, {
      receiptId: ids.receipt,
      ownerToken: ids.owner,
      status: "indeterminate",
      error: "response lost",
      deliveryState: "unknown",
    });
    if ("error" in indeterminate) throw new Error(indeterminate.error);
  });

  afterAll(async () => {
    if (!modules) return;
    await modules.db.q("DELETE FROM calls WHERE id = $1", [ids.call]).catch(() => {});
    await modules.db.q("DELETE FROM agents WHERE id = $1", [ids.agent]).catch(() => {});
    await modules.db.q("DELETE FROM orgs WHERE id = $1", [ids.org]).catch(() => {});
    await modules.db.getPool().end();
  });

  it("admits one read-only proof owner and atomically promotes the receipt", async () => {
    queryExecutions.count = 0;
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      modules.mcp.callTool(
        { callId: ids.call, agentId: ids.agent, orgId: ids.org },
        "reconcile_action",
        { receipt_id: ids.receipt },
        { invocationId: `reconcile-${randomUUID()}` }
      )
    ));
    expect(queryExecutions.count).toBe(1);
    expect(results.filter((result) =>
      !!result && typeof result === "object" && (result as { reconciled?: boolean }).reconciled
    )).toHaveLength(1);
    expect(results.filter((result) =>
      !!result && typeof result === "object" && (result as { pending?: boolean }).pending
    ).length).toBeGreaterThan(0);

    const persisted = await modules.store.loadFlowState(ids.call);
    expect(persisted.actionReceipts.find((receipt) => receipt.id === ids.receipt)).toMatchObject({
      status: "succeeded",
      result: { reservation_id: "R-100", status: "committed" },
      reconciliationProofId: expect.any(String),
    });
    const rows = await modules.db.q<{
      status: string;
      invocation_id: string;
      proof_status: string;
      reconciliation_proof_id: string;
    }>(
      `SELECT r.status, r.invocation_id, r.reconciliation_proof_id,
              p.status AS proof_status
       FROM flow_action_receipts r
       JOIN flow_action_reconciliation_proofs p
         ON p.id = r.reconciliation_proof_id
       WHERE r.id = $1 AND r.call_id = $2`,
      [ids.receipt, ids.call]
    );
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      invocation_id: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/),
      proof_status: "committed",
      reconciliation_proof_id: expect.any(String),
    });

    await expect(modules.mcp.callTool(
      { callId: ids.call, agentId: ids.agent, orgId: ids.org },
      "reconcile_action",
      { receipt_id: ids.receipt }
    )).resolves.toMatchObject({ reconciled: true, replayed: true });
    expect(queryExecutions.count).toBe(1);

    await expect(modules.db.q(
      "UPDATE flow_action_reconciliation_proofs SET policy_hash = $2 WHERE id = $1",
      [rows[0].reconciliation_proof_id, "0".repeat(64)]
    )).rejects.toThrow(/immutable/);
  });
});
