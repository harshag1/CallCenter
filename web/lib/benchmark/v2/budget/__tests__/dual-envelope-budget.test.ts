import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_TESTING_CEILING_MICRO_USD,
  BENCHMARK_CEILING_MICRO_USD,
  DualEnvelopeBudgetError,
  admitDualEnvelopeSession,
  initializeDualEnvelopeBudgetLedger,
  inspectDualEnvelopeBudgetLedger,
  recordDualEnvelopeTerminal,
  settleDualEnvelopeSession,
} from "../dual-envelope-budget";

const roots: string[] = [];
const NOW = () => new Date("2026-08-02T12:00:00.000Z");
const H = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function pathFor(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hacc-v2-dual-budget-"));
  roots.push(root);
  return join(root, "budget.json");
}

function admission(
  ledgerPath: string,
  suffix: string,
  purpose: "api_testing" | "benchmark",
  maximumMicroUsd = 1_000_000
) {
  return {
    ledgerPath,
    operationId: `admit-${suffix}`,
    sessionId: `session-${suffix}`,
    trialId: `trial-${suffix}`,
    purpose,
    provider: "openai",
    model: "gpt-realtime",
    maximumMicroUsd,
    attempt: 1,
    retryOf: null,
    replacementFor: null,
    fallbackFrom: null,
    now: NOW,
    randomId: () => `admission-${suffix}`,
  } as const;
}

async function initialize(ledgerPath: string) {
  return initializeDualEnvelopeBudgetLedger({ ledgerPath, ledgerId: "dual-budget-test", now: NOW });
}

async function expectCode(promise: Promise<unknown>, code: DualEnvelopeBudgetError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(DualEnvelopeBudgetError);
    expect((error as DualEnvelopeBudgetError).code).toBe(code);
  }
}

