import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createLc4DevelopmentDefaultRuntimeComposition } from "../lc4-development-default-runtime";
import { LC4_DEV_DEFAULT_RUNTIME_CLI_FLAGS } from "../lc4-development-operator-cli";
import {
  LC4_TEST_ASR_CONTRACT,
  LC4_TEST_ASR_CONTRACT_SHA256,
  createLc4TestAsrRunnerTrust,
} from "./lc4-test-asr-authority";

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
    const asrKeys = generateKeyPairSync("ed25519");
    const input = {
      audio_manifest_sha256: "1".repeat(64),
      repair_manifest_sha256: "2".repeat(64),
      calibration_artifact_sha256: "3".repeat(64),
      calibration_sha256: "4".repeat(64),
      asr_contract: LC4_TEST_ASR_CONTRACT,
      asr_contract_sha256: LC4_TEST_ASR_CONTRACT_SHA256,
      whisper_config_sha256: "6".repeat(64),
      asr_evaluator_build_sha256: "7".repeat(64),
      asr_evaluator_toolchain_sha256: "8".repeat(64),
      asr_runner_trust: createLc4TestAsrRunnerTrust(asrKeys.publicKey),
      criterion_binding_set_sha256: "a".repeat(64),
      caller_binding_count: 180 as const,
      repair_binding_count: 72 as const,
    };
    const first = createLc4DevelopmentDefaultRuntimeComposition(input);
    expect(first).toEqual(createLc4DevelopmentDefaultRuntimeComposition(input));
    expect(first).toMatchObject({
      schema_version: 3,
      runtime_kind: "lc4-dev-default-operator-runtime",
      caller_binding_count: 180,
      repair_binding_count: 72,
    });
    expect(first.runtime_config_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      createLc4DevelopmentDefaultRuntimeComposition({
        ...input,
        calibration_sha256: "9".repeat(64),
      }).runtime_config_sha256,
    ).not.toBe(first.runtime_config_sha256);
    expect(
      createLc4DevelopmentDefaultRuntimeComposition({
        ...input,
        asr_evaluator_toolchain_sha256: "b".repeat(64),
      }).runtime_config_sha256,
    ).not.toBe(first.runtime_config_sha256);
    expect(() =>
      createLc4DevelopmentDefaultRuntimeComposition({
        ...input,
        caller_binding_count: 179,
      } as unknown as Parameters<
        typeof createLc4DevelopmentDefaultRuntimeComposition
      >[0]),
    ).toThrow("exactly 180 caller and 72 repair bindings");
    expect(() =>
      createLc4DevelopmentDefaultRuntimeComposition({
        ...input,
        asr_runner_trust: {
          ...input.asr_runner_trust,
          public_key_fingerprint_sha256: "9".repeat(64),
        },
      }),
    ).toThrow("pinned Ed25519 trust root");
  });
});
