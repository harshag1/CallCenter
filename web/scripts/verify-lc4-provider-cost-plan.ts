#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../lib/benchmark/artifacts";
import { verifyLc4ProviderCostPlan } from "../lib/benchmark/lc4-provider-cost-plan";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactPath = resolve(repositoryRoot, "benchmarks/voice-long-horizon/HACC_LC4_PROVIDER_COST_PLAN.json");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const asOfDate = option("as-of") ?? new Date().toISOString().slice(0, 10);
  const input = JSON.parse(await readFile(artifactPath, "utf8")) as unknown;
  process.stdout.write(`${canonicalJson(verifyLc4ProviderCostPlan(input, { asOfDate }))}\n`);
}

main().catch((error) => {
  process.stderr.write(`${canonicalJson({
    errorClass: error instanceof Error ? error.name : "NonErrorThrow",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
