import type { DualEnvelopeBudgetSnapshot } from "../budget/dual-envelope-budget";
import type { RealtimeLifecycleConformanceReport } from "../../../realtime/conformance-v2";
import { canonicalJson } from "../../artifacts";
import { FilesystemDualEnvelopeBudget } from "./budget";
import { assertCompiledPairParity, compileCondition } from "./condition-compiler";
import { callerPlanSha256, type CallerScheduler, type PaidProviderConformanceAdapter } from "./contracts";
import {
  ProductionEvidenceAuthorityV2,
  type FinalizedUnitEvidenceV2,
  type ProductionUnitEvidenceSessionV2,
} from "./evidence-authority";
import { verifySignedSchedule } from "./schedule";
import { IntentionToTreatLedger } from "./terminal-ledger";
import type { ProviderIdentity, SignedSchedule, TerminalLedgerEntry } from "./types";

export type PaidProofRunResult = Readonly<{
  schema_version: 1;
  protocol: "HACC-Proof-v1";
  status: "completed" | "stopped";
  stop_reason: string | null;
  gates: Readonly<{
    schedule_verified: true;
    production_authorities: "passed";
    provider_paid_readiness: "passed" | "failed";
    testing: "passed" | "failed" | "not_opened" | "not_present";
    benchmark: "passed" | "failed" | "not_opened" | "not_present";
    evidence_v2_replay: "passed" | "failed" | "not_opened";
  }>;
  terminal_ledger: readonly TerminalLedgerEntry[];
  finalized_evidence: readonly Readonly<{
    unit_id: string;
    manifest_root_sha256: string;
    replay: FinalizedUnitEvidenceV2["replay"];
  }>[];
  budget: DualEnvelopeBudgetSnapshot;
}>;

function assertProductionAuthorities(
  budget: unknown,
  evidence: unknown,
): asserts budget is FilesystemDualEnvelopeBudget {
  if (!(budget instanceof FilesystemDualEnvelopeBudget)
    || Object.getPrototypeOf(budget) !== FilesystemDualEnvelopeBudget.prototype) {
    throw new Error("paid HACC proof requires the production filesystem dual-envelope/standing-aggregate authority");
  }
  if (!(evidence instanceof ProductionEvidenceAuthorityV2)
    || Object.getPrototypeOf(evidence) !== ProductionEvidenceAuthorityV2.prototype) {
    throw new Error("paid HACC proof requires the production EvidenceTapV2 frozen-contract authority");
  }
}
function reportMatchesIdentity(report: RealtimeLifecycleConformanceReport, identity: ProviderIdentity): boolean {
  const requested = report.snapshot.requestedConfiguration;
  const acknowledged = report.snapshot.acknowledgedConfiguration;
  return report.contractVersion === "2.0"
    && report.passed
    && report.paidReady
    && report.providerId === identity.provider
    && report.snapshot.providerId === identity.provider
    && report.snapshot.phase === "terminal"
    && report.snapshot.conformanceMode === "paid_readiness"
    && requested !== null
    && acknowledged !== null
    && requested.model === identity.model
    && requested.voice === identity.voice
    && requested.settingsSha256 === identity.settings_sha256
    && acknowledged.model === identity.model
    && acknowledged.voice === identity.voice
    && acknowledged.settingsSha256 === identity.settings_sha256;
}

function phaseStatus(entries: readonly TerminalLedgerEntry[], phase: "testing" | "benchmark") {
  const selected = entries.filter((entry) => entry.phase === phase);
  if (selected.length === 0) return "not_present" as const;
  if (selected.every((entry) => entry.disposition === "completed")) return "passed" as const;
  if (selected.some((entry) => entry.opening_count === 1)) return "failed" as const;
  return "not_opened" as const;
}

function terminalStatus(disposition: "completed" | "failed" | "ambiguous") {
  return disposition === "completed" ? "completed" as const
    : disposition === "failed" ? "failed" as const
      : "aborted" as const;
}

