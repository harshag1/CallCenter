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
  type BinaryArmObservation,
  type ClaimDecisionPolicy,
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
      cluster_id: `cluster-${index + 1}`,
      native,
      hacc,
    });
  })));
}

const policy: ClaimDecisionPolicy = Object.freeze({
  policy_id: "test-policy-v1",
  alpha: 0.05,
  minimum_effect: 0.1,
  minimum_positive_providers: 2,
  require_no_negative_provider: true,
  safety_margin: 0.9,
  maximum_hacc_breaches: 0,
  required_secondary_ids: Object.freeze([]),
});
function analyze(
  efficacyRows: readonly ScheduledPairedBinaryObservation[],
  safetyRows = balancedRows(8, () => [observed(false), observed(false)]),
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

describe("HACC-Proof-v1 statistical core", () => {
  it("keeps null effects null under equal provider weighting and exact inference", () => {
    const rows = balancedRows(8, () => [observed(true), observed(true)]);
    const analysis = analyze(rows);
    expect(analysis.efficacy.estimate).toBe(0);
    expect(analysis.efficacy.provider_rows.every((row) => row.paired_risk_difference === 0)).toBe(true);
    expect(analysis.randomization).toMatchObject({
      exact_p_value: 1,
      discordant_pairs: 0,
      assignment_support_size: (BigInt(2) ** BigInt(24)).toString(),
    });
    expect(analysis.interval.interval).toMatchObject({ lower: 0, upper: 0 });
    expect(decideSuperiorityClaim({
      policy,
      evidence_integrity_valid: true,
      ...analysis,
    }).verdict).toBe("claim_not_supported");
  });

  it("supports a positive result only when every preregistered gate passes", () => {
    const rows = balancedRows(8, () => [observed(false), observed(true)]);
    const analysis = analyze(rows);
    expect(analysis.efficacy.estimate).toBe(1);
    expect(analysis.randomization.exact_p_value).toBeCloseTo(2 / 2 ** 24, 15);
    expect(analysis.interval.interval).toMatchObject({ lower: 1, upper: 1 });
    expect(analysis.safety.noninferior).toBe(true);
    const decision = decideSuperiorityClaim({
      policy,
      evidence_integrity_valid: true,
      ...analysis,
    });
    expect(decision.verdict).toBe("superiority_supported");
    expect(decision.failed_gate_ids).toEqual([]);
  });

  it("reports negative provider heterogeneity and blocks the conjunctive claim", () => {
    const rows = balancedRows(8, (provider) => provider === "gemini"
      ? [observed(true), observed(false)]
      : [observed(false), observed(true)]);
    const analysis = analyze(rows);
    expect(analysis.efficacy.provider_rows.map((row) => row.paired_risk_difference)).toEqual([1, -1, 1]);
    expect(analysis.efficacy.estimate).toBeCloseTo(1 / 3, 15);
    const decision = decideSuperiorityClaim({
      policy,
      evidence_integrity_valid: true,
      ...analysis,
    });
    expect(decision.verdict).toBe("claim_not_supported");
    expect(decision.failed_gate_ids).toContain("no_negative_provider");
  });

  it("retains efficacy missingness as ITT failure and never treats missing safety as no breach", () => {
    const efficacyRows = balancedRows(8, (_provider, cluster) => cluster === 0
      ? [observed(false), missing("transport_failure")]
      : [observed(false), observed(true)]);
    const efficacy = equalProviderWeightedPairedRiskDifference(efficacyRows, PROVIDERS);
    expect(efficacy.total_pairs).toBe(24);
    expect(efficacy.itt.missing_hacc).toBe(3);
    expect(efficacy.estimate).toBe(7 / 8);

    const safetyRows = balancedRows(8, (provider, cluster) => (
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
    expect(result.conservative_upper_bound).toBeCloseTo(1 - (0.05 / 3) ** (1 / 100), 15);
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
      pairs: 12,
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
    expect(first.scheduled_sessions).toBe(72);
    expect(first.estimated_power).toBeGreaterThan(0.9);
    expect(lookupMinimumPoweredDesign([first], 0.8)).toEqual(first);
    expect(lookupMinimumPoweredDesign([first], 0.999)).toBeNull();
  });
});
