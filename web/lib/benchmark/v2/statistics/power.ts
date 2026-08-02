import {
  HACC_PROOF_V1_CONFIRMATORY_POLICY,
  decideSuperiorityClaim,
  type ClaimDecisionPolicy,
  type ConfirmatoryClaimArtifacts,
} from "./decision";
import {
  equalProviderWeightedPairedRiskDifference,
  exactProviderStratifiedRandomizationTest,
  pairedClusterBootstrapConfidenceInterval,
} from "./efficacy";
import {
  assertNonEmptyId,
  assertProbability,
  assertSafePositiveInteger,
  createSeededRng,
  draw,
  type RandomSource,
  type Seed,
} from "./helpers";
import { safetyNonInferiority } from "./safety";
import type { BinaryArmObservation, ScheduledPairedBinaryObservation } from "./types";
import { sha256Hex } from "../../artifacts";

export type PairedJointProbabilities = Readonly<{
  neither: number;
  native_only: number;
  hacc_only: number;
  both: number;
}>;

export type PowerProviderAssumptions = Readonly<{
  provider: string;
  pairs: number;
  efficacy: PairedJointProbabilities;
  safety: PairedJointProbabilities;
  efficacy_missing_probability: Readonly<{ native: number; hacc: number }>;
  safety_missing_probability: Readonly<{ native: number; hacc: number }>;
}>;

export type PowerDesign = Readonly<{
  design_id: string;
  providers: readonly PowerProviderAssumptions[];
}>;

export type PowerSimulationResult = Readonly<{
  method: "deterministic_seeded_conjunctive_claim_simulation";
  design_id: string;
  policy_id: string;
  providers: readonly string[];
  pairs_per_provider: number;
  scheduled_sessions: number;
  simulations: number;
  seed: Seed;
  bootstrap_iterations_per_simulation: number;
  supported: number;
  not_supported: number;
  invalid: number;
  estimated_power: number;
  monte_carlo_interval_95: Readonly<{ lower: number; upper: number }>;
}>;

function validateJoint(probabilities: PairedJointProbabilities, label: string): void {
  for (const key of ["neither", "native_only", "hacc_only", "both"] as const) {
    assertProbability(probabilities[key], `${label}.${key}`, true);
  }
  const sum = probabilities.neither + probabilities.native_only
    + probabilities.hacc_only + probabilities.both;
  if (Math.abs(sum - 1) > 1e-12) throw new Error(`${label} probabilities must sum to one`);
}

function validateDesign(design: PowerDesign): readonly string[] {
  assertNonEmptyId(design.design_id, "design.design_id");
  if (!Array.isArray(design.providers) || design.providers.length === 0) {
    throw new Error("design.providers must not be empty");
  }
  const providers = new Set<string>();
  const firstSize = design.providers[0].pairs;
  for (const profile of design.providers) {
    assertNonEmptyId(profile.provider, "power provider");
    if (providers.has(profile.provider)) throw new Error(`Duplicate power provider: ${profile.provider}`);
    providers.add(profile.provider);
    assertSafePositiveInteger(profile.pairs, `${profile.provider}.pairs`);
    if (profile.pairs !== firstSize) {
      throw new Error("Power simulation requires a balanced pair count across providers");
    }
    validateJoint(profile.efficacy, `${profile.provider}.efficacy`);
    validateJoint(profile.safety, `${profile.provider}.safety`);
    for (const endpoint of ["efficacy", "safety"] as const) {
      for (const arm of ["native", "hacc"] as const) {
        assertProbability(
          profile[`${endpoint}_missing_probability`][arm],
          `${profile.provider}.${endpoint}_missing_probability.${arm}`,
          true,
        );
      }
    }
  }
  return Object.freeze([...providers]);
}

function sampleJoint(probabilities: PairedJointProbabilities, rng: RandomSource): readonly [boolean, boolean] {
  const value = draw(rng);
  if (value < probabilities.neither) return [false, false];
  if (value < probabilities.neither + probabilities.native_only) return [true, false];
  if (value < probabilities.neither + probabilities.native_only + probabilities.hacc_only) {
    return [false, true];
  }
  return [true, true];
}

function possiblyMissing(
  value: boolean,
  probability: number,
  rng: RandomSource,
): BinaryArmObservation {
  return draw(rng) < probability
    ? Object.freeze({ status: "missing" as const, value: null })
    : Object.freeze({ status: "observed" as const, value });
}

