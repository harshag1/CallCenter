import { createPublicKey, type KeyObject } from "node:crypto";

import {
  INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
  independentAsrContractSha256,
  type IndependentAsrContract,
} from "../audible-evidence";
import { sha256Hex } from "../artifacts";
import {
  createLc4DevAsrRunnerTrust,
  type Lc4DevAsrRunnerTrust,
} from "../lc4-development-live-runner";

export const LC4_TEST_ASR_CONTRACT: IndependentAsrContract = Object.freeze({
  schema_version: 1,
  contract_id: "lc4-test-independent-asr-v1",
  engine: Object.freeze({
    implementation: "whisper.cpp",
    source_repository: "https://github.com/ggml-org/whisper.cpp",
    source_revision: "1".repeat(40),
    executable_sha256: sha256Hex("lc4-test-asr-executable"),
    dependency_lock_sha256: sha256Hex("lc4-test-asr-dependency-lock"),
    model_id: "openai/whisper-large-v3-turbo@lc4-test",
    model_revision: "2".repeat(40),
    weights_sha256: sha256Hex("lc4-test-asr-weights"),
  }),
  decoding: Object.freeze({
    language: "en",
    task: "transcribe",
    temperature_milli: 0,
    beam_size: 5,
    best_of: 5,
    word_timestamps: true,
    condition_on_previous_text: false,
    initial_prompt_sha256: null,
  }),
  resampling_profile_sha256: sha256Hex("lc4-test-resampling-profile"),
  result_schema_sha256: INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
});

export const LC4_TEST_ASR_CONTRACT_SHA256 =
  independentAsrContractSha256(LC4_TEST_ASR_CONTRACT);

export function createLc4TestAsrRunnerTrust(
  publicKey: KeyObject,
  keyId = "lc4-test-asr-runner",
): Lc4DevAsrRunnerTrust {
  const normalized = publicKey.type === "public"
    ? publicKey
    : createPublicKey(publicKey);
  const der = normalized.export({ format: "der", type: "spki" });
  return createLc4DevAsrRunnerTrust({
    key_id: keyId,
    public_key_spki_base64: der.toString("base64"),
    public_key_fingerprint_sha256: sha256Hex(der),
    signature_algorithm: "Ed25519",
  });
}
