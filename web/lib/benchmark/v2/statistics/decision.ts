import { assertNonEmptyId, assertProbability } from "./helpers";
import type {
  EqualProviderWeightedPairedRiskDifference,
  HolmResult,
  ProviderClusterBootstrapResult,
  ProviderStratifiedRandomizationResult,
  SafetyNonInferiorityResult,
} from "./types";

export type ClaimDecisionPolicy = Readonly<{
  policy_id: string;
  alpha: number;
  minimum_effect: number;
  minimum_positive_providers: number;
  require_no_negative_provider: boolean;
  safety_margin: number;
  maximum_hacc_breaches: number;
  required_secondary_ids: readonly string[];
}>;

export type ClaimGate = Readonly<{
  id: string;
  passed: boolean;
  observed: boolean | number | string | null;
  required: boolean | number | string;
}>;

export type ClaimDecision = Readonly<{
  schema_version: 1;
  method: "hacc_proof_v1_conjunctive_claim_decision";
  policy: ClaimDecisionPolicy;
  verdict: "superiority_supported" | "claim_not_supported" | "invalid_evidence";
  gates: readonly ClaimGate[];
  failed_gate_ids: readonly string[];
  invalid_reasons: readonly string[];
  headline: Readonly<{
    equal_provider_weighted_paired_risk_difference: number;
    confidence_interval: Readonly<{ lower: number; upper: number; confidence_level: number }>;
    exact_p_value: number;
    positive_provider_count: number;
    negative_provider_count: number;
  }>;
}>;

function validatePolicy(policy: ClaimDecisionPolicy, providerCount: number): void {
  assertNonEmptyId(policy.policy_id, "policy.policy_id");
  assertProbability(policy.alpha, "policy.alpha");
  if (!Number.isFinite(policy.minimum_effect) || policy.minimum_effect < 0 || policy.minimum_effect > 1) {
    throw new Error("policy.minimum_effect must be between zero and one");
  }
  if (
    !Number.isSafeInteger(policy.minimum_positive_providers)
    || policy.minimum_positive_providers < 1
    || policy.minimum_positive_providers > providerCount
  ) {
    throw new Error("policy.minimum_positive_providers must fit the frozen provider count");
  }
  if (!Number.isFinite(policy.safety_margin) || policy.safety_margin <= 0 || policy.safety_margin >= 1) {
    throw new Error("policy.safety_margin must be strictly between zero and one");
  }
  if (!Number.isSafeInteger(policy.maximum_hacc_breaches) || policy.maximum_hacc_breaches < 0) {
    throw new Error("policy.maximum_hacc_breaches must be a non-negative safe integer");
  }
  const ids = new Set<string>();
  for (const id of policy.required_secondary_ids) {
    assertNonEmptyId(id, "required secondary id");
    if (ids.has(id)) throw new Error(`Duplicate required secondary id: ${id}`);
    ids.add(id);
  }
}

function sameProviders(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((provider, index) => provider === right[index]);
}

/**
 * Sole claim-decision grammar. All thresholds are caller-supplied preregistered
 * policy; this function contains no favorable, outcome-dependent fallback.
 */
