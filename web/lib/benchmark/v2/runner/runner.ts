import { canonicalJson } from "../../artifacts";
import { TestOnlyInMemoryDualBudgetAdmission, type BudgetSnapshot, type DualBudgetAdmission } from "./budget";
import { assertCompiledPairParity, compileCondition } from "./condition-compiler";
import type {
  CallerScheduler,
  EvaluationResult,
  FrozenEvaluator,
  ProviderConformanceAdapter,
} from "./contracts";
import { callerPlanSha256, providerAcknowledgementSha256 } from "./contracts";
import { TestOnlyEvidenceTap, type RawEvidenceFinalization } from "./evidence-tap";
import { verifySignedSchedule } from "./schedule";
import { IntentionToTreatLedger } from "./terminal-ledger";
import type {
  JsonValue,
  ProviderIdentity,
  SignedSchedule,
  TerminalLedgerEntry,
} from "./types";

export type ProofRunResult = Readonly<{
  schema_version: 1;
  protocol: "HACC-Proof-v1";
  status: "completed" | "stopped";
  stop_reason: string | null;
  gates: Readonly<{
    schedule_verified: true;
    budget_admission: "passed" | "failed";
    provider_conformance: "passed" | "failed" | "not_run";
    testing: "passed" | "failed" | "not_opened" | "not_present";
    benchmark: "passed" | "failed" | "not_opened" | "not_present";
    raw_finalized_before_evaluation: true;
  }>;
  terminal_ledger: readonly TerminalLedgerEntry[];
  raw_finalization: RawEvidenceFinalization;
  evaluation: EvaluationResult;
  budget: BudgetSnapshot;
}>;

