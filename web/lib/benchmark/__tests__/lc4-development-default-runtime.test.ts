import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
  type Lc4DevAudioManifest,
  type Lc4DevRepairAudioManifest,
} from "../lc4-development-audio-materializer";
import {
  createLc4DevelopmentDefaultOperatorRuntime,
  createLc4DevelopmentDefaultRuntimeComposition,
} from "../lc4-development-default-runtime";
import { createLc4DevLivePrepareArtifact } from "../lc4-development-live-runner";
import {
  LC4_DEV_DEFAULT_RUNTIME_CLI_FLAGS,
  type Lc4DevOperatorSigner,
} from "../lc4-development-operator-cli";

const REAL = process.env.LC4_REAL_ASR_INTEGRATION === "1";
const AUDIO_ROOT = process.env.LC4_DEV_AUDIO_ROOT ?? "/private/tmp/hacc-lc4-dev-audio-v7";
const CALIBRATION_ROOT = process.env.LC4_DEV_CALIBRATION_ROOT ?? "/private/tmp/hacc-lc4-dev-semantic-asr-calibration-v4";

function operatorSigner(): Lc4DevOperatorSigner {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return Object.freeze({
    private_key: pair.privateKey,
    public_key_spki_der: der,
    public_key_spki_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key_pkcs8_pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    public_key_fingerprint_sha256: sha256Hex(der),
  });
}

describe("LC4-DEV default operator runtime", () => {
  it("requires every external runtime dependency as an explicit CLI flag", () => {
    expect(LC4_DEV_DEFAULT_RUNTIME_CLI_FLAGS).toEqual([
      "--semantic-calibration-root",
      "--asr-runner-private-key-source",
      "--whisper-cli-path",
      "--whisper-model-path",
      "--ffmpeg-path",
    ]);
    expect(new Set(LC4_DEV_DEFAULT_RUNTIME_CLI_FLAGS).size).toBe(5);
  });

  it("composes all audio, semantic, toolchain, signer, and criterion roots into one deterministic fail-closed root", () => {
    const input = {
      audio_manifest_sha256: "1".repeat(64),
      repair_manifest_sha256: "2".repeat(64),
      calibration_artifact_sha256: "3".repeat(64),
      calibration_sha256: "4".repeat(64),
      asr_contract_sha256: "5".repeat(64),
      whisper_config_sha256: "6".repeat(64),
      runner_public_key_sha256: "7".repeat(64),
      criterion_binding_set_sha256: "8".repeat(64),
      caller_binding_count: 180 as const,
      repair_binding_count: 72 as const,
    };
    const first = createLc4DevelopmentDefaultRuntimeComposition(input);
    expect(first).toEqual(createLc4DevelopmentDefaultRuntimeComposition(input));
    expect(first).toMatchObject({
      schema_version: 1,
      runtime_kind: "lc4-dev-default-operator-runtime",
      caller_binding_count: 180,
      repair_binding_count: 72,
    });
    expect(first.runtime_config_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(createLc4DevelopmentDefaultRuntimeComposition({ ...input, calibration_sha256: "9".repeat(64) }).runtime_config_sha256)
      .not.toBe(first.runtime_config_sha256);
    expect(() => createLc4DevelopmentDefaultRuntimeComposition({
      ...input,
      caller_binding_count: 179,
    } as unknown as Parameters<typeof createLc4DevelopmentDefaultRuntimeComposition>[0])).toThrow("exactly 180 caller and 72 repair bindings");
    expect(() => createLc4DevelopmentDefaultRuntimeComposition({
      ...input,
      runner_public_key_sha256: "not-a-hash",
    })).toThrow("runner_public_key_sha256");
  });

  it.runIf(REAL)("verifies every provider-free dependency and derives stable real control/listener roots", async () => {
    const [manifest, repairManifest] = await Promise.all([
      readFile(`${AUDIO_ROOT}/manifest.json`, "utf8").then((value) => JSON.parse(value) as Lc4DevAudioManifest),
      readFile(`${AUDIO_ROOT}/repair-manifest.json`, "utf8").then((value) => JSON.parse(value) as Lc4DevRepairAudioManifest),
    ]);
    const runtime = await createLc4DevelopmentDefaultOperatorRuntime({
      audio_root: AUDIO_ROOT,
      semantic_calibration_root: CALIBRATION_ROOT,
      asr_runner_private_key_source: `${CALIBRATION_ROOT}/runner-private-key.pem`,
      whisper_cli_path: "/opt/homebrew/Cellar/whisper-cpp/1.9.1/bin/whisper-cli",
      whisper_model_path: "/Users/harsha/.cache/hacc-benchmark/whisper/ggml-large-v3-turbo-q5_0.bin",
      ffmpeg_path: "/opt/homebrew/Cellar/ffmpeg@7/7.1.3_2/bin/ffmpeg",
    });
    const prepare = createLc4DevLivePrepareArtifact({
      execution_id: "lc4-dev-default-runtime-provider-free-test",
      created_at: "2026-07-22T07:00:00.000Z",
      source_commit: "1".repeat(40),
      source_tree_sha256: "2".repeat(64),
      audio_manifest_sha256: manifest.manifest_sha256,
      audio_bindings: manifest.caller_audio_bindings,
    });
    const signer = operatorSigner();
    const first = await runtime.inspect({
      prepare,
      audio_manifest: manifest,
      repair_manifest: repairManifest,
      signer,
      evidence_root: "/private/tmp/lc4-dev-default-runtime-provider-free-test",
    });
    const second = await runtime.inspect({
      prepare,
      audio_manifest: manifest,
      repair_manifest: repairManifest,
      signer,
      evidence_root: "/private/tmp/lc4-dev-default-runtime-provider-free-test",
    });
    expect(first).toEqual(second);
    expect(first.control_plane_manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.listener_evidence_manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
  }, 120_000);
});
