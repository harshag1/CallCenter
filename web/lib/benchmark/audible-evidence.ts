import {
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  canonicalJson,
  immutableJson,
  sha256Hex,
} from "./artifacts";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  type BenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationTrust,
} from "./kernel-attestation";

const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,1024}$/;
const PPM = 1_000_000;
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_CHUNKS = 4_096;
const MAX_SPANS = 65_536;
const MIN_CALIBRATION_FIXTURES = 48;
const MIN_CALIBRATION_FIXTURES_PER_ROUTE = 24;
const MIN_CALIBRATION_WORDS_PER_ROUTE = 64;
const MIN_CALIBRATION_SEMANTIC_EVENTS_PER_ROUTE = 32;
const MAX_CALIBRATION_FIXTURES = 100;
const MAX_CALIBRATION_TRANSCRIPT_CHARACTERS = 4_096;
const MAX_CALIBRATION_WORDS_PER_FIXTURE = 256;
const UNIT_MIN_PROCESSED_AUDIO_COVERAGE_PPM = 990_000;
const UNIT_MIN_CONFIDENCE_COVERAGE_PPM = 900_000;
const UNIT_MIN_MEAN_CONFIDENCE_PPM = 800_000;
const UNIT_MAX_NO_SPEECH_PROBABILITY_PPM = 500_000;

const CONTRACT_DOMAIN = "hacc/independent-asr-contract/v1\n";
const CALIBRATION_DOMAIN = "hacc/independent-asr-calibration/v1\n";
const CALIBRATION_FIXTURE_DOMAIN = "hacc/independent-asr-calibration-fixtures/v1\n";
const CALIBRATION_LABEL_DOMAIN = "hacc/independent-asr-calibration-labels/v1\n";
const CALIBRATION_OUTPUT_DOMAIN = "hacc/independent-asr-calibration-outputs/v2\n";
const CALIBRATION_EVIDENCE_DOMAIN = "hacc/independent-asr-calibration-evidence/v2\n";
const AUDIO_CHUNK_SEQUENCE_DOMAIN = "hacc/audible-pcm-chunk-sequence/v1\n";
const PLAYED_CHUNK_SEQUENCE_DOMAIN = "hacc/audible-played-pcm-prefix/v1\n";
const UNIT_DOMAIN = "hacc/independent-audible-semantic-unit/v1\n";
const UNIT_INVENTORY_DOMAIN = "hacc/independent-audible-semantic-inventory/v1\n";
const ARTIFACT_DOMAIN = "hacc/independent-audible-semantic-artifact/v1\n";
const SIGNATURE_DOMAIN = "hacc/independent-audible-semantic-signature/v1\n";
const LISTENER_EVIDENCE_DOMAIN = "hacc/condition-blind-listener-observation/v1\n";
const BLIND_OBSERVATION_DOMAIN = "hacc/condition-blind-observation-id/v2\n";
const ASR_RESULT_SCHEMA_DOMAIN = "hacc/independent-asr-normalized-result-schema/v1\n";
const ASR_REQUEST_DOMAIN = "hacc/independent-asr-request/v2\n";
const ASR_RESULT_DOMAIN = "hacc/independent-asr-result/v2\n";
const ASR_INVOCATION_DOMAIN = "hacc/independent-asr-invocation/v2\n";
const ASR_INVOCATION_SIGNATURE_DOMAIN = "hacc/independent-asr-invocation-signature/v2\n";

export const INDEPENDENT_ASR_RESULT_SCHEMA_SHA256 = sha256Hex(
  `${ASR_RESULT_SCHEMA_DOMAIN}completed-or-unavailable/request-and-pcm-bound/timed-utf8-spans/ppm-confidence/v2`
);

export type IndependentAsrContract = Readonly<{
  schema_version: 1;
  contract_id: string;
  engine: Readonly<{
    implementation: "whisper.cpp" | "mlx-whisper" | "other-open-weight";
    source_repository: string;
    source_revision: string;
    executable_sha256: string;
    dependency_lock_sha256: string;
    model_id: string;
    model_revision: string;
    weights_sha256: string;
  }>;
  decoding: Readonly<{
    language: string;
    task: "transcribe";
    temperature_milli: 0;
    beam_size: number;
    best_of: number;
    word_timestamps: true;
    condition_on_previous_text: false;
    initial_prompt_sha256: null;
  }>;
  resampling_profile_sha256: string;
  result_schema_sha256: string;
}>;

export type IndependentAsrCalibration = Readonly<{
  schema_version: 1;
  calibration_id: string;
  status: "calibrated" | "development_only_unvalidated";
  asr_contract_sha256: string;
  protocol_sha256: string;
  corpus_manifest_sha256: string;
  fixture_manifest_sha256: string;
  human_labels_sha256: string;
  asr_outputs_sha256: string;
  fixture_evidence_sha256: string;
  evaluator_build_sha256: string;
  runner_signing_key_id: string;
  runner_signing_public_key_sha256: string;
  fixture_count: number;
  route_metrics: readonly AsrCalibrationRouteMetrics[];
  metrics: Readonly<{
    word_error_rate_ppm: number;
    word_error_upper_bound_ppm: number;
    semantic_false_negative_rate_ppm: number;
    semantic_false_negative_upper_bound_ppm: number;
    semantic_false_positive_rate_ppm: number;
    semantic_false_positive_upper_bound_ppm: number;
    alignment_boundary_p95_ms: number;
    fixture_coverage_ppm: number;
    runtime_p95_ms: number;
  }>;
  thresholds: Readonly<{
    min_fixture_coverage_ppm: number;
    max_word_error_upper_bound_ppm: number;
    max_semantic_false_negative_upper_bound_ppm: number;
    max_semantic_false_positive_upper_bound_ppm: number;
    max_alignment_boundary_p95_ms: number;
    max_route_word_error_gap_ppm: number;
  }>;
  unvalidated_reasons: readonly string[];
}>;

export type AsrCalibrationRouteMetrics = Readonly<{
  route_id: string;
  fixture_count: number;
  reference_word_count: number;
  semantic_positive_count: number;
  semantic_negative_count: number;
  word_error_rate_ppm: number;
  word_error_upper_bound_ppm: number;
  semantic_false_negative_rate_ppm: number;
  semantic_false_negative_upper_bound_ppm: number;
  semantic_false_positive_rate_ppm: number;
  semantic_false_positive_upper_bound_ppm: number;
  alignment_boundary_p95_ms: number;
  fixture_coverage_ppm: number;
  runtime_p95_ms: number;
}>;

export type AsrCalibrationSourceFixture = Readonly<{
  fixture_id: string;
  route_id: string;
  split: "held_out";
  corpus_sample_id: string;
  reference_transcript: string;
  expected_semantic_phrases: readonly string[];
  forbidden_semantic_phrases: readonly string[];
  reference_audio_start_sample: number;
  reference_audio_end_sample: number;
  invocation: VerifiedIndependentAsrInvocation;
}>;

export type IndependentAsrCalibrationPlan = Readonly<{
  calibration_id: string;
  protocol_sha256: string;
  corpus_manifest_sha256: string;
  evaluator_build_sha256: string;
  expected_route_ids: readonly string[];
  thresholds: IndependentAsrCalibration["thresholds"];
}>;

const PREPARED_CALIBRATION = Symbol("prepared-independent-asr-calibration");
export type PreparedIndependentAsrCalibration = Readonly<{
  [PREPARED_CALIBRATION]: true;
  summary: IndependentAsrCalibration;
  runnerTrust: BenchmarkKernelAttestationTrust;
}>;
const preparedCalibrations = new WeakSet<object>();

export type AudiblePcmChunk = Readonly<{
  chunkId: string;
  encoding: "pcm16";
  sampleRateHz: number;
  channels: 1;
  data: Uint8Array;
}>;

export type TimedUtf8Span = Readonly<{
  span_id: string;
  text: string;
  utf8_start: number;
  utf8_end: number;
  audio_start_sample: number;
  audio_end_sample: number;
  confidence_ppm: number | null;
}>;

export type IndependentAsrResult =
  | Readonly<{
      status: "completed";
      source_request_sha256: string;
      source_played_audio_sha256: string;
      source_chunk_sequence_sha256: string;
      language: string;
      transcript: string;
      processed_through_sample: number;
      no_speech_probability_ppm: number | null;
      spans: readonly TimedUtf8Span[];
    }>
  | Readonly<{
      status: "unavailable";
      reason_code: string;
      reason: string;
    }>;

export type AudiblePcmChunkDescriptor = Readonly<{
  ordinal: number;
  chunk_id: string;
  byte_offset: number;
  byte_length: number;
  sample_offset: number;
  sample_count: number;
  sha256: string;
}>;

export type AudiblePcmBinding = Readonly<{
  format: Readonly<{
    encoding: "pcm16";
    endianness: "little";
    sample_rate_hz: number;
    channels: 1;
  }>;
  chunks: readonly AudiblePcmChunkDescriptor[];
  generated_byte_length: number;
  generated_sample_count: number;
  generated_pcm_sha256: string;
  generated_chunk_sequence_sha256: string;
  played_range: Readonly<{
    kind: "contiguous_prefix";
    byte_start: 0;
    byte_end: number;
    sample_start: 0;
    sample_end: number;
    played_pcm_sha256: string;
    played_chunk_sequence_sha256: string;
    terminal_chunk: Readonly<{
      ordinal: number;
      byte_end_in_chunk: number;
      sample_end_in_chunk: number;
    }> | null;
  }>;
}>;

/**
 * Provider-neutral input handed to an independently pinned ASR adapter.
 *
 * The PCM is the exact contiguous prefix that was audible to the caller. The
 * two source hashes must be copied verbatim into a completed ASR result. This
 * keeps adapter execution separate from evidence construction while ensuring
 * both paths bind to identical bytes and ordered chunk boundaries.
 */
const PREPARED_ASR_REQUEST = Symbol("prepared-independent-asr-request");
export type IndependentAsrRequest = Readonly<{
  [PREPARED_ASR_REQUEST]: true;
  schema_version: 1;
  run_id: string;
  unit_id: string;
  invocation_id: string;
  adapter_blind_nonce_sha256: string;
  asr_contract_sha256: string;
  format: Readonly<{
    encoding: "pcm16";
    endianness: "little";
    sample_rate_hz: number;
    channels: 1;
  }>;
  played_sample_count: number;
  source_played_audio_sha256: string;
  source_chunk_sequence_sha256: string;
  request_sha256: string;
  played_pcm: Uint8Array;
  audio_binding: AudiblePcmBinding;
}>;
const preparedAsrRequests = new WeakSet<object>();

export type IndependentAsrInvocationReceipt = Readonly<{
  schema_version: 1;
  receipt_type: "independent_asr_invocation";
  invocation_id: string;
  run_id: string;
  unit_id: string;
  asr_contract_sha256: string;
  request_sha256: string;
  source_played_audio_sha256: string;
  source_chunk_sequence_sha256: string;
  executable_sha256: string;
  model_weights_sha256: string;
  normalized_result_sha256: string;
  stdout_sha256: string;
  stderr_sha256: string;
  exit_code: 0;
  runtime_ms: number;
  signing_key_id: string;
  signing_public_key_sha256: string;
  receipt_sha256: string;
  signature: Readonly<{
    algorithm: "ed25519";
    key_id: string;
    signature_base64: string;
  }>;
}>;

const VERIFIED_ASR_INVOCATION = Symbol("verified-independent-asr-invocation");
export type VerifiedIndependentAsrInvocation = Readonly<{
  [VERIFIED_ASR_INVOCATION]: true;
  request: IndependentAsrRequest;
  result: IndependentAsrResult;
  receipt: IndependentAsrInvocationReceipt;
}>;
const verifiedAsrInvocations = new WeakSet<object>();

export type IndependentAsrAdapterInput = Readonly<{
  schema_version: 1;
  adapter_blind_nonce_sha256: string;
  asr_contract_sha256: string;
  /** Opaque request binding; contains no provider, arm, or semantic labels. */
  source_request_sha256: string;
  /** Opaque exact played-chunk binding; contains no provider or arm labels. */
  source_chunk_sequence_sha256: string;
  format: IndependentAsrRequest["format"];
  played_sample_count: number;
  played_pcm: Uint8Array;
}>;

export type IndependentAsrAdapterExecution = Readonly<{
  result: unknown;
  exitCode: number;
  runtimeMs: number;
  stdout: string | Uint8Array;
  stderr: string | Uint8Array;
}>;

export type AudibleUnitMetrics = Readonly<{
  processed_audio_coverage_ppm: number;
  timed_text_coverage_ppm: number;
  confidence_coverage_ppm: number;
  mean_confidence_ppm: number | null;
  no_speech_probability_ppm: number | null;
}>;

export type AudibleSemanticUnitRecord = Readonly<{
  schema_version: 1;
  run_id: string;
  unit_id: string;
  response_id: string;
  blind_observation_sha256: string;
  turn: number;
  audio_artifact_path: string;
  audio: AudiblePcmBinding;
  asr_request_sha256: string;
  asr_contract_sha256: string;
  calibration_evidence_sha256: string;
  asr_invocation_receipt: IndependentAsrInvocationReceipt;
  asr_result: IndependentAsrResult;
  asr_transcript_sha256: string | null;
  asr_transcript_utf8_byte_length: number | null;
  metrics: AudibleUnitMetrics;
  status: "verified" | "unverifiable";
  unverifiable_reasons: readonly string[];
  record_sha256: string;
}>;

export type ConditionBlindListenerObservation =
  | Readonly<{
      schema_version: 1;
      source: "independent_played_pcm_asr";
      status: "verified";
      observation_id: string;
      played_pcm_sha256: string;
      played_through_sample: number;
      transcript: string;
      transcript_sha256: string;
      timed_spans: readonly TimedUtf8Span[];
      evidence_sha256: string;
    }>
  | Readonly<{
      schema_version: 1;
      source: "independent_played_pcm_asr";
      status: "unverifiable";
      observation_id: string;
      played_pcm_sha256: string;
      played_through_sample: number;
      reasons: readonly ("calibration_unvalidated" | "asr_unavailable" | "audio_or_alignment_insufficient")[];
      evidence_sha256: string;
    }>;

const PREPARED_UNIT = Symbol("prepared-independent-audible-unit");
export type PreparedAudibleSemanticUnit = Readonly<{
  [PREPARED_UNIT]: true;
  record: AudibleSemanticUnitRecord;
  listener: ConditionBlindListenerObservation;
}>;
const preparedUnits = new WeakSet<object>();

