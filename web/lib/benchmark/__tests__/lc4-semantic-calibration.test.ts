import { describe, expect, it } from "vitest";

import {
  LC4_SEMANTIC_CALIBRATION_ARTIFACT_SHA256,
  LC4_SEMANTIC_CALIBRATION_FIXTURE_CORPUS_SHA256,
  LC4_SEMANTIC_CALIBRATION_VERSION,
  assertLc4SemanticCalibrationAuthority,
  createLc4SemanticCalibrationArtifact,
  type Lc4SemanticCalibrationCategory,
} from "../lc4-semantic-calibration";
import {
  LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256,
  LC4_LISTENER_SEMANTIC_SCORER_VERSION,
} from "../lc4-listener-evidence";

const HARD_NEGATIVE_CATEGORIES: readonly Lc4SemanticCalibrationCategory[] = Object.freeze([
  "explicit_negation",
  "contraction_negation",
  "stale_prefix",
  "rejected_suffix",
  "question",
  "uncertainty",
  "later_retraction",
  "stale_current_swap",
  "entity_swap",
  "purpose_swap",
  "number_swap",
  "date_swap",
  "prohibited_spoken_action",
  "prohibited_spoken_promise",
  "repair_language",
  "exclusion_scope",
  "hypothetical_or_reported",
  "no_longer_or_qualified",
  "postpositive_negation",
  "metalinguistic_mention",
  "negator_scope",
]);

describe("LC4 provider-free semantic scorer calibration", () => {
  it("achieves perfect authored sensitivity and specificity for every frozen criterion", () => {
    const artifact = createLc4SemanticCalibrationArtifact();

    expect(artifact.calibration_version).toBe(LC4_SEMANTIC_CALIBRATION_VERSION);
    expect(artifact.scorer_version).toBe(LC4_LISTENER_SEMANTIC_SCORER_VERSION);
    expect(artifact.scorer_build_sha256).toBe(LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256);
    expect(artifact.provider_calls_made).toBe(0);
    expect(artifact.claim_boundary)
      .toBe("deterministic_authored_regression_calibration_not_asr_or_provider_efficacy");
    expect(artifact.coverage.canonical_opportunities).toBe(60);
    expect(artifact.coverage.semantic_subjects).toBeGreaterThanOrEqual(60);
    expect(artifact.coverage.frozen_registered_criteria).toBeGreaterThan(0);
    expect(artifact.coverage.fixture_cases).toBe(artifact.cases.length);

    const registered = artifact.by_criterion.filter((row) =>
      row.scope === "frozen_registered_criterion");
    expect(registered).toHaveLength(artifact.coverage.frozen_registered_criteria);
    expect(artifact.by_criterion).toHaveLength(
      artifact.coverage.frozen_registered_criteria
      + artifact.coverage.synthetic_operator_criteria,
    );
    for (const row of artifact.by_criterion) {
      expect(row.confusion.expected_positive, row.criterion_key).toBeGreaterThan(0);
      expect(row.confusion.expected_negative, row.criterion_key).toBeGreaterThan(0);
      expect(row.confusion.false_positive, row.criterion_key).toBe(0);
      expect(row.confusion.false_negative, row.criterion_key).toBe(0);
      expect(row.confusion.sensitivity_ppm, row.criterion_key).toBe(1_000_000);
      expect(row.confusion.specificity_ppm, row.criterion_key).toBe(1_000_000);
    }
  });

  it("covers every named hard-negative family and keeps every authored label correct", () => {
    const artifact = createLc4SemanticCalibrationArtifact();
    const byCategory = new Map(artifact.by_category.map((row) => [row.category, row.confusion]));

    for (const category of HARD_NEGATIVE_CATEGORIES) {
      const result = byCategory.get(category);
      expect(result, category).toBeDefined();
      expect((result?.expected_positive ?? 0) + (result?.expected_negative ?? 0), category)
        .toBeGreaterThan(0);
      expect(result?.false_positive, category).toBe(0);
      expect(result?.false_negative, category).toBe(0);
      expect(result?.accuracy_ppm, category).toBe(1_000_000);
    }
    expect(artifact.aggregate.false_positive).toBe(0);
    expect(artifact.aggregate.false_negative).toBe(0);
    expect(artifact.aggregate.sensitivity_ppm).toBe(1_000_000);
    expect(artifact.aggregate.specificity_ppm).toBe(1_000_000);
    expect(artifact.failed_case_ids).toEqual([]);
  });

  it("records all outcome-specific op42 subjects instead of silently treating the adaptive branch as success", () => {
    const artifact = createLc4SemanticCalibrationArtifact();

    expect(artifact.coverage.op42).toEqual({
      present: true,
      applicability: "applicable",
      semantic_subject_count: 5,
      criterion_count: 10,
    });
    expect(artifact.coverage.applicable_semantic_subjects
      + artifact.coverage.not_applicable_semantic_subjects)
      .toBe(artifact.coverage.semantic_subjects);
    expect(new Set(artifact.cases
      .map((row) => row.opportunity_id)
      .filter((opportunityId) => opportunityId?.startsWith("lc4-dev-op-42:")))).toHaveLength(5);
  });

  it("replays to an identical numerical artifact and hash with no environment or provider input", () => {
    const first = createLc4SemanticCalibrationArtifact();
    const second = createLc4SemanticCalibrationArtifact();

    expect(second).toEqual(first);
    expect(second.fixture_corpus_sha256)
      .toBe(LC4_SEMANTIC_CALIBRATION_FIXTURE_CORPUS_SHA256);
    expect(second.artifact_sha256)
      .toBe(LC4_SEMANTIC_CALIBRATION_ARTIFACT_SHA256);
    expect(() => assertLc4SemanticCalibrationAuthority(second)).not.toThrow();
    expect(() => assertLc4SemanticCalibrationAuthority({
      ...second,
      aggregate: {
        ...second.aggregate,
        false_positive: 1,
      },
    })).toThrow(/calibration authority/u);
    expect(Object.keys(second).some((key) => /provider|api.?key|token|secret/iu.test(key)
      && key !== "provider_calls_made")).toBe(false);
  });
});
