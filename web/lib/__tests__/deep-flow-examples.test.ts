import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ActionReconciliationSpecSchema } from "../action-reconciliation";
import {
  alwaysTools,
  listStepRefs,
  validateAgentFlow,
  type AgentFlow,
} from "../flow";
import {
  completeFlowStep,
  createFlowExecutionState,
  deriveFlowActionInvocationId,
  enterFlowStep,
  grantedTools,
  markFlowActionDispatchStarted,
  promoteIndeterminateFlowAction,
  reserveFlowAction,
  selectFlowTopic,
  settleFlowAction,
  type FlowExecutionState,
} from "../flow-runtime";

const EXAMPLES = {
  appointment: "../../../examples/flows/service-appointment-lifecycle.json",
  warranty: "../../../examples/flows/warranty-and-incident-intake.json",
  membershipReturn: "../../../examples/flows/membership-return-resolution.json",
} as const;

function loadExample(path: string): AgentFlow {
  const input = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const validated = validateAgentFlow(input);
  expect(validated.diagnostics).toEqual([]);
  if (!validated.flow) throw new Error(`invalid example ${path}`);
  return validated.flow;
}

function expectState(
  result: FlowExecutionState | { error: string }
): asserts result is FlowExecutionState {
  if ("error" in result) throw new Error(result.error);
}

function enter(
  flow: AgentFlow,
  state: FlowExecutionState,
  path: string
): ReturnType<typeof enterFlowStep> & { state: FlowExecutionState; availableTools: string[] } {
  const result = enterFlowStep(flow, state, path);
  if ("error" in result) throw new Error(`${path}: ${result.error}`);
  return result;
}

function succeedAction(
  flow: AgentFlow,
  state: FlowExecutionState,
  receiptId: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown
): FlowExecutionState {
  const reserved = reserveFlowAction(flow, state, {
    receiptId,
    invocationId: deriveFlowActionInvocationId(`deep-example:${receiptId}`),
    tool,
    arguments: args,
    capabilityEpoch: state.capabilityEpoch,
  });
  if ("error" in reserved) throw new Error(reserved.error);
  const dispatched = markFlowActionDispatchStarted(reserved.state, { receiptId });
  if ("error" in dispatched) throw new Error(dispatched.error);
  const settled = settleFlowAction(dispatched.state, {
    receiptId,
    status: "succeeded",
    result,
  });
  if ("error" in settled) throw new Error(settled.error);
  return settled.state;
}

function complete(
  flow: AgentFlow,
  state: FlowExecutionState
): ReturnType<typeof completeFlowStep> & { state: FlowExecutionState; nextSteps: string[] } {
  const result = completeFlowStep(flow, state, { outputs: {} });
  if ("error" in result) throw new Error(result.error);
  return result;
}

function metric(flow: AgentFlow) {
  const refs = listStepRefs(flow);
  const maxActiveTools = Math.max(...refs.map((ref) => {
    const node = flow.nodes.find((candidate) => candidate.id === ref.nodeId);
    return new Set([
      ...alwaysTools(flow),
      ...(node?.tools ?? []),
      ...ref.ancestors.flatMap((ancestor) => ancestor.tools ?? []),
      ...(ref.step.tools ?? []),
    ]).size;
  }));
  return {
    steps: refs.length,
    maxDepth: Math.max(...refs.map((ref) => ref.path.split(".").length - 1)),
    checkpoints: refs.filter((ref) => ref.step.checkpoint).length,
    maxActiveTools,
  };
}

