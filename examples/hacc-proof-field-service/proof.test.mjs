import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProof } from "./run-proof.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("field-service proof is deterministic, complete, and provider-free", () => {
  const first = runProof();
  const second = runProof();

  assert.equal(first.passed, true);
  assert.deepEqual(first.assertions, {
    classified: true,
    safety_branch_blocked_unsafe_mutation: true,
    detour_resumed_original_goal: true,
    lost_response_reconciled_without_retry: true,
    worker_was_read_only: true,
    fresh_process_replay: true,
    journal_integrity_verified: true,
    mission_completed: true,
  });
  assert.equal(first.provider, null);
  assert.equal(first.network_calls, 0);
  assert.equal(first.database_calls, 0);
  assert.equal(first.expected_spend_usd, 0);
  assert.equal(first.final_state_sha256, second.final_state_sha256);
  assert.equal(first.journal_head_sha256, second.journal_head_sha256);
  assert.equal(first.world_sha256, second.world_sha256);
  assert.deepEqual(first.receipts, second.receipts);

  const reserve = first.receipts.find((receipt) => receipt.action === "reserve_part" && receipt.status === "succeeded");
  assert.equal(reserve.reconciliation, "authoritative_read_by_idempotency_key");
  assert.equal(first.authoritative_world.dispatch_count[reserve.idempotency_key], 1);
});

test("proof implementation has no network, provider, database, or secret access surface", () => {
  const files = ["proof-runtime.mjs", "proof-phase.mjs", "run-proof.mjs"];
  const forbidden = /(?:node:(?:http|https|net|tls)|\bfetch\s*\(|WebSocket|API_KEY|DATABASE_URL|TWILIO|OPENAI|GEMINI|XAI)/;
  for (const file of files) {
    assert.doesNotMatch(readFileSync(join(here, file), "utf8"), forbidden, file);
  }
});
