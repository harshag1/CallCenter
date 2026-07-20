import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  q: vi.fn(),
}));

vi.mock("../db", () => ({
  getPool: mocks.getPool,
  q: mocks.q,
}));

import {
  executeConfirmedOperatorAction,
  operatorActionArgumentsSha256,
  type FundedOperatorCapability,
} from "../agent/tools/operator-capability-policy";
import type { ToolCtx } from "../agent/types";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000002";
const THREAD_ID = "00000000-0000-4000-8000-000000000003";
const APPROVAL_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000005";
const ACTOR = "operator@example.test";
const TOKEN = "confirm_0123456789abcdef0123456789abcdef";
const IDEMPOTENCY_KEY = APPROVAL_ID;

type Role = "basic" | "operator" | "admin";
type ExecutionStatus = "reserved" | "dispatching" | "succeeded" | "indeterminate";

type Policy = Readonly<{
  enabled: boolean;
  dailyActionLimit: number;
  dailySpendLimitMicroUsd: number;
}>;

type Approval = {
  id: string;
  orgId: string;
  actorEmail: string;
  threadId: string;
  capability: FundedOperatorCapability;
  argumentsSha256: string;
  tokenSha256: string;
  estimatedUnits: number;
  estimatedMicroUsd: number;
  consumedExecutionId: string | null;
  expiresAt: string;
};

type Execution = {
  id: string;
  orgId: string;
  actorEmail: string;
  capability: FundedOperatorCapability;
  idempotencyKey: string;
  argumentsSha256: string;
  estimatedUnits: number;
  estimatedMicroUsd: number;
  status: ExecutionStatus;
  result: unknown;
};

type FakeDatabase = {
  memberships: Map<string, Role>;
  policies: Map<string, Policy>;
  approvals: Approval[];
  executions: Execution[];
  nextExecution: number;
};

function membershipKey(email: string, orgId: string): string {
  return `${email}\u0000${orgId}`;
}

