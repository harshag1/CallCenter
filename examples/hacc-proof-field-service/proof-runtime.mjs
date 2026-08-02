import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function stableId(namespace, ...parts) {
  return `${namespace}_${digest(parts.join("\0")).slice(0, 20)}`;
}

function eventHash(event) {
  return digest({
    sequence: event.sequence,
    type: event.type,
    payload: event.payload,
    previous_hash: event.previous_hash,
  });
}

export function readJournal(path) {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, "utf8").trim();
  const events = source ? source.split("\n").map((line) => JSON.parse(line)) : [];
  let previousHash = "GENESIS";
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1 || event.previous_hash !== previousHash || event.event_hash !== eventHash(event)) {
      throw new Error(`journal integrity failed at event ${index + 1}`);
    }
    previousHash = event.event_hash;
  }
  return events;
}

export function appendEvent(path, type, payload) {
  const events = readJournal(path);
  const event = {
    sequence: events.length + 1,
    type,
    payload,
    previous_hash: events.at(-1)?.event_hash ?? "GENESIS",
  };
  event.event_hash = eventHash(event);
  writeFileSync(path, `${events.concat(event).map((item) => canonicalJson(item)).join("\n")}\n`, { mode: 0o600 });
  return event;
}

function initialState() {
  return {
    schema_version: 1,
    conversation_id: null,
    status: "new",
    active_goal: null,
    goal_stack: [],
    completed_goals: [],
    facts: {},
    receipts: {},
    admission_denials: [],
    workers: {},
    trace: [],
  };
}

export function replay(path) {
  const events = readJournal(path);
  const state = initialState();
  for (const event of events) {
    state.trace.push(event.type);
    const payload = event.payload;
    switch (event.type) {
      case "conversation.opened":
        state.conversation_id = payload.conversation_id;
        state.status = "active";
        break;
      case "intent.classified":
        state.active_goal = payload.goal;
        break;
      case "safety.branch.entered":
        state.goal_stack.push(state.active_goal);
        state.active_goal = "safety_clearance";
        break;
      case "fact.recorded":
        state.facts[payload.fact_id] = { value: payload.value, authority: payload.authority };
        break;
      case "safety.branch.completed":
        state.active_goal = state.goal_stack.pop();
        break;
      case "detour.started":
        state.goal_stack.push(state.active_goal);
        state.active_goal = payload.goal;
        break;
      case "detour.completed":
        state.completed_goals.push(state.active_goal);
        state.active_goal = state.goal_stack.pop();
        break;
      case "action.receipt.recorded":
        state.receipts[payload.receipt_id] = payload;
        break;
      case "action.admission.denied":
        state.admission_denials.push(payload);
        break;
      case "action.receipt.reconciled":
        state.receipts[payload.receipt_id] = {
          ...state.receipts[payload.receipt_id],
          status: payload.status,
          reconciliation: payload.reconciliation,
          result: payload.result,
        };
        break;
      case "worker.spawned":
        state.workers[payload.worker_id] = payload;
        break;
      case "worker.completed":
        state.workers[payload.worker_id] = { ...state.workers[payload.worker_id], ...payload };
        break;
      case "goal.completed":
        state.completed_goals.push(payload.goal);
        state.active_goal = null;
        break;
      case "conversation.completed":
        state.status = "completed";
        break;
      default:
        break;
    }
  }
  return { events, state, head_hash: events.at(-1)?.event_hash ?? "GENESIS" };
}

