import { describe, expect, it, vi } from "vitest";
import { GovernedEffectCoordinator } from "../coordinator";
import type {
  AuthorityBinding,
  DispatchBoundaryResult,
  EffectDispatchOutcome,
  EffectReconciliationOutcome,
  GovernedEffectAdapter,
  GovernedEffectAuthority,
  GovernedEffectLease,
  GovernedEffectProposal,
  GovernedEffectReceipt,
  GovernedEffectStore,
  ReconciliationClaim,
  ReconciliationJob,
  ReserveAllowedInput,
  ReserveAllowedResult,
} from "../types";

const H = (character: string): string => character.repeat(64);
const AT = "2026-08-02T18:00:00.000Z";
const scope = Object.freeze({ subjectId: "call-01" });

const policy = Object.freeze({
  schema_version: 1,
  id: "test.effects",
  version: "1",
  default_decision: "deny",
  actions: [
    {
      action: "update_address",
      effect: "write",
      require_all: [{
        kind: "fact",
        fact_id: "caller.verified",
        operator: "equals",
        value: true,
        authorities: ["tool"],
      }],
      deny_if_any: [],
      postconditions: [{ kind: "argument", path: "status", operator: "equals", value: "applied" }],
      provider_visible_result_fields: ["status", "effective_at"],
    },
    {
      action: "lookup_address",
      effect: "read",
      require_all: [],
      deny_if_any: [],
      postconditions: [{ kind: "argument", path: "status", operator: "equals", value: "found" }],
      provider_visible_result_fields: ["status"],
    },
  ],
});

function authority(patch: Partial<GovernedEffectAuthority> = {}): GovernedEffectAuthority {
  return Object.freeze({
    stateHeadSha256: H("a"),
    stateRevision: 7,
    capabilityEpoch: 3,
    policy,
    facts: [{
      fact_id: "caller.verified",
      revision: 1,
      value: true,
      authority: "tool",
      observed_at: "2026-08-02T17:59:00.000Z",
      evidence_sha256: H("b"),
    }],
    receipts: [],
    priorCallCount: 0,
    ...patch,
  });
}

function binding(value = authority()): AuthorityBinding {
  return Object.freeze({
    stateHeadSha256: value.stateHeadSha256,
    stateRevision: value.stateRevision,
    capabilityEpoch: value.capabilityEpoch,
  });
}

function proposal(patch: Partial<GovernedEffectProposal> = {}): GovernedEffectProposal {
  return Object.freeze({
    scope,
    action: "update_address",
    arguments: Object.freeze({ postal_code: "94107" }),
    idempotencyKey: "turn-7:update-address",
    expectedAuthority: binding(),
    ...patch,
  });
}

class FakeStore implements GovernedEffectStore {
  currentAuthority = authority();
  readonly receipts = new Map<string, GovernedEffectReceipt>();
  readonly receiptByKey = new Map<string, string>();
  readonly jobs = new Map<string, ReconciliationJob>();
  readonly jobByReceipt = new Map<string, string>();
  reserveCalls = 0;
  repairCalls = 0;
  boundaryCalls = 0;
  settleCalls = 0;
  forceRepairResponses = 0;
  advanceAtBoundary = false;

  async readAuthority(): Promise<GovernedEffectAuthority> {
    return this.currentAuthority;
  }