describe("deep open-source Flow v2 examples", () => {
  it("passes the production semantic validator and reconciliation schema for every file", () => {
    const flows = Object.values(EXAMPLES).map(loadExample);
    expect(flows.map(metric)).toEqual([
      { steps: 15, maxDepth: 4, checkpoints: 6, maxActiveTools: 7 },
      { steps: 14, maxDepth: 4, checkpoints: 4, maxActiveTools: 7 },
      { steps: 13, maxDepth: 4, checkpoints: 4, maxActiveTools: 7 },
    ]);

    for (const flow of flows) {
      for (const ref of listStepRefs(flow)) {
        // Direct children unlock after completion regardless of transition conditions. Keep
        // every consent/eligibility branch leaf-only so a false branch cannot expose a mutation.
        if (ref.step.transitions?.some((transition) => transition.condition)) {
          expect(ref.step.steps ?? []).toEqual([]);
        }
        for (const policy of ref.step.action_policies ?? []) {
          if (policy.reconciliation) {
            expect(() => ActionReconciliationSpecSchema.parse(policy.reconciliation)).not.toThrow();
          }
        }
        for (const binding of ref.step.output_bindings ?? []) {
          expect(binding.output).not.toMatch(/delivered/i);
        }
      }
    }
  });

  it("walks a long appointment path, safely repeats slot selection, and reconciles ambiguity", () => {
    const flow = loadExample(EXAMPLES.appointment);
    let state = selectFlowTopic(flow, createFlowExecutionState(), "appointment");
    expectState(state);
    expect(grantedTools(flow, state)).toEqual(["contact_support", "request_recall", "end_call"]);

    let step = enter(flow, state, "appointment.route");
    expect(step.availableTools).toEqual([
      "contact_support",
      "request_recall",
      "end_call",
      "lookup_service_customer",
    ]);
    state = succeedAction(
      flow,
      step.state,
      "appointment-customer",
      "lookup_service_customer",
      { account_reference: "A-100", verification_factor: "fixture" },
      { customer_id: "customer_100" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "appointment.route.intent");
    expect(step.availableTools).toEqual([
      "contact_support",
      "request_recall",
      "end_call",
      "lookup_service_customer",
      "classify_appointment_intent",
    ]);
    state = succeedAction(
      flow,
      step.state,
      "appointment-intent",
      "classify_appointment_intent",
      { utterance: "I need a new visit" },
      { intent: "book" }
    );
    const routed = complete(flow, state);
    expect(routed.nextSteps).toEqual(["appointment.schedule"]);
    state = routed.state;

    step = enter(flow, state, "appointment.schedule");
    state = succeedAction(
      flow,
      step.state,
      "appointment-preferences",
      "capture_service_preferences",
      { customer_id: "customer_100", category: "appliance", window: "afternoon" },
      { preference_set_id: "preferences_100" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "appointment.schedule.search");
    state = succeedAction(
      flow,
      step.state,
      "appointment-search",
      "search_service_slots",
      { preference_set_id: "preferences_100" },
      { search_id: "search_100", slots: [{ slot_token: "slot_100" }] }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "appointment.schedule.search.select");
    state = succeedAction(
      flow,
      step.state,
      "appointment-slot",
      "select_service_slot",
      { search_id: "search_100", slot_token: "slot_100" },
      { slot_token: "slot_100" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "appointment.schedule.search.select.review");
    state = succeedAction(
      flow,
      step.state,
      "appointment-review-first",
      "capture_slot_review",
      { slot_token: "slot_100", response: "search again" },
      { accepted: false }
    );
    const searchAgain = complete(flow, state);
    expect(searchAgain.nextSteps).toEqual(["appointment.schedule"]);
    const secondSchedule = enter(flow, searchAgain.state, "appointment.schedule");
    expect(secondSchedule.state.attempts["appointment.schedule"]).toBe(1);
    expect(secondSchedule.state.completedSteps).toEqual([
      "appointment.route",
      "appointment.route.intent",
    ]);
    expect(secondSchedule.state.checkpoints.map((checkpoint) => checkpoint.step)).toEqual([
      "appointment.route",
    ]);

    state = succeedAction(
      flow,
      secondSchedule.state,
      "appointment-preferences-second",
      "capture_service_preferences",
      { customer_id: "customer_100", category: "appliance", window: "morning" },
      { preference_set_id: "preferences_200" }
    );
    state = complete(flow, state).state;
    step = enter(flow, state, "appointment.schedule.search");
    state = succeedAction(
      flow,
      step.state,
      "appointment-search-second",
      "search_service_slots",
      { preference_set_id: "preferences_200" },
      { search_id: "search_200", slots: [{ slot_token: "slot_200" }] }
    );
    state = complete(flow, state).state;
    step = enter(flow, state, "appointment.schedule.search.select");
    state = succeedAction(
      flow,
      step.state,
      "appointment-slot-second",
      "select_service_slot",
      { search_id: "search_200", slot_token: "slot_200" },
      { slot_token: "slot_200" }
    );
    state = complete(flow, state).state;
    step = enter(flow, state, "appointment.schedule.search.select.review");
    state = succeedAction(
      flow,
      step.state,
      "appointment-review-second",
      "capture_slot_review",
      { slot_token: "slot_200", response: "keep it" },
      { accepted: true }
    );
    const reviewed = complete(flow, state);
    expect(reviewed.nextSteps).toEqual(["appointment.consent"]);
    state = reviewed.state;

    step = enter(flow, state, "appointment.consent");
    state = succeedAction(
      flow,
      step.state,
      "appointment-consent",
      "capture_booking_consent",
      { slot_token: "slot_200", response: "yes" },
      { granted: true }
    );
    const consented = complete(flow, state);
    expect(consented.nextSteps).toEqual([
      "appointment.commit",
    ]);
    state = consented.state;

    step = enter(flow, state, "appointment.commit");
    expect(step.availableTools).toEqual([
      "contact_support",
      "request_recall",
      "end_call",
      "commit_service_appointment_operation",
    ]);
    const receiptId = "appointment-commit";
    const reserved = reserveFlowAction(flow, step.state, {
      receiptId,
      invocationId: deriveFlowActionInvocationId("deep-example:appointment-commit"),
      tool: "commit_service_appointment_operation",
      arguments: {
        customer_id: "customer_100",
        slot_token: "slot_200",
        consent_evidence: "fixture",
      },
      capabilityEpoch: step.state.capabilityEpoch,
    });
    if ("error" in reserved) throw new Error(reserved.error);
    const dispatched = markFlowActionDispatchStarted(reserved.state, { receiptId });
    if ("error" in dispatched) throw new Error(dispatched.error);
    const ambiguous = settleFlowAction(dispatched.state, {
      receiptId,
      status: "indeterminate",
      error: "connection ended after dispatch",
    });
    if ("error" in ambiguous) throw new Error(ambiguous.error);
    expect(completeFlowStep(flow, ambiguous.state, { outputs: {} })).toMatchObject({
      code: "pending_action_evidence",
    });
    expect(enterFlowStep(
      flow,
      ambiguous.state,
      "appointment.commit"
    )).toMatchObject({ code: "pending_action_evidence" });

    const reconciled = promoteIndeterminateFlowAction(ambiguous.state, {
      receiptId,
      proofId: "proof-appointment-commit",
      result: {
        appointment_id: "appointment_100",
        scheduled_at: "2026-08-04T21:00:00Z",
      },
    });
    if ("error" in reconciled) throw new Error(reconciled.error);
    const committed = complete(flow, reconciled.state);
    expect(committed.state.outputs[
      "appointment.commit"
    ]).toEqual({
      appointment_id: "appointment_100",
      scheduled_at: "2026-08-04T21:00:00Z",
    });
    state = committed.state;

    step = enter(
      flow,
      state,
      "appointment.commit.followup"
    );
    expect(step.availableTools).toHaveLength(5);
    state = succeedAction(
      flow,
      step.state,
      "appointment-notification",
      "submit_appointment_notification",
      { appointment_id: "appointment_100", channel: "email" },
      { accepted: true }
    );
    const finished = complete(flow, state);
    expect(finished.nextSteps).toEqual([]);
    expect(finished.state.status).toBe("completed");
    expect(finished.state.stepEntries).toBe(13);
    expect(finished.state.checkpoints.map((checkpoint) => checkpoint.step)).toEqual([
      "appointment.route",
      "appointment.schedule",
      "appointment.commit",
    ]);
  });

  it("walks warranty intake and routes exhausted incident retries to a safe handoff", () => {
    const flow = loadExample(EXAMPLES.warranty);
    let state = selectFlowTopic(flow, createFlowExecutionState(), "product_help");
    expectState(state);

    let step = enter(flow, state, "product_help.route");
    state = succeedAction(
      flow,
      step.state,
      "warranty-route",
      "classify_product_request",
      { request: "warranty review" },
      { request_kind: "warranty" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "product_help.warranty");
    state = succeedAction(
      flow,
      step.state,
      "warranty-purchase",
      "lookup_product_purchase",
      { purchase_reference: "P-100" },
      { product_id: "product_100", purchase_id: "purchase_100" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "product_help.warranty.eligibility");
    state = succeedAction(
      flow,
      step.state,
      "warranty-eligibility",
      "evaluate_warranty_policy",
      { purchase_id: "purchase_100", product_id: "product_100" },
      { eligible: true, reason: "within configured term" }
    );
    const eligible = complete(flow, state);
    expect(eligible.nextSteps).toEqual(["product_help.evidence"]);
    state = eligible.state;

    step = enter(flow, state, "product_help.evidence");
    state = succeedAction(
      flow,
      step.state,
      "warranty-description",
      "capture_issue_description",
      { description: "reported fixture issue" },
      { issue_record_id: "issue_100" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "product_help.evidence.attachments");
    state = succeedAction(
      flow,
      step.state,
      "warranty-attachment",
      "submit_warranty_evidence",
      { issue_record_id: "issue_100", attachment_refs: ["fixture://photo"] },
      { accepted: true }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "product_help.evidence.attachments.preference");
    state = succeedAction(
      flow,
      step.state,
      "warranty-preference",
      "capture_resolution_preference",
      { response: "repair review" },
      { preference: "repair_review" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "product_help.evidence.attachments.preference.consent");
    state = succeedAction(
      flow,
      step.state,
      "warranty-consent",
      "capture_case_consent",
      { response: "yes", retention_notice_version: "fixture-v1" },
      { granted: true }
    );
    state = complete(flow, state).state;

    step = enter(
      flow,
      state,
      "product_help.submit"
    );
    expect(step.availableTools).toHaveLength(4);
    state = succeedAction(
      flow,
      step.state,
      "warranty-submit",
      "submit_warranty_case",
      {
        purchase_id: "purchase_100",
        issue_record_id: "issue_100",
        preference: "repair_review",
      },
      { case_id: "case_100", status: "accepted_for_review" }
    );
    const submitted = complete(flow, state);
    expect(submitted.state.status).toBe("completed");
    expect(submitted.state.stepEntries).toBe(8);
    expect(submitted.state.outputs[
      "product_help.submit"
    ]).toEqual({
      case_id: "case_100",
      case_status: "accepted_for_review",
    });

    let incidentState = selectFlowTopic(flow, createFlowExecutionState(), "product_help");
    expectState(incidentState);
    step = enter(flow, incidentState, "product_help.route");
    incidentState = succeedAction(
      flow,
      step.state,
      "incident-route",
      "classify_product_request",
      { request: "report an incident" },
      { request_kind: "incident" }
    );
    incidentState = complete(flow, incidentState).state;
    const first = enter(flow, incidentState, "product_help.incident");
    const second = enter(flow, first.state, "product_help.incident");
    const third = enter(flow, second.state, "product_help.incident");
    expect(third.state.attempts["product_help.incident"]).toBe(3);
    expect(enterFlowStep(flow, third.state, "product_help.urgent_handoff")).not.toHaveProperty("error");
  });

  it("walks a membership goal followed by one independently authorized return item", () => {
    const flow = loadExample(EXAMPLES.membershipReturn);
    let state = selectFlowTopic(flow, createFlowExecutionState(), "membership_return");
    expectState(state);

    let step = enter(flow, state, "membership_return.route");
    state = succeedAction(
      flow,
      step.state,
      "multigoal-route",
      "verify_member_and_classify_goals",
      { member_reference: "M-100", request: "membership and return" },
      { member_id: "member_100", goals: ["membership", "return"] }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "membership_return.membership");
    state = succeedAction(
      flow,
      step.state,
      "membership-read",
      "read_membership_summary",
      { member_id: "member_100" },
      { status: "active", goal_complete: true }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "membership_return.membership.next_goal");
    state = succeedAction(
      flow,
      step.state,
      "membership-next-goal",
      "select_remaining_goal",
      { verified_goals: ["membership", "return"], completed: ["membership"] },
      { next_goal: "return" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "membership_return.return_items");
    state = succeedAction(
      flow,
      step.state,
      "return-order",
      "locate_return_order",
      { member_id: "member_100", order_reference: "O-100" },
      { order_id: "order_100" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "membership_return.return_items.select_item");
    state = succeedAction(
      flow,
      step.state,
      "return-item",
      "select_return_item",
      { order_id: "order_100", selection: "first item" },
      { line_item_id: "line_100" }
    );
    state = complete(flow, state).state;

    step = enter(flow, state, "membership_return.return_items.select_item.item_details");
    state = succeedAction(
      flow,
      step.state,
      "return-item-details",
      "capture_return_item_details",
      { line_item_id: "line_100", condition: "unopened", reason: "not needed" },
      { item_details_id: "details_100" }
    );
    state = complete(flow, state).state;

    step = enter(
      flow,
      state,
      "membership_return.return_items.select_item.item_details.eligibility"
    );
    state = succeedAction(
      flow,
      step.state,
      "return-eligibility",
      "evaluate_return_item",
      { order_id: "order_100", line_item_id: "line_100" },
      { eligible: true, reason: "within configured window" }
    );
    state = complete(flow, state).state;

    step = enter(
      flow,
      state,
      "membership_return.return_consent"
    );
    state = succeedAction(
      flow,
      step.state,
      "return-consent",
      "capture_return_consent",
      { line_item_id: "line_100", response: "yes" },
      { granted: true }
    );
    state = complete(flow, state).state;

    step = enter(
      flow,
      state,
      "membership_return.create_return"
    );
    state = succeedAction(
      flow,
      step.state,
      "return-create",
      "create_return_item",
      { line_item_id: "line_100", return_method: "mail" },
      { return_id: "return_100" }
    );
    state = complete(flow, state).state;

    step = enter(
      flow,
      state,
      "membership_return.create_return.notify"
    );
    expect(step.availableTools).toHaveLength(5);
    state = succeedAction(
      flow,
      step.state,
      "return-notification",
      "submit_return_label_notification",
      { return_id: "return_100", channel: "email" },
      { accepted: true }
    );
    const finished = complete(flow, state);
    expect(finished.nextSteps).toEqual([]);
    expect(finished.state.status).toBe("completed");
    expect(finished.state.stepEntries).toBe(10);
    expect(finished.state.checkpoints.map((checkpoint) => checkpoint.step)).toEqual([
      "membership_return.route",
      "membership_return.membership",
      "membership_return.return_items",
      "membership_return.create_return",
    ]);
  });
});
