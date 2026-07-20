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
  approveOperatorActionProposal,
  executeConfirmedOperatorAction,
  operatorActionArgumentsSha256,
  proposeOperatorAction,
} from "../agent/tools/operator-capability-policy";
import type { ToolCtx } from "../agent/types";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-000000000002";
const PROPOSAL_ID = "00000000-0000-4000-8000-000000000003";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000004";
const ACTOR = "operator@example.test";
const DURABLE_RESULT = Object.freeze({
  status: "accepted",
  provider_message_id: "provider-message-1",
});

const ctx: ToolCtx = Object.freeze({
  orgId: ORG_ID,
  email: ACTOR,
  agentId: null,
  origin: "https://operator.example.test",
  threadId: THREAD_ID,
});

const actionArguments = Object.freeze({
  to: "member@example.test",
  subject: "Renewal",
  message: "Your renewal is ready.",
  brand: null,
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function proposalClient(options: Readonly<{
  row?: { id: string; expires_at: string } | null;
  error?: Error;
}> = {}) {
  const query = vi.fn(async (rawSql: string, params: unknown[] = []) => {
    void params;
    const sql = compactSql(rawSql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    }
    if (sql.startsWith("WITH scrubbed AS")) {
      if (options.error) throw options.error;
      const row = options.row === undefined
        ? { id: PROPOSAL_ID, expires_at: "2026-07-16T20:10:00.000Z" }
        : options.row;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`Unhandled proposal SQL: ${sql}`);
  });
  const release = vi.fn();
  mocks.getPool.mockReturnValue({ connect: vi.fn(async () => ({ query, release })) });
  return { query, release };
}

function approvalClient(options: Readonly<{
  proposal?: boolean;
  policyEnabled?: boolean;
  role?: string | null;
  existingExecution?: boolean;
  alreadyApproved?: boolean;
  consumedExecutionId?: string | null;
  executionStatus?: "reserved" | "dispatching" | "succeeded" | "indeterminate";
  executionActorEmail?: string;
  executionArgumentsSha256?: string;
  executionEstimatedUnits?: number;
  executionEstimatedMicroUsd?: string;
  executionHasResult?: boolean;
  executionResult?: unknown;
  expiresAt?: string;
  clockNow?: string;
}> = {}) {
  const argumentsSha256 = operatorActionArgumentsSha256("send_email", actionArguments);
  const executionStatus = options.executionStatus ?? "succeeded";
  const executionResult = options.executionResult === undefined ? DURABLE_RESULT : options.executionResult;
  const query = vi.fn(async (rawSql: string, params: unknown[] = []) => {
    const sql = compactSql(rawSql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT operator_role FROM users")) {
      const role = options.role === undefined ? "operator" : options.role;
      return role
        ? { rows: [{ operator_role: role }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT capability, action_arguments")) {
      if (options.proposal === false) return { rows: [], rowCount: 0 };
      expect(params).toEqual([PROPOSAL_ID, ORG_ID, ACTOR, THREAD_ID]);
      return {
        rows: [{
          capability: "send_email",
          action_arguments: actionArguments,
          arguments_sha256: argumentsSha256,
          estimated_units: 1,
          estimated_micro_usd: "1000",
          approved_at: options.alreadyApproved === undefined
            ? options.existingExecution ? "2026-07-16T20:05:00.000Z" : null
            : options.alreadyApproved ? "2026-07-16T20:05:00.000Z" : null,
          consumed_execution_id: options.consumedExecutionId === undefined
            ? options.existingExecution ? EXECUTION_ID : null
            : options.consumedExecutionId,
          expires_at: options.expiresAt ?? "2099-07-16T20:10:00.000Z",
        }],
        rowCount: 1,
      };
    }
    if (sql === "SELECT clock_timestamp() AS now") {
      return { rows: [{ now: options.clockNow ?? "2026-07-16T20:06:00.000Z" }], rowCount: 1 };
    }
    if (sql === "SELECT enabled FROM operator_action_policies WHERE org_id = $1 AND capability = $2") {
      return options.policyEnabled === false
        ? { rows: [{ enabled: false }], rowCount: 1 }
        : { rows: [{ enabled: true }], rowCount: 1 };
    }
    if (sql.includes("SELECT enabled, daily_action_limit, daily_spend_limit_micro_usd")) {
      return options.policyEnabled === false
        ? { rows: [{ enabled: false, daily_action_limit: 100, daily_spend_limit_micro_usd: "1000000" }], rowCount: 1 }
        : { rows: [{ enabled: true, daily_action_limit: 100, daily_spend_limit_micro_usd: "1000000" }], rowCount: 1 };
    }
    if (sql.includes("SELECT oe.actor_email") && sql.includes("FROM operator_action_executions oe")) {
      return options.existingExecution
        ? {
            rows: [{
              actor_email: options.executionActorEmail ?? ACTOR,
              arguments_sha256: options.executionArgumentsSha256 ?? argumentsSha256,
              estimated_units: options.executionEstimatedUnits ?? 1,
              estimated_micro_usd: options.executionEstimatedMicroUsd ?? "1000",
              status: executionStatus,
              has_result: options.executionHasResult ?? executionStatus === "succeeded",
              result: executionResult,
              approval_id: PROPOSAL_ID,
              approval_actor_email: ACTOR,
              approval_thread_id: THREAD_ID,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM operator_action_executions") && sql.includes("idempotency_key = $3")) {
      return options.existingExecution
        ? {
            rows: [{
              id: EXECUTION_ID,
              actor_email: options.executionActorEmail ?? ACTOR,
              arguments_sha256: options.executionArgumentsSha256 ?? argumentsSha256,
              estimated_units: options.executionEstimatedUnits ?? 1,
              estimated_micro_usd: options.executionEstimatedMicroUsd ?? "1000",
              status: executionStatus,
              has_result: options.executionHasResult ?? executionStatus === "succeeded",
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE operator_action_approvals")) {
      return { rows: [{ id: PROPOSAL_ID }], rowCount: 1 };
    }
    throw new Error(`Unhandled approval SQL: ${sql}`);
  });
  const release = vi.fn();
  mocks.getPool.mockReturnValue({ connect: vi.fn(async () => ({ query, release })) });
  return { query, release };
}

describe("operator action proposal and browser approval boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a token-free immutable proposal while storing canonical exact arguments", async () => {
    const { query } = proposalClient({ row: {
      id: PROPOSAL_ID,
      expires_at: "2026-07-16T20:10:00.000Z",
    } });

    const proposal = await proposeOperatorAction({
      ctx,
      capability: "send_email",
      argumentsValue: actionArguments,
      estimatedUnits: 1,
      estimatedMicroUsd: 1_000,
    });

    expect(proposal).toEqual({
      schemaVersion: 1,
      proposalId: PROPOSAL_ID,
      capability: "send_email",
      arguments: {
        brand: null,
        message: "Your renewal is ready.",
        subject: "Renewal",
        to: "member@example.test",
      },
      argumentsSha256: operatorActionArgumentsSha256("send_email", actionArguments),
      estimatedUnits: 1,
      worstCaseMicroUsd: 1_000,
      expiresAt: "2026-07-16T20:10:00.000Z",
    });
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(JSON.stringify(proposal)).not.toMatch(/confirmation|token|idempotency|execution/i);
    const insertion = query.mock.calls.find(([sql]) => compactSql(String(sql)).startsWith("WITH scrubbed AS"));
    const sql = insertion?.[0];
    const params = insertion?.[1];
    if (typeof sql !== "string" || !Array.isArray(params)) {
      throw new Error("expected proposal insertion with bound parameters");
    }
    expect(sql).toContain("INSERT INTO operator_action_approvals");
    expect(sql).not.toContain("token_sha256");
    expect(params).toEqual([
      ACTOR,
      ORG_ID,
      THREAD_ID,
      "send_email",
      JSON.stringify(proposal.arguments),
      proposal.argumentsSha256,
      1,
      1_000,
      null,
      20,
    ]);
    expect(mocks.getPool).toHaveBeenCalledOnce();
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("stores private browser review data without returning it in the proposal", async () => {
    const { query } = proposalClient({ row: {
      id: PROPOSAL_ID,
      expires_at: "2026-07-16T20:10:00.000Z",
    } });

    const proposal = await proposeOperatorAction({
      ctx,
      capability: "run_campaign",
      argumentsValue: {
        action: "run_campaign",
        target_count: 2,
        target_set_sha256: "a".repeat(64),
      },
      privateDisplay: { targets: ["+14155550101", "+14155550102"] },
      estimatedUnits: 2,
      estimatedMicroUsd: 10_000_000,
    });

    expect(JSON.stringify(proposal)).not.toContain("+14155550101");
    expect(JSON.stringify(proposal)).not.toContain("+14155550102");
    expect("privateDisplay" in proposal).toBe(false);
    const insertion = query.mock.calls.find(([sql]) => compactSql(String(sql)).startsWith("WITH scrubbed AS"));
    const params = insertion?.[1];
    if (!Array.isArray(params)) {
      throw new Error("expected proposal insertion with bound parameters");
    }
    expect(params[8]).toBe(JSON.stringify({ targets: ["+14155550101", "+14155550102"] }));
  });

  it("fails proposal issuance closed without leaking database failures", async () => {
    proposalClient({ error: new Error("relation operator_action_approvals does not exist") });

    await expect(proposeOperatorAction({
      ctx,
      capability: "send_email",
      argumentsValue: actionArguments,
      estimatedUnits: 1,
      estimatedMicroUsd: 1_000,
    })).rejects.toMatchObject({
      code: "operator_action_proposal_unavailable",
    });
  });

  it("maps pool acquisition failures to the stable proposal-unavailable result", async () => {
    mocks.getPool.mockReturnValue({
      connect: vi.fn(async () => { throw new Error("connection string and host must not leak"); }),
    });

    await expect(proposeOperatorAction({
      ctx,
      capability: "send_email",
      argumentsValue: actionArguments,
      estimatedUnits: 1,
      estimatedMicroUsd: 1_000,
    })).rejects.toMatchObject({ code: "operator_action_proposal_unavailable" });
  });

  it("fails closed with the stable code when the pool cannot issue a client", async () => {
    mocks.getPool.mockReturnValue({
      connect: vi.fn(async () => {
        throw new Error("private connection failure");
      }),
    });

    await expect(proposeOperatorAction({
      ctx,
      capability: "send_email",
      argumentsValue: actionArguments,
      estimatedUnits: 1,
      estimatedMicroUsd: 1_000,
    })).rejects.toEqual(expect.objectContaining({
      code: "operator_action_proposal_unavailable",
      message: "operator_action_proposal_unavailable",
    }));
  });

  it("rejects an invalid tenant or thread before any database access", async () => {
    await expect(proposeOperatorAction({
      ctx: { ...ctx, threadId: "attacker-controlled-thread" },
      capability: "send_email",
      argumentsValue: actionArguments,
      estimatedUnits: 1,
      estimatedMicroUsd: 1_000,
    })).rejects.toMatchObject({
      code: "invalid_operator_action_context",
    });
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("mints approval authority only in the server stack and persists only its hash", async () => {
    const { query, release } = approvalClient();

    const approved = await approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID });

    expect(approved.approvalId).toBe(PROPOSAL_ID);
    expect(approved.idempotencyKey).toBe(PROPOSAL_ID);
    expect(approved.ctx).toBe(ctx);
    expect(approved.argumentsValue).toEqual(actionArguments);
    expect(approved.confirmationToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const issuance = query.mock.calls.find(([sql]) => compactSql(String(sql)).startsWith("UPDATE operator_action_approvals"));
    expect(issuance).toBeDefined();
    expect(compactSql(String(issuance![0]))).toContain(
      "approved_by IS NULL AND approved_at IS NULL AND token_sha256 IS NULL AND token_issued_at IS NULL",
    );
    const issuanceParams = issuance![1] as unknown[];
    expect(issuanceParams).toEqual([
      PROPOSAL_ID,
      ACTOR,
      sha256(approved.confirmationToken),
    ]);
    expect(JSON.stringify(issuanceParams)).not.toContain(approved.confirmationToken);
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
    const policyRead = query.mock.calls.find(([sql]) => compactSql(String(sql)).includes(
      "SELECT enabled FROM operator_action_policies"
    ));
    const executionRead = query.mock.calls.find(([sql]) => compactSql(String(sql)).includes(
      "FROM operator_action_executions"
    ));
    expect(compactSql(String(policyRead![0]))).not.toContain("FOR UPDATE");
    expect(compactSql(String(executionRead![0]))).not.toContain("FOR UPDATE");
    const membershipIndex = query.mock.calls.findIndex(([sql]) => compactSql(String(sql)).includes(
      "SELECT operator_role FROM users"
    ));
    const proposalIndex = query.mock.calls.findIndex(([sql]) => compactSql(String(sql)).includes(
      "SELECT capability, action_arguments"
    ));
    const policyIndex = query.mock.calls.findIndex(([sql]) => compactSql(String(sql)).includes(
      "SELECT enabled FROM operator_action_policies"
    ));
    const executionIndex = query.mock.calls.findIndex(([sql]) => compactSql(String(sql)).includes(
      "FROM operator_action_executions"
    ));
    const clockIndex = query.mock.calls.findIndex(([sql]) => compactSql(String(sql)) === (
      "SELECT clock_timestamp() AS now"
    ));
    const issuanceIndex = query.mock.calls.findIndex(([sql]) => compactSql(String(sql)).startsWith(
      "UPDATE operator_action_approvals"
    ));
    expect([membershipIndex, proposalIndex, policyIndex, executionIndex, clockIndex, issuanceIndex])
      .toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rechecks revocation and exact org/actor/thread/expiry binding before minting authority", async () => {
    const missing = approvalClient({ proposal: false });
    await expect(approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID }))
      .rejects.toMatchObject({
        code: "operator_action_proposal_unavailable",
      });
    expect(missing.query.mock.calls.some(([sql]) => compactSql(String(sql)).startsWith("UPDATE operator_action_approvals")))
      .toBe(false);

    vi.clearAllMocks();
    const revoked = approvalClient({ policyEnabled: false });
    await expect(approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID }))
      .rejects.toMatchObject({
        code: "capability_policy_required",
      });
    expect(revoked.query.mock.calls.some(([sql]) => compactSql(String(sql)).startsWith("UPDATE operator_action_approvals")))
      .toBe(false);
  });

  it("does not rotate a consumed action's stored token while preparing a receipt replay", async () => {
    const { query } = approvalClient({ existingExecution: true });

    const approved = await approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID });

    expect(approved.idempotencyKey).toBe(PROPOSAL_ID);
    expect(approved.confirmationToken).toBe("replay_only_no_confirmation_authority");
    expect(query.mock.calls.some(([sql]) => compactSql(String(sql)).startsWith("UPDATE operator_action_approvals")))
      .toBe(false);
    const executionRead = query.mock.calls.find(([sql]) => compactSql(String(sql)).includes(
      "FROM operator_action_executions"
    ));
    expect(compactSql(String(executionRead![0]))).not.toContain("FOR UPDATE");
  });

  it("reconstructs an exact succeeded receipt after proposal expiry without issuing authority or redispatching", async () => {
    const { query } = approvalClient({
      existingExecution: true,
      expiresAt: "2026-07-16T20:05:59.999Z",
      clockNow: "2026-07-16T20:06:00.000Z",
    });

    const approved = await approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID });
    const dispatch = vi.fn(async () => ({ status: "must-not-dispatch" }));
    const outcome = await executeConfirmedOperatorAction({ ...approved, dispatch });

    expect(outcome).toEqual({ ok: true, replayed: true, value: DURABLE_RESULT });
    expect(approved.confirmationToken).toBe("replay_only_no_confirmation_authority");
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => compactSql(String(sql)).startsWith("UPDATE operator_action_approvals")))
      .toBe(false);
    expect(query).not.toHaveBeenCalledWith("SELECT clock_timestamp() AS now");
    expect(query).toHaveBeenCalledWith("COMMIT");
    const proposalRead = query.mock.calls.find(([sql]) => compactSql(String(sql)).includes(
      "SELECT capability, action_arguments"
    ));
    expect(compactSql(String(proposalRead![0]))).toContain(
      "WHERE id = $1 AND org_id = $2 AND actor_email = $3 AND thread_id = $4 FOR UPDATE"
    );
    const executionRead = query.mock.calls.find(([sql]) => compactSql(String(sql)).includes(
      "FROM operator_action_executions"
    ));
    expect(compactSql(String(executionRead![0]))).toContain(
      "WHERE org_id = $1 AND capability = $2 AND idempotency_key = $3"
    );
    expect(executionRead![1]).toEqual([ORG_ID, "send_email", PROPOSAL_ID]);
  });

  it("makes the replay-only sentinel incapable of reserving a fresh execution", async () => {
    approvalClient({ existingExecution: true });
    const replayOnly = await approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID });
    const fresh = approvalClient();
    const dispatch = vi.fn(async () => ({ status: "must-not-dispatch" }));

    const outcome = await executeConfirmedOperatorAction({ ...replayOnly, dispatch });

    expect(outcome).toEqual({ ok: false, code: "fresh_exact_confirmation_required" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
    expect(fresh.query.mock.calls.some(([sql]) => compactSql(String(sql)).includes(
      "COALESCE(sum(estimated_units)"
    ))).toBe(false);
    expect(fresh.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("reconstructs a present JSON null result instead of confusing it with a missing SQL result", async () => {
    approvalClient({
      existingExecution: true,
      executionHasResult: true,
      executionResult: null,
      expiresAt: "2026-07-16T20:05:59.999Z",
    });
    const approved = await approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID });
    const dispatch = vi.fn(async (): Promise<null> => null);

    const outcome = await executeConfirmedOperatorAction<null>({ ...approved, dispatch });

    expect(outcome).toEqual({ ok: true, replayed: true, value: null });
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it.each(["reserved", "dispatching", "indeterminate"] as const)(
    "keeps an expired %s execution in a shaped do-not-retry state",
    async (executionStatus) => {
      const { query } = approvalClient({
        existingExecution: true,
        executionStatus,
        expiresAt: "2026-07-16T20:05:59.999Z",
        clockNow: "2026-07-16T20:06:00.000Z",
      });

      await expect(approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID }))
        .rejects.toMatchObject({ code: "approval_in_progress_or_outcome_unknown_do_not_retry" });

      expect(query.mock.calls.some(([sql]) => compactSql(String(sql)).startsWith("UPDATE operator_action_approvals")))
        .toBe(false);
      expect(query).not.toHaveBeenCalledWith("SELECT clock_timestamp() AS now");
      expect(query).toHaveBeenCalledWith("ROLLBACK");
    }
  );

  it.each([
    { name: "actor mismatch", options: { executionActorEmail: "other@example.test" } },
    { name: "argument mismatch", options: { executionArgumentsSha256: "a".repeat(64) } },
    { name: "unit mismatch", options: { executionEstimatedUnits: 2 } },
    { name: "cost mismatch", options: { executionEstimatedMicroUsd: "2000" } },
    { name: "unbound execution", options: { consumedExecutionId: null } },
    { name: "missing approval", options: { alreadyApproved: false } },
    { name: "missing durable result", options: { executionHasResult: false } },
  ])("does not reconstruct a succeeded receipt with $name", async ({ options }) => {
    const { query } = approvalClient({
      existingExecution: true,
      expiresAt: "2026-07-16T20:05:59.999Z",
      ...options,
    });

    await expect(approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID }))
      .rejects.toMatchObject({ code: "approval_in_progress_or_outcome_unknown_do_not_retry" });

    expect(query.mock.calls.some(([sql]) => compactSql(String(sql)).startsWith("UPDATE operator_action_approvals")))
      .toBe(false);
  });

  it("rechecks current role and policy before reconstructing an expired terminal receipt", async () => {
    const revokedRole = approvalClient({
      existingExecution: true,
      expiresAt: "2026-07-16T20:05:59.999Z",
      role: "basic",
    });
    await expect(approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID }))
      .rejects.toMatchObject({ code: "operator_role_required" });
    expect(revokedRole.query.mock.calls.some(([sql]) => compactSql(String(sql)).includes(
      "FROM operator_action_executions"
    ))).toBe(false);

    vi.clearAllMocks();
    const revokedPolicy = approvalClient({
      existingExecution: true,
      expiresAt: "2026-07-16T20:05:59.999Z",
      policyEnabled: false,
    });
    await expect(approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID }))
      .rejects.toMatchObject({ code: "capability_policy_required" });
    expect(revokedPolicy.query.mock.calls.some(([sql]) => compactSql(String(sql)).includes(
      "FROM operator_action_executions"
    ))).toBe(false);
  });

  it("does not rotate an already-issued token when the proposal is approved concurrently", async () => {
    const { query } = approvalClient({ alreadyApproved: true });

    await expect(approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID }))
      .rejects.toMatchObject({ code: "approval_in_progress_or_outcome_unknown_do_not_retry" });

    expect(query.mock.calls.some(([sql]) => compactSql(String(sql)).startsWith("UPDATE operator_action_approvals")))
      .toBe(false);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it.each([false, true])(
    "keeps an expired proposal without an exact terminal execution unavailable (already approved: %s)",
    async (alreadyApproved) => {
      const { query } = approvalClient({
        alreadyApproved,
        expiresAt: "2026-07-16T20:05:59.999Z",
        clockNow: "2026-07-16T20:06:00.000Z",
      });

      await expect(approveOperatorActionProposal({ ctx, proposalId: PROPOSAL_ID }))
        .rejects.toMatchObject({ code: "operator_action_proposal_unavailable" });

      const proposalRead = query.mock.calls.find(([sql]) => compactSql(String(sql)).includes(
        "FROM operator_action_approvals"
      ));
      expect(compactSql(String(proposalRead![0]))).not.toContain("expires_at > now()");
      expect(query).toHaveBeenCalledWith("SELECT clock_timestamp() AS now");
      expect(query.mock.calls.some(([sql]) => compactSql(String(sql)).startsWith("UPDATE operator_action_approvals")))
        .toBe(false);
      expect(query).toHaveBeenCalledWith("ROLLBACK");
    }
  );
});
