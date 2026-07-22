import { z } from "zod";
import { findStep, type AgentFlow } from "../flow";
import type { FlowExecutionState } from "../flow-runtime";
import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import type { AdmissibilityFrontierEvidence } from "./admissibility-frontier";
import type { AmbiguityQuarantine } from "./ambiguity-quarantine";
import type { ProviderCapabilitySnapshot } from "./capability-gateway";
import type { HaccSpeechGuardrailPacket } from "./speech-guardrail-packet";

export const HACC_RESPONSE_PLAN_KEY = "hacc_response_plan" as const;
export const HACC_RESPONSE_PLAN_VERSION = "hacc-state-derived-response-plan.v1" as const;

const POLICY_DOMAIN = "harshas-amazing-call-center/benchmark-response-plan-policy/v1\n";
const STATE_DOMAIN = "harshas-amazing-call-center/benchmark-response-plan-state/v1\n";
const PLAN_DOMAIN = "harshas-amazing-call-center/benchmark-response-plan-packet/v1\n";

const RESPONSE_PLAN_POLICY = Object.freeze({
  version: HACC_RESPONSE_PLAN_VERSION,
  derivation: "host_public_flow_frontier_and_receipt_presence_only",
  value_exposure: "slot_and_action_names_only_no_values",
  authority: "capability_snapshot_is_enforcing_boundary",
  provider_context_authority: "advisory_only_gateway_and_speech_gate_remain_enforcing",
  freshness: "caller_turn_revision_epoch_and_hash_bound",
});

export const HACC_RESPONSE_PLAN_POLICY_SHA256 = sha256Hex(
  `${POLICY_DOMAIN}${canonicalJson(RESPONSE_PLAN_POLICY)}`
);

const ResponseModeSchema = z.enum(["route", "act", "reconcile", "terminal", "recover"]);
const RecoveryStateSchema = z.enum(["none", "refresh_required", "ambiguity_quarantine"]);
const ProhibitedClaimSchema = z.enum([
  "repeat_verification_secrets",
  "terminal_success_without_authoritative_receipt",
  "terminal_success_while_reconciliation_pending",
  "retry_ambiguous_commit",
]);

