import { canonicalJson, sha256Hex } from "./artifacts";
import { createLc4PowerPlanArtifact } from "./lc4-power-plan";
import {
  assertLc4ResultReport,
  type Lc4AnalysisRow,
  type Lc4ResultReport,
} from "./lc4-result-report";
import { createSeededRng } from "./statistics";

export const LC4_CONSTRAINED_INFERENCE_ARTIFACT_ID = "HACC-LC4-CONSTRAINED-INFERENCE-v1" as const;
export const LC4_CLUSTER_BOOTSTRAP_SEED = "hacc-lc4-template-cluster-bootstrap-20260721-v1" as const;
const ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-constrained-inference/v1\n";
const ALLOCATION_SUPPORT_DOMAIN = "harshas-amazing-call-center/lc4-constrained-support/v1\n";
const SYNTHETIC_CHECK_DOMAIN = "harshas-amazing-call-center/lc4-inference-synthetic-check/v1\n";
const PROVIDERS = Object.freeze(["openai", "gemini", "xai"] as const);

export type Lc4Provider = (typeof PROVIDERS)[number];

type Lc4PairedBinaryObservation = Lc4AnalysisRow;

function combinationsOfTwo(values: readonly number[]): readonly (readonly [number, number])[] {
  const result: [number, number][] = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      result.push([values[left], values[right]]);
    }
  }
  return Object.freeze(result.map((pair) => Object.freeze(pair)));
}

/**
 * Enumerate the frozen LC4 assignment mechanism for one provider.
 *
 * Every assignment has 2/2 arm-order balance within each family, 3/3 within
 * each structural variant, and 4/4 within each TTS slot. Providers draw from
 * the same support independently, making the joint support the Cartesian cube.
 */
export function enumerateLc4ProviderAssignmentSupport() {
  const plan = createLc4PowerPlanArtifact();
  const source = plan.randomization.assignments.filter((row) => row.provider === PROVIDERS[0]);
  const templates = [...source].sort((left, right) => left.template_id.localeCompare(right.template_id));
  const templateIds = templates.map((row) => row.template_id);
  const indexByTemplate = new Map(templateIds.map((id, index) => [id, index]));
  const familyGroups = plan.schedule.families.map((family) =>
    templates.filter((row) => row.family === family).map((row) => indexByTemplate.get(row.template_id)!)
  );
  const support: string[] = [];
  const selected = new Set<number>();

  function visitFamily(familyIndex: number): void {
    if (familyIndex === familyGroups.length) {
      const selectedRows = templates.filter((_, index) => selected.has(index));
      const variantCounts = new Map<string, number>();
      const voiceCounts = new Map<string, number>();
      for (const row of selectedRows) {
        variantCounts.set(row.structural_variant, (variantCounts.get(row.structural_variant) ?? 0) + 1);
        voiceCounts.set(row.tts_voice_slot, (voiceCounts.get(row.tts_voice_slot) ?? 0) + 1);
      }
      if (plan.schedule.structural_variants.some((variant) => variantCounts.get(variant) !== 3)) return;
      if (plan.schedule.tts_voice_slots.some((voice) => voiceCounts.get(voice) !== 4)) return;
      support.push(templates.map((_, index) => selected.has(index) ? "1" : "0").join(""));
      return;
    }

    for (const [left, right] of combinationsOfTwo(familyGroups[familyIndex])) {
      selected.add(left);
      selected.add(right);
      visitFamily(familyIndex + 1);
      selected.delete(left);
      selected.delete(right);
    }
  }

  visitFamily(0);
  support.sort();
  if (new Set(support).size !== support.length) throw new Error("LC4 assignment support contains duplicates");
  return Object.freeze({
    template_ids: Object.freeze(templateIds),
    native_first_bitstrings: Object.freeze(support),
    support_size: support.length,
    support_sha256: sha256Hex(`${ALLOCATION_SUPPORT_DOMAIN}${canonicalJson({ template_ids: templateIds, native_first_bitstrings: support })}`),
  });
}

