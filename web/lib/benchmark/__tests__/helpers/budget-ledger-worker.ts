import {
  FilesystemBudgetLedgerError,
  reserveFilesystemBudget,
} from "../../filesystem-budget-ledger";

async function main(): Promise<void> {
  const [ledgerPath, workerId] = process.argv.slice(2);
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
        pricing_snapshot_sha256: "a".repeat(64),
        limits_sha256: "b".repeat(64),
        formula_sha256: "c".repeat(64),
        components: [{ name: "process-race", upper_bound_micro_usd: 1_000_000 }],
        safety_margin_micro_usd: 0,
      },
    });
    process.stdout.write("admitted\n");
  } catch (error) {
    if (error instanceof FilesystemBudgetLedgerError && error.code === "budget_refused") {
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
