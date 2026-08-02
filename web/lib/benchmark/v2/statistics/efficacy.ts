import {
  assertProbability,
  assertSafePositiveInteger,
  bigintRatio,
  createSeededRng,
  draw,
  lcm,
  normalizeEfficacyItt,
  percentile,
  type Seed,
  validateProviderSet,
} from "./helpers";
import type {
  EqualProviderWeightedPairedRiskDifference,
  IttPairedBinaryObservation,
  ProviderClusterBootstrapResult,
  ProviderPairedRiskDifference,
  ProviderStratifiedRandomizationResult,
  ScheduledPairedBinaryObservation,
} from "./types";

function providerRow(
  provider: string,
  rows: readonly IttPairedBinaryObservation[],
): ProviderPairedRiskDifference {
  const selected = rows.filter((row) => row.provider === provider);
  const nativeSuccesses = selected.filter((row) => row.native_value).length;
  const haccSuccesses = selected.filter((row) => row.hacc_value).length;
  const haccOnly = selected.filter((row) => row.hacc_value && !row.native_value).length;
  const nativeOnly = selected.filter((row) => row.native_value && !row.hacc_value).length;
  return Object.freeze({
    provider,
    pairs: selected.length,
    native_rate: nativeSuccesses / selected.length,
    hacc_rate: haccSuccesses / selected.length,
    paired_risk_difference: (haccSuccesses - nativeSuccesses) / selected.length,
    hacc_only: haccOnly,
    native_only: nativeOnly,
    ties: selected.length - haccOnly - nativeOnly,
    missing_native: selected.filter((row) => row.native_missing).length,
    missing_hacc: selected.filter((row) => row.hacc_missing).length,
  });
}

function estimateNormalized(
  rows: readonly IttPairedBinaryObservation[],
  providers: readonly string[],
): EqualProviderWeightedPairedRiskDifference {
  const frozenProviders = validateProviderSet(rows, providers);
  const providerRows = frozenProviders.map((provider) => providerRow(provider, rows));
  return Object.freeze({
    method: "equal_provider_weighted_paired_risk_difference" as const,
    estimate: providerRows.reduce((sum, row) => sum + row.paired_risk_difference, 0) / providerRows.length,
    providers: frozenProviders,
    provider_weight: 1 / frozenProviders.length,
    total_pairs: rows.length,
    provider_rows: Object.freeze(providerRows),
    itt: Object.freeze({
      rule: "non_observed_arm_is_failure" as const,
      missing_native: rows.filter((row) => row.native_missing).length,
      missing_hacc: rows.filter((row) => row.hacc_missing).length,
    }),
  });
}

export function equalProviderWeightedPairedRiskDifference(
  scheduled: readonly ScheduledPairedBinaryObservation[],
  providers: readonly string[],
): EqualProviderWeightedPairedRiskDifference {
  return estimateNormalized(normalizeEfficacyItt(scheduled), providers);
}

function exactDistribution(
  rows: readonly IttPairedBinaryObservation[],
  providers: readonly string[],
): Readonly<{
  frequencies: ReadonlyMap<bigint, bigint>;
  observed: bigint;
  discordantPairs: number;
}> {
  const counts = providers.map((provider) => rows.filter((row) => row.provider === provider).length);
  const common = counts.reduce((value, count) => lcm(value, BigInt(count)), BigInt(1));
  const contributions = rows.map((row) => {
    const providerIndex = providers.indexOf(row.provider);
    const difference = Number(row.hacc_value) - Number(row.native_value);
    return BigInt(difference) * (common / BigInt(counts[providerIndex]));
  });
  let frequencies = new Map<bigint, bigint>([[BigInt(0), BigInt(1)]]);
  for (const contribution of contributions) {
    const next = new Map<bigint, bigint>();
    for (const [sum, count] of frequencies) {
      if (contribution === BigInt(0)) {
        next.set(sum, (next.get(sum) ?? BigInt(0)) + count * BigInt(2));
      } else {
        const positive = sum + contribution;
        const negative = sum - contribution;
        next.set(positive, (next.get(positive) ?? BigInt(0)) + count);
        next.set(negative, (next.get(negative) ?? BigInt(0)) + count);
      }
    }
    frequencies = next;
  }
  return Object.freeze({
    frequencies,
    observed: contributions.reduce((sum, value) => sum + value, BigInt(0)),
    discordantPairs: contributions.filter((value) => value !== BigInt(0)).length,
  });
}

