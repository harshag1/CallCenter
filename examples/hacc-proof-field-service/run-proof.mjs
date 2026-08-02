#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finalArtifact } from "./proof-runtime.mjs";

const example = dirname(fileURLToPath(import.meta.url));
const scenarioPath = join(example, "scenario.json");
const phasePath = join(example, "proof-phase.mjs");

export function runProof() {
  const directory = mkdtempSync(join(tmpdir(), "hacc-proof-field-service-"));
  const journalPath = join(directory, "journal.jsonl");
  const worldPath = join(directory, "world.json");
  const environment = {
    HACC_PROVIDER_FREE_PROOF: "1",
    LANG: process.env.LANG ?? "C",
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
  const runPhase = (phase) => {
    const outcome = spawnSync(process.execPath, [phasePath, phase, journalPath, worldPath, scenarioPath], {
      cwd: example,
      env: environment,
      encoding: "utf8",
    });
    if (outcome.error) throw outcome.error;
    if (outcome.status !== 0) throw new Error(`${phase} failed: ${outcome.stderr}`);
    return JSON.parse(outcome.stdout);
  };

  try {
    const initial = runPhase("initial");
    const recovered = runPhase("recover");
    const worker = runPhase("worker");
    const finalized = runPhase("finalize");
    const replayed = runPhase("replay");
    const pids = [initial.pid, recovered.pid, worker.pid, finalized.pid, replayed.pid];
    const distinctProcesses = new Set(pids).size === pids.length;
    return finalArtifact({
      journalPath,
      worldPath,
      distinctProcesses,
      replayStateHash: replayed.state_sha256,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes("--json");
  const artifact = runProof();
  if (json) {
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } else {
    const rows = [
      ["classify", artifact.assertions.classified],
      ["safety branch", artifact.assertions.safety_branch_blocked_unsafe_mutation],
      ["detour + resume", artifact.assertions.detour_resumed_original_goal],
      ["lost response reconciliation", artifact.assertions.lost_response_reconciled_without_retry],
      ["read-only async worker", artifact.assertions.worker_was_read_only],
      ["fresh-process replay", artifact.assertions.fresh_process_replay],
      ["final mission", artifact.assertions.mission_completed],
    ];
    process.stdout.write("HACC provider-free field-service proof\n\n");
    for (const [label, passed] of rows) process.stdout.write(`${passed ? "PASS" : "FAIL"}  ${label}\n`);
    process.stdout.write(`\n${artifact.event_count} hash-chained events · ${artifact.receipts.length} receipts · $0 expected spend\n`);
    process.stdout.write(`state ${artifact.final_state_sha256}\n`);
  }
  process.exitCode = artifact.passed ? 0 : 1;
}
