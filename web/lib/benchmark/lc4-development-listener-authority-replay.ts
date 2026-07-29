import { createPublicKey } from "node:crypto";

import {
  canonicalJson,
  immutableJson,
  sha256Hex,
  type JsonValue,
} from "./artifacts";
import {
  assertLc4HeadlessListenerHandoffReceipt,
  createLc4HeadlessListenerAuthorityManifestSha256,
  type Lc4HeadlessListenerHandoffReceipt,
} from "./lc4-development-headless-listener-authority";
import {
  createLc4PinnedListenerManifestSha256,
  type Lc4ImmutableCas,
  type Lc4ImmutableCasReceipt,
} from "./lc4-development-live-dependencies";
import {
  lc4DevelopmentListenerCriterionBindings,
} from "./lc4-development-listener-semantics";
import type { Lc4CapturedOutput } from "./lc4-listener-evidence";
import {
  createLc4PublicDevelopmentCorpus,
} from "./lc4-public-development-corpus";

const SHA256 = /^[a-f0-9]{64}$/u;
const LISTENER_EVIDENCE_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-pinned-listener-evidence/v1\n";
const CAS_RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-cas-receipt/v1\n";
const REPLAY_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-listener-authority-replay/v1\n";
const DEPENDENCY_VERSION = "lc4-dev-live-dependencies-v1";

type JsonRecord = Record<string, JsonValue>;

/**
 * The preflight fields needed to turn an embedded public key into an intended
 * trust root. Callers must supply the independently expected fingerprint; a
 * self-consistent replacement preflight is not a trust anchor.
 */
export type Lc4ListenerAuthorityPreflightBinding = Readonly<{
  authority_trust_root_sha256: string;
  authorization_artifact_sha256: string;
  authorization_verified: true;
  listener_evidence_manifest_sha256: string;
  asr_evaluator_build_sha256: string;
  authorization: Readonly<{
    artifact_sha256: string;
    authority_public_key_spki_base64: string;
    authority_public_key_fingerprint_sha256: string;
    signature_algorithm: "Ed25519";
  }>;
}>;

