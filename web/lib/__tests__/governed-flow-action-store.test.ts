import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentFlowSchema } from "../flow";
import {
  deriveFlowActionInvocationId,
  enterFlowStep,
  hashFlowValue,
  selectFlowTopic,
  type FlowExecutionState,
} from "../flow-runtime";

vi.mock("server-only", () => ({}));

const harness = vi.hoisted(() => ({
  state: null as FlowExecutionState | null,
  priorCallCount: 0,
  calls: [] as Array<{ sql: string; params: unknown[] }>,
}));

const client = {
  async query(sql: string, params: unknown[] = []) {
    harness.calls.push({ sql, params });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.includes("INSERT INTO flow_runs")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT state, revision FROM flow_runs")) {
      return { rows: [{ state: harness.state, revision: harness.state?.revision }], rowCount: 1 };
    }
    if (sql.includes("SELECT status, runtime_digest FROM calls")) {
      return { rows: [{ status: "active", runtime_digest: "d".repeat(64) }], rowCount: 1 };
    }
    if (sql.includes("clock_timestamp() AS evaluated_at")) {
      return {
        rows: [{ evaluated_at: new Date("2026-07-21T12:00:00.000Z"), prior_call_count: String(harness.priorCallCount) }],
        rowCount: 1,
      };
    }
    if (sql.includes("reserve_conversation_call_action_intent")) {
      return { rows: [{ reserve_conversation_call_action_intent: true }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO flow_action_receipts")) return { rows: [], rowCount: 1 };
    if (sql.includes("append_flow_action_policy_decision")) return { rows: [{ append_flow_action_policy_decision: params[0] }], rowCount: 1 };
    if (sql.includes("UPDATE flow_runs SET state")) {
      harness.state = JSON.parse(String(params[1])) as FlowExecutionState;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
  release() {},
};

vi.mock("../db", () => ({
  getPool: () => ({ connect: async () => client }),
  q: vi.fn(),
  qOne: vi.fn(),
}));

import { reserveGovernedFlowActionAtomic } from "../flow-state-store";

const H = (char: string) => char.repeat(64);
const flow = AgentFlowSchema.parse({
  schema_version: 2,
  always_tools: [],
  nodes: [
    { id: "entry", label: "Incoming", kind: "incoming_call" },
    {
      id: "refunds",
      label: "Refunds",
      kind: "topic",
      steps: [{
        id: "issue",
        label: "Issue refund",
        instructions: "Issue one governed refund.",
        entry: true,
        tools: ["issue_refund"],
        action_policies: [{ tool: "issue_refund", idempotency: "per_call_arguments" }],
      }],
    },
  ],
  edges: [{ from: "entry", to: "refunds" }],
});

const policy = {
  schema_version: 1,
  id: "refund.policy",
  version: "1",
  default_decision: "deny",
  actions: [{
    action: "issue_refund",
    effect: "write",
    require_all: [
      { kind: "argument", path: "amount", operator: "greater_than", value: 0 },
      { kind: "argument", path: "amount", operator: "less_than_or_equal", value: 250 },
    ],
    deny_if_any: [],
    maximum_calls: 1,
    confirmation: { authorities: ["caller"], max_age_seconds: 60, readback_fields: ["amount"] },
    postconditions: [],
    provider_visible_result_fields: [],
  }],
} as const;

function activeState(): FlowExecutionState {
  const state = selectFlowTopic(flow, {
    version: 2,
    status: "routing",
    nodeId: null,
    currentStep: null,
    completedSteps: [],
    stepEntries: 0,
    attempts: {},
    outputs: {},
    checkpoints: [],
    capabilityEpoch: 0,
    actionReceipts: [],
    revision: 0,
    updatedAt: "2026-07-21T11:59:00.000Z",
  }, "refunds", "2026-07-21T11:59:01.000Z");
  if ("error" in state) throw new Error(state.error);
  const entered = enterFlowStep(flow, state, "refunds.issue", "2026-07-21T11:59:02.000Z");
  if ("error" in entered) throw new Error(entered.error);
  return entered.state;
}

function args(amount = 25) {
  return {
    receiptId: randomUUID(),
    invocationId: deriveFlowActionInvocationId(randomUUID()),
    ownerToken: randomUUID(),
    runtimeDigest: H("d"),
    tool: "issue_refund",
    arguments: { amount },
    capabilityEpoch: harness.state!.capabilityEpoch,
    policy,
    facts: [],
    receipts: [],
  };
}

describe("governed Flow action admission", () => {
  beforeEach(() => {
    harness.state = activeState();
    harness.priorCallCount = 0;
    harness.calls.length = 0;
  });

  it("enforces numeric policy before any receipt reservation", async () => {
    const result = await reserveGovernedFlowActionAtomic(randomUUID(), flow, args(250.01));
    if ("error" in result) throw new Error(result.error);
    expect(result.policy).toMatchObject({ decision: "deny", reason: "required_evidence_missing" });
    expect(result.reservation).toBeUndefined();
    expect(harness.calls.some(({ sql }) => sql.includes("INSERT INTO flow_action_receipts"))).toBe(false);
    expect(harness.calls.some(({ sql }) => sql.includes("append_flow_action_policy_decision"))).toBe(true);
  });

  it("invalidates confirmation when locked Flow state advances", async () => {
    const callId = randomUUID();
    const first = await reserveGovernedFlowActionAtomic(callId, flow, args());
    if ("error" in first) throw new Error(first.error);
    expect(first.policy.decision).toBe("require_confirmation");
    const confirmation = {
      proposal_digest: first.policy.proposalDigest,
      challenge_digest: first.policy.challengeDigest!,
      authority: "caller" as const,
      confirmed_at: "2026-07-21T11:59:30.000Z",
      evidence_sha256: H("c"),
      state_revision: first.policy.stateRevision,
      capability_epoch: first.policy.capabilityEpoch,
    };
    harness.state = {
      ...harness.state!,
      revision: harness.state!.revision + 1,
      updatedAt: "2026-07-21T11:59:45.000Z",
    };
    const second = await reserveGovernedFlowActionAtomic(callId, flow, { ...args(), confirmation });
    if ("error" in second) throw new Error(second.error);
    expect(second.policy).toMatchObject({ decision: "require_confirmation", reason: "fresh_confirmation_required" });
    expect(second.policy.proposalDigest).not.toBe(first.policy.proposalDigest);
    expect(second.reservation).toBeUndefined();
  });

  it("persists an allowed decision and its receipt in one transaction", async () => {
    const callId = randomUUID();
    const proposedArgs = args();
    const first = await reserveGovernedFlowActionAtomic(callId, flow, proposedArgs);
    if ("error" in first) throw new Error(first.error);
    const confirmedArgs = {
      ...args(),
      arguments: proposedArgs.arguments,
      confirmation: {
        proposal_digest: first.policy.proposalDigest,
        challenge_digest: first.policy.challengeDigest!,
        authority: "caller" as const,
        confirmed_at: "2026-07-21T11:59:30.000Z",
        evidence_sha256: H("c"),
        state_revision: first.policy.stateRevision,
        capability_epoch: first.policy.capabilityEpoch,
      },
    };
    harness.calls.length = 0;
    const allowed = await reserveGovernedFlowActionAtomic(callId, flow, confirmedArgs);
    if ("error" in allowed) throw new Error(allowed.error);
    expect(allowed.policy.decision).toBe("allow");
    expect(allowed.reservation).toMatchObject({ execute: true, replayed: false });
    expect(allowed.policy).not.toHaveProperty("evidence_sha256");
    const receiptInsert = harness.calls.findIndex(({ sql }) => sql.includes("INSERT INTO flow_action_receipts"));
    const decisionInsert = harness.calls.findIndex(({ sql }) => sql.includes("append_flow_action_policy_decision"));
    const commit = harness.calls.findIndex(({ sql }) => sql === "COMMIT");
    expect(receiptInsert).toBeGreaterThan(-1);
    expect(decisionInsert).toBeGreaterThan(receiptInsert);
    expect(commit).toBeGreaterThan(decisionInsert);
    const decisionParams = harness.calls[decisionInsert].params;
    expect(decisionParams).toHaveLength(22);
    expect(decisionParams[2]).toBe(allowed.reservation?.receipt.id);
    expect(decisionParams[9]).toBe(first.policy.stateRevision);
    expect(decisionParams[15]).toBe(hashFlowValue([]));
    expect(decisionParams[19]).toMatch(/^[a-f0-9]{64}$/);
    expect(decisionParams[20]).toBe(allowed.policy.decisionDigest);
  });

  it("uses the durable dispatch count for the policy call limit", async () => {
    harness.priorCallCount = 1;
    const result = await reserveGovernedFlowActionAtomic(randomUUID(), flow, args());
    if ("error" in result) throw new Error(result.error);
    expect(result.policy).toMatchObject({ decision: "deny", reason: "call_limit_reached" });
    expect(result.reservation).toBeUndefined();
  });

  it("binds coordinator scope and complete replay evidence before any reservation", async () => {
    const callId = randomUUID();
    const conversationId = randomUUID();
    const organizationId = randomUUID();
    const governedArgs = args();
    const result = await reserveGovernedFlowActionAtomic(
      callId,
      flow,
      governedArgs,
      { conversationId, organizationId },
    );
    if ("error" in result) throw new Error(result.error);

    const intent = harness.calls.find(({ sql }) =>
      sql.includes("reserve_conversation_call_action_intent"));
    expect(intent?.params).toEqual([
      governedArgs.receiptId,
      callId,
      conversationId,
      organizationId,
      governedArgs.invocationId,
      governedArgs.runtimeDigest,
      governedArgs.capabilityEpoch,
      governedArgs.tool,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      hashFlowValue(governedArgs.facts),
      hashFlowValue(governedArgs.receipts),
      null,
    ]);
    expect(harness.calls.findIndex(({ sql }) =>
      sql.includes("reserve_conversation_call_action_intent"))).toBeLessThan(
      harness.calls.findIndex(({ sql }) => sql.includes("append_flow_action_policy_decision")),
    );
  });
});

describe("flow action policy decision database contract", () => {
  const sql = readFileSync(new URL("../../migrations/035_flow_action_policy_decisions.sql", import.meta.url), "utf8");

  it("is append-only, default-deny, and append-function-only for runtime roles", () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.flow_action_policy_decisions/);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/FOR ALL TO hacc_backend USING \(false\) WITH CHECK \(false\)/);
    expect(sql).toMatch(/REVOKE ALL ON public\.flow_action_policy_decisions FROM PUBLIC/);
    expect(sql).toMatch(/SECURITY DEFINER SET search_path = pg_catalog, public/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.append_flow_action_policy_decision/);
    expect(sql).toMatch(/evaluation_time < date_trunc\('milliseconds', transaction_timestamp\(\)\)/);
    expect(sql).toMatch(/previous_call_count <> authoritative_call_count/);
  });

  it("binds reservations and bounded hash-only evidence", () => {
    expect(sql).toMatch(/FOREIGN KEY \(reservation_receipt_id, call_id\)/);
    expect(sql).toMatch(/reservation_receipt_id IS NULL OR decision = 'allow'/);
    expect(sql).toMatch(/jsonb_array_length\(evidence_sha256\) <= 256/);
    expect(sql).toMatch(/receipt\.capability_epoch <> flow_capability_epoch/);
  });
});

describe("036 conversation-scoped action intent contract", () => {
  const sql = readFileSync(
    new URL("../../migrations/036_conversation_call_action_intents.sql", import.meta.url),
    "utf8",
  );

  it("locks the unique call attachment before admitting coordinator action authority", () => {
    expect(sql).toMatch(/FROM public\.voice_conversation_calls\s+WHERE call_id = call_identity\s+FOR KEY SHARE/);
    expect(sql).toMatch(/binding\.conversation_id <> conversation_identity/);
    expect(sql).toMatch(/binding\.org_id <> organization_identity/);
    expect(sql).toMatch(/MESSAGE = 'conversation_call_action_scope_mismatch'/);
    expect(sql).toMatch(/FOREIGN KEY \(conversation_id, call_id\)/);
    expect(sql).toMatch(/FOREIGN KEY \(conversation_id, org_id\)/);
  });

  it("accepts only an exact replay of policy, arguments, facts, receipts, and confirmation", () => {
    expect(sql).toMatch(/intent\.policy_digest <> policy_sha256/);
    expect(sql).toMatch(/intent\.arguments_sha256 <> arguments_digest/);
    expect(sql).toMatch(/intent\.facts_sha256 <> facts_digest/);
    expect(sql).toMatch(/intent\.receipts_sha256 <> receipts_digest/);
    expect(sql).toMatch(/intent\.confirmation_sha256 IS DISTINCT FROM confirmation_digest/);
    expect(sql).toMatch(/MESSAGE = 'conversation_call_action_replay_conflict'/);
    expect(sql).toMatch(/UNIQUE \(call_id, invocation_id\)/);
  });

  it("keeps the intent ledger append-only and exposes only the admission function", () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.conversation_call_action_intents/);
    expect(sql).toMatch(/ALTER TABLE public\.conversation_call_action_intents FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/REVOKE ALL ON public\.conversation_call_action_intents FROM PUBLIC/);
    expect(sql).toMatch(/SECURITY DEFINER SET search_path = pg_catalog, public/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.reserve_conversation_call_action_intent/);
  });
});