describe("dual-envelope paid admission", () => {
  it("initializes two exact, independent $100 micro-USD envelopes", async () => {
    const ledgerPath = await pathFor();
    const snapshot = await initialize(ledgerPath);

    expect(snapshot.envelopes.api_testing.ceiling_micro_usd).toBe(API_TESTING_CEILING_MICRO_USD);
    expect(snapshot.envelopes.benchmark.ceiling_micro_usd).toBe(BENCHMARK_CEILING_MICRO_USD);
    expect(snapshot.envelopes.api_testing.usd.ceiling).toBe("100");
    expect(snapshot.envelopes.benchmark.usd.ceiling).toBe("100");
    expect(snapshot.opened_session_ids_itt).toEqual([]);
  });

  it("records the pessimistic reservation and ITT opening before returning network admission", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);

    const result = await admitDualEnvelopeSession(admission(ledgerPath, "first", "api_testing", 12_345_678));
    expect(result.value).toMatchObject({
      network_may_open: true,
      disposition: "newly_admitted",
      purpose: "api_testing",
      maximum_micro_usd: 12_345_678,
      admitted_sequence: 2,
    });
    expect(result.snapshot.envelopes.api_testing).toMatchObject({
      unsettled_reservations_micro_usd: 12_345_678,
      conservative_exposure_micro_usd: 12_345_678,
      opened_sessions_itt: 1,
    });
    expect((await inspectDualEnvelopeBudgetLedger({ ledgerPath })).opened_session_ids_itt).toEqual(["session-first"]);
  });

  it("prevents cross-subsidy even when the other envelope is empty", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);
    await admitDualEnvelopeSession(admission(ledgerPath, "api-full", "api_testing", 100_000_000));

    await expectCode(
      admitDualEnvelopeSession(admission(ledgerPath, "api-over", "api_testing", 1)),
      "envelope_exhausted"
    );
    const benchmark = await admitDualEnvelopeSession(admission(ledgerPath, "bench", "benchmark", 100_000_000));
    expect(benchmark.snapshot.envelopes.api_testing.state).toBe("closed");
    expect(benchmark.snapshot.envelopes.benchmark.state).toBe("closed");
  });

  it("serializes concurrent admissions without oversubscribing either envelope", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);
    const results = await Promise.allSettled([
      ...Array.from({ length: 30 }, (_, index) => admitDualEnvelopeSession({
        ...admission(ledgerPath, `api-${index}`, "api_testing", 5_000_000),
        lockTimeoutMs: 30_000,
      })),
      ...Array.from({ length: 30 }, (_, index) => admitDualEnvelopeSession({
        ...admission(ledgerPath, `bench-${index}`, "benchmark", 5_000_000),
        lockTimeoutMs: 30_000,
      })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(40);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(20);
    expect(rejected.every((result) => result.reason instanceof DualEnvelopeBudgetError
      && result.reason.code === "envelope_exhausted")).toBe(true);

    const snapshot = await inspectDualEnvelopeBudgetLedger({ ledgerPath });
    expect(snapshot.envelopes.api_testing.conservative_exposure_micro_usd).toBe(100_000_000);
    expect(snapshot.envelopes.benchmark.conservative_exposure_micro_usd).toBe(100_000_000);
    expect(snapshot.envelopes.api_testing.opened_sessions_itt).toBe(20);
    expect(snapshot.envelopes.benchmark.opened_sessions_itt).toBe(20);
  }, 60_000);

  it("prohibits retries, replacements, fallbacks, and renamed cross-envelope replacements", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);
    await admitDualEnvelopeSession(admission(ledgerPath, "original", "api_testing"));

    await expectCode(admitDualEnvelopeSession({
      ...admission(ledgerPath, "retry", "api_testing"),
      attempt: 2 as 1,
      retryOf: "session-original" as unknown as null,
    }), "prohibited_attempt");
    await expectCode(admitDualEnvelopeSession({
      ...admission(ledgerPath, "replacement", "benchmark"),
      replacementFor: "session-original" as unknown as null,
    }), "prohibited_attempt");
    await expectCode(admitDualEnvelopeSession({
      ...admission(ledgerPath, "fallback", "api_testing"),
      fallbackFrom: "openai" as unknown as null,
    }), "prohibited_attempt");
    await expectCode(admitDualEnvelopeSession({
      ...admission(ledgerPath, "renamed", "benchmark"),
      trialId: "trial-original",
    }), "duplicate_trial");
  });

  it("keeps failed and ambiguous opened sessions permanently in ITT", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);
    await admitDualEnvelopeSession(admission(ledgerPath, "failed", "benchmark", 9_000_000));
    await recordDualEnvelopeTerminal({
      ledgerPath,
      operationId: "terminal-failed",
      sessionId: "session-failed",
      outcome: "ambiguous",
      now: NOW,
    });

    const beforeSettlement = await inspectDualEnvelopeBudgetLedger({ ledgerPath });
    expect(beforeSettlement.envelopes.benchmark.opened_sessions_itt).toBe(1);
    expect(beforeSettlement.envelopes.benchmark.unsettled_reservations_micro_usd).toBe(9_000_000);
    await settleDualEnvelopeSession({
      ledgerPath,
      operationId: "settle-failed",
      sessionId: "session-failed",
      estimatedMicroUsd: 2_000_000,
      providerReportedMicroUsd: 3_000_000,
      reconciledMicroUsd: 3_000_000,
      reconciliationEvidenceSha256: H,
      now: NOW,
    });
    const settled = await inspectDualEnvelopeBudgetLedger({ ledgerPath });
    expect(settled.envelopes.benchmark.opened_sessions_itt).toBe(1);
    expect(settled.opened_session_ids_itt).toEqual(["session-failed"]);
    expect(settled.envelopes.benchmark.reconciled_spend_micro_usd).toBe(3_000_000);
  });

  it("makes local operation replay idempotent without creating a paid retry", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);
    const input = admission(ledgerPath, "same", "api_testing");
    const first = await admitDualEnvelopeSession(input);
    const replay = await admitDualEnvelopeSession(input);
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.value).toMatchObject({
      network_may_open: false,
      disposition: "already_opened_quarantine",
    });
    expect(replay.value.admission_id).toBe(first.value.admission_id);
    expect(replay.snapshot.envelopes.api_testing.opened_sessions_itt).toBe(1);

    await expectCode(admitDualEnvelopeSession({
      ...admission(ledgerPath, "other", "api_testing"),
      operationId: input.operationId,
    }), "operation_conflict");
    await expectCode(admitDualEnvelopeSession({
      ...input,
      operationId: "new-operation-same-session",
    }), "duplicate_session");

    const terminalInput = {
      ledgerPath,
      operationId: "terminal-same",
      sessionId: "session-same",
      outcome: "completed" as const,
      now: NOW,
    };
    await recordDualEnvelopeTerminal(terminalInput);
    expect((await recordDualEnvelopeTerminal(terminalInput)).idempotent_replay).toBe(true);

    const settlementInput = {
      ledgerPath,
      operationId: "settle-same",
      sessionId: "session-same",
      estimatedMicroUsd: 500_000,
      providerReportedMicroUsd: 600_000,
      reconciledMicroUsd: 600_000,
      reconciliationEvidenceSha256: H,
      now: NOW,
    };
    await settleDualEnvelopeSession(settlementInput);
    expect((await settleDualEnvelopeSession(settlementInput)).idempotent_replay).toBe(true);
    expect((await inspectDualEnvelopeBudgetLedger({ ledgerPath })).opened_session_ids_itt).toEqual(["session-same"]);
  });

  it("fails closed on a missing, truncated, or digest-invalid ledger", async () => {
    const ledgerPath = await pathFor();
    await expectCode(admitDualEnvelopeSession(admission(ledgerPath, "missing", "api_testing")), "missing_ledger");

    await initialize(ledgerPath);
    await writeFile(ledgerPath, "{\"schema_version\":1", "utf8");
    await expectCode(admitDualEnvelopeSession(admission(ledgerPath, "truncated", "api_testing")), "corrupt_ledger");

    await rm(ledgerPath);
    await initialize(ledgerPath);
    const tampered = JSON.parse(await readFile(ledgerPath, "utf8"));
    tampered.ceilings_micro_usd.api_testing = 200_000_000;
    await writeFile(ledgerPath, JSON.stringify(tampered), "utf8");
    await expectCode(inspectDualEnvelopeBudgetLedger({ ledgerPath }), "corrupt_ledger");
  });

  it("fails closed rather than bypassing an unavailable atomic lock", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);
    await mkdir(`${ledgerPath}.lock`);
    await expectCode(admitDualEnvelopeSession({
      ...admission(ledgerPath, "locked", "benchmark"),
      lockTimeoutMs: 0,
    }), "lock_timeout");
    await rm(`${ledgerPath}.lock`, { recursive: true });
    expect((await inspectDualEnvelopeBudgetLedger({ ledgerPath })).opened_session_ids_itt).toEqual([]);
  });

  it("rejects non-integer micro-USD values and settlement before terminal", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);
    await expectCode(admitDualEnvelopeSession({
      ...admission(ledgerPath, "fraction", "api_testing"),
      maximumMicroUsd: 0.5,
    }), "invalid_request");
    await admitDualEnvelopeSession(admission(ledgerPath, "open", "api_testing"));
    await expectCode(settleDualEnvelopeSession({
      ledgerPath,
      operationId: "settle-open",
      sessionId: "session-open",
      estimatedMicroUsd: 1,
      providerReportedMicroUsd: 1,
      reconciledMicroUsd: 1,
      reconciliationEvidenceSha256: H,
      now: NOW,
    }), "invalid_transition");
  });
});