export type AudibleSemanticEvidenceArtifact = Readonly<{
  schema_version: 1;
  artifact_type: "benchmark_independent_audible_semantics";
  bindings: Readonly<{
    run_id: string;
    timeline_sha256: string;
    transcript_set_sha256: string;
    asr_contract_sha256: string;
    calibration_sha256: string;
    unit_inventory_sha256: string;
    signing_key_id: string;
    signing_public_key_sha256: string;
  }>;
  asr_contract: IndependentAsrContract;
  calibration: IndependentAsrCalibration;
  units: readonly AudibleSemanticUnitRecord[];
  artifact_hash: string;
  signature: Readonly<{
    algorithm: "ed25519";
    key_id: string;
    signature_base64: string;
  }>;
}>;

const VERIFIED_EVIDENCE = Symbol("verified-independent-audible-evidence");
export type VerifiedAudibleSemanticEvidence = Readonly<{
  [VERIFIED_EVIDENCE]: true;
  schema_version: 1;
  artifact_hash: string;
  signature_verified: true;
  run_id: string;
  timeline_sha256: string;
  transcript_set_sha256: string;
  asr_contract_sha256: string;
  calibration_sha256: string;
  signing_key_id: string;
  signing_public_key_sha256: string;
  status: "verified" | "unverifiable";
  claim_eligible: false;
  claim_ineligible_reasons: readonly [
    "caller_playout_receipt_not_verified",
    "runner_execution_is_provenance_only",
    "real_independent_asr_calibration_not_established",
  ];
  units: readonly AudibleSemanticUnitRecord[];
}>;
const verifiedEvidence = new WeakSet<object>();

export type AudibleEvidenceVerification =
  | Readonly<{ ok: true; evidence: VerifiedAudibleSemanticEvidence }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

const CONTRACT_KEYS = Object.freeze([
  "contract_id", "decoding", "engine", "resampling_profile_sha256",
  "result_schema_sha256", "schema_version",
].sort());
const ENGINE_KEYS = Object.freeze([
  "dependency_lock_sha256", "executable_sha256", "implementation", "model_id",
  "model_revision", "source_repository", "source_revision", "weights_sha256",
].sort());
const DECODING_KEYS = Object.freeze([
  "beam_size", "best_of", "condition_on_previous_text", "initial_prompt_sha256",
  "language", "task", "temperature_milli", "word_timestamps",
].sort());
const CALIBRATION_KEYS = Object.freeze([
  "asr_contract_sha256", "asr_outputs_sha256", "calibration_id", "corpus_manifest_sha256",
  "evaluator_build_sha256", "fixture_count", "fixture_evidence_sha256", "fixture_manifest_sha256",
  "human_labels_sha256", "metrics", "protocol_sha256", "route_metrics", "schema_version",
  "runner_signing_key_id", "runner_signing_public_key_sha256", "status", "thresholds", "unvalidated_reasons",
].sort());
const CALIBRATION_METRIC_KEYS = Object.freeze([
  "alignment_boundary_p95_ms", "fixture_coverage_ppm", "runtime_p95_ms",
  "semantic_false_negative_rate_ppm", "semantic_false_negative_upper_bound_ppm",
  "semantic_false_positive_rate_ppm", "semantic_false_positive_upper_bound_ppm",
  "word_error_rate_ppm", "word_error_upper_bound_ppm",
].sort());
const THRESHOLD_KEYS = Object.freeze([
  "max_alignment_boundary_p95_ms", "max_route_word_error_gap_ppm",
  "max_semantic_false_negative_upper_bound_ppm", "max_semantic_false_positive_upper_bound_ppm",
  "max_word_error_upper_bound_ppm", "min_fixture_coverage_ppm",
].sort());
const ROUTE_METRIC_KEYS = Object.freeze([
  "alignment_boundary_p95_ms", "fixture_count", "fixture_coverage_ppm", "reference_word_count",
  "route_id", "runtime_p95_ms", "semantic_false_negative_rate_ppm",
  "semantic_false_negative_upper_bound_ppm", "semantic_false_positive_rate_ppm",
  "semantic_false_positive_upper_bound_ppm", "semantic_negative_count", "semantic_positive_count",
  "word_error_rate_ppm", "word_error_upper_bound_ppm",
].sort());
const ASR_COMPLETED_KEYS = Object.freeze([
  "language", "no_speech_probability_ppm", "processed_through_sample", "source_chunk_sequence_sha256", "source_request_sha256",
  "source_played_audio_sha256", "spans", "status", "transcript",
].sort());
const ASR_UNAVAILABLE_KEYS = Object.freeze(["reason", "reason_code", "status"].sort());
const SPAN_KEYS = Object.freeze([
  "audio_end_sample", "audio_start_sample", "confidence_ppm", "span_id", "text", "utf8_end", "utf8_start",
].sort());
const ARTIFACT_KEYS = Object.freeze([
  "artifact_hash", "artifact_type", "asr_contract", "bindings", "calibration",
  "schema_version", "signature", "units",
].sort());
const BINDING_KEYS = Object.freeze([
  "asr_contract_sha256", "calibration_sha256", "run_id", "signing_key_id",
  "signing_public_key_sha256", "timeline_sha256", "transcript_set_sha256", "unit_inventory_sha256",
].sort());
const SIGNATURE_KEYS = Object.freeze(["algorithm", "key_id", "signature_base64"].sort());
const UNIT_KEYS = Object.freeze([
  "asr_contract_sha256", "asr_invocation_receipt", "asr_request_sha256", "asr_result",
  "asr_transcript_sha256", "asr_transcript_utf8_byte_length", "audio", "audio_artifact_path",
  "blind_observation_sha256", "calibration_evidence_sha256", "metrics", "record_sha256",
  "response_id", "run_id", "schema_version", "status", "turn", "unit_id", "unverifiable_reasons",
].sort());
const AUDIO_KEYS = Object.freeze([
  "chunks", "format", "generated_byte_length", "generated_chunk_sequence_sha256",
  "generated_pcm_sha256", "generated_sample_count", "played_range",
].sort());
const FORMAT_KEYS = Object.freeze(["channels", "encoding", "endianness", "sample_rate_hz"].sort());
const CHUNK_KEYS = Object.freeze([
  "byte_length", "byte_offset", "chunk_id", "ordinal", "sample_count", "sample_offset", "sha256",
].sort());
const PLAYED_RANGE_KEYS = Object.freeze([
  "byte_end", "byte_start", "kind", "played_chunk_sequence_sha256", "played_pcm_sha256",
  "sample_end", "sample_start", "terminal_chunk",
].sort());
const TERMINAL_CHUNK_KEYS = Object.freeze(["byte_end_in_chunk", "ordinal", "sample_end_in_chunk"].sort());
const METRIC_KEYS = Object.freeze([
  "confidence_coverage_ppm", "mean_confidence_ppm", "no_speech_probability_ppm",
  "processed_audio_coverage_ppm", "timed_text_coverage_ppm",
].sort());
const ASR_INVOCATION_RECEIPT_KEYS = Object.freeze([
  "asr_contract_sha256", "executable_sha256", "exit_code", "invocation_id",
  "model_weights_sha256", "normalized_result_sha256", "receipt_sha256", "receipt_type",
  "request_sha256", "run_id", "runtime_ms", "schema_version", "signature",
  "signing_key_id", "signing_public_key_sha256", "source_chunk_sequence_sha256",
  "source_played_audio_sha256", "stderr_sha256", "stdout_sha256", "unit_id",
].sort());
const TRUST_KEYS = Object.freeze(["keyId", "publicKeyPem", "publicKeySha256"].sort());

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function exactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}

function exactDataKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  exactKeys(value, expected, label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
      throw new Error(`${label} must contain plain data properties`);
    }
  }
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
  return value;
}

function nonEmpty(value: unknown, label: string, max = 1_024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function ppm(value: unknown, label: string): number {
  return integer(value, label, 0, PPM);
}

function canonicalSignature(value: unknown): string {
  if (typeof value !== "string") throw new Error("audible evidence signature must be base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 64 || decoded.toString("base64") !== value) {
    throw new Error("audible evidence signature must be one canonical Ed25519 signature");
  }
  return value;
}

export function independentAsrContractSha256(input: IndependentAsrContract): string {
  return domainHash(CONTRACT_DOMAIN, validateContract(input));
}

function validateContract(input: unknown): IndependentAsrContract {
  exactKeys(input, CONTRACT_KEYS, "ASR contract");
  if (input.schema_version !== 1) throw new Error("ASR contract schema is unsupported");
  safeId(input.contract_id, "ASR contract ID");
  exactKeys(input.engine, ENGINE_KEYS, "ASR engine identity");
  const engine = input.engine;
  if (engine.implementation !== "whisper.cpp" && engine.implementation !== "mlx-whisper" && engine.implementation !== "other-open-weight") {
    throw new Error("ASR engine implementation is unsupported");
  }
  const repository = nonEmpty(engine.source_repository, "ASR source repository", 2_048);
  if (!repository.startsWith("https://")) throw new Error("ASR source repository must be HTTPS");
  if (typeof engine.source_revision !== "string" || !REVISION.test(engine.source_revision)) {
    throw new Error("ASR source revision must be an immutable commit digest");
  }
  sha(engine.executable_sha256, "ASR executable hash");
  sha(engine.dependency_lock_sha256, "ASR dependency-lock hash");
  const modelId = nonEmpty(engine.model_id, "ASR model ID", 512);
  if (/(?:^|[-_.\/])(?:latest|main|master)$/i.test(modelId)) throw new Error("ASR model ID cannot use a mutable alias");
  if (typeof engine.model_revision !== "string" || !REVISION.test(engine.model_revision)) {
    throw new Error("ASR model revision must be an immutable digest");
  }
  sha(engine.weights_sha256, "ASR weights hash");
  exactKeys(input.decoding, DECODING_KEYS, "ASR decoding settings");
  const decoding = input.decoding;
  if (typeof decoding.language !== "string" || !SAFE_LANGUAGE.test(decoding.language)) throw new Error("ASR language is invalid");
  if (decoding.task !== "transcribe" || decoding.temperature_milli !== 0 || decoding.word_timestamps !== true
    || decoding.condition_on_previous_text !== false || decoding.initial_prompt_sha256 !== null) {
    throw new Error("ASR decoding settings are not deterministic independent transcription settings");
  }
  integer(decoding.beam_size, "ASR beam size", 1, 32);
  integer(decoding.best_of, "ASR best_of", 1, 32);
  sha(input.resampling_profile_sha256, "ASR resampling profile hash");
  if (sha(input.result_schema_sha256, "ASR result schema hash") !== INDEPENDENT_ASR_RESULT_SCHEMA_SHA256) {
    throw new Error("ASR result schema hash is unsupported");
  }
  return immutableJson(input) as unknown as IndependentAsrContract;
}

export function independentAsrCalibrationSha256(input: IndependentAsrCalibration): string {
  return domainHash(CALIBRATION_DOMAIN, validateCalibration(input));
}

function validateCalibration(input: unknown): IndependentAsrCalibration {
  exactKeys(input, CALIBRATION_KEYS, "ASR calibration");
  if (input.schema_version !== 1) throw new Error("ASR calibration schema is unsupported");
  const calibrationId = safeId(input.calibration_id, "ASR calibration ID");
  if (input.status !== "calibrated" && input.status !== "development_only_unvalidated") {
    throw new Error("ASR calibration status is invalid");
  }
  const status = input.status;
  const asrContractSha256 = sha(input.asr_contract_sha256, "ASR calibration contract hash");
  const protocolSha256 = sha(input.protocol_sha256, "ASR calibration protocol hash");
  const corpusManifestSha256 = sha(input.corpus_manifest_sha256, "ASR calibration corpus-manifest hash");
  const fixtureManifestSha256 = sha(input.fixture_manifest_sha256, "ASR calibration fixture-manifest hash");
  const humanLabelsSha256 = sha(input.human_labels_sha256, "ASR calibration human-label hash");
  const asrOutputsSha256 = sha(input.asr_outputs_sha256, "ASR calibration ASR-output hash");
  const fixtureEvidenceSha256 = sha(input.fixture_evidence_sha256, "ASR calibration fixture-evidence hash");
  const evaluatorBuildSha256 = sha(input.evaluator_build_sha256, "ASR calibration evaluator-build hash");
  const runnerSigningKeyId = safeId(input.runner_signing_key_id, "ASR calibration runner signing key ID");
  const runnerSigningPublicKeySha256 = sha(
    input.runner_signing_public_key_sha256,
    "ASR calibration runner signing public-key fingerprint"
  );
  const fixtureCount = integer(input.fixture_count, "ASR calibration fixture count", 1, 1_000_000);
  if (!Array.isArray(input.route_metrics) || input.route_metrics.length < 1 || input.route_metrics.length > 64) {
    throw new Error("ASR calibration route metrics are invalid");
  }
  const routeIds = new Set<string>();
  const routeMetrics = input.route_metrics.map((route, index): AsrCalibrationRouteMetrics => {
    exactKeys(route, ROUTE_METRIC_KEYS, `ASR calibration route metric ${index}`);
    const routeId = safeId(route.route_id, `ASR calibration route ${index} ID`);
    if (routeIds.has(routeId)) throw new Error("ASR calibration route IDs must be unique");
    routeIds.add(routeId);
    return Object.freeze({
      route_id: routeId,
      fixture_count: integer(route.fixture_count, `ASR route ${routeId} fixture count`, 0),
      reference_word_count: integer(route.reference_word_count, `ASR route ${routeId} reference-word count`, 0),
      semantic_positive_count: integer(route.semantic_positive_count, `ASR route ${routeId} semantic-positive count`, 0),
      semantic_negative_count: integer(route.semantic_negative_count, `ASR route ${routeId} semantic-negative count`, 0),
      word_error_rate_ppm: ppm(route.word_error_rate_ppm, `ASR route ${routeId} WER`),
      word_error_upper_bound_ppm: ppm(route.word_error_upper_bound_ppm, `ASR route ${routeId} WER upper bound`),
      semantic_false_negative_rate_ppm: ppm(route.semantic_false_negative_rate_ppm, `ASR route ${routeId} semantic FN`),
      semantic_false_negative_upper_bound_ppm: ppm(route.semantic_false_negative_upper_bound_ppm, `ASR route ${routeId} semantic FN upper bound`),
      semantic_false_positive_rate_ppm: ppm(route.semantic_false_positive_rate_ppm, `ASR route ${routeId} semantic FP`),
      semantic_false_positive_upper_bound_ppm: ppm(route.semantic_false_positive_upper_bound_ppm, `ASR route ${routeId} semantic FP upper bound`),
      alignment_boundary_p95_ms: integer(route.alignment_boundary_p95_ms, `ASR route ${routeId} alignment p95`, 0, 60_000),
      fixture_coverage_ppm: ppm(route.fixture_coverage_ppm, `ASR route ${routeId} fixture coverage`),
      runtime_p95_ms: integer(route.runtime_p95_ms, `ASR route ${routeId} runtime p95`, 0, 3_600_000),
    });
  });
  if (routeMetrics.reduce((sum, route) => sum + route.fixture_count, 0) !== fixtureCount) {
    throw new Error("ASR calibration routes do not cover every fixture");
  }
  exactKeys(input.metrics, CALIBRATION_METRIC_KEYS, "ASR calibration metrics");
  const metrics = Object.freeze({
    word_error_rate_ppm: ppm(input.metrics.word_error_rate_ppm, "ASR calibration WER"),
    word_error_upper_bound_ppm: ppm(input.metrics.word_error_upper_bound_ppm, "ASR calibration WER upper bound"),
    semantic_false_negative_rate_ppm: ppm(
      input.metrics.semantic_false_negative_rate_ppm,
      "ASR calibration semantic false-negative rate"
    ),
    semantic_false_negative_upper_bound_ppm: ppm(
      input.metrics.semantic_false_negative_upper_bound_ppm,
      "ASR calibration semantic false-negative upper bound"
    ),
    semantic_false_positive_rate_ppm: ppm(
      input.metrics.semantic_false_positive_rate_ppm,
      "ASR calibration semantic false-positive rate"
    ),
    semantic_false_positive_upper_bound_ppm: ppm(
      input.metrics.semantic_false_positive_upper_bound_ppm,
      "ASR calibration semantic false-positive upper bound"
    ),
    alignment_boundary_p95_ms: integer(
      input.metrics.alignment_boundary_p95_ms,
      "ASR calibration alignment boundary p95",
      0,
      60_000
    ),
    fixture_coverage_ppm: ppm(input.metrics.fixture_coverage_ppm, "ASR calibration fixture coverage"),
    runtime_p95_ms: integer(input.metrics.runtime_p95_ms, "ASR calibration runtime p95", 0, 3_600_000),
  });
  exactKeys(input.thresholds, THRESHOLD_KEYS, "ASR calibration thresholds");
  const thresholds = Object.freeze({
    min_fixture_coverage_ppm: ppm(input.thresholds.min_fixture_coverage_ppm, "ASR threshold minimum fixture coverage"),
    max_word_error_upper_bound_ppm: ppm(input.thresholds.max_word_error_upper_bound_ppm, "ASR threshold WER upper bound"),
    max_semantic_false_negative_upper_bound_ppm: ppm(input.thresholds.max_semantic_false_negative_upper_bound_ppm, "ASR threshold semantic FN upper bound"),
    max_semantic_false_positive_upper_bound_ppm: ppm(input.thresholds.max_semantic_false_positive_upper_bound_ppm, "ASR threshold semantic FP upper bound"),
    max_alignment_boundary_p95_ms: integer(input.thresholds.max_alignment_boundary_p95_ms, "ASR threshold alignment p95", 0, 60_000),
    max_route_word_error_gap_ppm: ppm(input.thresholds.max_route_word_error_gap_ppm, "ASR threshold route WER gap"),
  });
  if (!Array.isArray(input.unvalidated_reasons)
    || input.unvalidated_reasons.some((reason) => typeof reason !== "string" || !SAFE_ID.test(reason))) {
    throw new Error("ASR calibration unvalidated reasons are invalid");
  }
  const reasons = Object.freeze([...new Set(input.unvalidated_reasons.map((reason, index) =>
    safeId(reason, `ASR calibration unvalidated reason ${index}`)))].sort(asciiCompare));
  if ((status === "calibrated") !== (reasons.length === 0)) throw new Error("ASR calibration status differs from derived reasons");
  return Object.freeze({
    schema_version: 1,
    calibration_id: calibrationId,
    status,
    asr_contract_sha256: asrContractSha256,
    protocol_sha256: protocolSha256,
    corpus_manifest_sha256: corpusManifestSha256,
    fixture_manifest_sha256: fixtureManifestSha256,
    human_labels_sha256: humanLabelsSha256,
    asr_outputs_sha256: asrOutputsSha256,
    fixture_evidence_sha256: fixtureEvidenceSha256,
    evaluator_build_sha256: evaluatorBuildSha256,
    runner_signing_key_id: runnerSigningKeyId,
    runner_signing_public_key_sha256: runnerSigningPublicKeySha256,
    fixture_count: fixtureCount,
    route_metrics: Object.freeze(routeMetrics),
    metrics,
    thresholds,
    unvalidated_reasons: reasons,
  });
}

type MeasuredCalibrationFixture = Readonly<{
  fixture_id: string;
  route_id: string;
  split: "held_out";
  corpus_sample_id: string;
  audio_sha256: string;
  request_sha256: string;
  runner_receipt_sha256: string;
  reference_transcript: string;
  hypothesis_transcript: string;
  expected_semantic_phrases: readonly string[];
  forbidden_semantic_phrases: readonly string[];
  reference_audio_start_sample: number;
  reference_audio_end_sample: number;
  hypothesis_audio_start_sample: number | null;
  hypothesis_audio_end_sample: number | null;
  sample_rate_hz: number;
  runtime_ms: number;
  covered: boolean;
  reference_word_count: number;
  word_errors: number;
  semantic_positive_count: number;
  semantic_false_negatives: number;
  semantic_negative_count: number;
  semantic_false_positives: number;
  alignment_errors_ms: readonly number[];
}>;

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPhrase(value: unknown, label: string): string {
  const phrase = nonEmpty(value, label, 256);
  const tokens = words(phrase);
  if (tokens.length < 1 || tokens.length > 16) throw new Error(`${label} must contain 1..16 lexical tokens`);
  return tokens.join(" ");
}

function containsPhrase(transcript: string, phrase: string): boolean {
  const haystack = words(transcript);
  const needle = words(phrase);
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, index) => token === haystack[start + index])) return true;
  }
  return false;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