export function readWorld(path) {
  if (!existsSync(path)) return { effects: {}, dispatch_count: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeWorld(path, world) {
  writeFileSync(path, `${canonicalJson(world)}\n`, { mode: 0o600 });
}

const capabilityByGoal = {
  repair: new Set(["reserve_part", "record_repair", "close_work_order", "notify_dispatch"]),
  schedule_followup: new Set(["schedule_visit", "send_visit_confirmation"]),
};

function actionAllowed(state, action, confirmation) {
  if (!capabilityByGoal[state.active_goal]?.has(action)) return "capability_not_active";
  if (action === "send_visit_confirmation" && !successfulReceipt(state, "schedule_visit")) return "schedule_receipt_required";
  if (action === "reserve_part" && state.facts.safe_to_work?.value !== true) return "safety_clearance_required";
  if (action === "record_repair" && !successfulReceipt(state, "reserve_part")) return "part_receipt_required";
  if (action === "close_work_order") {
    if (!successfulReceipt(state, "record_repair")) return "repair_receipt_required";
    if (state.facts.safe_to_work?.value !== true) return "safety_clearance_required";
    if (confirmation !== "yes") return "caller_confirmation_required";
  }
  if (action === "notify_dispatch" && !successfulReceipt(state, "close_work_order")) return "closure_receipt_required";
  return null;
}

function successfulReceipt(state, action) {
  return Object.values(state.receipts).some((receipt) => receipt.action === action && receipt.status === "succeeded");
}

export function governedMutation({ journalPath, worldPath, scenario, action, arguments: args, loseResponse = false, confirmation, probe = false }) {
  const { state, head_hash: authorityHead } = replay(journalPath);
  // Invocation identity is bound to the exact durable authority snapshot. A
  // denied attempt and a later authorized attempt therefore cannot collapse
  // into one receipt, while the semantic idempotency key below still protects
  // the external effect across ambiguous delivery and replay.
  const invocationId = stableId("inv", scenario.conversation_id, action, canonicalJson(args), authorityHead);
  const receiptId = stableId("rcpt", invocationId);
  const idempotencyKey = stableId("idem", scenario.conversation_id, action, canonicalJson(args));
  const deniedReason = actionAllowed(state, action, confirmation);
  if (deniedReason) {
    appendEvent(journalPath, "action.admission.denied", {
      admission_id: stableId("admission", invocationId),
      invocation_id: invocationId,
      action,
      reason: deniedReason,
      required_attempt: !probe,
      authority_head: authorityHead,
      effect_count: 0,
    });
    return { receiptId: null, status: "denied" };
  }

  const world = readWorld(worldPath);
  world.dispatch_count[idempotencyKey] = (world.dispatch_count[idempotencyKey] ?? 0) + 1;
  if (!world.effects[idempotencyKey]) {
    world.effects[idempotencyKey] = {
      action,
      arguments: args,
      effect_id: stableId("effect", idempotencyKey),
    };
  }
  writeWorld(worldPath, world);
  appendEvent(journalPath, "action.receipt.recorded", {
    receipt_id: receiptId,
    invocation_id: invocationId,
    idempotency_key: idempotencyKey,
    action,
    status: loseResponse ? "indeterminate" : "succeeded",
    authority_head: authorityHead,
    effect_count: 1,
    ...(loseResponse ? { failure: "response_lost_after_dispatch" } : { result: world.effects[idempotencyKey] }),
  });
  return { receiptId, status: loseResponse ? "indeterminate" : "succeeded" };
}

export function reconcileMutation({ journalPath, worldPath, receiptId }) {
  const { state } = replay(journalPath);
  const receipt = state.receipts[receiptId];
  if (!receipt || receipt.status !== "indeterminate") throw new Error("only an indeterminate receipt can be reconciled");
  const world = readWorld(worldPath);
  const effect = world.effects[receipt.idempotency_key];
  if (!effect) throw new Error("authoritative read found no committed effect");
  appendEvent(journalPath, "action.receipt.reconciled", {
    receipt_id: receiptId,
    status: "succeeded",
    reconciliation: "authoritative_read_by_idempotency_key",
    result: effect,
  });
  return effect;
}

const requiredActions = [
  "schedule_visit",
  "send_visit_confirmation",
  "reserve_part",
  "record_repair",
  "close_work_order",
  "notify_dispatch",
];

function authoritativeSuccess(state, world, action) {
  const receipts = Object.values(state.receipts).filter((receipt) => receipt.action === action && receipt.status === "succeeded");
  if (receipts.length !== 1) return false;
  const receipt = receipts[0];
  return typeof receipt.idempotency_key === "string" &&
    world.dispatch_count[receipt.idempotency_key] === 1 &&
    canonicalJson(world.effects[receipt.idempotency_key]) === canonicalJson(receipt.result);
}

export function evaluateProofEvidence({ state, world, distinctProcesses, replayStateHash, journalIntegrityVerified }) {
  const receipts = Object.values(state.receipts);
  const reserveReceipt = receipts.find((receipt) => receipt.action === "reserve_part" && receipt.status === "succeeded");
  const deniedSafetyProbe = state.admission_denials.find((denial) => denial.action === "reserve_part" && denial.required_attempt === false);
  const worker = Object.values(state.workers)[0];
  const deniedRequired = state.admission_denials.some((denial) => denial.required_attempt && requiredActions.includes(denial.action)) ||
    receipts.some((receipt) => requiredActions.includes(receipt.action) && receipt.status === "denied");
  const unresolvedRequired = receipts.some((receipt) => requiredActions.includes(receipt.action) && receipt.status !== "succeeded");
  const requiredEffectsSucceeded = requiredActions.every((action) => authoritativeSuccess(state, world, action));
  const registeredGoalPredicatesSatisfied = state.status === "completed" && state.active_goal === null &&
    state.goal_stack.length === 0 && state.completed_goals.includes("schedule_followup") &&
    state.completed_goals.includes("repair") && requiredEffectsSucceeded;
  const assertions = {
    classified: state.trace.includes("intent.classified"),
    safety_branch_blocked_unsafe_mutation: deniedSafetyProbe?.reason === "safety_clearance_required" && deniedSafetyProbe.effect_count === 0,
    detour_resumed_original_goal: state.completed_goals.includes("schedule_followup") &&
      state.completed_goals.includes("repair") && successfulReceipt(state, "schedule_visit") &&
      successfulReceipt(state, "send_visit_confirmation"),
    lost_response_reconciled_without_retry: reserveReceipt?.reconciliation === "authoritative_read_by_idempotency_key" &&
      world.dispatch_count[reserveReceipt.idempotency_key] === 1,
    worker_was_read_only: worker?.status === "succeeded" && worker?.capabilities?.length === 1 && worker?.mutation_count === 0,
    fresh_process_replay: distinctProcesses === true && replayStateHash === digest(state),
    journal_integrity_verified: journalIntegrityVerified === true,
    no_denied_required_actions: !deniedRequired,
    no_unresolved_required_receipts: !unresolvedRequired,
    registered_goal_predicates_satisfied: registeredGoalPredicatesSatisfied,
    terminal_actions_authoritatively_succeeded: authoritativeSuccess(state, world, "close_work_order") &&
      authoritativeSuccess(state, world, "notify_dispatch"),
    mission_completed: registeredGoalPredicatesSatisfied && !deniedRequired && !unresolvedRequired,
  };
  return { assertions, passed: Object.values(assertions).every(Boolean) };
}

export function finalArtifact({ journalPath, worldPath, distinctProcesses, replayStateHash }) {
  const { events, state, head_hash: headHash } = replay(journalPath);
  const world = readWorld(worldPath);
  const receipts = Object.values(state.receipts).sort((a, b) => a.receipt_id.localeCompare(b.receipt_id));
  const evaluation = evaluateProofEvidence({
    state,
    world,
    distinctProcesses,
    replayStateHash,
    journalIntegrityVerified: events.length > 0,
  });
  return {
    schema_version: 1,
    proof: "hacc-provider-free-field-service-v1",
    provider: null,
    network_calls: 0,
    database_calls: 0,
    expected_spend_usd: 0,
    event_count: events.length,
    journal_head_sha256: headHash,
    final_state_sha256: digest(state),
    world_sha256: digest(world),
    assertions: evaluation.assertions,
    passed: evaluation.passed,
    final_state: state,
    authoritative_world: world,
    receipts,
  };
}
