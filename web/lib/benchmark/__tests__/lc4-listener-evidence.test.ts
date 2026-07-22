import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
  createIndependentAsrRequest,
  independentAsrCalibrationSha256,
  prepareIndependentAsrCalibration,
  runIndependentAsrAdapter,
  type AsrCalibrationSourceFixture,
  type AudiblePcmChunk,
  type IndependentAsrCalibrationPlan,
  type IndependentAsrContract,
  type IndependentAsrRequest,
  type IndependentAsrResult,
  type PreparedIndependentAsrCalibration,
} from "../audible-evidence";
import {
  createLc4CapturedOutput,
  createLc4FrozenListenerSemanticRegistry,
  createLc4FrozenListenerSemanticRegistryManifest,
  createLc4ListenerEvidenceArtifact,
  createLc4ListenerSemanticPlan,
  createLc4PlaybackReceipt,
  lc4ListenerEvidenceForCrp,
  replayLc4ListenerSemantics,
  verifyLc4ListenerEvidenceArtifact,
  type Lc4CapturedOutput,
  type Lc4IndependentAsrOutputBinding,
  type Lc4ListenerPipelineOpportunity,
} from "../lc4-listener-evidence";
import {
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationTrust,
} from "../kernel-attestation";

const H = (value: string) => sha256Hex(value);
const RUN_ID = "lc4-listener-test-run";
const PROTOCOL_SHA256 = H("lc4-protocol");
const SCHEDULE_SHA256 = H("lc4-schedule");

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

const runnerIdentity = signingIdentity("lc4-listener-asr-runner");

const contract: IndependentAsrContract = Object.freeze({
  schema_version: 1,
  contract_id: "lc4-listener-whisper-test",
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
  calibration_id: "lc4-listener-balanced-test-calibration",
  protocol_sha256: PROTOCOL_SHA256,
  corpus_manifest_sha256: H("lc4-listener-corpus"),
  evaluator_build_sha256: H("lc4-listener-evaluator"),
  expected_route_ids: Object.freeze(["server-pcm", "listener-sink"]),
  thresholds: Object.freeze({
    min_fixture_coverage_ppm: 950_000,
    max_word_error_upper_bound_ppm: 100_000,
    max_semantic_false_negative_upper_bound_ppm: 100_000,
    max_semantic_false_positive_upper_bound_ppm: 100_000,
    max_alignment_boundary_p95_ms: 250,
    max_route_word_error_gap_ppm: 50_000,
  }),
});

function calibrationChunks(index: number): AudiblePcmChunk[] {
  const start = index + 1;
  return [{
    chunkId: "calibration-chunk",
    encoding: "pcm16",
    sampleRateHz: 16_000,
    channels: 1,
    data: Uint8Array.from([start, 0, start + 1, 0, start + 2, 0, start + 3, 0]),
  }];
}

function completedResult(
  request: IndependentAsrRequest,
  transcript = "latest revision acknowledged release confirmed",
): Extract<IndependentAsrResult, { status: "completed" }> {
  const bytes = Buffer.byteLength(transcript, "utf8");
  return Object.freeze({
    status: "completed",
    source_request_sha256: request.request_sha256,
    source_played_audio_sha256: request.source_played_audio_sha256,
    source_chunk_sequence_sha256: request.source_chunk_sequence_sha256,
    language: "en",
    transcript,
    processed_through_sample: request.played_sample_count,
    no_speech_probability_ppm: 10_000,
    spans: Object.freeze([{
      span_id: "span-1",
      text: transcript,
      utf8_start: 0,
      utf8_end: bytes,
      audio_start_sample: 0,
      audio_end_sample: request.played_sample_count,
      confidence_ppm: 950_000,
    }]),
  });
}

let preparedCalibration: PreparedIndependentAsrCalibration;

