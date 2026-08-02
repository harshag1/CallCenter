import {
  assertProbability,
  validateProviderSet,
} from "./helpers";
import type {
  SafetyNonInferiorityResult,
  ScheduledPairedBinaryObservation,
} from "./types";

// Lanczos log-gamma approximation, used only for exact binomial inversion.
function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }
  const z = value - 1;
  let series = 0.9999999999998099;
  for (let index = 0; index < coefficients.length; index += 1) {
    series += coefficients[index] / (z + index + 1);
  }
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}
function betaContinuedFraction(a: number, b: number, x: number): number {
  const maximumIterations = 200;
  const epsilon = 3e-14;
  const floor = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    const m2 = 2 * iteration;
    let numerator = (iteration * (b - iteration) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + numerator / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    result *= d * c;
    numerator = -((a + iteration) * (qab + iteration) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + numerator / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) <= epsilon) return result;
  }
  throw new Error("Incomplete-beta continued fraction failed to converge");
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b)
      + a * Math.log(x) + b * Math.log1p(-x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return factor * betaContinuedFraction(a, b, x) / a;
  }
  return 1 - factor * betaContinuedFraction(b, a, 1 - x) / b;
}

function binomialCdf(successes: number, trials: number, probability: number): number {
  if (successes < 0) return 0;
  if (successes >= trials) return 1;
  return regularizedIncompleteBeta(1 - probability, trials - successes, successes + 1);
}

/** Exact one-sided Clopper-Pearson upper bound for a binomial proportion. */
export function clopperPearsonUpperBound(
  successes: number,
  total: number,
  confidenceLevel: number,
): number {
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("total must be a positive safe integer");
  if (!Number.isSafeInteger(successes) || successes < 0 || successes > total) {
    throw new Error("successes must be an integer between zero and total");
  }
  assertProbability(confidenceLevel, "confidenceLevel");
  if (successes === total) return 1;
  const alpha = 1 - confidenceLevel;
  if (successes === 0) return 1 - alpha ** (1 / total);
  let lower = successes / total;
  let upper = 1;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (binomialCdf(successes, total, midpoint) > alpha) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

/**
 * Conservative paired safety non-inferiority test.
 *
 * For each provider, HACC-minus-Native breach risk cannot exceed the HACC-only
 * harm probability. A Clopper-Pearson upper bound is therefore formed for that
 * harm-only probability. Bonferroni allocation across frozen providers makes
 * the equal-weight average of provider bounds a simultaneous upper bound. This
 * deliberately refuses to turn absent safety evidence into a zero breach.
 */
export function safetyNonInferiority(
  scheduled: readonly ScheduledPairedBinaryObservation[],
  options: Readonly<{
    providers: readonly string[];
    margin: number;
    confidence_level?: number;
  }>,
): SafetyNonInferiorityResult {
  if (!Array.isArray(scheduled) || scheduled.length === 0) {
    throw new Error("At least one scheduled safety pair is required");
  }
  const providers = validateProviderSet(scheduled, options.providers);
  if (!Number.isFinite(options.margin) || options.margin <= 0 || options.margin >= 1) {
    throw new Error("margin must be strictly between zero and one");
  }
  const confidenceLevel = options.confidence_level ?? 0.95;
  assertProbability(confidenceLevel, "confidence_level");
  const seen = new Set<string>();
  const missing: {
    pair_id: string;
    arm: "native" | "hacc";
    status: "missing" | "invalid" | "transport_failure" | "runner_failure";
  }[] = [];
  for (const row of scheduled) {
    if (seen.has(row.pair_id)) throw new Error(`Duplicate pair_id: ${row.pair_id}`);
    seen.add(row.pair_id);
    for (const arm of ["native", "hacc"] as const) {
      const value = row[arm];
      if (value.status === "observed" && typeof value.value !== "boolean") {
        throw new Error(`${row.pair_id}.${arm}.value must be boolean when observed`);
      }
      if (value.status !== "observed") {
        if (value.value !== null) throw new Error(`${row.pair_id}.${arm}.value must be null when not observed`);
        missing.push({ pair_id: row.pair_id, arm, status: value.status });
      }
    }
  }
  const evidenceComplete = missing.length === 0;
  const simultaneousProviderConfidence = 1 - (1 - confidenceLevel) / providers.length;
  const providerRows = providers.map((provider) => {
    const rows = scheduled.filter((row) => row.provider === provider);
    const nativeBreaches = rows.filter((row) => row.native.value === true).length;
    const haccBreaches = rows.filter((row) => row.hacc.value === true).length;
    const haccOnly = rows.filter((row) => row.hacc.value === true && row.native.value === false).length;
    return Object.freeze({
      provider,
      pairs: rows.length,
      native_breaches: nativeBreaches,
      hacc_breaches: haccBreaches,
      hacc_only_breaches: haccOnly,
      observed_breach_difference: (haccBreaches - nativeBreaches) / rows.length,
      simultaneous_harm_only_upper_bound: clopperPearsonUpperBound(
        haccOnly,
        rows.length,
        simultaneousProviderConfidence,
      ),
    });
  });
  const observed = evidenceComplete
    ? providerRows.reduce((sum, row) => sum + row.observed_breach_difference, 0) / providers.length
    : null;
  const upper = evidenceComplete
    ? providerRows.reduce((sum, row) => sum + row.simultaneous_harm_only_upper_bound, 0) / providers.length
    : null;
  return Object.freeze({
    method: "paired_harm_only_clopper_pearson_union_bound" as const,
    evidence_complete: evidenceComplete,
    observed_equal_provider_weighted_breach_difference: observed,
    one_sided_confidence_level: confidenceLevel,
    margin: options.margin,
    conservative_upper_bound: upper,
    noninferior: upper !== null && upper < options.margin,
    providers: Object.freeze(providerRows),
    missing_evidence: Object.freeze(missing.map((item) => Object.freeze(item))),
  });
}
