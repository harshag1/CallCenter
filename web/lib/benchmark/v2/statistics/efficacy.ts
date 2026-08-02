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
import { canonicalJson, sha256Hex } from "../../artifacts";

const ANALYSIS_POPULATION_DOMAIN = "harshas-amazing-call-center/hacc-proof-v1/analysis-population/v1\n";

function analysisPopulationSha256(
  rows: readonly IttPairedBinaryObservation[],
  providers: readonly string[],
): string {
  return sha256Hex(`${ANALYSIS_POPULATION_DOMAIN}${canonicalJson({
    providers,
    rows: [...rows]
      .sort((left, right) => left.pair_id.localeCompare(right.pair_id))
      .map((row) => ({
        pair_id: row.pair_id,
        provider: row.provider,
        cluster_id: row.cluster_id,
        native_value: row.native_value,
        hacc_value: row.hacc_value,
        native_status: row.native_status,
        hacc_status: row.hacc_status,
      })),
  })}`);
}

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
    analysis_population_sha256: analysisPopulationSha256(rows, frozenProviders),
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
    analysis_population_sha256: estimate.analysis_population_sha256,
  });
}

function validateIndependentProviderStrata(
  rows: readonly IttPairedBinaryObservation[],
  providers: readonly string[],
): Readonly<{
  clusters: readonly string[];
  pairsPerProvider: number;
}> {
  const clusters = [...new Set(rows.map((row) => row.cluster_id))].sort();
  if (clusters.length !== rows.length) {
    const duplicate = clusters.find(
      (cluster) => rows.filter((row) => row.cluster_id === cluster).length !== 1,
    );
    throw new Error(
      `Independent template ${duplicate ?? "unknown"} appears more than once; provider-rendered pseudoreplication is forbidden`,
    );
  }
  const counts = providers.map((provider) => rows.filter((row) => row.provider === provider).length);
  if (new Set(counts).size !== 1) {
    throw new Error(
      `Provider strata must contain the same number of independent templates: ${providers
        .map((provider, index) => `${provider}=${counts[index]}`)
        .join(", ")}`,
    );
  }
  for (const cluster of clusters) {
    const selected = rows.filter((row) => row.cluster_id === cluster);
    if (selected.length !== 1) {
      throw new Error(`Independent template ${cluster} must contribute exactly one Native/HACC pair`);
    }
  }
  return Object.freeze({ clusters: Object.freeze(clusters), pairsPerProvider: counts[0] });
}

/**
 * Resamples independent templates within their assigned provider stratum,
 * then gives every provider-stratum mean equal aggregate weight. A template
 * may appear only once across the entire analysis population; rendering one
 * template through multiple providers is rejected as pseudoreplication.
 */
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
  const strata = validateIndependentProviderStrata(rows, providers);
  assertSafePositiveInteger(options.iterations, "iterations");
  if (options.iterations < 100) throw new Error("iterations must be at least 100");
  const confidenceLevel = options.confidence_level ?? 0.95;
  assertProbability(confidenceLevel, "confidence_level");
  const estimate = estimateNormalized(rows, providers).estimate;
  const differencesByProvider = new Map(providers.map((provider) => [
    provider,
    rows
      .filter((row) => row.provider === provider)
      .map((row) => Number(row.hacc_value) - Number(row.native_value)),
  ] as const));
  const rng = createSeededRng(options.seed);
  const draws = new Array<number>(options.iterations);
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let providerTotal = 0;
    for (const provider of providers) {
      const differences = differencesByProvider.get(provider)!;
      let stratumTotal = 0;
      for (let index = 0; index < differences.length; index += 1) {
        stratumTotal += differences[Math.floor(draw(rng) * differences.length)];
      }
      providerTotal += stratumTotal / differences.length;
    }
    draws[iteration] = providerTotal / providers.length;
  }
  const tail = (1 - confidenceLevel) / 2;
  return Object.freeze({
    method: "provider_stratified_template_bootstrap_equal_provider_weighted" as const,
    estimate,
    interval: Object.freeze({
      confidence_level: confidenceLevel,
      lower: percentile(draws, tail),
      upper: percentile(draws, 1 - tail),
    }),
    clusters: strata.clusters.length,
    providers,
    providers_per_cluster: 1 as const,
    pairs_per_provider: strata.pairsPerProvider,
    iterations: options.iterations,
    seed: options.seed,
    analysis_population_sha256: analysisPopulationSha256(rows, providers),
  });
}