function simulatedEndpoint(
  design: PowerDesign,
  endpoint: "efficacy" | "safety",
  rng: RandomSource,
): readonly ScheduledPairedBinaryObservation[] {
  const rows: ScheduledPairedBinaryObservation[] = [];
  for (const profile of design.providers) {
    for (let index = 0; index < profile.pairs; index += 1) {
      const [native, hacc] = sampleJoint(profile[endpoint], rng);
      const missing = profile[`${endpoint}_missing_probability`];
      rows.push(Object.freeze({
        pair_id: `${profile.provider}:pair-${index + 1}`,
        provider: profile.provider,
        cluster_id: `${profile.provider}:cluster-${index + 1}`,
        native: possiblyMissing(native, missing.native, rng),
        hacc: possiblyMissing(hacc, missing.hacc, rng),
      }));
    }
  }
  return Object.freeze(rows);
}

function wilson95(successes: number, total: number): Readonly<{ lower: number; upper: number }> {
  const z = 1.959963984540054;
  const proportion = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + z2 / (4 * total)) / total,
  ) / denominator;
  return Object.freeze({ lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) });
}

function powerSimulationArtifacts(
  efficacyPopulationSha256: string,
  safetyPopulationSha256: string,
  seed: Seed,
  simulation: number,
): ConfirmatoryClaimArtifacts {
  const h = (label: string) => sha256Hex(`hacc-proof-v1-power-simulation:${String(seed)}:${simulation}:${label}`);
  const common = Object.freeze({
    protocol_id: "HACC-Proof-v1" as const,
    policy_sha256: HACC_PROOF_V1_CONFIRMATORY_POLICY.policy_sha256,
    verified: true as const,
  });
  const receiptHashes = Object.freeze({
    schedule: h("schedule"), endpoint: h("endpoint"), power: h("power"),
    corpus: h("corpus"), latency: h("latency"), safety: h("safety"),
  });
  return Object.freeze({
    signed_policy: Object.freeze({
      ...common,
      artifact_type: "signed_policy_identity_receipt" as const,
      receipt_sha256: h("signed-policy"),
      freeze_commit_sha256: h("freeze-commit"),
      signer_key_id: "prospective-power-simulation-only",
      signature_sha256: h("signature"),
      signature_verifier_sha256: h("signature-verifier"),
      signature_verified: true as const,
      bindings: Object.freeze({
        schedule_itt_receipt_sha256: receiptHashes.schedule,
        endpoint_contract_receipt_sha256: receiptHashes.endpoint,
        powered_design_receipt_sha256: receiptHashes.power,
        phase_corpus_receipt_sha256: receiptHashes.corpus,
        latency_receipt_sha256: receiptHashes.latency,
        safety_receipt_sha256: receiptHashes.safety,
      }),
    }),
    schedule_itt: Object.freeze({
      ...common,
      artifact_type: "confirmatory_schedule_itt_receipt" as const,
      receipt_sha256: receiptHashes.schedule,
      phase: "confirmatory" as const,
      scheduled_template_pairs: 108 as const,
      opened_template_pairs: 108 as const,
      itt_template_pairs: 108 as const,
      terminal_episode_dispositions: 216 as const,
      all_scheduled_pairs_opened: true as const,
      all_opened_units_terminal: true as const,
      provider_template_counts: Object.freeze({ openai: 36 as const, gemini: 36 as const, xai: 36 as const }),
      analysis_population_sha256: efficacyPopulationSha256,
    }),
    endpoint_contract: Object.freeze({
      ...common,
      artifact_type: "endpoint_contract_receipt" as const,
      receipt_sha256: receiptHashes.endpoint,
      endpoint_id: "useful_mission_success" as const,
      endpoint_contract_sha256: h("endpoint-contract"),
      evaluator_sha256: h("evaluator"),
      all_conjuncts_replayed: true as const,
    }),
    powered_design: Object.freeze({
      ...common,
      artifact_type: "powered_design_receipt" as const,
      receipt_sha256: receiptHashes.power,
      computed_before_confirmatory_outcomes: true as const,
      design_template_pairs: 108 as const,
      templates_per_provider: 36 as const,
      target_power: 0.8,
      prospective_power_lower_bound: 1,
      passed: true as const,
      analysis_implementation_sha256: h("analysis-implementation"),
    }),
    phase_corpus: Object.freeze({
      ...common,
      artifact_type: "confirmatory_phase_corpus_receipt" as const,
      receipt_sha256: receiptHashes.corpus,
      phase: "confirmatory" as const,
      corpus_role: "untouched_confirmatory" as const,
      template_pairs: 108 as const,
      provider_template_counts: Object.freeze({ openai: 36 as const, gemini: 36 as const, xai: 36 as const }),
      development_or_pilot_templates_included: false as const,
      outcome_access_before_freeze: false as const,
      corpus_manifest_sha256: h("corpus-manifest"),
    }),
    latency: Object.freeze({
      ...common,
      artifact_type: "paired_safe_first_audio_latency_receipt" as const,
      receipt_sha256: receiptHashes.latency,
      metric: "median_paired_safe_first_audio_regression_ms" as const,
      complete_pairs: 108 as const,
      missing_pairs: 0 as const,
      median_regression_ms: 0,
      analysis_population_sha256: efficacyPopulationSha256,
    }),
    safety: Object.freeze({
      ...common,
      artifact_type: "critical_safety_receipt" as const,
      receipt_sha256: receiptHashes.safety,
      complete_pairs: 108 as const,
      missing_pairs: 0 as const,
      hacc_critical_unauthorized_or_duplicate_external_effects: 0,
      hacc_critical_caller_playable_speech_breaches: 0,
      analysis_population_sha256: safetyPopulationSha256,
      all_events_replayed: true as const,
    }),
  });
}

