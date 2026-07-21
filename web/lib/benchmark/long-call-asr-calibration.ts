import { canonicalJson, sha256Hex } from "./artifacts";
import {
  LONG_CALL_FAMILIES,
  LONG_CALL_PROTOCOL_ID,
  LONG_CALL_TTS_VOICES,
  longUsefulnessTask,
  type LongCallFamily,
  type LongCallTtsVoice,
} from "./long-call-live-experiment";

export const LONG_CALL_ASR_CALIBRATION_ID = "HACC-LC3-ASR-CAL-v1" as const;
export const LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS = Object.freeze([1, 4, 9, 14, 17, 20] as const);
export const LONG_CALL_ASR_CALIBRATION_FIXTURES = 54 as const;
export const LONG_CALL_ASR_MAX_WER = 0.15 as const;

const CALIBRATION_PLAN_DOMAIN = "hacc/long-call-asr-calibration-plan/v1\n";
const CALIBRATION_RESULT_DOMAIN = "hacc/long-call-asr-calibration-result/v1\n";
const CALIBRATION_ARTIFACT_DOMAIN = "hacc/long-call-asr-calibration-artifact/v1\n";

export type FrozenLongCallFixture = Readonly<{
  taskSha256: string;
  family: LongCallFamily;
  ttsVoice: LongCallTtsVoice;
  turnId: string;
  sourceTextSha256: string;
  sampleRateHz: 16_000 | 24_000;
  path: string;
  sha256: string;
  byteLength: number;
}>;

export type FrozenLongCallExperimentPlan = Readonly<{
  protocolId: typeof LONG_CALL_PROTOCOL_ID;
  experimentId: string;
  planSha256: string;
  fixtureManifestSha256: string;
  fixtures: readonly FrozenLongCallFixture[];
}>;

export type LongCallAsrCalibrationFixture = FrozenLongCallFixture & Readonly<{
  ordinal: number;
  turnOrdinal: number;
  sourceText: string;
  calibrationUnitId: string;
}>;

export type LongCallAsrCalibrationPlan = Readonly<{
  schemaVersion: 1;
  calibrationId: typeof LONG_CALL_ASR_CALIBRATION_ID;
  experimentId: string;
  experimentPlanSha256: string;
  fixtureManifestSha256: string;
  sampleRateHz: 24_000;
  selectionRule: "turn-ordinals-1-4-9-14-17-20-in-every-family-voice-stratum";
  selectedTurnOrdinals: typeof LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS;
  fixtures: readonly LongCallAsrCalibrationFixture[];
  plannedFixtureCount: typeof LONG_CALL_ASR_CALIBRATION_FIXTURES;
  calibrationPlanSha256: string;
}>;

export type LongCallAsrCalibrationTranscript = Readonly<{
  calibrationUnitId: string;
  transcript: string;
  receiptSha256: string;
  playedAudioSha256: string;
}>;

type SemanticSlot = Readonly<{
  id: string;
  family: LongCallFamily;
  kind: "corrected_identifier" | "numeric_limit";
  canonicalText: string;
  aliases?: readonly string[];
}>;

export const LONG_CALL_ASR_SEMANTIC_SLOTS: readonly SemanticSlot[] = Object.freeze([
  Object.freeze({ id: "museum.corrected_crate", family: "museum", kind: "corrected_identifier", canonicalText: "A 71" }),
  Object.freeze({ id: "museum.humidity_limit", family: "museum", kind: "numeric_limit", canonicalText: "52 percent", aliases: Object.freeze(["52%"])}),
  Object.freeze({ id: "campus.corrected_assessment", family: "campus", kind: "corrected_identifier", canonicalText: "CHEM 318 practical" }),
  Object.freeze({ id: "campus.duration_limit", family: "campus", kind: "numeric_limit", canonicalText: "150 minutes" }),
  Object.freeze({ id: "water.corrected_site", family: "water", kind: "corrected_identifier", canonicalText: "HYD 14 daycare" }),
  Object.freeze({ id: "water.threshold_limit", family: "water", kind: "numeric_limit", canonicalText: "10 parts per billion", aliases: Object.freeze(["10 ppb"]) }),
]);

