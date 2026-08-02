import type {
  AuthorityBinding,
  DispatchBoundaryResult,
  GovernedEffectAuthority,
  GovernedEffectLease,
  GovernedEffectReceipt,
  GovernedEffectStore,
  IndeterminateRecoveryResult,
  ReconciliationClaim,
  ReconciliationJob,
  ReserveAllowedInput,
  ReserveAllowedResult,
} from "../../../governed-effect-runtime";

const H = (character: string): string => character.repeat(64);

export const STRESS_SCOPE = Object.freeze({ subjectId: "offline-stress" });

export const STRESS_POLICY = Object.freeze({
  schema_version: 1,
  id: "hacc.offline-stress.effects",
  version: "1",
  default_decision: "deny",
  actions: [{
    action: "stress.write",
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
    provider_visible_result_fields: ["status", "effect_id"],
  }],
});

export function stressAuthority(patch: Partial<GovernedEffectAuthority> = {}): GovernedEffectAuthority {
  return Object.freeze({
    stateHeadSha256: H("a"),
    stateRevision: 7,
    capabilityEpoch: 3,
    policy: STRESS_POLICY,
    facts: [Object.freeze({
      fact_id: "caller.verified",
      revision: 1,
      value: true,
      authority: "tool" as const,
      observed_at: "2026-08-02T18:00:00.000Z",
      evidence_sha256: H("b"),
    })],
    receipts: [],
    priorCallCount: 0,
    ...patch,
  });
}

export function authorityBinding(authority = stressAuthority()): AuthorityBinding {
  return Object.freeze({
    stateHeadSha256: authority.stateHeadSha256,
    stateRevision: authority.stateRevision,
    capabilityEpoch: authority.capabilityEpoch,
  });
}

function sameAuthority(left: AuthorityBinding, right: AuthorityBinding): boolean {
  return left.stateHeadSha256 === right.stateHeadSha256
    && left.stateRevision === right.stateRevision
    && left.capabilityEpoch === right.capabilityEpoch;
}

export class DeterministicEffectStore implements GovernedEffectStore {
  currentAuthority = stressAuthority();
  readonly receipts = new Map<string, GovernedEffectReceipt>();
  readonly receiptByKey = new Map<string, string>();
  readonly jobs = new Map<string, ReconciliationJob>();
  readonly jobByReceipt = new Map<string, string>();
  boundaryStale = false;
  dispatchBoundaryCrossings = 0;
  repairCalls = 0;

  async readAuthority(): Promise<GovernedEffectAuthority> {
    return this.currentAuthority;
  }

