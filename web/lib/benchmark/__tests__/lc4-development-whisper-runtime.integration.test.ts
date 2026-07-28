import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
  prepareLc4DevelopmentSemanticCalibrationFromArtifact,
  verifyLc4DevelopmentSemanticCalibrationArtifact,
  type Lc4DevelopmentSemanticCalibrationArtifact,
} from "../lc4-development-asr-calibration-artifact";
import {
  LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
  createLc4DevelopmentPinnedListenerEvaluator,
} from "../lc4-development-listener-semantics";
import { createLc4DevelopmentLargeV3WhisperRuntime } from "../lc4-development-whisper-runtime";
import { createBenchmarkKernelAttestationSigner } from "../kernel-attestation";

const LC4_REAL_ASR_INTEGRATION = process.env.LC4_REAL_ASR_INTEGRATION;
function requiredEnvironmentPath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when LC4_REAL_ASR_INTEGRATION is enabled`);
  return value;
}

function integrationPaths() {
  return Object.freeze({
    whisper_cli_path: requiredEnvironmentPath("LC4_DEV_WHISPER_CLI_PATH"),
    model_path: requiredEnvironmentPath("LC4_DEV_WHISPER_MODEL_PATH"),
    ffmpeg_path: requiredEnvironmentPath("LC4_DEV_FFMPEG_PATH"),
  });
}

describe.runIf(Boolean(LC4_REAL_ASR_INTEGRATION))(
  "LC4-DEV pinned whisper.cpp runtime with retained local assets",
  () => {
    it("transcribes retained provider PCM through the real pinned binaries", async () => {
      const runtime = createLc4DevelopmentLargeV3WhisperRuntime(integrationPaths());
      const pcm = new Uint8Array(
        await readFile(requiredEnvironmentPath("LC4_DEV_REAL_ASR_PCM_PATH")),
      );
      const execution = await runtime.execute_asr(
        Object.freeze({
          schema_version: 1 as const,
          adapter_blind_nonce_sha256: sha256Hex(
            "lc4-real-asr-integration-blind-nonce",
          ),
          asr_contract_sha256: runtime.contract_sha256,
          source_request_sha256: sha256Hex("lc4-real-asr-integration-request"),
          source_chunk_sequence_sha256: sha256Hex(
            "lc4-real-asr-integration-chunks",
          ),
          format: Object.freeze({
            encoding: "pcm16" as const,
            endianness: "little" as const,
            sample_rate_hz: 24_000,
            channels: 1 as const,
          }),
          played_sample_count: pcm.byteLength / 2,
          played_pcm: pcm,
        }),
      );
      expect(execution.exitCode).toBe(0);
      expect(execution.result).toMatchObject({
        status: "completed",
        transcript: "The corrected identifier is A-71.",
        source_played_audio_sha256: sha256Hex(pcm),
      });
    }, 120_000);

    it("verifies retained calibration and evaluates real PCM through the signed listener boundary", async () => {
      const calibrationRoot = requiredEnvironmentPath("LC4_DEV_CALIBRATION_ROOT");
      const artifactBytes = await readFile(
        `${calibrationRoot}/calibration-artifact.json`,
      );
      const artifact = JSON.parse(
        artifactBytes.toString("utf8"),
      ) as Lc4DevelopmentSemanticCalibrationArtifact;
      expect(
        await verifyLc4DevelopmentSemanticCalibrationArtifact({
          artifact,
          root_dir: calibrationRoot,
        }),
      ).toEqual({ valid: true, errors: [] });
      const tampered = JSON.parse(JSON.stringify(artifact)) as {
        fixtures: Array<{ pcm_sha256: string }>;
      };
      tampered.fixtures[0].pcm_sha256 = "0".repeat(64);
      expect(
        await verifyLc4DevelopmentSemanticCalibrationArtifact({
          artifact: tampered,
          root_dir: calibrationRoot,
        }),
      ).toMatchObject({ valid: false });
      const calibration =
        await prepareLc4DevelopmentSemanticCalibrationFromArtifact({
          artifact,
          root_dir: calibrationRoot,
        });
      const runtime = createLc4DevelopmentLargeV3WhisperRuntime(integrationPaths());
      const signer = createBenchmarkKernelAttestationSigner({
        keyId: artifact.runner_trust.keyId,
        privateKeyPem: await readFile(
          `${calibrationRoot}/runner-private-key.pem`,
          "utf8",
        ),
        publicKeyPem: artifact.runner_trust.publicKeyPem,
      });
      const retained: Uint8Array[] = [];
      const evaluator = createLc4DevelopmentPinnedListenerEvaluator({
        asr_contract: runtime.contract,
        asr_calibration: calibration,
        asr_runner_signer: signer,
        execute_asr: runtime.execute_asr,
        retention: {
          async put(bytes) {
            const copy = Uint8Array.from(bytes);
            retained.push(copy);
            return Object.freeze({
              artifact_sha256: sha256Hex(copy),
              byte_length: copy.byteLength,
            });
          },
        },
      });
      const fixture = artifact.fixtures.find(
        (candidate) => candidate.fixture_id === "lc4-dev-synthetic-samantha-06",
      );
      if (!fixture)
        throw new Error("retained LC4-DEV integration fixture is unavailable");
      const pcm = new Uint8Array(
        await readFile(`${calibrationRoot}/${fixture.pcm_path}`),
      );
      const evaluation = await evaluator.evaluate({
        run_id: "lc4-dev-real-asr-integration",
        opportunity_id: fixture.opportunity_id,
        provider: "openai",
        sample_rate_hz: 24_000,
        pcm,
        criterion_plan_sha256: fixture.criterion_plan_sha256,
      });
      expect(evaluator.calibration_sha256).toBe(artifact.calibration_sha256);
      expect(evaluation).toMatchObject({
        source_pcm_sha256: fixture.pcm_sha256,
        evaluator_contract_sha256: runtime.contract_sha256,
        evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
        calibration_sha256: artifact.calibration_sha256,
        repair_projection: {
          listener_status: "verified",
          unmet_blocker_codes: [],
          final_required_criteria_pass: true,
        },
      });
      expect(retained).toHaveLength(2);
    }, 120_000);
  },
);
