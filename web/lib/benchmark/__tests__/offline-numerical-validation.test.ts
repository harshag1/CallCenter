import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import validation from "../../../../benchmarks/voice-long-horizon/OFFLINE_NUMERICAL_VALIDATION.json";
import { runMissionRuntimeSensitivityBenchmark } from "../mission-runtime-sensitivity";
import { exactConditionalMcNemarPower } from "../statistics";
import { runToolWorldCausalContainment } from "../tool-world-causal-containment";

const repositoryRoot = resolve(process.cwd(), "..");

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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
});