/**
 * Exact Fisher randomization test under independent within-pair arm-label
 * exchangeability. Provider sample sizes are represented with exact integer
 * weights, so unequal provider counts cannot silently change equal weighting.
 */
export function exactProviderStratifiedRandomizationTest(
  scheduled: readonly ScheduledPairedBinaryObservation[],
  providers: readonly string[],
  alternative: "two_sided" | "hacc_greater" | "hacc_less" = "two_sided",
): ProviderStratifiedRandomizationResult {
  const rows = normalizeEfficacyItt(scheduled);
  const frozenProviders = validateProviderSet(rows, providers);
  const estimate = estimateNormalized(rows, frozenProviders);
  const distribution = exactDistribution(rows, frozenProviders);
  let total = BigInt(0);
  let extreme = BigInt(0);
  for (const [candidate, count] of distribution.frequencies) {
    total += count;
    const isExtreme = alternative === "hacc_greater"
      ? candidate >= distribution.observed
      : alternative === "hacc_less"
        ? candidate <= distribution.observed
        : (candidate < BigInt(0) ? -candidate : candidate)
          >= (distribution.observed < BigInt(0) ? -distribution.observed : distribution.observed);
    if (isExtreme) extreme += count;
  }
  return Object.freeze({
    method: "exact_provider_stratified_paired_sign_flip" as const,
    alternative,
    statistic: "equal_provider_weighted_paired_risk_difference" as const,
    estimate: estimate.estimate,
    exact_p_value: bigintRatio(extreme, total),
    observed_scaled_integer: distribution.observed.toString(),
    extreme_assignments: extreme.toString(),
    assignment_support_size: total.toString(),
    discordant_pairs: distribution.discordantPairs,
    providers: frozenProviders,
  });
}

function validateBalancedClusters(
  rows: readonly IttPairedBinaryObservation[],
  providers: readonly string[],
): readonly string[] {
  const clusters = [...new Set(rows.map((row) => row.cluster_id))].sort();
  for (const cluster of clusters) {
    const selected = rows.filter((row) => row.cluster_id === cluster);
    for (const provider of providers) {
      if (selected.filter((row) => row.provider === provider).length !== 1) {
        throw new Error(`Cluster ${cluster} must contain exactly one pair for provider ${provider}`);
      }
    }
    if (selected.length !== providers.length) {
      throw new Error(`Cluster ${cluster} contains an unregistered or duplicate provider row`);
    }
  }
  return Object.freeze(clusters);
}

/** Resamples whole scenario-template clusters while preserving all providers. */
export function pairedClusterBootstrapConfidenceInterval(
  scheduled: readonly ScheduledPairedBinaryObservation[],
  options: Readonly<{
    providers: readonly string[];
    iterations: number;
    seed: Seed;
    confidence_level?: number;
  }>,
): ProviderClusterBootstrapResult {
  const rows = normalizeEfficacyItt(scheduled);
  const providers = validateProviderSet(rows, options.providers);
  const clusters = validateBalancedClusters(rows, providers);
  assertSafePositiveInteger(options.iterations, "iterations");
  if (options.iterations < 100) throw new Error("iterations must be at least 100");
  const confidenceLevel = options.confidence_level ?? 0.95;
  assertProbability(confidenceLevel, "confidence_level");
  const estimate = estimateNormalized(rows, providers).estimate;
  const clusterEffects = new Map(clusters.map((cluster) => {
    const selected = rows.filter((row) => row.cluster_id === cluster);
    return [cluster, estimateNormalized(selected, providers).estimate] as const;
  }));
  const rng = createSeededRng(options.seed);
  const draws = new Array<number>(options.iterations);
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < clusters.length; index += 1) {
      total += clusterEffects.get(clusters[Math.floor(draw(rng) * clusters.length)])!;
    }
    draws[iteration] = total / clusters.length;
  }
  const tail = (1 - confidenceLevel) / 2;
  return Object.freeze({
    method: "paired_cluster_bootstrap_equal_provider_weighted" as const,
    estimate,
    interval: Object.freeze({
      confidence_level: confidenceLevel,
      lower: percentile(draws, tail),
      upper: percentile(draws, 1 - tail),
    }),
    clusters: clusters.length,
    providers,
    providers_per_cluster: providers.length,
    iterations: options.iterations,
    seed: options.seed,
  });
}