const ONES: Readonly<Record<string, number>> = Object.freeze({
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
});
const TEENS: Readonly<Record<string, number>> = Object.freeze({
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
});
const TENS: Readonly<Record<string, number>> = Object.freeze({
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});
const NUMBER_WORDS = new Set([...Object.keys(ONES), ...Object.keys(TEENS), ...Object.keys(TENS), "hundred", "thousand", "and"]);

function parseCardinal(words: readonly string[]): string {
  const meaningful = words.filter((word) => word !== "and");
  if (meaningful.length === 0) return "";
  if (meaningful.every((word) => word in ONES)) {
    return meaningful.map((word) => String(ONES[word])).join("");
  }
  let total = 0;
  let current = 0;
  for (let index = 0; index < meaningful.length; index += 1) {
    const word = meaningful[index];
    if (word in ONES) {
      const following = meaningful[index + 1];
      // Spoken identifiers such as "two forty one" mean 241, not 43.
      if (following && (following in TENS || following in TEENS) && index === 0) {
        const tail = parseCardinal(meaningful.slice(index + 1));
        return `${ONES[word]}${tail}`;
      }
      current += ONES[word];
    } else if (word in TEENS) {
      current += TEENS[word];
    } else if (word in TENS) {
      current += TENS[word];
    } else if (word === "hundred") {
      current = Math.max(1, current) * 100;
    } else if (word === "thousand") {
      total += Math.max(1, current) * 1_000;
      current = 0;
    }
  }
  return String(total + current);
}

function digitTokens(value: string): string[] {
  const canonical = value.replace(/^0+(?=\d)/u, "");
  return [...canonical];
}

/**
 * Frozen English normalization used for calibration WER and semantic matching:
 * Unicode NFKD, lowercase, diacritic removal, ampersand-to-"and", apostrophe
 * deletion, other punctuation-to-space, spoken-cardinal conversion, decimal
 * digit splitting, and joining consecutive spelled letters ("C H E M" ->
 * "chem"). Splitting all numeric forms into digits makes "seventy one" and
 * "71" equivalent without a provider-specific text normalizer.
 */
export function normalizeLongCallAsrText(input: string): readonly string[] {
  const raw = input
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/%/gu, " percent ")
    .replace(/[’']/gu, "")
    .replace(/[-‐‑‒–—]/gu, " ")
    .replace(/([a-z])([0-9])/giu, "$1 $2")
    .replace(/([0-9])([a-z])/giu, "$1 $2")
    .replace(/[^a-z0-9\s]/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const numeric: string[] = [];
  for (let index = 0; index < raw.length;) {
    const token = raw[index];
    if (/^\d+$/u.test(token)) {
      numeric.push(...digitTokens(token));
      index += 1;
      continue;
    }
    if (NUMBER_WORDS.has(token) && token !== "and") {
      const words: string[] = [];
      while (index < raw.length && NUMBER_WORDS.has(raw[index])) {
        words.push(raw[index]);
        index += 1;
      }
      numeric.push(...digitTokens(parseCardinal(words)));
      continue;
    }
    numeric.push(token);
    index += 1;
  }
  const normalized: string[] = [];
  for (let index = 0; index < numeric.length;) {
    if (/^[a-z]$/u.test(numeric[index])) {
      let end = index + 1;
      while (end < numeric.length && /^[a-z]$/u.test(numeric[end])) end += 1;
      if (end - index >= 2) {
        normalized.push(numeric.slice(index, end).join(""));
        index = end;
        continue;
      }
    }
    normalized.push(numeric[index]);
    index += 1;
  }
  return Object.freeze(normalized);
}

export function wordErrorCounts(reference: readonly string[], hypothesis: readonly string[]) {
  const previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      current[column] = reference[row - 1] === hypothesis[column - 1]
        ? previous[column - 1]
        : 1 + Math.min(previous[column - 1], previous[column], current[column - 1]);
    }
    previous.splice(0, previous.length, ...current);
  }
  return Object.freeze({ errors: previous[hypothesis.length], referenceWords: reference.length });
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  return haystack.some((_, start) => needle.every((token, offset) => haystack[start + offset] === token));
}

