import { createPublicKey, verify } from "node:crypto";
import {
  canonicalEvidenceJsonV2,
  evidenceSha256HexV2,
  publicKeyFingerprintV2,
} from "../../../evidence-v2";
import { exactRecord, safeId, sha256, timestamp } from "../../../evidence-v2/validation";

const SIDECAR_ROOT_DOMAIN = "hacc/blind-semantic-sidecar-v2/root/v2\n";
const SIDECAR_SIGNATURE_DOMAIN = "hacc/blind-semantic-sidecar-v2/signature/v2\n";
const SIDECAR_KEYS = [
  "schema_version", "sidecar_type", "opaque_evaluation_id", "raw_manifest_root_sha256",
  "blind_package_sha256", "taxonomy_id", "taxonomy_sha256", "normalizer_sha256",
  "asr_contract_sha256", "finalized_at", "observations", "signer_id",
  "signing_public_key_sha256", "sidecar_root_sha256", "signature",
] as const;
const OBSERVATION_KEYS = [
  "opportunity_id", "played_audio", "asr_transcript_sha256", "alignment_sha256",
  "required_act_observed", "violation_codes",
] as const;
const PLAYED_AUDIO_KEYS = ["audio_sha256", "start_sample", "end_sample"] as const;
const SIGNATURE_KEYS = ["algorithm", "signer_id", "signature_base64"] as const;

export const SEMANTIC_VIOLATION_CODES_V2 = Object.freeze([
  "stale_fact",
  "unsupported_terminal_claim",
  "private_disclosure",
  "forbidden_policy_statement",
  "premature_semantic_action",
  "lost_obligation",
] as const);

export type SemanticViolationCodeV2 = typeof SEMANTIC_VIOLATION_CODES_V2[number];

export type BlindSemanticSidecarV2 = Readonly<{
  schema_version: 2;
  sidecar_type: "hacc_blind_semantic_sidecar";
  opaque_evaluation_id: string;
  raw_manifest_root_sha256: string;
  blind_package_sha256: string;
  taxonomy_id: string;
  taxonomy_sha256: string;
  normalizer_sha256: string;
  asr_contract_sha256: string;
  finalized_at: string;
  observations: readonly Readonly<{
    opportunity_id: string;
    played_audio: readonly Readonly<{
      audio_sha256: string;
      start_sample: number;
      end_sample: number;
    }>[];
    asr_transcript_sha256: string;
    alignment_sha256: string;
    /** null means the played-audio semantics were not verifiable. */
    required_act_observed: boolean | null;
    violation_codes: readonly SemanticViolationCodeV2[];
  }>[];
  signer_id: string;
  signing_public_key_sha256: string;
  sidecar_root_sha256: string;
  signature: Readonly<{
    algorithm: "ed25519";
    signer_id: string;
    signature_base64: string;
  }>;
}>;

export type BlindSemanticTrustV2 = Readonly<{
  signer_id: string;
  public_key_pem: string;
  taxonomy_id: string;
  taxonomy_sha256: string;
  normalizer_sha256: string;
  asr_contract_sha256: string;
}>;

declare const VERIFIED_SIDECAR: unique symbol;
export type VerifiedBlindSemanticSidecarV2 = BlindSemanticSidecarV2 & {
  readonly [VERIFIED_SIDECAR]: true;
};

export type BlindSemanticSidecarVerificationV2 =
  | Readonly<{ ok: true; sidecar: VerifiedBlindSemanticSidecarV2 }>
  | Readonly<{ ok: false; errors: readonly Readonly<{ code: string; message: string }>[] }>;

type UnsignedSidecar = Omit<BlindSemanticSidecarV2, "sidecar_root_sha256" | "signature">;

export function blindSemanticSidecarRootV2(value: UnsignedSidecar): string {
  return evidenceSha256HexV2(`${SIDECAR_ROOT_DOMAIN}${canonicalEvidenceJsonV2(value)}`);
}

export function blindSemanticSidecarSignaturePayloadV2(rootSha256: string): string {
  sha256(rootSha256, "blind semantic sidecar root");
  return `${SIDECAR_SIGNATURE_DOMAIN}${rootSha256}`;
}

function canonicalSignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === value;
}