  async reserveAllowed(input: ReserveAllowedInput): Promise<ReserveAllowedResult> {
    this.reserveCalls += 1;
    if (this.forceRepairResponses > 0) {
      this.forceRepairResponses -= 1;
      return { disposition: "repair_required", repairToken: `repair-${this.reserveCalls}` };
    }
    const current = binding(this.currentAuthority);
    if (current.stateHeadSha256 !== input.decision.state_head_sha256 ||
        current.stateRevision !== input.decision.state_revision ||
        current.capabilityEpoch !== input.decision.capability_epoch) {
      return { disposition: "stale_authority", current };
    }
    const key = `${input.scope.subjectId}:${input.proposal.idempotencyKey}`;
    const existingId = this.receiptByKey.get(key);
    if (existingId) {
      const existing = this.mustReceipt(existingId);
      if (existing.action !== input.proposal.action ||
          existing.argumentsSha256 !== input.decision.arguments_sha256 ||
          existing.proposalDigest !== input.decision.proposal_digest) {
        return {
          disposition: "idempotency_conflict",
          existingArgumentsSha256: existing.argumentsSha256,
        };
      }
      return {
        disposition: existing.status === "succeeded" || existing.status === "failed"
          ? "terminal_replay"
          : "in_flight_replay",
        receipt: existing,
      };
    }
    const receiptId = `receipt-${this.receipts.size + 1}`;
    const receipt: GovernedEffectReceipt = Object.freeze({
      receiptId,
      scopeId: input.scope.subjectId,
      invocationId: `invocation-${this.receipts.size + 1}`,
      idempotencyKey: input.proposal.idempotencyKey,
      action: input.proposal.action,
      effect: input.decision.effect as "read" | "write" | "opaque",
      argumentsSha256: input.decision.arguments_sha256,
      proposalDigest: input.decision.proposal_digest,
      policyDigest: input.decision.policy_digest,
      stateHeadSha256: input.decision.state_head_sha256,
      stateRevision: input.decision.state_revision,
      capabilityEpoch: input.decision.capability_epoch,
      status: "reserved",
      dispatchAttempts: 0,
    });
    const lease: GovernedEffectLease = Object.freeze({
      leaseId: `lease-${this.receipts.size + 1}`,
      action: input.proposal.action,
      effect: receipt.effect,
      argumentsSha256: receipt.argumentsSha256,
      proposalDigest: receipt.proposalDigest,
      policyDigest: receipt.policyDigest,
      decisionDigest: input.decision.decision_digest,
      stateHeadSha256: receipt.stateHeadSha256,
      stateRevision: receipt.stateRevision,
      capabilityEpoch: receipt.capabilityEpoch,
      expiresAt: input.leaseExpiresAt,
    });
    this.receipts.set(receiptId, receipt);
    this.receiptByKey.set(key, receiptId);
    return { disposition: "reserved", receipt, lease, dispatchOwner: true };
  }

  async repairBeforeDispatch(): Promise<Readonly<{ repaired: boolean }>> {
    this.repairCalls += 1;
    return { repaired: true };
  }

  async crossDispatchBoundary(input: Parameters<GovernedEffectStore["crossDispatchBoundary"]>[0]): Promise<DispatchBoundaryResult> {
    this.boundaryCalls += 1;
    const receipt = this.mustReceipt(input.receiptId);
    if (this.advanceAtBoundary) {
      this.currentAuthority = authority({
        stateHeadSha256: H("c"),
        stateRevision: this.currentAuthority.stateRevision + 1,
        capabilityEpoch: this.currentAuthority.capabilityEpoch + 1,
      });
    }
    const current = binding(this.currentAuthority);
    if (current.stateHeadSha256 !== input.expectedAuthority.stateHeadSha256 ||
        current.stateRevision !== input.expectedAuthority.stateRevision ||
        current.capabilityEpoch !== input.expectedAuthority.capabilityEpoch) {
      return { disposition: "stale_authority", current };
    }
    if (Date.parse(input.now) >= Date.parse(input.lease.expiresAt)) {
      return { disposition: "lease_expired", receipt };
    }
    if (receipt.dispatchStartedAt) return { disposition: "already_crossed", receipt };
    const started = Object.freeze({
      ...receipt,
      status: "dispatching" as const,
      dispatchAttempts: 1,
      dispatchStartedAt: input.now,
    });
    this.receipts.set(receipt.receiptId, started);
    return { disposition: "started", receipt: started };
  }

