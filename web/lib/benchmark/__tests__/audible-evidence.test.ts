import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
  conditionBlindListenerObservation,
  createAudibleSemanticEvidenceArtifact,
  createIndependentAsrRequest,
  independentAsrCalibrationSha256,
  independentAsrContractSha256,
  listenerObservationFromVerifiedEvidence,
  lookupVerifiedAudibleSemanticUnit,
  prepareAudibleSemanticUnit,
  prepareIndependentAsrCalibration,
  runIndependentAsrAdapter,
  serializeAudibleSemanticEvidence,
  verifyAudibleSemanticEvidence,
  verifyIndependentAsrInvocation,
  type AsrCalibrationSourceFixture,
  type AudiblePcmChunk,
  type AudibleSemanticEvidenceArtifact,
  type IndependentAsrCalibration,
  type IndependentAsrCalibrationPlan,
  type IndependentAsrContract,
  type IndependentAsrRequest,
  type IndependentAsrResult,
  type PreparedAudibleSemanticUnit,
  type PreparedIndependentAsrCalibration,
  type VerifiedIndependentAsrInvocation,
} from "../audible-evidence";
import {
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationTrust,
} from "../kernel-attestation";

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Uint8Array
    ? Uint8Array
    : T extends readonly (infer Item)[]
      ? DeepMutable<Item>[]
      : T extends object
        ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
        : T;

function signingIdentity(keyId: string): Readonly<{
  signer: BenchmarkKernelAttestationSigner;
  trust: BenchmarkKernelAttestationTrust;
}> {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({ keyId, privateKeyPem, publicKeyPem });
  return Object.freeze({
    signer,
    trust: Object.freeze({ keyId, publicKeySha256: signer.publicKeySha256, publicKeyPem }),
  });
}

const artifactIdentity = signingIdentity("audible-artifact-test-key-v2");
const runnerIdentity = signingIdentity("audible-runner-test-key-v2");
const otherRunnerIdentity = signingIdentity("audible-other-runner-key-v2");

