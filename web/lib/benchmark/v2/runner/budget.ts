import {
  admitDualEnvelopeSession,
  inspectDualEnvelopeBudgetLedger,
  recordDualEnvelopeTerminal,
  settleDualEnvelopeSession,
  type DualEnvelopeBudgetSnapshot,
  type NetworkAdmission,
  type TerminalOutcome,
} from "../budget/dual-envelope-budget";
import { sha256Hex } from "../../artifacts";
import type { ProofPhase, ScheduledUnit } from "./types";

export type BudgetSnapshot = Readonly<{
  testing_ceiling_micro_usd: number;
  benchmark_ceiling_micro_usd: number;
  testing_reserved_micro_usd: number;
  benchmark_reserved_micro_usd: number;
  testing_settled_micro_usd: number;
  benchmark_settled_micro_usd: number;
}>;

type Reservation = {
  phase: ProofPhase;
  maximum: number;
  opened: boolean;
  settled: boolean;
  conservativeSettled: number;
};

export interface DualBudgetAdmission {
  reserve(unit: ScheduledUnit): void;
  markOpened(unitId: string): void;
  settle(unitId: string, conservativeMicroUsd: number): void;
  cancelBeforeOpen(unitId: string): void;
  snapshot(): BudgetSnapshot;
}

/** Cannot be passed to the paid runner. It exists only for provider-free unit tests. */
export class TestOnlyInMemoryDualBudgetAdmission implements DualBudgetAdmission {
  readonly authority_kind = "test_only_in_memory_budget" as const;
  readonly #ceilings: Readonly<Record<ProofPhase, number>>;
  readonly #reservations = new Map<string, Reservation>();

  constructor(input: Readonly<{ testing_micro_usd: number; benchmark_micro_usd: number }>) {
    for (const value of Object.values(input)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("budget ceilings must be non-negative safe integers");
    }
    this.#ceilings = Object.freeze({
      testing: input.testing_micro_usd,
      benchmark: input.benchmark_micro_usd,
    });
  }

  reserve(unit: ScheduledUnit): void {
    if (this.#reservations.has(unit.unit_id)) throw new Error(`unit ${unit.unit_id} already has a budget reservation`);
    const exposure = [...this.#reservations.values()]
      .filter((entry) => entry.phase === unit.phase)
      .reduce((sum, entry) => sum + entry.maximum, 0);
    if (exposure + unit.maximum_micro_usd > this.#ceilings[unit.phase]) {
      throw new Error(`${unit.phase} budget admission denied`);
    }
    this.#reservations.set(unit.unit_id, {
      phase: unit.phase,
      maximum: unit.maximum_micro_usd,
      opened: false,
      settled: false,
      conservativeSettled: 0,
    });
  }

  markOpened(unitId: string): void {
    const reservation = this.#required(unitId);
    if (reservation.opened) throw new Error(`unit ${unitId} cannot open more than once`);
    if (reservation.settled) throw new Error(`unit ${unitId} is already terminal`);
    reservation.opened = true;
  }

  settle(unitId: string, conservativeMicroUsd: number): void {
    const reservation = this.#required(unitId);
    if (!reservation.opened || reservation.settled) throw new Error(`unit ${unitId} cannot settle from its current state`);
    if (!Number.isSafeInteger(conservativeMicroUsd)
      || conservativeMicroUsd < 0
      || conservativeMicroUsd > reservation.maximum) {
      throw new Error(`unit ${unitId} settlement exceeds its reservation`);
    }
    reservation.conservativeSettled = conservativeMicroUsd;
    reservation.settled = true;
  }

  cancelBeforeOpen(unitId: string): void {
    const reservation = this.#required(unitId);
    if (reservation.opened || reservation.settled) throw new Error(`unit ${unitId} cannot be cancelled before open`);
    reservation.settled = true;
  }

  snapshot(): BudgetSnapshot {
    const values = [...this.#reservations.values()];
    const reserved = (phase: ProofPhase) => values
      .filter((entry) => entry.phase === phase)
      .reduce((total, entry) => total + entry.maximum, 0);
    const settled = (phase: ProofPhase) => values
      .filter((entry) => entry.phase === phase)
      .reduce((total, entry) => total + entry.conservativeSettled, 0);
    return Object.freeze({
      testing_ceiling_micro_usd: this.#ceilings.testing,
      benchmark_ceiling_micro_usd: this.#ceilings.benchmark,
      testing_reserved_micro_usd: reserved("testing"),
      benchmark_reserved_micro_usd: reserved("benchmark"),
      testing_settled_micro_usd: settled("testing"),
      benchmark_settled_micro_usd: settled("benchmark"),
    });
  }

  #required(unitId: string): Reservation {
    const reservation = this.#reservations.get(unitId);
    if (!reservation) throw new Error(`unit ${unitId} has no budget reservation`);
    return reservation;
  }
}

