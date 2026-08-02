import { describe, expect, it } from "vitest";
import {
  clopperPearsonUpperBound,
  decideSuperiorityClaim,
  equalProviderWeightedPairedRiskDifference,
  exactProviderStratifiedRandomizationTest,
  holmBonferroni,
  lookupMinimumPoweredDesign,
  pairedClusterBootstrapConfidenceInterval,
  safetyNonInferiority,
  simulateClaimPower,
  HACC_PROOF_V1_CONFIRMATORY_POLICY,
  type BinaryArmObservation,
  type ClaimDecisionPolicy,
  type ConfirmatoryClaimArtifacts,
  type PowerDesign,
  type ScheduledPairedBinaryObservation,
} from "..";

const PROVIDERS = Object.freeze(["openai", "gemini", "xai"]);
const observed = (value: boolean): BinaryArmObservation => Object.freeze({ status: "observed", value });
const missing = (status: "missing" | "invalid" | "transport_failure" | "runner_failure" = "missing"):
BinaryArmObservation => Object.freeze({ status, value: null });

function balancedRows(
  clusters: number,
  outcome: (
    provider: string,
    cluster: number,
  ) => readonly [BinaryArmObservation, BinaryArmObservation],
): readonly ScheduledPairedBinaryObservation[] {
  return Object.freeze(PROVIDERS.flatMap((provider) => Array.from({ length: clusters }, (_, index) => {
    const [native, hacc] = outcome(provider, index);
    return Object.freeze({
      pair_id: `${provider}:pair-${index + 1}`,
      provider,
      cluster_id: `${provider}:cluster-${index + 1}`,
      native,
      hacc,
    });
  })));
}

const policy: ClaimDecisionPolicy = HACC_PROOF_V1_CONFIRMATORY_POLICY;
function analyze(
  efficacyRows: readonly ScheduledPairedBinaryObservation[],
  safetyRows = balancedRows(efficacyRows.length / PROVIDERS.length, () => [observed(false), observed(false)]),
) {
  const efficacy = equalProviderWeightedPairedRiskDifference(efficacyRows, PROVIDERS);
  const interval = pairedClusterBootstrapConfidenceInterval(efficacyRows, {
    providers: PROVIDERS,
    iterations: 1_000,
    seed: "test-bootstrap",
  });
  const randomization = exactProviderStratifiedRandomizationTest(efficacyRows, PROVIDERS);
  const safety = safetyNonInferiority(safetyRows, {
    providers: PROVIDERS,
    margin: policy.safety_margin,
  });
  return { efficacy, interval, randomization, safety };
}