/** The only public paid entrypoint. There are no default or in-memory authorities. */
export async function runHaccProof(input: Readonly<{
  schedule: SignedSchedule;
  budget: FilesystemDualEnvelopeBudget;
  evidence: ProductionEvidenceAuthorityV2;
  providers: readonly PaidProviderConformanceAdapter[];
  caller: CallerScheduler;
  now?: () => Date;
}>): Promise<PaidProofRunResult> {
  assertProductionAuthorities(input.budget, input.evidence);
  verifySignedSchedule(input.schedule);
  const now = input.now ?? (() => new Date());
  const ledger = new IntentionToTreatLedger(input.schedule.body.units);
  const providers = new Map(input.providers.map((provider) => [provider.provider, provider]));
  if (providers.size !== input.providers.length) throw new Error("paid provider adapters must be unique");
  const conditions = input.schedule.body.units.map(compileCondition);
  for (let index = 0; index < conditions.length; index += 2) {
    assertCompiledPairParity(conditions[index]!, conditions[index + 1]!);
  }
  // Validate every independent frozen evaluation and resolver binding before
  // conformance checks, budget mutation, DNS, or provider bytes.
  for (const unit of input.schedule.body.units) input.evidence.assertReady(unit);

  let stopReason: string | null = null;
  let providerReadiness: "passed" | "failed" = "passed";
  const identities = new Map<string, ProviderIdentity>();
  for (const unit of input.schedule.body.units) identities.set(canonicalJson(unit.identity), unit.identity);
  try {
    for (const identity of identities.values()) {
      const adapter = providers.get(identity.provider);
      if (!adapter) throw new Error(`no paid adapter registered for ${identity.provider}`);
      const report = await adapter.paidReadinessReport(identity);
      if (!reportMatchesIdentity(report, identity)) {
        throw new Error(`provider ${identity.provider} lacks a matching conformance-v2 paidReady receipt`);
      }
    }
  } catch (error) {
    providerReadiness = "failed";
    stopReason = error instanceof Error ? error.message : "provider paid-readiness gate failed";
  }

  const evidenceResults: Array<Readonly<{ unit_id: string; result: FinalizedUnitEvidenceV2 }>> = [];
  for (let index = 0; index < input.schedule.body.units.length && !stopReason; index += 1) {
    const unit = input.schedule.body.units[index]!;
    const condition = conditions[index]!;
    let paidAdmission = false;
    let opened = false;
    let evidenceSession: ProductionUnitEvidenceSessionV2 | null = null;
    let providerSession: Awaited<ReturnType<PaidProviderConformanceAdapter["openPaid"]>> | null = null;
    const logicalSessionId = input.budget.logicalSessionId(input.schedule.schedule_sha256, unit);
    try {
      const callerPlan = input.caller.compile(unit);
      if (callerPlan.caller_plan_sha256 !== unit.caller_plan_sha256
        || callerPlanSha256(callerPlan.actions) !== unit.caller_plan_sha256) {
        throw new Error(`caller plan mismatch for ${unit.unit_id}`);
      }
      const admission = await input.budget.admit(unit, logicalSessionId);
      paidAdmission = true;
      if (!admission.network_may_open || admission.disposition !== "newly_admitted") {
        throw new Error(`paid admission for ${unit.unit_id} is quarantined and cannot reopen`);
      }
      evidenceSession = input.evidence.begin(unit, condition);
      const adapter = providers.get(unit.identity.provider)!;
      providerSession = await adapter.openPaid(condition);
      ledger.markOpened(unit.unit_id, providerSession.session_id);
      opened = true;
      const result = await providerSession.run(callerPlan.actions, (observation) => {
        evidenceSession!.append(observation);
      });
      if (!(["completed", "failed", "ambiguous"] as const).includes(result.disposition)) {
        throw new Error(`provider returned invalid disposition for ${unit.unit_id}`);
      }
      if (result.billing.estimated_micro_usd !== result.estimated_micro_usd) {
        throw new Error(`provider billing evidence disagrees with result for ${unit.unit_id}`);
      }
      await input.budget.terminal(unit, logicalSessionId, result.disposition);
      await input.budget.settle(unit, logicalSessionId, result.billing);
      ledger.markTerminal(unit.unit_id, result.disposition, result.estimated_micro_usd, result.reason ?? null);
      const finalized = evidenceSession.finalizeAndEvaluate({
        disposition_id: `terminal-${unit.unit_id}`,
        status: terminalStatus(result.disposition),
        reason_code: result.reason ?? null,
      }, now().toISOString());
      evidenceResults.push({ unit_id: unit.unit_id, result: finalized });
      if (!finalized.replay.ok) stopReason = `EvidenceTapV2 replay failed for ${unit.unit_id}`;
      else if (result.disposition !== "completed") stopReason = `${unit.unit_id} ended ${result.disposition}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "paid unit failed";
      if (paidAdmission) {
        try { await input.budget.terminal(unit, logicalSessionId, "ambiguous"); } catch { /* durable ledger remains conservative */ }
        if (!opened) ledger.markOpened(unit.unit_id, `unacknowledged:${logicalSessionId}`);
        ledger.markTerminal(unit.unit_id, "ambiguous", unit.maximum_micro_usd, reason);
      }
      if (evidenceSession) {
        try {
          const finalized = evidenceSession.finalizeAndEvaluate({
            disposition_id: `terminal-${unit.unit_id}`,
            status: "aborted",
            reason_code: "paid_unit_ambiguous",
          }, now().toISOString());
          evidenceResults.push({ unit_id: unit.unit_id, result: finalized });
        } catch { /* custody failure is preserved by the stopped run */ }
      }
      stopReason = reason;
    } finally {
      if (providerSession) {
        try { await providerSession.close(); } catch { /* close never authorizes retry */ }
      }
    }
  }

  if (stopReason) ledger.stopUnopened(stopReason);
  else ledger.stopUnopened("runner invariant: scheduled unit was not opened");
  const itt = ledger.snapshot();
  const replayGate = evidenceResults.length === 0 ? "not_opened" as const
    : evidenceResults.every((entry) => entry.result.replay.ok) ? "passed" as const : "failed" as const;
  return Object.freeze({
    schema_version: 1,
    protocol: "HACC-Proof-v1",
    status: stopReason ? "stopped" : "completed",
    stop_reason: stopReason,
    gates: Object.freeze({
      schedule_verified: true,
      production_authorities: "passed" as const,
      provider_paid_readiness: providerReadiness,
      testing: phaseStatus(itt, "testing"),
      benchmark: phaseStatus(itt, "benchmark"),
      evidence_v2_replay: replayGate,
    }),
    terminal_ledger: itt,
    finalized_evidence: Object.freeze(evidenceResults.map(({ unit_id, result }) => Object.freeze({
      unit_id,
      manifest_root_sha256: result.bundle.terminal_manifest.manifest_root_sha256,
      replay: result.replay,
    }))),
    budget: await input.budget.snapshot(),
  });
}