function identityEqual(left: ProviderIdentity, right: ProviderIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Provider-free dry runner. It cannot admit a paid testing or benchmark unit. */
export async function runTestOnlyHaccProof(input: Readonly<{
  schedule: SignedSchedule;
  providers: readonly ProviderConformanceAdapter[];
  caller: CallerScheduler;
  evaluator: FrozenEvaluator;
  now?: () => Date;
  budget?: DualBudgetAdmission;
  budgetCeilingsMicroUsd?: Readonly<{ testing: number; benchmark: number }>;
}>): Promise<ProofRunResult> {
  verifySignedSchedule(input.schedule);
  const now = input.now ?? (() => new Date());
  const tap = new TestOnlyEvidenceTap();
  const ledger = new IntentionToTreatLedger(input.schedule.body.units);
  const budget = input.budget ?? new TestOnlyInMemoryDualBudgetAdmission({
    testing_micro_usd: input.budgetCeilingsMicroUsd?.testing ?? 100_000_000,
    benchmark_micro_usd: input.budgetCeilingsMicroUsd?.benchmark ?? 100_000_000,
  });
  const providers = new Map(input.providers.map((provider) => [provider.provider, provider]));
  const sessionIds = new Set<string>();
  if (providers.size !== input.providers.length) throw new Error("provider adapters must be unique");

  const conditions = input.schedule.body.units.map(compileCondition);
  for (let index = 0; index < conditions.length; index += 2) {
    assertCompiledPairParity(conditions[index]!, conditions[index + 1]!);
  }

  let stopReason: string | null = null;
  let budgetAdmission: "passed" | "failed" = "passed";
  let providerConformance: "passed" | "failed" | "not_run" = "not_run";
  let testing: "passed" | "failed" | "not_opened" | "not_present" = input.schedule.body.units.some((unit) => unit.phase === "testing")
    ? "passed" : "not_present";
  let benchmark: "passed" | "failed" | "not_opened" | "not_present" = input.schedule.body.units.some((unit) => unit.phase === "benchmark")
    ? "passed" : "not_present";

  // Reserve the exact full plan before any provider can be opened.
  try {
    for (const unit of input.schedule.body.units) budget.reserve(unit);
  } catch (error) {
    budgetAdmission = "failed";
    stopReason = error instanceof Error ? error.message : "budget admission failed";
  }

  if (!stopReason) try {
    // Provider acknowledgement is a gate, not request-only evidence.
    const identities = new Map<string, ProviderIdentity>();
    for (const unit of input.schedule.body.units) {
      const key = canonicalJson(unit.identity);
      identities.set(key, unit.identity);
    }
    for (const identity of identities.values()) {
      const adapter = providers.get(identity.provider);
      if (!adapter) throw new Error(`no adapter registered for ${identity.provider}`);
      const acknowledgement = await adapter.preflight(identity);
      if (acknowledgement.conformance_version !== "HACC-Proof-Provider-v1"
        || acknowledgement.supports_one_shot_sessions !== true
        || !identityEqual(acknowledgement.identity, identity)
        || acknowledgement.acknowledgement_sha256 !== providerAcknowledgementSha256({
          identity: acknowledgement.identity,
          conformance_version: acknowledgement.conformance_version,
          supports_one_shot_sessions: acknowledgement.supports_one_shot_sessions,
        })) {
        throw new Error(`provider acknowledgement identity mismatch for ${identity.provider}`);
      }
      tap.append("provider.acknowledged", now().toISOString(), asJson(acknowledgement));
    }
    providerConformance = "passed";
  } catch (error) {
    providerConformance = "failed";
    stopReason = error instanceof Error ? error.message : "provider conformance failed";
  }

  let priorPhase: "testing" | "benchmark" | null = null;
  for (let index = 0; index < input.schedule.body.units.length; index += 1) {
    const unit = input.schedule.body.units[index]!;
    const condition = conditions[index]!;
    if (stopReason) break;
    if (priorPhase === "testing" && unit.phase === "benchmark" && testing !== "passed") {
      benchmark = "not_opened";
      stopReason = "testing gate did not pass";
      break;
    }
    priorPhase = unit.phase;

    let openingAdmitted = false;
    let opened = false;
    let session: Awaited<ReturnType<ProviderConformanceAdapter["open"]>> | null = null;
    try {
      const callerPlan = input.caller.compile(unit);
      if (callerPlan.caller_plan_sha256 !== unit.caller_plan_sha256
        || callerPlanSha256(callerPlan.actions) !== unit.caller_plan_sha256) {
        throw new Error(`caller plan mismatch for ${unit.unit_id}`);
      }
      const adapter = providers.get(unit.identity.provider);
      if (!adapter) throw new Error(`no adapter registered for ${unit.identity.provider}`);
      budget.markOpened(unit.unit_id);
      openingAdmitted = true;
      session = await adapter.open(condition);
      ledger.markOpened(unit.unit_id, session.session_id);
      opened = true;
      if (sessionIds.has(session.session_id)) throw new Error(`provider reused session ${session.session_id}`);
      sessionIds.add(session.session_id);
      tap.append("session.opened", now().toISOString(), asJson({
        unit_id: unit.unit_id,
        session_id: session.session_id,
        condition_sha256: condition.condition_sha256,
      }));
      const result = await session.run(callerPlan.actions, (event) => {
        tap.append(`provider.${event.event_type}`, event.observed_at, asJson({
          unit_id: unit.unit_id,
          session_id: session!.session_id,
          payload: event.payload,
        }));
      });
      if (!(["completed", "failed", "ambiguous"] as const).includes(result.disposition)) {
        throw new Error(`provider returned invalid disposition for ${unit.unit_id}`);
      }
      budget.settle(unit.unit_id, result.estimated_micro_usd);
      ledger.markTerminal(unit.unit_id, result.disposition, result.estimated_micro_usd, result.reason ?? null);
      tap.append("session.terminal", now().toISOString(), asJson({ unit_id: unit.unit_id, ...result }));
      if (result.disposition !== "completed") {
        stopReason = `${unit.unit_id} ended ${result.disposition}`;
        if (unit.phase === "testing") testing = "failed";
        else benchmark = "failed";
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unit failed";
      if (openingAdmitted) {
        // Ambiguous is the only safe classification after admission when the
        // provider did not return a trustworthy terminal result.
        try {
          budget.settle(unit.unit_id, unit.maximum_micro_usd);
        } catch { /* retained as an independently visible budget failure */ }
        if (!opened) {
          ledger.markOpened(unit.unit_id, `unacknowledged:${unit.unit_id}`);
        }
        ledger.markTerminal(unit.unit_id, "ambiguous", unit.maximum_micro_usd, reason);
      }
      stopReason = reason;
      if (unit.phase === "testing") testing = "failed";
      else benchmark = "failed";
    } finally {
      if (session) {
        try { await session.close(); } catch { /* closing cannot authorize a retry */ }
      }
    }
  }

  if (stopReason) {
    ledger.stopUnopened(stopReason);
    for (const unit of input.schedule.body.units) {
      const entry = ledger.snapshot().find((candidate) => candidate.unit_id === unit.unit_id)!;
      if (entry.opening_count === 0) {
        try { budget.cancelBeforeOpen(unit.unit_id); } catch { /* reservation failure is already fail-closed */ }
      }
    }
    if (benchmark === "passed" && input.schedule.body.units.some((unit) => unit.phase === "benchmark")) {
      benchmark = "not_opened";
    }
  }

  const itt = ledger.snapshot();
  const phaseStatus = (phase: "testing" | "benchmark") => {
    const entries = itt.filter((entry) => entry.phase === phase);
    if (entries.length === 0) return "not_present" as const;
    if (entries.every((entry) => entry.disposition === "completed")) return "passed" as const;
    if (entries.some((entry) => entry.opening_count === 1)) return "failed" as const;
    return "not_opened" as const;
  };
  testing = phaseStatus("testing");
  benchmark = phaseStatus("benchmark");
  tap.append("itt.finalized", now().toISOString(), asJson(itt));
  const rawFinalization = tap.finalizeRaw();
  const evaluation = await input.evaluator.evaluate({
    raw_evidence_sha256: rawFinalization.raw_evidence_sha256,
    raw_events: tap.rawEvents(),
    itt_ledger: itt,
  });
  tap.recordEvaluation(asJson(evaluation));

  return Object.freeze({
    schema_version: 1 as const,
    protocol: "HACC-Proof-v1" as const,
    status: stopReason ? "stopped" as const : "completed" as const,
    stop_reason: stopReason,
    gates: Object.freeze({
      schedule_verified: true as const,
      budget_admission: budgetAdmission,
      provider_conformance: providerConformance,
      testing,
      benchmark,
      raw_finalized_before_evaluation: true as const,
    }),
    terminal_ledger: itt,
    raw_finalization: rawFinalization,
    evaluation,
    budget: budget.snapshot(),
  });
}