function validateObservations(observations: readonly Lc4PairedBinaryObservation[]): ReadonlyMap<string, Lc4PairedBinaryObservation> {
  const plan = createLc4PowerPlanArtifact();
  const expected = new Map<string, (typeof plan.randomization.assignments)[number]>(
    plan.randomization.assignments.map((row) => [row.pair_id, row])
  );
  if (observations.length !== expected.size) {
    throw new Error(`LC4 analysis requires exactly ${expected.size} complete provider-template pairs`);
  }
  const observed = new Map<string, Lc4PairedBinaryObservation>();
  for (const row of observations) {
    if (typeof row.native_success !== "boolean" || typeof row.hacc_success !== "boolean") {
      throw new Error(`${row.pair_id} success values must be boolean`);
    }
    const assignment = expected.get(row.pair_id);
    if (!assignment) throw new Error(`Unknown LC4 pair_id: ${row.pair_id}`);
    if (row.template_id !== assignment.template_id || row.provider !== assignment.provider) {
      throw new Error(`${row.pair_id} does not match the frozen template and provider`);
    }
    if (observed.has(row.pair_id)) throw new Error(`Duplicate LC4 pair_id: ${row.pair_id}`);
    observed.set(row.pair_id, row);
  }
  for (const pairId of expected.keys()) {
    if (!observed.has(pairId)) throw new Error(`Missing LC4 pair_id: ${pairId}`);
  }
  return observed;
}

function pairDifference(row: Lc4PairedBinaryObservation): number {
  return Number(row.hacc_success) - Number(row.native_success);
}

/** Equal-weight average of the three provider-specific paired risk differences. */
function providerStratifiedEqualWeightPairedStatistic(
  observations: readonly Lc4PairedBinaryObservation[]
) {
  const observed = validateObservations(observations);
  const plan = createLc4PowerPlanArtifact();
  const providerRows = PROVIDERS.map((provider) => {
    const rows = plan.randomization.assignments.filter((assignment) => assignment.provider === provider);
    const effect = rows.reduce((sum, assignment) => sum + pairDifference(observed.get(assignment.pair_id)!), 0) / rows.length;
    return Object.freeze({ provider, pairs: rows.length, paired_risk_difference: effect });
  });
  return Object.freeze({
    statistic: "equal_provider_weight_paired_risk_difference" as const,
    provider_weights: Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [provider, 1 / PROVIDERS.length]))),
    provider_rows: Object.freeze(providerRows),
    estimate: providerRows.reduce((sum, row) => sum + row.paired_risk_difference, 0) / PROVIDERS.length,
  });
}

function convolveIntegerFrequencies(
  left: ReadonlyMap<number, bigint>,
  right: ReadonlyMap<number, bigint>
): Map<number, bigint> {
  const result = new Map<number, bigint>();
  for (const [leftValue, leftCount] of left) {
    for (const [rightValue, rightCount] of right) {
      const value = leftValue + rightValue;
      result.set(value, (result.get(value) ?? BigInt(0)) + leftCount * rightCount);
    }
  }
  return result;
}

/**
 * Exact two-sided Fisher randomization test for the frozen constrained design.
 * The sharp-null distribution is evaluated over the complete 504^3 support,
 * using exact integer frequency convolution rather than random draws.
 */