function policyKey(orgId: string, capability: FundedOperatorCapability): string {
  return `${orgId}\u0000${capability}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function cloneExecutions(executions: Execution[]): Execution[] {
  return executions.map((execution) => ({
    ...execution,
    result: execution.result === null || execution.result === undefined
      ? execution.result
      : structuredClone(execution.result),
  }));
}

function installFakeDatabase() {
  const state: FakeDatabase = {
    memberships: new Map(),
    policies: new Map(),
    approvals: [],
    executions: [],
    nextExecution: 1,
  };
  let transactionSnapshot: Pick<FakeDatabase, "approvals" | "executions" | "nextExecution"> | null = null;

  const client = {
    query: vi.fn(async (rawSql: string, params: unknown[] = []) => {
      const sql = compactSql(rawSql);
      if (sql === "BEGIN") {
        transactionSnapshot = {
          approvals: state.approvals.map((approval) => ({ ...approval })),
          executions: cloneExecutions(state.executions),
          nextExecution: state.nextExecution,
        };
        return { rows: [], rowCount: 0 };
      }
      if (sql === "COMMIT") {
        transactionSnapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql === "ROLLBACK") {
        if (transactionSnapshot) {
          state.approvals = transactionSnapshot.approvals;
          state.executions = transactionSnapshot.executions;
          state.nextExecution = transactionSnapshot.nextExecution;
        }
        transactionSnapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT operator_role FROM users")) {
        const role = state.memberships.get(membershipKey(String(params[0]), String(params[1])));
        return { rows: role ? [{ operator_role: role }] : [], rowCount: role ? 1 : 0 };
      }
      if (sql.includes("FROM operator_action_policies") && sql.includes("FOR UPDATE")) {
        const policy = state.policies.get(policyKey(
          String(params[0]),
          String(params[1]) as FundedOperatorCapability
        ));
        return {
          rows: policy ? [{
            enabled: policy.enabled,
            daily_action_limit: policy.dailyActionLimit,
            daily_spend_limit_micro_usd: String(policy.dailySpendLimitMicroUsd),
          }] : [],
          rowCount: policy ? 1 : 0,
        };
      }
      if (sql === "SELECT clock_timestamp() AS now") {
        return { rows: [{ now: "2026-07-16T20:06:00.000Z" }], rowCount: 1 };
      }
      if (sql.includes("FROM operator_action_executions oe")
          && sql.includes("oe.idempotency_key = $3")) {
        const execution = state.executions.find((candidate) =>
          candidate.orgId === params[0]
          && candidate.capability === params[1]
          && candidate.idempotencyKey === params[2]
        );
        return {
          rows: execution ? (() => {
            const approval = state.approvals.find((candidate) =>
              candidate.consumedExecutionId === execution.id
              && candidate.orgId === execution.orgId
              && candidate.capability === execution.capability
            );
            return [{
              actor_email: execution.actorEmail,
              arguments_sha256: execution.argumentsSha256,
              estimated_units: execution.estimatedUnits,
              estimated_micro_usd: String(execution.estimatedMicroUsd),
              status: execution.status,
              has_result: execution.status === "succeeded",
              result: execution.result,
              approval_id: approval?.id ?? null,
              approval_actor_email: approval?.actorEmail ?? null,
              approval_thread_id: approval?.threadId ?? null,
            }];
          })() : [],
          rowCount: execution ? 1 : 0,
        };
      }
      if (sql.includes("COALESCE(sum(estimated_units)")) {
        const matching = state.executions.filter((execution) =>
          execution.orgId === params[0] && execution.capability === params[1]
        );
        return {
          rows: [{
            units: String(matching.reduce((sum, execution) => sum + execution.estimatedUnits, 0)),
            spend: String(matching.reduce((sum, execution) => sum + execution.estimatedMicroUsd, 0)),
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("SELECT id, expires_at FROM operator_action_approvals")) {
        const approval = state.approvals.find((candidate) =>
          candidate.id === params[0]
          && candidate.orgId === params[1]
          && candidate.actorEmail === params[2]
          && candidate.threadId === params[3]
          && candidate.capability === params[4]
          && candidate.argumentsSha256 === params[5]
          && candidate.tokenSha256 === params[6]
          && candidate.estimatedUnits === params[7]
          && candidate.estimatedMicroUsd === params[8]
          && candidate.consumedExecutionId === null
        );
        return {
          rows: approval ? [{ id: approval.id, expires_at: approval.expiresAt }] : [],
          rowCount: approval ? 1 : 0,
        };
      }
      if (sql.startsWith("INSERT INTO operator_action_executions")) {
        const id = `10000000-0000-4000-8000-${String(state.nextExecution++).padStart(12, "0")}`;
        state.executions.push({
          id,
          orgId: String(params[0]),
          actorEmail: String(params[1]),
          capability: String(params[2]) as FundedOperatorCapability,
          idempotencyKey: String(params[3]),
          argumentsSha256: String(params[4]),
          estimatedUnits: Number(params[5]),
          estimatedMicroUsd: Number(params[6]),
          status: "reserved",
          result: null,
        });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE operator_action_approvals")) {
        const approval = state.approvals.find((candidate) =>
          candidate.id === params[0] && candidate.consumedExecutionId === null
        );
        if (approval) approval.consumedExecutionId = String(params[1]);
        return { rows: approval ? [{ id: approval.id }] : [], rowCount: approval ? 1 : 0 };
      }
      if (sql.startsWith("INSERT INTO operator_action_cost_observations")) {
        return { rows: [{ id: "20000000-0000-4000-8000-000000000001" }], rowCount: 1 };
      }
      throw new Error(`Unhandled transactional SQL in policy test: ${sql}`);
    }),
    release: vi.fn(),
  };

  mocks.getPool.mockReturnValue({
    connect: vi.fn(async () => client),
  });
  mocks.q.mockImplementation(async (rawSql: string, params: unknown[] = []) => {
    const sql = compactSql(rawSql);
    if (sql.includes("SET status = 'dispatching'")) {
      const execution = state.executions.find((candidate) =>
        candidate.id === params[0]
        && candidate.orgId === params[1]
        && candidate.actorEmail === params[2]
        && candidate.status === "reserved"
      );
      if (execution) execution.status = "dispatching";
      return execution ? [{ id: execution.id }] : [];
    }
    if (sql.includes("SET status = 'succeeded'")) {
      const execution = state.executions.find((candidate) =>
        candidate.id === params[0]
        && candidate.orgId === params[1]
        && candidate.actorEmail === params[2]
        && candidate.status === "dispatching"
      );
      if (execution) {
        execution.status = "succeeded";
        execution.result = JSON.parse(String(params[3]));
      }
      return execution ? [{ id: execution.id }] : [];
    }
    if (sql.includes("SET status = 'indeterminate'")) {
      const execution = state.executions.find((candidate) =>
        candidate.id === params[0]
        && candidate.orgId === params[1]
        && candidate.actorEmail === params[2]
        && candidate.status === "dispatching"
      );
      if (execution) execution.status = "indeterminate";
      return execution ? [{ id: execution.id }] : [];
    }
    throw new Error(`Unhandled non-transactional SQL in policy test: ${sql}`);
  });

  function grantMembership(email = ACTOR, orgId = ORG_A, role: Role = "operator"): void {
    state.memberships.set(membershipKey(email, orgId), role);
  }

  function grantPolicy(
    orgId = ORG_A,
    capability: FundedOperatorCapability = "send_email",
    overrides: Partial<Policy> = {}
  ): void {
    state.policies.set(policyKey(orgId, capability), {
      enabled: true,
      dailyActionLimit: 100,
      dailySpendLimitMicroUsd: 1_000_000,
      ...overrides,
    });
  }

  function approve(
    argumentsValue: unknown,
    overrides: Partial<Omit<Approval, "id">> = {}
  ): void {
    const capability = overrides.capability ?? "send_email";
    state.approvals.push({
      id: overrides.orgId === undefined && state.approvals.length === 0
        ? APPROVAL_ID
        : `00000000-0000-4000-8001-${String(state.approvals.length + 1).padStart(12, "0")}`,
      orgId: ORG_A,
      actorEmail: ACTOR,
      threadId: THREAD_ID,
      capability,
      argumentsSha256: operatorActionArgumentsSha256(capability, argumentsValue),
      tokenSha256: sha256(TOKEN),
      estimatedUnits: 1,
      estimatedMicroUsd: 1_000,
      consumedExecutionId: null,
      expiresAt: "2099-07-16T20:10:00.000Z",
      ...overrides,
    });
  }

  function seedUsage(units: number, spend: number): void {
    state.executions.push({
      id: `seed-${state.executions.length + 1}`,
      orgId: ORG_A,
      actorEmail: ACTOR,
      capability: "send_email",
      idempotencyKey: `seed-usage-${state.executions.length + 1}`,
      argumentsSha256: "a".repeat(64),
      estimatedUnits: units,
      estimatedMicroUsd: spend,
      status: "succeeded",
      result: { seeded: true },
    });
  }

  return { state, client, grantMembership, grantPolicy, approve, seedUsage };
}

const ctx: ToolCtx = {
  orgId: ORG_A,
  email: ACTOR,
  agentId: null,
  origin: "https://operator.example.test",
  threadId: THREAD_ID,
};

function actionInput<T>(options: Readonly<{
  argumentsValue: unknown;
  dispatch: () => Promise<T>;
  confirmationToken?: string;
  approvalId?: string;
  idempotencyKey?: string;
  estimatedUnits?: number;
  estimatedMicroUsd?: number;
  context?: ToolCtx;
}>) {
  return {
    ctx: options.context ?? ctx,
    capability: "send_email" as const,
    argumentsValue: options.argumentsValue,
    confirmationToken: options.confirmationToken ?? TOKEN,
    approvalId: options.approvalId ?? APPROVAL_ID,
    idempotencyKey: options.idempotencyKey ?? IDEMPOTENCY_KEY,
    estimatedUnits: options.estimatedUnits ?? 1,
    estimatedMicroUsd: options.estimatedMicroUsd ?? 1_000,
    dispatch: options.dispatch,
  };
}

describe("operator capability policy security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed for missing membership, basic users, missing policies, and policies from another organization", async () => {
    const cases: Array<Readonly<{
      name: string;
      arrange: (harness: ReturnType<typeof installFakeDatabase>) => void;
      code: string;
    }>> = [
      { name: "missing membership", arrange: () => {}, code: "operator_role_required" },
      {
        name: "basic user",
        arrange: (harness) => {
          harness.grantMembership(ACTOR, ORG_A, "basic");
          harness.grantPolicy();
        },
        code: "operator_role_required",
      },
      {
        name: "missing policy",
        arrange: (harness) => harness.grantMembership(),
        code: "capability_policy_required",
      },
      {
        name: "cross-org policy",
        arrange: (harness) => {
          harness.grantMembership();
          harness.grantPolicy(ORG_B);
        },
        code: "capability_policy_required",
      },
    ];

    for (const testCase of cases) {
      vi.clearAllMocks();
      const harness = installFakeDatabase();
      testCase.arrange(harness);
      const dispatch = vi.fn(async () => ({ sent: true }));
      const outcome = await executeConfirmedOperatorAction(actionInput({
        argumentsValue: { case: testCase.name },
        dispatch,
      }));

      expect(outcome, testCase.name).toEqual({ ok: false, code: testCase.code });
      expect(dispatch, testCase.name).not.toHaveBeenCalled();
      expect(harness.state.executions, testCase.name).toHaveLength(0);
    }
  });

  it("requires a fresh approval bound to the exact organization, actor, capability, token, and arguments", async () => {
    const intendedArguments = { body: "approved", to: "member@example.test" };
    const mismatches: Array<Readonly<{
      name: string;
      approvalOverrides?: Partial<Omit<Approval, "id">>;
      attemptedArguments?: unknown;
      attemptedToken?: string;
    }>> = [
      { name: "arguments", attemptedArguments: { ...intendedArguments, body: "changed" } },
      { name: "token", attemptedToken: `${TOKEN}x` },
      { name: "organization", approvalOverrides: { orgId: ORG_B } },
      { name: "actor", approvalOverrides: { actorEmail: "other@example.test" } },
      { name: "capability", approvalOverrides: { capability: "send_sms" } },
    ];

    for (const mismatch of mismatches) {
      vi.clearAllMocks();
      const harness = installFakeDatabase();
      harness.grantMembership();
      harness.grantPolicy();
      harness.approve(intendedArguments, mismatch.approvalOverrides);
      const dispatch = vi.fn(async () => ({ sent: true }));

      const outcome = await executeConfirmedOperatorAction(actionInput({
        argumentsValue: mismatch.attemptedArguments ?? intendedArguments,
        confirmationToken: mismatch.attemptedToken,
        dispatch,
      }));

      expect(outcome, mismatch.name).toEqual({
        ok: false,
        code: "fresh_exact_confirmation_required",
      });
      expect(dispatch, mismatch.name).not.toHaveBeenCalled();
      expect(harness.state.executions, mismatch.name).toHaveLength(0);
      expect(harness.state.approvals[0]?.consumedExecutionId, mismatch.name).toBeNull();
    }
  });

  it("denies both action-unit and spend quota overflow before consuming approval", async () => {
    const quotaCases = [
      { name: "units", usedUnits: 2, usedSpend: 0, limitUnits: 2, limitSpend: 100_000 },
      { name: "spend", usedUnits: 0, usedSpend: 99_500, limitUnits: 10, limitSpend: 100_000 },
    ] as const;

    for (const quotaCase of quotaCases) {
      vi.clearAllMocks();
      const harness = installFakeDatabase();
      const argumentsValue = { quota: quotaCase.name };
      harness.grantMembership();
      harness.grantPolicy(ORG_A, "send_email", {
        dailyActionLimit: quotaCase.limitUnits,
        dailySpendLimitMicroUsd: quotaCase.limitSpend,
      });
      harness.seedUsage(quotaCase.usedUnits, quotaCase.usedSpend);
      harness.approve(argumentsValue);
      const dispatch = vi.fn(async () => ({ sent: true }));

      const outcome = await executeConfirmedOperatorAction(actionInput({
        argumentsValue,
        estimatedUnits: 1,
        estimatedMicroUsd: 1_000,
        dispatch,
      }));

      expect(outcome, quotaCase.name).toEqual({ ok: false, code: "daily_quota_exceeded" });
      expect(dispatch, quotaCase.name).not.toHaveBeenCalled();
      expect(harness.state.approvals[0]?.consumedExecutionId, quotaCase.name).toBeNull();
      expect(harness.state.executions, quotaCase.name).toHaveLength(1);
    }
  });

  it("dispatches once, durably settles, and replays the receipt without consuming another approval", async () => {
    const harness = installFakeDatabase();
    const firstArguments = { to: "member@example.test", body: "hello" };
    const canonicallyEquivalentArguments = { body: "hello", to: "member@example.test" };
    harness.grantMembership();
    harness.grantPolicy();
    harness.approve(firstArguments);
    const dispatch = vi.fn(async () => ({ messageId: "provider-message-1" }));

    const first = await executeConfirmedOperatorAction(actionInput({
      argumentsValue: firstArguments,
      dispatch,
    }));
    const replay = await executeConfirmedOperatorAction(actionInput({
      argumentsValue: canonicallyEquivalentArguments,
      dispatch,
    }));

    expect(first).toEqual({
      ok: true,
      replayed: false,
      value: { messageId: "provider-message-1" },
    });
    expect(replay).toEqual({
      ok: true,
      replayed: true,
      value: { messageId: "provider-message-1" },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      executionId: harness.state.executions[0]?.id,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(harness.state.executions).toHaveLength(1);
    expect(harness.state.executions[0]).toMatchObject({
      status: "succeeded",
      result: { messageId: "provider-message-1" },
    });
    const settlementSql = mocks.q.mock.calls
      .map(([sql]) => compactSql(String(sql)))
      .find((sql) => sql.includes("SET status = 'succeeded'"));
    expect(settlementSql).toContain("execution.capability = 'place_call'");
    expect(settlementSql).toContain("call.metadata->'delivery_receipt'->>'status' IN ('delivered','terminal_failure')");
    expect(settlementSql).toContain("call.metadata->'delivery_receipt'->>'evidence_source' = 'verified_status_webhook'");
    expect(settlementSql).toContain("$4::jsonb->'delivery'->>'evidence_source' = 'provider_create_response'");
    expect(settlementSql).toContain("call.metadata->'delivery_receipt'->>'provider_message_id' = $4::jsonb->'delivery'->>'provider_message_id'");
    expect(harness.state.approvals[0]?.consumedExecutionId).toBe(harness.state.executions[0]?.id);
  });

  it("rejects changed arguments reusing a settled idempotency key without a second dispatch", async () => {
    const harness = installFakeDatabase();
    const approvedArguments = { body: "approved", to: "member@example.test" };
    harness.grantMembership();
    harness.grantPolicy();
    harness.approve(approvedArguments);
    const dispatch = vi.fn(async () => ({ messageId: "provider-message-1" }));

    const first = await executeConfirmedOperatorAction(actionInput({
      argumentsValue: approvedArguments,
      dispatch,
    }));
    const conflict = await executeConfirmedOperatorAction(actionInput({
      argumentsValue: { ...approvedArguments, body: "attacker changed this" },
      dispatch,
    }));

    expect(first.ok).toBe(true);
    expect(conflict).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(harness.state.executions).toHaveLength(1);
  });

  it("does not let another operator replay an organization-scoped idempotency receipt", async () => {
    const harness = installFakeDatabase();
    const argumentsValue = { body: "approved", to: "member@example.test" };
    const otherContext: ToolCtx = { ...ctx, email: "other-operator@example.test" };
    harness.grantMembership();
    harness.grantMembership(otherContext.email, ORG_A, "operator");
    harness.grantPolicy();
    harness.approve(argumentsValue);
    const firstDispatch = vi.fn(async () => ({ messageId: "provider-message-1" }));
    const otherDispatch = vi.fn(async () => ({ messageId: "must-not-run" }));

    const first = await executeConfirmedOperatorAction(actionInput({
      argumentsValue,
      dispatch: firstDispatch,
    }));
    const crossActorReplay = await executeConfirmedOperatorAction(actionInput({
      argumentsValue,
      context: otherContext,
      dispatch: otherDispatch,
    }));

    expect(first.ok).toBe(true);
    expect(crossActorReplay).toEqual({ ok: false, code: "idempotency_actor_conflict" });
    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(otherDispatch).not.toHaveBeenCalled();
    expect(harness.state.executions).toHaveLength(1);
  });

  it("does not replay a consumed proposal receipt into another chat thread", async () => {
    const harness = installFakeDatabase();
    const argumentsValue = { body: "approved", to: "member@example.test" };
    harness.grantMembership();
    harness.grantPolicy();
    harness.approve(argumentsValue);
    const firstDispatch = vi.fn(async () => ({ messageId: "provider-message-1" }));
    const crossThreadDispatch = vi.fn(async () => ({ messageId: "must-not-run" }));

    const first = await executeConfirmedOperatorAction(actionInput({
      argumentsValue,
      dispatch: firstDispatch,
    }));
    const crossThreadReplay = await executeConfirmedOperatorAction(actionInput({
      argumentsValue,
      context: { ...ctx, threadId: OTHER_THREAD_ID },
      dispatch: crossThreadDispatch,
    }));

    expect(first.ok).toBe(true);
    expect(crossThreadReplay).toEqual({ ok: false, code: "idempotency_approval_conflict" });
    expect(firstDispatch).toHaveBeenCalledOnce();
    expect(crossThreadDispatch).not.toHaveBeenCalled();
    expect(harness.state.executions).toHaveLength(1);
  });

  it("marks a provider error indeterminate and permanently blocks redispatch of that key", async () => {
    const harness = installFakeDatabase();
    const argumentsValue = { body: "hello", to: "member@example.test" };
    harness.grantMembership();
    harness.grantPolicy();
    harness.approve(argumentsValue);
    const firstDispatch = vi.fn(async () => {
      throw new Error("provider timeout after request acceptance");
    });
    const retryDispatch = vi.fn(async () => ({ messageId: "must-not-run" }));

    const first = await executeConfirmedOperatorAction(actionInput({
      argumentsValue,
      dispatch: firstDispatch,
    }));
    const retry = await executeConfirmedOperatorAction(actionInput({
      argumentsValue,
      dispatch: retryDispatch,
    }));

    expect(first).toEqual({
      ok: false,
      code: "provider_outcome_indeterminate_do_not_retry",
    });
    expect(retry).toEqual({
      ok: false,
      code: "action_already_reserved_or_indeterminate",
    });
    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(retryDispatch).not.toHaveBeenCalled();
    expect(harness.state.executions).toHaveLength(1);
    expect(harness.state.executions[0]?.status).toBe("indeterminate");
  });

  it("does not reserve or dispatch an approval that is expired at the post-lock database clock", async () => {
    const harness = installFakeDatabase();
    const argumentsValue = { body: "hello", to: "member@example.test" };
    harness.grantMembership();
    harness.grantPolicy();
    harness.approve(argumentsValue, { expiresAt: "2026-07-16T20:05:59.999Z" });
    const dispatch = vi.fn(async () => ({ messageId: "must-not-run" }));

    const outcome = await executeConfirmedOperatorAction(actionInput({
      argumentsValue,
      dispatch,
    }));

    expect(outcome).toEqual({ ok: false, code: "fresh_exact_confirmation_required" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(harness.state.executions).toHaveLength(0);
    expect(harness.state.approvals[0]?.consumedExecutionId).toBeNull();
  });
});
