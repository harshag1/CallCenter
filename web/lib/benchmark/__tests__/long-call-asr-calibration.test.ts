import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LONG_CALL_ASR_CALIBRATION_FIXTURES,
  LONG_CALL_ASR_OUTPUT_VOICE_ROUTES,
  LONG_CALL_ASR_SEMANTIC_SLOTS,
  createLongCallAsrCalibrationArtifact,
  createLongCallAsrCalibrationPlan,
  createOutputVoiceCalibrationManifest,
  createOutputVoiceCaptureVerificationReceipt,
  normalizeLongCallAsrText,
  outputVoiceCaptureReceiptSha256,
  outputVoiceCaptureSigningBytes,
  outputVoiceChunkSequenceSha256,
  scoreLongCallAsrCalibration,
  verifyLongCallAsrCalibrationArtifact,
  wordErrorCounts,
  verifyOutputVoiceCalibrationPcm,
  verifyOutputVoiceCaptureVerificationReceipt,
  type FrozenLongCallExperimentPlan,
} from "../long-call-asr-calibration";
import {
  LONG_CALL_FAMILIES,
  LONG_CALL_PROTOCOL_ID,
  LONG_CALL_TTS_VOICES,
  longUsefulnessTask,
} from "../long-call-live-experiment";

const HASH = "a".repeat(64);
const CAPTURE_KEYS = generateKeyPairSync("ed25519");
const CAPTURE_PUBLIC_KEY_PEM = CAPTURE_KEYS.publicKey.export({ format: "pem", type: "spki" }).toString();
const CAPTURE_PUBLIC_KEY_SHA256 = sha256Hex(CAPTURE_KEYS.publicKey.export({ format: "der", type: "spki" }));

function fixturePcm(id: string): Uint8Array {
  const seed = Buffer.from(sha256Hex(id), "hex");
  return Uint8Array.from({ length: 48_000 }, (_, index) => seed[index % seed.length]);
}

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
  const outputVoiceCalibrationFixtures = LONG_CALL_ASR_OUTPUT_VOICE_ROUTES.flatMap((route) =>
    LONG_CALL_ASR_SEMANTIC_SLOTS.map((slot) => {
      const calibrationUnitId = `cal-output-${route.provider}-${slot.id.replace(".", "-")}`;
      const referenceText = `Calibration phrase: ${slot.canonicalText}.`;
      const referenceTextSha256 = sha256Hex(referenceText);
      const pcm = fixturePcm(calibrationUnitId);
      const pcmSha256 = sha256Hex(pcm);
      const chunks = Object.freeze([Object.freeze({
        ordinal: 1,
        byteOffset: 0,
        byteLength: pcm.byteLength,
        sha256: pcmSha256,
      })]);
      const unsignedReceipt = Object.freeze({
        schemaVersion: 1 as const,
        receiptType: "hacc_output_voice_calibration_capture" as const,
        captureId: calibrationUnitId,
        provider: route.provider,
        model: route.model,
        voice: route.voice,
        referenceTextSha256,
        pcmSha256,
        sampleRateHz: 24_000 as const,
        channels: 1 as const,
        encoding: "pcm16" as const,
        request: Object.freeze({
          sessionConfigurationSha256: sha256Hex(`${calibrationUnitId}/session-config`),
          requestBodySha256: sha256Hex(`${calibrationUnitId}/request-body`),
        }),
        providerReceipt: Object.freeze({
          receiptClass: "credential_neutral_provider_wire_receipt" as const,
          sessionIdSha256: sha256Hex(`${calibrationUnitId}/session-id`),
          requestIdSha256: sha256Hex(`${calibrationUnitId}/request-id`),
          acknowledgementKind: route.provider === "openai"
            ? "exact_configuration_echo" as const
            : route.provider === "gemini"
              ? "request_bound_setup_complete" as const
              : "request_bound_partial_echo" as const,
          acknowledgementEventSha256: sha256Hex(`${calibrationUnitId}/ack`),
          acknowledgedModel: route.provider === "gemini" ? null : route.model,
          acknowledgedVoice: route.provider === "gemini" ? null : route.voice,
          terminalEventSha256: sha256Hex(`${calibrationUnitId}/terminal`),
          credentialFieldsRetained: Object.freeze([] as const),
        }),
        wireCapture: Object.freeze({
          sanitizedEventLogSha256: sha256Hex(`${calibrationUnitId}/wire-events`),
          outputChunks: chunks,
          outputChunkSequenceSha256: outputVoiceChunkSequenceSha256(chunks),
        }),
        captureToolchain: Object.freeze({
          implementationSha256: sha256Hex("capture-implementation-v1"),
          sourceCommitSha256: sha256Hex("capture-source-commit-v1"),
        }),
      });
      const signature = Object.freeze({
        algorithm: "ed25519" as const,
        keyId: "test-output-capture",
        publicKeyPem: CAPTURE_PUBLIC_KEY_PEM,
        publicKeySha256: CAPTURE_PUBLIC_KEY_SHA256,
        signatureBase64: sign(null, outputVoiceCaptureSigningBytes(unsignedReceipt), CAPTURE_KEYS.privateKey).toString("base64"),
      });
      const receiptBody = Object.freeze({ ...unsignedReceipt, signature });
      return Object.freeze({
        calibrationUnitId,
        ...route,
        family: slot.family,
        slotId: slot.id,
        referenceText,
        referenceTextSha256,
        sampleRateHz: 24_000 as const,
        path: `output-voice-calibration/${route.provider}/${calibrationUnitId}.pcm`,
        sha256: pcmSha256,
        byteLength: pcm.byteLength,
        captureReceipt: Object.freeze({
          ...receiptBody,
          receiptSha256: outputVoiceCaptureReceiptSha256(receiptBody),
        }),
      });
    })
  );
  return Object.freeze({
    protocolId: LONG_CALL_PROTOCOL_ID,
    experimentId: "hacc-lc3-v3",
    planSha256: HASH,
    fixtures,
    fixtureManifestSha256: sha256Hex(canonicalJson(fixtures)),
    outputVoiceCalibrationFixtures,
    outputVoiceCalibrationManifestSha256: createOutputVoiceCalibrationManifest(outputVoiceCalibrationFixtures).manifestSha256,
  });
}