/** One-sided 95% Wilson upper bound, expressed in integer parts per million. */
function wilsonUpperPpm(errorsInput: number, trials: number): number {
  if (trials <= 0) return PPM;
  const errors = Math.min(trials, Math.max(0, errorsInput));
  const z = 1.6448536269514722;
  const p = errors / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.min(PPM, Math.ceil(((center + margin) / denominator) * PPM));
}

function calibrationRouteMetrics(
  routeId: string,
  fixtures: readonly MeasuredCalibrationFixture[]
): AsrCalibrationRouteMetrics {
  const referenceWords = fixtures.reduce((sum, fixture) => sum + fixture.reference_word_count, 0);
  const wordErrors = fixtures.reduce((sum, fixture) => sum + fixture.word_errors, 0);
  const positiveCount = fixtures.reduce((sum, fixture) => sum + fixture.semantic_positive_count, 0);
  const falseNegatives = fixtures.reduce((sum, fixture) => sum + fixture.semantic_false_negatives, 0);
  const negativeCount = fixtures.reduce((sum, fixture) => sum + fixture.semantic_negative_count, 0);
  const falsePositives = fixtures.reduce((sum, fixture) => sum + fixture.semantic_false_positives, 0);
  return Object.freeze({
    route_id: routeId,
    fixture_count: fixtures.length,
    reference_word_count: referenceWords,
    semantic_positive_count: positiveCount,
    semantic_negative_count: negativeCount,
    word_error_rate_ppm: ratioPpm(wordErrors, referenceWords),
    word_error_upper_bound_ppm: wilsonUpperPpm(wordErrors, referenceWords),
    semantic_false_negative_rate_ppm: ratioPpm(falseNegatives, positiveCount),
    semantic_false_negative_upper_bound_ppm: wilsonUpperPpm(falseNegatives, positiveCount),
    semantic_false_positive_rate_ppm: ratioPpm(falsePositives, negativeCount),
    semantic_false_positive_upper_bound_ppm: wilsonUpperPpm(falsePositives, negativeCount),
    alignment_boundary_p95_ms: percentile95(fixtures.flatMap((fixture) => fixture.alignment_errors_ms)),
    fixture_coverage_ppm: ratioPpm(fixtures.filter((fixture) => fixture.covered).length, fixtures.length),
    runtime_p95_ms: percentile95(fixtures.map((fixture) => fixture.runtime_ms)),
  });
}

function calibrationMetrics(fixtures: readonly MeasuredCalibrationFixture[]) {
  const metrics = calibrationRouteMetrics("aggregate", fixtures);
  return Object.freeze({
    word_error_rate_ppm: metrics.word_error_rate_ppm,
    word_error_upper_bound_ppm: metrics.word_error_upper_bound_ppm,
    semantic_false_negative_rate_ppm: metrics.semantic_false_negative_rate_ppm,
    semantic_false_negative_upper_bound_ppm: metrics.semantic_false_negative_upper_bound_ppm,
    semantic_false_positive_rate_ppm: metrics.semantic_false_positive_rate_ppm,
    semantic_false_positive_upper_bound_ppm: metrics.semantic_false_positive_upper_bound_ppm,
    alignment_boundary_p95_ms: metrics.alignment_boundary_p95_ms,
    fixture_coverage_ppm: metrics.fixture_coverage_ppm,
    runtime_p95_ms: metrics.runtime_p95_ms,
  });
}