const contract: IndependentAsrContract = Object.freeze({
  schema_version: 1,
  contract_id: "whisper-cpp-base-en-test-v2",
  engine: Object.freeze({
    implementation: "whisper.cpp",
    source_repository: "https://github.com/ggml-org/whisper.cpp",
    source_revision: "a".repeat(40),
    executable_sha256: "1".repeat(64),
    dependency_lock_sha256: "2".repeat(64),
    model_id: "ggml-base.en",
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

const calibrationPlan: IndependentAsrCalibrationPlan = Object.freeze({
  calibration_id: "balanced-held-out-calibration-v2",
  protocol_sha256: "5".repeat(64),
  corpus_manifest_sha256: "6".repeat(64),
  evaluator_build_sha256: "7".repeat(64),
  expected_route_ids: Object.freeze(["baseline", "harness"]),
  thresholds: Object.freeze({
    min_fixture_coverage_ppm: 950_000,
    max_word_error_upper_bound_ppm: 100_000,
    max_semantic_false_negative_upper_bound_ppm: 100_000,
    max_semantic_false_positive_upper_bound_ppm: 100_000,
    max_alignment_boundary_p95_ms: 250,
    max_route_word_error_gap_ppm: 50_000,
  }),
});

const RUN_ID = "run-audible-evidence-002";
const TIMELINE_SHA256 = "8".repeat(64);
const TRANSCRIPT_SET_SHA256 = "9".repeat(64);
const BLIND_OBSERVATION_NONCE_SHA256 = "e".repeat(64);
const ADAPTER_BLIND_NONCE_SHA256 = "0".repeat(64);

function pcmChunks(sampleRateHz = 16_000): AudiblePcmChunk[] {
  return [
    {
      chunkId: "chunk-000",
      encoding: "pcm16",
      sampleRateHz,
      channels: 1,
      data: Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]),
    },
    {
      chunkId: "chunk-001",
      encoding: "pcm16",
      sampleRateHz,
      channels: 1,
      data: Uint8Array.from([5, 0, 6, 0, 7, 0, 8, 0]),
    },
  ];
}

function calibrationPcm(index: number): AudiblePcmChunk[] {
  const value = index + 1;
  return [
    {
      chunkId: "cal-chunk-000",
      encoding: "pcm16",
      sampleRateHz: 16_000,
      channels: 1,
      data: Uint8Array.from([value, 0, value + 1, 0, value + 2, 0, value + 3, 0]),
    },
    {
      chunkId: "cal-chunk-001",
      encoding: "pcm16",
      sampleRateHz: 16_000,
      channels: 1,
      data: Uint8Array.from([value + 4, 0, value + 5, 0, value + 6, 0, value + 7, 0]),
    },
  ];
}

function request(input: Readonly<{
  runId?: string;
  unitId?: string;
  invocationId?: string;
  adapterBlindNonceSha256?: string;
  fixtureContract?: IndependentAsrContract;
  chunks?: readonly AudiblePcmChunk[];
  playedThroughByte?: number;
}> = {}): IndependentAsrRequest {
  return createIndependentAsrRequest({
    runId: input.runId ?? RUN_ID,
    unitId: input.unitId ?? "unit-001",
    invocationId: input.invocationId ?? "invocation-001",
    adapterBlindNonceSha256: input.adapterBlindNonceSha256 ?? ADAPTER_BLIND_NONCE_SHA256,
    contract: input.fixtureContract ?? contract,
    chunks: input.chunks ?? pcmChunks(),
    playedThroughByte: input.playedThroughByte ?? 16,
  });
}

function completedAsr(
  source: IndependentAsrRequest,
  overrides: Partial<Extract<IndependentAsrResult, { status: "completed" }>> = {}
): Extract<IndependentAsrResult, { status: "completed" }> {
  const transcript = overrides.transcript ?? "hello world";
  const transcriptBytes = Buffer.byteLength(transcript, "utf8");
  return {
    status: "completed",
    source_request_sha256: source.request_sha256,
    source_played_audio_sha256: source.source_played_audio_sha256,
    source_chunk_sequence_sha256: source.source_chunk_sequence_sha256,
    language: "en",
    transcript,
    processed_through_sample: source.played_sample_count,
    no_speech_probability_ppm: 10_000,
    spans: transcriptBytes === 0 ? [] : [{
      span_id: "span-000",
      text: transcript,
      utf8_start: 0,
      utf8_end: transcriptBytes,
      audio_start_sample: 0,
      audio_end_sample: source.played_sample_count,
      confidence_ppm: 950_000,
    }],
    ...overrides,
  };
}

async function invocation(input: Readonly<{
  source?: IndependentAsrRequest;
  result?: IndependentAsrResult;
  runnerSigner?: BenchmarkKernelAttestationSigner;
  mutateAdapterPcm?: boolean;
}> = {}): Promise<VerifiedIndependentAsrInvocation> {
  const source = input.source ?? request();
  return runIndependentAsrAdapter({
    request: source,
    contract,
    runnerSigner: input.runnerSigner ?? runnerIdentity.signer,
    execute(adapterInput) {
      if (input.mutateAdapterPcm) adapterInput.played_pcm[0] ^= 0xff;
      return {
        result: input.result ?? completedAsr(source),
        exitCode: 0,
        runtimeMs: 2,
        stdout: "normalized-whisper-output",
        stderr: "",
      };
    },
  });
}

let calibrationFixtures: AsrCalibrationSourceFixture[];
let preparedCalibration: PreparedIndependentAsrCalibration;

beforeAll(async () => {
  calibrationFixtures = [];
  for (const routeId of ["baseline", "harness"] as const) {
    for (let index = 0; index < 32; index += 1) {
      const fixtureId = `cal-${routeId}-${String(index).padStart(3, "0")}`;
      const source = request({
        runId: "calibration-run-v2",
        unitId: fixtureId,
        invocationId: `inv-${fixtureId}`,
        adapterBlindNonceSha256: sha256Hex(`adapter-blind:${fixtureId}`),
        chunks: calibrationPcm(index),
      });
      calibrationFixtures.push(Object.freeze({
        fixture_id: fixtureId,
        route_id: routeId,
        split: "held_out",
        corpus_sample_id: `sample-${String(index).padStart(3, "0")}`,
        reference_transcript: "hello world",
        expected_semantic_phrases: Object.freeze(["hello", "world"]),
        forbidden_semantic_phrases: Object.freeze(["invented", "fraud"]),
        reference_audio_start_sample: 0,
        reference_audio_end_sample: source.played_sample_count,
        invocation: await invocation({ source }),
      }));
    }
  }
  preparedCalibration = prepareIndependentAsrCalibration({
    plan: calibrationPlan,
    contract,
    fixtures: calibrationFixtures,
    runnerTrust: runnerIdentity.trust,
  });
});

async function preparedFixture(input: Readonly<{
  source?: IndependentAsrRequest;
  asrInvocation?: VerifiedIndependentAsrInvocation;
  blindObservationId?: string;
}> = {}): Promise<Readonly<{
  source: IndependentAsrRequest;
  asrInvocation: VerifiedIndependentAsrInvocation;
  unit: PreparedAudibleSemanticUnit;
}>> {
  const source = input.source ?? request();
  const asrInvocation = input.asrInvocation ?? await invocation({ source });
  return Object.freeze({
    source,
    asrInvocation,
    unit: prepareAudibleSemanticUnit({
      runId: RUN_ID,
      unitId: "unit-001",
      responseId: "response-001",
      blindObservationId: input.blindObservationId ?? BLIND_OBSERVATION_NONCE_SHA256,
      turn: 1,
      audioArtifactPath: "audio/unit-001.pcm",
      asrInvocation,
      contract,
      calibration: preparedCalibration,
    }),
  });
}

async function artifactFixture(unit?: PreparedAudibleSemanticUnit): Promise<AudibleSemanticEvidenceArtifact> {
  const prepared = unit ?? (await preparedFixture()).unit;
  return createAudibleSemanticEvidenceArtifact({
    runId: RUN_ID,
    timelineSha256: TIMELINE_SHA256,
    transcriptSetSha256: TRANSCRIPT_SET_SHA256,
    contract,
    calibration: preparedCalibration,
    units: [prepared],
    signer: artifactIdentity.signer,
  });
}

function verificationInput(
  artifact: unknown,
  overrides: Readonly<{
    chunks?: readonly AudiblePcmChunk[];
    playedThroughByte?: number;
    runId?: string;
    timelineSha256?: string;
    transcriptSetSha256?: string;
    fixtureContract?: IndependentAsrContract;
    fixtures?: readonly AsrCalibrationSourceFixture[];
    plan?: IndependentAsrCalibrationPlan;
    runnerTrust?: BenchmarkKernelAttestationTrust;
    artifactTrust?: BenchmarkKernelAttestationTrust;
    invocationId?: string;
    adapterBlindNonceSha256?: string;
    blindObservationId?: string;
  }> = {}
) {
  return {
    artifact,
    expected: {
      runId: overrides.runId ?? RUN_ID,
      timelineSha256: overrides.timelineSha256 ?? TIMELINE_SHA256,
      transcriptSetSha256: overrides.transcriptSetSha256 ?? TRANSCRIPT_SET_SHA256,
      contract: overrides.fixtureContract ?? contract,
      calibrationEvidence: {
        plan: overrides.plan ?? calibrationPlan,
        fixtures: overrides.fixtures ?? calibrationFixtures,
      },
      unitIds: ["unit-001"],
      trust: overrides.artifactTrust ?? artifactIdentity.trust,
      runnerTrust: overrides.runnerTrust ?? runnerIdentity.trust,
    },
    pcm: [{
      unitId: "unit-001",
      responseId: "response-001",
      blindObservationId: overrides.blindObservationId ?? BLIND_OBSERVATION_NONCE_SHA256,
      invocationId: overrides.invocationId ?? "invocation-001",
      adapterBlindNonceSha256: overrides.adapterBlindNonceSha256 ?? ADAPTER_BLIND_NONCE_SHA256,
      turn: 1,
      audioArtifactPath: "audio/unit-001.pcm",
      chunks: overrides.chunks ?? pcmChunks(),
      playedThroughByte: overrides.playedThroughByte ?? 16,
    }],
  } as const;
}

function mutable<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

describe("independent audible semantic evidence v2", () => {
  it("derives a balanced held-out calibration from raw labels and signed ASR outputs", () => {
    expect(preparedCalibration.summary).toMatchObject({
      status: "calibrated",
      asr_contract_sha256: independentAsrContractSha256(contract),
      fixture_count: 64,
      route_metrics: [
        { route_id: "baseline", fixture_count: 32, word_error_rate_ppm: 0 },
        { route_id: "harness", fixture_count: 32, word_error_rate_ppm: 0 },
      ],
      metrics: {
        word_error_rate_ppm: 0,
        semantic_false_negative_rate_ppm: 0,
        semantic_false_positive_rate_ppm: 0,
        alignment_boundary_p95_ms: 0,
        fixture_coverage_ppm: 1_000_000,
      },
      unvalidated_reasons: [],
    });
    expect(preparedCalibration.summary.asr_outputs_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preparedCalibration.summary.human_labels_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("makes online units and post-run verification invariant to unheard tails but sensitive to audible bytes, order, and format", async () => {
    const base = request({ playedThroughByte: 12 });
    const withFutureChunk = request({
      playedThroughByte: 12,
      chunks: [...pcmChunks(), {
        chunkId: "chunk-002",
        encoding: "pcm16",
        sampleRateHz: 16_000,
        channels: 1,
        data: Uint8Array.from([9, 0, 10, 0]),
      }],
    });
    const extendedTerminal = pcmChunks();
    extendedTerminal[1] = {
      ...extendedTerminal[1],
      data: Uint8Array.from([...extendedTerminal[1].data, 99, 0, 100, 0]),
    };
    const withTerminalTail = request({ playedThroughByte: 12, chunks: extendedTerminal });
    expect(withFutureChunk.source_played_audio_sha256).toBe(base.source_played_audio_sha256);
    expect(withFutureChunk.source_chunk_sequence_sha256).toBe(base.source_chunk_sequence_sha256);
    expect(withTerminalTail.source_chunk_sequence_sha256).toBe(base.source_chunk_sequence_sha256);
    expect(withTerminalTail.request_sha256).toBe(base.request_sha256);

    const mutated = pcmChunks();
    mutated[1].data[2] ^= 0xff;
    expect(request({ playedThroughByte: 12, chunks: mutated }).request_sha256).not.toBe(base.request_sha256);
    expect(request({ playedThroughByte: 12, chunks: [...pcmChunks()].reverse() }).request_sha256).not.toBe(base.request_sha256);
    expect(request({ playedThroughByte: 12, chunks: pcmChunks(8_000) }).request_sha256).not.toBe(base.request_sha256);
    expect(base.source_played_audio_sha256).toBe(sha256Hex(base.played_pcm));

    const partialUnit = (await preparedFixture({
      source: base,
      asrInvocation: await invocation({ source: base }),
    })).unit;
    const partialArtifact = await artifactFixture(partialUnit);
    expect(verifyAudibleSemanticEvidence(verificationInput(partialArtifact, {
      chunks: [...pcmChunks(), {
        chunkId: "chunk-002",
        encoding: "pcm16",
        sampleRateHz: 16_000,
        channels: 1,
        data: Uint8Array.from([9, 0, 10, 0]),
      }],
      playedThroughByte: 12,
    })).ok).toBe(true);
    expect(verifyAudibleSemanticEvidence(verificationInput(partialArtifact, {
      chunks: extendedTerminal,
      playedThroughByte: 12,
    })).ok).toBe(true);
    expect(verifyAudibleSemanticEvidence(verificationInput(partialArtifact, {
      chunks: mutated,
      playedThroughByte: 12,
    })).ok).toBe(false);
  });

  it("rejects request and adapter PCM mutation before issuing a runner receipt", async () => {
    const preMutated = request();
    preMutated.played_pcm[0] ^= 0xff;
    await expect(invocation({ source: preMutated })).rejects.toThrow(/changed before execution/);
    await expect(invocation({ source: request(), mutateAdapterPcm: true })).rejects.toThrow(/changed during adapter execution/);
    const source = request();
    const executed = await invocation({ source });
    source.played_pcm[0] ^= 0xff;
    expect(() => prepareAudibleSemanticUnit({
      runId: RUN_ID,
      unitId: "unit-001",
      responseId: "response-001",
      blindObservationId: BLIND_OBSERVATION_NONCE_SHA256,
      turn: 1,
      audioArtifactPath: "audio/unit-001.pcm",
      asrInvocation: executed,
      contract,
      calibration: preparedCalibration,
    })).toThrow(/changed (after runner execution|before receipt verification)/);
  });

  it("binds runner receipts to run, unit, nonce, PCM, model, weights, result, and a distinct trust key", async () => {
    const source = request();
    let adapterKeys: string[] = [];
    await runIndependentAsrAdapter({
      request: source,
      contract,
      runnerSigner: runnerIdentity.signer,
      execute(adapterInput) {
        adapterKeys = Object.keys(adapterInput).sort();
        return {
          result: completedAsr(source),
          exitCode: 0,
          runtimeMs: 1,
          stdout: "blind-adapter-output",
          stderr: "",
        };
      },
    });
    expect(adapterKeys).toEqual([
      "adapter_blind_nonce_sha256",
      "asr_contract_sha256",
      "format",
      "played_pcm",
      "played_sample_count",
      "schema_version",
    ]);
    const executed = await invocation({ source });
    expect(verifyIndependentAsrInvocation({
      request: source,
      contract,
      result: executed.result,
      receipt: executed.receipt,
      runnerTrust: runnerIdentity.trust,
    }).receipt.receipt_sha256).toBe(executed.receipt.receipt_sha256);
    expect(() => verifyIndependentAsrInvocation({
      request: source,
      contract,
      result: executed.result,
      receipt: executed.receipt,
      runnerTrust: otherRunnerIdentity.trust,
    })).toThrow(/substitution|trust/);
    const otherNonce = request({ invocationId: "another-invocation" });
    expect(() => verifyIndependentAsrInvocation({
      request: otherNonce,
      contract,
      result: executed.result,
      receipt: executed.receipt,
      runnerTrust: runnerIdentity.trust,
    })).toThrow(/canonical request|substitution/);
    const wrongSignerSource = request();
    const wrongSignerInvocation = await invocation({
      source: wrongSignerSource,
      runnerSigner: otherRunnerIdentity.signer,
    });
    expect(() => prepareAudibleSemanticUnit({
      runId: RUN_ID,
      unitId: "unit-001",
      responseId: "response-001",
      blindObservationId: BLIND_OBSERVATION_NONCE_SHA256,
      turn: 1,
      audioArtifactPath: "audio/unit-001.pcm",
      asrInvocation: wrongSignerInvocation,
      contract,
      calibration: preparedCalibration,
    })).toThrow(/substitution|runner trust/);
  });

  it("permanently rejects the raw silent-PCM invented-transcript exploit and structural brand forgery", async () => {
    const silentChunks: AudiblePcmChunk[] = [{
      chunkId: "silent-000",
      encoding: "pcm16",
      sampleRateHz: 16_000,
      channels: 1,
      data: new Uint8Array(16),
    }];
    const silentRequest = request({ chunks: silentChunks, playedThroughByte: 16 });
    const invented = completedAsr(silentRequest, { transcript: "invented" });
    const rawForgery = {
      request: silentRequest,
      result: invented,
      receipt: {},
    } as unknown as VerifiedIndependentAsrInvocation;
    expect(() => prepareAudibleSemanticUnit({
      runId: RUN_ID,
      unitId: "unit-001",
      responseId: "response-001",
      blindObservationId: BLIND_OBSERVATION_NONCE_SHA256,
      turn: 1,
      audioArtifactPath: "audio/unit-001.pcm",
      asrInvocation: rawForgery,
      contract,
      calibration: preparedCalibration,
    })).toThrow(/verified independent ASR runner invocation/);

    const signedInvocation = await invocation({ source: silentRequest, result: invented });
    const unit = prepareAudibleSemanticUnit({
      runId: RUN_ID,
      unitId: "unit-001",
      responseId: "response-001",
      blindObservationId: BLIND_OBSERVATION_NONCE_SHA256,
      turn: 1,
      audioArtifactPath: "audio/unit-001.pcm",
      asrInvocation: signedInvocation,
      contract,
      calibration: preparedCalibration,
    });
    expect(unit.record.status).toBe("unverifiable");
    expect(unit.record.unverifiable_reasons).toContain("digital_silence_with_transcript");
    expect(conditionBlindListenerObservation(unit).status).toBe("unverifiable");
    expect("transcript" in conditionBlindListenerObservation(unit)).toBe(false);
  });

  it("verifies a sidecar only after recomputing calibration, PCM, request, runner receipt, thresholds, and artifact signature", async () => {
    const artifact = await artifactFixture();
    const result = verifyAudibleSemanticEvidence(verificationInput(artifact));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.evidence).toMatchObject({
      signature_verified: true,
      status: "verified",
      claim_eligible: false,
      claim_ineligible_reasons: [
        "caller_playout_receipt_not_verified",
        "runner_execution_is_provenance_only",
        "real_independent_asr_calibration_not_established",
      ],
      run_id: RUN_ID,
      asr_contract_sha256: independentAsrContractSha256(contract),
      calibration_sha256: independentAsrCalibrationSha256(preparedCalibration.summary),
    });
    expect(lookupVerifiedAudibleSemanticUnit(result.evidence, "unit-001")?.status).toBe("verified");
    const listener = listenerObservationFromVerifiedEvidence(result.evidence, "unit-001");
    expect(listener).toMatchObject({ status: "verified", transcript: "hello world" });
    expect(listener && "unit_id" in listener).toBe(false);
    expect(listener && "response_id" in listener).toBe(false);
    expect(listener && "turn" in listener).toBe(false);
    expect(serializeAudibleSemanticEvidence(artifact).endsWith("\n")).toBe(true);
  });

  it("rejects duplicate blind observation identities across otherwise distinct units", async () => {
    const first = await preparedFixture();
    const secondSource = request({ unitId: "unit-002", invocationId: "invocation-002" });
    const secondInvocation = await invocation({ source: secondSource });
    const second = prepareAudibleSemanticUnit({
      runId: RUN_ID,
      unitId: "unit-002",
      responseId: "response-002",
      blindObservationId: BLIND_OBSERVATION_NONCE_SHA256,
      turn: 2,
      audioArtifactPath: "audio/unit-002.pcm",
      asrInvocation: secondInvocation,
      contract,
      calibration: preparedCalibration,
    });
    expect(() => createAudibleSemanticEvidenceArtifact({
      runId: RUN_ID,
      timelineSha256: TIMELINE_SHA256,
      transcriptSetSha256: TRANSCRIPT_SET_SHA256,
      contract,
      calibration: preparedCalibration,
      units: [first.unit, second],
      signer: artifactIdentity.signer,
    })).toThrow(/repeats a blind observation identity/);
  });

  it("rejects freshly re-signed cross-model/calibration relabeling", async () => {
    const changedContract = mutable(contract);
    changedContract.engine.model_id = "ggml-small.en";
    changedContract.engine.model_revision = "c".repeat(40);
    changedContract.engine.weights_sha256 = "d".repeat(64);
    const fixture = await preparedFixture();
    expect(() => createAudibleSemanticEvidenceArtifact({
      runId: RUN_ID,
      timelineSha256: TIMELINE_SHA256,
      transcriptSetSha256: TRANSCRIPT_SET_SHA256,
      contract: changedContract,
      calibration: preparedCalibration,
      units: [fixture.unit],
      signer: artifactIdentity.signer,
    })).toThrow(/contract|model|weights|asr_contract_sha256/);
    expect(() => prepareIndependentAsrCalibration({
      plan: calibrationPlan,
      contract: changedContract,
      fixtures: calibrationFixtures,
      runnerTrust: runnerIdentity.trust,
    })).toThrow(/contract|model|weights|asr_contract_sha256/);
  });

  it("rejects raw human-label, hypothesis, route, threshold, and runner-key calibration substitution", async () => {
    const artifact = await artifactFixture();
    const changedLabels = [...calibrationFixtures];
    changedLabels[0] = { ...changedLabels[0], forbidden_semantic_phrases: ["fabricated", "fraud"] };
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, { fixtures: changedLabels })).ok).toBe(false);

    const badSource = request({
      runId: "calibration-run-v2",
      unitId: calibrationFixtures[0].fixture_id,
      invocationId: "replacement-calibration-invocation",
      adapterBlindNonceSha256: sha256Hex("adapter-blind:replacement-calibration-invocation"),
      chunks: calibrationPcm(0),
    });
    const badInvocation = await invocation({
      source: badSource,
      result: completedAsr(badSource, { transcript: "invented fraud" }),
    });
    const changedOutput = [...calibrationFixtures];
    changedOutput[0] = { ...changedOutput[0], invocation: badInvocation };
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, { fixtures: changedOutput })).ok).toBe(false);

    const changedPlan = mutable(calibrationPlan);
    changedPlan.thresholds.max_word_error_upper_bound_ppm = 110_000;
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, { plan: changedPlan })).ok).toBe(false);
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, {
      runnerTrust: otherRunnerIdentity.trust,
    })).ok).toBe(false);
  });

  it("rejects chunk reorder, splice, played-boundary, run, nonce, and blind-observation substitution", async () => {
    const artifact = await artifactFixture();
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, { chunks: [...pcmChunks()].reverse() })).ok).toBe(false);
    const spliced = pcmChunks();
    spliced[1].data[2] ^= 0xff;
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, { chunks: spliced })).ok).toBe(false);
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, { playedThroughByte: 8 })).ok).toBe(false);
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, { runId: "another-run" })).ok).toBe(false);
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, { invocationId: "another-invocation" })).ok).toBe(false);
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, {
      adapterBlindNonceSha256: "f".repeat(64),
    })).ok).toBe(false);
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, { blindObservationId: "f".repeat(64) })).ok).toBe(false);
  });

  it("rejects UTF-8, alignment, confidence, timestamp, and hidden provider-text mutations", async () => {
    const source = request();
    const base = completedAsr(source);
    const providerText = { ...base, provider_transcript: "trust provider text" } as unknown as IndependentAsrResult;
    await expect(invocation({ source, result: providerText })).rejects.toThrow(/missing or unsupported fields/);
    const splitUtf8 = {
      ...base,
      transcript: "café",
      spans: [{
        span_id: "utf8",
        text: "caf�",
        utf8_start: 0,
        utf8_end: 4,
        audio_start_sample: 0,
        audio_end_sample: 8,
        confidence_ppm: 950_000,
      }],
    };
    await expect(invocation({ source, result: splitUtf8 })).rejects.toThrow(/UTF-8 code point/);
    const outsideProcessed = {
      ...base,
      processed_through_sample: 4,
      spans: [{ ...base.spans[0], audio_end_sample: 8 }],
    };
    await expect(invocation({ source, result: outsideProcessed })).rejects.toThrow(/audio end/);
    const badConfidence = {
      ...base,
      spans: [{ ...base.spans[0], confidence_ppm: "950000" }],
    } as unknown as IndependentAsrResult;
    await expect(invocation({ source, result: badConfidence })).rejects.toThrow(/safe integer/);
  });

  it("fails closed to a text-free listener view when coverage/confidence is insufficient", async () => {
    const source = request();
    const weakResult = completedAsr(source, {
      processed_through_sample: 4,
      no_speech_probability_ppm: null,
      spans: [{
        ...completedAsr(source).spans[0],
        audio_end_sample: 4,
        confidence_ppm: null,
      }],
    });
    const weakInvocation = await invocation({ source, result: weakResult });
    const weak = (await preparedFixture({ source, asrInvocation: weakInvocation })).unit;
    expect(weak.record.status).toBe("unverifiable");
    expect(weak.record.unverifiable_reasons).toEqual(expect.arrayContaining([
      "processed_audio_coverage_below_threshold",
      "confidence_coverage_below_threshold",
      "confidence_unavailable",
      "no_speech_probability_unavailable",
    ]));
    const listener = conditionBlindListenerObservation(weak);
    expect(listener.status).toBe("unverifiable");
    expect("transcript" in listener).toBe(false);
    expect("timed_spans" in listener).toBe(false);
  });

  it("rejects post-signature transcript, receipt, calibration, and artifact-signing mutations", async () => {
    const artifact = await artifactFixture();
    const transcriptMutation = mutable(artifact);
    if (transcriptMutation.units[0].asr_result.status !== "completed") throw new Error("expected completed ASR");
    transcriptMutation.units[0].asr_result.transcript = "hello fraud";
    expect(verifyAudibleSemanticEvidence(verificationInput(transcriptMutation)).ok).toBe(false);
    const receiptMutation = mutable(artifact);
    receiptMutation.units[0].asr_invocation_receipt.runtime_ms += 1;
    expect(verifyAudibleSemanticEvidence(verificationInput(receiptMutation)).ok).toBe(false);
    const calibrationMutation = mutable(artifact);
    calibrationMutation.calibration.metrics.word_error_rate_ppm += 1;
    expect(verifyAudibleSemanticEvidence(verificationInput(calibrationMutation)).ok).toBe(false);
    expect(verifyAudibleSemanticEvidence(verificationInput(artifact, {
      artifactTrust: otherRunnerIdentity.trust,
    })).ok).toBe(false);
    expect(() => serializeAudibleSemanticEvidence(transcriptMutation)).toThrow();
  });

  it("keeps undersized or failed semantic/alignment calibration development-only", async () => {
    const undersized = prepareIndependentAsrCalibration({
      plan: calibrationPlan,
      contract,
      fixtures: calibrationFixtures.slice(0, 24),
      runnerTrust: runnerIdentity.trust,
    });
    expect(undersized.summary.status).toBe("development_only_unvalidated");
    expect(undersized.summary.unvalidated_reasons).toContain("insufficient_fixture_count");

    const badFixtures = [...calibrationFixtures];
    const original = badFixtures[0];
    const badSource = request({
      runId: "calibration-run-v2",
      unitId: original.fixture_id,
      invocationId: "semantic-failure-invocation",
      adapterBlindNonceSha256: sha256Hex("adapter-blind:semantic-failure-invocation"),
      chunks: calibrationPcm(0),
    });
    badFixtures[0] = {
      ...original,
      invocation: await invocation({
        source: badSource,
        result: completedAsr(badSource, { transcript: "invented fraud" }),
      }),
    };
    const failed = prepareIndependentAsrCalibration({
      plan: calibrationPlan,
      contract,
      fixtures: badFixtures,
      runnerTrust: runnerIdentity.trust,
    });
    expect(failed.summary.asr_outputs_sha256).not.toBe(preparedCalibration.summary.asr_outputs_sha256);
    expect(failed.summary.metrics.semantic_false_positive_rate_ppm).toBeGreaterThan(0);
  });

  it("rejects malformed calibration scalar types and ambiguous PCM structure", () => {
    const malformed = {
      ...preparedCalibration.summary,
      metrics: { ...preparedCalibration.summary.metrics, word_error_rate_ppm: "0" },
    } as unknown as IndependentAsrCalibration;
    expect(() => independentAsrCalibrationSha256(malformed)).toThrow(/safe integer/);
    const duplicate = pcmChunks();
    duplicate[1] = { ...duplicate[1], chunkId: duplicate[0].chunkId };
    expect(() => request({ chunks: duplicate })).toThrow(/duplicate chunk IDs/);
    const odd = pcmChunks();
    odd[1] = { ...odd[1], data: Uint8Array.from([1, 0, 2]) };
    expect(() => request({ chunks: odd })).toThrow(/complete non-empty PCM16/);
    expect(() => request({ playedThroughByte: 15 })).toThrow(/sample boundary/);
  });

  it("enforces bounded calibration inventory and maximum claim-policy thresholds", () => {
    const oversizedInventory = Array.from({ length: 101 }, (_, index) =>
      calibrationFixtures[index % calibrationFixtures.length]);
    expect(() => prepareIndependentAsrCalibration({
      plan: calibrationPlan,
      contract,
      fixtures: oversizedInventory,
      runnerTrust: runnerIdentity.trust,
    })).toThrow(/fixture inventory is invalid/);

    const permissivePlan = mutable(calibrationPlan);
    permissivePlan.thresholds.max_word_error_upper_bound_ppm = 250_001;
    expect(() => prepareIndependentAsrCalibration({
      plan: permissivePlan,
      contract,
      fixtures: calibrationFixtures,
      runnerTrust: runnerIdentity.trust,
    })).toThrow(/maximum claim policy/);
  });
});
