import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import validation from "../../../../benchmarks/voice-long-horizon/OFFLINE_NUMERICAL_VALIDATION.json";
import { runMissionRuntimeSensitivityBenchmark } from "../mission-runtime-sensitivity";
import { exactClopperPearsonInterval } from "../scoring";
import { exactConditionalMcNemarPower, wilsonScoreInterval } from "../statistics";
import { runToolWorldCausalContainment } from "../tool-world-causal-containment";

const repositoryRoot = resolve(process.cwd(), "..");

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function binomialProbabilities(trials: number, probability: number): readonly number[] {
  if (probability === 0) return [1, ...Array.from({ length: trials }, () => 0)];
  if (probability === 1) return [...Array.from({ length: trials }, () => 0), 1];
  if (probability > 0.5) {
    return [...binomialProbabilities(trials, 1 - probability)].reverse();
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
  return probabilities.map((value) => value / total);
}

function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) return value;
  if (Object.is(value, -0) || value === 0) return Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  let high = view.getUint32(0, false);
  let low = view.getUint32(4, false);
  if (value > 0) {
    low = (low + 1) >>> 0;
    if (low === 0) high = (high + 1) >>> 0;
  } else if (low === 0) {
    high = (high - 1) >>> 0;
    low = 0xffff_ffff;
  } else {
    low = (low - 1) >>> 0;
  }
  view.setUint32(0, high, false);
  view.setUint32(4, low, false);
  return view.getFloat64(0, false);
}

function nextDown(value: number): number {
  return -nextUp(-value);
}

function clopperPearsonCoverageAtEveryJump(
  trials: number,
  confidence: number
): Readonly<{
  intervals: readonly Readonly<{ lower: number; upper: number }>[];
  minimumCoverage: number;
}> {
  const intervals = Array.from(
    { length: trials + 1 },
    (_, successes) => exactClopperPearsonInterval(successes, trials, confidence)
  );
  const candidates = new Set<number>([0, 1]);
  for (const interval of intervals) {
    for (const endpoint of [interval.lower, interval.upper]) {
      candidates.add(endpoint);
      candidates.add(nextDown(endpoint));
      candidates.add(nextUp(endpoint));
    }
  }
  let minimumCoverage = 1;
  for (const probability of candidates) {
    if (probability < 0 || probability > 1) continue;
    const probabilities = binomialProbabilities(trials, probability);
    const coverage = probabilities.reduce((sum, mass, successes) => {
      const interval = intervals[successes];
      return sum + (interval.lower <= probability && probability <= interval.upper ? mass : 0);
    }, 0);
    minimumCoverage = Math.min(minimumCoverage, coverage);
  }
  return { intervals, minimumCoverage };
}

