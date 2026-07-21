import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LONG_CALL_ASR_CALIBRATION_FIXTURES,
  createLongCallAsrCalibrationArtifact,
  createLongCallAsrCalibrationPlan,
  normalizeLongCallAsrText,
  scoreLongCallAsrCalibration,
  verifyLongCallAsrCalibrationArtifact,
  wordErrorCounts,
  type FrozenLongCallExperimentPlan,
} from "../long-call-asr-calibration";
import {
  LONG_CALL_FAMILIES,
  LONG_CALL_PROTOCOL_ID,
  LONG_CALL_TTS_VOICES,
  longUsefulnessTask,
} from "../long-call-live-experiment";

const HASH = "a".repeat(64);

function frozenPlan(): FrozenLongCallExperimentPlan {
  const fixtures = LONG_CALL_FAMILIES.flatMap((family) => {
    const task = longUsefulnessTask(family);
    return LONG_CALL_TTS_VOICES.flatMap((ttsVoice) => task.scenario.caller.turns.map((turn, index) => Object.freeze({
      taskSha256: task.suite_sha256,
      family,
      ttsVoice,
      turnId: turn.id,
      sourceTextSha256: sha256Hex(turn.utterance),
      sampleRateHz: 24_000 as const,
      path: `fixtures/${family}/${ttsVoice.toLowerCase()}/${turn.id}.pcm`,
      sha256: sha256Hex(`${family}/${ttsVoice}/${turn.id}`),
      byteLength: 48_000 + index * 2,
    })));
  });
  return Object.freeze({
    protocolId: LONG_CALL_PROTOCOL_ID,
    experimentId: "hacc-lc3-v1",
    planSha256: HASH,
    fixtures,
    fixtureManifestSha256: sha256Hex(canonicalJson(fixtures)),
  });
}

describe("long-call ASR calibration", () => {
  it("normalizes compact/spaced identifiers and numeric renderings equivalently", () => {
    expect(normalizeLongCallAsrText("A71 CHEM318 HYD14"))
      .toEqual(normalizeLongCallAsrText("A seventy-one, C H E M three eighteen, H Y D fourteen"));
    expect(normalizeLongCallAsrText("one hundred fifty minutes"))
      .toEqual(normalizeLongCallAsrText("150 minutes"));
    expect(normalizeLongCallAsrText("fifty-two percent"))
      .toEqual(normalizeLongCallAsrText("52%"));
    expect(normalizeLongCallAsrText("M L R two zero four eight"))
      .toEqual(normalizeLongCallAsrText("MLR-2048"));
    expect(wordErrorCounts(["a", "b", "c"], ["a", "x", "c", "d"]))
      .toEqual({ errors: 2, referenceWords: 3 });
  });

  it("selects exactly six 24 kHz turns in each family-by-voice stratum", () => {
    const calibration = createLongCallAsrCalibrationPlan(frozenPlan());
    expect(calibration.fixtures).toHaveLength(LONG_CALL_ASR_CALIBRATION_FIXTURES);
    for (const family of LONG_CALL_FAMILIES) {
      for (const voice of LONG_CALL_TTS_VOICES) {
        expect(calibration.fixtures.filter((fixture) => fixture.family === family && fixture.ttsVoice === voice))
          .toHaveLength(6);
      }
    }
    expect(calibration.fixtures.map((fixture) => fixture.turnOrdinal).slice(0, 6)).toEqual([1, 4, 9, 14, 17, 20]);
  });

  it("passes exact transcripts and fail-closes missing evidence or semantic hallucinations", () => {
    const plan = createLongCallAsrCalibrationPlan(frozenPlan());
    const exact = plan.fixtures.map((fixture) => Object.freeze({
      calibrationUnitId: fixture.calibrationUnitId,
      transcript: fixture.sourceText,
      receiptSha256: sha256Hex(`receipt/${fixture.calibrationUnitId}`),
      playedAudioSha256: fixture.sha256,
    }));
    const pass = scoreLongCallAsrCalibration({ plan, transcripts: exact });
    expect(pass.gatePass).toBe(true);
    expect(pass.metrics).toMatchObject({
      completedFixtures: 54,
      fixtureCoverage: 1,
      wordErrorRate: 0,
      criticalSlotFalseNegatives: 0,
      semanticSlotFalsePositives: 0,
    });

    const missing = scoreLongCallAsrCalibration({ plan, transcripts: exact.slice(1) });
    expect(missing.gatePass).toBe(false);
    expect(missing.metrics.completedFixtures).toBe(53);

    const hallucinated = exact.map((transcript, index) => index === 0
      ? Object.freeze({ ...transcript, transcript: `${transcript.transcript} fifty-two percent` })
      : transcript);
    const failed = scoreLongCallAsrCalibration({ plan, transcripts: hallucinated });
    expect(failed.gatePass).toBe(false);
    expect(failed.metrics.semanticSlotFalsePositives).toBe(1);
  });

  it("hash-binds and verifies the final artifact against experiment inputs", () => {
    const plan = createLongCallAsrCalibrationPlan(frozenPlan());
    const scored = scoreLongCallAsrCalibration({
      plan,
      transcripts: plan.fixtures.map((fixture) => ({
        calibrationUnitId: fixture.calibrationUnitId,
        transcript: fixture.sourceText,
        receiptSha256: sha256Hex(`receipt/${fixture.calibrationUnitId}`),
        playedAudioSha256: fixture.sha256,
      })),
    });
    const artifact = createLongCallAsrCalibrationArtifact({
      scored,
      fixtureManifestSha256: plan.fixtureManifestSha256,
      asrConfigSha256: "b".repeat(64),
      asrBatchFinalizationSha256: "c".repeat(64),
      receiptsManifestSha256: "d".repeat(64),
    });
    expect(verifyLongCallAsrCalibrationArtifact(artifact, {
      experimentPlanSha256: plan.experimentPlanSha256,
      fixtureManifestSha256: plan.fixtureManifestSha256,
      asrConfigSha256: "b".repeat(64),
      requirePassingGate: true,
    })).toEqual({ valid: true, errors: [] });
    expect(verifyLongCallAsrCalibrationArtifact({ ...artifact, gatePass: false }, {
      experimentPlanSha256: plan.experimentPlanSha256,
      fixtureManifestSha256: plan.fixtureManifestSha256,
      asrConfigSha256: "b".repeat(64),
    }).valid).toBe(false);
  });
});
