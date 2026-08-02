import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, digest, evaluateProofEvidence, governedMutation, readWorld, reconcileMutation } from "./proof-runtime.mjs";
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
    no_denied_required_actions: true,
    no_unresolved_required_receipts: true,
    registered_goal_predicates_satisfied: true,
    terminal_actions_authoritatively_succeeded: true,
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

test("negative evidence mutations cannot preserve a passing result", () => {
  const valid = runProof();
  const evaluate = (state) => evaluateProofEvidence({
    state,
    world: valid.authoritative_world,
    distinctProcesses: true,
    replayStateHash: digest(state),
    journalIntegrityVerified: true,
  });
  const closeReceiptId = Object.values(valid.final_state.receipts)
    .find((receipt) => receipt.action === "close_work_order").receipt_id;

  const deniedClose = structuredClone(valid.final_state);
  deniedClose.receipts[closeReceiptId].status = "denied";
  assert.equal(evaluate(deniedClose).passed, false);
  assert.equal(evaluate(deniedClose).assertions.no_denied_required_actions, false);
  assert.equal(evaluate(deniedClose).assertions.terminal_actions_authoritatively_succeeded, false);

  const unresolvedClose = structuredClone(valid.final_state);
  unresolvedClose.receipts[closeReceiptId].status = "indeterminate";
  assert.equal(evaluate(unresolvedClose).passed, false);
  assert.equal(evaluate(unresolvedClose).assertions.no_unresolved_required_receipts, false);

  const missingGoalPredicate = structuredClone(valid.final_state);
  missingGoalPredicate.completed_goals = missingGoalPredicate.completed_goals.filter((goal) => goal !== "repair");
  assert.equal(evaluate(missingGoalPredicate).passed, false);
  assert.equal(evaluate(missingGoalPredicate).assertions.registered_goal_predicates_satisfied, false);
});

test("exact and conflicting ambiguous replays are quarantined before redispatch", () => {
  const directory = mkdtempSync(join(tmpdir(), "hacc-proof-replay-test-"));
  const journalPath = join(directory, "journal.jsonl");
  const worldPath = join(directory, "world.json");
  const scenario = JSON.parse(readFileSync(join(here, "scenario.json"), "utf8"));
  const originalArguments = { work_order_id: scenario.work_order_id, sku: scenario.repair.part_sku };
  try {
    appendEvent(journalPath, "conversation.opened", { conversation_id: scenario.conversation_id });
    appendEvent(journalPath, "intent.classified", { goal: "repair", confidence_basis: "test" });
    appendEvent(journalPath, "fact.recorded", { fact_id: "safe_to_work", value: true, authority: "policy" });

    const dispatched = governedMutation({
      journalPath,
      worldPath,
      scenario,
      action: "reserve_part",
      arguments: originalArguments,
      loseResponse: true,
    });
    assert.equal(dispatched.status, "indeterminate");

    const exactReplay = governedMutation({
      journalPath,
      worldPath,
      scenario,
      action: "reserve_part",
      arguments: originalArguments,
    });
    assert.deepEqual(exactReplay, {
      receiptId: dispatched.receiptId,
      status: "quarantined",
      reason: "reconciliation_required",
    });

    const conflictingReplay = governedMutation({
      journalPath,
      worldPath,
      scenario,
      action: "reserve_part",
      arguments: { ...originalArguments, sku: "CONFLICTING-SKU" },
    });
    assert.deepEqual(conflictingReplay, {
      receiptId: dispatched.receiptId,
      status: "quarantined",
      reason: "conflicting_replay",
    });

    let world = readWorld(worldPath);
    assert.deepEqual(Object.values(world.dispatch_count), [1]);
    assert.equal(Object.keys(world.effects).length, 1);

    reconcileMutation({ journalPath, worldPath, receiptId: dispatched.receiptId });
    const settledReplay = governedMutation({
      journalPath,
      worldPath,
      scenario,
      action: "reserve_part",
      arguments: originalArguments,
    });
    assert.equal(settledReplay.status, "succeeded");
    assert.equal(settledReplay.replayed, true);
    world = readWorld(worldPath);
    assert.deepEqual(Object.values(world.dispatch_count), [1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("proof implementation has no network, provider, database, or secret access surface", () => {
  const files = ["proof-runtime.mjs", "proof-phase.mjs", "run-proof.mjs"];
  const forbidden = /(?:node:(?:http|https|net|tls)|\bfetch\s*\(|WebSocket|API_KEY|DATABASE_URL|TWILIO|OPENAI|GEMINI|XAI)/;
  for (const file of files) {
    assert.doesNotMatch(readFileSync(join(here, file), "utf8"), forbidden, file);
  }
});
