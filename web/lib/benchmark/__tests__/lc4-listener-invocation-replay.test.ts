import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
  createIndependentAsrRequest,
  independentAsrContractSha256,
  runIndependentAsrAdapter,
  type IndependentAsrContract,
  type IndependentAsrResult,
} from "../audible-evidence";
import {
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationTrust,
} from "../kernel-attestation";
import {
  lc4DevelopmentAsrBlindNonceSha256,
} from "../lc4-development-listener-semantics";
import {
  replayLc4ListenerInvocation,
  verifyLc4ListenerInvocation,
} from "../lc4-listener-invocation-replay";

const RUN_ID = "lc4-dev-openai-native";
const OPPORTUNITY_ID = "lc4-dev-op-01";
const CRITERION_PLAN_SHA256 = sha256Hex("criterion-plan");
const PCM = Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]);
const TRANSCRIPT = "Archive access is available.";
const TRANSCRIPT_SHA256 = sha256Hex(Buffer.from(TRANSCRIPT, "utf8"));

const CONTRACT: IndependentAsrContract = Object.freeze({
  schema_version: 1,
  contract_id: "lc4-listener-invocation-replay-test",
  engine: Object.freeze({
    implementation: "whisper.cpp",
    source_repository: "https://github.com/ggml-org/whisper.cpp",
    source_revision: "a".repeat(40),
    executable_sha256: "1".repeat(64),
    dependency_lock_sha256: "2".repeat(64),
    model_id: "ggml-large-v3",
    model_revision: "b".repeat(40),
    weights_sha256: "3".repeat(64),
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
  resampling_profile_sha256: "4".repeat(64),
  result_schema_sha256: INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
});

function identity(keyId: string): Readonly<{
  signer: BenchmarkKernelAttestationSigner;
  trust: BenchmarkKernelAttestationTrust;
}> {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicKeyPem = pair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId,
    privateKeyPem,
    publicKeyPem,
  });
  return Object.freeze({
    signer,
    trust: Object.freeze({
      keyId,
      publicKeySha256: signer.publicKeySha256,
      publicKeyPem,
    }),
  });
}

const RUNNER = identity("lc4-asr-runner");
const OTHER_RUNNER = identity("other-lc4-asr-runner");

function result(
  request: ReturnType<typeof createIndependentAsrRequest>,
): IndependentAsrResult {
  return Object.freeze({
    status: "completed" as const,
    source_request_sha256: request.request_sha256,
    source_played_audio_sha256: request.source_played_audio_sha256,
    source_chunk_sequence_sha256: request.source_chunk_sequence_sha256,
    language: "en",
    transcript: TRANSCRIPT,
    processed_through_sample: request.played_sample_count,
    no_speech_probability_ppm: 1_000,
    spans: Object.freeze([{
      span_id: "span-001",
      text: TRANSCRIPT,
      utf8_start: 0,
      utf8_end: 28,
      audio_start_sample: 0,
      audio_end_sample: request.played_sample_count,
      confidence_ppm: 990_000,
    }]),
  });
}

async function fixture(
  signer = RUNNER.signer,
  sampleRateHz = 24_000,
  unavailable = false,
): Promise<Readonly<{
  artifact: Uint8Array;
  receiptSha256: string;
}>> {
  const sourcePcmSha256 = sha256Hex(PCM);
  const blindNonceSha256 = lc4DevelopmentAsrBlindNonceSha256({
    source_pcm_sha256: sourcePcmSha256,
    source_pcm_byte_length: PCM.byteLength,
    criterion_plan_sha256: CRITERION_PLAN_SHA256,
    evaluator_contract_sha256: independentAsrContractSha256(CONTRACT),
  });
  const requestIdentity = sha256Hex(`${blindNonceSha256}\n${RUN_ID}`)
    .slice(0, 24);
  const request = createIndependentAsrRequest({
    runId: RUN_ID,
    unitId: `listener-${OPPORTUNITY_ID}`,
    invocationId: `lc4-dev-asr-${requestIdentity}`,
    adapterBlindNonceSha256: blindNonceSha256,
    contract: CONTRACT,
    chunks: Object.freeze([{
      chunkId: "captured-output",
      encoding: "pcm16",
      sampleRateHz,
      channels: 1,
      data: PCM,
    }]),
    playedThroughByte: PCM.byteLength,
  });
  const invocation = await runIndependentAsrAdapter({
    request,
    contract: CONTRACT,
    runnerSigner: signer,
    execute: () => ({
      result: unavailable
        ? {
            status: "unavailable" as const,
            reason_code: "fixture_unavailable",
            reason: "fixture unavailable",
          }
        : result(request),
      exitCode: 0,
      runtimeMs: 3,
      stdout: "whisper normalized output",
      stderr: "",
    }),
  });
  const artifact = Buffer.from(canonicalJson({
    request: {
      schema_version: request.schema_version,
      run_id: request.run_id,
      unit_id: request.unit_id,
      invocation_id: request.invocation_id,
      adapter_blind_nonce_sha256: request.adapter_blind_nonce_sha256,
      asr_contract_sha256: request.asr_contract_sha256,
      format: request.format,
      played_sample_count: request.played_sample_count,
      source_played_audio_sha256: request.source_played_audio_sha256,
      source_chunk_sequence_sha256: request.source_chunk_sequence_sha256,
      request_sha256: request.request_sha256,
    },
    result: invocation.result,
    receipt: invocation.receipt,
  }), "utf8");
  return Object.freeze({
    artifact: new Uint8Array(artifact),
    receiptSha256: invocation.receipt.receipt_sha256,
  });
}

