import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import type {
  Lc4DevAudioManifest,
  Lc4DevRepairAudioManifest,
} from "../lc4-development-audio-materializer";
import { createLc4DevelopmentDefaultOperatorRuntime } from "../lc4-development-default-runtime";
import { createLc4DevLivePrepareArtifact } from "../lc4-development-live-runner";
import type { Lc4DevOperatorSigner } from "../lc4-development-operator-cli";
import {
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "../lc4-provider-profiles";

const LC4_REAL_ASR_INTEGRATION = process.env.LC4_REAL_ASR_INTEGRATION;

function requiredEnvironmentPath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when LC4_REAL_ASR_INTEGRATION is enabled`);
  return value;
}

function operatorSigner(): Lc4DevOperatorSigner {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return Object.freeze({
    private_key: pair.privateKey,
    public_key_spki_der: der,
    public_key_spki_pem: pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    private_key_pkcs8_pem: pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    public_key_fingerprint_sha256: sha256Hex(der),
  });
}

describe.runIf(Boolean(LC4_REAL_ASR_INTEGRATION))(
  "LC4-DEV default operator runtime with retained local assets",
  () => {
    it("verifies every provider-free dependency and derives stable real control/listener roots", async () => {
      const audioRoot = requiredEnvironmentPath("LC4_DEV_AUDIO_ROOT");
      const calibrationRoot = requiredEnvironmentPath("LC4_DEV_CALIBRATION_ROOT");
      const [manifest, repairManifest] = await Promise.all([
        readFile(`${audioRoot}/manifest.json`, "utf8").then(
          (value) => JSON.parse(value) as Lc4DevAudioManifest,
        ),
        readFile(`${audioRoot}/repair-manifest.json`, "utf8").then(
          (value) => JSON.parse(value) as Lc4DevRepairAudioManifest,
        ),
      ]);
      const runtime = await createLc4DevelopmentDefaultOperatorRuntime({
        audio_root: audioRoot,
        semantic_calibration_root: calibrationRoot,
        asr_runner_private_key_source: `${calibrationRoot}/runner-private-key.pem`,
        whisper_cli_path: requiredEnvironmentPath("LC4_DEV_WHISPER_CLI_PATH"),
        whisper_model_path: requiredEnvironmentPath("LC4_DEV_WHISPER_MODEL_PATH"),
        ffmpeg_path: requiredEnvironmentPath("LC4_DEV_FFMPEG_PATH"),
      });
      const prepare = createLc4DevLivePrepareArtifact({
        execution_id: "lc4-dev-default-runtime-provider-free-test",
        created_at: "2026-07-22T07:00:00.000Z",
        source_commit: "1".repeat(40),
        source_tree_sha256: "2".repeat(64),
        audio_manifest_sha256: manifest.manifest_sha256,
        audio_bindings: manifest.caller_audio_bindings,
        xai_finite_manual_gate_d: {
          receipt_sha256: sha256Hex("synthetic-gate-d-receipt"),
          plan_authority_trust_root_sha256:
            sha256Hex("synthetic-gate-d-authority"),
          transport_profile_sha256:
            LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
        },
      });
      const signer = operatorSigner();
      const evidenceRoot = requiredEnvironmentPath("LC4_DEV_EVIDENCE_ROOT");
      const first = await runtime.inspect({
        prepare,
        audio_manifest: manifest,
        repair_manifest: repairManifest,
        signer,
        evidence_root: evidenceRoot,
      });
      const second = await runtime.inspect({
        prepare,
        audio_manifest: manifest,
        repair_manifest: repairManifest,
        signer,
        evidence_root: evidenceRoot,
      });
      expect(first).toEqual(second);
      expect(first.control_plane_manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(first.listener_evidence_manifest_sha256).toMatch(
        /^[a-f0-9]{64}$/u,
      );
    }, 120_000);
  },
);