function exactLc4ConstrainedRandomizationTest(
  observations: readonly Lc4PairedBinaryObservation[]
) {
  const observed = validateObservations(observations);
  const plan = createLc4PowerPlanArtifact();
  const support = enumerateLc4ProviderAssignmentSupport();
  const templateIndex = new Map(support.template_ids.map((id, index) => [id, index]));
  const providerDistributions: Readonly<{ provider: Lc4Provider; frequencies: Map<number, bigint> }>[] = PROVIDERS.map((provider) => {
    const assignments = plan.randomization.assignments
      .filter((row) => row.provider === provider)
      .sort((left, right) => left.template_id.localeCompare(right.template_id));
    const differences = assignments.map((assignment) => pairDifference(observed.get(assignment.pair_id)!));
    const observedNativeFirst = assignments.map((assignment) => assignment.arm_order[0] === "native");
    const frequencies = new Map<number, bigint>();
    for (const bitstring of support.native_first_bitstrings) {
      let sum = 0;
      for (const assignment of assignments) {
        const index = templateIndex.get(assignment.template_id)!;
        const candidateNativeFirst = bitstring[index] === "1";
        sum += differences[index] * (candidateNativeFirst === observedNativeFirst[index] ? 1 : -1);
      }
      frequencies.set(sum, (frequencies.get(sum) ?? BigInt(0)) + BigInt(1));
    }
    return Object.freeze({ provider, frequencies });
  });
  let joint = new Map<number, bigint>([[0, BigInt(1)]]);
  for (const distribution of providerDistributions) {
    joint = convolveIntegerFrequencies(joint, distribution.frequencies);
  }
  const observedSum = [...observed.values()].reduce((sum, row) => sum + pairDifference(row), 0);
  let extreme = BigInt(0);
  let total = BigInt(0);
  for (const [sum, count] of joint) {
    total += count;
    if (Math.abs(sum) >= Math.abs(observedSum)) extreme += count;
  }
  const statistic = providerStratifiedEqualWeightPairedStatistic(observations);
  return Object.freeze({
    method: "exact_provider_stratified_constrained_paired_randomization_two_sided" as const,
    null_hypothesis: "sharp null of no HACC effect for every provider-template pair" as const,
    statistic: statistic.statistic,
    estimate: statistic.estimate,
    provider_rows: statistic.provider_rows,
    observed_integer_sum: observedSum,
    provider_support_size: support.support_size,
    joint_support_size: total.toString(),
    extreme_assignments: extreme.toString(),
    exact_p_value: Number(extreme) / Number(total),
    support_sha256: support.support_sha256,
  });
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) throw new Error("Cannot take a quantile of an empty sample");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("quantile probability must be between zero and one");
  }
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Paired template-cluster percentile bootstrap. A draw resamples one of the 24
 * templates and carries all three provider pair effects with it. The DKW bound
 * quantifies Monte Carlo CDF error only; it is not a coverage guarantee.
 */
