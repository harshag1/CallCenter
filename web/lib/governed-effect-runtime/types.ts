import type {
  ConfirmationEvidence,
  Json,
  PolicyFact,
  PolicyReceipt,
  PreDispatchDecision,
} from "../action-policy-kernel";

export type GovernedEffectScope = Readonly<{
  subjectId: string;
}>;

export type AuthorityBinding = Readonly<{
  stateHeadSha256: string;
  stateRevision: number;
  capabilityEpoch: number;
}>;

export type GovernedEffectAuthority = AuthorityBinding & Readonly<{
  policy: unknown;
  facts: readonly PolicyFact[];
  receipts: readonly PolicyReceipt[];
  priorCallCount: number;
}>;

export type GovernedEffectProposal = Readonly<{
  scope: GovernedEffectScope;
  action: string;
  arguments: Readonly<Record<string, Json>>;
  idempotencyKey: string;
  expectedAuthority: AuthorityBinding;
  confirmation?: ConfirmationEvidence;
}>;

export type GovernedEffectLease = AuthorityBinding & Readonly<{
  leaseId: string;
  action: string;
  effect: "read" | "write" | "opaque";
  argumentsSha256: string;
  proposalDigest: string;
  policyDigest: string;
  decisionDigest: string;
  expiresAt: string;
}>;

export type GovernedEffectReceiptStatus =
  | "reserved"
  | "dispatching"
  | "succeeded"
  | "failed"
  | "indeterminate";

export type GovernedEffectReceipt = AuthorityBinding & Readonly<{
  receiptId: string;
  scopeId: string;
  invocationId: string;
  idempotencyKey: string;
  action: string;
  effect: "read" | "write" | "opaque";
  argumentsSha256: string;
  proposalDigest: string;
  policyDigest: string;
  status: GovernedEffectReceiptStatus;
  dispatchAttempts: number;
  dispatchStartedAt?: string;
  settledAt?: string;
  resultSha256?: string;
  proofSha256?: string;
  errorCode?: string;
  providerVisibleResult?: Readonly<Record<string, Json>>;
}>;

export type ReserveAllowedInput = Readonly<{
  scope: GovernedEffectScope;
  proposal: GovernedEffectProposal;
  decision: PreDispatchDecision & Readonly<{ decision: "allow" }>;
  leaseExpiresAt: string;
  now: string;
}>;

export type ReserveAllowedResult =
  | Readonly<{
      disposition: "reserved";
      receipt: GovernedEffectReceipt;
      lease: GovernedEffectLease;
      dispatchOwner: boolean;
    }>
  | Readonly<{
      disposition: "terminal_replay";
      receipt: GovernedEffectReceipt;
    }>
  | Readonly<{
      disposition: "in_flight_replay";
      receipt: GovernedEffectReceipt;
    }>
  | Readonly<{
      disposition: "idempotency_conflict";
      existingArgumentsSha256: string;
    }>
  | Readonly<{
      disposition: "stale_authority";
      current: AuthorityBinding;
    }>
  | Readonly<{
      disposition: "repair_required";
      repairToken: string;
    }>;

export type DispatchBoundaryResult =
  | Readonly<{ disposition: "started"; receipt: GovernedEffectReceipt }>
  | Readonly<{ disposition: "stale_authority"; current: AuthorityBinding }>
  | Readonly<{ disposition: "lease_expired" | "not_owner" | "already_crossed"; receipt: GovernedEffectReceipt }>;

export type ReconciliationJob = Readonly<{
  jobId: string;
  receiptId: string;
  scope: GovernedEffectScope;
  invocationId: string;
  idempotencyKey: string;
  action: string;
  arguments: Readonly<Record<string, Json>>;
  argumentsSha256: string;
  policy: unknown;
  preDispatchDecision: PreDispatchDecision & Readonly<{ decision: "allow" }>;
  attempt: 0 | 1;
  status: "queued" | "running" | "completed";
}>;

export type ReconciliationClaim = Readonly<{
  disposition: "claimed";
  job: ReconciliationJob & Readonly<{ attempt: 1; status: "running" }>;
}> | Readonly<{
  disposition: "not_claimable";
  job: ReconciliationJob;
  receipt: GovernedEffectReceipt;
}>;

export type IndeterminateRecoveryResult =
  | Readonly<{
      disposition: "indeterminate";
      receipt: GovernedEffectReceipt;
      job: ReconciliationJob;
    }>
  | Readonly<{
      /** A prior terminal settlement won the race and must never be rewritten. */
      disposition: "terminal";
      receipt: GovernedEffectReceipt;
    }>;

export interface GovernedEffectStore {
  /** Returns the current authoritative policy and state for this subject. */
  readAuthority(scope: GovernedEffectScope): Promise<GovernedEffectAuthority>;

  /**
   * Atomically compares the current authority, creates a short lease, and reserves an
   * idempotency key. Implementations must return `idempotency_conflict` when the same scoped
   * key is already bound to different action arguments or semantics.
   */
  reserveAllowed(input: ReserveAllowedInput): Promise<ReserveAllowedResult>;

