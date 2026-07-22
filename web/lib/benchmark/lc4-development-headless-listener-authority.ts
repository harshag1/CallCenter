import { createPublicKey, verify as verifySignature } from "node:crypto";

import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import type {
  BenchmarkKernelAttestationSigner,
  BenchmarkKernelAttestationTrust,
} from "./kernel-attestation";
import {
  assertLc4CapturedOutputIntegrity,
  type Lc4CapturedOutput,
  type Lc4CrpBlockerCode,
} from "./lc4-listener-evidence";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const MANIFEST_DOMAIN = "harshas-amazing-call-center/lc4-dev/headless-listener-authority-manifest/v1\n";
const RECEIPT_BODY_DOMAIN = "harshas-amazing-call-center/lc4-dev/headless-listener-handoff-receipt/v1\n";
const SIGNATURE_DOMAIN = "harshas-amazing-call-center/lc4-dev/headless-listener-handoff-signature/v1\n";
const ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-dev/headless-listener-handoff-artifact/v1\n";
const REPAIR_PROJECTION_DOMAIN = "harshas-amazing-call-center/lc4-dev/arm-blind-repair-projection/v1\n";

export const LC4_HEADLESS_LISTENER_AUTHORITY_VERSION = "lc4-dev-headless-listener-authority-v1" as const;

