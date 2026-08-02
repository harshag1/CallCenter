import type { ScheduledUnit, TerminalDisposition, TerminalLedgerEntry } from "./types";

type MutableEntry = {
  unit: ScheduledUnit;
  openingCount: 0 | 1;
  sessionId: string | null;
  disposition: TerminalDisposition | null;
  estimatedMicroUsd: number;
  reason: string | null;
};

export class IntentionToTreatLedger {
  readonly #entries: Map<string, MutableEntry>;

  constructor(units: readonly ScheduledUnit[]) {
    this.#entries = new Map(units.map((unit) => [unit.unit_id, {
      unit,
      openingCount: 0 as const,
      sessionId: null,
      disposition: null,
      estimatedMicroUsd: 0,
      reason: null,
    }]));
    if (this.#entries.size !== units.length) throw new Error("ITT ledger requires unique scheduled units");
  }

  markOpened(unitId: string, sessionId: string): void {
    const entry = this.#required(unitId);
    if (entry.openingCount !== 0 || entry.disposition || !sessionId) {
      throw new Error(`unit ${unitId} cannot be opened more than once`);
    }
    entry.openingCount = 1;
    entry.sessionId = sessionId;
  }

  markTerminal(unitId: string, disposition: Exclude<TerminalDisposition, "not_opened_gate_stopped">, estimatedMicroUsd: number, reason: string | null): void {
    const entry = this.#required(unitId);
    if (entry.openingCount !== 1 || entry.disposition) throw new Error(`opened unit ${unitId} cannot be terminalized`);
    entry.disposition = disposition;
    entry.estimatedMicroUsd = estimatedMicroUsd;
    entry.reason = reason;
  }

  stopUnopened(reason: string): void {
    for (const entry of this.#entries.values()) {
      if (!entry.disposition && entry.openingCount === 0) {
        entry.disposition = "not_opened_gate_stopped";
        entry.reason = reason;
      }
    }
  }

  snapshot(): readonly TerminalLedgerEntry[] {
    const snapshot = [...this.#entries.values()].map((entry): TerminalLedgerEntry => {
      if (!entry.disposition) throw new Error(`ITT unit ${entry.unit.unit_id} has no terminal disposition`);
      return Object.freeze({
        unit_id: entry.unit.unit_id,
        pair_id: entry.unit.pair_id,
        arm: entry.unit.arm,
        phase: entry.unit.phase,
        opening_count: entry.openingCount,
        session_id: entry.sessionId,
        disposition: entry.disposition,
        estimated_micro_usd: entry.estimatedMicroUsd,
        reason: entry.reason,
      });
    });
    return Object.freeze(snapshot);
  }

  #required(unitId: string): MutableEntry {
    const entry = this.#entries.get(unitId);
    if (!entry) throw new Error(`unknown ITT unit ${unitId}`);
    return entry;
  }
}