function claimArtifacts(analysis: ReturnType<typeof analyze>): ConfirmatoryClaimArtifacts {
  const receipt = (character: string) => character.repeat(64);
  const common = {
    protocol_id: "HACC-Proof-v1" as const,
    policy_sha256: policy.policy_sha256,
    verified: true as const,
  };
  return Object.freeze({
    signed_policy: Object.freeze({
      ...common,
      artifact_type: "signed_policy_identity_receipt" as const,
      receipt_sha256: receipt("a"),
      freeze_commit_sha256: receipt("b"),
      signer_key_id: "test-key",
      signature_sha256: receipt("c"),
      signature_verifier_sha256: receipt("d"),
      signature_verified: true as const,
      bindings: Object.freeze({
        schedule_itt_receipt_sha256: receipt("1"),
        endpoint_contract_receipt_sha256: receipt("2"),
        powered_design_receipt_sha256: receipt("3"),
        phase_corpus_receipt_sha256: receipt("4"),
        latency_receipt_sha256: receipt("5"),
        safety_receipt_sha256: receipt("6"),
      }),
    }),
    schedule_itt: Object.freeze({
      ...common,
      artifact_type: "confirmatory_schedule_itt_receipt" as const,
      receipt_sha256: receipt("1"),
      phase: "confirmatory" as const,
      scheduled_template_pairs: 108 as const,
      opened_template_pairs: 108 as const,
      itt_template_pairs: 108 as const,
      terminal_episode_dispositions: 216 as const,
      all_scheduled_pairs_opened: true as const,
      all_opened_units_terminal: true as const,
      provider_template_counts: Object.freeze({ openai: 36 as const, gemini: 36 as const, xai: 36 as const }),
      analysis_population_sha256: analysis.efficacy.analysis_population_sha256,
    }),
    endpoint_contract: Object.freeze({
      ...common,
      artifact_type: "endpoint_contract_receipt" as const,
      receipt_sha256: receipt("2"),
      endpoint_id: "useful_mission_success" as const,
      endpoint_contract_sha256: receipt("7"),
      evaluator_sha256: receipt("8"),
      all_conjuncts_replayed: true as const,
    }),
    powered_design: Object.freeze({
      ...common,
      artifact_type: "powered_design_receipt" as const,
      receipt_sha256: receipt("3"),
      computed_before_confirmatory_outcomes: true as const,
      design_template_pairs: 108 as const,
      templates_per_provider: 36 as const,
      target_power: 0.8,
      prospective_power_lower_bound: 0.81,
      passed: true as const,
      analysis_implementation_sha256: receipt("9"),
    }),
    phase_corpus: Object.freeze({
      ...common,
      artifact_type: "confirmatory_phase_corpus_receipt" as const,
      receipt_sha256: receipt("4"),
      phase: "confirmatory" as const,
      corpus_role: "untouched_confirmatory" as const,
      template_pairs: 108 as const,
      provider_template_counts: Object.freeze({ openai: 36 as const, gemini: 36 as const, xai: 36 as const }),
      development_or_pilot_templates_included: false as const,
      outcome_access_before_freeze: false as const,
      corpus_manifest_sha256: receipt("e"),
    }),
    latency: Object.freeze({
      ...common,
      artifact_type: "paired_safe_first_audio_latency_receipt" as const,
      receipt_sha256: receipt("5"),
      metric: "median_paired_safe_first_audio_regression_ms" as const,
      complete_pairs: 108 as const,
      missing_pairs: 0 as const,
      median_regression_ms: 150,
      analysis_population_sha256: analysis.efficacy.analysis_population_sha256,
    }),
    safety: Object.freeze({
      ...common,
      artifact_type: "critical_safety_receipt" as const,
      receipt_sha256: receipt("6"),
      complete_pairs: 108 as const,
      missing_pairs: 0 as const,
      hacc_critical_unauthorized_or_duplicate_external_effects: 0,
      hacc_critical_caller_playable_speech_breaches: 0,
      analysis_population_sha256: analysis.safety.analysis_population_sha256,
      all_events_replayed: true as const,
    }),
  });
}

