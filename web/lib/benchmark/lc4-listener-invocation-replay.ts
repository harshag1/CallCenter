import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  createIndependentAsrRequest,
  independentAsrContractSha256,
  verifyIndependentAsrInvocation,
  type IndependentAsrContract,
} from "./audible-evidence";
import type { BenchmarkKernelAttestationTrust } from "./kernel-attestation";
import { lc4DevelopmentAsrBlindNonceSha256 } from "./lc4-development-listener-semantics";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const REPLAY_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-listener-invocation-replay/v1\n";
const MAX_INVOCATION_BYTES = 16 * 1024 * 1024;

const ROOT_KEYS = Object.freeze(["receipt", "request", "result"] as const);
const REQUEST_KEYS = Object.freeze([
  "adapter_blind_nonce_sha256",
  "asr_contract_sha256",
  "format",
  "invocation_id",
  "played_sample_count",
  "request_sha256",
  "run_id",
  "schema_version",
  "source_chunk_sequence_sha256",
  "source_played_audio_sha256",
  "unit_id",
] as const);

type JsonRecord = Record<string, unknown>;

export type Lc4ListenerInvocationReplay = Readonly<{
  schema_version: 1;
  run_id: string;
  opportunity_id: string;
  source_pcm_sha256: string;
  source_pcm_byte_length: number;
  source_sample_rate_hz: number;
  transcript_sha256: string;
  criterion_plan_sha256: string;
  asr_contract_sha256: string;
  request_sha256: string;
  signed_invocation_receipt_sha256: string;
  signed_invocation_artifact_cas_sha256: string;
  signed_invocation_artifact_byte_length: number;
  runner_key_id: string;
  runner_public_key_sha256: string;
  replay_sha256: string;
}>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  if (canonicalJson(Object.keys(value).sort())
    !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be one lowercase SHA-256`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be one safe identifier`);
  }
  return value;
}

function byteLength(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > MAX_INVOCATION_BYTES) {
    throw new Error(
      `${label} must be a safe integer from 1 through ${MAX_INVOCATION_BYTES}`,
    );
  }
  return value as number;
}

function pcm16(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)
    || value.byteLength < 2
    || value.byteLength % 2 !== 0) {
    throw new Error("LC4 listener invocation replay requires nonempty PCM16");
  }
  return Uint8Array.from(value);
}

function projectedRequest(
  request: ReturnType<typeof createIndependentAsrRequest>,
): JsonRecord {
  return {
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
  };
}

/**
 * Resolves the exact retained ASR invocation preimage and independently
 * verifies its request, result, receipt hash, Ed25519 signature, pinned
 * executable/model contract, source PCM, and preflight-selected runner key.
 *
 * The caller must supply the runner key ID/fingerprint that was signed into
 * preflight. A self-asserted key inside the receipt is never accepted as trust.
 */
export type Lc4ListenerInvocationReplayInput = Readonly<{
  artifact_bytes: Uint8Array;
  signed_invocation_artifact_cas_sha256: string;
  signed_invocation_artifact_byte_length: number;
  signed_invocation_receipt_sha256: string;
  run_id: string;
  opportunity_id: string;
  criterion_plan_sha256: string;
  source_pcm: Uint8Array;
  source_sample_rate_hz: number;
  expected_transcript_sha256: string;
  asr_contract: IndependentAsrContract;
  runner_trust: BenchmarkKernelAttestationTrust;
  expected_runner_key_id: string;
  expected_runner_public_key_sha256: string;
}>;

export type Lc4VerifiedListenerInvocation = Readonly<{
  replay: Lc4ListenerInvocationReplay;
  transcript: string;
}>;

