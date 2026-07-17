/** Deterministic statistical utilities for paired benchmark experiments. */

export type RandomSource = () => number;
export type Seed = string | number;

export type ConfidenceInterval = Readonly<{
  confidence_level: number;
  lower: number;
  upper: number;
}>;

export type PairedValue = Readonly<{
  pair_id: string;
  baseline: number;
  treatment: number;
}>;

export type ClusteredPairedValue = PairedValue & Readonly<{ cluster_id: string }>;

export type BootstrapDifference = Readonly<{
  estimate: number;
  standard_error: number;
  interval: ConfidenceInterval;
  iterations: number;
  seed: Seed;
  sampling_unit: "pair" | "cluster";
  units: number;
}>;

export type ExactConditionalMcNemarPower = Readonly<{
  method: "exact_conditional_mcnemar_two_sided";
  sample_size: number;
  alpha: number;
  risk_difference: number;
  discordance: number;
  treatment_only_probability: number;
  baseline_only_probability: number;
  power: number;
}>;

function assertProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${label} must be strictly between zero and one`);
  }
}

function assertFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
}

function assertIterations(iterations: number): void {
  if (!Number.isSafeInteger(iterations) || iterations < 100) {
    throw new Error("iterations must be a safe integer of at least 100");
  }
}

function assertUniquePairIds(pairs: readonly PairedValue[]): void {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error("At least one paired observation is required");
  }
  const ids = new Set<string>();
  for (const pair of pairs) {
    if (typeof pair.pair_id !== "string" || pair.pair_id.trim().length === 0) {
      throw new Error("Every paired observation needs a non-empty pair_id");
    }
    if (ids.has(pair.pair_id)) throw new Error(`Duplicate pair_id: ${pair.pair_id}`);
    ids.add(pair.pair_id);
    assertFinite(pair.baseline, `${pair.pair_id}.baseline`);
    assertFinite(pair.treatment, `${pair.pair_id}.treatment`);
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot compute the mean of an empty sample");
  let sum = 0;
  for (const value of values) {
    assertFinite(value, "sample value");
    sum += value;
    if (!Number.isFinite(sum)) throw new Error("Sample sum exceeds finite numeric range");
  }
  return sum / values.length;
}

function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * FNV-1a seed hashing followed by Mulberry32. The algorithm is intentionally
 * specified here so reruns do not depend on a platform RNG implementation.
 */
export function createSeededRng(seed: Seed): RandomSource {
  const seedText = typeof seed === "number"
    ? (() => {
        if (!Number.isFinite(seed)) throw new Error("Numeric seed must be finite");
        return `number:${Object.is(seed, -0) ? 0 : seed}`;
      })()
    : `string:${seed}`;

  let state = 0x811c9dc5;
  for (let index = 0; index < seedText.length; index += 1) {
    state ^= seedText.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  state >>>= 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function asRng(seedOrRng: Seed | RandomSource): RandomSource {
  return typeof seedOrRng === "function" ? seedOrRng : createSeededRng(seedOrRng);
}

function draw(rng: RandomSource): number {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("Random source must return a finite value in [0, 1)");
  }
  return value;
}

export function shuffleSeeded<T>(
  values: readonly T[],
  seedOrRng: Seed | RandomSource
): readonly T[] {
  const result = [...values];
  const rng = asRng(seedOrRng);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(draw(rng) * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return Object.freeze(result);
}

/**
 * Block-balanced paired order assignment. Pair scheduling is shuffled, while
 * AB and BA assignments differ by at most one even for small pilot batches.
 */
export function randomizePairedArmOrder<TArm extends string>(
  pairIds: readonly string[],
  arms: readonly [TArm, TArm],
  seed: Seed
): readonly Readonly<{
  sequence: number;
  pair_id: string;
  first: TArm;
  second: TArm;
}>[] {
  if (pairIds.length === 0) throw new Error("At least one pair_id is required");
  if (arms[0] === arms[1]) throw new Error("Paired arms must be distinct");
  if (arms.some((arm) => typeof arm !== "string" || arm.trim().length === 0)) {
    throw new Error("Paired arm names must be non-empty strings");
  }
  const unique = new Set(pairIds);
  if (unique.size !== pairIds.length || pairIds.some((id) => id.trim().length === 0)) {
    throw new Error("pair_id values must be unique and non-empty");
  }

  const rng = createSeededRng(seed);
  const shuffledPairs = shuffleSeeded(pairIds, rng);
  const startsWithFirstArm = draw(rng) < 0.5;
  return Object.freeze(shuffledPairs.map((pairId, sequence) => {
    const orientation = (sequence + (startsWithFirstArm ? 0 : 1)) % 2;
    return Object.freeze({
      sequence,
      pair_id: pairId,
      first: arms[orientation],
      second: arms[1 - orientation],
    });
  }));
}

/** Acklam's inverse-normal approximation, accurate well beyond benchmark needs. */
export function normalQuantile(probability: number): number {
  assertProbability(probability, "probability");
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  const high = 1 - low;

  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability <= high) {
    const q = probability - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - probability));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export function wilsonScoreInterval(
  successes: number,
  total: number,
  confidenceLevel = 0.95
): ConfidenceInterval {
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("total must be a positive safe integer");
  if (!Number.isSafeInteger(successes) || successes < 0 || successes > total) {
    throw new Error("successes must be an integer between zero and total");
  }
  assertProbability(confidenceLevel, "confidenceLevel");
  const z = normalQuantile(1 - (1 - confidenceLevel) / 2);
  const proportion = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * total)) / total
  ) / denominator;
  return Object.freeze({
    confidence_level: confidenceLevel,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  });
}

function binomialProbabilities(trials: number, probability: number): readonly number[] {
  if (!Number.isSafeInteger(trials) || trials < 0 || trials > 1_000) {
    throw new Error("binomial trials must be a safe integer between zero and 1,000");
  }
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("binomial probability must be between zero and one");
  }
  if (probability === 0) {
    return Object.freeze([1, ...Array.from({ length: trials }, () => 0)]);
  }
  if (probability === 1) {
    return Object.freeze([...Array.from({ length: trials }, () => 0), 1]);
  }
  if (probability > 0.5) {
    return Object.freeze([...binomialProbabilities(trials, 1 - probability)].reverse());
  }
  const probabilities = new Array<number>(trials + 1).fill(0);
  probabilities[0] = (1 - probability) ** trials;
  const odds = probability / (1 - probability);
  for (let successes = 0; successes < trials; successes += 1) {
    probabilities[successes + 1] = probabilities[successes]
      * ((trials - successes) / (successes + 1))
      * odds;
  }
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("binomial probability calculation lost numeric support");
  }
  return Object.freeze(probabilities.map((value) => value / total));
}

/**
 * Planning-only exact power for a two-sided conditional McNemar test.
 *
 * This freezes the candidate-design calculation in the protocol; it does not
 * establish power for a report that uses a different interval, clustering,
 * provider-weighting, missingness, multiplicity, or conjunctive decision rule.
 */
export function exactConditionalMcNemarPower(input: Readonly<{
  sample_size: number;
  risk_difference: number;
  discordance: number;
  alpha?: number;
}>): ExactConditionalMcNemarPower {
  if (!Number.isSafeInteger(input.sample_size) || input.sample_size <= 0 || input.sample_size > 1_000) {
    throw new Error("sample_size must be a safe integer between one and 1,000");
  }
  const alpha = input.alpha ?? 0.05;
  assertProbability(alpha, "alpha");
  if (!Number.isFinite(input.discordance) || input.discordance <= 0 || input.discordance >= 1) {
    throw new Error("discordance must be strictly between zero and one");
  }
  if (
    !Number.isFinite(input.risk_difference)
    || input.risk_difference <= 0
    || input.risk_difference > input.discordance
  ) {
    throw new Error("risk_difference must be positive and no larger than discordance");
  }
  const treatmentOnly = (input.discordance + input.risk_difference) / 2;
  const baselineOnly = (input.discordance - input.risk_difference) / 2;
  const treatmentShareAmongDiscordant = treatmentOnly / input.discordance;
  const discordantCounts = binomialProbabilities(input.sample_size, input.discordance);
  let power = 0;
  for (let discordant = 1; discordant <= input.sample_size; discordant += 1) {
    const nullDistribution = binomialProbabilities(discordant, 0.5);
    const alternativeDistribution = binomialProbabilities(
      discordant,
      treatmentShareAmongDiscordant
    );
    const lowerTail = new Array<number>(discordant + 1).fill(0);
    for (let index = 0; index <= discordant; index += 1) {
      lowerTail[index] = nullDistribution[index] + (index === 0 ? 0 : lowerTail[index - 1]);
    }
    let conditionalRejectionProbability = 0;
    for (let treatmentOnlyCount = 0; treatmentOnlyCount <= discordant; treatmentOnlyCount += 1) {
      const symmetricTail = Math.min(treatmentOnlyCount, discordant - treatmentOnlyCount);
      const twoSidedPValue = Math.min(1, 2 * lowerTail[symmetricTail]);
      if (twoSidedPValue <= alpha + 1e-12) {
        conditionalRejectionProbability += alternativeDistribution[treatmentOnlyCount];
      }
    }
    power += discordantCounts[discordant] * conditionalRejectionProbability;
  }
  return Object.freeze({
    method: "exact_conditional_mcnemar_two_sided" as const,
    sample_size: input.sample_size,
    alpha,
    risk_difference: input.risk_difference,
    discordance: input.discordance,
    treatment_only_probability: treatmentOnly,
    baseline_only_probability: baselineOnly,
    power,
  });
}

export function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error("Cannot take a percentile of an empty sample");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("Percentile probability must be between zero and one");
  }
  values.forEach((value, index) => assertFinite(value, `values[${index}]`));
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function bootstrapMeans(
  units: readonly number[],
  iterations: number,
  rng: RandomSource
): number[] {
  const samples = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let drawIndex = 0; drawIndex < units.length; drawIndex += 1) {
      sum += units[Math.floor(draw(rng) * units.length)];
      if (!Number.isFinite(sum)) throw new Error("Bootstrap sample exceeds finite numeric range");
    }
    samples[iteration] = sum / units.length;
  }
  return samples;
}

function bootstrapResult(
  differences: readonly number[],
  options: { iterations?: number; confidence_level?: number; seed: Seed },
  samplingUnit: "pair" | "cluster"
): BootstrapDifference {
  const iterations = options.iterations ?? 10_000;
  const confidenceLevel = options.confidence_level ?? 0.95;
  assertIterations(iterations);
  assertProbability(confidenceLevel, "confidence_level");
  if (differences.length === 0) throw new Error("At least one sampling unit is required");
  const samples = bootstrapMeans(differences, iterations, createSeededRng(options.seed));
  const alpha = 1 - confidenceLevel;
  return Object.freeze({
    estimate: mean(differences),
    standard_error: sampleStandardDeviation(samples),
    interval: Object.freeze({
      confidence_level: confidenceLevel,
      lower: percentile(samples, alpha / 2),
      upper: percentile(samples, 1 - alpha / 2),
    }),
    iterations,
    seed: options.seed,
    sampling_unit: samplingUnit,
    units: differences.length,
  });
}

/** Percentile bootstrap of treatment minus baseline, resampling whole pairs. */
export function pairedBootstrapMeanDifference(
  pairs: readonly PairedValue[],
  options: { iterations?: number; confidence_level?: number; seed: Seed }
): BootstrapDifference {
  assertUniquePairIds(pairs);
  const differences = pairs.map((pair) => pair.treatment - pair.baseline);
  differences.forEach((difference) => assertFinite(difference, "paired difference"));
  return bootstrapResult(
    differences,
    options,
    "pair"
  );
}

/**
 * Generalization-unit bootstrap. Pair differences are first averaged inside
 * each scenario/cluster, then whole cluster means are resampled with equal
 * weight so a large scenario cannot dominate the interval.
 */
export function clusteredPairedBootstrapMeanDifference(
  pairs: readonly ClusteredPairedValue[],
  options: { iterations?: number; confidence_level?: number; seed: Seed }
): BootstrapDifference {
  assertUniquePairIds(pairs);
  const clusters = new Map<string, number[]>();
  for (const pair of pairs) {
    if (typeof pair.cluster_id !== "string" || pair.cluster_id.trim().length === 0) {
      throw new Error(`Pair ${pair.pair_id} needs a non-empty cluster_id`);
    }
    const values = clusters.get(pair.cluster_id) ?? [];
    const difference = pair.treatment - pair.baseline;
    assertFinite(difference, `${pair.pair_id} difference`);
    values.push(difference);
    clusters.set(pair.cluster_id, values);
  }
  const clusterMeans = [...clusters.keys()]
    .sort()
    .map((clusterId) => mean(clusters.get(clusterId)!));
  return bootstrapResult(clusterMeans, options, "cluster");
}

export type RandomizationAlternative = "two_sided" | "treatment_greater" | "treatment_less";

export type PairedRandomizationResult = Readonly<{
  observed_mean_difference: number;
  p_value: number;
  alternative: RandomizationAlternative;
  method: "exact" | "monte_carlo";
  permutations: number;
  seed: Seed | null;
}>;

function atLeastAsExtreme(
  candidate: number,
  observed: number,
  alternative: RandomizationAlternative
): boolean {
  const tolerance = 1e-12;
  if (alternative === "treatment_greater") return candidate >= observed - tolerance;
  if (alternative === "treatment_less") return candidate <= observed + tolerance;
  return Math.abs(candidate) >= Math.abs(observed) - tolerance;
}

/** Exact sign-flip test for small samples; seeded Monte Carlo for larger ones. */
export function pairedRandomizationTest(
  pairs: readonly PairedValue[],
  options: {
    alternative?: RandomizationAlternative;
    exact_threshold?: number;
    iterations?: number;
    seed: Seed;
  }
): PairedRandomizationResult {
  assertUniquePairIds(pairs);
  const alternative = options.alternative ?? "two_sided";
  const exactThreshold = options.exact_threshold ?? 16;
  if (!Number.isSafeInteger(exactThreshold) || exactThreshold < 0 || exactThreshold > 24) {
    throw new Error("exact_threshold must be an integer between zero and 24");
  }
  const differences = pairs.map((pair) => pair.treatment - pair.baseline);
  differences.forEach((difference) => assertFinite(difference, "paired difference"));
  const observed = mean(differences);

  if (differences.length <= exactThreshold) {
    const permutations = 2 ** differences.length;
    let extreme = 0;
    for (let mask = 0; mask < permutations; mask += 1) {
      let sum = 0;
      for (let index = 0; index < differences.length; index += 1) {
        sum += (mask & 2 ** index) === 0 ? differences[index] : -differences[index];
      }
      if (atLeastAsExtreme(sum / differences.length, observed, alternative)) extreme += 1;
    }
    return Object.freeze({
      observed_mean_difference: observed,
      p_value: extreme / permutations,
      alternative,
      method: "exact",
      permutations,
      seed: null,
    });
  }

  const iterations = options.iterations ?? 100_000;
  assertIterations(iterations);
  const rng = createSeededRng(options.seed);
  let extreme = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (const difference of differences) sum += draw(rng) < 0.5 ? difference : -difference;
    if (atLeastAsExtreme(sum / differences.length, observed, alternative)) extreme += 1;
  }
  return Object.freeze({
    observed_mean_difference: observed,
    p_value: (extreme + 1) / (iterations + 1),
    alternative,
    method: "monte_carlo",
    permutations: iterations,
    seed: options.seed,
  });
}