export function prepareIndependentAsrCalibration(input: Readonly<{
  plan: IndependentAsrCalibrationPlan;
  contract: IndependentAsrContract;
  fixtures: readonly AsrCalibrationSourceFixture[];
  runnerTrust: BenchmarkKernelAttestationTrust;
}>): PreparedIndependentAsrCalibration {
  const contract = validateContract(input.contract);
  const contractSha256 = independentAsrContractSha256(contract);
  const runnerTrust = snapshotTrust(input.runnerTrust, "ASR calibration runner trust");
  const calibrationId = safeId(input.plan.calibration_id, "ASR calibration plan ID");
  const protocolSha256 = sha(input.plan.protocol_sha256, "ASR calibration protocol hash");
  const corpusManifestSha256 = sha(input.plan.corpus_manifest_sha256, "ASR calibration corpus-manifest hash");
  const evaluatorBuildSha256 = sha(input.plan.evaluator_build_sha256, "ASR calibration evaluator-build hash");
  exactKeys(input.plan.thresholds, THRESHOLD_KEYS, "ASR calibration plan thresholds");
  const thresholds: IndependentAsrCalibration["thresholds"] = Object.freeze({
    min_fixture_coverage_ppm: ppm(input.plan.thresholds.min_fixture_coverage_ppm, "minimum ASR fixture coverage"),
    max_word_error_upper_bound_ppm: ppm(input.plan.thresholds.max_word_error_upper_bound_ppm, "maximum ASR WER upper bound"),
    max_semantic_false_negative_upper_bound_ppm: ppm(input.plan.thresholds.max_semantic_false_negative_upper_bound_ppm, "maximum ASR semantic FN upper bound"),
    max_semantic_false_positive_upper_bound_ppm: ppm(input.plan.thresholds.max_semantic_false_positive_upper_bound_ppm, "maximum ASR semantic FP upper bound"),
    max_alignment_boundary_p95_ms: integer(input.plan.thresholds.max_alignment_boundary_p95_ms, "maximum ASR alignment p95", 0, 60_000),
    max_route_word_error_gap_ppm: ppm(input.plan.thresholds.max_route_word_error_gap_ppm, "maximum ASR route WER gap"),
  });
  if (thresholds.min_fixture_coverage_ppm < 950_000
    || thresholds.max_word_error_upper_bound_ppm > 250_000
    || thresholds.max_semantic_false_negative_upper_bound_ppm > 200_000
    || thresholds.max_semantic_false_positive_upper_bound_ppm > 200_000
    || thresholds.max_alignment_boundary_p95_ms > 1_000
    || thresholds.max_route_word_error_gap_ppm > 150_000) {
    throw new Error("ASR calibration thresholds exceed the framework's maximum claim policy");
  }
  if (!Array.isArray(input.plan.expected_route_ids) || input.plan.expected_route_ids.length < 2
    || input.plan.expected_route_ids.length > 16) throw new Error("ASR calibration requires 2..16 preregistered routes");
  const routeIds = input.plan.expected_route_ids.map((routeId, index) => safeId(routeId, `ASR calibration route ${index} ID`));
  if (new Set(routeIds).size !== routeIds.length) throw new Error("ASR calibration expected routes contain duplicates");
  routeIds.sort(asciiCompare);
  if (!Array.isArray(input.fixtures) || input.fixtures.length < 1 || input.fixtures.length > MAX_CALIBRATION_FIXTURES) {
    throw new Error("ASR calibration fixture inventory is invalid");
  }
  const fixtureIds = new Set<string>();
  const receiptIds = new Set<string>();
  const routeSampleIds = new Set<string>();
  const routeAudioIds = new Set<string>();
  const runnerIdentities = new Set<string>();
  const adapterBlindNonces = new Set<string>();
  const measured = input.fixtures.map((fixture: AsrCalibrationSourceFixture): MeasuredCalibrationFixture => {
    const fixtureId = safeId(fixture.fixture_id, "ASR calibration fixture ID");
    if (fixtureIds.has(fixtureId)) throw new Error("ASR calibration fixture IDs must be unique");
    fixtureIds.add(fixtureId);
    const routeId = safeId(fixture.route_id, `ASR calibration fixture ${fixtureId} route ID`);
    if (!routeIds.includes(routeId)) throw new Error(`ASR calibration fixture ${fixtureId} uses an unregistered route`);
    if (fixture.split !== "held_out") throw new Error("ASR calibration fixtures must use the held-out split");
    const corpusSampleId = safeId(fixture.corpus_sample_id, `ASR calibration fixture ${fixtureId} corpus sample ID`);
    const routeSampleId = `${routeId}\0${corpusSampleId}`;
    if (routeSampleIds.has(routeSampleId)) throw new Error("ASR calibration repeats a corpus sample within one route");
    routeSampleIds.add(routeSampleId);
    if (!verifiedAsrInvocations.has(fixture.invocation)
      || fixture.invocation[VERIFIED_ASR_INVOCATION] !== true) {
      throw new Error("ASR calibration requires independently verified runner invocations");
    }
    const invocation = verifyIndependentAsrInvocation({
      request: fixture.invocation.request,
      contract,
      result: fixture.invocation.result,
      receipt: fixture.invocation.receipt,
      runnerTrust,
    });
    if (invocation.request.asr_contract_sha256 !== contractSha256
      || invocation.receipt.asr_contract_sha256 !== contractSha256) {
      throw new Error("ASR calibration fixture contract/model/weights substitution");
    }
    if (invocation.request.unit_id !== fixtureId || invocation.receipt.unit_id !== fixtureId) {
      throw new Error("ASR calibration fixture ID differs from its runner receipt unit");
    }
    if (receiptIds.has(invocation.receipt.receipt_sha256)) throw new Error("ASR calibration reuses a runner receipt");
    receiptIds.add(invocation.receipt.receipt_sha256);
    const routeAudioId = `${routeId}\0${invocation.request.source_played_audio_sha256}`;
    if (routeAudioIds.has(routeAudioId)) throw new Error("ASR calibration repeats identical audio within one route");
    routeAudioIds.add(routeAudioId);
    runnerIdentities.add(`${invocation.receipt.signing_key_id}\0${invocation.receipt.signing_public_key_sha256}`);
    if (adapterBlindNonces.has(invocation.request.adapter_blind_nonce_sha256)) {
      throw new Error("ASR calibration repeats an adapter blind nonce");
    }
    adapterBlindNonces.add(invocation.request.adapter_blind_nonce_sha256);
    const referenceTranscript = nonEmpty(
      fixture.reference_transcript,
      `ASR fixture ${fixtureId} human transcript`,
      MAX_CALIBRATION_TRANSCRIPT_CHARACTERS
    );
    const referenceWords = words(referenceTranscript);
    if (referenceWords.length < 1 || referenceWords.length > MAX_CALIBRATION_WORDS_PER_FIXTURE) {
      throw new Error("ASR calibration reference word count is invalid");
    }
    const expected = fixture.expected_semantic_phrases.map((phrase, index) =>
      normalizedPhrase(phrase, `ASR fixture ${fixtureId} expected semantic phrase ${index}`));
    const forbidden = fixture.forbidden_semantic_phrases.map((phrase, index) =>
      normalizedPhrase(phrase, `ASR fixture ${fixtureId} forbidden semantic phrase ${index}`));
    if (expected.length < 1 || forbidden.length < 1 || expected.length > 64 || forbidden.length > 64
      || new Set(expected).size !== expected.length || new Set(forbidden).size !== forbidden.length) {
      throw new Error("ASR calibration semantic labels must be bounded, non-empty, and unique");
    }
    if (expected.some((phrase) => !containsPhrase(referenceTranscript, phrase))) {
      throw new Error("ASR expected semantic phrases must occur in the human transcript");
    }
    if (forbidden.some((phrase) => containsPhrase(referenceTranscript, phrase))
      || forbidden.some((phrase) => expected.includes(phrase))) {
      throw new Error("ASR forbidden semantic phrases must be absent from the human transcript");
    }
    const playedSamples = invocation.request.played_sample_count;
    const referenceStart = integer(fixture.reference_audio_start_sample, `ASR fixture ${fixtureId} reference start`, 0, playedSamples);
    const referenceEnd = integer(fixture.reference_audio_end_sample, `ASR fixture ${fixtureId} reference end`, referenceStart + 1, playedSamples);
    const result = invocation.result;
    const hypothesis = result.status === "completed" ? result.transcript : "";
    if (hypothesis.length > MAX_CALIBRATION_TRANSCRIPT_CHARACTERS
      || words(hypothesis).length > MAX_CALIBRATION_WORDS_PER_FIXTURE * 2) {
      throw new Error("ASR calibration hypothesis exceeds the bounded evaluator input");
    }
    const firstSpan = result.status === "completed" ? result.spans[0] : undefined;
    const lastSpan = result.status === "completed" ? result.spans[result.spans.length - 1] : undefined;
    const hypothesisStart = firstSpan?.audio_start_sample ?? null;
    const hypothesisEnd = lastSpan?.audio_end_sample ?? null;
    const sampleRate = invocation.request.format.sample_rate_hz;
    const durationMs = Math.ceil((referenceEnd - referenceStart) * 1_000 / sampleRate);
    const alignmentErrors = hypothesisStart === null || hypothesisEnd === null
      ? Object.freeze([durationMs, durationMs])
      : Object.freeze([
          Math.ceil(Math.abs(hypothesisStart - referenceStart) * 1_000 / sampleRate),
          Math.ceil(Math.abs(hypothesisEnd - referenceEnd) * 1_000 / sampleRate),
        ]);
    const processedCoverage = result.status === "completed"
      ? ratioPpm(result.processed_through_sample, playedSamples)
      : 0;
    return Object.freeze({
      fixture_id: fixtureId,
      route_id: routeId,
      split: "held_out",
      corpus_sample_id: corpusSampleId,
      audio_sha256: invocation.request.source_played_audio_sha256,
      request_sha256: invocation.request.request_sha256,
      runner_receipt_sha256: invocation.receipt.receipt_sha256,
      reference_transcript: referenceTranscript,
      hypothesis_transcript: hypothesis,
      expected_semantic_phrases: Object.freeze(expected),
      forbidden_semantic_phrases: Object.freeze(forbidden),
      reference_audio_start_sample: referenceStart,
      reference_audio_end_sample: referenceEnd,
      hypothesis_audio_start_sample: hypothesisStart,
      hypothesis_audio_end_sample: hypothesisEnd,
      sample_rate_hz: sampleRate,
      runtime_ms: invocation.receipt.runtime_ms,
      covered: result.status === "completed" && hypothesis.length > 0 && processedCoverage >= 990_000,
      reference_word_count: referenceWords.length,
      word_errors: editDistance(referenceWords, words(hypothesis)),
      semantic_positive_count: expected.length,
      semantic_false_negatives: expected.filter((phrase) => !containsPhrase(hypothesis, phrase)).length,
      semantic_negative_count: forbidden.length,
      semantic_false_positives: forbidden.filter((phrase) => containsPhrase(hypothesis, phrase)).length,
      alignment_errors_ms: alignmentErrors,
    });
  }).sort((left, right) => asciiCompare(left.fixture_id, right.fixture_id));
  const routeMetrics = routeIds.map((routeId) => calibrationRouteMetrics(
    routeId,
    measured.filter((fixture) => fixture.route_id === routeId)
  ));
  const metrics = calibrationMetrics(measured);
  const reasons: string[] = [];
  if (measured.length < MIN_CALIBRATION_FIXTURES) reasons.push("insufficient_fixture_count");
  if (runnerIdentities.size !== 1) reasons.push("runner_identity_not_uniform");
  if (new Set(routeMetrics.map((route) => route.fixture_count)).size !== 1) reasons.push("route_fixture_counts_unbalanced");
  for (const route of routeMetrics) {
    if (route.fixture_count < MIN_CALIBRATION_FIXTURES_PER_ROUTE) reasons.push(`insufficient_route_fixtures:${route.route_id}`);
    if (route.reference_word_count < MIN_CALIBRATION_WORDS_PER_ROUTE) reasons.push(`insufficient_route_words:${route.route_id}`);
    if (route.semantic_positive_count < MIN_CALIBRATION_SEMANTIC_EVENTS_PER_ROUTE) reasons.push(`insufficient_route_positive_events:${route.route_id}`);
    if (route.semantic_negative_count < MIN_CALIBRATION_SEMANTIC_EVENTS_PER_ROUTE) reasons.push(`insufficient_route_negative_events:${route.route_id}`);
    if (route.fixture_coverage_ppm < thresholds.min_fixture_coverage_ppm) reasons.push(`route_coverage_below_threshold:${route.route_id}`);
    if (route.word_error_upper_bound_ppm > thresholds.max_word_error_upper_bound_ppm) reasons.push(`route_wer_above_threshold:${route.route_id}`);
    if (route.semantic_false_negative_upper_bound_ppm > thresholds.max_semantic_false_negative_upper_bound_ppm) reasons.push(`route_semantic_fn_above_threshold:${route.route_id}`);
    if (route.semantic_false_positive_upper_bound_ppm > thresholds.max_semantic_false_positive_upper_bound_ppm) reasons.push(`route_semantic_fp_above_threshold:${route.route_id}`);
    if (route.alignment_boundary_p95_ms > thresholds.max_alignment_boundary_p95_ms) reasons.push(`route_alignment_above_threshold:${route.route_id}`);
  }
  if (metrics.fixture_coverage_ppm < thresholds.min_fixture_coverage_ppm) reasons.push("aggregate_coverage_below_threshold");
  if (metrics.word_error_upper_bound_ppm > thresholds.max_word_error_upper_bound_ppm) reasons.push("aggregate_wer_above_threshold");
  if (metrics.semantic_false_negative_upper_bound_ppm > thresholds.max_semantic_false_negative_upper_bound_ppm) reasons.push("aggregate_semantic_fn_above_threshold");
  if (metrics.semantic_false_positive_upper_bound_ppm > thresholds.max_semantic_false_positive_upper_bound_ppm) reasons.push("aggregate_semantic_fp_above_threshold");
  if (metrics.alignment_boundary_p95_ms > thresholds.max_alignment_boundary_p95_ms) reasons.push("aggregate_alignment_above_threshold");
  const routeWer = routeMetrics.map((route) => route.word_error_rate_ppm);
  if (Math.max(...routeWer) - Math.min(...routeWer) > thresholds.max_route_word_error_gap_ppm) {
    reasons.push("route_word_error_gap_above_threshold");
  }
  const fixtureManifest = measured.map((fixture) => ({
    fixture_id: fixture.fixture_id,
    route_id: fixture.route_id,
    split: fixture.split,
    corpus_sample_id: fixture.corpus_sample_id,
    audio_sha256: fixture.audio_sha256,
    request_sha256: fixture.request_sha256,
  }));
  const humanLabels = measured.map((fixture) => ({
    fixture_id: fixture.fixture_id,
    reference_transcript: fixture.reference_transcript,
    expected_semantic_phrases: fixture.expected_semantic_phrases,
    forbidden_semantic_phrases: fixture.forbidden_semantic_phrases,
    reference_audio_start_sample: fixture.reference_audio_start_sample,
    reference_audio_end_sample: fixture.reference_audio_end_sample,
  }));
  const outputs = measured.map((fixture) => ({
    fixture_id: fixture.fixture_id,
    hypothesis_transcript: fixture.hypothesis_transcript,
    hypothesis_audio_start_sample: fixture.hypothesis_audio_start_sample,
    hypothesis_audio_end_sample: fixture.hypothesis_audio_end_sample,
    runner_receipt_sha256: fixture.runner_receipt_sha256,
    runtime_ms: fixture.runtime_ms,
  }));
  const fixtureManifestSha256 = domainHash(CALIBRATION_FIXTURE_DOMAIN, fixtureManifest);
  const humanLabelsSha256 = domainHash(CALIBRATION_LABEL_DOMAIN, humanLabels);
  const asrOutputsSha256 = domainHash(CALIBRATION_OUTPUT_DOMAIN, outputs);
  const summary = validateCalibration({
    schema_version: 1,
    calibration_id: calibrationId,
    status: reasons.length === 0 ? "calibrated" : "development_only_unvalidated",
    asr_contract_sha256: contractSha256,
    protocol_sha256: protocolSha256,
    corpus_manifest_sha256: corpusManifestSha256,
    fixture_manifest_sha256: fixtureManifestSha256,
    human_labels_sha256: humanLabelsSha256,
    asr_outputs_sha256: asrOutputsSha256,
    fixture_evidence_sha256: domainHash(CALIBRATION_EVIDENCE_DOMAIN, {
      contract_sha256: contractSha256,
      protocol_sha256: protocolSha256,
      corpus_manifest_sha256: corpusManifestSha256,
      fixture_manifest_sha256: fixtureManifestSha256,
      human_labels_sha256: humanLabelsSha256,
      asr_outputs_sha256: asrOutputsSha256,
      evaluator_build_sha256: evaluatorBuildSha256,
    }),
    evaluator_build_sha256: evaluatorBuildSha256,
    runner_signing_key_id: runnerTrust.keyId,
    runner_signing_public_key_sha256: runnerTrust.publicKeySha256,
    fixture_count: measured.length,
    route_metrics: routeMetrics,
    metrics,
    thresholds,
    unvalidated_reasons: [...new Set(reasons)].sort(asciiCompare),
  });
  const prepared = Object.freeze({
    [PREPARED_CALIBRATION]: true as const,
    summary,
    runnerTrust,
  });
  preparedCalibrations.add(prepared);
  return prepared;
}

