import { createHash } from "node:crypto";
import {
  evaluatePostDispatch,
  evaluatePreDispatch,
  type PreDispatchDecision,
} from "../action-policy-kernel";
import type {
  AuthorityBinding,
  GovernedEffectAdapter,
  GovernedEffectAuthority,
  GovernedEffectExecutionResult,
  GovernedEffectLease,
  GovernedEffectProposal,
  GovernedEffectReceipt,
  GovernedEffectStore,
  ReconciliationRunResult,
  ReserveAllowedResult,
} from "./types";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_IDEMPOTENCY_KEY_BYTES = 512;
const MAX_LEASE_TTL_MS = 60_000;

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === undefined) throw new Error("undefined is not valid canonical JSON");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite numbers are not valid canonical JSON");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error(`${typeof value} is not valid canonical JSON`);
  if (seen.has(value)) throw new Error("cyclic values are not valid canonical JSON");
  seen.add(value);
  if (Array.isArray(value)) {
    const encoded = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return encoded;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("only plain objects are valid canonical JSON");
  }
  const record = value as Record<string, unknown>;
  const encoded = `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return encoded;
}

function sha256(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonicalJson(value)}`, "utf8").digest("hex");
}

function deepFreezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function sameAuthority(left: AuthorityBinding, right: AuthorityBinding): boolean {
  return left.stateHeadSha256 === right.stateHeadSha256 &&
    left.stateRevision === right.stateRevision &&
    left.capabilityEpoch === right.capabilityEpoch;
}

function authorityBinding(authority: GovernedEffectAuthority): AuthorityBinding {
  return Object.freeze({
    stateHeadSha256: authority.stateHeadSha256,
    stateRevision: authority.stateRevision,
    capabilityEpoch: authority.capabilityEpoch,
  });
}

