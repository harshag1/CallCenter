#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { appendEvent, digest, governedMutation, reconcileMutation, replay, stableId } from "./proof-runtime.mjs";

if (process.env.HACC_PROVIDER_FREE_PROOF !== "1") throw new Error("provider-free proof authority is required");

const [phase, journalPath, worldPath, scenarioPath] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

if (phase === "initial") {
  appendEvent(journalPath, "conversation.opened", { conversation_id: scenario.conversation_id });
  appendEvent(journalPath, "intent.classified", { goal: scenario.initial_intent, confidence_basis: "registered_fixture" });
  appendEvent(journalPath, "fact.recorded", { fact_id: "identity_verified", value: true, authority: "tool" });
  appendEvent(journalPath, "safety.branch.entered", { reason: "safe_to_work_unknown" });
  appendEvent(journalPath, "fact.recorded", { fact_id: "safe_to_work", value: scenario.safety.initially_safe, authority: "policy" });
  appendEvent(journalPath, "safety.branch.completed", { outcome: "mutation_blocked_until_clearance" });

  governedMutation({
    journalPath,
    worldPath,
    scenario,
    action: "reserve_part",
    arguments: { work_order_id: scenario.work_order_id, sku: scenario.repair.part_sku },
    probe: true,
  });

  appendEvent(journalPath, "safety.branch.entered", { reason: "authoritative_clearance_available" });
  appendEvent(journalPath, "fact.recorded", { fact_id: "safe_to_work", value: scenario.safety.cleared, authority: scenario.safety.clearance_authority });
  appendEvent(journalPath, "safety.branch.completed", { outcome: "cleared" });
  appendEvent(journalPath, "detour.started", { goal: scenario.detour.goal, parent_goal: "repair" });
  governedMutation({
    journalPath,
    worldPath,
    scenario,
    action: "schedule_visit",
    arguments: { customer_id: scenario.customer_id, slot: scenario.detour.slot },
  });
  governedMutation({
    journalPath,
    worldPath,
    scenario,
    action: "send_visit_confirmation",
    arguments: { customer_id: scenario.customer_id, slot: scenario.detour.slot },
  });
  appendEvent(journalPath, "detour.completed", { goal: scenario.detour.goal });
  appendEvent(journalPath, "goal.resumed", { goal: "repair" });

  const reservation = governedMutation({
    journalPath,
    worldPath,
    scenario,
    action: "reserve_part",
    arguments: { work_order_id: scenario.work_order_id, sku: scenario.repair.part_sku },
    loseResponse: true,
  });
  const workerId = stableId("worker", scenario.conversation_id, scenario.worker.bulletin_id);
  appendEvent(journalPath, "worker.spawned", {
    worker_id: workerId,
    status: "pending",
    capabilities: [scenario.worker.capability],
    parent_goal: "repair",
    input: { bulletin_id: scenario.worker.bulletin_id },
  });
  appendEvent(journalPath, "process.interrupted", { after: "mutation_dispatch", simulated: true });
  process.stdout.write(`${JSON.stringify({ pid: process.pid, receipt_id: reservation.receiptId, worker_id: workerId })}\n`);
} else if (phase === "recover") {
  const { state } = replay(journalPath);
  const indeterminate = Object.values(state.receipts).find((receipt) => receipt.action === "reserve_part" && receipt.status === "indeterminate");
  if (!indeterminate) throw new Error("indeterminate receipt missing from durable replay");

  reconcileMutation({ journalPath, worldPath, receiptId: indeterminate.receipt_id });
  process.stdout.write(`${JSON.stringify({ pid: process.pid, receipt_id: indeterminate.receipt_id })}\n`);
} else if (phase === "worker") {
  const { state } = replay(journalPath);
  const worker = Object.values(state.workers).find((candidate) => candidate.status === "pending");
  if (!worker || worker.capabilities.length !== 1 || worker.capabilities[0] !== scenario.worker.capability) {
    throw new Error("read-only worker manifest missing from durable replay");
  }
  appendEvent(journalPath, "worker.completed", {
    worker_id: worker.worker_id,
    status: "succeeded",
    capabilities: worker.capabilities,
    mutation_count: 0,
    result: { bulletin_id: scenario.worker.bulletin_id, finding: scenario.worker.finding },
  });
  process.stdout.write(`${JSON.stringify({ pid: process.pid, worker_id: worker.worker_id })}\n`);
} else if (phase === "finalize") {
  const { state } = replay(journalPath);
  const reconciled = Object.values(state.receipts).some((receipt) => receipt.action === "reserve_part" && receipt.status === "succeeded");
  const workerSucceeded = Object.values(state.workers).some((worker) => worker.status === "succeeded" && worker.mutation_count === 0);
  if (!reconciled || !workerSucceeded) throw new Error("finalization prerequisites missing from durable replay");
  governedMutation({
    journalPath,
    worldPath,
    scenario,
    action: "record_repair",
    arguments: { work_order_id: scenario.work_order_id, serial_evidence: scenario.repair.serial_evidence },
  });
  governedMutation({
    journalPath,
    worldPath,
    scenario,
    action: "close_work_order",
    arguments: { work_order_id: scenario.work_order_id },
    confirmation: scenario.repair.caller_close_confirmation,
  });
  governedMutation({
    journalPath,
    worldPath,
    scenario,
    action: "notify_dispatch",
    arguments: { work_order_id: scenario.work_order_id },
  });
  appendEvent(journalPath, "goal.completed", { goal: "repair" });
  appendEvent(journalPath, "conversation.completed", { outcome: "useful_mission_success" });
  process.stdout.write(`${JSON.stringify({ pid: process.pid })}\n`);
} else if (phase === "replay") {
  const result = replay(journalPath);
  process.stdout.write(`${JSON.stringify({ pid: process.pid, state_sha256: digest(result.state) })}\n`);
} else {
  throw new Error("phase must be initial, recover, worker, finalize, or replay");
}
