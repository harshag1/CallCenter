/**
 * Outcome-blind statistical contracts for HACC-Proof-v1.
 *
 * `value` means success for efficacy endpoints and breach/event occurrence for
 * safety endpoints. A non-observed disposition must have `value: null`.
 */
export type ObservationStatus =
  | "observed"
  | "missing"
  | "invalid"
  | "transport_failure"
  | "runner_failure";

export type BinaryArmObservation = Readonly<{
  status: ObservationStatus;
  value: boolean | null;
}>;

export type ScheduledPairedBinaryObservation = Readonly<{
  pair_id: string;
  provider: string;
  /** Generalization unit, normally the scenario-template ID. */
  cluster_id: string;
  native: BinaryArmObservation;
  hacc: BinaryArmObservation;
}>;

export type IttPairedBinaryObservation = Readonly<{
  pair_id: string;
  provider: string;
  cluster_id: string;
  native_value: boolean;
  hacc_value: boolean;
  native_status: ObservationStatus;
  hacc_status: ObservationStatus;
  native_missing: boolean;
  hacc_missing: boolean;
}>;

export type ProviderPairedRiskDifference = Readonly<{
  provider: string;
  pairs: number;
  native_rate: number;
  hacc_rate: number;
  paired_risk_difference: number;
  hacc_only: number;
  native_only: number;
  ties: number;
  missing_native: number;
  missing_hacc: number;
}>;

export type EqualProviderWeightedPairedRiskDifference = Readonly<{
  method: "equal_provider_weighted_paired_risk_difference";
  estimate: number;
  providers: readonly string[];
  provider_weight: number;
  total_pairs: number;
  provider_rows: readonly ProviderPairedRiskDifference[];
  itt: Readonly<{
    rule: "non_observed_arm_is_failure";
    missing_native: number;
    missing_hacc: number;
  }>;
}>;

export type ConfidenceInterval = Readonly<{
  confidence_level: number;
  lower: number;
  upper: number;
}>;

export type ProviderStratifiedRandomizationResult = Readonly<{
  method: "exact_provider_stratified_paired_sign_flip";
  alternative: "two_sided" | "hacc_greater" | "hacc_less";
  statistic: "equal_provider_weighted_paired_risk_difference";
  estimate: number;
  exact_p_value: number;
  observed_scaled_integer: string;
  extreme_assignments: string;
  assignment_support_size: string;
  discordant_pairs: number;
  providers: readonly string[];
}>;

export type ProviderClusterBootstrapResult = Readonly<{
  method: "paired_cluster_bootstrap_equal_provider_weighted";
  estimate: number;
  interval: ConfidenceInterval;
  clusters: number;
  providers: readonly string[];
  providers_per_cluster: number;
  iterations: number;
  seed: string | number;
}>;

export type SafetyNonInferiorityResult = Readonly<{
  method: "paired_harm_only_clopper_pearson_union_bound";
  evidence_complete: boolean;
  observed_equal_provider_weighted_breach_difference: number | null;
  one_sided_confidence_level: number;
  margin: number;
  conservative_upper_bound: number | null;
  noninferior: boolean;
  providers: readonly Readonly<{
    provider: string;
    pairs: number;
    native_breaches: number;
    hacc_breaches: number;
    hacc_only_breaches: number;
    observed_breach_difference: number;
    simultaneous_harm_only_upper_bound: number;
  }>[];
  missing_evidence: readonly Readonly<{
    pair_id: string;
    arm: "native" | "hacc";
    status: Exclude<ObservationStatus, "observed">;
  }>[];
}>;

export type HolmHypothesis = Readonly<{
  id: string;
  p_value: number;
}>;

export type HolmResult = Readonly<{
  method: "holm_bonferroni";
  family_alpha: number;
  hypotheses: readonly Readonly<{
    id: string;
    p_value: number;
    rank: number;
    adjusted_p_value: number;
    rejected: boolean;
  }>[];
}>;
