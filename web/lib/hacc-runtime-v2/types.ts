import type { ConfirmationEvidence, Json } from "../action-policy-kernel";
import type { AudibilityLedger, AudibilityLedgerEvent } from "../audibility-v2";
import type { VerifiedClaimGrantAuthority } from "../audibility-v2";
import type {
  ConversationProgramEventPayload,
  ConversationProgramLog,
  ConversationProgramProjection,
} from "../conversation-program";
import type { EvidenceTapV2, ProviderNormalizedPayload } from "../evidence-v2";
import type {
  GovernedEffectAdapter,
  GovernedEffectStore,
} from "../governed-effect-runtime";
import type {
  ProductionTurnContract,
  TurnContractSource,
} from "../runtime-control/turn-contract";

export const HACC_RUNTIME_COORDINATOR_V2_SCHEMA_VERSION = 2 as const;

export type HaccRuntimeSnapshotV2 = Readonly<{
  schemaVersion: typeof HACC_RUNTIME_COORDINATOR_V2_SCHEMA_VERSION;
  runtimeRevision: number;
  program: ConversationProgramLog;
  audibility: AudibilityLedger;
  contract: ProductionTurnContract;
}>;

export type HaccRuntimeMutationV2<T> = Readonly<{
  next: HaccRuntimeSnapshotV2;
  value: T;
}>;

/**
 * The store owns per-program serialization. `transact` must invoke the callback
 * exactly once while holding an exclusive conversation lease, and must publish
 * `next` atomically before resolving. It must never retry a callback that may
 * have crossed an external dispatch boundary.
 */
export interface HaccRuntimeStoreV2 {
  create(snapshot: HaccRuntimeSnapshotV2): Promise<"created" | "exists">;
  read(programId: string): Promise<HaccRuntimeSnapshotV2 | null>;
  transact<T>(
    programId: string,
    operation: (current: HaccRuntimeSnapshotV2) => Promise<HaccRuntimeMutationV2<T>>,
  ): Promise<T>;
}

export interface HaccTurnContractProjectorV2 {
  project(input: Readonly<{
    program: ConversationProgramProjection;
    audibility: AudibilityLedger;
  }>): TurnContractSource;
}

export interface HaccRuntimeCommitObserverV2 {
  onCommitted(snapshot: HaccRuntimeSnapshotV2): Promise<void> | void;
}

export type HaccRuntimeDependenciesV2 = Readonly<{
  store: HaccRuntimeStoreV2;
  contractProjector: HaccTurnContractProjectorV2;
  effectStore: GovernedEffectStore;
  effectAdapters: readonly GovernedEffectAdapter[];
  evidenceTap: EvidenceTapV2;
  onCommit?: HaccRuntimeCommitObserverV2;
  now?: () => string;
}>;

export type ContractBoundRequestV2 = Readonly<{
  expectedContractSha256: string;
}>;

export type ProgramEventRequestV2 = ContractBoundRequestV2 & Readonly<{
  eventId: string;
  payload: ConversationProgramEventPayload;
  occurredAt?: string;
}>;

export type EffectRequestV2 = ContractBoundRequestV2 & Readonly<{
  attemptId: string;
  action: string;
  arguments: Readonly<Record<string, Json>>;
  idempotencyKey: string;
  confirmation?: ConfirmationEvidence;
}>;

export type ReconciliationRequestV2 = ContractBoundRequestV2 & Readonly<{
  eventId: string;
  jobId: string;
}>;

export type AudibilityLedgerEventDraftV2 = AudibilityLedgerEvent extends infer Event
  ? Event extends unknown ? Omit<Event, "sequence" | "sessionId"> : never
  : never;

export type AudibilityEventRequestV2 = ContractBoundRequestV2 & Readonly<{
  event: AudibilityLedgerEventDraftV2;
}>;

export type ClaimGrantPreparationRequestV2 = ContractBoundRequestV2 & Readonly<{
  responseId: string;
  claimId: string;
  receiptId: string;
}>;

export type PreparedClaimGrantV2 = Readonly<{
  authority: VerifiedClaimGrantAuthority;
  evidenceSha256: string;
}>;

export type ProviderEventRequestV2 = ContractBoundRequestV2 & Readonly<{
  event: ProviderNormalizedPayload;
}>;

export type HaccRuntimeEffectResultV2 = Readonly<{
  snapshot: HaccRuntimeSnapshotV2;
  disposition:
    | "denied"
    | "confirmation_required"
    | "stale_authority"
    | "idempotency_conflict"
    | "pre_dispatch_failed"
    | "in_flight"
    | "succeeded"
    | "failed"
    | "indeterminate";
  receiptId: string | null;
  reconciliationJobId: string | null;
}>;

export type HaccRuntimeReconciliationResultV2 = Readonly<{
  snapshot: HaccRuntimeSnapshotV2;
  disposition: "committed" | "absent" | "unknown" | "not_claimable" | "exhausted" | "stale_claim" | "terminal";
  receiptId: string;
}>;
