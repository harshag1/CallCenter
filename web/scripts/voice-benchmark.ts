#!/usr/bin/env node

import { runBenchmarkCli } from "../lib/benchmark/benchmark-cli";
import { executePaidBenchmarkRun } from "../lib/benchmark/paid-runner";

async function main(): Promise<void> {
  process.exitCode = await runBenchmarkCli(process.argv.slice(2), {
    executePaid: executePaidBenchmarkRun,
  });
}

void main();