beforeAll(async () => {
  const fixtures: AsrCalibrationSourceFixture[] = [];
  for (const routeId of calibrationPlan.expected_route_ids) {
    for (let index = 0; index < 32; index += 1) {
      const fixtureId = `${routeId}-${index}`;
      const request = createIndependentAsrRequest({
        runId: "lc4-listener-calibration",
        unitId: fixtureId,
        invocationId: `inv-${routeId}-${index}`,
        adapterBlindNonceSha256: H(`blind-${routeId}-${index}`),
        contract,
        chunks: calibrationChunks(index),
        playedThroughByte: 8,
      });
      const invocation = await runIndependentAsrAdapter({
        request,
        contract,
        runnerSigner: runnerIdentity.signer,
        execute: () => ({
          result: completedResult(request),
          exitCode: 0,
          runtimeMs: 1,
          stdout: "calibration",
          stderr: "",
        }),
      });
      fixtures.push(Object.freeze({
        fixture_id: fixtureId,
        route_id: routeId,
        split: "held_out",
        corpus_sample_id: `sample-${index}`,
        reference_transcript: "latest revision acknowledged release confirmed",
        expected_semantic_phrases: Object.freeze(["latest revision", "release confirmed"]),
        forbidden_semantic_phrases: Object.freeze(["old revision", "release pending"]),
        reference_audio_start_sample: 0,
        reference_audio_end_sample: request.played_sample_count,
        invocation,
      }));
    }
  }
  preparedCalibration = prepareIndependentAsrCalibration({
    plan: calibrationPlan,
    contract,
    fixtures,
    runnerTrust: runnerIdentity.trust,
  });
});

function semanticPlan(opportunityIds: readonly string[]) {
  const registry = createLc4FrozenListenerSemanticRegistry({
    templateId: "lc4-template-01",
    protocolSha256: PROTOCOL_SHA256,
    scheduleSha256: SCHEDULE_SHA256,
    opportunities: opportunityIds.map((opportunityId) => ({
      opportunity_id: opportunityId,
      criteria: Object.freeze([
        {
          criterion_id: "latest-revision",
          operator: "contains_any" as const,
          phrases: Object.freeze(["latest revision acknowledged", "new revision accepted"]),
          required_for_final_scorer: true,
          crp_blocker: Object.freeze({ code: "latest_revision_unacknowledged" as const, precedence: 1 }),
        },
        {
          criterion_id: "no-pending-claim",
          operator: "contains_none" as const,
          phrases: Object.freeze(["release pending"]),
          required_for_final_scorer: true,
          crp_blocker: Object.freeze({ code: "terminal_claim_unsupported" as const, precedence: 2 }),
        },
      ]),
    })),
  });
  const manifest = createLc4FrozenListenerSemanticRegistryManifest([registry]);
  return createLc4ListenerSemanticPlan(registry, manifest);
}

function capture(input: Readonly<{
  opportunityId?: string;
  provider?: "openai" | "gemini" | "xai";
  surface?: "server_realtime_pcm" | "browser_webrtc_remote_track";
}> = {}): Lc4CapturedOutput {
  const opportunityId = input.opportunityId ?? "opportunity-1";
  return createLc4CapturedOutput({
    runId: RUN_ID,
    opportunityId,
    responseId: `response-${opportunityId}`,
    provider: input.provider ?? "openai",
    surface: input.surface ?? "server_realtime_pcm",
    sampleRateHz: 24_000,
    chunks: Object.freeze([
      { chunkId: "chunk-1", pcm: Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]) },
      { chunkId: "chunk-2", pcm: Uint8Array.from([5, 0, 6, 0, 7, 0, 8, 0]) },
    ]),
  });
}

function opportunity(input: Readonly<{
  id?: string;
  state?: Lc4ListenerPipelineOpportunity["state"];
  capture?: Lc4CapturedOutput;
  playback?: Lc4ListenerPipelineOpportunity["playback"];
}> = {}): Lc4ListenerPipelineOpportunity {
  const id = input.id ?? "opportunity-1";
  return Object.freeze({
    opportunityId: id,
    turn: 1,
    state: input.state ?? "reached",
    audioArtifactPath: `audio/output/${id}.pcm`,
    blindObservationNonceSha256: H(`observation-${id}`),
    adapterBlindNonceSha256: H(`adapter-${id}`),
    ...(input.capture ? { capture: input.capture } : {}),
    ...(input.playback ? { playback: input.playback } : {}),
  });
}

