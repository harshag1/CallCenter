import { createHash } from "node:crypto";
import { runFlowScenario } from "./agent/tools/flow-testing";
import { canonicalJson } from "./conversation-kernel";
import { listStepRefs } from "./flow";
import {
  analyzeFlowV2Import,
  materializeFlowV2Import,
  type FlowV2ImportPlan,
} from "./flow-package";

type JsonObject = Record<string, unknown>;

export type OfflineDemoTool = Readonly<{
  execute: (arguments_: JsonObject) => unknown;
}>;

export type OfflineDemoToolRegistry = Readonly<Record<string, OfflineDemoTool>>;

type FakeCallReceipt = Readonly<{
  invocation_id: string;
  tool: string;
  arguments_sha256: string;
  result_sha256: string;
}>;

type OfflineDemoFailure = Readonly<{
  ok: false;
  mode: "offline";
  stage: "catalog_admission" | "tool_execution" | "scenario_simulation" | "proof_verification";
  error: string;
  details?: unknown;
}>;

export type OfflineDemoSuccess = Readonly<{
  ok: true;
  mode: "offline";
  installation: Readonly<{
    persistence: "in_memory";
    flow_sha256: string;
    catalog_closed: true;
    registered_tools: number;
    flow_steps: number;
  }>;
  simulation: Readonly<{
    topic: "appointment";
    events: number;
    completed_steps: readonly string[];
    flow_receipts: number;
    fake_tool_calls: number;
    indeterminate_dispatches_reconciled: 1;
    provider_calls: 0;
    database_writes: 0;
  }>;
  evidence: Readonly<{
    fake_call_receipts: readonly FakeCallReceipt[];
    fake_call_receipts_sha256: string;
    trace_sha256: string;
    final_state_sha256: string;
  }>;
  final: unknown;
}>;

export type OfflineDemoResult = OfflineDemoSuccess | OfflineDemoFailure;

const DEMO_STARTED_AT = "2026-01-01T00:00:00.000Z";
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function tool(execute: OfflineDemoTool["execute"]): OfflineDemoTool {
  return Object.freeze({ execute });
}

/**
 * Complete deterministic catalog for the service-appointment example.
 * These fixtures make no network, provider, database, email, SMS, or telephony calls.
 */
export function createOfflineDemoToolRegistry(): OfflineDemoToolRegistry {
  return Object.freeze({
    capture_booking_consent: tool(() => ({ granted: true, evidence_id: "consent_demo_001" })),
    capture_cancellation_consent: tool(() => ({ granted: true, evidence_id: "cancel_consent_demo_001" })),
    capture_service_preferences: tool(() => ({ preference_set_id: "preferences_demo_001" })),
    capture_slot_review: tool(() => ({ accepted: true })),
    classify_appointment_intent: tool(() => ({ intent: "book" })),
    commit_service_appointment_operation: tool(() => ({
      status: "dispatched_without_response",
      error: "deterministic timeout after dispatch",
    })),
    commit_service_cancellation: tool(() => ({ cancellation_id: "cancellation_demo_001" })),
    contact_support: tool(() => ({ accepted: true, transfer_id: "transfer_demo_001" })),
    end_call: tool(() => ({ accepted: true })),
    lookup_appointment_invocation: tool((arguments_) => ({
      invocation_id: arguments_.invocation_id,
      terminal: "committed",
      result: {
        appointment_id: "appointment_demo_001",
        scheduled_at: "2026-02-03T15:30:00.000Z",
      },
    })),
    lookup_cancellation_invocation: tool((arguments_) => ({
      invocation_id: arguments_.invocation_id,
      terminal: "absent",
    })),
    lookup_existing_appointment: tool(() => ({
      appointment_id: "appointment_existing_demo_001",
    })),
    lookup_service_customer: tool(() => ({ customer_id: "customer_demo_001" })),
    request_recall: tool(() => ({ accepted: true, recall_id: "recall_demo_001" })),
    search_service_slots: tool(() => ({
      search_id: "search_demo_001",
      slots: [{
        slot_token: "slot_demo_001",
        scheduled_at: "2026-02-03T15:30:00.000Z",
      }],
    })),
    select_service_slot: tool(() => ({ slot_token: "slot_demo_001" })),
    submit_appointment_notification: tool(() => ({
      accepted: true,
      submission_id: "notification_demo_001",
    })),
  });
}

function admissionFailure(plan: FlowV2ImportPlan): OfflineDemoFailure {
  return Object.freeze({
    ok: false,
    mode: "offline",
    stage: "catalog_admission",
    error: "Flow v2 example was not install-ready; simulation was not started",
    details: {
      valid: plan.valid,
      diagnostics: plan.diagnostics,
      catalog: plan.catalog,
    },
  });
}

/**
 * Installs the supplied Flow v2 definition in memory, invokes deterministic fixture tools, and
 * runs the production scenario simulator over a deep appointment path. Any missing dependency,
 * tool exception, simulator failure, or missing recovery proof returns `ok:false`.
 */
