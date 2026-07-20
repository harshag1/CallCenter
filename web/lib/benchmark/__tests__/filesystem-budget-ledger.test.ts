import { appendFile, chmod, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  FilesystemBudgetLedgerError,
  cancelFilesystemBudgetBeforeOpen,
  expireFilesystemBudgetReservation,
  initializeFilesystemBudgetLedger,
  inspectFilesystemBudgetLedger,
  markBudgetConnectionIntent,
  markBudgetSessionOpened,
  reconcileFilesystemBudget,
  recordBudgetTerminal,
  recordFilesystemProviderCost,
  recoverFilesystemBudgetHead,
  reserveFilesystemBudget,
  setFilesystemBudgetPaused,
  settleFilesystemBudget,
  type BudgetCostEnvelope,
} from "../filesystem-budget-ledger";

const roots: string[] = [];
const H = "a".repeat(64);
const TEST_NOW = "2026-07-10T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ledgerPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hacc-budget-"));
  roots.push(root);
  return join(root, "budget.jsonl");
}

function envelope(maximumUsd: number): BudgetCostEnvelope {
  return Object.freeze({
    schema_version: 1,
    kind: "hacc_provider_gate1_cost_envelope",
    pricing_snapshot_sha256: H,
    provider_hard_session_caps_sha256: "b".repeat(64),
    runner_config_sha256: "c".repeat(64),
    formula_sha256: "d".repeat(64),
    components: Object.freeze([Object.freeze({
      name: "pessimistic-provider-charge",
      upper_bound_micro_usd: maximumUsd * 1_000_000,
    })]),
    safety_margin_micro_usd: 0,
  });
}

function reservation(path: string, id: string, maximumUsd = 1, expiresAt = "2026-07-10T13:00:00.000Z") {
  return {
    ledgerPath: path,
    operationId: `reserve-${id}`,
    reservationId: `reservation-${id}`,
    runId: `run-${id}`,
    provider: "openai",
    model: "gpt-realtime-2.1",
    condition: "full-harness",
    expiresAt,
    costEnvelope: envelope(maximumUsd),
    now: () => new Date(TEST_NOW),
  } as const;
}

async function initialize(path: string, now = TEST_NOW) {
  return initializeFilesystemBudgetLedger({
    ledgerPath: path,
    ledgerId: "hacc-budget-test",
    operationId: "initialize-test-ledger",
    now: () => new Date(now),
  });
}