function lc4TemplateClusterBootstrapInterval(
  observations: readonly Lc4PairedBinaryObservation[],
  options: Readonly<{
    iterations?: number;
    confidence_level?: number;
    monte_carlo_confidence?: number;
    seed?: string;
  }> = {}
) {
  const observed = validateObservations(observations);
  const plan = createLc4PowerPlanArtifact();
  const iterations = options.iterations ?? 100_000;
  const confidenceLevel = options.confidence_level ?? 0.95;
  const monteCarloConfidence = options.monte_carlo_confidence ?? 0.999;
  const seed = options.seed ?? LC4_CLUSTER_BOOTSTRAP_SEED;
  if (!Number.isSafeInteger(iterations) || iterations < 1_000) throw new Error("iterations must be at least 1,000");
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) throw new Error("confidence_level must be between zero and one");
  if (!(monteCarloConfidence > 0 && monteCarloConfidence < 1)) throw new Error("monte_carlo_confidence must be between zero and one");

  const templateEffects = plan.randomization.assignments
    .filter((row, index, values) => values.findIndex((candidate) => candidate.template_id === row.template_id) === index)
    .sort((left, right) => left.template_id.localeCompare(right.template_id))
    .map((template) => {
      const rows = plan.randomization.assignments.filter((assignment) => assignment.template_id === template.template_id);
      return rows.reduce((sum, assignment) => sum + pairDifference(observed.get(assignment.pair_id)!), 0) / rows.length;
    });
  const estimate = templateEffects.reduce((sum, value) => sum + value, 0) / templateEffects.length;
  const rng = createSeededRng(seed);
  const draws = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let sample = 0; sample < templateEffects.length; sample += 1) {
      sum += templateEffects[Math.floor(rng() * templateEffects.length)];
    }
    draws[iteration] = sum / templateEffects.length;
  }
  draws.sort((left, right) => left - right);
  const tail = (1 - confidenceLevel) / 2;
  const dkwEpsilon = Math.sqrt(Math.log(2 / (1 - monteCarloConfidence)) / (2 * iterations));
  const lower = quantile(draws, tail);
  const upper = quantile(draws, 1 - tail);
  return Object.freeze({
    method: "paired_template_cluster_percentile_bootstrap" as const,
    estimate,
    confidence_level: confidenceLevel,
    interval: Object.freeze({ lower, upper }),
    clusters: templateEffects.length,
    providers_per_cluster: PROVIDERS.length,
    iterations,
    seed,
    monte_carlo_error: Object.freeze({
      method: "Dvoretzky-Kiefer-Wolfowitz uniform empirical CDF bound" as const,
      confidence: monteCarloConfidence,
      cdf_error_bound: dkwEpsilon,
      lower_endpoint_quantile_range: Object.freeze({
        from_probability: Math.max(0, tail - dkwEpsilon),
        to_probability: Math.min(1, tail + dkwEpsilon),
        from_value: quantile(draws, Math.max(0, tail - dkwEpsilon)),
        to_value: quantile(draws, Math.min(1, tail + dkwEpsilon)),
      }),
      upper_endpoint_quantile_range: Object.freeze({
        from_probability: Math.max(0, 1 - tail - dkwEpsilon),
        to_probability: Math.min(1, 1 - tail + dkwEpsilon),
        from_value: quantile(draws, Math.max(0, 1 - tail - dkwEpsilon)),
        to_value: quantile(draws, Math.min(1, 1 - tail + dkwEpsilon)),
      }),
      scope: "bounds simulation CDF error only; does not bound statistical interval coverage error" as const,
    }),
  });
}

/**
 * The sole production inference entry point. Outcomes are accepted only from a
 * self-consistent LC4 report whose complete root matches the independently
 * supplied expected root; detached or caller-constructed boolean rows have no
 * exported analysis path.
 */
export function analyzeVerifiedLc4ResultReport(
  report: Lc4ResultReport,
  expectedResultSha256: string,
  options: Readonly<{
    bootstrapIterations?: number;
    bootstrapSeed?: string;
  }> = {},
) {
  if (!/^[a-f0-9]{64}$/u.test(expectedResultSha256)) {
    throw new Error("expected LC4 result root must be a lowercase SHA-256 digest");
  }
  if (report.resultSha256 !== expectedResultSha256) {
    throw new Error("LC4 inference report root differs from the expected result root");
  }
  assertLc4ResultReport(report);
  const exactTest = exactLc4ConstrainedRandomizationTest(report.analysisRows);
  const templateClusterInterval = lc4TemplateClusterBootstrapInterval(report.analysisRows, {
    iterations: options.bootstrapIterations,
    seed: options.bootstrapSeed,
  });
  return Object.freeze({
    protocol_id: "HACC-LC4-v1" as const,
    result_report_sha256: report.resultSha256,
    analysis_rows_sha256: report.analysisRowsSha256,
    exact_test: exactTest,
    template_cluster_interval: templateClusterInterval,
  });
}

function syntheticMechanicsCheckObservations(): readonly Lc4PairedBinaryObservation[] {
  const assignments = [...createLc4PowerPlanArtifact().randomization.assignments]
    .sort((left, right) => left.pair_id.localeCompare(right.pair_id));
  return Object.freeze(assignments.map((assignment, index) => {
    const code = (index * 17 + Number(assignment.template_id.slice(-2)) * 7) % 20;
    return Object.freeze({
      pair_id: assignment.pair_id,
      template_id: assignment.template_id,
      provider: assignment.provider,
      native_success: code === 6 || (code >= 7 && code < 12),
      hacc_success: code < 6 || (code >= 7 && code < 12),
    });
  }));
}