export function runOfflineFlowDemo(
  flowInput: unknown,
  registry: OfflineDemoToolRegistry = createOfflineDemoToolRegistry()
): OfflineDemoResult {
  const toolNames = Object.entries(registry)
    .filter(([, candidate]) => typeof candidate?.execute === "function")
    .map(([name]) => name);
  const plan = analyzeFlowV2Import(flowInput, { availableTools: toolNames });
  if (!plan.readyForInstall || !plan.flowSha256) return admissionFailure(plan);

  let flow;
  try {
    flow = materializeFlowV2Import(plan);
  } catch (error) {
    return Object.freeze({
      ok: false,
      mode: "offline",
      stage: "catalog_admission",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const fakeReceipts: FakeCallReceipt[] = [];
  let invocation = 0;
  const invoke = (name: string, arguments_: JsonObject): unknown => {
    const registered = registry[name];
    if (!registered || typeof registered.execute !== "function") {
      throw new Error(`fixture tool is not registered: ${name}`);
    }
    const result = registered.execute(structuredClone(arguments_));
    fakeReceipts.push(Object.freeze({
      invocation_id: `fake:${String(++invocation).padStart(2, "0")}:${name}`,
      tool: name,
      arguments_sha256: sha256(arguments_),
      result_sha256: sha256(result),
    }));
    return structuredClone(result);
  };

  const events: JsonObject[] = [];
  const step = (
    path: string,
    receiptId: string,
    name: string,
    arguments_: JsonObject
  ): void => {
    const result = invoke(name, arguments_);
    events.push(
      { type: "enter_step", path },
      {
        type: "action",
        receipt_id: receiptId,
        tool: name,
        arguments: arguments_,
        outcome: "succeeded",
        result,
      },
      { type: "complete_step", outputs: {} }
    );
  };

  try {
    step(
      "appointment.route",
      "receipt:customer",
      "lookup_service_customer",
      { account_reference: "DEMO-100", verification_factor: "postal_code" }
    );
    step(
      "appointment.route.intent",
      "receipt:intent",
      "classify_appointment_intent",
      { utterance: "I need to book a service visit" }
    );
    step(
      "appointment.schedule",
      "receipt:preferences",
      "capture_service_preferences",
      {
        customer_id: "customer_demo_001",
        category: "appliance",
        timing: "weekday afternoon",
      }
    );
    step(
      "appointment.schedule.search",
      "receipt:search",
      "search_service_slots",
      { preference_set_id: "preferences_demo_001" }
    );
    step(
      "appointment.schedule.search.select",
      "receipt:slot",
      "select_service_slot",
      { search_id: "search_demo_001", slot_token: "slot_demo_001" }
    );
    step(
      "appointment.schedule.search.select.review",
      "receipt:review",
      "capture_slot_review",
      { slot_token: "slot_demo_001", response: "That works" }
    );
    step(
      "appointment.consent",
      "receipt:consent",
      "capture_booking_consent",
      {
        customer_id: "customer_demo_001",
        slot_token: "slot_demo_001",
        response: "Yes, book it",
      }
    );

    const commitArguments = {
      customer_id: "customer_demo_001",
      slot_token: "slot_demo_001",
      consent_evidence_id: "consent_demo_001",
    };
    const commitDispatch = invoke("commit_service_appointment_operation", commitArguments);
    if (
      !commitDispatch ||
      typeof commitDispatch !== "object" ||
      (commitDispatch as JsonObject).status !== "dispatched_without_response"
    ) {
      throw new Error("commit fixture must model a lost response after dispatch");
    }
    events.push(
      { type: "enter_step", path: "appointment.commit" },
      {
        type: "action",
        receipt_id: "receipt:commit",
        tool: "commit_service_appointment_operation",
        arguments: commitArguments,
        outcome: "reserved",
        dispatch_started: true,
      },
      { type: "interrupt", reason: "process_restart" },
      {
        type: "action",
        receipt_id: "receipt:commit",
        tool: "commit_service_appointment_operation",
        arguments: commitArguments,
        outcome: "succeeded",
        result: { appointment_id: "must_not_replace_authoritative_readback" },
      }
    );

    const proof = invoke("lookup_appointment_invocation", {
      invocation_id: "demo-commit-invocation-001",
      customer_id: "customer_demo_001",
    });
    if (
      !proof ||
      typeof proof !== "object" ||
      (proof as JsonObject).terminal !== "committed" ||
      !(proof as JsonObject).result
    ) {
      throw new Error("reconciliation fixture did not return an authoritative committed result");
    }
    events.push(
      {
        type: "reconcile_action",
        receipt_id: "receipt:commit",
        proof_id: "proof:appointment-readback:001",
        resolution: "committed",
        result: (proof as JsonObject).result,
      },
      { type: "complete_step", outputs: {} }
    );

    step(
      "appointment.commit.followup",
      "receipt:notification",
      "submit_appointment_notification",
      {
        appointment_id: "appointment_demo_001",
        channel: "sms",
      }
    );
  } catch (error) {
    return Object.freeze({
      ok: false,
      mode: "offline",
      stage: "tool_execution",
      error: error instanceof Error ? error.message : String(error),
      details: { fake_call_receipts: fakeReceipts },
    });
  }

  const scenario = {
    topic: "appointment",
    started_at: DEMO_STARTED_AT,
    events,
    expect: {
      status: "completed",
      topic: "appointment",
      current_step: null,
      completed_steps: [
        "appointment.route",
        "appointment.route.intent",
        "appointment.schedule",
        "appointment.schedule.search",
        "appointment.schedule.search.select",
        "appointment.schedule.search.select.review",
        "appointment.consent",
        "appointment.commit",
        "appointment.commit.followup",
      ],
      next_steps: [],
      outputs: {
        "appointment.route": { customer_id: "customer_demo_001" },
        "appointment.route.intent": { intent: "book" },
        "appointment.schedule": { preference_set_id: "preferences_demo_001" },
        "appointment.schedule.search": { slot_search_id: "search_demo_001" },
        "appointment.schedule.search.select": { slot_token: "slot_demo_001" },
        "appointment.schedule.search.select.review": { slot_accepted: true },
        "appointment.consent": { consent_granted: true },
        "appointment.commit": {
          appointment_id: "appointment_demo_001",
          scheduled_at: "2026-02-03T15:30:00.000Z",
        },
        "appointment.commit.followup": { notification_accepted: true },
      },
      checkpoints: [
        "appointment.route",
        "appointment.schedule",
        "appointment.commit",
      ],
      receipt_statuses: {
        "receipt:customer": { status: "succeeded", tool: "lookup_service_customer" },
        "receipt:intent": { status: "succeeded", tool: "classify_appointment_intent" },
        "receipt:preferences": { status: "succeeded", tool: "capture_service_preferences" },
        "receipt:search": { status: "succeeded", tool: "search_service_slots" },
        "receipt:slot": { status: "succeeded", tool: "select_service_slot" },
        "receipt:review": { status: "succeeded", tool: "capture_slot_review" },
        "receipt:consent": { status: "succeeded", tool: "capture_booking_consent" },
        "receipt:commit": {
          status: "succeeded",
          tool: "commit_service_appointment_operation",
          reconciliation_proof_id: "proof:appointment-readback:001",
        },
        "receipt:notification": { status: "succeeded", tool: "submit_appointment_notification" },
      },
    },
  };

  const simulation = runFlowScenario(flow, scenario);
  if (!simulation.ok) {
    return Object.freeze({
      ok: false,
      mode: "offline",
      stage: "scenario_simulation",
      error: "receipt-backed scenario did not satisfy its exact terminal assertions",
      details: simulation,
    });
  }

  const commitReplay = simulation.trace.find((entry) =>
    !!entry && typeof entry === "object" &&
    (entry as JsonObject).type === "action" &&
    (entry as JsonObject).receipt_id === "receipt:commit" &&
    (entry as JsonObject).execute === false);
  const reconciliation = simulation.trace.find((entry) =>
    !!entry && typeof entry === "object" &&
    (entry as JsonObject).type === "reconcile_action" &&
    (entry as JsonObject).proof_id === "proof:appointment-readback:001");
  const final = simulation.final as JsonObject;
  const actionReceipts = Array.isArray(final.action_receipts) ? final.action_receipts : [];
  const proofChecks = [
    simulation.assertions?.passed === true,
    commitReplay !== undefined,
    reconciliation !== undefined,
    actionReceipts.length === 9,
    fakeReceipts.length === 10,
    plan.catalog.required.length === 17,
    plan.catalog.missing.length === 0,
    listStepRefs(flow).length === 15,
    SHA256.test(plan.flowSha256),
  ];
  if (proofChecks.some((passed) => !passed)) {
    return Object.freeze({
      ok: false,
      mode: "offline",
      stage: "proof_verification",
      error: "simulation returned without the complete receipt/replay/catalog proof set",
      details: {
        proof_checks: proofChecks,
        flow_receipts: actionReceipts.length,
        fake_tool_calls: fakeReceipts.length,
      },
    });
  }

  const canonicalFinal = jsonRoundTrip(simulation.final);
  const success: OfflineDemoSuccess = {
    ok: true,
    mode: "offline",
    installation: {
      persistence: "in_memory",
      flow_sha256: plan.flowSha256,
      catalog_closed: true,
      registered_tools: plan.catalog.available.length,
      flow_steps: listStepRefs(flow).length,
    },
    simulation: {
      topic: "appointment",
      events: events.length,
      completed_steps: scenario.expect.completed_steps,
      flow_receipts: actionReceipts.length,
      fake_tool_calls: fakeReceipts.length,
      indeterminate_dispatches_reconciled: 1,
      provider_calls: 0,
      database_writes: 0,
    },
    evidence: {
      fake_call_receipts: Object.freeze([...fakeReceipts]),
      fake_call_receipts_sha256: sha256(fakeReceipts),
      trace_sha256: sha256(simulation.trace),
      final_state_sha256: sha256(canonicalFinal),
    },
    final: canonicalFinal,
  };
  return Object.freeze(success);
}