async function expectCode(action: Promise<unknown>, code: FilesystemBudgetLedgerError["code"]): Promise<void> {
  try {
    await action;
    throw new Error("expected action to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(FilesystemBudgetLedgerError);
    expect((error as FilesystemBudgetLedgerError).code).toBe(code);
  }
}

describe("append-only filesystem budget ledger", () => {
  it("initializes an explicit signed $15/$900/$1000 ledger with private files", async () => {
    const path = await ledgerPath();
    const initialized = await initialize(path);

    expect(initialized.snapshot).toMatchObject({
      authorization_ceiling_micro_usd: 1_000_000_000,
      scheduling_stop_micro_usd: 900_000_000,
      operational_ceiling_micro_usd: 15_000_000,
      scheduling_exposure_micro_usd: 0,
      state: "open",
      sequence: 1,
    });
    expect((await readFile(path, "utf8")).split("\n")).toHaveLength(2);
    expect(await inspectFilesystemBudgetLedger({ ledgerPath: path })).toEqual(initialized.snapshot);
  });

  it("serializes concurrent reservations against fresh state without oversubscribing $15", async () => {
    const path = await ledgerPath();
    await initialize(path);

    const attempts = await Promise.allSettled(
      Array.from({ length: 40 }, (_, index) => reserveFilesystemBudget({
        ...reservation(path, String(index), 1),
        // The same idempotent reservation operation may queue behind 39
        // signing mutations when the full suite saturates the host. A lock
        // wait is not a budget refusal, so keep polling fresh ledger state.
        lockTimeoutMs: 60_000,
        lockRetryMs: 10,
      }))
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(15);
    const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(25);
    const unexpected = rejected.flatMap((result) => {
      if (
        result.reason instanceof FilesystemBudgetLedgerError
        && result.reason.code === "budget_refused"
      ) return [];
      return [{
        name: result.reason instanceof Error ? result.reason.name : "NonErrorThrow",
        code: result.reason instanceof FilesystemBudgetLedgerError
          ? result.reason.code
          : null,
        message: result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      }];
    });
    expect(unexpected).toEqual([]);

    const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath: path });
    expect(snapshot.reservations).toHaveLength(15);
    expect(snapshot.active_reservations_micro_usd).toBe(15_000_000);
    expect(snapshot.state).toBe("operational_closed");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(16);
  }, 90_000);

  it("retains the pessimistic maximum through open/crash states and charges max of every observed channel", async () => {
    const path = await ledgerPath();
    await initialize(path);
    await reserveFilesystemBudget(reservation(path, "lifecycle", 5));
    await markBudgetConnectionIntent({
      ledgerPath: path,
      operationId: "intent-lifecycle",
      reservationId: "reservation-lifecycle",
    });
    await markBudgetSessionOpened({
      ledgerPath: path,
      operationId: "opened-lifecycle",
      reservationId: "reservation-lifecycle",
    });
    await recordBudgetTerminal({
      ledgerPath: path,
      operationId: "terminal-lifecycle",
      reservationId: "reservation-lifecycle",
      outcome: "completed",
    });

    expect((await inspectFilesystemBudgetLedger({ ledgerPath: path })).scheduling_exposure_micro_usd).toBe(5_000_000);
    await settleFilesystemBudget({
      ledgerPath: path,
      operationId: "settle-lifecycle",
      reservationId: "reservation-lifecycle",
      estimatedUsd: "2",
      providerReportedUsd: "3",
    });
    await reconcileFilesystemBudget({
      ledgerPath: path,
      operationId: "reconcile-lifecycle",
      reservationId: "reservation-lifecycle",
      reconciledUsd: "1",
      evidenceSha256: H,
    });
    expect((await inspectFilesystemBudgetLedger({ ledgerPath: path })).conservative_settled_micro_usd).toBe(3_000_000);

    await recordFilesystemProviderCost({
      ledgerPath: path,
      operationId: "provider-lifecycle",
      reservationId: "reservation-lifecycle",
      providerReportedUsd: "4",
    });
    expect((await inspectFilesystemBudgetLedger({ ledgerPath: path })).conservative_settled_micro_usd).toBe(4_000_000);
  });

  it("expires or cancels only never-opening reservations", async () => {
    const path = await ledgerPath();
    await initialize(path);
    await reserveFilesystemBudget({
      ...reservation(path, "expired", 2, "2026-07-10T12:01:00.000Z"),
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    await expireFilesystemBudgetReservation({
      ledgerPath: path,
      operationId: "expire-expired",
      reservationId: "reservation-expired",
      now: () => new Date("2026-07-10T12:02:00.000Z"),
    });
    expect((await inspectFilesystemBudgetLedger({ ledgerPath: path })).scheduling_exposure_micro_usd).toBe(0);

    await reserveFilesystemBudget({
      ...reservation(path, "opening", 2, "2026-07-10T12:03:00.000Z"),
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    await markBudgetConnectionIntent({
      ledgerPath: path,
      operationId: "intent-opening",
      reservationId: "reservation-opening",
    });
    await expectCode(expireFilesystemBudgetReservation({
      ledgerPath: path,
      operationId: "expire-opening",
      reservationId: "reservation-opening",
      now: () => new Date("2026-07-10T12:04:00.000Z"),
    }), "invalid_transition");
    await expectCode(cancelFilesystemBudgetBeforeOpen({
      ledgerPath: path,
      operationId: "cancel-opening",
      reservationId: "reservation-opening",
    }), "invalid_transition");
    expect((await inspectFilesystemBudgetLedger({ ledgerPath: path })).scheduling_exposure_micro_usd).toBe(2_000_000);
  });

  it("makes operation IDs idempotent and rejects conflicting reuse and duplicate run IDs", async () => {
    const path = await ledgerPath();
    await initialize(path);
    const first = await reserveFilesystemBudget(reservation(path, "same", 1));
    const replay = await reserveFilesystemBudget(reservation(path, "same", 1));
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.event.event_sha256).toBe(first.event.event_sha256);
    expect(replay.snapshot.sequence).toBe(first.snapshot.sequence);

    await expectCode(reserveFilesystemBudget({
      ...reservation(path, "different", 2),
      operationId: "reserve-same",
    }), "operation_conflict");
    await expectCode(reserveFilesystemBudget({
      ...reservation(path, "new-id", 1),
      runId: "run-same",
    }), "duplicate_run");
  });

  it("checks release-gate ledger identity and ancestry atomically with reservation", async () => {
    const path = await ledgerPath();
    const initialized = await initialize(path);

    await reserveFilesystemBudget({
      ...reservation(path, "lineage-valid", 1),
      expectedLedgerId: initialized.snapshot.ledger_id,
      requiredAncestorHeadSha256: initialized.snapshot.head_sha256,
    });

    await expectCode(reserveFilesystemBudget({
      ...reservation(path, "lineage-wrong-id", 1),
      expectedLedgerId: "replacement-ledger-with-reused-path",
      requiredAncestorHeadSha256: initialized.snapshot.head_sha256,
    }), "integrity_failure");

    await expectCode(reserveFilesystemBudget({
      ...reservation(path, "lineage-missing-head", 1),
      expectedLedgerId: initialized.snapshot.ledger_id,
      requiredAncestorHeadSha256: "d".repeat(64),
    }), "integrity_failure");

    const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath: path });
    expect(snapshot.reservations.map((entry) => entry.reservation_id)).toEqual([
      "reservation-lineage-valid",
    ]);
  });

  it("rejects the reproduced paused-zero ABA because a plan binds the exact post-resume head", async () => {
    const path = await ledgerPath();
    const initialized = await initializeFilesystemBudgetLedger({
      ledgerPath: path,
      ledgerId: "hacc-budget-aba",
      operationId: "initialize-aba",
      operationalCeilingUsd: "5",
      initiallyPaused: true,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const pausedTriplet = await Promise.all([
      readFile(path),
      readFile(`${path}.head.json`),
      readFile(`${path}.signing-key.pem`),
    ]);
    const firstResume = await setFilesystemBudgetPaused({
      ledgerPath: path,
      operationId: "resume-first",
      paused: false,
      reasonCode: "gate1-approved",
      evidenceSha256: H,
      expectedHeadSha256: initialized.snapshot.head_sha256,
      now: () => new Date("2026-07-10T12:00:01.000Z"),
    });
    await Promise.all([
      writeFile(path, pausedTriplet[0], { mode: 0o600 }),
      writeFile(`${path}.head.json`, pausedTriplet[1], { mode: 0o600 }),
      writeFile(`${path}.signing-key.pem`, pausedTriplet[2], { mode: 0o600 }),
    ]);
    const secondResume = await setFilesystemBudgetPaused({
      ledgerPath: path,
      operationId: "resume-second",
      paused: false,
      reasonCode: "gate1-approved",
      evidenceSha256: H,
      expectedHeadSha256: initialized.snapshot.head_sha256,
      now: () => new Date("2026-07-10T12:00:02.000Z"),
    });
    expect(secondResume.snapshot.head_sha256).not.toBe(firstResume.snapshot.head_sha256);
    await expectCode(reserveFilesystemBudget({
      ...reservation(path, "stale-plan", 5),
      expectedLedgerId: initialized.snapshot.ledger_id,
      requiredAncestorHeadSha256: initialized.snapshot.head_sha256,
      requiredCurrentHeadSha256: firstResume.snapshot.head_sha256,
      planConsumption: {
        consumptionId: "stale-plan-consumption",
        planSha256: "1".repeat(64),
        maximumMicroUsd: 5_000_000,
      },
    }), "integrity_failure");
    expect((await inspectFilesystemBudgetLedger({ ledgerPath: path })).reservations).toEqual([]);
  });

  it("one-shot head authority survives exact open-triplet rollback and blocks same or different plans", async () => {
    const path = await ledgerPath();
    const initialized = await initializeFilesystemBudgetLedger({
      ledgerPath: path,
      ledgerId: "hacc-budget-open-replay",
      operationId: "initialize-open-replay",
      operationalCeilingUsd: "5",
      initiallyPaused: true,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const resumed = await setFilesystemBudgetPaused({
      ledgerPath: path,
      operationId: "resume-open-replay",
      paused: false,
      reasonCode: "gate1-approved",
      evidenceSha256: H,
      expectedHeadSha256: initialized.snapshot.head_sha256,
      now: () => new Date("2026-07-10T12:00:01.000Z"),
    });
    const openTriplet = await Promise.all([
      readFile(path),
      readFile(`${path}.head.json`),
      readFile(`${path}.signing-key.pem`),
    ]);
    const authority = {
      expectedLedgerId: initialized.snapshot.ledger_id,
      requiredAncestorHeadSha256: initialized.snapshot.head_sha256,
      requiredCurrentHeadSha256: resumed.snapshot.head_sha256,
    };
    await reserveFilesystemBudget({
      ...reservation(path, "first-plan", 5),
      ...authority,
      planConsumption: {
        consumptionId: "first-plan-consumption",
        planSha256: "1".repeat(64),
        maximumMicroUsd: 5_000_000,
      },
    });
    await Promise.all([
      writeFile(path, openTriplet[0], { mode: 0o600 }),
      writeFile(`${path}.head.json`, openTriplet[1], { mode: 0o600 }),
      writeFile(`${path}.signing-key.pem`, openTriplet[2], { mode: 0o600 }),
    ]);
    await expectCode(reserveFilesystemBudget({
      ...reservation(path, "first-plan", 5),
      ...authority,
      planConsumption: {
        consumptionId: "first-plan-consumption",
        planSha256: "1".repeat(64),
        maximumMicroUsd: 5_000_000,
      },
    }), "plan_consumed");
    await expectCode(reserveFilesystemBudget({
      ...reservation(path, "different-plan", 5),
      ...authority,
      planConsumption: {
        consumptionId: "different-plan-consumption",
        planSha256: "2".repeat(64),
        maximumMicroUsd: 5_000_000,
      },
    }), "plan_consumed");
    const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath: path });
    expect(snapshot.sequence).toBe(2);
    expect(snapshot.reservations).toEqual([]);
    const anchorDirectory = `${path}.plan-consumptions`;
    const anchors = await readdir(anchorDirectory);
    expect(anchors).toHaveLength(1);
    expect(JSON.parse(await readFile(join(anchorDirectory, anchors[0]!), "utf8"))).toMatchObject({
      kind: "hacc_paid_plan_consumption",
      ledger_id: initialized.snapshot.ledger_id,
      ledger_open_head_sha256: resumed.snapshot.head_sha256,
      consumption_id: "first-plan-consumption",
      plan_sha256: "1".repeat(64),
      maximum_micro_usd: 5_000_000,
      run_id: "run-first-plan",
      reservation_id: "reservation-first-plan",
      operation_id: "reserve-first-plan",
    });
  });

  it("refuses reservation if the plan-anchor directory is replaced before ledger commit", async () => {
    const path = await ledgerPath();
    const initialized = await initializeFilesystemBudgetLedger({
      ledgerPath: path,
      ledgerId: "hacc-budget-anchor-race",
      operationId: "initialize-anchor-race",
      operationalCeilingUsd: "5",
      initiallyPaused: true,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const resumed = await setFilesystemBudgetPaused({
      ledgerPath: path,
      operationId: "resume-anchor-race",
      paused: false,
      reasonCode: "gate1-approved",
      evidenceSha256: H,
      expectedHeadSha256: initialized.snapshot.head_sha256,
      now: () => new Date("2026-07-10T12:00:01.000Z"),
    });
    const anchorDirectory = `${path}.plan-consumptions`;
    const detachedDirectory = `${anchorDirectory}.detached`;
    let randomIdCalls = 0;

    await expectCode(reserveFilesystemBudget({
      ...reservation(path, "anchor-race", 5),
      expectedLedgerId: initialized.snapshot.ledger_id,
      requiredAncestorHeadSha256: initialized.snapshot.head_sha256,
      requiredCurrentHeadSha256: resumed.snapshot.head_sha256,
      planConsumption: {
        consumptionId: "anchor-race-consumption",
        planSha256: "3".repeat(64),
        maximumMicroUsd: 5_000_000,
      },
      randomId: () => {
        randomIdCalls += 1;
        // First call owns the cooperative ledger lock. The second occurs only
        // after the exclusive anchor is written, immediately before mutation
        // commit; replace the directory at that precise boundary.
        if (randomIdCalls === 2) {
          renameSync(anchorDirectory, detachedDirectory);
          mkdirSync(anchorDirectory, { mode: 0o700 });
        }
        return `anchor-race-id-${randomIdCalls}`;
      },
    }), "unsafe_filesystem");

    expect(randomIdCalls).toBe(2);
    expect(await readdir(anchorDirectory)).toEqual([]);
    expect(await readdir(detachedDirectory)).toHaveLength(1);
    const after = await inspectFilesystemBudgetLedger({ ledgerPath: path });
    expect(after.sequence).toBe(resumed.snapshot.sequence);
    expect(after.head_sha256).toBe(resumed.snapshot.head_sha256);
    expect(after.reservations).toEqual([]);
  });

  it("fails closed on a stale signed head and recovers only the exact verified append-only log", async () => {
    const path = await ledgerPath();
    await initialize(path);
    const oldHead = await readFile(`${path}.head.json`);
    await reserveFilesystemBudget(reservation(path, "head", 1));
    await writeFile(`${path}.head.json`, oldHead, { mode: 0o600 });

    await expectCode(inspectFilesystemBudgetLedger({ ledgerPath: path }), "integrity_failure");
    const recovered = await recoverFilesystemBudgetHead({ ledgerPath: path });
    expect(recovered.reservations).toHaveLength(1);
    expect(await inspectFilesystemBudgetLedger({ ledgerPath: path })).toEqual(recovered);
  });

  it("rejects partial tails, hard links, unsafe permissions, and credential-shaped fields", async () => {
    const path = await ledgerPath();
    await initialize(path);
    await writeFile(path, "{", { flag: "a" });
    await expectCode(inspectFilesystemBudgetLedger({ ledgerPath: path }), "integrity_failure");

    const second = await ledgerPath();
    await initialize(second);
    const linked = `${second}.linked`;
    await link(second, linked);
    await expectCode(inspectFilesystemBudgetLedger({ ledgerPath: second }), "unsafe_filesystem");

    const third = await ledgerPath();
    await initialize(third);
    await chmod(third, 0o644);
    await expectCode(inspectFilesystemBudgetLedger({ ledgerPath: third }), "unsafe_filesystem");

    const fourth = await ledgerPath();
    await initialize(fourth);
    await expectCode(reserveFilesystemBudget({
      ...reservation(fourth, "secret", 1),
      model: "sk-supersecretcredentialmaterial",
    }), "invalid_input");
  });

  it("does not confuse xAI provider labels in run identities with API keys", async () => {
    const path = await ledgerPath();
    await initialize(path);

    const accepted = await reserveFilesystemBudget({
      ...reservation(path, "xai-provider-canary", 1),
      reservationId: "c3-xai-20260720-v6-reservation",
      runId: "c3-xai-20260720-v6-full-harness",
      provider: "xai",
      model: "grok-voice-think-fast-1.0",
    });

    expect(accepted.snapshot.reservations).toContainEqual(expect.objectContaining({
      reservation_id: "c3-xai-20260720-v6-reservation",
      provider: "xai",
    }));
  });

  it("never steals a dead same-host lock or exposes its partial append", async () => {
    const path = await ledgerPath();
    await initialize(path);
    const lock = `${path}.lock`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({
      schema_version: 1,
      nonce: "dead-lock",
      hostname: hostname(),
      pid: 999_999,
      created_at: "2026-07-10T12:00:00.000Z",
    })}\n`, { mode: 0o600 });

    // Simulate a writer that appended only part of its next event before
    // crashing. Ordinary admission must not rename the stale lock: two
    // contenders can otherwise race the rename and expose this tail while a
    // replacement writer is live.
    await appendFile(path, "{\"partial_event\":");
    await expectCode(inspectFilesystemBudgetLedger({
      ledgerPath: path,
      lockTimeoutMs: 25,
      lockRetryMs: 5,
    }), "lock_timeout");

    // Removing a stale lock is an explicit operator recovery action. The
    // existing integrity verifier still refuses the interrupted append; it
    // never truncates or repairs evidence implicitly.
    await rm(lock, { recursive: true, force: false });
    await expectCode(inspectFilesystemBudgetLedger({ ledgerPath: path }), "integrity_failure");
  });

  it("honors an append-only kill switch and refuses new work without releasing exposure", async () => {
    const path = await ledgerPath();
    await initialize(path);
    await reserveFilesystemBudget(reservation(path, "active", 1));
    await setFilesystemBudgetPaused({
      ledgerPath: path,
      operationId: "pause-ledger",
      paused: true,
      reasonCode: "operator-stop",
      evidenceSha256: sha256Hex("operator requested stop"),
    });
    expect((await inspectFilesystemBudgetLedger({ ledgerPath: path })).state).toBe("paused");
    await expectCode(reserveFilesystemBudget(reservation(path, "blocked", 1)), "paused");
    expect((await inspectFilesystemBudgetLedger({ ledgerPath: path })).active_reservations_micro_usd).toBe(1_000_000);
  });
});
