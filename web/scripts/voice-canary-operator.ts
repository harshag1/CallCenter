#!/usr/bin/env node

import { runCanaryOperatorCli } from "../lib/benchmark/canary-operator";

void runCanaryOperatorCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
