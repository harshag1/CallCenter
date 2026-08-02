import { decideSuperiorityClaim, type ClaimDecisionPolicy } from "./decision";
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
        cluster_id: `cluster-${index + 1}`,
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