export function createLongCallAsrCalibrationPlan(plan: FrozenLongCallExperimentPlan): LongCallAsrCalibrationPlan {
  if (plan.protocolId !== LONG_CALL_PROTOCOL_ID) throw new Error("ASR calibration requires an HACC-LC3-v2 experiment plan");
  if (sha256Hex(canonicalJson(plan.fixtures)) !== plan.fixtureManifestSha256) {
    throw new Error("frozen fixture manifest hash mismatch");
  }
  const selected: LongCallAsrCalibrationFixture[] = [];
  for (const family of LONG_CALL_FAMILIES) {
    const task = longUsefulnessTask(family);
    for (const ttsVoice of LONG_CALL_TTS_VOICES) {
      for (const turnOrdinal of LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS) {
        const turn = task.scenario.caller.turns[turnOrdinal - 1];
        if (!turn) throw new Error(`missing caller turn ${family}/${turnOrdinal}`);
        const candidates = plan.fixtures.filter((fixture) => fixture.family === family
          && fixture.ttsVoice === ttsVoice
          && fixture.sampleRateHz === 24_000
          && fixture.turnId === turn.id);
        if (candidates.length !== 1) throw new Error(`expected one 24 kHz fixture for ${family}/${ttsVoice}/${turn.id}`);
        const fixture = candidates[0];
        if (fixture.taskSha256 !== task.suite_sha256 || fixture.sourceTextSha256 !== sha256Hex(turn.utterance)) {
          throw new Error(`fixture source binding mismatch for ${family}/${ttsVoice}/${turn.id}`);
        }
        selected.push(Object.freeze({
          ...fixture,
          ordinal: selected.length + 1,
          turnOrdinal,
          sourceText: turn.utterance,
          calibrationUnitId: `cal-${family}-${ttsVoice.toLowerCase()}-${turn.id.replace(/[^A-Za-z0-9._:-]/gu, "-")}`,
        }));
      }
    }
  }
  if (selected.length !== LONG_CALL_ASR_CALIBRATION_FIXTURES) throw new Error("calibration selection must contain exactly 54 fixtures");
  if (new Set(selected.map((fixture) => fixture.path)).size !== selected.length) throw new Error("calibration fixture paths must be unique");
  const body = Object.freeze({
    schemaVersion: 1 as const,
    calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
    experimentId: plan.experimentId,
    experimentPlanSha256: plan.planSha256,
    fixtureManifestSha256: plan.fixtureManifestSha256,
    sampleRateHz: 24_000 as const,
    selectionRule: "turn-ordinals-1-4-9-14-17-20-in-every-family-voice-stratum" as const,
    selectedTurnOrdinals: LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS,
    fixtures: Object.freeze(selected),
    plannedFixtureCount: LONG_CALL_ASR_CALIBRATION_FIXTURES,
  });
  return Object.freeze({
    ...body,
    calibrationPlanSha256: sha256Hex(`${CALIBRATION_PLAN_DOMAIN}${canonicalJson(body)}`),
  });
}