  async settle(input: Parameters<GovernedEffectStore["settle"]>[0]): Promise<GovernedEffectReceipt> {
    this.settleCalls += 1;
    const current = this.mustReceipt(input.receiptId);
    if (current.status === "succeeded" || current.status === "failed" || current.status === "indeterminate") {
      if (current.status === input.status && current.resultSha256 === input.resultSha256 &&
          current.errorCode === input.errorCode) return current;
      throw new Error("terminal receipt rewrite");
    }
    const receipt = Object.freeze({
      ...current,
      status: input.status,
      ...(input.resultSha256 ? { resultSha256: input.resultSha256 } : {}),
      ...(input.proofSha256 ? { proofSha256: input.proofSha256 } : {}),
      ...(input.providerVisibleResult ? { providerVisibleResult: input.providerVisibleResult } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      settledAt: input.now,
    });
    this.receipts.set(receipt.receiptId, receipt);
    return receipt;
  }

  async ensureIndeterminateReconciliation(
    input: Parameters<GovernedEffectStore["ensureIndeterminateReconciliation"]>[0],
  ): ReturnType<GovernedEffectStore["ensureIndeterminateReconciliation"]> {
    let receipt = this.mustReceipt(input.receiptId);
    if (receipt.status === "succeeded" || receipt.status === "failed") {
      return { disposition: "terminal", receipt };
    }
    if (receipt.status !== "indeterminate") {
      receipt = Object.freeze({
        ...receipt,
        status: "indeterminate" as const,
        ...(input.resultSha256 ? { resultSha256: input.resultSha256 } : {}),
        errorCode: input.errorCode,
        settledAt: input.now,
      });
      this.receipts.set(receipt.receiptId, receipt);
    }
    const existingId = this.jobByReceipt.get(input.receiptId);
    if (existingId) return { disposition: "indeterminate", receipt, job: this.mustJob(existingId) };
    const job: ReconciliationJob = Object.freeze({
      jobId: `job-${this.jobs.size + 1}`,
      receiptId: input.receiptId,
      scope: input.scope,
      invocationId: input.invocationId,
      idempotencyKey: input.idempotencyKey,
      action: input.action,
      arguments: input.arguments,
      argumentsSha256: input.argumentsSha256,
      policy: input.policy,
      preDispatchDecision: input.preDispatchDecision,
      attempt: 0,
      status: "queued",
    });
    this.jobs.set(job.jobId, job);
    this.jobByReceipt.set(job.receiptId, job.jobId);
    return { disposition: "indeterminate", receipt, job };
  }

  async claimReconciliation(jobId: string): Promise<ReconciliationClaim> {
    const job = this.mustJob(jobId);
    const receipt = this.mustReceipt(job.receiptId);
    if (job.status !== "queued" || job.attempt !== 0) {
      return { disposition: "not_claimable", job, receipt };
    }
    const claimed = Object.freeze({ ...job, attempt: 1 as const, status: "running" as const });
    this.jobs.set(jobId, claimed);
    return { disposition: "claimed", job: claimed };
  }

  async settleReconciliation(
    input: Parameters<GovernedEffectStore["settleReconciliation"]>[0],
  ): Promise<Readonly<{ job: ReconciliationJob; receipt: GovernedEffectReceipt }>> {
    const job = this.mustJob(input.jobId);
    if (job.status !== "running" || job.attempt !== 1) throw new Error("job is not running");
    const current = this.mustReceipt(input.receiptId);
    if (current.status !== "indeterminate") throw new Error("receipt is not indeterminate");
    const receipt = Object.freeze({
      ...current,
      status: input.disposition === "committed" ? "succeeded" as const
        : input.disposition === "absent" ? "failed" as const : "indeterminate" as const,
      ...(input.resultSha256 ? { resultSha256: input.resultSha256 } : {}),
      ...(input.proofSha256 ? { proofSha256: input.proofSha256 } : {}),
      ...(input.providerVisibleResult ? { providerVisibleResult: input.providerVisibleResult } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      settledAt: input.now,
    });
    const completed = Object.freeze({ ...job, status: "completed" as const });
    this.receipts.set(receipt.receiptId, receipt);
    this.jobs.set(job.jobId, completed);
    return { job: completed, receipt };
  }

  private mustReceipt(receiptId: string): GovernedEffectReceipt {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new Error(`missing receipt ${receiptId}`);
    return receipt;
  }

  private mustJob(jobId: string): ReconciliationJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`missing job ${jobId}`);
    return job;
  }
}