function concatenateChunks(chunks: readonly AudiblePcmChunk[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  if (!Number.isSafeInteger(total) || total > MAX_AUDIO_BYTES) throw new Error("audible PCM exceeds the 256 MiB unit bound");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return output;
}

function bindAudio(chunksInput: readonly AudiblePcmChunk[], playedThroughByteInput: number): AudiblePcmBinding {
  if (!Array.isArray(chunksInput) || chunksInput.length < 1 || chunksInput.length > MAX_CHUNKS) {
    throw new Error("audible PCM requires 1..4096 ordered chunks");
  }
  const chunks = chunksInput.map((chunk) => ({ ...chunk, data: Uint8Array.from(chunk.data) }));
  const first = chunks[0];
  if (first.encoding !== "pcm16" || first.channels !== 1 || !Number.isSafeInteger(first.sampleRateHz)
    || first.sampleRateHz < 8_000 || first.sampleRateHz > 192_000) throw new Error("audible PCM format is invalid");
  const ids = new Set<string>();
  let byteOffset = 0;
  let sampleOffset = 0;
  const descriptors: AudiblePcmChunkDescriptor[] = chunks.map((chunk, ordinal) => {
    safeId(chunk.chunkId, `PCM chunk ${ordinal} ID`);
    if (ids.has(chunk.chunkId)) throw new Error("audible PCM contains duplicate chunk IDs");
    ids.add(chunk.chunkId);
    if (chunk.encoding !== first.encoding || chunk.channels !== first.channels || chunk.sampleRateHz !== first.sampleRateHz) {
      throw new Error("audible PCM changes format between chunks");
    }
    if (!(chunk.data instanceof Uint8Array) || chunk.data.byteLength < 2 || chunk.data.byteLength % 2 !== 0) {
      throw new Error(`PCM chunk ${ordinal} must contain complete non-empty PCM16 samples`);
    }
    const descriptor = Object.freeze({
      ordinal,
      chunk_id: chunk.chunkId,
      byte_offset: byteOffset,
      byte_length: chunk.data.byteLength,
      sample_offset: sampleOffset,
      sample_count: chunk.data.byteLength / 2,
      sha256: sha256Hex(chunk.data),
    });
    byteOffset += chunk.data.byteLength;
    sampleOffset += chunk.data.byteLength / 2;
    return descriptor;
  });
  const generated = concatenateChunks(chunks);
  const playedThroughByte = integer(playedThroughByteInput, "played-through byte", 0, generated.byteLength);
  if (playedThroughByte % 2 !== 0) throw new Error("played-through byte must end on a PCM16 sample boundary");
  const played = generated.subarray(0, playedThroughByte);
  let terminalChunk: AudiblePcmBinding["played_range"]["terminal_chunk"] = null;
  if (playedThroughByte > 0) {
    const descriptor = descriptors.find((candidate) =>
      playedThroughByte > candidate.byte_offset
      && playedThroughByte <= candidate.byte_offset + candidate.byte_length
    );
    if (!descriptor) throw new Error("played-through byte is detached from the PCM chunk sequence");
    const byteEndInChunk = playedThroughByte - descriptor.byte_offset;
    terminalChunk = Object.freeze({
      ordinal: descriptor.ordinal,
      byte_end_in_chunk: byteEndInChunk,
      sample_end_in_chunk: byteEndInChunk / 2,
    });
  }
  const generatedChunkSequenceSha256 = domainHash(AUDIO_CHUNK_SEQUENCE_DOMAIN, descriptors);
  const format = Object.freeze({
    encoding: "pcm16" as const,
    endianness: "little" as const,
    sample_rate_hz: first.sampleRateHz,
    channels: 1 as const,
  });
  const playedChunkDescriptors = descriptors
    .filter((descriptor) => descriptor.byte_offset < playedThroughByte)
    .map((descriptor) => {
      const playedByteLength = Math.min(
        descriptor.byte_length,
        playedThroughByte - descriptor.byte_offset
      );
      const chunkBytes = chunks[descriptor.ordinal].data.subarray(0, playedByteLength);
      return Object.freeze({
        ordinal: descriptor.ordinal,
        chunk_id: descriptor.chunk_id,
        byte_offset: descriptor.byte_offset,
        byte_length: playedByteLength,
        sample_offset: descriptor.sample_offset,
        sample_count: playedByteLength / 2,
        sha256: sha256Hex(chunkBytes),
      });
    });
  const playedPcmSha256 = sha256Hex(played);
  const playedChunkSequenceSha256 = domainHash(PLAYED_CHUNK_SEQUENCE_DOMAIN, {
    format,
    played_byte_length: playedThroughByte,
    played_sample_count: playedThroughByte / 2,
    played_pcm_sha256: playedPcmSha256,
    chunks: playedChunkDescriptors,
  });
  return immutableJson({
    format,
    chunks: descriptors,
    generated_byte_length: generated.byteLength,
    generated_sample_count: generated.byteLength / 2,
    generated_pcm_sha256: sha256Hex(generated),
    generated_chunk_sequence_sha256: generatedChunkSequenceSha256,
    played_range: {
      kind: "contiguous_prefix",
      byte_start: 0,
      byte_end: playedThroughByte,
      sample_start: 0,
      sample_end: playedThroughByte / 2,
      played_pcm_sha256: playedPcmSha256,
      played_chunk_sequence_sha256: playedChunkSequenceSha256,
      terminal_chunk: terminalChunk,
    },
  }) as unknown as AudiblePcmBinding;
}

export function createIndependentAsrRequest(input: Readonly<{
  runId: string;
  unitId: string;
  invocationId: string;
  adapterBlindNonceSha256: string;
  contract: IndependentAsrContract;
  chunks: readonly AudiblePcmChunk[];
  playedThroughByte: number;
}>): IndependentAsrRequest {
  const runId = safeId(input.runId, "independent ASR request run ID");
  const unitId = safeId(input.unitId, "independent ASR request unit ID");
  const invocationId = safeId(input.invocationId, "independent ASR invocation ID");
  const adapterBlindNonceSha256 = sha(input.adapterBlindNonceSha256, "independent ASR adapter blind nonce hash");
  const contract = validateContract(input.contract);
  if (!Array.isArray(input.chunks)) throw new Error("independent ASR request chunks are invalid");
  const chunks = input.chunks.map((chunk) => ({ ...chunk, data: Uint8Array.from(chunk.data) }));
  const generatedAudioBinding = bindAudio(chunks, input.playedThroughByte);
  const generated = concatenateChunks(chunks);
  const playedPcm = Uint8Array.from(generated.subarray(0, generatedAudioBinding.played_range.byte_end));
  const audiblePrefixChunks = generatedAudioBinding.chunks
    .filter((descriptor) => descriptor.byte_offset < generatedAudioBinding.played_range.byte_end)
    .map((descriptor) => ({
      chunkId: descriptor.chunk_id,
      encoding: "pcm16" as const,
      sampleRateHz: generatedAudioBinding.format.sample_rate_hz,
      channels: 1 as const,
      data: Uint8Array.from(chunks[descriptor.ordinal].data.subarray(
        0,
        Math.min(
          descriptor.byte_length,
          generatedAudioBinding.played_range.byte_end - descriptor.byte_offset
        )
      )),
    }));
  const audioBinding = audiblePrefixChunks.length === 0
    ? generatedAudioBinding
    : bindAudio(audiblePrefixChunks, playedPcm.byteLength);
  if (audioBinding.played_range.played_pcm_sha256 !== generatedAudioBinding.played_range.played_pcm_sha256
    || audioBinding.played_range.played_chunk_sequence_sha256
      !== generatedAudioBinding.played_range.played_chunk_sequence_sha256) {
    throw new Error("independent ASR audible-prefix snapshot differs from generated playback state");
  }
  if (sha256Hex(playedPcm) !== audioBinding.played_range.played_pcm_sha256) {
    throw new Error("independent ASR request PCM differs from its binding");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    run_id: runId,
    unit_id: unitId,
    invocation_id: invocationId,
    adapter_blind_nonce_sha256: adapterBlindNonceSha256,
    asr_contract_sha256: independentAsrContractSha256(contract),
    format: audioBinding.format,
    played_sample_count: audioBinding.played_range.sample_end,
    source_played_audio_sha256: audioBinding.played_range.played_pcm_sha256,
    source_chunk_sequence_sha256: audioBinding.played_range.played_chunk_sequence_sha256,
  });
  const request = Object.freeze({
    [PREPARED_ASR_REQUEST]: true as const,
    ...body,
    request_sha256: domainHash(ASR_REQUEST_DOMAIN, body),
    played_pcm: playedPcm,
    audio_binding: audioBinding,
  });
  preparedAsrRequests.add(request);
  return request;
}

function asrResultSha256(result: IndependentAsrResult): string {
  return domainHash(ASR_RESULT_DOMAIN, result);
}

function invocationReceiptBody(
  receipt: Omit<IndependentAsrInvocationReceipt, "receipt_sha256" | "signature">
    | IndependentAsrInvocationReceipt
) {
  return {
    schema_version: receipt.schema_version,
    receipt_type: receipt.receipt_type,
    invocation_id: receipt.invocation_id,
    run_id: receipt.run_id,
    unit_id: receipt.unit_id,
    asr_contract_sha256: receipt.asr_contract_sha256,
    request_sha256: receipt.request_sha256,
    source_played_audio_sha256: receipt.source_played_audio_sha256,
    source_chunk_sequence_sha256: receipt.source_chunk_sequence_sha256,
    executable_sha256: receipt.executable_sha256,
    model_weights_sha256: receipt.model_weights_sha256,
    normalized_result_sha256: receipt.normalized_result_sha256,
    stdout_sha256: receipt.stdout_sha256,
    stderr_sha256: receipt.stderr_sha256,
    exit_code: receipt.exit_code,
    runtime_ms: receipt.runtime_ms,
    signing_key_id: receipt.signing_key_id,
    signing_public_key_sha256: receipt.signing_public_key_sha256,
  };
}

function bytes(value: string | Uint8Array, label: string): Uint8Array {
  const output = typeof value === "string" ? Buffer.from(value, "utf8") : Uint8Array.from(value);
  if (output.byteLength > 16 * 1024 * 1024) throw new Error(`${label} exceeds the 16 MiB receipt bound`);
  return output;
}

function validateResultForRequest(input: unknown, request: IndependentAsrRequest): IndependentAsrResult {
  const result = validateAsrResult(input, request.audio_binding);
  if (result.status === "completed" && result.source_request_sha256 !== request.request_sha256) {
    throw new Error("ASR result is detached from its canonical request");
  }
  return result;
}

export async function runIndependentAsrAdapter(input: Readonly<{
  request: IndependentAsrRequest;
  contract: IndependentAsrContract;
  runnerSigner: BenchmarkKernelAttestationSigner;
  execute(adapterInput: IndependentAsrAdapterInput): Promise<IndependentAsrAdapterExecution> | IndependentAsrAdapterExecution;
}>): Promise<VerifiedIndependentAsrInvocation> {
  if (!preparedAsrRequests.has(input.request) || input.request[PREPARED_ASR_REQUEST] !== true) {
    throw new Error("independent ASR execution requires a locally prepared canonical request");
  }
  const contract = validateContract(input.contract);
  const contractSha256 = independentAsrContractSha256(contract);
  if (input.request.asr_contract_sha256 !== contractSha256) throw new Error("ASR request contract substitution");
  if (input.runnerSigner.algorithm !== "ed25519") throw new Error("independent ASR runner signer must use Ed25519");
  const runnerKeyId = safeId(input.runnerSigner.keyId, "independent ASR runner signing key ID");
  const runnerFingerprint = sha(input.runnerSigner.publicKeySha256, "independent ASR runner fingerprint");
  if (sha256Hex(input.request.played_pcm) !== input.request.source_played_audio_sha256) {
    throw new Error("independent ASR request PCM changed before execution");
  }
  const adapterPcm = Uint8Array.from(input.request.played_pcm);
  const adapterInput = Object.freeze({
    schema_version: 1 as const,
    adapter_blind_nonce_sha256: input.request.adapter_blind_nonce_sha256,
    asr_contract_sha256: contractSha256,
    source_request_sha256: input.request.request_sha256,
    source_chunk_sequence_sha256: input.request.source_chunk_sequence_sha256,
    format: input.request.format,
    played_sample_count: input.request.played_sample_count,
    played_pcm: adapterPcm,
  });
  const execution = await input.execute(adapterInput);
  if (sha256Hex(input.request.played_pcm) !== input.request.source_played_audio_sha256
    || sha256Hex(adapterPcm) !== input.request.source_played_audio_sha256) {
    throw new Error("independent ASR PCM changed during adapter execution");
  }
  if (execution === null || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("independent ASR adapter execution result is invalid");
  }
  if (execution.exitCode !== 0) throw new Error("independent ASR adapter did not exit successfully");
  const runtimeMs = integer(execution.runtimeMs, "independent ASR runtime", 0, 3_600_000);
  const result = validateResultForRequest(execution.result, input.request);
  const withoutHash = Object.freeze({
    schema_version: 1 as const,
    receipt_type: "independent_asr_invocation" as const,
    invocation_id: input.request.invocation_id,
    run_id: input.request.run_id,
    unit_id: input.request.unit_id,
    asr_contract_sha256: contractSha256,
    request_sha256: input.request.request_sha256,
    source_played_audio_sha256: input.request.source_played_audio_sha256,
    source_chunk_sequence_sha256: input.request.source_chunk_sequence_sha256,
    executable_sha256: contract.engine.executable_sha256,
    model_weights_sha256: contract.engine.weights_sha256,
    normalized_result_sha256: asrResultSha256(result),
    stdout_sha256: sha256Hex(bytes(execution.stdout, "independent ASR stdout")),
    stderr_sha256: sha256Hex(bytes(execution.stderr, "independent ASR stderr")),
    exit_code: 0 as const,
    runtime_ms: runtimeMs,
    signing_key_id: runnerKeyId,
    signing_public_key_sha256: runnerFingerprint,
  });
  const receiptSha256 = domainHash(ASR_INVOCATION_DOMAIN, withoutHash);
  const signatureBase64 = input.runnerSigner.sign(`${ASR_INVOCATION_SIGNATURE_DOMAIN}${receiptSha256}`);
  canonicalSignature(signatureBase64);
  const receipt = immutableJson({
    ...withoutHash,
    receipt_sha256: receiptSha256,
    signature: { algorithm: "ed25519", key_id: runnerKeyId, signature_base64: signatureBase64 },
  }) as unknown as IndependentAsrInvocationReceipt;
  const invocation = Object.freeze({
    [VERIFIED_ASR_INVOCATION]: true as const,
    request: input.request,
    result,
    receipt,
  });
  verifiedAsrInvocations.add(invocation);
  return invocation;
}