export const HaccResponsePlanSchema = z.object({
  schema_version: z.literal(1),
  plan_type: z.literal(HACC_RESPONSE_PLAN_VERSION),
  revision: z.number().int().positive(),
  condition_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  policy_sha256: z.literal(HACC_RESPONSE_PLAN_POLICY_SHA256),
  state_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  previous_plan_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  frontier_evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capability_catalog_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capability_epoch: z.number().int().nonnegative(),
  target: z.string().min(1),
  current_step: z.string().min(1).nullable(),
  response_mode: ResponseModeSchema,
  context_authority: z.literal("advisory_only_gateway_and_speech_gate_enforced"),
  eligible_actions: z.array(z.string().min(1)),
  present_public_slots: z.array(z.string().min(1)),
  missing_public_slots: z.array(z.string().min(1)),
  recovery_state: RecoveryStateSchema,
  designated_reconciliation_actions: z.array(z.string().min(1)),
  prohibited_claims: z.array(ProhibitedClaimSchema),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type HaccResponsePlan = z.infer<typeof HaccResponsePlanSchema>;

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function publicCapabilityCatalog(snapshot: ProviderCapabilitySnapshot): Readonly<{
  scope: string;
  capability_epoch: number;
  actions: readonly Readonly<{ name: string; semantic_hash: string }>[];
}> {
  return Object.freeze({
    scope: snapshot.scope,
    capability_epoch: snapshot.capability_epoch,
    actions: Object.freeze(snapshot.actions
      .map((action) => Object.freeze({ name: action.name, semantic_hash: action.semantic_hash }))
      .sort((left, right) => left.name.localeCompare(right.name))),
  });
}

function valueAtPath(value: unknown, path: string): unknown {
  const segments = path === "$" ? [] : path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") return undefined;
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function slotPresence(
  flow: AgentFlow,
  state: FlowExecutionState,
  currentStep: string | null,
): { present: string[]; missing: string[] } {
  if (!currentStep) return { present: [], missing: [] };
  const step = findStep(flow, currentStep)?.step;
  if (!step) throw new Error("response plan current step is absent from the configured Flow");
  const required = sortedUnique(step.required_outputs ?? []);
  const present = new Set<string>();
  const completed = state.outputs[currentStep] ?? {};
  for (const slot of required) {
    if (completed[slot] !== undefined && completed[slot] !== null) present.add(slot);
  }
  for (const binding of step.output_bindings ?? []) {
    if (!required.includes(binding.output)) continue;
    const receipt = state.actionReceipts.find((candidate) =>
      candidate.step === currentStep
      && candidate.tool === binding.tool
      && candidate.status === "succeeded"
      && candidate.result !== undefined
    );
    const value = receipt ? valueAtPath(receipt.result, binding.result_path) : undefined;
    if (value !== undefined && value !== null) present.add(binding.output);
  }
  return {
    present: sortedUnique([...present]),
    missing: required.filter((slot) => !present.has(slot)),
  };
}

function stateBody(plan: Omit<HaccResponsePlan, "state_sha256" | "plan_sha256">): unknown {
  return {
    revision: plan.revision,
    condition_sha256: plan.condition_sha256,
    frontier_evidence_sha256: plan.frontier_evidence_sha256,
    capability_catalog_sha256: plan.capability_catalog_sha256,
    capability_epoch: plan.capability_epoch,
    target: plan.target,
    current_step: plan.current_step,
    response_mode: plan.response_mode,
    context_authority: plan.context_authority,
    eligible_actions: plan.eligible_actions,
    present_public_slots: plan.present_public_slots,
    missing_public_slots: plan.missing_public_slots,
    recovery_state: plan.recovery_state,
    designated_reconciliation_actions: plan.designated_reconciliation_actions,
    prohibited_claims: plan.prohibited_claims,
  };
}

export function createHaccResponsePlan(input: Readonly<{
  flow: AgentFlow;
  state: FlowExecutionState;
  conditionSha256: string;
  target: string;
  catalogMode: "target" | "post_step_transition" | "terminal" | "refresh_required";
  snapshot: ProviderCapabilitySnapshot;
  frontierEvidence: AdmissibilityFrontierEvidence;
  quarantines: readonly AmbiguityQuarantine[];
  speechGuardrailPacket: HaccSpeechGuardrailPacket;
  revision: number;
  previousPlanSha256: string | null;
}>): HaccResponsePlan {
  const currentStep = input.state.currentStep !== null
    && !input.state.completedSteps.includes(input.state.currentStep)
    ? input.state.currentStep
    : null;
  const activeQuarantines = input.quarantines.filter((item) => item.status === "reconciliation_required");
  const designated = sortedUnique(activeQuarantines.flatMap((item) => item.designatedReconciliationActions));
  const recoveryState = activeQuarantines.length > 0
    ? "ambiguity_quarantine" as const
    : input.catalogMode === "refresh_required"
      ? "refresh_required" as const
      : "none" as const;
  const responseMode = recoveryState === "ambiguity_quarantine"
    ? "reconcile" as const
    : recoveryState === "refresh_required"
      ? "recover" as const
      : input.state.status === "completed" || input.state.status === "failed" || input.catalogMode === "terminal"
        ? "terminal" as const
        : currentStep
          ? "act" as const
          : "route" as const;
  const prohibited = new Set<z.infer<typeof ProhibitedClaimSchema>>();
  if (input.speechGuardrailPacket.privacy_directive === "never_repeat_verification_secrets") {
    prohibited.add("repeat_verification_secrets");
  }
  if (input.speechGuardrailPacket.terminal_directive === "do_not_claim_terminal_success_without_authoritative_receipt") {
    prohibited.add("terminal_success_without_authoritative_receipt");
  } else if (input.speechGuardrailPacket.terminal_directive === "ambiguity_quarantine_reconcile_before_terminal_claim") {
    prohibited.add("terminal_success_while_reconciliation_pending");
    prohibited.add("retry_ambiguous_commit");
  }
  const slots = slotPresence(input.flow, input.state, currentStep);
  const bodyWithoutHashes = {
    schema_version: 1 as const,
    plan_type: HACC_RESPONSE_PLAN_VERSION,
    revision: input.revision,
    condition_sha256: input.conditionSha256,
    policy_sha256: HACC_RESPONSE_PLAN_POLICY_SHA256,
    previous_plan_sha256: input.previousPlanSha256,
    frontier_evidence_sha256: input.frontierEvidence.evidence_sha256,
    capability_catalog_sha256: domainHash(STATE_DOMAIN, publicCapabilityCatalog(input.snapshot)),
    capability_epoch: input.snapshot.capability_epoch,
    target: input.target,
    current_step: currentStep,
    response_mode: responseMode,
    context_authority: "advisory_only_gateway_and_speech_gate_enforced" as const,
    eligible_actions: sortedUnique(input.snapshot.actions.map((action) => action.name)),
    present_public_slots: slots.present,
    missing_public_slots: slots.missing,
    recovery_state: recoveryState,
    designated_reconciliation_actions: designated,
    prohibited_claims: sortedUnique([...prohibited]) as z.infer<typeof ProhibitedClaimSchema>[],
  };
  const withState = {
    ...bodyWithoutHashes,
    state_sha256: domainHash(STATE_DOMAIN, stateBody(bodyWithoutHashes)),
  };
  return immutableJson({
    ...withState,
    plan_sha256: domainHash(PLAN_DOMAIN, withState),
  }) as unknown as HaccResponsePlan;
}

export function assertHaccResponsePlan(
  input: unknown,
  expected?: Readonly<{
    revision?: number;
    capabilityEpoch?: number;
    target?: string;
    eligibleActions?: readonly string[];
    frontierEvidenceSha256?: string;
    previousPlanSha256?: string | null;
  }>,
): HaccResponsePlan {
  const plan = HaccResponsePlanSchema.parse(input);
  for (const [label, values] of [
    ["eligible actions", plan.eligible_actions],
    ["present public slots", plan.present_public_slots],
    ["missing public slots", plan.missing_public_slots],
    ["designated reconciliation actions", plan.designated_reconciliation_actions],
    ["prohibited claims", plan.prohibited_claims],
  ] as const) {
    if (canonicalJson(values) !== canonicalJson(sortedUnique(values))) {
      throw new Error(`response plan ${label} are not sorted and unique`);
    }
  }
  if (plan.present_public_slots.some((slot) => plan.missing_public_slots.includes(slot))) {
    throw new Error("response plan public slot sets overlap");
  }
  const withoutHashes = {
    schema_version: plan.schema_version,
    plan_type: plan.plan_type,
    revision: plan.revision,
    condition_sha256: plan.condition_sha256,
    policy_sha256: plan.policy_sha256,
    previous_plan_sha256: plan.previous_plan_sha256,
    frontier_evidence_sha256: plan.frontier_evidence_sha256,
    capability_catalog_sha256: plan.capability_catalog_sha256,
    capability_epoch: plan.capability_epoch,
    target: plan.target,
    current_step: plan.current_step,
    response_mode: plan.response_mode,
    context_authority: plan.context_authority,
    eligible_actions: plan.eligible_actions,
    present_public_slots: plan.present_public_slots,
    missing_public_slots: plan.missing_public_slots,
    recovery_state: plan.recovery_state,
    designated_reconciliation_actions: plan.designated_reconciliation_actions,
    prohibited_claims: plan.prohibited_claims,
  };
  const expectedStateHash = domainHash(STATE_DOMAIN, stateBody(withoutHashes));
  if (plan.state_sha256 !== expectedStateHash) throw new Error("response plan state hash mismatch");
  const planBody = { ...withoutHashes, state_sha256: plan.state_sha256 };
  if (plan.plan_sha256 !== domainHash(PLAN_DOMAIN, planBody)) {
    throw new Error("response plan packet hash mismatch");
  }
  if (expected?.revision !== undefined && plan.revision !== expected.revision) {
    throw new Error("response plan revision is stale");
  }
  if (expected?.capabilityEpoch !== undefined && plan.capability_epoch !== expected.capabilityEpoch) {
    throw new Error("response plan capability epoch is stale");
  }
  if (expected?.target !== undefined && plan.target !== expected.target) {
    throw new Error("response plan target is stale");
  }
  if (expected?.frontierEvidenceSha256 !== undefined
      && plan.frontier_evidence_sha256 !== expected.frontierEvidenceSha256) {
    throw new Error("response plan frontier evidence is stale");
  }
  if (expected?.previousPlanSha256 !== undefined
      && plan.previous_plan_sha256 !== expected.previousPlanSha256) {
    throw new Error("response plan chain is stale");
  }
  if (expected?.eligibleActions !== undefined
      && canonicalJson(plan.eligible_actions) !== canonicalJson(sortedUnique(expected.eligibleActions))) {
    throw new Error("response plan eligible actions are stale");
  }
  return plan;
}

export function renderHaccResponsePlan(plan: HaccResponsePlan): string {
  return `<hacc_response_plan>\n${canonicalJson(plan)}\n</hacc_response_plan>`;
}