function assertCanonicalTime(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601`);
  }
  return milliseconds;
}

function assertReceiptBoundToDecision(
  receipt: GovernedEffectReceipt,
  proposal: GovernedEffectProposal,
  decision: PreDispatchDecision,
): void {
  if (receipt.scopeId !== proposal.scope.subjectId ||
      receipt.idempotencyKey !== proposal.idempotencyKey ||
      receipt.action !== proposal.action ||
      receipt.effect !== decision.effect ||
      receipt.argumentsSha256 !== decision.arguments_sha256 ||
      receipt.proposalDigest !== decision.proposal_digest ||
      receipt.policyDigest !== decision.policy_digest ||
      receipt.stateHeadSha256 !== decision.state_head_sha256 ||
      receipt.stateRevision !== decision.state_revision ||
      receipt.capabilityEpoch !== decision.capability_epoch) {
    throw new Error("governed effect store returned a receipt with mismatched authority or semantics");
  }
  if (!receipt.receiptId || !receipt.invocationId || !Number.isInteger(receipt.dispatchAttempts) ||
      receipt.dispatchAttempts < 0 || receipt.dispatchAttempts > 1) {
    throw new Error("governed effect store returned an invalid receipt");
  }
  if ((receipt.dispatchAttempts === 0) !== (receipt.dispatchStartedAt === undefined)) {
    throw new Error("governed effect receipt dispatch evidence is inconsistent");
  }
}

function assertLeaseBoundToDecision(
  lease: GovernedEffectLease,
  decision: PreDispatchDecision,
  nowMs: number,
): void {
  const expiresAtMs = assertCanonicalTime(lease.expiresAt, "effect lease expiry");
  if (!lease.leaseId || lease.action !== decision.action || lease.effect !== decision.effect ||
      lease.argumentsSha256 !== decision.arguments_sha256 ||
      lease.proposalDigest !== decision.proposal_digest ||
      lease.policyDigest !== decision.policy_digest ||
      lease.decisionDigest !== decision.decision_digest ||
      lease.stateHeadSha256 !== decision.state_head_sha256 ||
      lease.stateRevision !== decision.state_revision ||
      lease.capabilityEpoch !== decision.capability_epoch ||
      expiresAtMs <= nowMs || expiresAtMs - nowMs > MAX_LEASE_TTL_MS) {
    throw new Error("governed effect store returned an invalid or mismatched lease");
  }
}

function replayResult(receipt: GovernedEffectReceipt): GovernedEffectExecutionResult {
  if (receipt.status === "succeeded") {
    return Object.freeze({
      disposition: "succeeded",
      receipt,
      providerVisibleResult: receipt.providerVisibleResult ?? Object.freeze({}),
    });
  }
  if (receipt.status === "failed") return Object.freeze({ disposition: "failed", receipt });
  return Object.freeze({ disposition: "in_flight", receipt });
}

export class GovernedEffectCoordinator {
  readonly #store: GovernedEffectStore;
  readonly #adapters: ReadonlyMap<string, GovernedEffectAdapter>;
  readonly #now: () => string;
  readonly #leaseTtlMs: number;

  constructor(input: Readonly<{
    store: GovernedEffectStore;
    adapters: readonly GovernedEffectAdapter[];
    now?: () => string;
    leaseTtlMs?: number;
  }>) {
    const adapters = new Map<string, GovernedEffectAdapter>();
    for (const adapter of input.adapters) {
      if (!adapter.action || adapter.reconciliationEffect !== "read") {
        throw new Error("governed effect adapters require an action and a read-only reconciliation contract");
      }
      if (adapters.has(adapter.action)) throw new Error(`duplicate governed effect adapter: ${adapter.action}`);
      adapters.set(adapter.action, adapter);
    }
    const leaseTtlMs = input.leaseTtlMs ?? 15_000;
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1 || leaseTtlMs > MAX_LEASE_TTL_MS) {
      throw new Error(`effect lease TTL must be between 1 and ${MAX_LEASE_TTL_MS} milliseconds`);
    }
    this.#store = input.store;
    this.#adapters = adapters;
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#leaseTtlMs = leaseTtlMs;
  }

  async execute(inputProposal: GovernedEffectProposal): Promise<GovernedEffectExecutionResult> {
    if (!inputProposal.scope.subjectId || !inputProposal.idempotencyKey ||
        Buffer.byteLength(inputProposal.idempotencyKey, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES) {
      return Object.freeze({ disposition: "pre_dispatch_failed", reason: "invalid_execution_identity" });
    }
    let proposal: GovernedEffectProposal;
    try {
      // Detach execution semantics from caller-owned objects before the first asynchronous gap.
      // Parsing canonical JSON also rejects cycles, class instances, functions, and undefined.
      const argumentsClone = deepFreezeJson(
        JSON.parse(canonicalJson(inputProposal.arguments)) as GovernedEffectProposal["arguments"],
      );
      proposal = Object.freeze({
        ...structuredClone(inputProposal),
        scope: Object.freeze({ ...inputProposal.scope }),
        arguments: argumentsClone,
        expectedAuthority: Object.freeze({ ...inputProposal.expectedAuthority }),
        ...(inputProposal.confirmation
          ? { confirmation: Object.freeze(structuredClone(inputProposal.confirmation)) }
          : {}),
      });
    } catch {
      return Object.freeze({ disposition: "pre_dispatch_failed", reason: "invalid_arguments" });
    }

    const now = this.#now();
    const nowMs = assertCanonicalTime(now, "coordinator time");
    const authority = await this.#store.readAuthority(proposal.scope);
    const current = authorityBinding(authority);
    if (!sameAuthority(current, proposal.expectedAuthority)) {
      return Object.freeze({ disposition: "stale_authority", current });
    }

    const decision = evaluatePreDispatch({
      policy: authority.policy,
      action: proposal.action,
      arguments: proposal.arguments,
      state_head_sha256: authority.stateHeadSha256,
      state_revision: authority.stateRevision,
      capability_epoch: authority.capabilityEpoch,
      facts: authority.facts,
      receipts: authority.receipts,
      prior_call_count: authority.priorCallCount,
      confirmation: proposal.confirmation,
      now,
    });
    if (decision.decision !== "allow") {
      return Object.freeze({
        disposition: decision.decision === "require_confirmation" ? "confirmation_required" : "denied",
        decision,
      });
    }
    const allowedDecision = decision as PreDispatchDecision & Readonly<{ decision: "allow" }>;
    const adapter = this.#adapters.get(proposal.action);
    if (!adapter) return Object.freeze({ disposition: "pre_dispatch_failed", reason: "adapter_not_registered" });

    const leaseExpiresAt = new Date(nowMs + this.#leaseTtlMs).toISOString();
    let reservation: ReserveAllowedResult = await this.#store.reserveAllowed({
      scope: proposal.scope,
      proposal,
      decision: allowedDecision,
      leaseExpiresAt,
      now,
    });
    if (reservation.disposition === "repair_required") {
      const repaired = await this.#store.repairBeforeDispatch({
        scope: proposal.scope,
        idempotencyKey: proposal.idempotencyKey,
        repairToken: reservation.repairToken,
        now,
      });
      if (!repaired.repaired) {
        return Object.freeze({ disposition: "pre_dispatch_failed", reason: "pre_dispatch_repair_failed" });
      }
      // Exactly one retry is permitted here, before any dispatch boundary exists.
      reservation = await this.#store.reserveAllowed({
        scope: proposal.scope,
        proposal,
        decision: allowedDecision,
        leaseExpiresAt,
        now,
      });
      if (reservation.disposition === "repair_required") {
        return Object.freeze({ disposition: "pre_dispatch_failed", reason: "pre_dispatch_repair_exhausted" });
      }
    }
    if (reservation.disposition === "stale_authority") {
      return Object.freeze({ disposition: "stale_authority", current: reservation.current });
    }
    if (reservation.disposition === "idempotency_conflict") {
      return Object.freeze({
        disposition: "idempotency_conflict",
        existingArgumentsSha256: reservation.existingArgumentsSha256,
      });
    }
    if (reservation.disposition === "terminal_replay") {
      assertReceiptBoundToDecision(reservation.receipt, proposal, allowedDecision);
      return replayResult(reservation.receipt);
    }
    if (reservation.disposition === "in_flight_replay") {
      assertReceiptBoundToDecision(reservation.receipt, proposal, allowedDecision);
      if (reservation.receipt.status === "indeterminate") {
        const job = await this.#enqueueReconciliation(reservation.receipt, proposal, now);
        return Object.freeze({
          disposition: "indeterminate",
          receipt: reservation.receipt,
          reconciliationJob: job,
        });
      }
      return replayResult(reservation.receipt);
    }

    if (reservation.disposition !== "reserved") {
      throw new Error("governed effect store returned an unknown reservation disposition");
    }
    assertReceiptBoundToDecision(reservation.receipt, proposal, allowedDecision);
    assertLeaseBoundToDecision(reservation.lease, allowedDecision, nowMs);
    if (!reservation.dispatchOwner) return Object.freeze({ disposition: "in_flight", receipt: reservation.receipt });

    const boundaryTime = this.#now();
    assertCanonicalTime(boundaryTime, "dispatch boundary time");
    const boundary = await this.#store.crossDispatchBoundary({
      receiptId: reservation.receipt.receiptId,
      lease: reservation.lease,
      expectedAuthority: current,
      now: boundaryTime,
    });
    if (boundary.disposition === "stale_authority") {
      const receipt = await this.#store.settle({
        receiptId: reservation.receipt.receiptId,
        status: "failed",
        errorCode: "authority_stale_before_dispatch",
        now: boundaryTime,
      });
      return Object.freeze({ disposition: "stale_authority", current: boundary.current, receipt } as
        GovernedEffectExecutionResult & { receipt: GovernedEffectReceipt });
    }
    if (boundary.disposition === "lease_expired") {
      const receipt = await this.#store.settle({
        receiptId: reservation.receipt.receiptId,
        status: "failed",
        errorCode: "lease_expired_before_dispatch",
        now: boundaryTime,
      });
      return Object.freeze({ disposition: "failed", receipt });
    }
    if (boundary.disposition !== "started") {
      return Object.freeze({ disposition: "in_flight", receipt: boundary.receipt });
    }
    assertReceiptBoundToDecision(boundary.receipt, proposal, allowedDecision);
    if (boundary.receipt.dispatchAttempts !== 1 || !boundary.receipt.dispatchStartedAt) {
      throw new Error("dispatch boundary did not persist exactly one dispatch attempt");
    }

    let outcome;
    try {
      outcome = await adapter.dispatch({
        receiptId: boundary.receipt.receiptId,
        invocationId: boundary.receipt.invocationId,
        idempotencyKey: proposal.idempotencyKey,
        arguments: proposal.arguments,
      });
    } catch {
      return allowedDecision.effect === "read"
        ? this.#settleReadFailure(boundary.receipt, "dispatch_exception")
        : this.#settleIndeterminate(boundary.receipt, proposal, "dispatch_exception");
    }
    if (outcome.disposition === "authoritatively_absent") {
      if (!SHA256.test(outcome.proofSha256)) {
        return allowedDecision.effect === "read"
          ? this.#settleReadFailure(boundary.receipt, "invalid_absence_proof")
          : this.#settleIndeterminate(boundary.receipt, proposal, "invalid_absence_proof");
      }
      const receipt = await this.#store.settle({
        receiptId: boundary.receipt.receiptId,
        status: "failed",
        proofSha256: outcome.proofSha256,
        errorCode: outcome.errorCode ?? "authoritatively_absent",
        now: this.#now(),
      });
      return Object.freeze({ disposition: "failed", receipt });
    }
    if (outcome.disposition === "indeterminate") {
      return allowedDecision.effect === "read"
        ? this.#settleReadFailure(boundary.receipt, outcome.errorCode ?? "dispatch_indeterminate")
        : this.#settleIndeterminate(boundary.receipt, proposal, outcome.errorCode ?? "dispatch_indeterminate");
    }

    const settledAt = this.#now();
    const latest = await this.#store.readAuthority(proposal.scope);
    const post = evaluatePostDispatch({
      policy: latest.policy,
      pre_dispatch: allowedDecision,
      current_state_head_sha256: latest.stateHeadSha256,
      current_state_revision: latest.stateRevision,
      current_capability_epoch: latest.capabilityEpoch,
      result: outcome.result,
    });
    if (post.decision === "accept") {
      const receipt = await this.#store.settle({
        receiptId: boundary.receipt.receiptId,
        status: "succeeded",
        resultSha256: post.raw_result_sha256,
        providerVisibleResult: post.provider_result ?? {},
        now: settledAt,
      });
      return Object.freeze({ disposition: "succeeded", receipt, providerVisibleResult: post.provider_result ?? {} });
    }
    if (allowedDecision.effect === "read") {
      const receipt = await this.#store.settle({
        receiptId: boundary.receipt.receiptId,
        status: "failed",
        resultSha256: post.raw_result_sha256,
        errorCode: post.reason,
        now: settledAt,
      });
      return Object.freeze({ disposition: "failed", receipt });
    }
    // A write or opaque action has crossed the network boundary. A stale authority or malformed
    // result can never be converted into a safe retry; only read-back may resolve it.
    return this.#settleIndeterminate(boundary.receipt, proposal, post.reason, post.raw_result_sha256);
  }

  async #settleReadFailure(
    receipt: GovernedEffectReceipt,
    errorCode: string,
    resultSha256?: string,
  ): Promise<GovernedEffectExecutionResult> {
    const settled = await this.#store.settle({
      receiptId: receipt.receiptId,
      status: "failed",
      resultSha256,
      errorCode,
      now: this.#now(),
    });
    return Object.freeze({ disposition: "failed", receipt: settled });
  }

  async #settleIndeterminate(
    receipt: GovernedEffectReceipt,
    proposal: GovernedEffectProposal,
    errorCode: string,
    resultSha256?: string,
  ): Promise<GovernedEffectExecutionResult> {
    const now = this.#now();
    const settled = await this.#store.settle({
      receiptId: receipt.receiptId,
      status: "indeterminate",
      resultSha256,
      errorCode,
      now,
    });
    const job = await this.#enqueueReconciliation(settled, proposal, now);
    return Object.freeze({ disposition: "indeterminate", receipt: settled, reconciliationJob: job });
  }

  async #enqueueReconciliation(
    receipt: GovernedEffectReceipt,
    proposal: GovernedEffectProposal,
    now: string,
  ) {
    return this.#store.enqueueReconciliation({
      receiptId: receipt.receiptId,
      scope: proposal.scope,
      invocationId: receipt.invocationId,
      idempotencyKey: proposal.idempotencyKey,
      action: proposal.action,
      arguments: proposal.arguments,
      argumentsSha256: receipt.argumentsSha256,
      now,
    });
  }

  async runReconciliation(jobId: string): Promise<ReconciliationRunResult> {
    const now = this.#now();
    const claim = await this.#store.claimReconciliation(jobId, now);
    if (claim.disposition === "not_claimable") {
      return Object.freeze({
        disposition: "not_claimable",
        job: claim.job,
        receipt: claim.receipt,
      });
    }
    const adapter = this.#adapters.get(claim.job.action);
    if (!adapter || adapter.reconciliationEffect !== "read") {
      throw new Error("reconciliation adapter is missing or is not read-only");
    }
    let outcome;
    try {
      outcome = await adapter.reconcile({
        receiptId: claim.job.receiptId,
        invocationId: claim.job.invocationId,
        idempotencyKey: claim.job.idempotencyKey,
        arguments: claim.job.arguments,
      });
    } catch {
      outcome = Object.freeze({ disposition: "unknown", errorCode: "reconciliation_exception" } as const);
    }
    const resultSha256 = outcome.disposition === "committed"
      ? sha256("hacc/governed-effect-reconciliation-result/v1", outcome.result)
      : undefined;
    const proofSha256 = outcome.disposition === "unknown" ? undefined : outcome.proofSha256;
    const invalidProof = proofSha256 !== undefined && !SHA256.test(proofSha256);
    const disposition = invalidProof ? "unknown" as const : outcome.disposition;
    const settled = await this.#store.settleReconciliation({
      jobId: claim.job.jobId,
      receiptId: claim.job.receiptId,
      disposition,
      proofSha256: invalidProof ? undefined : proofSha256,
      resultSha256: disposition === "committed" ? resultSha256 : undefined,
      errorCode: invalidProof
        ? "invalid_reconciliation_proof"
        : outcome.disposition === "unknown" ? outcome.errorCode ?? "reconciliation_unknown" : undefined,
      now: this.#now(),
    });
    return Object.freeze({ disposition, job: settled.job, receipt: settled.receipt });
  }
}
