import type { EvidenceReplayResultV2 } from "../../../evidence-v2";
import type {
  ClaimDecision,
  ClaimDecisionPolicy,
  ConfirmatoryClaimArtifacts,
  EqualProviderWeightedPairedRiskDifference,
  ProviderClusterBootstrapResult,
  ProviderStratifiedRandomizationResult,
  SafetyNonInferiorityResult,
} from "../statistics";
import type { BlindSemanticTrustV2 } from "./blind-semantic-sidecar";
import type { ClaimEligibilityTrustV2 } from "./claim-eligibility-receipt";

export type BenchmarkPhaseV2 = "development" | "pilot" | "confirmatory";
export type BenchmarkArmV2 = "registered_native" | "full_hacc";

export type ReportArmInputV2 = Readonly<{
  episode_id: string;
  network_admission: "opened" | "unopened";
  replay: EvidenceReplayResultV2 | null;
  blind_semantic_sidecar: unknown | null;
}>;

export type ReportPairInputV2 = Readonly<{
  pair_id: string;
  cluster_id: string;
  provider: string;
  registered_native: ReportArmInputV2;
  full_hacc: ReportArmInputV2;
}>;

export type BenchmarkReportRegistrationV2 = Readonly<{
  report_id: string;
  protocol_id: string;
  phase: BenchmarkPhaseV2;
  generated_at: string;
  providers: readonly string[];
  expected_pair_count: number;
  semantic_opportunity_ids: readonly string[];
  semantic_trust: BlindSemanticTrustV2;
  claim_eligibility_receipt: unknown;
  claim_eligibility_trust: ClaimEligibilityTrustV2;
  confirmatory_claim_artifacts: ConfirmatoryClaimArtifacts;
  claim_policy: ClaimDecisionPolicy;
  maximum_median_safe_first_audio_regression_ms: number;
  bootstrap_iterations: number;
  bootstrap_seed: string | number;
}>;

export type EpisodeEndpointScoresV2 = Readonly<{
  useful_mission_success: boolean;
  task_completion: boolean;
  model_integrity: boolean;
  system_integrity: boolean;
  critical_effect_breach: boolean;
  critical_speech_breach: boolean;
  semantic_opportunities_total: number;
  semantic_opportunities_satisfied: number;
  semantic_unverifiable_count: number;
  semantic_violation_count: number;
  safe_first_audio_latency_ms: number | null;
}>;

export type EpisodeScoreV2 = Readonly<{
  episode_id: string;
  pair_id: string;
  cluster_id: string;
  provider: string;
  arm: BenchmarkArmV2;
  network_admission: "opened" | "unopened";
  evidence_status: "observed" | "unopened" | "incomplete" | "invalid";
  evidence_errors: readonly string[];
  replay_run_id: string | null;
  raw_manifest_root_sha256: string | null;
  semantic_evaluation_id: string | null;
  semantic_sidecar_root_sha256: string | null;
  endpoints: EpisodeEndpointScoresV2 | null;
}>;

export type EndpointRatesV2 = Readonly<{
  opened: number;
  useful_mission_success: number;
  task_completion: number;
  model_integrity: number;
  system_integrity: number;
}>;

export type ReportClaimGateV2 = Readonly<{
  id: string;
  passed: boolean;
  observed: boolean | number | string | null;
  required: boolean | number | string;
}>;

export type ReportClaimDecisionV2 = Readonly<{
  method: "hacc_proof_v1_report_conjunctive_decision";
  verdict: "superiority_supported" | "claim_not_supported" | "incomplete_evidence" | "invalid_evidence";
  gates: readonly ReportClaimGateV2[];
  failed_gate_ids: readonly string[];
  invalid_reasons: readonly string[];
  incomplete_reasons: readonly string[];
  statistical_decision: ClaimDecision | null;
}>;

export type BenchmarkAnalysisV2 = Readonly<{
  efficacy: EqualProviderWeightedPairedRiskDifference;
  interval: ProviderClusterBootstrapResult;
  randomization: ProviderStratifiedRandomizationResult;
  safety: SafetyNonInferiorityResult;
  median_paired_safe_first_audio_regression_ms: number | null;
}>;

export type FullBenchmarkReportV2 = Readonly<{
  schema_version: 2;
  report_type: "hacc_proof_full_report";
  report_id: string;
  protocol_id: string;
  phase: BenchmarkPhaseV2;
  generated_at: string;
  providers: readonly string[];
  schedule: Readonly<{
    registered_pairs: number;
    opened_pairs: number;
    unopened_pairs: number;
    asymmetric_admission_pairs: number;
    opened_episodes: number;
    scored_opened_episodes: number;
    all_opened_episodes_retained: boolean;
  }>;
  evidence: Readonly<{
    incomplete_opened_episodes: number;
    invalid_opened_episodes: number;
  }>;
  claim_eligibility: Readonly<{
    verified: boolean;
    receipt_id: string | null;
    receipt_root_sha256: string | null;
    endpoint_contract_id: string | null;
    endpoint_contract_sha256: string | null;
    power_analysis_sha256: string | null;
    corpus_id: string | null;
    corpus_manifest_sha256: string | null;
  }>;
  arm_rates: Readonly<Record<BenchmarkArmV2, EndpointRatesV2>>;
  episodes: readonly EpisodeScoreV2[];
  analysis: BenchmarkAnalysisV2 | null;
  claim_decision: ReportClaimDecisionV2;
}>;

export type PublicBenchmarkReportV2 = Readonly<{
  schema_version: 2;
  report_type: "hacc_proof_public_report";
  report_id: string;
  protocol_id: string;
  phase: BenchmarkPhaseV2;
  providers: readonly string[];
  opened_episodes: number;
  native_success_rate: number | null;
  hacc_success_rate: number | null;
  paired_risk_difference: number | null;
  confidence_interval: Readonly<{ lower: number; upper: number; confidence_level: number }> | null;
  exact_p_value: number | null;
  verdict: ReportClaimDecisionV2["verdict"];
  failed_gates: readonly string[];
  graph: Readonly<{
    title: "Useful mission success";
    unit: "proportion";
    series: readonly Readonly<{ id: BenchmarkArmV2; value: number }>[];
  }> | null;
}>;

export type BenchmarkReportOutputV2 = Readonly<{
  full_report: FullBenchmarkReportV2;
  public_report: PublicBenchmarkReportV2;
  public_json: string;
  public_markdown: string;
}>;
