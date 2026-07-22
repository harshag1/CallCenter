import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  createLc4ConstrainedInferenceArtifact,
  enumerateLc4ProviderAssignmentSupport,
  exactLc4ConstrainedRandomizationTest,
  lc4TemplateClusterBootstrapInterval,
  type Lc4PairedBinaryObservation,
  providerStratifiedEqualWeightPairedStatistic,
} from "../lc4-constrained-inference";
import { createLc4PowerPlanArtifact } from "../lc4-power-plan";

function observations(
  outcome: (index: number, provider: string) => readonly [native: boolean, hacc: boolean]
): readonly Lc4PairedBinaryObservation[] {
  return Object.freeze([...createLc4PowerPlanArtifact().randomization.assignments]
    .sort((left, right) => left.pair_id.localeCompare(right.pair_id))
    .map((assignment, index) => {
      const [nativeSuccess, haccSuccess] = outcome(index, assignment.provider);
      return Object.freeze({
        pair_id: assignment.pair_id,
        template_id: assignment.template_id,
        provider: assignment.provider,
        native_success: nativeSuccess,
        hacc_success: haccSuccess,
      });
    }));
}

describe("LC4 executable constrained inference", () => {
  it("enumerates the complete balanced support and contains every frozen provider allocation", () => {
    const support = enumerateLc4ProviderAssignmentSupport();
    const plan = createLc4PowerPlanArtifact();
    expect(support.support_size).toBe(504);
    expect(support.support_sha256).toBe("f9c1c1002953b054a61d730bf43eded184299f3cb40a0bd120a09329f2d7db3b");
    expect(support.native_first_bitstrings).toEqual([...support.native_first_bitstrings].sort());
    for (const provider of plan.schedule.providers) {
      const bitstring = [...plan.randomization.assignments]
        .filter((row) => row.provider === provider)
        .sort((left, right) => left.template_id.localeCompare(right.template_id))
        .map((row) => row.arm_order[0] === "native" ? "1" : "0")
        .join("");
      expect(support.native_first_bitstrings).toContain(bitstring);
    }
  });

  it("computes provider-equal paired effects and the exact 504-cubed permutation p-value", () => {
    const rows = observations((index) => {
      if (index < 24) return [false, true];
      if (index < 48) return [true, true];
      return [false, false];
    });
    const statistic = providerStratifiedEqualWeightPairedStatistic(rows);
    expect(statistic.provider_rows.map((row) => row.pairs)).toEqual([24, 24, 24]);
    expect(statistic.estimate).toBeCloseTo(1 / 3, 15);
    const test = exactLc4ConstrainedRandomizationTest(rows);
    expect(test.joint_support_size).toBe("128024064");
    expect(test.observed_integer_sum).toBe(24);
    expect(test.estimate).toBeCloseTo(1 / 3, 15);
    expect(test.extreme_assignments).toBe("10404");
    expect(test.exact_p_value).toBeCloseTo(0.00008126597199726451, 18);
    expect(BigInt(test.extreme_assignments)).toBeLessThanOrEqual(BigInt(test.joint_support_size));
  });

  it("returns p=1 for an all-tie sharp-null sample and rejects malformed panels", () => {
    const ties = observations(() => [true, true]);
    expect(exactLc4ConstrainedRandomizationTest(ties).exact_p_value).toBe(1);
    expect(() => exactLc4ConstrainedRandomizationTest(ties.slice(1))).toThrow(/exactly 72/);
    expect(() => exactLc4ConstrainedRandomizationTest([
      ...ties.slice(0, -1),
      { ...ties[ties.length - 1], template_id: "wrong-template" },
    ])).toThrow(/does not match/);
  });

  it("resamples 24 whole template clusters deterministically with a frozen DKW bound", () => {
    const rows = observations((index, provider) => {
      const templateIndex = Math.floor(index / 3);
      if ((templateIndex + provider.length) % 5 === 0) return [true, false];
      if ((templateIndex + provider.length) % 3 === 0) return [false, true];
      return [true, true];
    });
    const first = lc4TemplateClusterBootstrapInterval(rows, { iterations: 10_000 });
    const second = lc4TemplateClusterBootstrapInterval(rows, { iterations: 10_000 });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      clusters: 24,
      providers_per_cluster: 3,
      iterations: 10_000,
      confidence_level: 0.95,
    });
    expect(first.interval.lower).toBeLessThanOrEqual(first.estimate);
    expect(first.interval.upper).toBeGreaterThanOrEqual(first.estimate);
    expect(first.monte_carlo_error.cdf_error_bound).toBeCloseTo(0.019494746035204052, 15);
    expect(first.monte_carlo_error.lower_endpoint_quantile_range.from_probability)
      .toBeLessThan(first.monte_carlo_error.lower_endpoint_quantile_range.to_probability);
    expect(first.monte_carlo_error.scope).toMatch(/does not bound statistical interval coverage/);
  });

  it("matches the checked-in canonical inference artifact", async () => {
    const generated = createLc4ConstrainedInferenceArtifact();
    const checkedIn = JSON.parse(await readFile(resolve(
      process.cwd(),
      "../benchmarks/voice-long-horizon/HACC_LC4_CONSTRAINED_INFERENCE_V1.json",
    ), "utf8"));
    expect(checkedIn).toEqual(generated);
    expect(generated.artifact_sha256).toBe("84ff4802dc2379ce59b98300fede35465cd37591dc3b0bdfc8bf277e6090e9b1");
    const body = Object.fromEntries(Object.entries(generated).filter(([key]) => key !== "artifact_sha256"));
    expect(generated.artifact_sha256).toBe(sha256Hex(
      `harshas-amazing-call-center/lc4-constrained-inference/v1\n${canonicalJson(body)}`,
    ));
    expect(generated.synthetic_mechanics_check.evidentiary_value).toMatch(/^none/);
    expect(generated.claim_boundaries.join(" ")).toMatch(/zero provider calls/);
  });
});