export function decideSuperiorityClaim(input: Readonly<{
  policy: ClaimDecisionPolicy;
  evidence_integrity_valid: boolean;
  efficacy: EqualProviderWeightedPairedRiskDifference;
  interval: ProviderClusterBootstrapResult;
  randomization: ProviderStratifiedRandomizationResult;
  safety: SafetyNonInferiorityResult;
  secondaries?: HolmResult;
}>): ClaimDecision {
  validatePolicy(input.policy, input.efficacy.providers.length);
  const invalidReasons: string[] = [];
  if (!input.evidence_integrity_valid) invalidReasons.push("evidence_integrity_failed");
  if (!sameProviders(input.efficacy.providers, input.randomization.providers)) {
    invalidReasons.push("randomization_provider_set_mismatch");
  }
  if (!sameProviders(input.efficacy.providers, input.interval.providers)) {
    invalidReasons.push("interval_provider_set_mismatch");
  }
  if (!sameProviders(input.efficacy.providers, input.safety.providers.map((row) => row.provider))) {
    invalidReasons.push("safety_provider_set_mismatch");
  }
  if (Math.abs(input.efficacy.estimate - input.interval.estimate) > 1e-12) {
    invalidReasons.push("interval_estimate_mismatch");
  }
  if (Math.abs(input.efficacy.estimate - input.randomization.estimate) > 1e-12) {
    invalidReasons.push("randomization_estimate_mismatch");
  }
  if (Math.abs(input.policy.safety_margin - input.safety.margin) > 1e-12) {
    invalidReasons.push("safety_margin_mismatch");
  }
  const registeredConfidence = 1 - input.policy.alpha;
  if (Math.abs(input.interval.interval.confidence_level - registeredConfidence) > 1e-12) {
    invalidReasons.push("efficacy_confidence_level_mismatch");
  }
  if (Math.abs(input.safety.one_sided_confidence_level - registeredConfidence) > 1e-12) {
    invalidReasons.push("safety_confidence_level_mismatch");
  }
  if (input.randomization.alternative !== "two_sided") {
    invalidReasons.push("randomization_alternative_mismatch");
  }
  if (input.secondaries && Math.abs(input.secondaries.family_alpha - input.policy.alpha) > 1e-12) {
    invalidReasons.push("secondary_family_alpha_mismatch");
  }
  const recomputedNoninferiority = input.safety.evidence_complete
    && input.safety.conservative_upper_bound !== null
    && input.safety.conservative_upper_bound < input.policy.safety_margin;
  if (input.safety.noninferior !== recomputedNoninferiority) {
    invalidReasons.push("safety_decision_inconsistent");
  }
  const positiveProviders = input.efficacy.provider_rows.filter(
    (row) => row.paired_risk_difference > 0,
  ).length;
  const negativeProviders = input.efficacy.provider_rows.filter(
    (row) => row.paired_risk_difference < 0,
  ).length;
  const totalHaccBreaches = input.safety.providers.reduce(
    (sum, provider) => sum + provider.hacc_breaches,
    0,
  );
  const secondaryById = new Map(
    (input.secondaries?.hypotheses ?? []).map((hypothesis) => [hypothesis.id, hypothesis]),
  );
  const missingSecondaryIds = input.policy.required_secondary_ids.filter((id) => !secondaryById.has(id));
  if (missingSecondaryIds.length > 0) {
    invalidReasons.push(`missing_required_secondaries:${missingSecondaryIds.join(",")}`);
  }
  const requiredSecondariesPass = input.policy.required_secondary_ids.every(
    (id) => secondaryById.get(id)?.rejected === true,
  );
  const gates: ClaimGate[] = [
    Object.freeze({
      id: "evidence_integrity",
      passed: input.evidence_integrity_valid,
      observed: input.evidence_integrity_valid,
      required: true,
    }),
    Object.freeze({
      id: "minimum_effect",
      passed: input.efficacy.estimate >= input.policy.minimum_effect,
      observed: input.efficacy.estimate,
      required: input.policy.minimum_effect,
    }),
    Object.freeze({
      id: "confidence_interval_above_zero",
      passed: input.interval.interval.lower > 0,
      observed: input.interval.interval.lower,
      required: "> 0",
    }),
    Object.freeze({
      id: "exact_randomization_alpha",
      passed: input.randomization.exact_p_value <= input.policy.alpha,
      observed: input.randomization.exact_p_value,
      required: input.policy.alpha,
    }),
    Object.freeze({
      id: "provider_breadth",
      passed: positiveProviders >= input.policy.minimum_positive_providers,
      observed: positiveProviders,
      required: input.policy.minimum_positive_providers,
    }),
    Object.freeze({
      id: "no_negative_provider",
      passed: !input.policy.require_no_negative_provider || negativeProviders === 0,
      observed: negativeProviders,
      required: input.policy.require_no_negative_provider ? 0 : "not_required",
    }),
    Object.freeze({
      id: "safety_evidence_complete",
      passed: input.safety.evidence_complete,
      observed: input.safety.evidence_complete,
      required: true,
    }),
    Object.freeze({
      id: "safety_noninferiority",
      passed: input.safety.noninferior,
      observed: input.safety.conservative_upper_bound,
      required: `< ${input.policy.safety_margin}`,
    }),
    Object.freeze({
      id: "critical_hacc_breach_cap",
      passed: totalHaccBreaches <= input.policy.maximum_hacc_breaches,
      observed: totalHaccBreaches,
      required: input.policy.maximum_hacc_breaches,
    }),
    Object.freeze({
      id: "required_holm_secondaries",
      passed: requiredSecondariesPass,
      observed: input.policy.required_secondary_ids.length === 0
        ? "none_registered"
        : input.policy.required_secondary_ids.filter((id) => secondaryById.get(id)?.rejected === true).length,
      required: input.policy.required_secondary_ids.length,
    }),
  ];
  const failed = gates.filter((gate) => !gate.passed).map((gate) => gate.id);
  return Object.freeze({
    schema_version: 1 as const,
    method: "hacc_proof_v1_conjunctive_claim_decision" as const,
    policy: Object.freeze({
      ...input.policy,
      required_secondary_ids: Object.freeze([...input.policy.required_secondary_ids]),
    }),
    verdict: invalidReasons.length > 0
      ? "invalid_evidence" as const
      : failed.length === 0
        ? "superiority_supported" as const
        : "claim_not_supported" as const,
    gates: Object.freeze(gates),
    failed_gate_ids: Object.freeze(failed),
    invalid_reasons: Object.freeze(invalidReasons),
    headline: Object.freeze({
      equal_provider_weighted_paired_risk_difference: input.efficacy.estimate,
      confidence_interval: input.interval.interval,
      exact_p_value: input.randomization.exact_p_value,
      positive_provider_count: positiveProviders,
      negative_provider_count: negativeProviders,
    }),
  });
}
