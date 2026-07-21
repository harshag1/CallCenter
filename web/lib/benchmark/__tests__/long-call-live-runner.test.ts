import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function runnerSource(): Promise<string> {
  return readFile(resolve(process.cwd(), "scripts/long-call-live-benchmark.ts"), "utf8");
}

describe("HACC-LC3 live runner release contract", () => {
  it("binds paid execution to the signed append-only aggregate ledger lifecycle", async () => {
    const source = await runnerSource();
    for (const symbol of [
      "initializeFilesystemBudgetLedger",
      "reserveFilesystemBudget",
      "markBudgetConnectionIntent",
      "markBudgetSessionOpened",
      "recordBudgetTerminal",
      "settleFilesystemBudget",
    ]) {
      expect(source).toContain(symbol);
    }
    expect(source).toContain("upper_bound_micro_usd: 5_000_000");
    expect(source).toContain("operationalCeilingUsd: LONG_CALL_MAXIMUM_AGGREGATE_USD");
  });

  it("freezes the long-call bounds and blocks reporting before ASR scoring", async () => {
    const source = await runnerSource();
    expect(source).toContain("leaseTtlSeconds: 12 * 60");
    expect(source).toContain("maxSessionMs: 9 * 60_000");
    expect(source).toContain("maxOutputAudioBytes: 64 * 1024 * 1024");
    expect(source).toContain("ASR semantic scoring is incomplete");
    expect(source).toContain("summary.asrReceiptsSha256 ??");
    expect(source).toContain("evaluateLongCallModelIntegrity(result.world, publicTranscript)");
    expect(source).toContain("assertHostManagedGrantExposure(publicTranscript)");
    expect(source).toContain("isLongCallMissionCompletionPass(summary)");
    expect(source).not.toContain("autoAdvanceLinearFlow:");
  });

  it("does not commit a developer-machine credential path", async () => {
    const source = await runnerSource();
    expect(source).not.toContain("/Users/");
    expect(source).not.toContain("staging-runtime-provider.env");
    expect(source).toContain("--env-file must be an absolute normalized path");
  });

  it("is exposed as the package long-call command", async () => {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["benchmark:long-call"]).toBe("tsx scripts/long-call-live-benchmark.ts");
  });
});