function parseInput(input: unknown): Readonly<{ value: unknown; byteError: string | null }> {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    return Object.freeze({ value: input, byteError: null });
  }
  let text: string;
  try {
    text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return Object.freeze({ value: null, byteError: "sidecar is not valid UTF-8" });
  }
  try {
    const value = JSON.parse(text) as unknown;
    return Object.freeze({
      value,
      byteError: text === `${canonicalEvidenceJsonV2(value)}\n`
        ? null
        : "serialized sidecar is not canonical JSON followed by one newline",
    });
  } catch {
    return Object.freeze({ value: null, byteError: "sidecar is not valid JSON" });
  }
}

function integer(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function validateStructure(input: unknown): BlindSemanticSidecarV2 {
  exactRecord(input, SIDECAR_KEYS, "blind semantic sidecar");
  if (input.schema_version !== 2 || input.sidecar_type !== "hacc_blind_semantic_sidecar") {
    throw new Error("blind semantic sidecar has an unsupported schema or type");
  }
  safeId(input.opaque_evaluation_id, "opaque evaluation ID");
  sha256(input.raw_manifest_root_sha256, "raw manifest root");
  sha256(input.blind_package_sha256, "blind package hash");
  safeId(input.taxonomy_id, "taxonomy ID");
  sha256(input.taxonomy_sha256, "taxonomy hash");
  sha256(input.normalizer_sha256, "normalizer hash");
  sha256(input.asr_contract_sha256, "ASR contract hash");
  timestamp(input.finalized_at, "sidecar finalization time");
  safeId(input.signer_id, "sidecar signer ID");
  sha256(input.signing_public_key_sha256, "sidecar public-key fingerprint");
  sha256(input.sidecar_root_sha256, "sidecar root");
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new Error("blind semantic sidecar must contain observations");
  }
  const opportunityIds = new Set<string>();
  for (const [index, candidate] of input.observations.entries()) {
    exactRecord(candidate, OBSERVATION_KEYS, `semantic observation[${index}]`);
    safeId(candidate.opportunity_id, `semantic observation[${index}] opportunity ID`);
    if (opportunityIds.has(candidate.opportunity_id)) {
      throw new Error(`blind semantic sidecar repeats opportunity ${candidate.opportunity_id}`);
    }
    opportunityIds.add(candidate.opportunity_id);
    if (!Array.isArray(candidate.played_audio) || candidate.played_audio.length === 0) {
      throw new Error(`semantic observation[${index}] must bind listener-played audio`);
    }
    for (const [rangeIndex, range] of candidate.played_audio.entries()) {
      exactRecord(range, PLAYED_AUDIO_KEYS, `semantic observation[${index}] played_audio[${rangeIndex}]`);
      sha256(range.audio_sha256, `semantic observation[${index}] audio hash`);
      integer(range.start_sample, `semantic observation[${index}] start sample`);
      integer(range.end_sample, `semantic observation[${index}] end sample`);
      if ((range.end_sample as number) <= (range.start_sample as number)) {
        throw new Error(`semantic observation[${index}] played range must be non-empty`);
      }
    }
    sha256(candidate.asr_transcript_sha256, `semantic observation[${index}] ASR transcript hash`);
    sha256(candidate.alignment_sha256, `semantic observation[${index}] alignment hash`);
    if (candidate.required_act_observed !== null && typeof candidate.required_act_observed !== "boolean") {
      throw new Error(`semantic observation[${index}] required_act_observed must be boolean or null`);
    }
    if (!Array.isArray(candidate.violation_codes)) {
      throw new Error(`semantic observation[${index}] violation codes must be an array`);
    }
    const violations = new Set<string>();
    for (const code of candidate.violation_codes) {
      if (typeof code !== "string" || !SEMANTIC_VIOLATION_CODES_V2.includes(code as SemanticViolationCodeV2)) {
        throw new Error(`semantic observation[${index}] contains an unsupported violation code`);
      }
      if (violations.has(code)) throw new Error(`semantic observation[${index}] repeats violation ${code}`);
      violations.add(code);
    }
  }
  exactRecord(input.signature, SIGNATURE_KEYS, "sidecar signature");
  if (input.signature.algorithm !== "ed25519") throw new Error("sidecar signature algorithm is unsupported");
  safeId(input.signature.signer_id, "signature signer ID");
  if (!canonicalSignature(input.signature.signature_base64)) {
    throw new Error("sidecar signature is not a canonical Ed25519 signature");
  }
  return input as unknown as BlindSemanticSidecarV2;
}