function parseAsrInvocationReceipt(input: unknown): IndependentAsrInvocationReceipt {
  exactKeys(input, ASR_INVOCATION_RECEIPT_KEYS, "independent ASR invocation receipt");
  if (input.schema_version !== 1 || input.receipt_type !== "independent_asr_invocation") {
    throw new Error("independent ASR invocation receipt schema/type is unsupported");
  }
  const invocationId = safeId(input.invocation_id, "independent ASR receipt invocation ID");
  const runId = safeId(input.run_id, "independent ASR receipt run ID");
  const unitId = safeId(input.unit_id, "independent ASR receipt unit ID");
  const hashFields = [
    "asr_contract_sha256", "request_sha256", "source_played_audio_sha256",
    "source_chunk_sequence_sha256", "executable_sha256", "model_weights_sha256",
    "normalized_result_sha256", "stdout_sha256", "stderr_sha256", "signing_public_key_sha256",
    "receipt_sha256",
  ] as const;
  const hashes = Object.fromEntries(hashFields.map((field) => [field, sha(input[field], `independent ASR receipt ${field}`)]));
  if (input.exit_code !== 0) throw new Error("independent ASR receipt exit code is not successful");
  const runtimeMs = integer(input.runtime_ms, "independent ASR receipt runtime", 0, 3_600_000);
  const signingKeyId = safeId(input.signing_key_id, "independent ASR receipt signing key ID");
  exactKeys(input.signature, SIGNATURE_KEYS, "independent ASR receipt signature");
  if (input.signature.algorithm !== "ed25519" || input.signature.key_id !== signingKeyId) {
    throw new Error("independent ASR receipt signature identity is invalid");
  }
  const signatureBase64 = canonicalSignature(input.signature.signature_base64);
  const receipt: IndependentAsrInvocationReceipt = Object.freeze({
    schema_version: 1,
    receipt_type: "independent_asr_invocation",
    invocation_id: invocationId,
    run_id: runId,
    unit_id: unitId,
    asr_contract_sha256: hashes.asr_contract_sha256,
    request_sha256: hashes.request_sha256,
    source_played_audio_sha256: hashes.source_played_audio_sha256,
    source_chunk_sequence_sha256: hashes.source_chunk_sequence_sha256,
    executable_sha256: hashes.executable_sha256,
    model_weights_sha256: hashes.model_weights_sha256,
    normalized_result_sha256: hashes.normalized_result_sha256,
    stdout_sha256: hashes.stdout_sha256,
    stderr_sha256: hashes.stderr_sha256,
    exit_code: 0,
    runtime_ms: runtimeMs,
    signing_key_id: signingKeyId,
    signing_public_key_sha256: hashes.signing_public_key_sha256,
    receipt_sha256: hashes.receipt_sha256,
    signature: Object.freeze({ algorithm: "ed25519", key_id: signingKeyId, signature_base64: signatureBase64 }),
  });
  if (domainHash(ASR_INVOCATION_DOMAIN, invocationReceiptBody(receipt)) !== receipt.receipt_sha256) {
    throw new Error("independent ASR invocation receipt hash mismatch");
  }
  return receipt;
}

function snapshotTrust(input: BenchmarkKernelAttestationTrust, label: string) {
  exactDataKeys(input, TRUST_KEYS, label);
  const keyId = safeId(input.keyId, `${label} key ID`);
  const publicKeyPem = nonEmpty(input.publicKeyPem, `${label} public key PEM`, 64 * 1024);
  const publicKeySha256 = sha(input.publicKeySha256, `${label} public key fingerprint`);
  const actualFingerprint = benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem);
  if (actualFingerprint !== publicKeySha256) throw new Error(`${label} public-key fingerprint mismatch`);
  return Object.freeze({ keyId, publicKeyPem, publicKeySha256 });
}

export function verifyIndependentAsrInvocation(input: Readonly<{
  request: IndependentAsrRequest;
  contract: IndependentAsrContract;
  result: unknown;
  receipt: unknown;
  runnerTrust: BenchmarkKernelAttestationTrust;
}>): VerifiedIndependentAsrInvocation {
  if (!preparedAsrRequests.has(input.request) || input.request[PREPARED_ASR_REQUEST] !== true) {
    throw new Error("independent ASR receipt verification requires a locally reconstructed canonical request");
  }
  if (sha256Hex(input.request.played_pcm) !== input.request.source_played_audio_sha256) {
    throw new Error("independent ASR request PCM changed before receipt verification");
  }
  const contract = validateContract(input.contract);
  const contractSha256 = independentAsrContractSha256(contract);
  const result = validateResultForRequest(input.result, input.request);
  const receipt = parseAsrInvocationReceipt(input.receipt);
  const trust = snapshotTrust(input.runnerTrust, "independent ASR runner trust");
  const expected = {
    invocation_id: input.request.invocation_id,
    run_id: input.request.run_id,
    unit_id: input.request.unit_id,
    asr_contract_sha256: contractSha256,
    request_sha256: input.request.request_sha256,
    source_played_audio_sha256: input.request.source_played_audio_sha256,
    source_chunk_sequence_sha256: input.request.source_chunk_sequence_sha256,
    executable_sha256: contract.engine.executable_sha256,
    model_weights_sha256: contract.engine.weights_sha256,
    normalized_result_sha256: asrResultSha256(result),
    signing_key_id: trust.keyId,
    signing_public_key_sha256: trust.publicKeySha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key as keyof IndependentAsrInvocationReceipt] !== value) {
      throw new Error(`independent ASR invocation receipt ${key} substitution`);
    }
  }
  const publicKey = createPublicKey(trust.publicKeyPem);
  if (!verifySignature(
    null,
    Buffer.from(`${ASR_INVOCATION_SIGNATURE_DOMAIN}${receipt.receipt_sha256}`, "utf8"),
    publicKey,
    Buffer.from(receipt.signature.signature_base64, "base64")
  )) throw new Error("independent ASR invocation receipt signature verification failed");
  const invocation = Object.freeze({
    [VERIFIED_ASR_INVOCATION]: true as const,
    request: input.request,
    result,
    receipt,
  });
  verifiedAsrInvocations.add(invocation);
  return invocation;
}

function validateAsrResult(input: unknown, audio: AudiblePcmBinding): IndependentAsrResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("ASR result must be an object");
  const status = Reflect.get(input, "status");
  if (status === "unavailable") {
    exactKeys(input, ASR_UNAVAILABLE_KEYS, "unavailable ASR result");
    return Object.freeze({
      status: "unavailable",
      reason_code: safeId(input.reason_code, "ASR unavailable reason code"),
      reason: nonEmpty(input.reason, "ASR unavailable reason", 2_048),
    });
  }
  exactKeys(input, ASR_COMPLETED_KEYS, "completed ASR result");
  if (input.status !== "completed") throw new Error("ASR result status is invalid");
  const sourcePlayedAudioSha256 = sha(input.source_played_audio_sha256, "ASR source audio hash");
  const sourceChunkSequenceSha256 = sha(input.source_chunk_sequence_sha256, "ASR source chunk-sequence hash");
  const sourceRequestSha256 = sha(input.source_request_sha256, "ASR source request hash");
  if (sourcePlayedAudioSha256 !== audio.played_range.played_pcm_sha256
    || sourceChunkSequenceSha256
      !== audio.played_range.played_chunk_sequence_sha256) {
    throw new Error("ASR result is detached from the exact played PCM prefix");
  }
  if (typeof input.language !== "string" || !SAFE_LANGUAGE.test(input.language)) throw new Error("ASR result language is invalid");
  const language = input.language;
  if (typeof input.transcript !== "string" || Buffer.byteLength(input.transcript, "utf8") > MAX_TRANSCRIPT_BYTES
    || input.transcript.includes("\0")) throw new Error("ASR transcript is invalid or oversized");
  const transcript = input.transcript;
  const playedSamples = audio.played_range.sample_end;
  const processedThroughSample = integer(input.processed_through_sample, "ASR processed sample", 0, playedSamples);
  const noSpeechProbabilityPpm = input.no_speech_probability_ppm === null
    ? null
    : ppm(input.no_speech_probability_ppm, "ASR no-speech probability");
  if (!Array.isArray(input.spans) || input.spans.length > MAX_SPANS) throw new Error("ASR timed spans are invalid");
  const transcriptBytes = Buffer.from(transcript, "utf8");
  if ((transcriptBytes.byteLength === 0) !== (input.spans.length === 0)) {
    throw new Error("ASR timed spans must cover exactly one non-empty transcript or be empty with it");
  }
  let priorUtf8End = 0;
  let priorAudioEnd = 0;
  const spanIds = new Set<string>();
  const spans: TimedUtf8Span[] = [];
  for (const [index, span] of input.spans.entries()) {
    exactKeys(span, SPAN_KEYS, `ASR span ${index}`);
    const spanId = safeId(span.span_id, `ASR span ${index} ID`);
    if (spanIds.has(spanId)) throw new Error("ASR timed spans contain duplicate IDs");
    spanIds.add(spanId);
    const utf8Start = integer(span.utf8_start, `ASR span ${index} UTF-8 start`, 0, transcriptBytes.byteLength);
    const utf8End = integer(span.utf8_end, `ASR span ${index} UTF-8 end`, utf8Start + 1, transcriptBytes.byteLength);
    if (utf8Start !== priorUtf8End) throw new Error("ASR timed UTF-8 spans contain a gap or overlap");
    const prefix = transcriptBytes.subarray(0, utf8Start).toString("utf8");
    const through = transcriptBytes.subarray(0, utf8End).toString("utf8");
    if (Buffer.byteLength(prefix, "utf8") !== utf8Start || Buffer.byteLength(through, "utf8") !== utf8End) {
      throw new Error("ASR timed span splits a UTF-8 code point");
    }
    if (typeof span.text !== "string" || span.text !== transcriptBytes.subarray(utf8Start, utf8End).toString("utf8")) {
      throw new Error("ASR timed span text differs from its exact transcript bytes");
    }
    const text = span.text;
    const audioStart = integer(span.audio_start_sample, `ASR span ${index} audio start`, priorAudioEnd, processedThroughSample);
    const audioEnd = integer(span.audio_end_sample, `ASR span ${index} audio end`, audioStart + 1, processedThroughSample);
    const confidencePpm = span.confidence_ppm === null
      ? null
      : ppm(span.confidence_ppm, `ASR span ${index} confidence`);
    spans.push(Object.freeze({
      span_id: spanId,
      text,
      utf8_start: utf8Start,
      utf8_end: utf8End,
      audio_start_sample: audioStart,
      audio_end_sample: audioEnd,
      confidence_ppm: confidencePpm,
    }));
    priorUtf8End = utf8End;
    priorAudioEnd = audioEnd;
  }
  if (priorUtf8End !== transcriptBytes.byteLength) throw new Error("ASR timed UTF-8 spans do not cover the full transcript");
  return Object.freeze({
    status: "completed",
    source_request_sha256: sourceRequestSha256,
    source_played_audio_sha256: sourcePlayedAudioSha256,
    source_chunk_sequence_sha256: sourceChunkSequenceSha256,
    language,
    transcript,
    processed_through_sample: processedThroughSample,
    no_speech_probability_ppm: noSpeechProbabilityPpm,
    spans: Object.freeze(spans),
  });
}

function ratioPpm(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.min(PPM, Math.floor(numerator * PPM / denominator));
}

function unitBody(record: Omit<AudibleSemanticUnitRecord, "record_sha256"> | AudibleSemanticUnitRecord) {
  return {
    schema_version: record.schema_version,
    run_id: record.run_id,
    unit_id: record.unit_id,
    response_id: record.response_id,
    blind_observation_sha256: record.blind_observation_sha256,
    turn: record.turn,
    audio_artifact_path: record.audio_artifact_path,
    audio: record.audio,
    asr_request_sha256: record.asr_request_sha256,
    asr_contract_sha256: record.asr_contract_sha256,
    calibration_evidence_sha256: record.calibration_evidence_sha256,
    asr_invocation_receipt: record.asr_invocation_receipt,
    asr_result: record.asr_result,
    asr_transcript_sha256: record.asr_transcript_sha256,
    asr_transcript_utf8_byte_length: record.asr_transcript_utf8_byte_length,
    metrics: record.metrics,
    status: record.status,
    unverifiable_reasons: record.unverifiable_reasons,
  };
}

function listenerFor(record: AudibleSemanticUnitRecord): ConditionBlindListenerObservation {
  const common = {
    schema_version: 1 as const,
    source: "independent_played_pcm_asr" as const,
    observation_id: record.blind_observation_sha256,
    played_pcm_sha256: record.audio.played_range.played_pcm_sha256,
    played_through_sample: record.audio.played_range.sample_end,
  };
  const body = record.status === "verified" && record.asr_result.status === "completed"
    ? {
        ...common,
        status: "verified" as const,
        transcript: record.asr_result.transcript,
        transcript_sha256: record.asr_transcript_sha256!,
        timed_spans: record.asr_result.spans,
      }
    : {
        ...common,
        status: "unverifiable" as const,
        reasons: Object.freeze([
          ...(record.unverifiable_reasons.some((reason) => reason.startsWith("calibration_"))
            ? ["calibration_unvalidated" as const]
            : []),
          ...(record.unverifiable_reasons.some((reason) => reason.startsWith("asr_unavailable"))
            ? ["asr_unavailable" as const]
            : []),
          ...(record.unverifiable_reasons.some((reason) => !reason.startsWith("calibration_") && !reason.startsWith("asr_unavailable"))
            ? ["audio_or_alignment_insufficient" as const]
            : []),
        ]),
      };
  return immutableJson({
    ...body,
    evidence_sha256: domainHash(LISTENER_EVIDENCE_DOMAIN, body),
  }) as unknown as ConditionBlindListenerObservation;
}