export type Lc4ListenerAuthorityReplay = Readonly<{
  schema_version: 1;
  listener_evidence_sha256: string;
  capture_receipt_sha256: string;
  generated_pcm_sha256: string;
  evaluator_consumed_pcm_cas_receipt_sha256: string;
  headless_listener_authority_receipt_sha256: string;
  headless_listener_authority_receipt_cas_sha256: string;
  headless_listener_authority_receipt_cas_receipt_sha256: string;
  authority_manifest_sha256: string;
  authority_trust_root_sha256: string;
  authority_key_id: string;
  asr_evaluator_build_sha256: string;
  listener_evidence_manifest_sha256: string;
  physical_playback_status: "not_performed_headless";
  human_audibility_status: "not_measured_not_claimed";
  replay_sha256: string;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function assertOnlyKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  if (canonicalJson(Object.keys(value).sort())
    !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function hash(value: unknown, label: string): string {
  const digest = string(value, label);
  if (!SHA256.test(digest)) {
    throw new Error(`${label} must be one lowercase SHA-256`);
  }
  return digest;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function exactBase64Bytes(value: unknown, label: string): Uint8Array {
  const encoded = string(value, label);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    throw new Error(`${label} must be canonical base64`);
  }
  if (bytes.byteLength === 0 || bytes.toString("base64") !== encoded) {
    throw new Error(`${label} must be canonical base64`);
  }
  return new Uint8Array(bytes);
}

function exactJson(bytes: Uint8Array, label: string): JsonRecord {
  let encoded: string;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  const value = record(parsed, label);
  if (canonicalJson(value) !== encoded) {
    throw new Error(`${label} is not exact canonical JSON`);
  }
  return value;
}

function casReceiptSha256(input: Readonly<{
  artifact_sha256: string;
  byte_length: number;
  media_type: Lc4ImmutableCasReceipt["media_type"];
}>): string {
  const body = {
    schema_version: 1 as const,
    algorithm: "sha256" as const,
    artifact_sha256: input.artifact_sha256,
    byte_length: input.byte_length,
    relative_path:
      `${input.artifact_sha256.slice(0, 2)}/${input.artifact_sha256}`,
    media_type: input.media_type,
  };
  return domainHash(CAS_RECEIPT_DOMAIN, body);
}

function exactBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
): boolean {
  return actual.byteLength === expected.byteLength
    && Buffer.from(actual).equals(Buffer.from(expected));
}

function authorityTrust(input: Readonly<{
  preflight: Lc4ListenerAuthorityPreflightBinding;
  expected_authority_trust_root_sha256: string;
}>): Readonly<{
  keyId: string;
  publicKeySha256: string;
  publicKeyPem: string;
}> {
  const expectedRoot = hash(
    input.expected_authority_trust_root_sha256,
    "LC4 expected listener authority trust root",
  );
  const preflightRoot = hash(
    input.preflight.authority_trust_root_sha256,
    "LC4 preflight listener authority trust root",
  );
  const authorization = input.preflight.authorization;
  const authorizationRoot = hash(
    authorization.authority_public_key_fingerprint_sha256,
    "LC4 authorization public-key fingerprint",
  );
  if (input.preflight.authorization_verified !== true
    || authorization.signature_algorithm !== "Ed25519"
    || input.preflight.authorization_artifact_sha256
      !== authorization.artifact_sha256
    || expectedRoot !== preflightRoot
    || expectedRoot !== authorizationRoot) {
    throw new Error(
      "LC4 listener authority preflight differs from the intended trust root",
    );
  }
  const keyBytes = exactBase64Bytes(
    authorization.authority_public_key_spki_base64,
    "LC4 authorization public key",
  );
  if (sha256Hex(keyBytes) !== expectedRoot) {
    throw new Error(
      "LC4 listener authority public key differs from the intended trust root",
    );
  }
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(keyBytes),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error("LC4 listener authority public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("LC4 listener authority public key is not Ed25519");
  }
  return Object.freeze({
    // The default LC4 runtime derives this exact key ID from the preflight
    // fingerprint. Treating an arbitrary receipt-supplied alias as trusted
    // would let a same-key identity substitution bypass manifest replay.
    keyId: `lc4-dev-authority-${expectedRoot.slice(0, 24)}`,
    publicKeySha256: expectedRoot,
    publicKeyPem:
      publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
}

/**
 * Reopens the exact authority-receipt and evaluator-consumed PCM CAS objects,
 * validates both CAS receipt identities, and verifies the signed handoff
 * against the independently pinned preflight authority root.
 */
export async function replayLc4DevelopmentListenerAuthority(
  input: Readonly<{
    cas: Pick<Lc4ImmutableCas, "get">;
    preflight: Lc4ListenerAuthorityPreflightBinding;
    expected_authority_trust_root_sha256: string;
    listener_evidence: JsonValue;
    listener_evidence_sha256: string;
    capture: Lc4CapturedOutput;
    pcm: Uint8Array;
  }>,
): Promise<Lc4ListenerAuthorityReplay> {
  const listener = record(
    input.listener_evidence,
    "LC4 retained listener evidence",
  );
  const listenerEvidenceSha256 = hash(
    input.listener_evidence_sha256,
    "LC4 retained listener evidence hash",
  );
  if (listenerEvidenceSha256 !== domainHash(
    LISTENER_EVIDENCE_DOMAIN,
    listener,
  )) {
    throw new Error(
      "LC4 retained listener evidence differs from its exact domain hash",
    );
  }
  const trust = authorityTrust({
    preflight: input.preflight,
    expected_authority_trust_root_sha256:
      input.expected_authority_trust_root_sha256,
  });
  const listenerManifestSha256 = hash(
    listener.listener_manifest_sha256,
    "LC4 retained listener manifest",
  );
  if (listenerManifestSha256
    !== input.preflight.listener_evidence_manifest_sha256) {
    throw new Error(
      "LC4 retained listener evidence differs from the preflight listener manifest",
    );
  }
  const preflightEvaluatorBuildSha256 = hash(
    input.preflight.asr_evaluator_build_sha256,
    "LC4 preflight evaluator build",
  );

  const generatedPcmSha256 = hash(
    listener.generated_pcm_sha256,
    "LC4 listener generated PCM",
  );
  const pcm = Uint8Array.from(input.pcm);
  if (pcm.byteLength < 2
    || pcm.byteLength % 2 !== 0
    || sha256Hex(pcm) !== generatedPcmSha256) {
    throw new Error(
      "LC4 listener PCM differs from the exact generated PCM identity",
    );
  }
  const retainedPcm = Uint8Array.from(await input.cas.get(
    generatedPcmSha256,
  ));
  if (sha256Hex(retainedPcm) !== generatedPcmSha256
    || !exactBytesEqual(retainedPcm, pcm)) {
    throw new Error(
      "LC4 evaluator-consumed PCM CAS bytes are missing or substituted",
    );
  }
  const expectedPcmCasReceiptSha256 = casReceiptSha256({
    artifact_sha256: generatedPcmSha256,
    byte_length: pcm.byteLength,
    media_type: "audio/pcm",
  });
  if (listener.evaluator_consumed_pcm_cas_receipt_sha256
    !== expectedPcmCasReceiptSha256) {
    throw new Error(
      "LC4 evaluator-consumed PCM CAS receipt identity is invalid",
    );
  }

  const authorityReceiptCasSha256 = hash(
    listener.headless_listener_authority_receipt_cas_sha256,
    "LC4 listener authority receipt CAS artifact",
  );
  const authorityReceiptBytes = Uint8Array.from(await input.cas.get(
    authorityReceiptCasSha256,
  ));
  if (sha256Hex(authorityReceiptBytes) !== authorityReceiptCasSha256) {
    throw new Error(
      "LC4 listener authority receipt CAS bytes differ from their address",
    );
  }
  const expectedAuthorityCasReceiptSha256 = casReceiptSha256({
    artifact_sha256: authorityReceiptCasSha256,
    byte_length: authorityReceiptBytes.byteLength,
    media_type: "application/json",
  });
  if (listener.headless_listener_authority_receipt_cas_receipt_sha256
    !== expectedAuthorityCasReceiptSha256) {
    throw new Error(
      "LC4 listener authority receipt CAS receipt identity is invalid",
    );
  }
  const authorityReceiptJson = exactJson(
    authorityReceiptBytes,
    "LC4 listener authority receipt CAS artifact",
  );
  assertOnlyKeys(authorityReceiptJson, [
    "body",
    "signature_algorithm",
    "signature_base64",
    "receipt_sha256",
  ], "LC4 listener authority receipt CAS artifact");
  const authorityReceiptBody = record(
    authorityReceiptJson.body,
    "LC4 listener authority receipt body",
  );
  assertOnlyKeys(authorityReceiptBody, [
    "schema_version",
    "authority_version",
    "evidence_scope",
    "run_id",
    "opportunity_id",
    "response_id",
    "provider",
    "capture_receipt_sha256",
    "generated_chunk_sequence_sha256",
    "generated_pcm_sha256",
    "generated_byte_length",
    "captured_pcm_sha256",
    "captured_byte_start",
    "captured_byte_end",
    "evaluator_consumed_pcm_sha256",
    "evaluator_consumed_byte_start",
    "evaluator_consumed_byte_end",
    "evaluator_contract_sha256",
    "evaluator_build_sha256",
    "calibration_sha256",
    "criterion_plan_sha256",
    "evaluator_signed_invocation_receipt_sha256",
    "evaluator_signed_invocation_artifact_cas_sha256",
    "evaluator_signed_invocation_artifact_byte_length",
    "transcript_sha256",
    "semantic_result_sha256",
    "physical_playback_status",
    "human_audibility_status",
    "authority_manifest_sha256",
    "authority_key_id",
    "authority_public_key_sha256",
    "receipt_body_sha256",
  ], "LC4 listener authority receipt body");
  const signatureBytes = exactBase64Bytes(
    authorityReceiptJson.signature_base64,
    "LC4 listener authority receipt signature",
  );
  if (signatureBytes.byteLength !== 64) {
    throw new Error(
      "LC4 listener authority receipt signature is not one Ed25519 signature",
    );
  }
  const authorityReceipt =
    authorityReceiptJson as unknown as Lc4HeadlessListenerHandoffReceipt;
  const authorityReceiptSha256 = hash(
    listener.headless_listener_authority_receipt_sha256,
    "LC4 listener authority receipt",
  );
  if (authorityReceipt.receipt_sha256 !== authorityReceiptSha256) {
    throw new Error(
      "LC4 listener authority receipt differs from its listener evidence edge",
    );
  }

  assertLc4HeadlessListenerHandoffReceipt({
    receipt: authorityReceipt,
    trust,
    capture: input.capture,
    pcm,
  });
  const expectedAuthorityManifestSha256 =
    createLc4HeadlessListenerAuthorityManifestSha256({
      signer: {
        algorithm: "ed25519",
        keyId: trust.keyId,
        publicKeySha256: trust.publicKeySha256,
      },
    });
  const receipt = authorityReceipt.body;
  const evaluation = record(
    listener.evaluation,
    "LC4 retained listener evaluation",
  );
  const expectedListenerManifestSha256 =
    createLc4PinnedListenerManifestSha256({
      corpus_sha256:
        createLc4PublicDevelopmentCorpus().artifact_sha256,
      evaluator: {
        evaluator_contract_sha256: hash(
          evaluation.evaluator_contract_sha256,
          "LC4 listener evaluator contract",
        ),
        evaluator_build_sha256: hash(
          evaluation.evaluator_build_sha256,
          "LC4 listener evaluator build",
        ),
        calibration_sha256: hash(
          evaluation.calibration_sha256,
          "LC4 listener evaluator calibration",
        ),
      },
      criteria: lc4DevelopmentListenerCriterionBindings(),
      playback_authority_manifest_sha256:
        expectedAuthorityManifestSha256,
    });
  if (listener.schema_version !== 1
    || listener.dependency_version !== DEPENDENCY_VERSION
    || listener.episode_id !== input.capture.run_id
    || listener.opportunity_id !== input.capture.opportunity_id
    || listener.provider !== input.capture.provider
    || listener.capture_receipt_sha256
      !== input.capture.capture_receipt_sha256
    || listener.generated_pcm_sha256 !== generatedPcmSha256
    || listener.captured_pcm_sha256 !== generatedPcmSha256
    || listener.evaluator_consumed_pcm_sha256 !== generatedPcmSha256
    || listener.evaluator_consumed_byte_start !== 0
    || listener.evaluator_consumed_byte_end !== pcm.byteLength
    || listener.physical_playback_status !== "not_performed_headless"
    || listener.human_audibility_status !== "not_measured_not_claimed"
    || listenerManifestSha256 !== expectedListenerManifestSha256
    || input.preflight.listener_evidence_manifest_sha256
      !== expectedListenerManifestSha256
    || receipt.authority_manifest_sha256
      !== expectedAuthorityManifestSha256
    || receipt.authority_key_id !== trust.keyId
    || receipt.authority_public_key_sha256 !== trust.publicKeySha256
    || receipt.capture_receipt_sha256
      !== input.capture.capture_receipt_sha256
    || receipt.generated_chunk_sequence_sha256
      !== input.capture.generated_chunk_sequence_sha256
    || receipt.generated_pcm_sha256 !== generatedPcmSha256
    || receipt.generated_byte_length !== pcm.byteLength
    || receipt.criterion_plan_sha256 !== listener.criterion_plan_sha256
    || receipt.evaluator_contract_sha256
      !== evaluation.evaluator_contract_sha256
    || receipt.evaluator_build_sha256 !== evaluation.evaluator_build_sha256
    || evaluation.evaluator_build_sha256
      !== preflightEvaluatorBuildSha256
    || receipt.calibration_sha256 !== evaluation.calibration_sha256
    || receipt.evaluator_signed_invocation_receipt_sha256
      !== evaluation.signed_invocation_receipt_sha256
    || receipt.evaluator_signed_invocation_artifact_cas_sha256
      !== evaluation.signed_invocation_artifact_cas_sha256
    || receipt.evaluator_signed_invocation_artifact_byte_length
      !== evaluation.signed_invocation_artifact_byte_length
    || listener.signed_invocation_artifact_cas_sha256
      !== evaluation.signed_invocation_artifact_cas_sha256
    || listener.signed_invocation_artifact_byte_length
      !== evaluation.signed_invocation_artifact_byte_length
    || receipt.transcript_sha256 !== evaluation.transcript_sha256
    || receipt.semantic_result_sha256 !== evaluation.semantic_result_sha256
    || evaluation.source_pcm_sha256 !== generatedPcmSha256
    || integer(
      evaluation.source_pcm_byte_length,
      "LC4 listener evaluator source PCM bytes",
    ) !== pcm.byteLength) {
    throw new Error(
      "LC4 listener authority receipt is not bound to the exact listener, capture, evaluator, PCM, and preflight roots",
    );
  }

  const body = freeze({
    schema_version: 1 as const,
    listener_evidence_sha256: listenerEvidenceSha256,
    capture_receipt_sha256: input.capture.capture_receipt_sha256,
    generated_pcm_sha256: generatedPcmSha256,
    evaluator_consumed_pcm_cas_receipt_sha256:
      expectedPcmCasReceiptSha256,
    headless_listener_authority_receipt_sha256:
      authorityReceiptSha256,
    headless_listener_authority_receipt_cas_sha256:
      authorityReceiptCasSha256,
    headless_listener_authority_receipt_cas_receipt_sha256:
      expectedAuthorityCasReceiptSha256,
    authority_manifest_sha256: expectedAuthorityManifestSha256,
    authority_trust_root_sha256: trust.publicKeySha256,
    authority_key_id: trust.keyId,
    asr_evaluator_build_sha256: preflightEvaluatorBuildSha256,
    listener_evidence_manifest_sha256:
      expectedListenerManifestSha256,
    physical_playback_status: "not_performed_headless" as const,
    human_audibility_status: "not_measured_not_claimed" as const,
  });
  return freeze({
    ...body,
    replay_sha256: domainHash(REPLAY_DOMAIN, body),
  });
}