function replayInput(
  retained: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Parameters<typeof replayLc4ListenerInvocation>[0]> = {},
): Parameters<typeof replayLc4ListenerInvocation>[0] {
  return {
    artifact_bytes: retained.artifact,
    signed_invocation_artifact_cas_sha256: sha256Hex(retained.artifact),
    signed_invocation_artifact_byte_length: retained.artifact.byteLength,
    signed_invocation_receipt_sha256: retained.receiptSha256,
    run_id: RUN_ID,
    opportunity_id: OPPORTUNITY_ID,
    criterion_plan_sha256: CRITERION_PLAN_SHA256,
    source_pcm: PCM,
    source_sample_rate_hz: 24_000,
    expected_transcript_sha256: TRANSCRIPT_SHA256,
    asr_contract: CONTRACT,
    runner_trust: RUNNER.trust,
    expected_runner_key_id: RUNNER.trust.keyId,
    expected_runner_public_key_sha256: RUNNER.trust.publicKeySha256,
    ...overrides,
  };
}

describe("LC4 listener signed invocation replay", () => {
  it("replays exact CAS bytes through the preflight-bound runner trust root", async () => {
    const retained = await fixture();
    const verified = verifyLc4ListenerInvocation(replayInput(retained));
    const replay = verified.replay;

    expect(verified.transcript).toBe(TRANSCRIPT);
    expect(replayLc4ListenerInvocation(replayInput(retained))).toEqual(replay);
    expect(replay.source_pcm_sha256).toBe(sha256Hex(PCM));
    expect(replay.source_sample_rate_hz).toBe(24_000);
    expect(replay.transcript_sha256).toBe(TRANSCRIPT_SHA256);
    expect(replay.signed_invocation_receipt_sha256)
      .toBe(retained.receiptSha256);
    expect(replay.signed_invocation_artifact_cas_sha256)
      .toBe(sha256Hex(retained.artifact));
    expect(replay.runner_public_key_sha256)
      .toBe(RUNNER.trust.publicKeySha256);
    expect(replay.replay_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects swapped CAS bytes, lengths, and addresses", async () => {
    const retained = await fixture();
    const swapped = Uint8Array.from(retained.artifact);
    swapped[0] ^= 1;
    expect(() => replayLc4ListenerInvocation(replayInput(retained, {
      artifact_bytes: swapped,
    }))).toThrow(/CAS-substituted/u);
    expect(() => replayLc4ListenerInvocation(replayInput(retained, {
      signed_invocation_artifact_byte_length:
        retained.artifact.byteLength + 1,
    }))).toThrow(/CAS-substituted/u);
    expect(() => replayLc4ListenerInvocation(replayInput(retained, {
      signed_invocation_artifact_cas_sha256: "f".repeat(64),
    }))).toThrow(/CAS-substituted/u);
  });

  it("rejects criterion, PCM, contract, and opportunity substitutions", async () => {
    const retained = await fixture();
    expect(() => replayLc4ListenerInvocation(replayInput(retained, {
      criterion_plan_sha256: sha256Hex("other criterion"),
    }))).toThrow(/exact PCM, criterion, contract, or run identity/u);
    expect(() => replayLc4ListenerInvocation(replayInput(retained, {
      source_pcm: Uint8Array.from([9, 0, 8, 0]),
    }))).toThrow(/exact PCM, criterion, contract, or run identity/u);
    expect(() => replayLc4ListenerInvocation(replayInput(retained, {
      opportunity_id: "lc4-dev-op-02",
    }))).toThrow(/identity or PCM format/u);
  });

  it("rejects a correctly signed invocation that interprets the exact PCM at the wrong sample rate", async () => {
    const retained = await fixture(RUNNER.signer, 16_000);
    expect(() => replayLc4ListenerInvocation(replayInput(retained)))
      .toThrow(/identity or PCM format/u);
  });

  it("rejects transcript substitution and a correctly signed unavailable ASR result", async () => {
    const retained = await fixture();
    expect(() => replayLc4ListenerInvocation(replayInput(retained, {
      expected_transcript_sha256: sha256Hex("foreign transcript"),
    }))).toThrow(/transcript differs/u);

    const unavailable = await fixture(RUNNER.signer, 24_000, true);
    expect(() => replayLc4ListenerInvocation(replayInput(unavailable)))
      .toThrow(/completed nonempty ASR result/u);
  });

  it("rejects a self-asserted runner key that differs from preflight", async () => {
    const retained = await fixture(OTHER_RUNNER.signer);
    expect(() => replayLc4ListenerInvocation(replayInput(retained, {
      runner_trust: OTHER_RUNNER.trust,
    }))).toThrow(/differs from signed preflight/u);
  });

  it("rejects a tampered signature even when the attacker re-addresses the JSON", async () => {
    const retained = await fixture();
    const parsed = JSON.parse(
      Buffer.from(retained.artifact).toString("utf8"),
    ) as {
      receipt: { signature: { signature_base64: string } };
    };
    parsed.receipt.signature.signature_base64 =
      Buffer.alloc(64, 7).toString("base64");
    const tampered = Buffer.from(canonicalJson(parsed), "utf8");
    expect(() => replayLc4ListenerInvocation(replayInput(retained, {
      artifact_bytes: tampered,
      signed_invocation_artifact_cas_sha256: sha256Hex(tampered),
      signed_invocation_artifact_byte_length: tampered.byteLength,
    }))).toThrow(/signature verification failed/u);
  });
});
