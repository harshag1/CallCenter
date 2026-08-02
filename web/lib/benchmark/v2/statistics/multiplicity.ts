import { assertNonEmptyId, assertProbability } from "./helpers";
import type { HolmHypothesis, HolmResult } from "./types";

/** Holm's step-down family-wise error correction with deterministic tie order. */
export function holmBonferroni(
  hypotheses: readonly HolmHypothesis[],
  familyAlpha = 0.05,
): HolmResult {
  if (!Array.isArray(hypotheses) || hypotheses.length === 0) {
    throw new Error("At least one secondary hypothesis is required");
  }
  assertProbability(familyAlpha, "familyAlpha");
  const ids = new Set<string>();
  for (const [index, hypothesis] of hypotheses.entries()) {
    assertNonEmptyId(hypothesis.id, `hypotheses[${index}].id`);
    if (ids.has(hypothesis.id)) throw new Error(`Duplicate hypothesis id: ${hypothesis.id}`);
    ids.add(hypothesis.id);
    assertProbability(hypothesis.p_value, `${hypothesis.id}.p_value`, true);
  }
  const sorted = [...hypotheses].sort((left, right) => (
    left.p_value - right.p_value || left.id.localeCompare(right.id)
  ));
  let runningAdjusted = 0;
  let rejectionOpen = true;
  const evaluated = sorted.map((hypothesis, index) => {
    const multiplier = sorted.length - index;
    runningAdjusted = Math.max(runningAdjusted, Math.min(1, multiplier * hypothesis.p_value));
    const localThreshold = familyAlpha / multiplier;
    const rejected = rejectionOpen && hypothesis.p_value <= localThreshold + 1e-15;
    if (!rejected) rejectionOpen = false;
    return Object.freeze({
      id: hypothesis.id,
      p_value: hypothesis.p_value,
      rank: index + 1,
      adjusted_p_value: runningAdjusted,
      rejected,
    });
  });
  return Object.freeze({
    method: "holm_bonferroni" as const,
    family_alpha: familyAlpha,
    hypotheses: Object.freeze(evaluated),
  });
}
