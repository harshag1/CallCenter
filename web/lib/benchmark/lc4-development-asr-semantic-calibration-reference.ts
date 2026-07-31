import type {
  Lc4ListenerSemanticCriterion,
} from "./lc4-listener-evidence";

const NUMERIC_WORD =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twentieth)\b/iu;

/**
 * Provider-free selection frozen before the paid LC4-DEV run. Keep the
 * criterion-plan digest beside its opportunity ID: a verifier must reject a
 * semantically substituted opportunity even when its public ID is unchanged.
 */
export const LC4_DEV_SEMANTIC_ASR_CALIBRATION_SELECTED_SET = Object.freeze([
  Object.freeze({ opportunity_id: "lc4-dev-op-05", criterion_plan_sha256: "ef4644ce75c78ad949adac40cf4d968f9d7e7b16dcfffeee96eda5021ac6485d" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-10", criterion_plan_sha256: "c502c0f6aa67a644b9386202eb244cf3b38a3d9b6c71b9ecd4210ba64c0afb64" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-11", criterion_plan_sha256: "dee3722fdc690223911a83314cc32dbfe9f0ed8696ff2754313af21fde473363" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-15", criterion_plan_sha256: "e46d3e891ed77ea4c94faf5c92431ae7071575ddedeb3445a19d36aef0904391" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-19", criterion_plan_sha256: "b63777a23c16b5a57b3fe908ecdcfef9f0a534abe8d930a117e727092ff4f9ec" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-20", criterion_plan_sha256: "1c4a72fd57d7ca92c01950402a6f6968dddcaaba8c2268ad3e7e3bf5f77831af" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-21", criterion_plan_sha256: "1b3cc498e65f0993fdf816a6ff7c630e1968c369ec45bacd310249d05cbb6ed5" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-23", criterion_plan_sha256: "69558cbae26c2238e7536be0fc09bddd2c3e21df64a70ffd57c242fa207c8b6c" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-26", criterion_plan_sha256: "e604f3765642a37b80ab94ec08011e7ccd26bab75cdc2400cea123bd9f1a672f" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-01", criterion_plan_sha256: "241332d6e09fef1fe29666edfa86efeccf8ece2b37323ff604914aab87c9f82a" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-02", criterion_plan_sha256: "e116ae667727024cdf627ba7e7fc5974ce008d1a4c8c9c58ad322b34facca539" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-30", criterion_plan_sha256: "1a7a69aa0e79bba01074686b8b46c09fca14c4404e54ae9fc416493a54cca66b" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-04", criterion_plan_sha256: "b6e5951c8169cac7f4f714c3ce6838e00f0dc150d31eb41c909d9da3c5c858af" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-37", criterion_plan_sha256: "2d706823b00c7f17490f9ac16d2fe570fe2f63f9b07ab75eeb25598ffa794a40" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-39", criterion_plan_sha256: "8e5fd5d39af193335352091810a2b803b36720686a964bc0b02fe03ad56d20e1" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-40", criterion_plan_sha256: "64f36f13b870ec55b3e35351d1de70e90a009be0aef44323c5b45c646a4aaf4e" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-41", criterion_plan_sha256: "c797ea20a43aae05c2cf11796a2424a54631c0d4f648b32b28f7a3cb2bbfad42" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-45", criterion_plan_sha256: "45a02775f686f78a2e33d263cd3ad6d05f4a6715633bc5b97e1ad6b4efde51b9" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-46", criterion_plan_sha256: "414166e9fe841c03848a10e575abcebf95fb2d0b5b1b12a291b3b29f35bb5ec6" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-48", criterion_plan_sha256: "bafe0b9091ec752cefce945d67c7cb9eb058473740984e19b8c47547dccf8c60" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-50", criterion_plan_sha256: "0c60652ea51d25edc235e4c8586dacf50c2a08098821e900636bcc2dc5c48bc6" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-53", criterion_plan_sha256: "68773d600fee2187786c857e9162c29950cdd2d1041cb8b182ef20a7fcee7bc9" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-54", criterion_plan_sha256: "428f3ec7b1a7b763913eb668d2ba5073c48bcce3fe049b5a1c18481d326c6443" }),
  Object.freeze({ opportunity_id: "lc4-dev-op-57", criterion_plan_sha256: "17aa326256d46767c4d05dfacd0a58c9b6c782d0a927533770fe3547ee70717f" }),
] as const);

export const LC4_DEV_SEMANTIC_ASR_CALIBRATION_OPPORTUNITY_IDS =
  Object.freeze(LC4_DEV_SEMANTIC_ASR_CALIBRATION_SELECTED_SET.map(
    (selected) => selected.opportunity_id,
  ));

export const LC4_DEV_SEMANTIC_ASR_CALIBRATION_ROUTES = Object.freeze([
  Object.freeze({ route_id: "synthetic-samantha", voice: "Samantha" }),
  Object.freeze({ route_id: "synthetic-daniel", voice: "Daniel" }),
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
