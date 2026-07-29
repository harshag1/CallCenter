import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson, sha256Hex } from "./artifacts";
import {
  createIndependentAsrRequest,
  independentAsrCalibrationSha256,
  independentAsrContractSha256,
  prepareIndependentAsrCalibration,
  verifyIndependentAsrInvocation,
  type IndependentAsrCalibration,
  type IndependentAsrContract,
  type IndependentAsrInvocationReceipt,
  type IndependentAsrResult,
  type PreparedIndependentAsrCalibration,
} from "./audible-evidence";
import { benchmarkKernelAttestationPublicKeyFingerprint } from "./kernel-attestation";
import { LC4_DEV_LISTENER_PLAN_SHA256 } from "./lc4-development-listener-semantics";
import { LC4_DEV_LISTENER_SEMANTIC_BUNDLE } from "./lc4-development-listener-semantics";
import {
  LC4_DEV_SEMANTIC_ASR_CALIBRATION_OPPORTUNITY_IDS,
} from "./lc4-development-asr-semantic-calibration-reference";
import {
  scoreLc4ListenerSemanticCriterion,
} from "./lc4-listener-evidence";
import {
  LC4_DEV_OUTPUT_ROUTE_CALIBRATION_CONFIG_SHA256,
  LC4_DEV_WHISPER_CPP_EXECUTABLE_SHA256,
  LC4_DEV_WHISPER_LARGE_V3_MODEL_SHA256,
} from "./lc4-development-whisper-runtime";

const SHA256 = /^[a-f0-9]{64}$/u;
const ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-dev-semantic-asr-calibration/v1\n";
const SIGNATURE_DOMAIN = "harshas-amazing-call-center/lc4-dev-semantic-asr-calibration-signature/v1\n";
const INVOCATION_DOMAIN = "hacc/independent-asr-invocation/v2\n";
const INVOCATION_SIGNATURE_DOMAIN = "hacc/independent-asr-invocation-signature/v2\n";
const RESULT_DOMAIN = "hacc/independent-asr-result/v2\n";

type RetainedFixture = Readonly<{
  fixture_id: string;
  route_id: string;
  voice: string;
  opportunity_id: string;
  criterion_plan_sha256: string;
  synthesis_prompt: string;
  reference_transcript: string;
  expected_semantic_phrases: readonly string[];
  pcm_path: string;
  pcm_sha256: string;
  request: Readonly<{
    run_id: string;
    unit_id: string;
    invocation_id: string;
    adapter_blind_nonce_sha256: string;
    request_sha256: string;
    source_chunk_sequence_sha256: string;
    played_sample_count: number;
  }>;
  result: IndependentAsrResult;
  signed_receipt: IndependentAsrInvocationReceipt;
}>;

export type Lc4DevelopmentSemanticCalibrationArtifact = Readonly<{
  schema_version: 1;
  artifact_type: "lc4_dev_provider_free_semantic_asr_calibration";
  created_at: string;
  semantic_plan_sha256: string;
  asr_contract: IndependentAsrContract;
  asr_contract_sha256: string;
  whisper_config_sha256: string;
  runner_trust: Readonly<{ keyId: string; publicKeySha256: string; publicKeyPem: string }>;
  tts: Readonly<{
    executable: "/usr/bin/say";
    executable_sha256: string;
    routes: readonly Readonly<{ route_id: string; voice: string }>[];
    fixture_count: number;
  }>;
  calibration: IndependentAsrCalibration;
  calibration_sha256: string;
  fixtures: readonly RetainedFixture[];
  artifact_sha256: string;
  signature: Readonly<{ algorithm: "ed25519"; key_id: string; signature_base64: string }>;
}>;

function receiptBody(receipt: IndependentAsrInvocationReceipt) {
  const body: Record<string, unknown> = { ...receipt };
  delete body.receipt_sha256;
  delete body.signature;
  return body;
}

function resultSha256(result: IndependentAsrResult): string {
  return sha256Hex(`${RESULT_DOMAIN}${canonicalJson(result)}`);
}

function asArtifact(input: unknown): Lc4DevelopmentSemanticCalibrationArtifact {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("LC4-DEV calibration artifact must be an object");
  return input as Lc4DevelopmentSemanticCalibrationArtifact;
}

