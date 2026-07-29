import { describe, expect, it } from "vitest";

import {
  createLc4DevelopmentSemanticCalibrationReference,
  lc4DevelopmentSpeechFriendlyPhrase,
  LC4_DEV_SEMANTIC_ASR_CALIBRATION_OPPORTUNITY_IDS,
} from "../lc4-development-asr-semantic-calibration-reference";
import {
  LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
} from "../lc4-development-listener-semantics";
import {
  scoreLc4ListenerSemanticCriterion,
  type Lc4ListenerSemanticCriterion,
} from "../lc4-listener-evidence";

describe("LC4-DEV semantic ASR calibration references", () => {
  it("selects stable phrases without digits or number words", () => {
    expect(
      lc4DevelopmentSpeechFriendlyPhrase([
        "step twenty",
        "account 42",
        "membership renewal",
      ]),
    ).toBe("membership renewal");
    expect(lc4DevelopmentSpeechFriendlyPhrase(["MPL-1402"])).toBe("MPL-1402");
  });

  it("makes every required selected criterion pass the frozen scorer", () => {
    for (const opportunityId of LC4_DEV_SEMANTIC_ASR_CALIBRATION_OPPORTUNITY_IDS) {
      const opportunity =
        LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities.find(
          (candidate) => candidate.opportunity_id === opportunityId,
        );
      expect(opportunity).toBeDefined();
      const reference =
        createLc4DevelopmentSemanticCalibrationReference({
          marker: opportunityId,
          criteria: opportunity!.criteria,
        });
      for (const criterion of opportunity!.criteria.filter(
        (candidate) => candidate.required_for_final_scorer,
      )) {
        expect(
          scoreLc4ListenerSemanticCriterion(
            criterion,
            reference.reference_transcript,
          ),
          `${opportunityId}:${criterion.criterion_id}`,
        ).toBe(true);
        expect(
          scoreLc4ListenerSemanticCriterion(
            criterion,
            reference.reference_transcript.replace(/[.!?]/gu, ""),
          ),
          `${opportunityId}:${criterion.criterion_id}:punctuation-free`,
        ).toBe(true);
      }
    }
  });

  it("retains a canonical transcript separately from TTS pronunciation", () => {
    const opportunity =
      LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities.find(
        (candidate) => candidate.opportunity_id === "lc4-dev-op-05",
      )!;
    const reference = createLc4DevelopmentSemanticCalibrationReference({
      marker: "alpha",
      criteria: opportunity.criteria,
    });
    expect(reference.reference_transcript).toContain(
      "The confirmed values are o river 17, family history.",
    );
    expect(reference.synthesis_prompt).toContain(
      "The confirmed values are oh river seventeen, family history.",
    );
    expect(reference.expected_semantic_phrases).not.toContain("o river 17");
    expect(reference.expected_semantic_phrases).toContain("family history");
  });

  it("keeps prohibited phrases out of contains-none calibration speech", () => {
    const criterion: Lc4ListenerSemanticCriterion = Object.freeze({
      criterion_id: "no-false-promise",
      operator: "contains_none",
      phrases: Object.freeze(["release confirmed"]),
      required_for_final_scorer: true,
      crp_blocker: null,
    });
    const reference = createLc4DevelopmentSemanticCalibrationReference({
      marker: "negative",
      criteria: [criterion],
    });
    expect(reference.reference_transcript).not.toContain("release confirmed");
    expect(reference.expected_semantic_phrases).toEqual([
      "no prohibited claim is present",
    ]);
    expect(
      scoreLc4ListenerSemanticCriterion(
        criterion,
        reference.reference_transcript,
      ),
    ).toBe(true);
  });
});