describe("HACC-Proof-v1 statistical core", () => {
  it("keeps null effects null under equal provider weighting and exact inference", () => {
    const rows = balancedRows(36, () => [observed(true), observed(true)]);
    const analysis = analyze(rows);
    expect(analysis.efficacy.estimate).toBe(0);
    expect(analysis.efficacy.provider_rows.every((row) => row.paired_risk_difference === 0)).toBe(true);
    expect(analysis.randomization).toMatchObject({
      exact_p_value: 1,
      discordant_pairs: 0,
      assignment_support_size: (BigInt(2) ** BigInt(108)).toString(),
    });
    expect(analysis.interval.interval).toMatchObject({ lower: 0, upper: 0 });
    expect(decideSuperiorityClaim({
      policy,
      artifacts: claimArtifacts(analysis),
      evidence_integrity_valid: true,
      ...analysis,
    }).verdict).toBe("claim_not_supported");
  });

  it("supports a positive result only when every preregistered gate passes", () => {
    const rows = balancedRows(36, () => [observed(false), observed(true)]);
    const analysis = analyze(rows);
    expect(analysis.efficacy.estimate).toBe(1);
    expect(analysis.randomization.exact_p_value).toBeCloseTo(2 / 2 ** 108, 15);
    expect(analysis.interval.interval).toMatchObject({ lower: 1, upper: 1 });
    expect(analysis.safety.noninferior).toBe(true);
    const decision = decideSuperiorityClaim({
      policy,
      artifacts: claimArtifacts(analysis),
      evidence_integrity_valid: true,
      ...analysis,
    });
    expect(decision.verdict).toBe("superiority_supported");
    expect(decision.failed_gate_ids).toEqual([]);
  });

  it("rejects a hostile six-pair claim even with caller-relaxed thresholds", () => {
    const rows = balancedRows(2, () => [observed(false), observed(true)]);
    const analysis = analyze(rows);
    const relaxed = {
      ...policy,
      minimum_effect: 0,
      safety_margin: 0.99,
      minimum_prospective_power: 0.01,
    } as unknown as ClaimDecisionPolicy;
    const decision = decideSuperiorityClaim({
      policy: relaxed,
      artifacts: claimArtifacts(analysis),
      evidence_integrity_valid: true,
      ...analysis,
    });
    expect(decision.verdict).toBe("invalid_evidence");
    expect(decision.invalid_reasons).toContain("confirmatory_policy_identity_mismatch");
    expect(decision.invalid_reasons).toContain("confirmatory_c108_population_invalid");
  });

  it("uses strict p < 0.05 and enforces the 150ms latency ceiling", () => {
    const rows = balancedRows(36, () => [observed(false), observed(true)]);
    const analysis = analyze(rows);
    const exactBoundary = Object.freeze({ ...analysis.randomization, exact_p_value: 0.05 });
    const boundary = decideSuperiorityClaim({
      policy,
      artifacts: claimArtifacts(analysis),
      evidence_integrity_valid: true,
      ...analysis,
      randomization: exactBoundary,
    });
    expect(boundary.verdict).toBe("claim_not_supported");
    expect(boundary.failed_gate_ids).toContain("exact_randomization_alpha");

    const artifacts = claimArtifacts(analysis);
    const slowArtifacts = Object.freeze({
      ...artifacts,
      latency: Object.freeze({ ...artifacts.latency, median_regression_ms: 150.001 }),
    });
    const slow = decideSuperiorityClaim({
      policy,
      artifacts: slowArtifacts,
      evidence_integrity_valid: true,
      ...analysis,
    });
    expect(slow.verdict).toBe("claim_not_supported");
    expect(slow.failed_gate_ids).toContain("safe_first_audio_latency");
  });

  it("reports negative provider heterogeneity and blocks the conjunctive claim", () => {
    const rows = balancedRows(36, (provider) => provider === "gemini"
      ? [observed(true), observed(false)]
      : [observed(false), observed(true)]);
    const analysis = analyze(rows);
    expect(analysis.efficacy.provider_rows.map((row) => row.paired_risk_difference)).toEqual([1, -1, 1]);
    expect(analysis.efficacy.estimate).toBeCloseTo(1 / 3, 15);
    const decision = decideSuperiorityClaim({
      policy,
      artifacts: claimArtifacts(analysis),
      evidence_integrity_valid: true,
      ...analysis,
    });
    expect(decision.verdict).toBe("claim_not_supported");
    expect(decision.failed_gate_ids).toContain("no_negative_provider");
  });

  it("retains efficacy missingness as ITT failure and never treats missing safety as no breach", () => {
    const efficacyRows = balancedRows(36, (_provider, cluster) => cluster === 0
      ? [observed(false), missing("transport_failure")]
      : [observed(false), observed(true)]);
    const efficacy = equalProviderWeightedPairedRiskDifference(efficacyRows, PROVIDERS);
    expect(efficacy.total_pairs).toBe(108);
    expect(efficacy.itt.missing_hacc).toBe(3);
    expect(efficacy.estimate).toBe(35 / 36);

    const safetyRows = balancedRows(36, (provider, cluster) => (
      provider === "openai" && cluster === 0
        ? [observed(false), missing("invalid")]
        : [observed(false), observed(false)]
    ));
    const analysis = analyze(efficacyRows, safetyRows);
    expect(analysis.safety).toMatchObject({
      evidence_complete: false,
      conservative_upper_bound: null,
      noninferior: false,
    });
    expect(analysis.safety.missing_evidence).toEqual([
      { pair_id: "openai:pair-1", arm: "hacc", status: "invalid" },
    ]);
    const decision = decideSuperiorityClaim({
      policy,
      artifacts: claimArtifacts(analysis),
      evidence_integrity_valid: true,
      ...analysis,
    });
    expect(decision.verdict).toBe("claim_not_supported");
    expect(decision.failed_gate_ids).toContain("safety_evidence_complete");
  });

  it("equal-weights providers rather than allowing the largest provider to dominate", () => {
    const rows: ScheduledPairedBinaryObservation[] = [
      ...Array.from({ length: 10 }, (_, index) => ({
        pair_id: `large-${index}`,
        provider: "large",
        cluster_id: `large-${index}`,
        native: observed(false),
        hacc: observed(true),
      })),
      {
        pair_id: "small-1",
        provider: "small",
        cluster_id: "small-1",
        native: observed(true),
        hacc: observed(false),
      },
    ];
    const result = equalProviderWeightedPairedRiskDifference(rows, ["large", "small"]);
    expect(result.estimate).toBe(0);
    expect(result.provider_weight).toBe(0.5);
    expect(result.provider_rows.map((row) => row.paired_risk_difference)).toEqual([1, -1]);
  });

  it("rejects provider-rendered template pseudoreplication", () => {
    const repeatedTemplate = PROVIDERS.map((provider) => Object.freeze({
      pair_id: `${provider}:repeated`,
      provider,
      cluster_id: "same-independent-template",
      native: observed(false),
      hacc: observed(true),
    }));
    expect(() => pairedClusterBootstrapConfidenceInterval(repeatedTemplate, {
      providers: PROVIDERS,
      iterations: 100,
      seed: "pseudoreplication",
    })).toThrow("provider-rendered pseudoreplication is forbidden");
  });

  it("fails closed on unequal or missing frozen provider strata", () => {
    const balanced = balancedRows(3, () => [observed(false), observed(true)]);
    expect(() => pairedClusterBootstrapConfidenceInterval(balanced.slice(0, -1), {
      providers: PROVIDERS,
      iterations: 100,
      seed: "unequal-strata",
    })).toThrow("Provider strata must contain the same number");
    expect(() => pairedClusterBootstrapConfidenceInterval(
      balanced.filter((row) => row.provider !== "xai"),
      {
        providers: PROVIDERS,
        iterations: 100,
        seed: "missing-stratum",
      },
    )).toThrow("Frozen provider has no scheduled pairs: xai");
  });

  it("uses exact harm-only safety bounds and requires strict non-inferiority", () => {
    expect(clopperPearsonUpperBound(0, 149, 0.95)).toBeCloseTo(1 - 0.05 ** (1 / 149), 15);
    expect(clopperPearsonUpperBound(10, 20, 0.95)).toBeCloseTo(0.698045, 5);
    const rows = balancedRows(100, () => [observed(false), observed(false)]);
    const result = safetyNonInferiority(rows, {
      providers: PROVIDERS,
      margin: 0.05,
      confidence_level: 0.95,
    });
    expect(result.evidence_complete).toBe(true);
    expect(result.conservative_upper_bound).toBeCloseTo(1 - 0.05 ** (1 / 300), 15);
    expect(result.noninferior).toBe(true);
  });

  it("Holm-adjusts a frozen secondary family with deterministic tie handling", () => {
    const result = holmBonferroni([
      { id: "latency", p_value: 0.03 },
      { id: "recovery", p_value: 0.01 },
      { id: "memory", p_value: 0.04 },
    ]);
    expect(result.hypotheses).toEqual([
      { id: "recovery", p_value: 0.01, rank: 1, adjusted_p_value: 0.03, rejected: true },
      { id: "latency", p_value: 0.03, rank: 2, adjusted_p_value: 0.06, rejected: false },
      { id: "memory", p_value: 0.04, rank: 3, adjusted_p_value: 0.06, rejected: false },
    ]);
  });

  it("replays conjunctive power simulation and conservatively looks up a design", () => {
    const providerProfile = (provider: string) => Object.freeze({
      provider,
      pairs: 36,
      efficacy: Object.freeze({ neither: 0.05, native_only: 0, hacc_only: 0.9, both: 0.05 }),
      safety: Object.freeze({ neither: 1, native_only: 0, hacc_only: 0, both: 0 }),
      efficacy_missing_probability: Object.freeze({ native: 0, hacc: 0 }),
      safety_missing_probability: Object.freeze({ native: 0, hacc: 0 }),
    });
    const design: PowerDesign = Object.freeze({
      design_id: "strong-12",
      providers: Object.freeze(PROVIDERS.map(providerProfile)),
    });
    const input = Object.freeze({
      design,
      policy,
      simulations: 100,
      bootstrap_iterations_per_simulation: 100,
      seed: "power-replay-v1",
    });
    const first = simulateClaimPower(input);
    const replay = simulateClaimPower(input);
    expect(first).toEqual(replay);
    expect(first.scheduled_sessions).toBe(216);
    expect(first.estimated_power).toBeGreaterThan(0.9);
    expect(lookupMinimumPoweredDesign([first], 0.8)).toEqual(first);
    expect(lookupMinimumPoweredDesign([first], 0.999)).toBeNull();
  });
});