/** Offline verifier for the signed envelope, every runner receipt, and every retained PCM byte string. */
export async function verifyLc4DevelopmentSemanticCalibrationArtifact(input: Readonly<{
  artifact: unknown;
  root_dir: string;
}>): Promise<Readonly<{ valid: boolean; errors: readonly string[] }>> {
  const errors: string[] = [];
  try {
    const artifact = asArtifact(input.artifact);
    if (artifact.schema_version !== 1 || artifact.artifact_type !== "lc4_dev_provider_free_semantic_asr_calibration") {
      throw new Error("LC4-DEV calibration schema/type mismatch");
    }
    if (artifact.semantic_plan_sha256 !== LC4_DEV_LISTENER_PLAN_SHA256) errors.push("semantic plan hash mismatch");
    if (artifact.whisper_config_sha256 !== LC4_DEV_OUTPUT_ROUTE_CALIBRATION_CONFIG_SHA256) errors.push("whisper configuration is not the passing route-calibrated configuration");
    if (artifact.asr_contract.engine.executable_sha256 !== LC4_DEV_WHISPER_CPP_EXECUTABLE_SHA256
      || artifact.asr_contract.engine.weights_sha256 !== LC4_DEV_WHISPER_LARGE_V3_MODEL_SHA256) {
      errors.push("ASR executable/model pin mismatch");
    }
    if (artifact.asr_contract_sha256 !== independentAsrContractSha256(artifact.asr_contract)) errors.push("ASR contract hash mismatch");
    if (artifact.calibration_sha256 !== independentAsrCalibrationSha256(artifact.calibration)) errors.push("calibration summary hash mismatch");
    if (artifact.calibration.status !== "calibrated") errors.push("provider-free semantic calibration is not calibrated");
    if (artifact.calibration.asr_contract_sha256 !== artifact.asr_contract_sha256) errors.push("calibration contract binding mismatch");
    if (artifact.runner_trust.publicKeySha256 !== benchmarkKernelAttestationPublicKeyFingerprint(artifact.runner_trust.publicKeyPem)) {
      errors.push("runner trust fingerprint mismatch");
    }
    if (artifact.signature.algorithm !== "ed25519" || artifact.signature.key_id !== artifact.runner_trust.keyId) {
      errors.push("artifact signature identity mismatch");
    }
    const claimed = artifact.artifact_sha256;
    const body: Record<string, unknown> = { ...artifact };
    delete body.artifact_sha256;
    delete body.signature;
    const computed = sha256Hex(`${ARTIFACT_DOMAIN}${canonicalJson(body)}`);
    if (claimed !== computed) errors.push("artifact root hash mismatch");
    const publicKey = createPublicKey(artifact.runner_trust.publicKeyPem);
    if (!verifySignature(null, Buffer.from(`${SIGNATURE_DOMAIN}${computed}`, "utf8"), publicKey, Buffer.from(artifact.signature.signature_base64, "base64"))) {
      errors.push("artifact signature verification failed");
    }
    if (!Array.isArray(artifact.fixtures) || artifact.fixtures.length !== 48 || artifact.tts.fixture_count !== 48) {
      errors.push("calibration fixture inventory must contain exactly 48 fixtures");
    }
    const expectedMatrix = new Set(
      ["synthetic-samantha", "synthetic-daniel"].flatMap((routeId) =>
        LC4_DEV_SEMANTIC_ASR_CALIBRATION_OPPORTUNITY_IDS.map(
          (opportunityId) => `${routeId}\0${opportunityId}`,
        )),
    );
    const observedMatrix = new Set<string>();
    const observedFixtureIds = new Set<string>();
    const root = resolve(input.root_dir);
    for (const fixture of artifact.fixtures ?? []) {
      if (observedFixtureIds.has(fixture.fixture_id)) {
        errors.push(`duplicate calibration fixture ID:${fixture.fixture_id}`);
      }
      observedFixtureIds.add(fixture.fixture_id);
      const matrixKey = `${fixture.route_id}\0${fixture.opportunity_id}`;
      if (!expectedMatrix.has(matrixKey) || observedMatrix.has(matrixKey)) {
        errors.push(`calibration route/opportunity substitution:${fixture.fixture_id}`);
      }
      observedMatrix.add(matrixKey);
      const opportunity =
        LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities.find(
          (candidate) =>
            candidate.opportunity_id === fixture.opportunity_id,
        );
      if (!opportunity
        || opportunity.criterion_plan_sha256 !==
          fixture.criterion_plan_sha256) {
        errors.push(`frozen semantic plan mismatch:${fixture.fixture_id}`);
      }
      if (typeof fixture.synthesis_prompt !== "string"
        || fixture.synthesis_prompt.length === 0
        || fixture.synthesis_prompt.length > 4_096) {
        errors.push(`invalid retained TTS prompt:${fixture.fixture_id}`);
      }
      if (fixture.result.status !== "completed") {
        errors.push(`ASR did not complete:${fixture.fixture_id}`);
      } else if (opportunity) {
        for (const criterion of opportunity.criteria.filter(
          (candidate) => candidate.required_for_final_scorer,
        )) {
          if (!scoreLc4ListenerSemanticCriterion(
            criterion,
            fixture.result.transcript,
          )) {
            errors.push(
              `frozen semantic replay failed:${fixture.fixture_id}:${criterion.criterion_id}`,
            );
          }
        }
      }
      if (!/^[A-Za-z0-9._-]+$/u.test(fixture.pcm_path)) throw new Error("calibration PCM path is unsafe");
      const pcm = new Uint8Array(await readFile(join(root, fixture.pcm_path)));
      if (sha256Hex(pcm) !== fixture.pcm_sha256 || fixture.request.played_sample_count * 2 !== pcm.byteLength) {
        errors.push(`PCM binding mismatch:${fixture.fixture_id}`);
      }
      const receipt = fixture.signed_receipt;
      const receiptHash = sha256Hex(`${INVOCATION_DOMAIN}${canonicalJson(receiptBody(receipt))}`);
      if (receipt.receipt_sha256 !== receiptHash
        || receipt.normalized_result_sha256 !== resultSha256(fixture.result)
        || receipt.request_sha256 !== fixture.request.request_sha256
        || receipt.source_played_audio_sha256 !== fixture.pcm_sha256
        || receipt.source_chunk_sequence_sha256 !== fixture.request.source_chunk_sequence_sha256
        || receipt.signing_key_id !== artifact.runner_trust.keyId
        || receipt.signing_public_key_sha256 !== artifact.runner_trust.publicKeySha256) {
        errors.push(`signed invocation binding mismatch:${fixture.fixture_id}`);
      }
      if (!verifySignature(null, Buffer.from(`${INVOCATION_SIGNATURE_DOMAIN}${receiptHash}`, "utf8"), publicKey, Buffer.from(receipt.signature.signature_base64, "base64"))) {
        errors.push(`signed invocation signature mismatch:${fixture.fixture_id}`);
      }
    }
    if (observedMatrix.size !== expectedMatrix.size
      || [...expectedMatrix].some((key) => !observedMatrix.has(key))) {
      errors.push("calibration route/opportunity matrix is incomplete");
    }
    if (!SHA256.test(artifact.artifact_sha256) || !SHA256.test(artifact.calibration_sha256)) errors.push("artifact contains an invalid digest");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

/** Recompute the branded prepared calibration from retained PCM and signed receipts. */
export async function prepareLc4DevelopmentSemanticCalibrationFromArtifact(input: Readonly<{
  artifact: unknown;
  root_dir: string;
}>): Promise<PreparedIndependentAsrCalibration> {
  const verification = await verifyLc4DevelopmentSemanticCalibrationArtifact(input);
  if (!verification.valid) throw new Error(`LC4-DEV semantic calibration verification failed: ${verification.errors.join("; ")}`);
  const artifact = asArtifact(input.artifact);
  const root = resolve(input.root_dir);
  const fixtures = await Promise.all(artifact.fixtures.map(async (fixture) => {
    const pcm = new Uint8Array(await readFile(join(root, fixture.pcm_path)));
    const request = createIndependentAsrRequest({
      runId: fixture.request.run_id,
      unitId: fixture.request.unit_id,
      invocationId: fixture.request.invocation_id,
      adapterBlindNonceSha256: fixture.request.adapter_blind_nonce_sha256,
      contract: artifact.asr_contract,
      chunks: Object.freeze([{ chunkId: "synthetic-reference", encoding: "pcm16", sampleRateHz: 24_000, channels: 1, data: pcm }]),
      playedThroughByte: pcm.byteLength,
    });
    if (request.request_sha256 !== fixture.request.request_sha256
      || request.source_chunk_sequence_sha256 !== fixture.request.source_chunk_sequence_sha256) {
      throw new Error(`LC4-DEV calibration canonical request mismatch:${fixture.fixture_id}`);
    }
    const invocation = verifyIndependentAsrInvocation({
      request,
      contract: artifact.asr_contract,
      result: fixture.result,
      receipt: fixture.signed_receipt,
      runnerTrust: artifact.runner_trust,
    });
    return Object.freeze({
      fixture_id: fixture.fixture_id,
      route_id: fixture.route_id,
      split: "held_out" as const,
      corpus_sample_id: `${fixture.opportunity_id}-${fixture.voice.toLowerCase()}`,
      reference_transcript: fixture.reference_transcript,
      expected_semantic_phrases: fixture.expected_semantic_phrases,
      forbidden_semantic_phrases: Object.freeze(["counterfeit lunar permission", "zebra override accepted"]),
      reference_audio_start_sample: 0,
      reference_audio_end_sample: request.played_sample_count,
      invocation,
    });
  }));
  const prepared = prepareIndependentAsrCalibration({
    plan: Object.freeze({
      calibration_id: artifact.calibration.calibration_id,
      protocol_sha256: artifact.calibration.protocol_sha256,
      corpus_manifest_sha256: artifact.calibration.corpus_manifest_sha256,
      evaluator_build_sha256: artifact.calibration.evaluator_build_sha256,
      expected_route_ids: Object.freeze(artifact.tts.routes.map((route) => route.route_id)),
      thresholds: artifact.calibration.thresholds,
    }),
    contract: artifact.asr_contract,
    fixtures,
    runnerTrust: artifact.runner_trust,
  });
  if (canonicalJson(prepared.summary) !== canonicalJson(artifact.calibration)) {
    throw new Error("LC4-DEV prepared calibration differs from the signed retained summary");
  }
  return prepared;
}