export type PaidBillingEvidence = Readonly<{
  estimated_micro_usd: number;
  provider_reported_micro_usd: number;
  reconciled_micro_usd: number;
  reconciliation_evidence_sha256: string;
}>;

/**
 * Nominal production authority around the fsynced dual-envelope ledger and its
 * pinned standing aggregate. Paid orchestration requires an actual instance;
 * structural test doubles cannot be substituted.
 */
export class FilesystemDualEnvelopeBudget {
  readonly authority_kind = "filesystem_dual_envelope_standing_aggregate" as const;
  readonly #ledgerPath: string;
  readonly #standingAggregateLedgerPath: string;
  readonly #now?: () => Date;

  constructor(input: Readonly<{
    ledgerPath: string;
    standingAggregateLedgerPath: string;
    now?: () => Date;
  }>) {
    if (!input.ledgerPath || !input.standingAggregateLedgerPath) {
      throw new Error("production budget authority requires both durable ledger paths");
    }
    this.#ledgerPath = input.ledgerPath;
    this.#standingAggregateLedgerPath = input.standingAggregateLedgerPath;
    this.#now = input.now;
  }

  async admit(unit: ScheduledUnit, logicalSessionId: string): Promise<NetworkAdmission> {
    const result = await admitDualEnvelopeSession({
      ledgerPath: this.#ledgerPath,
      standingAggregateLedgerPath: this.#standingAggregateLedgerPath,
      operationId: `hacc-proof-admit:${unit.unit_id}`,
      sessionId: logicalSessionId,
      trialId: unit.unit_id,
      purpose: unit.phase === "testing" ? "api_testing" : "benchmark",
      provider: unit.identity.provider,
      model: unit.identity.model,
      maximumMicroUsd: unit.maximum_micro_usd,
      attempt: 1,
      retryOf: null,
      replacementFor: null,
      fallbackFrom: null,
      now: this.#now,
    });
    return result.value;
  }

  async terminal(unit: ScheduledUnit, logicalSessionId: string, outcome: TerminalOutcome): Promise<void> {
    await recordDualEnvelopeTerminal({
      ledgerPath: this.#ledgerPath,
      operationId: `hacc-proof-terminal:${unit.unit_id}`,
      sessionId: logicalSessionId,
      outcome,
      now: this.#now,
    });
  }

  async settle(unit: ScheduledUnit, logicalSessionId: string, evidence: PaidBillingEvidence): Promise<void> {
    await settleDualEnvelopeSession({
      ledgerPath: this.#ledgerPath,
      standingAggregateLedgerPath: this.#standingAggregateLedgerPath,
      operationId: `hacc-proof-settle:${unit.unit_id}`,
      sessionId: logicalSessionId,
      estimatedMicroUsd: evidence.estimated_micro_usd,
      providerReportedMicroUsd: evidence.provider_reported_micro_usd,
      reconciledMicroUsd: evidence.reconciled_micro_usd,
      reconciliationEvidenceSha256: evidence.reconciliation_evidence_sha256,
      now: this.#now,
    });
  }

  async snapshot(): Promise<DualEnvelopeBudgetSnapshot> {
    return inspectDualEnvelopeBudgetLedger({ ledgerPath: this.#ledgerPath });
  }

  logicalSessionId(scheduleSha256: string, unit: ScheduledUnit): string {
    return `proof-${sha256Hex(`${scheduleSha256}\n${unit.unit_id}`).slice(0, 40)}`;
  }
}