  async reserveAllowed(input: ReserveAllowedInput): Promise<ReserveAllowedResult> {
    const current = authorityBinding(this.currentAuthority);
    const decisionBinding: AuthorityBinding = {
      stateHeadSha256: input.decision.state_head_sha256,
      stateRevision: input.decision.state_revision,
      capabilityEpoch: input.decision.capability_epoch,
    };
    if (!sameAuthority(current, decisionBinding)) return { disposition: "stale_authority", current };

    const key = `${input.scope.subjectId}:${input.proposal.idempotencyKey}`;
    const existingId = this.receiptByKey.get(key);
    if (existingId) {
      const existing = this.mustReceipt(existingId);
      if (existing.action !== input.proposal.action
        || existing.argumentsSha256 !== input.decision.arguments_sha256
        || existing.proposalDigest !== input.decision.proposal_digest) {
        return { disposition: "idempotency_conflict", existingArgumentsSha256: existing.argumentsSha256 };
      }
      return {
        disposition: existing.status === "succeeded" || existing.status === "failed"
          ? "terminal_replay"
          : "in_flight_replay",
        receipt: existing,
      };
    }

    const ordinal = this.receipts.size + 1;
    const receipt: GovernedEffectReceipt = Object.freeze({
      receiptId: `receipt-${ordinal}`,
      scopeId: input.scope.subjectId,
      invocationId: `invocation-${ordinal}`,
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
      leaseId: `lease-${ordinal}`,
      action: receipt.action,
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
    this.receipts.set(receipt.receiptId, receipt);
    this.receiptByKey.set(key, receipt.receiptId);
    return { disposition: "reserved", receipt, lease, dispatchOwner: true };
  }

  async repairBeforeDispatch(): Promise<Readonly<{ repaired: boolean }>> {
    this.repairCalls += 1;
    return { repaired: true };
  }

  async crossDispatchBoundary(
    input: Parameters<GovernedEffectStore["crossDispatchBoundary"]>[0],
  ): Promise<DispatchBoundaryResult> {
    const receipt = this.mustReceipt(input.receiptId);
    if (this.boundaryStale) {
      this.boundaryStale = false;
      this.currentAuthority = stressAuthority({
        stateHeadSha256: H("c"),
        stateRevision: this.currentAuthority.stateRevision + 1,
        capabilityEpoch: this.currentAuthority.capabilityEpoch + 1,
      });
    }
    const current = authorityBinding(this.currentAuthority);
    if (!sameAuthority(current, input.expectedAuthority)) return { disposition: "stale_authority", current };
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
    this.dispatchBoundaryCrossings += 1;
    return { disposition: "started", receipt: started };
  }

  async settle(input: Parameters<GovernedEffectStore["settle"]>[0]): Promise<GovernedEffectReceipt> {
    const current = this.mustReceipt(input.receiptId);
    if (["succeeded", "failed", "indeterminate"].includes(current.status)) {
      if (current.status === input.status
        && current.resultSha256 === input.resultSha256
        && current.errorCode === input.errorCode) return current;
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
  ): Promise<IndeterminateRecoveryResult> {
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
    const existingJobId = this.jobByReceipt.get(receipt.receiptId);
    if (existingJobId) {
      return { disposition: "indeterminate", receipt, job: this.mustJob(existingJobId) };
    }
    const job: ReconciliationJob = Object.freeze({
      jobId: `job-${this.jobs.size + 1}`,
      receiptId: receipt.receiptId,
      scope: input.scope,
      invocationId: input.invocationId,
      idempotencyKey: input.idempotencyKey,
      action: input.action,
      arguments: input.arguments,
      argumentsSha256: input.argumentsSha256,
      policy: input.policy,
      preDispatchDecision: input.preDispatchDecision,
      attempt: 0,
      maxAttempts: input.maxClaimAttempts,
      status: "queued",
    });
    this.jobs.set(job.jobId, job);
    this.jobByReceipt.set(receipt.receiptId, job.jobId);
    return { disposition: "indeterminate", receipt, job };
  }

  async claimReconciliation(
    input: Parameters<GovernedEffectStore["claimReconciliation"]>[0],
  ): Promise<ReconciliationClaim> {
    const job = this.mustJob(input.jobId);
    const receipt = this.mustReceipt(job.receiptId);
    if (job.status === "completed") {
      return { disposition: "not_claimable", job, receipt };
    }
    if (job.status === "running" && job.activeClaim && Date.parse(input.now) < Date.parse(job.activeClaim.expiresAt)) {
      return { disposition: "not_claimable", job, receipt };
    }
    if (job.attempt >= job.maxAttempts) return { disposition: "exhausted", job, receipt };
    const ordinal = job.attempt + 1;
    const claim = Object.freeze({
      claimId: `claim-${job.jobId}-${ordinal}`,
      ordinal,
      claimedAt: input.now,
      expiresAt: input.leaseExpiresAt,
    });
    const claimed = Object.freeze({
      ...job,
      attempt: ordinal,
      activeClaim: claim,
      status: "running" as const,
    });
    this.jobs.set(input.jobId, claimed);
    return { disposition: "claimed", job: claimed, claim };
  }

  async settleReconciliation(
    input: Parameters<GovernedEffectStore["settleReconciliation"]>[0],
  ): ReturnType<GovernedEffectStore["settleReconciliation"]> {
    const job = this.mustJob(input.jobId);
    const current = this.mustReceipt(job.receiptId);
    if (current.status === "succeeded" || current.status === "failed") {
      return { disposition: "terminal", job, receipt: current };
    }
    if (job.status !== "running" || !job.activeClaim || job.receiptId !== input.receiptId
      || job.activeClaim.claimId !== input.claimId || job.activeClaim.ordinal !== input.claimOrdinal) {
      return { disposition: "stale_claim", job, receipt: current };
    }
    const status = input.disposition === "committed" ? "succeeded" as const
      : input.disposition === "absent" ? "failed" as const
        : "indeterminate" as const;
    const receipt = Object.freeze({
      ...current,
      status,
      ...(input.proofSha256 ? { proofSha256: input.proofSha256 } : {}),
      ...(input.resultSha256 ? { resultSha256: input.resultSha256 } : {}),
      ...(input.providerVisibleResult ? { providerVisibleResult: input.providerVisibleResult } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      settledAt: input.now,
    });
    const completed = Object.freeze({ ...job, status: "completed" as const });
    this.receipts.set(receipt.receiptId, receipt);
    this.jobs.set(job.jobId, completed);
    return { disposition: "settled", job: completed, receipt };
  }

  mustReceipt(receiptId: string): GovernedEffectReceipt {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new Error(`missing receipt ${receiptId}`);
    return receipt;
  }

  mustJob(jobId: string): ReconciliationJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`missing job ${jobId}`);
    return job;
  }
}
