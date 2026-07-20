#!/usr/bin/env node

/**
 * Provider-incapable benchmark entrypoint for Gate 0 and pre-canary proof.
 *
 * Keep this module's runtime import closure provider-free. In particular, do
 * not import paid-runner or any realtime adapter here. `run paid` therefore
 * reaches benchmark-cli's explicit paid_executor_unavailable failure before a
 * credential read, reservation, client construction, or socket can occur.
 */
import { runBenchmarkCli } from "../lib/benchmark/benchmark-cli";

async function main(): Promise<void> {
  process.exitCode = await runBenchmarkCli(process.argv.slice(2));
}

void main();