describe("public offline numerical validation artifact", () => {
  it("recomputes the 1,000-seed mission-runtime numbers and exact output hash", () => {
    const expected = validation.mission_runtime;
    const report = runMissionRuntimeSensitivityBenchmark({
      trials: expected.trials,
      seed_start: expected.seed_start,
    });
    expect(report.strict_pass).toMatchObject({
      raw_count: expected.raw_strict_pass_count,
      raw_rate: expected.raw_strict_pass_rate,
      mission_count: expected.mission_strict_pass_count,
      mission_rate: expected.mission_strict_pass_rate,
      absolute_difference: expected.absolute_difference,
    });
    expect(report.raw_effects.unsafe_effect_count).toBe(expected.raw_unsafe_effect_count);
    expect(report.mission).toMatchObject({
      blocked_attempt_count: expected.mission_blocked_attempt_count,
      failed_runtime_count: expected.mission_runtime_failure_count,
      open_obligation_count: expected.mission_terminal_open_obligation_count,
    });
    expect(report.result_hash).toBe(expected.semantic_result_sha256);
    expect(sha256(`${JSON.stringify(report, null, 2)}\n`)).toBe(expected.pretty_json_sha256);
    for (const [path, expectedHash] of Object.entries(expected.source_files)) {
      expect(sha256(readFileSync(resolve(repositoryRoot, path))), path).toBe(expectedHash);
    }
  }, 20_000);

  it("recomputes the 160 ToolWorld schedules and verifies checked artifact bytes", () => {
    const expected = validation.tool_world_causal_containment;
    const report = runToolWorldCausalContainment({
      seed_start: expected.seed_start,
      seeds_per_case: expected.seeds_per_case,
    });
    expect(report).toMatchObject({
      trial_count: expected.trial_count,
      result_hash: expected.semantic_result_sha256,
      trial_set_hash: expected.trial_set_sha256,
      aggregate: {
        attempted: expected.trial_count,
        naive_comparator_unsafe_accept_count: expected.naive_comparator_unsafe_accept_count,
        harness_contained_count: expected.harness_contained_count,
        harness_corrupt_state_rejection_count: expected.harness_corrupt_state_rejection_count,
        harness_idempotent_suppression_count: expected.harness_idempotent_suppression_count,
        schedule_set_hash: expected.schedule_set_sha256,
      },
    });
    expect(sha256(readFileSync(resolve(
      repositoryRoot,
      "benchmarks/voice-long-horizon/scenarios/tool-world-causal-containment.v1.json"
    )))).toBe(expected.artifact_file_sha256);
    expect(sha256(readFileSync(resolve(
      repositoryRoot,
      "benchmarks/voice-long-horizon/scenarios/tool-world-causal-containment.v1.provenance.json"
    )))).toBe(expected.provenance_file_sha256);
  });

  it("recomputes both planning-only exact McNemar powers from the executable method", () => {
    const expected = validation.paired_power_candidate;
    for (const candidate of expected.cases) {
      const result = exactConditionalMcNemarPower({
        sample_size: expected.sample_size,
        risk_difference: expected.risk_difference,
        discordance: candidate.discordance,
        alpha: expected.alpha,
      });
      expect(result.method).toBe(expected.method);
      expect(result.treatment_only_probability).toBeCloseTo(
        candidate.treatment_only_probability,
        14
      );
      expect(result.baseline_only_probability).toBeCloseTo(
        candidate.baseline_only_probability,
        14
      );
      expect(result.power).toBeCloseTo(candidate.power, 11);
    }
    for (const [path, expectedHash] of Object.entries(expected.source_files)) {
      expect(sha256(readFileSync(resolve(repositoryRoot, path))), path).toBe(expectedHash);
    }
  });

  it("falsifies the pre-fix Wilson curve as a uniform simultaneous confidence band", () => {
    const expected = validation.semantic_horizon_interval_falsification;
    for (const candidate of expected.cases) {
      const firstPositiveLower = wilsonScoreInterval(
        1,
        expected.sample_size,
        candidate.pointwise_confidence
      ).lower;
      const coverageLeftLimit = (1 - firstPositiveLower) ** expected.sample_size;
      expect(firstPositiveLower).toBeCloseTo(candidate.worst_probability_left_limit, 8);
      expect(coverageLeftLimit).toBeCloseTo(candidate.worst_one_sided_coverage, 8);

      let thresholdCount = expected.sample_size + 1;
      for (let successes = 0; successes <= expected.sample_size; successes += 1) {
        if (wilsonScoreInterval(
          successes,
          expected.sample_size,
          candidate.pointwise_confidence
        ).lower >= 0.9) {
          thresholdCount = successes;
          break;
        }
      }
      const probabilities = binomialProbabilities(expected.sample_size, 0.9);
      const falsePositiveProbability = probabilities
        .slice(thresholdCount)
        .reduce((sum, value) => sum + value, 0);
      expect(candidate.opportunities * falsePositiveProbability).toBeCloseTo(
        candidate.rh_0_90_false_positive_union_bound,
        8
      );
      expect(coverageLeftLimit).toBeLessThan(0.95);
    }
    expect(expected.verdict).toBe("invalid_uniform_simultaneous_coverage");
  });

  it("verifies exact Clopper-Pearson coverage at every registered 107-unit jump", () => {
    const expected = validation.clopper_pearson_replacement_verification;
    expect(() => exactClopperPearsonInterval(0, 0, 0.95)).toThrow(
      "total must be a positive safe integer"
    );
    for (const candidate of expected.cases) {
      const { intervals, minimumCoverage } = clopperPearsonCoverageAtEveryJump(
        expected.sample_size,
        candidate.pointwise_confidence
      );
      for (let index = 0; index < intervals.length; index += 1) {
        expect(intervals[index].lower).toBeLessThanOrEqual(intervals[index].upper);
        if (index > 0) {
          expect(intervals[index].lower).toBeGreaterThanOrEqual(intervals[index - 1].lower);
          expect(intervals[index].upper).toBeGreaterThanOrEqual(intervals[index - 1].upper);
        }
      }
      expect(minimumCoverage).toBeCloseTo(candidate.minimum_exact_coverage, 9);
      expect(minimumCoverage).toBeGreaterThanOrEqual(candidate.pointwise_confidence - 1e-12);
    }
    expect(expected.n_1_minimum_coverages).toHaveLength(4);
    expected.n_1_minimum_coverages.forEach((minimumCoverage, index) => {
      const candidate = expected.cases[index];
      const result = clopperPearsonCoverageAtEveryJump(1, candidate.pointwise_confidence);
      expect(result.minimumCoverage).toBeCloseTo(minimumCoverage, 12);
      expect(result.minimumCoverage).toBeGreaterThanOrEqual(
        candidate.pointwise_confidence - 1e-12
      );
    });
    expect(expected.verdict).toBe("verified_for_checked_registered_sizes");
    expect(expected.adjacent_float_bound_mutations_rejected).toBe(true);
    for (const [path, expectedHash] of Object.entries(expected.tested_source_files)) {
      expect(sha256(readFileSync(resolve(repositoryRoot, path))), path).toBe(expectedHash);
    }
  });
});