export function verifyBlindSemanticSidecarV2(
  input: unknown,
  options: Readonly<{
    trust: BlindSemanticTrustV2;
    expected_raw_manifest_root_sha256: string;
    expected_opportunity_ids: readonly string[];
  }>,
): BlindSemanticSidecarVerificationV2 {
  const errors: Array<{ code: string; message: string }> = [];
  const parsed = parseInput(input);
  if (parsed.byteError) errors.push({ code: "noncanonical_or_invalid_bytes", message: parsed.byteError });
  let sidecar: BlindSemanticSidecarV2;
  try {
    sidecar = validateStructure(parsed.value);
    safeId(options.trust.signer_id, "trusted signer ID");
    safeId(options.trust.taxonomy_id, "trusted taxonomy ID");
    sha256(options.trust.taxonomy_sha256, "trusted taxonomy hash");
    sha256(options.trust.normalizer_sha256, "trusted normalizer hash");
    sha256(options.trust.asr_contract_sha256, "trusted ASR contract hash");
    sha256(options.expected_raw_manifest_root_sha256, "expected raw manifest root");
  } catch (error) {
    errors.push({ code: "invalid_structure", message: error instanceof Error ? error.message : "invalid sidecar" });
    return Object.freeze({ ok: false, errors: Object.freeze(errors.map((item) => Object.freeze(item))) });
  }
  if (sidecar.raw_manifest_root_sha256 !== options.expected_raw_manifest_root_sha256) {
    errors.push({ code: "cross_run_substitution", message: "sidecar raw-manifest binding does not match replay" });
  }
  if (sidecar.signer_id !== options.trust.signer_id || sidecar.signature.signer_id !== options.trust.signer_id) {
    errors.push({ code: "signer_substitution", message: "sidecar signer is not the frozen evaluator signer" });
  }
  if (sidecar.taxonomy_id !== options.trust.taxonomy_id || sidecar.taxonomy_sha256 !== options.trust.taxonomy_sha256) {
    errors.push({ code: "taxonomy_substitution", message: "sidecar taxonomy does not match the frozen taxonomy" });
  }
  if (sidecar.normalizer_sha256 !== options.trust.normalizer_sha256) {
    errors.push({ code: "normalizer_substitution", message: "sidecar normalizer does not match the frozen normalizer" });
  }
  if (sidecar.asr_contract_sha256 !== options.trust.asr_contract_sha256) {
    errors.push({ code: "asr_contract_substitution", message: "sidecar ASR contract does not match the frozen contract" });
  }
  const expectedIds = [...options.expected_opportunity_ids];
  const actualIds = sidecar.observations.map((observation) => observation.opportunity_id);
  if (new Set(expectedIds).size !== expectedIds.length || expectedIds.length === 0) {
    errors.push({ code: "invalid_expectation", message: "expected opportunity IDs must be unique and non-empty" });
  } else if (expectedIds.length !== actualIds.length || expectedIds.some((id, index) => id !== actualIds[index])) {
    errors.push({ code: "opportunity_contract_mismatch", message: "sidecar observations do not exactly match the frozen opportunity order" });
  }
  let publicKey: ReturnType<typeof createPublicKey> | null = null;
  try {
    publicKey = createPublicKey(options.trust.public_key_pem);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("trusted evaluator key must use Ed25519");
    if (publicKeyFingerprintV2(options.trust.public_key_pem) !== sidecar.signing_public_key_sha256) {
      errors.push({ code: "key_substitution", message: "sidecar public-key fingerprint does not match trust" });
    }
  } catch (error) {
    errors.push({ code: "invalid_trust_key", message: error instanceof Error ? error.message : "invalid trust key" });
  }
  const { sidecar_root_sha256: _root, signature: _signature, ...unsigned } = sidecar;
  void _root;
  void _signature;
  const recomputedRoot = blindSemanticSidecarRootV2(unsigned);
  if (recomputedRoot !== sidecar.sidecar_root_sha256) {
    errors.push({ code: "root_mismatch", message: "sidecar root does not match its contents" });
  }
  if (publicKey && !verify(
    null,
    Buffer.from(blindSemanticSidecarSignaturePayloadV2(sidecar.sidecar_root_sha256), "utf8"),
    publicKey,
    Buffer.from(sidecar.signature.signature_base64, "base64"),
  )) {
    errors.push({ code: "invalid_signature", message: "sidecar signature verification failed" });
  }
  if (errors.length > 0) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors.map((item) => Object.freeze(item))) });
  }
  return Object.freeze({ ok: true, sidecar: sidecar as VerifiedBlindSemanticSidecarV2 });
}