export function prepareAudibleSemanticUnit(input: Readonly<{
  runId: string;
  unitId: string;
  responseId: string;
  blindObservationId: string;
  turn: number;
  audioArtifactPath: string;
  asrInvocation: VerifiedIndependentAsrInvocation;
  contract: IndependentAsrContract;
  calibration: PreparedIndependentAsrCalibration;
}>): PreparedAudibleSemanticUnit {
  const runId = safeId(input.runId, "audible semantic run ID");
  const unitId = safeId(input.unitId, "audible semantic unit ID");
  const responseId = safeId(input.responseId, "audible semantic response ID");
  const blindObservationId = sha(input.blindObservationId, "blind audible observation nonce hash");
  integer(input.turn, "audible semantic turn", 1);
  if (typeof input.audioArtifactPath !== "string" || !SAFE_PATH.test(input.audioArtifactPath)) {
    throw new Error("audio artifact path must be a safe relative path");
  }
  const contract = validateContract(input.contract);
  if (!preparedCalibrations.has(input.calibration) || input.calibration[PREPARED_CALIBRATION] !== true) {
    throw new Error("audible semantic unit requires raw-fixture-recomputed ASR calibration");
  }
  const calibration = validateCalibration(input.calibration.summary);
  const contractSha256 = independentAsrContractSha256(contract);
  if (calibration.asr_contract_sha256 !== contractSha256) {
    throw new Error("audible semantic unit calibration is detached from its ASR contract/model/weights");
  }
  if (!verifiedAsrInvocations.has(input.asrInvocation)
    || input.asrInvocation[VERIFIED_ASR_INVOCATION] !== true) {
    throw new Error("audible semantic unit requires a verified independent ASR runner invocation");
  }
  const invocation = verifyIndependentAsrInvocation({
    request: input.asrInvocation.request,
    contract,
    result: input.asrInvocation.result,
    receipt: input.asrInvocation.receipt,
    runnerTrust: input.calibration.runnerTrust,
  });
  if (sha256Hex(invocation.request.played_pcm) !== invocation.request.source_played_audio_sha256) {
    throw new Error("audible semantic unit ASR request PCM changed after runner execution");
  }
  if (invocation.request.run_id !== runId || invocation.request.unit_id !== unitId
    || invocation.receipt.run_id !== runId || invocation.receipt.unit_id !== unitId) {
    throw new Error("audible semantic unit run/unit differs from its runner invocation");
  }
  if (invocation.request.asr_contract_sha256 !== contractSha256
    || invocation.receipt.asr_contract_sha256 !== contractSha256) {
    throw new Error("audible semantic unit runner contract/model/weights substitution");
  }
  const audio = invocation.request.audio_binding;
  const asrResult = invocation.result;
  const reasons: string[] = [];
  let transcriptHash: string | null = null;
  let transcriptBytes: number | null = null;
  let metrics: AudibleUnitMetrics = Object.freeze({
    processed_audio_coverage_ppm: 0,
    timed_text_coverage_ppm: 0,
    confidence_coverage_ppm: 0,
    mean_confidence_ppm: null,
    no_speech_probability_ppm: null,
  });
  if (calibration.status !== "calibrated") reasons.push("calibration_not_validated");
  if (audio.played_range.sample_end === 0) reasons.push("no_played_audio");
  if (asrResult.status === "unavailable") {
    reasons.push(`asr_unavailable:${asrResult.reason_code}`);
  } else {
    if (asrResult.language !== contract.decoding.language) reasons.push("language_mismatch");
    const utf8Bytes = Buffer.byteLength(asrResult.transcript, "utf8");
    transcriptHash = sha256Hex(Buffer.from(asrResult.transcript, "utf8"));
    transcriptBytes = utf8Bytes;
    if (utf8Bytes === 0) reasons.push("empty_transcript");
    if (utf8Bytes > 0 && invocation.request.played_pcm.every((byte) => byte === 0)) {
      reasons.push("digital_silence_with_transcript");
    }
    const processedCoverage = ratioPpm(asrResult.processed_through_sample, audio.played_range.sample_end);
    const confidenceBytes = asrResult.spans.reduce((sum, span) =>
      sum + (span.confidence_ppm === null ? 0 : span.utf8_end - span.utf8_start), 0);
    const confidenceCoverage = ratioPpm(confidenceBytes, utf8Bytes);
    const weightedConfidenceNumerator = asrResult.spans.reduce((sum, span) =>
      sum + (span.confidence_ppm ?? 0) * (span.utf8_end - span.utf8_start), 0);
    const meanConfidence = confidenceBytes === 0 ? null : Math.floor(weightedConfidenceNumerator / confidenceBytes);
    metrics = Object.freeze({
      processed_audio_coverage_ppm: processedCoverage,
      timed_text_coverage_ppm: utf8Bytes === 0 ? 0 : PPM,
      confidence_coverage_ppm: confidenceCoverage,
      mean_confidence_ppm: meanConfidence,
      no_speech_probability_ppm: asrResult.no_speech_probability_ppm,
    });
    if (processedCoverage < UNIT_MIN_PROCESSED_AUDIO_COVERAGE_PPM) reasons.push("processed_audio_coverage_below_threshold");
    // Confidence and no-speech probabilities are optional in the normalized
    // result schema because pinned open-weight engines such as whisper.cpp do
    // not expose them through every deterministic output format. A passing,
    // route-bound calibration is the admissibility gate when they are absent;
    // when present, the stricter per-unit thresholds still apply.
    if (meanConfidence !== null && confidenceCoverage < UNIT_MIN_CONFIDENCE_COVERAGE_PPM) {
      reasons.push("confidence_coverage_below_threshold");
    }
    if (meanConfidence !== null && meanConfidence < UNIT_MIN_MEAN_CONFIDENCE_PPM) {
      reasons.push("mean_confidence_below_threshold");
    }
    if (asrResult.no_speech_probability_ppm !== null
      && asrResult.no_speech_probability_ppm > UNIT_MAX_NO_SPEECH_PROBABILITY_PPM) {
      reasons.push("no_speech_probability_above_threshold");
    }
  }
  const withoutHash = Object.freeze({
    schema_version: 1 as const,
    run_id: runId,
    unit_id: unitId,
    response_id: responseId,
    blind_observation_sha256: domainHash(BLIND_OBSERVATION_DOMAIN, { run_id: runId, blind_observation_id: blindObservationId }),
    turn: input.turn,
    audio_artifact_path: input.audioArtifactPath,
    audio,
    asr_request_sha256: invocation.request.request_sha256,
    asr_contract_sha256: contractSha256,
    calibration_evidence_sha256: calibration.fixture_evidence_sha256,
    asr_invocation_receipt: invocation.receipt,
    asr_result: asrResult,
    asr_transcript_sha256: transcriptHash,
    asr_transcript_utf8_byte_length: transcriptBytes,
    metrics,
    status: reasons.length === 0 ? "verified" as const : "unverifiable" as const,
    unverifiable_reasons: Object.freeze([...new Set(reasons)].sort(asciiCompare)),
  });
  const record = immutableJson({
    ...withoutHash,
    record_sha256: domainHash(UNIT_DOMAIN, withoutHash),
  }) as unknown as AudibleSemanticUnitRecord;
  const prepared = Object.freeze({
    [PREPARED_UNIT]: true as const,
    record,
    listener: listenerFor(record),
  });
  preparedUnits.add(prepared);
  return prepared;
}

export function conditionBlindListenerObservation(
  prepared: PreparedAudibleSemanticUnit
): ConditionBlindListenerObservation {
  if (!preparedUnits.has(prepared) || prepared[PREPARED_UNIT] !== true) {
    throw new Error("listener projection requires a locally prepared played-PCM ASR observation");
  }
  return prepared.listener;
}

function unitInventoryHash(units: readonly AudibleSemanticUnitRecord[]): string {
  return domainHash(UNIT_INVENTORY_DOMAIN, units.map((unit) => ({
    unit_id: unit.unit_id,
    record_sha256: unit.record_sha256,
    played_pcm_sha256: unit.audio.played_range.played_pcm_sha256,
    played_chunk_sequence_sha256: unit.audio.played_range.played_chunk_sequence_sha256,
  })));
}

function unsignedArtifact(input: Omit<AudibleSemanticEvidenceArtifact, "artifact_hash" | "signature"> | AudibleSemanticEvidenceArtifact) {
  return {
    schema_version: input.schema_version,
    artifact_type: input.artifact_type,
    bindings: input.bindings,
    asr_contract: input.asr_contract,
    calibration: input.calibration,
    units: input.units,
  };
}

export function audibleSemanticEvidenceArtifactHash(
  input: Omit<AudibleSemanticEvidenceArtifact, "artifact_hash" | "signature"> | AudibleSemanticEvidenceArtifact
): string {
  return domainHash(ARTIFACT_DOMAIN, unsignedArtifact(input));
}

export function createAudibleSemanticEvidenceArtifact(input: Readonly<{
  runId: string;
  timelineSha256: string;
  transcriptSetSha256: string;
  contract: IndependentAsrContract;
  calibration: PreparedIndependentAsrCalibration;
  units: readonly PreparedAudibleSemanticUnit[];
  signer: BenchmarkKernelAttestationSigner;
}>): AudibleSemanticEvidenceArtifact {
  safeId(input.runId, "audible evidence run ID");
  sha(input.timelineSha256, "audible evidence timeline hash");
  sha(input.transcriptSetSha256, "audible evidence transcript-set hash");
  const contract = validateContract(input.contract);
  if (!preparedCalibrations.has(input.calibration) || input.calibration[PREPARED_CALIBRATION] !== true) {
    throw new Error("audible evidence artifact requires raw-fixture-recomputed ASR calibration");
  }
  const calibration = validateCalibration(input.calibration.summary);
  if (calibration.asr_contract_sha256 !== independentAsrContractSha256(contract)) {
    throw new Error("audible evidence artifact calibration contract/model/weights substitution");
  }
  if (!Array.isArray(input.units) || input.units.length < 1 || input.units.length > 100_000) {
    throw new Error("audible evidence requires a bounded non-empty unit set");
  }
  for (const unit of input.units) {
    if (!preparedUnits.has(unit) || unit[PREPARED_UNIT] !== true) throw new Error("audible evidence received an unprepared unit");
  }
  const units = [...input.units].map((unit) => unit.record).sort((left, right) => asciiCompare(left.unit_id, right.unit_id));
  if (new Set(units.map((unit) => unit.unit_id)).size !== units.length) throw new Error("audible evidence repeats a unit ID");
  if (new Set(units.map((unit) => unit.blind_observation_sha256)).size !== units.length) {
    throw new Error("audible evidence repeats a blind observation identity");
  }
  if (units.some((unit) => unit.run_id !== input.runId
    || unit.asr_contract_sha256 !== calibration.asr_contract_sha256
    || unit.calibration_evidence_sha256 !== calibration.fixture_evidence_sha256)) {
    throw new Error("audible evidence unit run/contract/calibration substitution");
  }
  if (input.signer.algorithm !== "ed25519") throw new Error("audible evidence signer must use Ed25519");
  safeId(input.signer.keyId, "audible evidence signing key ID");
  sha(input.signer.publicKeySha256, "audible evidence signing public-key fingerprint");
  if (units.some((unit) => unit.asr_invocation_receipt.signing_public_key_sha256 === input.signer.publicKeySha256)) {
    throw new Error("audible evidence artifact signer must be distinct from the independent ASR runner signer");
  }
  const withoutHash = Object.freeze({
    schema_version: 1 as const,
    artifact_type: "benchmark_independent_audible_semantics" as const,
    bindings: Object.freeze({
      run_id: input.runId,
      timeline_sha256: input.timelineSha256,
      transcript_set_sha256: input.transcriptSetSha256,
      asr_contract_sha256: independentAsrContractSha256(contract),
      calibration_sha256: independentAsrCalibrationSha256(calibration),
      unit_inventory_sha256: unitInventoryHash(units),
      signing_key_id: input.signer.keyId,
      signing_public_key_sha256: input.signer.publicKeySha256,
    }),
    asr_contract: contract,
    calibration,
    units: Object.freeze(units),
  });
  const artifactHash = audibleSemanticEvidenceArtifactHash(withoutHash);
  const signatureBase64 = input.signer.sign(`${SIGNATURE_DOMAIN}${artifactHash}`);
  canonicalSignature(signatureBase64);
  return immutableJson({
    ...withoutHash,
    artifact_hash: artifactHash,
    signature: { algorithm: "ed25519", key_id: input.signer.keyId, signature_base64: signatureBase64 },
  }) as unknown as AudibleSemanticEvidenceArtifact;
}

function parseStoredAudio(input: unknown): AudiblePcmBinding {
  exactKeys(input, AUDIO_KEYS, "audible unit audio binding");
  exactKeys(input.format, FORMAT_KEYS, "audible unit audio format");
  if (input.format.encoding !== "pcm16" || input.format.endianness !== "little" || input.format.channels !== 1) {
    throw new Error("stored audible PCM format is invalid");
  }
  integer(input.format.sample_rate_hz, "stored audible PCM sample rate", 8_000, 192_000);
  if (!Array.isArray(input.chunks) || input.chunks.length < 1 || input.chunks.length > MAX_CHUNKS) throw new Error("stored PCM chunks are invalid");
  for (const [index, chunk] of input.chunks.entries()) {
    exactKeys(chunk, CHUNK_KEYS, `stored PCM chunk ${index}`);
    integer(chunk.ordinal, `stored PCM chunk ${index} ordinal`, 0);
    safeId(chunk.chunk_id, `stored PCM chunk ${index} ID`);
    integer(chunk.byte_offset, `stored PCM chunk ${index} byte offset`, 0);
    integer(chunk.byte_length, `stored PCM chunk ${index} byte length`, 2);
    integer(chunk.sample_offset, `stored PCM chunk ${index} sample offset`, 0);
    integer(chunk.sample_count, `stored PCM chunk ${index} sample count`, 1);
    sha(chunk.sha256, `stored PCM chunk ${index} hash`);
  }
  integer(input.generated_byte_length, "stored generated PCM byte length", 2, MAX_AUDIO_BYTES);
  integer(input.generated_sample_count, "stored generated PCM sample count", 1);
  sha(input.generated_pcm_sha256, "stored generated PCM hash");
  sha(input.generated_chunk_sequence_sha256, "stored generated chunk-sequence hash");
  exactKeys(input.played_range, PLAYED_RANGE_KEYS, "stored played PCM range");
  const played = input.played_range;
  if (played.kind !== "contiguous_prefix" || played.byte_start !== 0 || played.sample_start !== 0) {
    throw new Error("stored played range must be one contiguous prefix");
  }
  integer(played.byte_end, "stored played byte end", 0, input.generated_byte_length as number);
  integer(played.sample_end, "stored played sample end", 0, input.generated_sample_count as number);
  sha(played.played_pcm_sha256, "stored played PCM hash");
  sha(played.played_chunk_sequence_sha256, "stored played chunk-sequence hash");
  if (played.terminal_chunk !== null) {
    exactKeys(played.terminal_chunk, TERMINAL_CHUNK_KEYS, "stored terminal PCM chunk cursor");
    integer(played.terminal_chunk.ordinal, "stored terminal chunk ordinal", 0);
    integer(played.terminal_chunk.byte_end_in_chunk, "stored terminal chunk byte end", 2);
    integer(played.terminal_chunk.sample_end_in_chunk, "stored terminal chunk sample end", 1);
  }
  return immutableJson(input) as unknown as AudiblePcmBinding;
}

function parseStoredMetrics(input: unknown): AudibleUnitMetrics {
  exactKeys(input, METRIC_KEYS, "audible unit metrics");
  ppm(input.processed_audio_coverage_ppm, "processed audio coverage");
  ppm(input.timed_text_coverage_ppm, "timed text coverage");
  ppm(input.confidence_coverage_ppm, "confidence coverage");
  if (input.mean_confidence_ppm !== null) ppm(input.mean_confidence_ppm, "mean confidence");
  if (input.no_speech_probability_ppm !== null) ppm(input.no_speech_probability_ppm, "no-speech probability");
  return immutableJson(input) as unknown as AudibleUnitMetrics;
}