function adapter(input: Readonly<{
  action?: string;
  dispatch?: () => Promise<EffectDispatchOutcome>;
  reconcile?: () => Promise<EffectReconciliationOutcome>;
}> = {}): GovernedEffectAdapter & Readonly<{
  dispatch: ReturnType<typeof vi.fn<() => Promise<EffectDispatchOutcome>>>;
  reconcile: ReturnType<typeof vi.fn<() => Promise<EffectReconciliationOutcome>>>;
}> {
  return {
    action: input.action ?? "update_address",
    reconciliationEffect: "read",
    dispatch: vi.fn(input.dispatch ?? (async () => ({
      disposition: "completed",
      result: { status: "applied", effective_at: "2026-08-03", private_token: "never-project" },
    }))),
    reconcile: vi.fn(input.reconcile ?? (async () => ({ disposition: "unknown" }))),
  };
}

function coordinator(store: FakeStore, effectAdapter = adapter()): GovernedEffectCoordinator {
  return new GovernedEffectCoordinator({ store, adapters: [effectAdapter], now: () => AT });
}

describe("GovernedEffectCoordinator", () => {
  it("evaluates the current policy and rejects stale or denied proposals before reservation", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter();
    const runtime = coordinator(store, effectAdapter);

    await expect(runtime.execute(proposal({ expectedAuthority: { ...binding(), stateRevision: 6 } })))
      .resolves.toMatchObject({ disposition: "stale_authority" });
    store.currentAuthority = authority({ facts: [] });
    await expect(runtime.execute(proposal())).resolves.toMatchObject({
      disposition: "denied",
      decision: { reason: "required_evidence_missing" },
    });
    expect(store.reserveCalls).toBe(0);
    expect(effectAdapter.dispatch).not.toHaveBeenCalled();
  });

  it("persists reservation and boundary, projects safe fields, and replays without redispatch", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter();
    const runtime = coordinator(store, effectAdapter);

    const first = await runtime.execute(proposal());
    expect(first).toMatchObject({
      disposition: "succeeded",
      providerVisibleResult: { status: "applied", effective_at: "2026-08-03" },
      receipt: { dispatchAttempts: 1, status: "succeeded" },
    });
    expect(JSON.stringify(first)).not.toContain("never-project");
    const replay = await runtime.execute(proposal());
    expect(replay).toMatchObject({
      disposition: "succeeded",
      providerVisibleResult: { status: "applied", effective_at: "2026-08-03" },
    });
    expect(effectAdapter.dispatch).toHaveBeenCalledTimes(1);
    expect(store.boundaryCalls).toBe(1);
  });

  it("detaches exact action semantics from caller mutation before asynchronous admission", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter({
      dispatch: async () => ({ disposition: "completed", result: { status: "applied" } }),
    });
    const runtime = coordinator(store, effectAdapter);
    const mutableArguments = { postal_code: "94107", nested: { unit: "4A" } };
    const execution = runtime.execute(proposal({ arguments: mutableArguments }));
    mutableArguments.postal_code = "10001";
    mutableArguments.nested.unit = "ATTACK";

    await expect(execution).resolves.toMatchObject({ disposition: "succeeded" });
    expect(effectAdapter.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      arguments: { postal_code: "94107", nested: { unit: "4A" } },
    }));
  });

  it("fails closed on non-JSON action values before reading authority", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter();
    const invalid = proposal({ arguments: { amount: Number.NaN } });
    await expect(coordinator(store, effectAdapter).execute(invalid)).resolves.toEqual({
      disposition: "pre_dispatch_failed",
      reason: "invalid_arguments",
    });
    expect(store.reserveCalls).toBe(0);
    expect(effectAdapter.dispatch).not.toHaveBeenCalled();
  });

  it("denies an idempotency key reused with different payload semantics", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter();
    const runtime = coordinator(store, effectAdapter);
    await runtime.execute(proposal());

    const result = await runtime.execute(proposal({ arguments: { postal_code: "10001" } }));
    expect(result).toMatchObject({ disposition: "idempotency_conflict" });
    expect(effectAdapter.dispatch).toHaveBeenCalledTimes(1);
  });

  it("atomically rejects an epoch/revision advance at the dispatch boundary", async () => {
    const store = new FakeStore();
    store.advanceAtBoundary = true;
    const effectAdapter = adapter();
    const result = await coordinator(store, effectAdapter).execute(proposal());

    expect(result).toMatchObject({
      disposition: "stale_authority",
      current: { stateRevision: 8, capabilityEpoch: 4 },
      receipt: { status: "failed", dispatchAttempts: 0 },
    });
    expect(effectAdapter.dispatch).not.toHaveBeenCalled();
  });

  it("allows one bounded repair only before dispatch", async () => {
    const repairedStore = new FakeStore();
    repairedStore.forceRepairResponses = 1;
    const repairedAdapter = adapter();
    await expect(coordinator(repairedStore, repairedAdapter).execute(proposal()))
      .resolves.toMatchObject({ disposition: "succeeded" });
    expect(repairedStore.repairCalls).toBe(1);
    expect(repairedStore.reserveCalls).toBe(2);
    expect(repairedAdapter.dispatch).toHaveBeenCalledTimes(1);

    const exhaustedStore = new FakeStore();
    exhaustedStore.forceRepairResponses = 2;
    const exhaustedAdapter = adapter();
    await expect(coordinator(exhaustedStore, exhaustedAdapter).execute(proposal()))
      .resolves.toEqual({ disposition: "pre_dispatch_failed", reason: "pre_dispatch_repair_exhausted" });
    expect(exhaustedStore.repairCalls).toBe(1);
    expect(exhaustedAdapter.dispatch).not.toHaveBeenCalled();
  });

  it("expires a lease before provider I/O and settles the unopened reservation", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter();
    const times = [AT, "2026-08-02T18:00:20.000Z"];
    const runtime = new GovernedEffectCoordinator({
      store,
      adapters: [effectAdapter],
      now: () => times.shift() ?? times.at(-1) ?? AT,
      leaseTtlMs: 15_000,
    });
    await expect(runtime.execute(proposal())).resolves.toMatchObject({
      disposition: "failed",
      receipt: { status: "failed", dispatchAttempts: 0, errorCode: "lease_expired_before_dispatch" },
    });
    expect(effectAdapter.dispatch).not.toHaveBeenCalled();
  });

  it("never blindly retries after dispatch and creates exactly one reconciliation job", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter({ dispatch: async () => { throw new Error("lost response"); } });
    const runtime = coordinator(store, effectAdapter);

    const first = await runtime.execute(proposal());
    expect(first).toMatchObject({
      disposition: "indeterminate",
      receipt: { status: "indeterminate", dispatchAttempts: 1 },
      reconciliationJob: { status: "queued", attempt: 0 },
    });
    await expect(runtime.execute(proposal())).resolves.toMatchObject({
      disposition: "indeterminate",
      reconciliationJob: { jobId: "job-1" },
    });
    expect(effectAdapter.dispatch).toHaveBeenCalledTimes(1);
    expect(store.jobs).toHaveLength(1);
  });

  it("accepts authoritative absence as a terminal failure and preserves its proof", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter({
      dispatch: async () => ({
        disposition: "authoritatively_absent",
        proofSha256: H("f"),
        errorCode: "provider_rejected_before_commit",
      }),
    });
    const runtime = coordinator(store, effectAdapter);
    await expect(runtime.execute(proposal())).resolves.toMatchObject({
      disposition: "failed",
      receipt: {
        status: "failed",
        proofSha256: H("f"),
        errorCode: "provider_rejected_before_commit",
      },
    });
    await runtime.execute(proposal());
    expect(effectAdapter.dispatch).toHaveBeenCalledTimes(1);
    expect(store.jobs).toHaveLength(0);
  });

  it("admits one dispatch owner under concurrent exact-idempotency proposals", async () => {
    const store = new FakeStore();
    let release!: (outcome: EffectDispatchOutcome) => void;
    const pending = new Promise<EffectDispatchOutcome>((resolve) => { release = resolve; });
    const effectAdapter = adapter({ dispatch: async () => pending });
    const runtime = coordinator(store, effectAdapter);

    const firstPromise = runtime.execute(proposal());
    await vi.waitFor(() => expect(effectAdapter.dispatch).toHaveBeenCalledTimes(1));
    const second = await runtime.execute(proposal());
    expect(second).toMatchObject({ disposition: "in_flight", receipt: { dispatchAttempts: 1 } });
    release({ disposition: "completed", result: { status: "applied" } });
    await expect(firstPromise).resolves.toMatchObject({ disposition: "succeeded" });
    expect(effectAdapter.dispatch).toHaveBeenCalledTimes(1);
  });

  it("runs one read-only reconciliation and cannot claim it twice", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter({
      dispatch: async () => ({ disposition: "indeterminate", errorCode: "timeout" }),
      reconcile: async () => ({
        disposition: "committed",
        proofSha256: H("d"),
        result: { status: "applied", effective_at: "2026-08-03" },
      }),
    });
    const runtime = coordinator(store, effectAdapter);
    const execution = await runtime.execute(proposal());
    if (execution.disposition !== "indeterminate") throw new Error("expected indeterminate execution");

    await expect(runtime.runReconciliation(execution.reconciliationJob.jobId)).resolves.toMatchObject({
      disposition: "committed",
      job: { status: "completed", attempt: 1 },
      receipt: { status: "succeeded" },
    });
    await expect(runtime.runReconciliation(execution.reconciliationJob.jobId)).resolves.toMatchObject({
      disposition: "not_claimable",
      receipt: { status: "succeeded" },
    });
    expect(effectAdapter.reconcile).toHaveBeenCalledTimes(1);
  });

  it("quarantines a completed write when authority advances while it is in flight", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter({
      dispatch: async () => {
        store.currentAuthority = authority({ stateHeadSha256: H("e"), stateRevision: 8, capabilityEpoch: 4 });
        return { disposition: "completed", result: { status: "applied" } };
      },
    });
    const result = await coordinator(store, effectAdapter).execute(proposal());
    expect(result).toMatchObject({
      disposition: "indeterminate",
      receipt: { errorCode: "authority_advanced_after_decision" },
      reconciliationJob: { status: "queued" },
    });
  });

  it("atomically quarantines malformed post-boundary output instead of stranding dispatching", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter({
      dispatch: async () => ({ disposition: "completed", result: undefined as never }),
    });
    await expect(coordinator(store, effectAdapter).execute(proposal())).resolves.toMatchObject({
      disposition: "indeterminate",
      receipt: { status: "indeterminate", errorCode: "post_dispatch_exception" },
      reconciliationJob: { status: "queued" },
    });
    expect(effectAdapter.dispatch).toHaveBeenCalledTimes(1);
    expect(store.jobs).toHaveLength(1);
  });

  it("refuses to promote a reconciliation result that violates the frozen postcondition", async () => {
    const store = new FakeStore();
    const effectAdapter = adapter({
      dispatch: async () => ({ disposition: "indeterminate" }),
      reconcile: async () => ({
        disposition: "committed",
        proofSha256: H("9"),
        result: { status: "not_applied" },
      }),
    });
    const runtime = coordinator(store, effectAdapter);
    const execution = await runtime.execute(proposal());
    if (execution.disposition !== "indeterminate") throw new Error("expected indeterminate execution");
    await expect(runtime.runReconciliation(execution.reconciliationJob.jobId)).resolves.toMatchObject({
      disposition: "unknown",
      receipt: { status: "indeterminate", errorCode: "reconciliation_result_failed_frozen_policy" },
    });
  });

  it("fails a read safely without creating mutation reconciliation work", async () => {
    const store = new FakeStore();
    const readAdapter = adapter({
      action: "lookup_address",
      dispatch: async () => ({ disposition: "indeterminate", errorCode: "read_timeout" }),
    });
    const result = await coordinator(store, readAdapter).execute(proposal({
      action: "lookup_address",
      arguments: {},
      idempotencyKey: "turn-7:lookup-address",
    }));
    expect(result).toMatchObject({ disposition: "failed", receipt: { errorCode: "read_timeout" } });
    expect(store.jobs).toHaveLength(0);
    expect(readAdapter.dispatch).toHaveBeenCalledTimes(1);
  });
});
