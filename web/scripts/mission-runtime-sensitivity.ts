#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { link, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { runMissionRuntimeSensitivityBenchmark } from "../lib/benchmark/mission-runtime-sensitivity";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} exceeds safe integer precision`);
  return value;
}

async function publishNoClobber(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const descriptor = await open(temporary, "r");
    try {
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write([
      "Usage: npm run benchmark:mission-runtime -- [options]",
      "",
      "Options:",
      "  --trials N       Number of seeded trials (default 1000)",
      "  --seed-start N   First deterministic seed (default 1)",
      "  --out FILE       No-clobber JSON artifact path",
      "  --help           Show this help",
      "",
    ].join("\n"));
    return;
  }
  const trials = integer("trials", 1_000);
  const seedStart = integer("seed-start", 1);
  const output = resolve(option("out") ?? "../benchmarks/voice-long-horizon/.local/mission-runtime-sensitivity.json");
  const started = performance.now();
  const report = runMissionRuntimeSensitivityBenchmark({ trials, seed_start: seedStart });
  const elapsedMs = performance.now() - started;
  await publishNoClobber(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output,
    result_hash: report.result_hash,
    trials: report.trials,
    raw_strict_pass_rate: report.strict_pass.raw_rate,
    mission_strict_pass_rate: report.strict_pass.mission_rate,
    absolute_difference: report.strict_pass.absolute_difference,
    raw_unsafe_effects: report.raw_effects.unsafe_effect_count,
    mission_blocked_attempts: report.mission.blocked_attempt_count,
    elapsed_ms: Math.round(elapsedMs * 100) / 100,
    claim_scope: "deterministic runtime sensitivity; not model quality",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