function exactTranscripts(plan: ReturnType<typeof createLongCallAsrCalibrationPlan>) {
  return [
    ...plan.fixtures.map((fixture) => ({
      calibrationUnitId: fixture.calibrationUnitId,
      transcript: fixture.sourceText,
      receiptSha256: sha256Hex(`receipt/${fixture.calibrationUnitId}`),
      playedAudioSha256: fixture.sha256,
    })),
    ...plan.outputVoiceFixtures.map((fixture) => ({
      calibrationUnitId: fixture.calibrationUnitId,
      transcript: fixture.referenceText,
      receiptSha256: sha256Hex(`receipt/${fixture.calibrationUnitId}`),
      playedAudioSha256: fixture.sha256,
    })),
  ];
}

describe("long-call ASR calibration", () => {
  it("atomically publishes the evidence directory before making it read-only", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/long-call-asr-calibration.ts"),
      "utf8"
    );
    const publish = source.indexOf("await rename(stagingDirectory, finalDirectory)");
    const lock = source.indexOf("await makeReadOnlyRecursively(finalDirectory, finalReceiptPaths)");
    expect(publish).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(publish);
  });

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

  it("balances caller strata and all exact provider output voices", () => {
    const calibration = createLongCallAsrCalibrationPlan(frozenPlan());
    expect(LONG_CALL_ASR_CALIBRATION_FIXTURES).toBe(
      LONG_CALL_FAMILIES.length * LONG_CALL_TTS_VOICES.length * 6
    );
    expect(calibration.fixtures).toHaveLength(LONG_CALL_ASR_CALIBRATION_FIXTURES);
    for (const family of LONG_CALL_FAMILIES) {
      for (const voice of LONG_CALL_TTS_VOICES) {
        expect(calibration.fixtures.filter((fixture) => fixture.family === family && fixture.ttsVoice === voice))
          .toHaveLength(6);
      }
    }
    expect(calibration.fixtures.map((fixture) => fixture.turnOrdinal).slice(0, 6)).toEqual([1, 4, 9, 14, 17, 20]);
    expect(calibration.outputVoiceFixtures).toHaveLength(18);
    expect(calibration.plannedFixtureCount).toBe(LONG_CALL_ASR_CALIBRATION_FIXTURES + 18);
    for (const route of LONG_CALL_ASR_OUTPUT_VOICE_ROUTES) {
      expect(calibration.outputVoiceFixtures.filter((fixture) => fixture.provider === route.provider
        && fixture.model === route.model
        && fixture.voice === route.voice)).toHaveLength(6);
    }

    const missingOutput = frozenPlan();
    const incomplete = missingOutput.outputVoiceCalibrationFixtures.slice(1);
    expect(() => createLongCallAsrCalibrationPlan({
      ...missingOutput,
      outputVoiceCalibrationFixtures: incomplete,
      outputVoiceCalibrationManifestSha256: createOutputVoiceCalibrationManifest(incomplete).manifestSha256,
    })).toThrow("requires six fixtures");

    const unsafePlan = frozenPlan();
    const unsafe = unsafePlan.outputVoiceCalibrationFixtures.map((fixture, index) => index === 0
      ? Object.freeze({ ...fixture, calibrationUnitId: "../escape" })
      : fixture);
    expect(() => createLongCallAsrCalibrationPlan({
      ...unsafePlan,
      outputVoiceCalibrationFixtures: unsafe,
      outputVoiceCalibrationManifestSha256: createOutputVoiceCalibrationManifest(unsafe).manifestSha256,
    })).toThrow("calibration unit ID is unsafe");

    const tamperedPlan = frozenPlan();
    const tampered = tamperedPlan.outputVoiceCalibrationFixtures.map((fixture, index) => index === 0
      ? Object.freeze({ ...fixture, captureReceipt: Object.freeze({ ...fixture.captureReceipt, pcmSha256: HASH }) })
      : fixture);
    expect(() => createLongCallAsrCalibrationPlan({
      ...tamperedPlan,
      outputVoiceCalibrationFixtures: tampered,
      outputVoiceCalibrationManifestSha256: createOutputVoiceCalibrationManifest(tampered).manifestSha256,
    })).toThrow("capture receipt hash is invalid");

    const captured = calibration.outputVoiceFixtures[0];
    expect(() => verifyOutputVoiceCalibrationPcm({
      fixture: captured,
      pcm: fixturePcm(captured.calibrationUnitId),
      expectedCaptureAuthoritySha256: CAPTURE_PUBLIC_KEY_SHA256,
    })).not.toThrow();
    expect(() => verifyOutputVoiceCalibrationPcm({
      fixture: captured,
      pcm: fixturePcm(captured.calibrationUnitId),
      expectedCaptureAuthoritySha256: HASH,
    })).toThrow("differs from the preregistered trust root");
    const corruptedPcm = fixturePcm(captured.calibrationUnitId);
    corruptedPcm[17] ^= 1;
    expect(() => verifyOutputVoiceCalibrationPcm({
      fixture: captured,
      pcm: corruptedPcm,
      expectedCaptureAuthoritySha256: CAPTURE_PUBLIC_KEY_SHA256,
    })).toThrow("does not match signed wire chunks");

    const manifest = createOutputVoiceCalibrationManifest(calibration.outputVoiceFixtures);
    const verificationReceipt = createOutputVoiceCaptureVerificationReceipt({
      manifest,
      expectedCaptureAuthoritySha256: CAPTURE_PUBLIC_KEY_SHA256,
      verificationImplementationSha256: sha256Hex("capture-verifier-v1"),
    });
    expect(() => verifyOutputVoiceCaptureVerificationReceipt({
      receipt: verificationReceipt,
      manifest,
      expectedCaptureAuthoritySha256: CAPTURE_PUBLIC_KEY_SHA256,
    })).not.toThrow();
    expect(() => verifyOutputVoiceCaptureVerificationReceipt({
      receipt: { ...verificationReceipt, verifiedFixtures: verificationReceipt.verifiedFixtures.slice(1) },
      manifest,
      expectedCaptureAuthoritySha256: CAPTURE_PUBLIC_KEY_SHA256,
    })).toThrow("invalid or incomplete");
  });

  it("passes exact transcripts and fail-closes missing evidence or semantic hallucinations", () => {
    const plan = createLongCallAsrCalibrationPlan(frozenPlan());
    const exact = exactTranscripts(plan);
    const pass = scoreLongCallAsrCalibration({ plan, transcripts: exact });
    expect(pass.gatePass).toBe(true);
    expect(pass.metrics).toMatchObject({
      plannedFixtures: plan.plannedFixtureCount,
      completedFixtures: plan.plannedFixtureCount,
      fixtureCoverage: 1,
      wordErrorRate: 0,
      criticalSlotFalseNegatives: 0,
      semanticSlotFalsePositives: 0,
    });

    const missing = scoreLongCallAsrCalibration({ plan, transcripts: exact.slice(1) });
    expect(missing.gatePass).toBe(false);
    expect(missing.metrics.completedFixtures).toBe(plan.plannedFixtureCount - 1);

    const invalidReceipt = scoreLongCallAsrCalibration({
      plan,
      transcripts: exact.map((transcript, index) => index === 0
        ? Object.freeze({ ...transcript, receiptSha256: "not-a-receipt" })
        : transcript),
    });
    expect(invalidReceipt.gatePass).toBe(false);
    expect(invalidReceipt.metrics.completedFixtures).toBe(plan.plannedFixtureCount - 1);

    const hallucinated = exact.map((transcript, index) => index === 0
      ? Object.freeze({ ...transcript, transcript: `${transcript.transcript} fifty-two percent` })
      : transcript);
    const failed = scoreLongCallAsrCalibration({ plan, transcripts: hallucinated });
    expect(failed.gatePass).toBe(false);
    expect(failed.metrics.semanticSlotFalsePositives).toBe(1);

    const outputFailure = scoreLongCallAsrCalibration({
      plan,
      transcripts: exact.map((transcript) => transcript.calibrationUnitId === plan.outputVoiceFixtures[0].calibrationUnitId
        ? Object.freeze({ ...transcript, transcript: "Calibration phrase omitted." })
        : transcript),
    });
    expect(outputFailure.gatePass).toBe(false);
    expect(outputFailure.outputVoiceMetrics.find((metrics) => metrics.provider === "openai")?.criticalSlotFalseNegatives).toBe(1);
  });

  it("hash-binds and verifies the final artifact against experiment inputs", () => {
    const plan = createLongCallAsrCalibrationPlan(frozenPlan());
    const scored = scoreLongCallAsrCalibration({
      plan,
      transcripts: exactTranscripts(plan),
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
      outputVoiceCalibrationManifestSha256: plan.outputVoiceCalibrationManifestSha256,
      asrConfigSha256: "b".repeat(64),
      requiredOutputVoiceRoutes: LONG_CALL_ASR_OUTPUT_VOICE_ROUTES,
      requirePassingGate: true,
    })).toEqual({ valid: true, errors: [] });
    expect(verifyLongCallAsrCalibrationArtifact({ ...artifact, gatePass: false }, {
      experimentPlanSha256: plan.experimentPlanSha256,
      fixtureManifestSha256: plan.fixtureManifestSha256,
      outputVoiceCalibrationManifestSha256: plan.outputVoiceCalibrationManifestSha256,
      asrConfigSha256: "b".repeat(64),
      requiredOutputVoiceRoutes: LONG_CALL_ASR_OUTPUT_VOICE_ROUTES,
    }).valid).toBe(false);
    const stale = verifyLongCallAsrCalibrationArtifact({ ...artifact, calibrationId: "HACC-LC3-ASR-CAL-v1" }, {
      experimentPlanSha256: plan.experimentPlanSha256,
      fixtureManifestSha256: plan.fixtureManifestSha256,
      outputVoiceCalibrationManifestSha256: plan.outputVoiceCalibrationManifestSha256,
      asrConfigSha256: "b".repeat(64),
      requiredOutputVoiceRoutes: LONG_CALL_ASR_OUTPUT_VOICE_ROUTES,
    });
    expect(stale.valid).toBe(false);
    expect(stale.errors).toContain("calibration ID mismatch");
  });
});