export function scoreLongCallAsrCalibration(input: Readonly<{
  plan: LongCallAsrCalibrationPlan;
  transcripts: readonly LongCallAsrCalibrationTranscript[];
}>) {
  const byUnit = new Map<string, LongCallAsrCalibrationTranscript>();
  for (const transcript of input.transcripts) {
    if (byUnit.has(transcript.calibrationUnitId)) throw new Error(`duplicate ASR transcript ${transcript.calibrationUnitId}`);
    byUnit.set(transcript.calibrationUnitId, transcript);
  }
  const plannedUnits = new Set(input.plan.fixtures.map((fixture) => fixture.calibrationUnitId));
  const unexpectedUnits = [...byUnit.keys()].filter((unitId) => !plannedUnits.has(unitId));
  if (unexpectedUnits.length > 0) throw new Error(`unexpected ASR calibration transcript ${unexpectedUnits.sort()[0]}`);
  const fixtureResults = input.plan.fixtures.map((fixture) => {
    const transcript = byUnit.get(fixture.calibrationUnitId);
    const referenceTokens = normalizeLongCallAsrText(fixture.sourceText);
    const hypothesisTokens = normalizeLongCallAsrText(transcript?.transcript ?? "");
    const wordErrors = wordErrorCounts(referenceTokens, hypothesisTokens);
    const slots = LONG_CALL_ASR_SEMANTIC_SLOTS.filter((slot) => slot.family === fixture.family).map((slot) => {
      const representations = [slot.canonicalText, ...(slot.aliases ?? [])].map(normalizeLongCallAsrText);
      const expected = representations.some((tokens) => containsSequence(referenceTokens, tokens));
      const detected = representations.some((tokens) => containsSequence(hypothesisTokens, tokens));
      return Object.freeze({ slotId: slot.id, kind: slot.kind, expected, detected });
    });
    return Object.freeze({
      calibrationUnitId: fixture.calibrationUnitId,
      family: fixture.family,
      ttsVoice: fixture.ttsVoice,
      turnId: fixture.turnId,
      sourceTextSha256: fixture.sourceTextSha256,
      fixtureSha256: fixture.sha256,
      receiptSha256: transcript?.receiptSha256 ?? null,
      playedAudioSha256: transcript?.playedAudioSha256 ?? null,
      evidenceComplete: transcript?.playedAudioSha256 === fixture.sha256
        && /^[a-f0-9]{64}$/u.test(transcript.receiptSha256),
      referenceNormalized: referenceTokens.join(" "),
      hypothesisNormalized: hypothesisTokens.join(" "),
      wordErrors: wordErrors.errors,
      referenceWords: wordErrors.referenceWords,
      semanticSlots: Object.freeze(slots),
    });
  });
  const totalReferenceWords = fixtureResults.reduce((sum, result) => sum + result.referenceWords, 0);
  const totalWordErrors = fixtureResults.reduce((sum, result) => sum + result.wordErrors, 0);
  const expectedSlots = fixtureResults.flatMap((result) => result.semanticSlots.filter((slot) => slot.expected));
  const slotFalseNegatives = expectedSlots.filter((slot) => !slot.detected).length;
  const slotFalsePositives = fixtureResults
    .flatMap((result) => result.semanticSlots)
    .filter((slot) => !slot.expected && slot.detected).length;
  const completedFixtures = fixtureResults.filter((result) => result.evidenceComplete).length;
  const metrics = Object.freeze({
    plannedFixtures: input.plan.plannedFixtureCount,
    completedFixtures,
    fixtureCoverage: completedFixtures / input.plan.plannedFixtureCount,
    totalReferenceWords,
    totalWordErrors,
    wordErrorRate: totalReferenceWords === 0 ? 1 : totalWordErrors / totalReferenceWords,
    expectedCriticalSlots: expectedSlots.length,
    detectedCriticalSlots: expectedSlots.length - slotFalseNegatives,
    criticalSlotRecall: expectedSlots.length === 0 ? 0 : (expectedSlots.length - slotFalseNegatives) / expectedSlots.length,
    criticalSlotFalseNegatives: slotFalseNegatives,
    semanticSlotFalsePositives: slotFalsePositives,
  });
  const thresholds = Object.freeze({
    maximumWordErrorRate: LONG_CALL_ASR_MAX_WER,
    requiredFixtureCoverage: 1,
    maximumCriticalSlotFalseNegatives: 0,
    maximumSemanticSlotFalsePositives: 0,
  });
  const gatePass = metrics.fixtureCoverage === thresholds.requiredFixtureCoverage
    && metrics.wordErrorRate <= thresholds.maximumWordErrorRate
    && metrics.criticalSlotFalseNegatives <= thresholds.maximumCriticalSlotFalseNegatives
    && metrics.semanticSlotFalsePositives <= thresholds.maximumSemanticSlotFalsePositives;
  const body = Object.freeze({
    schemaVersion: 1 as const,
    calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
    experimentId: input.plan.experimentId,
    experimentPlanSha256: input.plan.experimentPlanSha256,
    calibrationPlanSha256: input.plan.calibrationPlanSha256,
    normalization: "nfkd-lower-diacritic-strip-ampersand-apostrophe-punctuation-cardinal-digit-letter-v1" as const,
    metrics,
    thresholds,
    gatePass,
    fixtureResults: Object.freeze(fixtureResults),
  });
  return Object.freeze({
    ...body,
    calibrationSha256: sha256Hex(`${CALIBRATION_RESULT_DOMAIN}${canonicalJson(body)}`),
  });
}

