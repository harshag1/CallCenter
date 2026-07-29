import type {
  Lc4ListenerSemanticCriterion,
} from "./lc4-listener-evidence";

const NUMERIC_WORD =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twentieth)\b/iu;

export const LC4_DEV_SEMANTIC_ASR_CALIBRATION_OPPORTUNITY_IDS =
  Object.freeze([
    "lc4-dev-op-05", "lc4-dev-op-10", "lc4-dev-op-11", "lc4-dev-op-15",
    "lc4-dev-op-19", "lc4-dev-op-20", "lc4-dev-op-21", "lc4-dev-op-23",
    "lc4-dev-op-26", "lc4-dev-op-01", "lc4-dev-op-02", "lc4-dev-op-30",
    "lc4-dev-op-04", "lc4-dev-op-37", "lc4-dev-op-39", "lc4-dev-op-40",
    "lc4-dev-op-41", "lc4-dev-op-45", "lc4-dev-op-46", "lc4-dev-op-48",
    "lc4-dev-op-50", "lc4-dev-op-53", "lc4-dev-op-54", "lc4-dev-op-57",
  ] as const);

const PREFERRED_CANONICAL_PHRASES = Object.freeze([
  "rights review",
  "authoritative status",
  "oral history access",
  "o river 17",
  "oriver 17",
  "MPL-1402",
  "August 20",
  "230",
  "2 30",
  "voice callback ending 0184",
]);

const TTS_PRONUNCIATIONS: Readonly<Record<string, string>> = Object.freeze({
  "o river 17": "oh river seventeen",
  "oriver 17": "oh river seventeen",
  "MPL-1402": "M P L fourteen oh two",
  "August 20": "August twenty",
  "230": "two thirty",
  "2 30": "two thirty",
  "voice callback ending 0184":
    "voice callback ending zero one eight four",
});

/**
 * Pick a phrase that macOS TTS and Whisper can reproduce without depending on
 * punctuation, digit normalization, or ordinal normalization.
 */
export function lc4DevelopmentSpeechFriendlyPhrase(
  phrases: readonly string[],
): string | null {
  const pinned = PREFERRED_CANONICAL_PHRASES.find((phrase) =>
    phrases.includes(phrase));
  if (pinned) return pinned;
  const preferred = phrases.filter(
    (phrase) => !/\d/u.test(phrase) && !NUMERIC_WORD.test(phrase),
  );
  const candidates = preferred.length > 0 ? preferred : phrases;
  return [...candidates].sort(
    (left, right) =>
      right.length - left.length || left.localeCompare(right),
  )[0] ?? null;
}

function strictlySpeechStablePhrase(
  phrases: readonly string[],
): string | null {
  const candidates = phrases.filter(
    (phrase) => !/\d/u.test(phrase) && !NUMERIC_WORD.test(phrase),
  );
  return [...candidates].sort(
    (left, right) =>
      right.length - left.length || left.localeCompare(right),
  )[0] ?? null;
}

export type Lc4DevelopmentSemanticCalibrationReference = Readonly<{
  synthesis_prompt: string;
  reference_transcript: string;
  expected_semantic_phrases: readonly string[];
}>;

/**
 * Build speech that exercises the frozen semantic scorer, not merely its
 * tokenizer. Positive criteria are stated as explicit assertions. Prohibited
 * phrases are deliberately absent, so `contains_none` criteria test silence
 * rather than teaching the recognizer the forbidden claim.
 */
export function createLc4DevelopmentSemanticCalibrationReference(input: Readonly<{
  marker: string;
  criteria: readonly Lc4ListenerSemanticCriterion[];
}>): Lc4DevelopmentSemanticCalibrationReference {
  if (input.criteria.length === 0) {
    throw new Error("LC4-DEV semantic calibration requires criteria");
  }

  const asserted: string[] = [];
  const expected: string[] = [];
  for (const criterion of input.criteria) {
    if (criterion.operator === "contains_none") continue;
    const phrases =
      criterion.operator === "contains_any"
        ? [lc4DevelopmentSpeechFriendlyPhrase(criterion.phrases)]
        : criterion.phrases.map((phrase) =>
            lc4DevelopmentSpeechFriendlyPhrase([phrase]));
    if (phrases.some((phrase) => phrase === null)) {
      throw new Error(
        `semantic criterion ${criterion.criterion_id} has no speech-stable phrase`,
      );
    }
    asserted.push(...(phrases as string[]));
    const stableExpected = phrases.map((phrase) =>
      phrase === null ? null : strictlySpeechStablePhrase([phrase]));
    expected.push(
      ...(stableExpected.filter(
        (phrase): phrase is string => phrase !== null,
      )),
    );
  }

  const assertions =
    asserted.length === 0
      ? ["No prohibited claim is present."]
      : [`The confirmed values are ${asserted.join(", ")}.`];
  const synthesisAssertions =
    asserted.length === 0
      ? assertions
      : [
          `The confirmed values are ${asserted
            .map((phrase) => TTS_PRONUNCIATIONS[phrase] ?? phrase)
            .join(", ")}.`,
        ];
  const calibrationLabels =
    expected.length === 0
      ? ["no prohibited claim is present"]
      : expected;
  return Object.freeze({
    synthesis_prompt:
      `Listener calibration ${input.marker}. ${synthesisAssertions.join(" ")}`,
    reference_transcript:
      `Listener calibration ${input.marker}. ${assertions.join(" ")}`,
    expected_semantic_phrases: Object.freeze(calibrationLabels),
  });
}