function asrExecution(
  _adapterInput: unknown,
  binding: Lc4IndependentAsrOutputBinding,
  transcript = "latest revision acknowledged release confirmed",
) {
  const bytes = Buffer.byteLength(transcript, "utf8");
  const sourceBinding = {
    source_request_sha256: binding.source_request_sha256,
    source_played_audio_sha256: binding.source_played_audio_sha256,
    source_chunk_sequence_sha256: binding.source_chunk_sequence_sha256,
    language: binding.language,
  };
  return {
    result: {
      status: "completed",
      ...sourceBinding,
      transcript,
      processed_through_sample: binding.played_sample_count,
      no_speech_probability_ppm: 10_000,
      spans: [{
        span_id: "span-1",
        text: transcript,
        utf8_start: 0,
        utf8_end: bytes,
        audio_start_sample: 0,
        audio_end_sample: binding.played_sample_count,
        confidence_ppm: 950_000,
      }],
    },
    exitCode: 0,
    runtimeMs: 2,
    stdout: "listener-asr",
    stderr: "",
  };
}

const evidenceTrust = Object.freeze({
  verifyOutputCaptureEvidence: () => true,
  verifyPlaybackEvidence: () => true,
});

describe("LC4 listener-heard evidence pipeline", () => {
  it("accepts OpenAI server-side benchmark PCM and emits CRP/final-scorer evidence", async () => {
    const output = capture();
    const playback = createLc4PlaybackReceipt({
      capture: output,
      evidenceSource: "benchmark_listener_sink",
      evidenceSha256: H("listener-sink-receipt"),
      status: "completed",
      playedByteEnd: output.generated_byte_length,
    });
    const plan = semanticPlan(["opportunity-1"]);
    const artifact = await createLc4ListenerEvidenceArtifact({
      runId: RUN_ID,
      protocolSha256: PROTOCOL_SHA256,
      scheduleSha256: SCHEDULE_SHA256,
      semanticPlan: plan,
      asrContract: contract,
      asrCalibration: preparedCalibration,
      asrRunnerSigner: runnerIdentity.signer,
      ...evidenceTrust,
      opportunities: [opportunity({ capture: output, playback })],
      executeAsr: asrExecution,
    });

    expect(artifact.records[0]).toMatchObject({
      criterion_plan_sha256: plan.opportunities[0]!.criterion_plan_sha256,
      disposition: "heard_verified",
      played_byte_end: 16,
      semantic_replay: {
        earliest_unmet_crp_blocker: null,
        final_required_criteria_pass: true,
      },
    });
    expect(artifact.coverage).toMatchObject({
      expected_opportunities: 1,
      playback_verified: 1,
      listener_semantics_verified: 1,
    });
    expect(artifact.final_scorer).toEqual({
      semantic_applicability: "applicable",
      all_required_listener_evidence_verified: true,
      all_required_semantic_criteria_pass: true,
      failed_opportunity_ids: [],
      unverifiable_opportunity_ids: [],
    });
    expect(artifact).toMatchObject({
      template_id: plan.template_id,
      semantic_registry_sha256: plan.registry_sha256,
      semantic_registry_manifest_sha256: plan.registry_manifest_sha256,
    });
    expect(lc4ListenerEvidenceForCrp(artifact, "opportunity-1")).toMatchObject({
      status: "verified",
      earliestUnmetBlocker: null,
    });
    expect(verifyLc4ListenerEvidenceArtifact({
      artifact,
      semanticPlan: plan,
      asrContract: contract,
      calibrationSha256: independentAsrCalibrationSha256(preparedCalibration.summary),
    })).toEqual({ valid: true, errors: [] });
  });

  it("marks empty frozen criteria explicitly not-applicable instead of vacuously passing", () => {
    const registry = createLc4FrozenListenerSemanticRegistry({
      templateId: "lc4-template-01",
      protocolSha256: PROTOCOL_SHA256,
      scheduleSha256: SCHEDULE_SHA256,
      opportunities: [{ opportunity_id: "opportunity-empty", criteria: [] }],
    });
    const manifest = createLc4FrozenListenerSemanticRegistryManifest([registry]);
    const plan = createLc4ListenerSemanticPlan(registry, manifest);
    expect(plan.opportunities[0]).toMatchObject({
      applicability: {
        status: "not_applicable",
        reason: "no_registered_audible_semantic_criteria",
      },
      criteria: [],
    });
    expect(replayLc4ListenerSemantics({
      plan,
      opportunityId: "opportunity-empty",
      observation: null,
    })).toMatchObject({
      listener_status: "not_applicable",
      final_required_criteria_pass: null,
      criteria: [],
    });
  });

  it("transcribes only an exact interrupted playback prefix", async () => {
    const output = capture();
    const playback = createLc4PlaybackReceipt({
      capture: output,
      evidenceSource: "exact_scheduled_playback_range",
      evidenceSha256: H("scheduled-prefix"),
      status: "interrupted",
      playedByteEnd: 8,
      scheduledByteEnd: 8,
      interruptionReason: "registered barge-in",
    });
    let observedBytes = 0;
    const artifact = await createLc4ListenerEvidenceArtifact({
      runId: RUN_ID,
      protocolSha256: PROTOCOL_SHA256,
      scheduleSha256: SCHEDULE_SHA256,
      semanticPlan: semanticPlan(["opportunity-1"]),
      asrContract: contract,
      asrCalibration: preparedCalibration,
      asrRunnerSigner: runnerIdentity.signer,
      ...evidenceTrust,
      opportunities: [opportunity({ capture: output, playback })],
      executeAsr(adapterInput, binding) {
        observedBytes = adapterInput.played_pcm.byteLength;
        return asrExecution(adapterInput, binding);
      },
    });
    expect(observedBytes).toBe(8);
    expect(artifact.records[0]).toMatchObject({
      disposition: "partial_heard_verified",
      played_byte_end: 8,
      generated_byte_length: 16,
    });
    expect(artifact.coverage.partial_playback_opportunities).toBe(1);
  });

  it("fails browser WebRTC capture closed while retaining OpenAI server PCM support", async () => {
    const output = capture({ surface: "browser_webrtc_remote_track" });
    const playback = createLc4PlaybackReceipt({
      capture: output,
      evidenceSource: "benchmark_listener_sink",
      evidenceSha256: H("browser-track"),
      status: "completed",
      playedByteEnd: output.generated_byte_length,
    });
    let asrCalls = 0;
    const artifact = await createLc4ListenerEvidenceArtifact({
      runId: RUN_ID,
      protocolSha256: PROTOCOL_SHA256,
      scheduleSha256: SCHEDULE_SHA256,
      semanticPlan: semanticPlan(["opportunity-1"]),
      asrContract: contract,
      asrCalibration: preparedCalibration,
      asrRunnerSigner: runnerIdentity.signer,
      ...evidenceTrust,
      opportunities: [opportunity({ capture: output, playback })],
      executeAsr(adapterInput, binding) {
        asrCalls += 1;
        return asrExecution(adapterInput, binding);
      },
    });
    expect(asrCalls).toBe(0);
    expect(artifact.records[0]).toMatchObject({
      disposition: "capture_surface_unsupported",
      failure_reasons: ["browser_webrtc_listener_capture_not_implemented"],
    });
    expect(artifact.final_scorer.all_required_listener_evidence_verified).toBe(false);
  });

  it("requires external capture and playback trust instead of accepting self-hashed receipts", async () => {
    const output = capture();
    const playback = createLc4PlaybackReceipt({
      capture: output,
      evidenceSource: "benchmark_listener_sink",
      evidenceSha256: H("untrusted-playback"),
      status: "completed",
      playedByteEnd: output.generated_byte_length,
    });
    let asrCalls = 0;
    const artifact = await createLc4ListenerEvidenceArtifact({
      runId: RUN_ID,
      protocolSha256: PROTOCOL_SHA256,
      scheduleSha256: SCHEDULE_SHA256,
      semanticPlan: semanticPlan(["opportunity-1"]),
      asrContract: contract,
      asrCalibration: preparedCalibration,
      asrRunnerSigner: runnerIdentity.signer,
      opportunities: [opportunity({ capture: output, playback })],
      verifyOutputCaptureEvidence: () => true,
      verifyPlaybackEvidence: () => false,
      executeAsr(adapterInput, binding) {
        asrCalls += 1;
        return asrExecution(adapterInput, binding);
      },
    });
    expect(asrCalls).toBe(0);
    expect(artifact.records[0]).toMatchObject({
      disposition: "playback_evidence_invalid",
      failure_reasons: ["listener_playback_authority_rejected"],
    });
  });

  it("retains no-output, missing-playback, and not-reached dispositions without inventing semantics", async () => {
    const ids = ["no-output", "missing-playback", "not-reached"];
    const missingPlaybackCapture = capture({ opportunityId: "missing-playback", provider: "gemini" });
    const artifact = await createLc4ListenerEvidenceArtifact({
      runId: RUN_ID,
      protocolSha256: PROTOCOL_SHA256,
      scheduleSha256: SCHEDULE_SHA256,
      semanticPlan: semanticPlan(ids),
      asrContract: contract,
      asrCalibration: preparedCalibration,
      asrRunnerSigner: runnerIdentity.signer,
      ...evidenceTrust,
      opportunities: [
        opportunity({ id: "no-output" }),
        opportunity({ id: "missing-playback", capture: missingPlaybackCapture }),
        opportunity({ id: "not-reached", state: "not_reached_after_critical_failure" }),
      ],
      executeAsr: asrExecution,
    });
    expect(artifact.records.map((record) => record.disposition)).toEqual([
      "no_output",
      "playback_evidence_missing",
      "not_reached_after_critical_failure",
    ]);
    expect(artifact.records.every((record) => record.listener_observation === null)).toBe(true);
    expect(artifact.records.every((record) => record.semantic_replay.final_required_criteria_pass === null)).toBe(true);
    expect(artifact.final_scorer.all_required_semantic_criteria_pass).toBeNull();
  });

  it("detects post-receipt PCM mutation and preserves the earliest CRP blocker on verified speech", async () => {
    const output = capture();
    output.chunks[0]!.pcm[0] ^= 0xff;
    const plan = semanticPlan(["opportunity-1"]);
    const invalid = await createLc4ListenerEvidenceArtifact({
      runId: RUN_ID,
      protocolSha256: PROTOCOL_SHA256,
      scheduleSha256: SCHEDULE_SHA256,
      semanticPlan: plan,
      asrContract: contract,
      asrCalibration: preparedCalibration,
      asrRunnerSigner: runnerIdentity.signer,
      ...evidenceTrust,
      opportunities: [opportunity({ capture: output })],
      executeAsr: asrExecution,
    });
    expect(invalid.records[0]?.disposition).toBe("capture_evidence_invalid");

    const clean = capture();
    const playback = createLc4PlaybackReceipt({
      capture: clean,
      evidenceSource: "benchmark_listener_sink",
      evidenceSha256: H("negative-semantic-sink"),
      status: "completed",
      playedByteEnd: clean.generated_byte_length,
    });
    const semanticFailure = await createLc4ListenerEvidenceArtifact({
      runId: RUN_ID,
      protocolSha256: PROTOCOL_SHA256,
      scheduleSha256: SCHEDULE_SHA256,
      semanticPlan: plan,
      asrContract: contract,
      asrCalibration: preparedCalibration,
      asrRunnerSigner: runnerIdentity.signer,
      ...evidenceTrust,
      opportunities: [opportunity({ capture: clean, playback })],
      executeAsr(adapterInput, binding) {
        return asrExecution(adapterInput, binding, "release pending");
      },
    });
    expect(semanticFailure.records[0]?.semantic_replay).toMatchObject({
      earliest_unmet_crp_blocker: "latest_revision_unacknowledged",
      final_required_criteria_pass: false,
    });
    expect(semanticFailure.final_scorer.failed_opportunity_ids).toEqual(["opportunity-1"]);
  });

  it("rejects semantic criteria created after the frozen registry manifest", () => {
    const frozen = createLc4FrozenListenerSemanticRegistry({
      templateId: "lc4-template-01",
      protocolSha256: PROTOCOL_SHA256,
      scheduleSha256: SCHEDULE_SHA256,
      opportunities: [{
        opportunity_id: "opportunity-1",
        criteria: [{
          criterion_id: "frozen-criterion",
          operator: "contains_any",
          phrases: ["frozen before provider execution"],
          required_for_final_scorer: true,
          crp_blocker: { code: "subject_or_goal_unresolved", precedence: 1 },
        }],
      }],
    });
    const sealedManifest = createLc4FrozenListenerSemanticRegistryManifest([frozen]);
    const postHoc = createLc4FrozenListenerSemanticRegistry({
      templateId: frozen.template_id,
      protocolSha256: frozen.protocol_sha256,
      scheduleSha256: frozen.schedule_sha256,
      opportunities: [{
        opportunity_id: "opportunity-1",
        criteria: [{
          criterion_id: "post-hoc-criterion",
          operator: "contains_any",
          phrases: ["phrase selected after observing the response"],
          required_for_final_scorer: true,
          crp_blocker: { code: "subject_or_goal_unresolved", precedence: 1 },
        }],
      }],
    });

    expect(() => createLc4ListenerSemanticPlan(postHoc, sealedManifest))
      .toThrow(/not present in the sealed registry manifest/);
  });
});
