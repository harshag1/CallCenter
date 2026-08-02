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
import {
  initializeStandingAggregateBudgetLedger,
  inspectStandingAggregateBudgetLedger,
} from "../standing-aggregate-budget";

const roots: string[] = [];
const aggregatePaths = new Map<string, string>();
const NOW = () => new Date("2026-08-02T12:00:00.000Z");
const H = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function pathFor(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hacc-v2-dual-budget-"));
  roots.push(root);
  const ledgerPath = join(root, "budget.json");
  const aggregateLedgerPath = join(root, "standing-aggregate.json");
  await initializeStandingAggregateBudgetLedger({ aggregateLedgerPath, now: NOW });
  aggregatePaths.set(ledgerPath, aggregateLedgerPath);
  return ledgerPath;
}

function admission(
  ledgerPath: string,
  suffix: string,
  purpose: "api_testing" | "benchmark",
  maximumMicroUsd = 1_000_000
) {
  return {
    ledgerPath,
    standingAggregateLedgerPath: aggregatePaths.get(ledgerPath)!,
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
  return initializeDualEnvelopeBudgetLedger({
    ledgerPath,
    ledgerId: "dual-budget-test",
    standingAggregateLedgerPath: aggregatePaths.get(ledgerPath)!,
    now: NOW,
  });
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
    const benchmark = await admitDualEnvelopeSession(admission(ledgerPath, "bench", "benchmark", 20_000_000));
    expect(benchmark.snapshot.envelopes.api_testing.state).toBe("closed");
    expect(benchmark.snapshot.envelopes.benchmark.conservative_exposure_micro_usd).toBe(20_000_000);
  });

  it("serializes concurrent admissions without oversubscribing either envelope", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);
    const results = await Promise.allSettled([
      ...Array.from({ length: 30 }, (_, index) => admitDualEnvelopeSession({
        ...admission(ledgerPath, `api-${index}`, "api_testing", 2_500_000),
        lockTimeoutMs: 30_000,
      })),
      ...Array.from({ length: 30 }, (_, index) => admitDualEnvelopeSession({
        ...admission(ledgerPath, `bench-${index}`, "benchmark", 2_500_000),
        lockTimeoutMs: 30_000,
      })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(50);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(10);

    const snapshot = await inspectDualEnvelopeBudgetLedger({ ledgerPath });
    expect(snapshot.envelopes.api_testing.conservative_exposure_micro_usd).toBeLessThanOrEqual(100_000_000);
    expect(snapshot.envelopes.benchmark.conservative_exposure_micro_usd).toBeLessThanOrEqual(100_000_000);
    expect(snapshot.envelopes.api_testing.opened_sessions_itt
      + snapshot.envelopes.benchmark.opened_sessions_itt).toBe(50);
    expect((await inspectStandingAggregateBudgetLedger({
      aggregateLedgerPath: aggregatePaths.get(ledgerPath)!,
    })).aggregate_conservative_micro_usd).toBe(297_500_000);
  }, 60_000);

  it("atomically enforces the standing aggregate across concurrent child ledgers", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-v2-standing-race-"));
    roots.push(root);
    const aggregateLedgerPath = join(root, "standing-aggregate.json");
    const leftPath = join(root, "left-budget.json");
    const rightPath = join(root, "right-budget.json");
    await initializeStandingAggregateBudgetLedger({ aggregateLedgerPath, now: NOW });
    aggregatePaths.set(leftPath, aggregateLedgerPath);
    aggregatePaths.set(rightPath, aggregateLedgerPath);
    await initializeDualEnvelopeBudgetLedger({
      ledgerPath: leftPath,
      ledgerId: "left-child",
      standingAggregateLedgerPath: aggregateLedgerPath,
      now: NOW,
    });
    await initializeDualEnvelopeBudgetLedger({
      ledgerPath: rightPath,
      ledgerId: "right-child",
      standingAggregateLedgerPath: aggregateLedgerPath,
      now: NOW,
    });

    // Genesis is $172.50 and the standing ceiling is exclusive $300. Two
    // simultaneous $70 reservations cannot both fit the remaining $127.50.
    const results = await Promise.allSettled([
      admitDualEnvelopeSession({ ...admission(leftPath, "left-race", "api_testing", 70_000_000), lockTimeoutMs: 30_000 }),
      admitDualEnvelopeSession({ ...admission(rightPath, "right-race", "benchmark", 70_000_000), lockTimeoutMs: 30_000 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const aggregate = await inspectStandingAggregateBudgetLedger({ aggregateLedgerPath });
    expect(aggregate).toMatchObject({
      genesis_micro_usd: 172_500_000,
      registered_conservative_micro_usd: 70_000_000,
      aggregate_conservative_micro_usd: 242_500_000,
      reservation_count: 1,
      state: "open",
    });
    const openedAcrossChildren = (await inspectDualEnvelopeBudgetLedger({ ledgerPath: leftPath })).opened_session_ids_itt.length
      + (await inspectDualEnvelopeBudgetLedger({ ledgerPath: rightPath })).opened_session_ids_itt.length;
    expect(openedAcrossChildren).toBe(1);
  });

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
      standingAggregateLedgerPath: aggregatePaths.get(ledgerPath)!,
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
    expect(settled.envelopes.benchmark.conservative_settled_micro_usd).toBe(9_000_000);
    expect(settled.envelopes.benchmark.conservative_exposure_micro_usd).toBe(9_000_000);
  });

  it("never frees an opened maximum when settlement evidence claims zero cost", async () => {
    const ledgerPath = await pathFor();
    await initialize(ledgerPath);
    await admitDualEnvelopeSession(admission(ledgerPath, "full", "api_testing", 100_000_000));
    await recordDualEnvelopeTerminal({
      ledgerPath,
      operationId: "terminal-full",
      sessionId: "session-full",
      outcome: "completed",
      now: NOW,
    });
    const forgedLow = await settleDualEnvelopeSession({
      ledgerPath,
      standingAggregateLedgerPath: aggregatePaths.get(ledgerPath)!,
      operationId: "settle-full",
      sessionId: "session-full",
      estimatedMicroUsd: 0,
      providerReportedMicroUsd: 0,
      reconciledMicroUsd: 0,
      reconciliationEvidenceSha256: H,
      now: NOW,
    });
    expect(forgedLow.snapshot.envelopes.api_testing).toMatchObject({
      reconciled_spend_micro_usd: 0,
      conservative_settled_micro_usd: 100_000_000,
      conservative_exposure_micro_usd: 100_000_000,
      state: "closed",
    });
    expect(await inspectStandingAggregateBudgetLedger({
      aggregateLedgerPath: aggregatePaths.get(ledgerPath)!,
    })).toMatchObject({
      registered_conservative_micro_usd: 100_000_000,
      aggregate_conservative_micro_usd: 272_500_000,
    });
    await expectCode(
      admitDualEnvelopeSession(admission(ledgerPath, "second-full", "api_testing", 100_000_000)),
      "envelope_exhausted"
    );
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
      standingAggregateLedgerPath: aggregatePaths.get(ledgerPath)!,
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
      standingAggregateLedgerPath: aggregatePaths.get(ledgerPath)!,
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
