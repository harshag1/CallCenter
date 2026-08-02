#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const example = join(root, "examples", "hacc-proof-field-service");
const testMode = process.argv.slice(2).includes("--test");
const allowed = new Set(["--json", "--test"]);

for (const argument of process.argv.slice(2)) {
  if (!allowed.has(argument)) {
    process.stderr.write("Usage: npm run demo:proof -- [--json|--test]\n");
    process.exit(2);
  }
}

const target = testMode ? join(example, "proof.test.mjs") : join(example, "run-proof.mjs");
const args = testMode
  ? ["--test", target]
  : [target, ...(process.argv.includes("--json") ? ["--json"] : [])];

// The proof does not inherit credentials. Its only authority is local fixture I/O.
const environment = {
  HACC_PROVIDER_FREE_PROOF: "1",
  LANG: process.env.LANG ?? "C",
  PATH: process.env.PATH ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
};

const outcome = spawnSync(process.execPath, args, {
  cwd: root,
  env: environment,
  stdio: "inherit",
});

if (outcome.error) throw outcome.error;
process.exit(outcome.status ?? 1);