function hash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function requireHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe opaque identifier`);
}

function exactCapturedPcm(capture: Lc4CapturedOutput): Uint8Array {
  assertLc4CapturedOutputIntegrity(capture);
  const pcm = new Uint8Array(capture.generated_byte_length);
  let offset = 0;
  for (const chunk of capture.chunks) {
    pcm.set(chunk.pcm, offset);
    offset += chunk.pcm.byteLength;
  }
  if (offset !== capture.generated_byte_length || sha256Hex(pcm) !== capture.generated_pcm_sha256) {
    throw new Error("LC4 headless listener capture does not reconstruct to its complete generated PCM");
  }
  return pcm;
}

export type Lc4PinnedListenerEvaluation = Readonly<{
  source_pcm_sha256: string;
  source_pcm_byte_length: number;
  evaluator_contract_sha256: string;
  evaluator_build_sha256: string;
  calibration_sha256: string;
  transcript_sha256: string;
  semantic_result_sha256: string;
  signed_invocation_receipt_sha256: string;
  repair_projection?: Lc4DevArmBlindRepairProjection;
}>;

export type Lc4DevArmBlindRepairProjection = Readonly<{
  schema_version: 1;
  opportunity_id: string;
  listener_status: "verified";
  semantic_result_sha256: string;
  semantic_replay_sha256: string;
  unmet_blocker_codes: readonly Lc4CrpBlockerCode[];
  final_required_criteria_pass: boolean;
  projection_sha256: string;
}>;

export function createLc4DevArmBlindRepairProjection(input: Omit<Lc4DevArmBlindRepairProjection, "schema_version" | "projection_sha256">): Lc4DevArmBlindRepairProjection {
  requireSafeId(input.opportunity_id, "LC4 repair projection opportunity ID");
  requireHash(input.semantic_result_sha256, "LC4 repair projection semantic result");
  requireHash(input.semantic_replay_sha256, "LC4 repair projection semantic replay");
  if (input.listener_status !== "verified" || new Set(input.unmet_blocker_codes).size !== input.unmet_blocker_codes.length) {
    throw new Error("LC4 repair projection must contain unique blockers from verified listener evidence");
  }
  const body = freeze({ schema_version: 1 as const, ...input, unmet_blocker_codes: [...input.unmet_blocker_codes] });
  return freeze({ ...body, projection_sha256: hash(REPAIR_PROJECTION_DOMAIN, body) });
}

export function assertLc4DevArmBlindRepairProjection(projection: Lc4DevArmBlindRepairProjection): void {
  const rebuilt = createLc4DevArmBlindRepairProjection({
    opportunity_id: projection.opportunity_id,
    listener_status: projection.listener_status,
    semantic_result_sha256: projection.semantic_result_sha256,
    semantic_replay_sha256: projection.semantic_replay_sha256,
    unmet_blocker_codes: projection.unmet_blocker_codes,
    final_required_criteria_pass: projection.final_required_criteria_pass,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(projection)) throw new Error("LC4 repair projection hash or shape mismatch");
}

export type Lc4PinnedListenerEvaluator = Readonly<{
  evaluator_contract_sha256: string;
  evaluator_build_sha256: string;
  calibration_sha256: string;
  evaluate(input: Readonly<{
    run_id: string;
    opportunity_id: string;
    provider: "openai" | "gemini" | "xai";
    sample_rate_hz: number;
    pcm: Uint8Array;
    criterion_plan_sha256: string;
  }>): Promise<Lc4PinnedListenerEvaluation>;
}>;

export type Lc4HeadlessListenerHandoffReceiptBody = Readonly<{
  schema_version: 1;
  authority_version: typeof LC4_HEADLESS_LISTENER_AUTHORITY_VERSION;
  evidence_scope: "server_captured_pcm_handed_to_pinned_evaluator";
  run_id: string;
  opportunity_id: string;
  response_id: string;
  provider: "openai" | "gemini" | "xai";
  capture_receipt_sha256: string;
  generated_chunk_sequence_sha256: string;
  generated_pcm_sha256: string;
  generated_byte_length: number;
  captured_pcm_sha256: string;
  captured_byte_start: 0;
  captured_byte_end: number;
  evaluator_consumed_pcm_sha256: string;
  evaluator_consumed_byte_start: 0;
  evaluator_consumed_byte_end: number;
  evaluator_contract_sha256: string;
  evaluator_build_sha256: string;
  calibration_sha256: string;
  criterion_plan_sha256: string;
  evaluator_signed_invocation_receipt_sha256: string;
  transcript_sha256: string;
  semantic_result_sha256: string;
  physical_playback_status: "not_performed_headless";
  human_audibility_status: "not_measured_not_claimed";
  authority_manifest_sha256: string;
  authority_key_id: string;
  authority_public_key_sha256: string;
  receipt_body_sha256: string;
}>;

export type Lc4HeadlessListenerHandoffReceipt = Readonly<{
  body: Lc4HeadlessListenerHandoffReceiptBody;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  receipt_sha256: string;
}>;

export type Lc4ListenerPlaybackAuthority = Readonly<{
  /** Historical interface name; this mode makes no physical-playback claim. */
  mode: "headless_evaluator_handoff";
  authority_manifest_sha256: string;
  consume(input: Readonly<{
    capture: Lc4CapturedOutput;
    pcm: Uint8Array;
    criterion_plan_sha256: string;
    evaluator: Lc4PinnedListenerEvaluator;
  }>): Promise<Readonly<{
    status: "evaluator_consumed_complete_capture";
    generated_pcm_sha256: string;
    generated_byte_length: number;
    captured_pcm_sha256: string;
    captured_byte_start: 0;
    captured_byte_end: number;
    evaluator_consumed_pcm_sha256: string;
    evaluator_consumed_byte_start: 0;
    evaluator_consumed_byte_end: number;
    physical_playback_status: "not_performed_headless";
    human_audibility_status: "not_measured_not_claimed";
    authority_receipt: Lc4HeadlessListenerHandoffReceipt;
    evaluation: Lc4PinnedListenerEvaluation;
  }>>;
}>;

export function createLc4HeadlessListenerAuthorityManifestSha256(input: Readonly<{
  signer: Pick<BenchmarkKernelAttestationSigner, "algorithm" | "keyId" | "publicKeySha256">;
}>): string {
  if (input.signer.algorithm !== "ed25519") throw new Error("LC4 headless listener authority signer must be Ed25519");
  requireSafeId(input.signer.keyId, "LC4 headless listener authority key ID");
  requireHash(input.signer.publicKeySha256, "LC4 headless listener authority public-key hash");
  return hash(MANIFEST_DOMAIN, {
    schema_version: 1,
    authority_version: LC4_HEADLESS_LISTENER_AUTHORITY_VERSION,
    mode: "headless_evaluator_handoff",
    evidence_scope: "server_captured_pcm_handed_to_pinned_evaluator",
    physical_playback_status: "not_performed_headless",
    human_audibility_status: "not_measured_not_claimed",
    byte_range_policy: "complete_capture_zero_to_generated_byte_length",
    signer: {
      algorithm: input.signer.algorithm,
      key_id: input.signer.keyId,
      public_key_sha256: input.signer.publicKeySha256,
    },
  });
}

function validateEvaluatorIdentity(evaluator: Lc4PinnedListenerEvaluator): void {
  requireHash(evaluator.evaluator_contract_sha256, "LC4 listener evaluator contract hash");
  requireHash(evaluator.evaluator_build_sha256, "LC4 listener evaluator build hash");
  requireHash(evaluator.calibration_sha256, "LC4 listener evaluator calibration hash");
}

function validateEvaluation(
  evaluation: Lc4PinnedListenerEvaluation,
  evaluator: Lc4PinnedListenerEvaluator,
  expectedPcmSha256: string,
  expectedByteLength: number,
): void {
  for (const [label, digest] of Object.entries({
    source_pcm_sha256: evaluation.source_pcm_sha256,
    evaluator_contract_sha256: evaluation.evaluator_contract_sha256,
    evaluator_build_sha256: evaluation.evaluator_build_sha256,
    calibration_sha256: evaluation.calibration_sha256,
    transcript_sha256: evaluation.transcript_sha256,
    semantic_result_sha256: evaluation.semantic_result_sha256,
    signed_invocation_receipt_sha256: evaluation.signed_invocation_receipt_sha256,
  })) requireHash(digest, `LC4 listener evaluation ${label}`);
  if (evaluation.repair_projection) assertLc4DevArmBlindRepairProjection(evaluation.repair_projection);
  if (evaluation.source_pcm_sha256 !== expectedPcmSha256
    || evaluation.source_pcm_byte_length !== expectedByteLength
    || evaluation.evaluator_contract_sha256 !== evaluator.evaluator_contract_sha256
    || evaluation.evaluator_build_sha256 !== evaluator.evaluator_build_sha256
    || evaluation.calibration_sha256 !== evaluator.calibration_sha256
    || (evaluation.repair_projection !== undefined
      && evaluation.repair_projection.semantic_result_sha256 !== evaluation.semantic_result_sha256)) {
    throw new Error("LC4 headless evaluator did not attest consumption of the exact complete captured PCM");
  }
}

/**
 * Creates the server-side authority used by headless LC4-DEV runs. It owns the
 * evaluator invocation, passes one immutable copy of the complete capture, and
 * signs the resulting byte-range/evaluator binding. It deliberately does not
 * claim that a physical speaker or human caller heard the bytes.
 */
export function createLc4HeadlessListenerPlaybackAuthority(input: Readonly<{
  signer: BenchmarkKernelAttestationSigner;
}>): Lc4ListenerPlaybackAuthority {
  const authorityManifestSha256 = createLc4HeadlessListenerAuthorityManifestSha256({ signer: input.signer });
  return Object.freeze({
    mode: "headless_evaluator_handoff" as const,
    authority_manifest_sha256: authorityManifestSha256,
    consume: async ({ capture, pcm, criterion_plan_sha256, evaluator }) => {
      requireHash(criterion_plan_sha256, "LC4 listener criterion plan");
      validateEvaluatorIdentity(evaluator);
      const capturedPcm = exactCapturedPcm(capture);
      if (!(pcm instanceof Uint8Array)
        || pcm.byteLength !== capturedPcm.byteLength
        || sha256Hex(pcm) !== sha256Hex(capturedPcm)) {
        throw new Error("LC4 headless listener handoff differs from the exact complete captured PCM");
      }
      const beforeEvaluationSha256 = sha256Hex(capturedPcm);
      const evaluatorInputPcm = Uint8Array.from(capturedPcm);
      const evaluation = await evaluator.evaluate(Object.freeze({
        run_id: capture.run_id,
        opportunity_id: capture.opportunity_id,
        provider: capture.provider,
        sample_rate_hz: capture.format.sample_rate_hz,
        pcm: evaluatorInputPcm,
        criterion_plan_sha256,
      }));
      if (sha256Hex(evaluatorInputPcm) !== beforeEvaluationSha256) {
        throw new Error("LC4 headless evaluator mutated its source PCM buffer during evaluation");
      }
      validateEvaluation(evaluation, evaluator, beforeEvaluationSha256, capturedPcm.byteLength);

      const bodyWithoutHash = {
        schema_version: 1 as const,
        authority_version: LC4_HEADLESS_LISTENER_AUTHORITY_VERSION,
        evidence_scope: "server_captured_pcm_handed_to_pinned_evaluator" as const,
        run_id: capture.run_id,
        opportunity_id: capture.opportunity_id,
        response_id: capture.response_id,
        provider: capture.provider,
        capture_receipt_sha256: capture.capture_receipt_sha256,
        generated_chunk_sequence_sha256: capture.generated_chunk_sequence_sha256,
        generated_pcm_sha256: capture.generated_pcm_sha256,
        generated_byte_length: capture.generated_byte_length,
        captured_pcm_sha256: beforeEvaluationSha256,
        captured_byte_start: 0 as const,
        captured_byte_end: capturedPcm.byteLength,
        evaluator_consumed_pcm_sha256: evaluation.source_pcm_sha256,
        evaluator_consumed_byte_start: 0 as const,
        evaluator_consumed_byte_end: evaluation.source_pcm_byte_length,
        evaluator_contract_sha256: evaluation.evaluator_contract_sha256,
        evaluator_build_sha256: evaluation.evaluator_build_sha256,
        calibration_sha256: evaluation.calibration_sha256,
        criterion_plan_sha256,
        evaluator_signed_invocation_receipt_sha256: evaluation.signed_invocation_receipt_sha256,
        transcript_sha256: evaluation.transcript_sha256,
        semantic_result_sha256: evaluation.semantic_result_sha256,
        physical_playback_status: "not_performed_headless" as const,
        human_audibility_status: "not_measured_not_claimed" as const,
        authority_manifest_sha256: authorityManifestSha256,
        authority_key_id: input.signer.keyId,
        authority_public_key_sha256: input.signer.publicKeySha256,
      };
      const body = freeze({
        ...bodyWithoutHash,
        receipt_body_sha256: hash(RECEIPT_BODY_DOMAIN, bodyWithoutHash),
      });
      const signatureBase64 = input.signer.sign(`${SIGNATURE_DOMAIN}${canonicalJson(body)}`);
      const receiptWithoutHash = {
        body,
        signature_algorithm: "Ed25519" as const,
        signature_base64: signatureBase64,
      };
      const authorityReceipt = freeze({
        ...receiptWithoutHash,
        receipt_sha256: hash(ARTIFACT_DOMAIN, receiptWithoutHash),
      });
      return freeze({
        status: "evaluator_consumed_complete_capture" as const,
        generated_pcm_sha256: capture.generated_pcm_sha256,
        generated_byte_length: capture.generated_byte_length,
        captured_pcm_sha256: beforeEvaluationSha256,
        captured_byte_start: 0 as const,
        captured_byte_end: capturedPcm.byteLength,
        evaluator_consumed_pcm_sha256: evaluation.source_pcm_sha256,
        evaluator_consumed_byte_start: 0 as const,
        evaluator_consumed_byte_end: evaluation.source_pcm_byte_length,
        physical_playback_status: "not_performed_headless" as const,
        human_audibility_status: "not_measured_not_claimed" as const,
        authority_receipt: authorityReceipt,
        evaluation,
      });
    },
  });
}

/** Independently verifies a retained authority receipt and, when supplied, its source capture/PCM. */
export function assertLc4HeadlessListenerHandoffReceipt(input: Readonly<{
  receipt: Lc4HeadlessListenerHandoffReceipt;
  trust: BenchmarkKernelAttestationTrust;
  capture?: Lc4CapturedOutput;
  pcm?: Uint8Array;
}>): void {
  const { receipt, trust } = input;
  const { receipt_body_sha256: claimedBodyHash, ...bodyWithoutHash } = receipt.body;
  if (receipt.body.schema_version !== 1
    || receipt.body.authority_version !== LC4_HEADLESS_LISTENER_AUTHORITY_VERSION
    || receipt.body.evidence_scope !== "server_captured_pcm_handed_to_pinned_evaluator"
    || receipt.body.physical_playback_status !== "not_performed_headless"
    || receipt.body.human_audibility_status !== "not_measured_not_claimed"
    || receipt.body.captured_byte_start !== 0
    || receipt.body.evaluator_consumed_byte_start !== 0
    || receipt.body.captured_byte_end !== receipt.body.generated_byte_length
    || receipt.body.evaluator_consumed_byte_end !== receipt.body.generated_byte_length
    || receipt.body.generated_pcm_sha256 !== receipt.body.captured_pcm_sha256
    || receipt.body.generated_pcm_sha256 !== receipt.body.evaluator_consumed_pcm_sha256
    || claimedBodyHash !== hash(RECEIPT_BODY_DOMAIN, bodyWithoutHash)) {
    throw new Error("LC4 headless listener receipt does not prove complete exact evaluator consumption");
  }
  for (const digest of [
    receipt.body.capture_receipt_sha256,
    receipt.body.generated_chunk_sequence_sha256,
    receipt.body.generated_pcm_sha256,
    receipt.body.evaluator_contract_sha256,
    receipt.body.evaluator_build_sha256,
    receipt.body.calibration_sha256,
    receipt.body.criterion_plan_sha256,
    receipt.body.evaluator_signed_invocation_receipt_sha256,
    receipt.body.transcript_sha256,
    receipt.body.semantic_result_sha256,
    receipt.body.authority_manifest_sha256,
    receipt.body.authority_public_key_sha256,
    receipt.body.receipt_body_sha256,
  ]) requireHash(digest, "LC4 headless listener receipt hash");
  requireSafeId(receipt.body.authority_key_id, "LC4 headless listener authority key ID");
  if (receipt.signature_algorithm !== "Ed25519"
    || receipt.body.authority_key_id !== trust.keyId
    || receipt.body.authority_public_key_sha256 !== trust.publicKeySha256
    || receipt.receipt_sha256 !== hash(ARTIFACT_DOMAIN, {
      body: receipt.body,
      signature_algorithm: receipt.signature_algorithm,
      signature_base64: receipt.signature_base64,
    })) {
    throw new Error("LC4 headless listener receipt signer or artifact binding is invalid");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(trust.publicKeyPem);
  } catch {
    throw new Error("LC4 headless listener trust key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519"
    || sha256Hex(new Uint8Array(publicKey.export({ type: "spki", format: "der" }))) !== trust.publicKeySha256
    || !verifySignature(
      null,
      Buffer.from(`${SIGNATURE_DOMAIN}${canonicalJson(receipt.body)}`, "utf8"),
      publicKey,
      Buffer.from(receipt.signature_base64, "base64"),
    )) {
    throw new Error("LC4 headless listener receipt signature is invalid");
  }
  if (input.capture) {
    const expected = exactCapturedPcm(input.capture);
    if (input.capture.run_id !== receipt.body.run_id
      || input.capture.opportunity_id !== receipt.body.opportunity_id
      || input.capture.response_id !== receipt.body.response_id
      || input.capture.provider !== receipt.body.provider
      || input.capture.capture_receipt_sha256 !== receipt.body.capture_receipt_sha256
      || input.capture.generated_chunk_sequence_sha256 !== receipt.body.generated_chunk_sequence_sha256
      || input.capture.generated_pcm_sha256 !== receipt.body.generated_pcm_sha256
      || expected.byteLength !== receipt.body.generated_byte_length) {
      throw new Error("LC4 headless listener receipt is substituted from another capture");
    }
  }
  if (input.pcm && (input.pcm.byteLength !== receipt.body.generated_byte_length
    || sha256Hex(input.pcm) !== receipt.body.generated_pcm_sha256)) {
    throw new Error("LC4 headless listener receipt is not bound to the supplied PCM bytes");
  }
}