function parseStoredUnit(input: unknown): AudibleSemanticUnitRecord {
  exactKeys(input, UNIT_KEYS, "audible semantic unit");
  if (input.schema_version !== 1) throw new Error("audible semantic unit schema is unsupported");
  safeId(input.run_id, "audible semantic run ID");
  safeId(input.unit_id, "audible semantic unit ID");
  safeId(input.response_id, "audible semantic response ID");
  sha(input.blind_observation_sha256, "blind audible observation hash");
  integer(input.turn, "audible semantic turn", 1);
  if (typeof input.audio_artifact_path !== "string" || !SAFE_PATH.test(input.audio_artifact_path)) throw new Error("stored audio artifact path is invalid");
  const audio = parseStoredAudio(input.audio);
  const requestSha256 = sha(input.asr_request_sha256, "stored ASR request hash");
  const contractSha256 = sha(input.asr_contract_sha256, "stored ASR contract hash");
  const calibrationEvidenceSha256 = sha(input.calibration_evidence_sha256, "stored ASR calibration evidence hash");
  const receipt = parseAsrInvocationReceipt(input.asr_invocation_receipt);
  const asrResult = validateAsrResult(input.asr_result, audio);
  if (receipt.run_id !== input.run_id || receipt.unit_id !== input.unit_id
    || receipt.request_sha256 !== requestSha256 || receipt.asr_contract_sha256 !== contractSha256
    || receipt.source_played_audio_sha256 !== audio.played_range.played_pcm_sha256
    || receipt.source_chunk_sequence_sha256 !== audio.played_range.played_chunk_sequence_sha256
    || receipt.normalized_result_sha256 !== asrResultSha256(asrResult)
    || (asrResult.status === "completed" && asrResult.source_request_sha256 !== requestSha256)) {
    throw new Error("stored ASR invocation receipt is detached from its unit/request/result");
  }
  if (input.asr_transcript_sha256 !== null) sha(input.asr_transcript_sha256, "stored ASR transcript hash");
  if (input.asr_transcript_utf8_byte_length !== null) integer(input.asr_transcript_utf8_byte_length, "stored ASR transcript byte length", 0);
  const metrics = parseStoredMetrics(input.metrics);
  if (input.status !== "verified" && input.status !== "unverifiable") throw new Error("audible semantic unit status is invalid");
  if (!Array.isArray(input.unverifiable_reasons) || input.unverifiable_reasons.some((reason) => typeof reason !== "string" || !reason)) {
    throw new Error("audible semantic unverifiable reasons are invalid");
  }
  sha(input.record_sha256, "audible semantic record hash");
  const parsed = immutableJson({
    ...input,
    asr_request_sha256: requestSha256,
    asr_contract_sha256: contractSha256,
    calibration_evidence_sha256: calibrationEvidenceSha256,
    audio,
    asr_invocation_receipt: receipt,
    asr_result: asrResult,
    metrics,
  }) as unknown as AudibleSemanticUnitRecord;
  if (domainHash(UNIT_DOMAIN, unitBody(parsed)) !== parsed.record_sha256) throw new Error("audible semantic record hash mismatch");
  return parsed;
}

function parseArtifact(input: unknown): AudibleSemanticEvidenceArtifact {
  exactKeys(input, ARTIFACT_KEYS, "audible semantic evidence artifact");
  if (input.schema_version !== 1 || input.artifact_type !== "benchmark_independent_audible_semantics") {
    throw new Error("audible semantic evidence artifact schema/type is unsupported");
  }
  exactKeys(input.bindings, BINDING_KEYS, "audible semantic evidence bindings");
  safeId(input.bindings.run_id, "audible evidence run ID");
  for (const key of [
    "timeline_sha256", "transcript_set_sha256", "asr_contract_sha256", "calibration_sha256",
    "unit_inventory_sha256", "signing_public_key_sha256",
  ] as const) sha(input.bindings[key], `audible evidence binding ${key}`);
  safeId(input.bindings.signing_key_id, "audible evidence signing key ID");
  const contract = validateContract(input.asr_contract);
  const calibration = validateCalibration(input.calibration);
  if (!Array.isArray(input.units) || input.units.length < 1 || input.units.length > 100_000) throw new Error("audible semantic units are invalid");
  const units = input.units.map(parseStoredUnit);
  if (new Set(units.map((unit) => unit.unit_id)).size !== units.length) throw new Error("audible semantic artifact repeats a unit ID");
  if (new Set(units.map((unit) => unit.blind_observation_sha256)).size !== units.length) {
    throw new Error("audible semantic artifact repeats a blind observation identity");
  }
  if ([...units].sort((left, right) => asciiCompare(left.unit_id, right.unit_id))
    .some((unit, index) => unit.unit_id !== units[index].unit_id)) throw new Error("audible semantic units are not canonically ordered");
  sha(input.artifact_hash, "audible semantic artifact hash");
  exactKeys(input.signature, SIGNATURE_KEYS, "audible semantic signature");
  if (input.signature.algorithm !== "ed25519") throw new Error("audible semantic signature algorithm is invalid");
  safeId(input.signature.key_id, "audible semantic signature key ID");
  canonicalSignature(input.signature.signature_base64);
  if (input.signature.key_id !== input.bindings.signing_key_id) throw new Error("audible semantic signature key differs from its binding");
  return immutableJson({ ...input, asr_contract: contract, calibration, units }) as unknown as AudibleSemanticEvidenceArtifact;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function verifyAudibleSemanticEvidence(input: Readonly<{
  artifact: unknown;
  expected: Readonly<{
    runId: string;
    timelineSha256: string;
    transcriptSetSha256: string;
    contract: IndependentAsrContract;
    calibrationEvidence: Readonly<{
      plan: IndependentAsrCalibrationPlan;
      fixtures: readonly AsrCalibrationSourceFixture[];
    }>;
    unitIds: readonly string[];
    trust: BenchmarkKernelAttestationTrust;
    runnerTrust: BenchmarkKernelAttestationTrust;
  }>;
  pcm: readonly Readonly<{
    unitId: string;
    responseId: string;
    blindObservationId: string;
    invocationId: string;
    adapterBlindNonceSha256: string;
    turn: number;
    audioArtifactPath: string;
    chunks: readonly AudiblePcmChunk[];
    playedThroughByte: number;
  }>[];
}>): AudibleEvidenceVerification {
  const errors: string[] = [];
  try {
    const artifact = parseArtifact(input.artifact);
    const runId = safeId(input.expected.runId, "expected audible evidence run ID");
    const timelineSha256 = sha(input.expected.timelineSha256, "expected timeline hash");
    const transcriptSetSha256 = sha(input.expected.transcriptSetSha256, "expected transcript-set hash");
    const contract = validateContract(input.expected.contract);
    const runnerTrust = snapshotTrust(input.expected.runnerTrust, "independent ASR runner trust");
    const preparedCalibration = prepareIndependentAsrCalibration({
      plan: input.expected.calibrationEvidence.plan,
      contract,
      fixtures: input.expected.calibrationEvidence.fixtures,
      runnerTrust,
    });
    const calibration = preparedCalibration.summary;
    const expectedUnitIds = [...input.expected.unitIds];
    for (const id of expectedUnitIds) safeId(id, "expected audible unit ID");
    expectedUnitIds.sort(asciiCompare);
    if (new Set(expectedUnitIds).size !== expectedUnitIds.length) throw new Error("expected audible unit IDs contain duplicates");
    const artifactTrust = snapshotTrust(input.expected.trust, "audible evidence artifact trust");
    if (artifactTrust.keyId === runnerTrust.keyId || artifactTrust.publicKeySha256 === runnerTrust.publicKeySha256) {
      throw new Error("audible artifact and independent ASR runner trust must be distinct");
    }
    if (artifactTrust.keyId !== artifact.bindings.signing_key_id
      || artifact.bindings.signing_public_key_sha256 !== artifactTrust.publicKeySha256) {
      throw new Error("audible semantic signing identity differs from independent trust");
    }
    const expectedBindings = {
      run_id: runId,
      timeline_sha256: timelineSha256,
      transcript_set_sha256: transcriptSetSha256,
      asr_contract_sha256: independentAsrContractSha256(contract),
      calibration_sha256: independentAsrCalibrationSha256(calibration),
      unit_inventory_sha256: unitInventoryHash(artifact.units),
      signing_key_id: artifactTrust.keyId,
      signing_public_key_sha256: artifactTrust.publicKeySha256,
    };
    if (!sameJson(artifact.bindings, expectedBindings)) throw new Error("audible evidence bindings differ from expected run/model/calibration/trust");
    if (!sameJson(artifact.asr_contract, contract)) throw new Error("audible evidence ASR contract substitution");
    if (!sameJson(artifact.calibration, calibration)) throw new Error("audible evidence calibration substitution");
    if (!sameJson(artifact.units.map((unit) => unit.unit_id), expectedUnitIds)) throw new Error("audible evidence unit inventory is incomplete or substituted");
    if (!Array.isArray(input.pcm) || input.pcm.length !== expectedUnitIds.length) throw new Error("persisted PCM inventory does not cover every audible unit");
    const pcmById = new Map(input.pcm.map((pcm) => [pcm.unitId, pcm]));
    if (pcmById.size !== input.pcm.length) throw new Error("persisted PCM inventory repeats a unit ID");
    const blindObservationHashes = input.pcm.map((pcm) => domainHash(BLIND_OBSERVATION_DOMAIN, {
      run_id: runId,
      blind_observation_id: sha(pcm.blindObservationId, "persisted blind observation nonce hash"),
    }));
    if (new Set(blindObservationHashes).size !== blindObservationHashes.length) {
      throw new Error("persisted PCM inventory repeats a blind observation identity");
    }
    for (const unit of artifact.units) {
      const pcm = pcmById.get(unit.unit_id);
      if (!pcm) throw new Error(`persisted PCM is missing for ${unit.unit_id}`);
      if (unit.run_id !== runId) throw new Error(`audible semantic unit ${unit.unit_id} run substitution`);
      const request = createIndependentAsrRequest({
        runId,
        unitId: pcm.unitId,
        invocationId: pcm.invocationId,
        adapterBlindNonceSha256: pcm.adapterBlindNonceSha256,
        contract,
        chunks: pcm.chunks,
        playedThroughByte: pcm.playedThroughByte,
      });
      const invocation = verifyIndependentAsrInvocation({
        request,
        contract,
        result: unit.asr_result,
        receipt: unit.asr_invocation_receipt,
        runnerTrust,
      });
      const recomputed = prepareAudibleSemanticUnit({
        runId,
        unitId: pcm.unitId,
        responseId: pcm.responseId,
        blindObservationId: pcm.blindObservationId,
        turn: pcm.turn,
        audioArtifactPath: pcm.audioArtifactPath,
        asrInvocation: invocation,
        contract,
        calibration: preparedCalibration,
      }).record;
      if (!sameJson(recomputed, unit)) throw new Error(`audible semantic unit ${unit.unit_id} differs from persisted PCM or recomputed thresholds`);
    }
    const expectedArtifactHash = audibleSemanticEvidenceArtifactHash(artifact);
    if (artifact.artifact_hash !== expectedArtifactHash) throw new Error("audible semantic artifact hash mismatch");
    const publicKey = createPublicKey(artifactTrust.publicKeyPem);
    if (!verifySignature(
      null,
      Buffer.from(`${SIGNATURE_DOMAIN}${expectedArtifactHash}`, "utf8"),
      publicKey,
      Buffer.from(artifact.signature.signature_base64, "base64")
    )) throw new Error("audible semantic signature verification failed");
    const evidence = Object.freeze({
      [VERIFIED_EVIDENCE]: true as const,
      schema_version: 1 as const,
      artifact_hash: expectedArtifactHash,
      signature_verified: true as const,
      run_id: artifact.bindings.run_id,
      timeline_sha256: artifact.bindings.timeline_sha256,
      transcript_set_sha256: artifact.bindings.transcript_set_sha256,
      asr_contract_sha256: artifact.bindings.asr_contract_sha256,
      calibration_sha256: artifact.bindings.calibration_sha256,
      signing_key_id: artifact.bindings.signing_key_id,
      signing_public_key_sha256: artifact.bindings.signing_public_key_sha256,
      status: artifact.units.every((unit) => unit.status === "verified") ? "verified" as const : "unverifiable" as const,
      claim_eligible: false as const,
      claim_ineligible_reasons: Object.freeze([
        "caller_playout_receipt_not_verified",
        "runner_execution_is_provenance_only",
        "real_independent_asr_calibration_not_established",
      ] as const),
      units: artifact.units,
    });
    verifiedEvidence.add(evidence);
    return Object.freeze({ ok: true as const, evidence });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "audible semantic evidence is invalid");
    return Object.freeze({ ok: false as const, errors: Object.freeze(errors) });
  }
}

export function lookupVerifiedAudibleSemanticUnit(
  evidence: VerifiedAudibleSemanticEvidence,
  unitId: string
): AudibleSemanticUnitRecord | null {
  if (!verifiedEvidence.has(evidence) || evidence[VERIFIED_EVIDENCE] !== true) {
    throw new Error("audible semantic unit lookup requires independently verified evidence");
  }
  safeId(unitId, "audible semantic lookup unit ID");
  return evidence.units.find((unit) => unit.unit_id === unitId) ?? null;
}

export function listenerObservationFromVerifiedEvidence(
  evidence: VerifiedAudibleSemanticEvidence,
  unitId: string
): ConditionBlindListenerObservation | null {
  const unit = lookupVerifiedAudibleSemanticUnit(evidence, unitId);
  return unit ? listenerFor(unit) : null;
}

export function serializeAudibleSemanticEvidence(artifact: AudibleSemanticEvidenceArtifact): string {
  const parsed = parseArtifact(artifact);
  if (audibleSemanticEvidenceArtifactHash(parsed) !== parsed.artifact_hash) {
    throw new Error("cannot serialize audible semantic evidence with an invalid hash");
  }
  return `${canonicalJson(parsed)}\n`;
}

function words(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

function editDistance(left: readonly string[], right: readonly string[]): number {
  let prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const next = [row];
    for (let column = 1; column <= right.length; column += 1) {
      next[column] = Math.min(
        prior[column] + 1,
        next[column - 1] + 1,
        prior[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    prior = next;
  }
  return prior[right.length];
}