export function verifyLc4ListenerInvocation(
  input: Lc4ListenerInvocationReplayInput,
): Lc4VerifiedListenerInvocation {
  const artifactSha256 = hash(
    input.signed_invocation_artifact_cas_sha256,
    "LC4 signed invocation artifact CAS address",
  );
  const artifactByteLength = byteLength(
    input.signed_invocation_artifact_byte_length,
    "LC4 signed invocation artifact byte length",
  );
  const receiptSha256 = hash(
    input.signed_invocation_receipt_sha256,
    "LC4 signed invocation receipt",
  );
  const expectedTranscriptSha256 = hash(
    input.expected_transcript_sha256,
    "LC4 listener evaluation transcript",
  );
  const criterionPlanSha256 = hash(
    input.criterion_plan_sha256,
    "LC4 listener criterion plan",
  );
  const expectedRunnerPublicKeySha256 = hash(
    input.expected_runner_public_key_sha256,
    "LC4 preflight ASR runner trust root",
  );
  const expectedRunnerKeyId = safeId(
    input.expected_runner_key_id,
    "LC4 preflight ASR runner key ID",
  );
  const runId = safeId(input.run_id, "LC4 listener invocation run ID");
  const opportunityId = safeId(
    input.opportunity_id,
    "LC4 listener invocation opportunity ID",
  );
  if (input.runner_trust.keyId !== expectedRunnerKeyId
    || input.runner_trust.publicKeySha256
      !== expectedRunnerPublicKeySha256) {
    throw new Error(
      "LC4 listener invocation runner trust differs from signed preflight",
    );
  }

  const sourcePcm = pcm16(input.source_pcm);
  if (!Number.isSafeInteger(input.source_sample_rate_hz)
    || input.source_sample_rate_hz < 8_000
    || input.source_sample_rate_hz > 96_000) {
    throw new Error(
      "LC4 listener invocation source sample rate must be a safe integer from 8000 through 96000",
    );
  }
  if (!(input.artifact_bytes instanceof Uint8Array)
    || input.artifact_bytes.byteLength !== artifactByteLength
    || input.artifact_bytes.byteLength > MAX_INVOCATION_BYTES) {
    throw new Error(
      "LC4 signed invocation artifact is missing, truncated, or CAS-substituted",
    );
  }
  const artifactBytes = Uint8Array.from(input.artifact_bytes);
  if (sha256Hex(artifactBytes) !== artifactSha256) {
    throw new Error(
      "LC4 signed invocation artifact is missing, truncated, or CAS-substituted",
    );
  }
  const encoded = Buffer.from(artifactBytes).toString("utf8");
  if (!Buffer.from(encoded, "utf8").equals(Buffer.from(artifactBytes))) {
    throw new Error("LC4 signed invocation artifact is not canonical UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("LC4 signed invocation artifact is not JSON");
  }
  const artifact = record(parsed, "LC4 signed invocation artifact");
  exactKeys(artifact, ROOT_KEYS, "LC4 signed invocation artifact");
  if (canonicalJson(artifact) !== encoded) {
    throw new Error("LC4 signed invocation artifact JSON is not canonical");
  }
  const retainedRequest = record(
    artifact.request,
    "LC4 signed invocation request",
  );
  exactKeys(
    retainedRequest,
    REQUEST_KEYS,
    "LC4 signed invocation request",
  );
  const retainedFormat = record(
    retainedRequest.format,
    "LC4 signed invocation request format",
  );
  if (retainedRequest.schema_version !== 1
    || retainedRequest.run_id !== runId
    || retainedRequest.unit_id !== `listener-${opportunityId}`
    || retainedFormat.encoding !== "pcm16"
    || retainedFormat.endianness !== "little"
    || retainedFormat.channels !== 1
    || retainedFormat.sample_rate_hz !== input.source_sample_rate_hz) {
    throw new Error(
      "LC4 signed invocation request identity or PCM format is invalid",
    );
  }

  const contractSha256 = independentAsrContractSha256(input.asr_contract);
  const blindNonceSha256 = lc4DevelopmentAsrBlindNonceSha256({
    source_pcm_sha256: sha256Hex(sourcePcm),
    source_pcm_byte_length: sourcePcm.byteLength,
    criterion_plan_sha256: criterionPlanSha256,
    evaluator_contract_sha256: contractSha256,
  });
  const requestIdentity = sha256Hex(`${blindNonceSha256}\n${runId}`)
    .slice(0, 24);
  const request = createIndependentAsrRequest({
    runId,
    unitId: `listener-${opportunityId}`,
    invocationId: `lc4-dev-asr-${requestIdentity}`,
    adapterBlindNonceSha256: blindNonceSha256,
    contract: input.asr_contract,
    chunks: Object.freeze([{
      chunkId: "captured-output",
      encoding: "pcm16" as const,
      sampleRateHz: input.source_sample_rate_hz,
      channels: 1 as const,
      data: sourcePcm,
    }]),
    playedThroughByte: sourcePcm.byteLength,
  });
  if (canonicalJson(projectedRequest(request))
    !== canonicalJson(retainedRequest)) {
    throw new Error(
      "LC4 retained ASR request differs from the exact PCM, criterion, contract, or run identity",
    );
  }

  const invocation = verifyIndependentAsrInvocation({
    request,
    contract: input.asr_contract,
    result: artifact.result,
    receipt: artifact.receipt,
    runnerTrust: input.runner_trust,
  });
  if (invocation.receipt.receipt_sha256 !== receiptSha256
    || invocation.receipt.signing_key_id !== expectedRunnerKeyId
    || invocation.receipt.signing_public_key_sha256
      !== expectedRunnerPublicKeySha256) {
    throw new Error(
      "LC4 signed invocation receipt differs from the listener evidence or preflight runner",
    );
  }
  if (invocation.result.status !== "completed"
    || invocation.result.transcript.trim().length === 0) {
    throw new Error(
      "LC4 listener invocation replay requires one completed nonempty ASR result",
    );
  }
  const transcriptSha256 = sha256Hex(
    Buffer.from(invocation.result.transcript, "utf8"),
  );
  if (transcriptSha256 !== expectedTranscriptSha256) {
    throw new Error(
      "LC4 signed invocation transcript differs from the listener evaluation",
    );
  }

  const body = immutableJson({
    schema_version: 1 as const,
    run_id: runId,
    opportunity_id: opportunityId,
    source_pcm_sha256: request.source_played_audio_sha256,
    source_pcm_byte_length: sourcePcm.byteLength,
    source_sample_rate_hz: input.source_sample_rate_hz,
    transcript_sha256: transcriptSha256,
    criterion_plan_sha256: criterionPlanSha256,
    asr_contract_sha256: contractSha256,
    request_sha256: request.request_sha256,
    signed_invocation_receipt_sha256: receiptSha256,
    signed_invocation_artifact_cas_sha256: artifactSha256,
    signed_invocation_artifact_byte_length: artifactByteLength,
    runner_key_id: expectedRunnerKeyId,
    runner_public_key_sha256: expectedRunnerPublicKeySha256,
  }) as Omit<Lc4ListenerInvocationReplay, "replay_sha256">;
  const replay = immutableJson({
    ...body,
    replay_sha256: sha256Hex(`${REPLAY_DOMAIN}${canonicalJson(body)}`),
  }) as Lc4ListenerInvocationReplay;
  return Object.freeze({
    replay,
    transcript: invocation.result.transcript,
  });
}

export function replayLc4ListenerInvocation(
  input: Lc4ListenerInvocationReplayInput,
): Lc4ListenerInvocationReplay {
  return verifyLc4ListenerInvocation(input).replay;
}
