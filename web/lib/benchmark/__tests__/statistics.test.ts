import { describe, expect, it } from "vitest";
import {
  clusteredPairedBootstrapMeanDifference,
  createSeededRng,
  pairedBootstrapMeanDifference,
  pairedRandomizationTest,
  randomizePairedArmOrder,
  shuffleSeeded,
  wilsonScoreInterval,
} from "../statistics";

describe("deterministic paired experiment statistics", () => {
  it("replays the same RNG sequence and never mutates shuffled input", () => {
    const first = createSeededRng("experiment-42");
    const second = createSeededRng("experiment-42");
    const different = createSeededRng("experiment-43");
    const a = Array.from({ length: 5 }, () => first());
    const b = Array.from({ length: 5 }, () => second());
    const c = Array.from({ length: 5 }, () => different());
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);

    const input = [1, 2, 3, 4, 5];
    const shuffled = shuffleSeeded(input, "shuffle-1");
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...shuffled].sort()).toEqual(input);
    expect(shuffleSeeded(input, "shuffle-1")).toEqual(shuffled);
  });

  it("block-balances AB/BA order and randomizes pair scheduling", () => {
    const pairIds = Array.from({ length: 11 }, (_, index) => `pair-${index}`);
    const assignment = randomizePairedArmOrder(pairIds, ["raw", "harness"], "order-seed");
    const rawFirst = assignment.filter((pair) => pair.first === "raw").length;
    expect(Math.abs(rawFirst - (assignment.length - rawFirst))).toBeLessThanOrEqual(1);
    expect(assignment.map((pair) => pair.pair_id)).not.toEqual(pairIds);
    expect(randomizePairedArmOrder(pairIds, ["raw", "harness"], "order-seed")).toEqual(assignment);
  });

  it("computes Wilson bounds used by the Reliable Horizon endpoint", () => {
    const perfect = wilsonScoreInterval(100, 100, 0.95);
    expect(perfect.lower).toBeCloseTo(0.963, 3);
    expect(perfect.upper).toBe(1);
    const half = wilsonScoreInterval(50, 100, 0.95);
    expect(half.lower).toBeCloseTo(0.4038, 3);
    expect(half.upper).toBeCloseTo(0.5962, 3);
  });

  it("produces reproducible paired bootstrap intervals", () => {
    const pairs = Array.from({ length: 20 }, (_, index) => ({
      pair_id: `pair-${index}`,
      baseline: index % 3,
      treatment: index % 3 + (index < 15 ? 1 : 0),
    }));
    const first = pairedBootstrapMeanDifference(pairs, { iterations: 2_000, seed: "bootstrap-1" });
    const replay = pairedBootstrapMeanDifference(pairs, { iterations: 2_000, seed: "bootstrap-1" });
    expect(first).toEqual(replay);
    expect(first.estimate).toBe(0.75);
    expect(first.interval.lower).toBeGreaterThan(0.5);
    expect(first.interval.upper).toBeLessThanOrEqual(1);
  });

  it("weights scenario clusters equally rather than letting a large scenario dominate", () => {
    const pairs = [
      { pair_id: "rare-1", cluster_id: "rare", baseline: 0, treatment: 10 },
      ...Array.from({ length: 10 }, (_, index) => ({
        pair_id: `common-${index}`,
        cluster_id: "common",
        baseline: 0,
        treatment: 0,
      })),
    ];
    const byPair = pairedBootstrapMeanDifference(pairs, { iterations: 500, seed: "pair" });
    const byCluster = clusteredPairedBootstrapMeanDifference(pairs, {
      iterations: 500,
      seed: "cluster",
    });
    expect(byPair.estimate).toBeCloseTo(10 / 11);
    expect(byCluster.estimate).toBe(5);
    expect(byCluster.sampling_unit).toBe("cluster");
  });

  it("uses an exact paired sign-flip test when the sample is small", () => {
    const pairs = Array.from({ length: 4 }, (_, index) => ({
      pair_id: `pair-${index}`,
      baseline: 0,
      treatment: 1,
    }));
    expect(pairedRandomizationTest(pairs, { seed: "unused" })).toMatchObject({
      observed_mean_difference: 1,
      p_value: 0.125,
      method: "exact",
      permutations: 16,
      seed: null,
    });
    expect(pairedRandomizationTest(pairs, {
      seed: "unused",
      alternative: "treatment_greater",
    }).p_value).toBe(0.0625);
  });

  it("makes the Monte Carlo randomization test reproducible", () => {
    const pairs = Array.from({ length: 20 }, (_, index) => ({
      pair_id: `pair-${index}`,
      baseline: 0,
      treatment: index < 15 ? 1 : -1,
    }));
    const first = pairedRandomizationTest(pairs, {
      exact_threshold: 10,
      iterations: 2_000,
      seed: "permutation-1",
    });
    const replay = pairedRandomizationTest(pairs, {
      exact_threshold: 10,
      iterations: 2_000,
      seed: "permutation-1",
    });
    expect(first).toEqual(replay);
    expect(first.method).toBe("monte_carlo");
  });
});