export function createLc4ConstrainedInferenceArtifact() {
  const plan = createLc4PowerPlanArtifact();
  const support = enumerateLc4ProviderAssignmentSupport();
  const synthetic = syntheticMechanicsCheckObservations();
  const exactCheck = exactLc4ConstrainedRandomizationTest(synthetic);
  const clusterCheck = lc4TemplateClusterBootstrapInterval(synthetic);
  const body = Object.freeze({
    schema_version: 1 as const,
    artifact_id: LC4_CONSTRAINED_INFERENCE_ARTIFACT_ID,
    protocol_id: "HACC-LC4-v1" as const,
    status: "outcome-blind executable inference artifact; not a preregistration or run authorization" as const,
    created_at: "2026-07-21T00:00:00.000Z" as const,
    binds: Object.freeze({
      power_plan_artifact_id: plan.artifact_id,
      power_plan_artifact_sha256: plan.artifact_sha256,
      allocation_sha256: plan.randomization.allocation_sha256,
    }),
    constrained_randomization: Object.freeze({
      implemented: true,
      assignment_indicator: "1 means Native-first; 0 means HACC-first" as const,
      per_provider_constraints: Object.freeze([
        "exactly 2 Native-first templates in each 4-template family",
        "exactly 3 Native-first templates in each 6-template structural variant",
        "exactly 4 Native-first templates in each 8-template TTS slot",
      ]),
      provider_assignment_mechanism: "independent uniform draw from the complete constrained support within each provider" as const,
      provider_support_size: support.support_size,
      joint_support_size: (BigInt(support.support_size) ** BigInt(PROVIDERS.length)).toString(),
      support_sha256: support.support_sha256,
      test: "exact two-sided Fisher randomization test of the sharp null using provider-frequency convolution" as const,
      statistic: "equal-weight mean of three provider-specific paired risk differences" as const,
    }),
    template_cluster_interval: Object.freeze({
      implemented: true,
      method: "paired template-cluster percentile bootstrap; each draw preserves all three provider pairs" as const,
      clusters: 24,
      providers_per_cluster: 3,
      iterations: 100_000,
      confidence_level: 0.95,
      seed: LC4_CLUSTER_BOOTSTRAP_SEED,
      monte_carlo_confidence: 0.999,
      monte_carlo_cdf_error_bound: clusterCheck.monte_carlo_error.cdf_error_bound,
      error_bound_scope: clusterCheck.monte_carlo_error.scope,
    }),
    synthetic_mechanics_check: Object.freeze({
      evidentiary_value: "none; deterministic synthetic values exercise the frozen implementation and are not provider outcomes" as const,
      observation_sha256: sha256Hex(`${SYNTHETIC_CHECK_DOMAIN}${canonicalJson(synthetic)}`),
      exact_test: exactCheck,
      cluster_interval: clusterCheck,
    }),
    claim_boundaries: Object.freeze([
      "The exact p-value is valid for the sharp null under the frozen constrained arm-order mechanism; it is not a power calculation or a test of a superiority margin.",
      "The cluster percentile interval has 24 independent template clusters; the DKW bound covers only Monte Carlo CDF error and cannot guarantee finite-sample coverage.",
      "Missingness, safety conjunctions, multiplicity, provider drift, and endpoint construction still require final preregistration rules.",
      "The synthetic mechanics check has no efficacy or provider-comparison evidentiary value.",
      "This artifact authorizes zero provider calls and zero efficacy claims.",
    ]),
  });
  return Object.freeze({
    ...body,
    artifact_sha256: sha256Hex(`${ARTIFACT_DOMAIN}${canonicalJson(body)}`),
  });
}

export type Lc4ConstrainedInferenceArtifact = ReturnType<typeof createLc4ConstrainedInferenceArtifact>;
