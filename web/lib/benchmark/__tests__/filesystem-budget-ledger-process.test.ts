import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeFilesystemBudgetLedger,
  inspectFilesystemBudgetLedger,
} from "../filesystem-budget-ledger";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runWorker(
  helper: string,
  ledgerPath: string,
  id: number,
  authority?: Readonly<{ head: string; ledgerId: string }>,
): Promise<string> {
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", helper, ledgerPath, String(id),
      ...(authority ? [authority.head, authority.ledgerId] : []),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectWorker);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectWorker(new Error(`worker exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      resolveWorker(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

describe("filesystem budget ledger cross-process admission", () => {
  it("admits exactly 15 of 24 racing $1 workers under the operational gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-budget-process-"));
    roots.push(root);
    const ledgerPath = join(root, "budget.jsonl");
    await initializeFilesystemBudgetLedger({
      ledgerPath,
      ledgerId: "hacc-process-race-ledger",
      operationId: "initialize-process-race",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const helper = resolve(process.cwd(), "lib/benchmark/__tests__/helpers/budget-ledger-worker.ts");
    const outcomes = await Promise.all(Array.from({ length: 24 }, (_, index) => runWorker(helper, ledgerPath, index)));
    expect(outcomes.filter((outcome) => outcome === "admitted")).toHaveLength(15);
    expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(9);

    const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath });
    expect(snapshot.reservations).toHaveLength(15);
    expect(snapshot.active_reservations_micro_usd).toBe(15_000_000);
    expect(snapshot.state).toBe("operational_closed");
    expect(snapshot.sequence).toBe(16);
  }, 90_000);

  it("admits exactly one racing process for the same signed open-head authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-plan-consumption-process-"));
    roots.push(root);
    const ledgerPath = join(root, "budget.jsonl");
    const initialized = await initializeFilesystemBudgetLedger({
      ledgerPath,
      ledgerId: "hacc-process-plan-authority",
      operationId: "initialize-process-plan-authority",
      operationalCeilingUsd: "5",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const helper = resolve(process.cwd(), "lib/benchmark/__tests__/helpers/budget-ledger-worker.ts");
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => runWorker(
      helper,
      ledgerPath,
      index + 1,
      {
        head: initialized.snapshot.head_sha256,
        ledgerId: initialized.snapshot.ledger_id,
      },
    )));
    expect(outcomes.filter((outcome) => outcome === "admitted")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(11);
    const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath });
    expect(snapshot.reservations).toHaveLength(1);
    expect(snapshot.active_reservations_micro_usd).toBe(5_000_000);
    expect(snapshot.sequence).toBe(2);
  }, 90_000);
});