/** Simulates the complete frozen claim conjunction, not merely a McNemar test. */
export function simulateClaimPower(input: Readonly<{
  design: PowerDesign;
  policy: ClaimDecisionPolicy;
  simulations: number;
  bootstrap_iterations_per_simulation: number;
  seed: Seed;
}>): PowerSimulationResult {
  const providers = validateDesign(input.design);
  assertSafePositiveInteger(input.simulations, "simulations");
  if (input.simulations < 100) throw new Error("simulations must be at least 100");
  assertSafePositiveInteger(input.bootstrap_iterations_per_simulation, "bootstrap_iterations_per_simulation");
  if (input.bootstrap_iterations_per_simulation < 100) {
    throw new Error("bootstrap_iterations_per_simulation must be at least 100");
  }
  const rng = createSeededRng(input.seed);
  let supported = 0;
  let notSupported = 0;
  let invalid = 0;
  for (let simulation = 0; simulation < input.simulations; simulation += 1) {
    const efficacyRows = simulatedEndpoint(input.design, "efficacy", rng);
    const safetyRows = simulatedEndpoint(input.design, "safety", rng);
    const efficacy = equalProviderWeightedPairedRiskDifference(efficacyRows, providers);
    const interval = pairedClusterBootstrapConfidenceInterval(efficacyRows, {
      providers,
      iterations: input.bootstrap_iterations_per_simulation,
      seed: `${String(input.seed)}:${input.design.design_id}:bootstrap:${simulation}`,
    });
    const randomization = exactProviderStratifiedRandomizationTest(
      efficacyRows,
      providers,
      "two_sided",
    );
    const safety = safetyNonInferiority(safetyRows, {
      providers,
      margin: input.policy.safety_margin,
    });
    const decision = decideSuperiorityClaim({
      policy: input.policy,
      artifacts: powerSimulationArtifacts(
        efficacy.analysis_population_sha256,
        safety.analysis_population_sha256,
        input.seed,
        simulation,
      ),
      evidence_integrity_valid: true,
      efficacy,
      interval,
      randomization,
      safety,
    });
    if (decision.verdict === "superiority_supported") supported += 1;
    else if (decision.verdict === "invalid_evidence") invalid += 1;
    else notSupported += 1;
  }
  return Object.freeze({
    method: "deterministic_seeded_conjunctive_claim_simulation" as const,
    design_id: input.design.design_id,
    policy_id: input.policy.policy_id,
    providers,
    pairs_per_provider: input.design.providers[0].pairs,
    scheduled_sessions: input.design.providers.reduce((sum, profile) => sum + profile.pairs * 2, 0),
    simulations: input.simulations,
    seed: input.seed,
    bootstrap_iterations_per_simulation: input.bootstrap_iterations_per_simulation,
    supported,
    not_supported: notSupported,
    invalid,
    estimated_power: supported / input.simulations,
    monte_carlo_interval_95: wilson95(supported, input.simulations),
  });
}

/**
 * Selects the smallest design whose Monte Carlo lower bound clears target
 * power. Callers must supply results generated from the same frozen policy and
 * nuisance assumptions; this function never interpolates or relaxes a target.
 */
export function lookupMinimumPoweredDesign(
  results: readonly PowerSimulationResult[],
  targetPower: number,
): PowerSimulationResult | null {
  assertProbability(targetPower, "targetPower");
  if (!Array.isArray(results) || results.length === 0) throw new Error("At least one power result is required");
  const ids = new Set<string>();
  const policyId = results[0].policy_id;
  for (const result of results) {
    if (ids.has(result.design_id)) throw new Error(`Duplicate power design result: ${result.design_id}`);
    ids.add(result.design_id);
    if (result.policy_id !== policyId) throw new Error("Power lookup cannot mix claim policies");
  }
  return [...results]
    .sort((left, right) => left.scheduled_sessions - right.scheduled_sessions
      || left.design_id.localeCompare(right.design_id))
    .find((result) => result.monte_carlo_interval_95.lower >= targetPower) ?? null;
}
