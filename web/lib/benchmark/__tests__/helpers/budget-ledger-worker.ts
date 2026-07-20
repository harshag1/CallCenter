import {
  FilesystemBudgetLedgerError,
  reserveFilesystemBudget,
} from "../../filesystem-budget-ledger";

async function main(): Promise<void> {
  const [ledgerPath, workerId, expectedHeadSha256, expectedLedgerId] = process.argv.slice(2);
  if (!ledgerPath || !workerId) throw new Error("worker requires ledger path and ID");
  try {
    await reserveFilesystemBudget({
      ledgerPath,
      // A full-suite run can leave 24 signing workers contending for this
      // single-writer lock while the host is CPU-saturated. Keep retrying the
      // same idempotent operation rather than treating transient contention as
      // a budget decision.
      lockTimeoutMs: 60_000,
      lockRetryMs: 10,
      operationId: `process-reserve-${workerId}`,
      reservationId: `process-reservation-${workerId}`,
      runId: `process-run-${workerId}`,
      provider: "openai",
      model: "gpt-realtime-2.1",
      condition: "full-harness",
      expiresAt: "2026-07-10T13:00:00.000Z",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      costEnvelope: {
        schema_version: 1,
        kind: "hacc_provider_gate1_cost_envelope",
        pricing_snapshot_sha256: "a".repeat(64),
        provider_hard_session_caps_sha256: "b".repeat(64),
        runner_config_sha256: "c".repeat(64),
        formula_sha256: "d".repeat(64),
        components: [{
          name: "process-race",
          upper_bound_micro_usd: expectedHeadSha256 ? 5_000_000 : 1_000_000,
        }],
        safety_margin_micro_usd: 0,
      },
      ...(expectedHeadSha256 && expectedLedgerId
        ? {
            expectedLedgerId,
            requiredCurrentHeadSha256: expectedHeadSha256,
            planConsumption: {
              consumptionId: `process-plan-consumption-${workerId}`,
              planSha256: workerId.padStart(64, "0"),
              maximumMicroUsd: 5_000_000,
            },
          }
        : {}),
    });
    process.stdout.write("admitted\n");
  } catch (error) {
    if (
      error instanceof FilesystemBudgetLedgerError
      && ["budget_refused", "integrity_failure", "plan_consumed"].includes(error.code)
    ) {
      process.stdout.write("refused\n");
      return;
    }
    throw error;
  }
}

void main().catch((error: unknown) => {
  const diagnostic = error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        code: error instanceof FilesystemBudgetLedgerError ? error.code : null,
        stack: error.stack ?? null,
      }
    : {
        name: "NonErrorThrow",
        message: String(error),
        code: null,
        stack: null,
      };
  process.stderr.write(`budget worker failed: ${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 1;
});