  /**
   * Repairs only an unopened reservation. This operation must reject any receipt that has a
   * dispatch marker; the coordinator invokes it at most once per execute call.
   */
  repairBeforeDispatch(input: Readonly<{
    scope: GovernedEffectScope;
    idempotencyKey: string;
    repairToken: string;
    now: string;
  }>): Promise<Readonly<{ repaired: boolean }>>;

  /** Atomically validates the live authority and lease while writing the one-way marker. */
  crossDispatchBoundary(input: Readonly<{
    receiptId: string;
    lease: GovernedEffectLease;
    expectedAuthority: AuthorityBinding;
    now: string;
  }>): Promise<DispatchBoundaryResult>;

  /** Settlement is immutable; exact repeats may be returned, conflicting rewrites must fail. */
  settle(input: Readonly<{
    receiptId: string;
    status: "succeeded" | "failed" | "indeterminate";
    resultSha256?: string;
    proofSha256?: string;
    providerVisibleResult?: Readonly<Record<string, Json>>;
    errorCode?: string;
    now: string;
  }>): Promise<GovernedEffectReceipt>;

  /**
   * Atomically changes dispatching -> indeterminate and creates the unique reconciliation job.
   * It also repairs an already-indeterminate, jobless crash cut. A terminal winner is returned
   * unchanged and receives no job.
   */
  ensureIndeterminateReconciliation(input: Readonly<{
    receiptId: string;
    scope: GovernedEffectScope;
    invocationId: string;
    idempotencyKey: string;
    action: string;
    arguments: Readonly<Record<string, Json>>;
    argumentsSha256: string;
    policy: unknown;
    preDispatchDecision: PreDispatchDecision & Readonly<{ decision: "allow" }>;
    resultSha256?: string;
    errorCode: string;
    now: string;
  }>): Promise<IndeterminateRecoveryResult>;

  /** Claims the single permitted read-only attempt. Completed jobs are never claimable again. */
  claimReconciliation(jobId: string, now: string): Promise<ReconciliationClaim>;

  settleReconciliation(input: Readonly<{
    jobId: string;
    receiptId: string;
    disposition: "committed" | "absent" | "unknown";
    proofSha256?: string;
    resultSha256?: string;
    providerVisibleResult?: Readonly<Record<string, Json>>;
    errorCode?: string;
    now: string;
  }>): Promise<Readonly<{ job: ReconciliationJob; receipt: GovernedEffectReceipt }>>;
}

export type EffectDispatchOutcome =
  | Readonly<{ disposition: "completed"; result: Readonly<Record<string, Json>> }>
  | Readonly<{ disposition: "authoritatively_absent"; proofSha256: string; errorCode?: string }>
  | Readonly<{ disposition: "indeterminate"; errorCode?: string }>;

export type EffectReconciliationOutcome =
  | Readonly<{ disposition: "committed"; proofSha256: string; result: Readonly<Record<string, Json>> }>
  | Readonly<{ disposition: "absent"; proofSha256: string }>
  | Readonly<{ disposition: "unknown"; errorCode?: string }>;

export interface GovernedEffectAdapter {
  readonly action: string;
  /** Reconciliation is structurally read-only; mutation adapters are not accepted here. */
  readonly reconciliationEffect: "read";
  dispatch(input: Readonly<{
    receiptId: string;
    invocationId: string;
    idempotencyKey: string;
    arguments: Readonly<Record<string, Json>>;
  }>): Promise<EffectDispatchOutcome>;
  reconcile(input: Readonly<{
    receiptId: string;
    invocationId: string;
    idempotencyKey: string;
    arguments: Readonly<Record<string, Json>>;
  }>): Promise<EffectReconciliationOutcome>;
}

export type GovernedEffectExecutionResult =
  | Readonly<{ disposition: "denied" | "confirmation_required"; decision: PreDispatchDecision }>
  | Readonly<{ disposition: "stale_authority"; current: AuthorityBinding; receipt?: GovernedEffectReceipt }>
  | Readonly<{ disposition: "idempotency_conflict"; existingArgumentsSha256: string }>
  | Readonly<{ disposition: "pre_dispatch_failed"; reason: string }>
  | Readonly<{ disposition: "in_flight"; receipt: GovernedEffectReceipt }>
  | Readonly<{
      disposition: "succeeded";
      receipt: GovernedEffectReceipt;
      providerVisibleResult: Readonly<Record<string, Json>>;
    }>
  | Readonly<{ disposition: "failed"; receipt: GovernedEffectReceipt }>
  | Readonly<{
      disposition: "indeterminate";
      receipt: GovernedEffectReceipt;
      reconciliationJob: ReconciliationJob;
    }>;

export type ReconciliationRunResult = Readonly<{
  disposition: "committed" | "absent" | "unknown" | "not_claimable";
  job: ReconciliationJob;
  receipt: GovernedEffectReceipt;
}>;