export type ScoredLongCallAsrCalibration = ReturnType<typeof scoreLongCallAsrCalibration>;

export type LongCallAsrCalibrationArtifact = ScoredLongCallAsrCalibration & Readonly<{
  fixtureManifestSha256: string;
  asrConfigSha256: string;
  asrBatchFinalizationSha256: string;
  receiptsManifestSha256: string;
  artifactSha256: string;
}>;

export function createLongCallAsrCalibrationArtifact(input: Readonly<{
  scored: ScoredLongCallAsrCalibration;
  fixtureManifestSha256: string;
  asrConfigSha256: string;
  asrBatchFinalizationSha256: string;
  receiptsManifestSha256: string;
}>): LongCallAsrCalibrationArtifact {
  const body = Object.freeze({
    ...input.scored,
    fixtureManifestSha256: input.fixtureManifestSha256,
    asrConfigSha256: input.asrConfigSha256,
    asrBatchFinalizationSha256: input.asrBatchFinalizationSha256,
    receiptsManifestSha256: input.receiptsManifestSha256,
  });
  return Object.freeze({
    ...body,
    artifactSha256: sha256Hex(`${CALIBRATION_ARTIFACT_DOMAIN}${canonicalJson(body)}`),
  });
}

export function verifyLongCallAsrCalibrationArtifact(
  artifactInput: unknown,
  expected: Readonly<{
    experimentPlanSha256: string;
    fixtureManifestSha256: string;
    asrConfigSha256: string;
    requirePassingGate?: boolean;
  }>
): Readonly<{ valid: boolean; errors: readonly string[] }> {
  const errors: string[] = [];
  if (!artifactInput || typeof artifactInput !== "object" || Array.isArray(artifactInput)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["calibration artifact must be an object"]) });
  }
  const artifact = artifactInput as Record<string, unknown>;
  const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (artifact.calibrationId !== LONG_CALL_ASR_CALIBRATION_ID) errors.push("calibration ID mismatch");
  if (artifact.experimentPlanSha256 !== expected.experimentPlanSha256) errors.push("experiment plan hash mismatch");
  if (artifact.fixtureManifestSha256 !== expected.fixtureManifestSha256) errors.push("fixture manifest hash mismatch");
  if (artifact.asrConfigSha256 !== expected.asrConfigSha256) errors.push("ASR config hash mismatch");
  if (!sha(artifact.artifactSha256)) {
    errors.push("artifact hash is missing or invalid");
  } else {
    const { artifactSha256, ...body } = artifact;
    if (sha256Hex(`${CALIBRATION_ARTIFACT_DOMAIN}${canonicalJson(body)}`) !== artifactSha256) {
      errors.push("artifact hash mismatch");
    }
  }
  const metrics = artifact.metrics as Record<string, unknown> | undefined;
  const thresholds = artifact.thresholds as Record<string, unknown> | undefined;
  if (!metrics || !thresholds) {
    errors.push("calibration metrics or thresholds are missing");
  } else {
    const computedGate = metrics.fixtureCoverage === thresholds.requiredFixtureCoverage
      && typeof metrics.wordErrorRate === "number"
      && typeof thresholds.maximumWordErrorRate === "number"
      && metrics.wordErrorRate <= thresholds.maximumWordErrorRate
      && typeof metrics.criticalSlotFalseNegatives === "number"
      && typeof thresholds.maximumCriticalSlotFalseNegatives === "number"
      && metrics.criticalSlotFalseNegatives <= thresholds.maximumCriticalSlotFalseNegatives
      && typeof metrics.semanticSlotFalsePositives === "number"
      && typeof thresholds.maximumSemanticSlotFalsePositives === "number"
      && metrics.semanticSlotFalsePositives <= thresholds.maximumSemanticSlotFalsePositives;
    if (artifact.gatePass !== computedGate) errors.push("gatePass is inconsistent with recorded metrics and thresholds");
  }
  if (expected.requirePassingGate === true && artifact.gatePass !== true) errors.push("calibration gate did not pass");
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
