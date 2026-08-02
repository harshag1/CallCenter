import { createPublicKey, verify } from "node:crypto";
import {
  canonicalEvidenceJsonV2,
  evidenceSha256HexV2,
  publicKeyFingerprintV2,
} from "../../../evidence-v2";
import { exactRecord, safeId, sha256, timestamp } from "../../../evidence-v2/validation";

const ROOT_DOMAIN = "hacc/claim-eligibility-receipt-v2/root/v2\n";
const SIGNATURE_DOMAIN = "hacc/claim-eligibility-receipt-v2/signature/v2\n";
const RECEIPT_KEYS = [
  "schema_version", "receipt_type", "receipt_id", "protocol_id", "endpoint_contract_id",
  "endpoint_contract_sha256", "endpoint_contract_example_only", "power_analysis_sha256",
  "prospective_power_passed", "corpus_id", "corpus_manifest_sha256",
  "confirmatory_corpus_eligible", "provider_allocations", "planned_pair_count", "issued_at",
  "preregistration_frozen_before_outcomes", "claim_artifacts_sha256",
  "signer_id", "signing_public_key_sha256", "receipt_root_sha256", "signature",
] as const;
const ALLOCATION_KEYS = ["provider", "pairs"] as const;
const SIGNATURE_KEYS = ["algorithm", "signer_id", "signature_base64"] as const;

export type ClaimEligibilityReceiptV2 = Readonly<{
  schema_version: 2;
  receipt_type: "hacc_claim_eligibility_receipt";
  receipt_id: string;
  protocol_id: string;
  endpoint_contract_id: string;
  endpoint_contract_sha256: string;
  endpoint_contract_example_only: false;
  power_analysis_sha256: string;
  prospective_power_passed: boolean;
  corpus_id: string;
  corpus_manifest_sha256: string;
  confirmatory_corpus_eligible: boolean;
  provider_allocations: readonly Readonly<{ provider: string; pairs: number }>[];
  planned_pair_count: number;
  issued_at: string;
  preregistration_frozen_before_outcomes: true;
  claim_artifacts_sha256: string;
  signer_id: string;
  signing_public_key_sha256: string;
  receipt_root_sha256: string;
  signature: Readonly<{
    algorithm: "ed25519";
    signer_id: string;
    signature_base64: string;
  }>;
}>;

export type ClaimEligibilityTrustV2 = Readonly<{ signer_id: string; public_key_pem: string }>;
declare const VERIFIED_RECEIPT: unique symbol;
export type VerifiedClaimEligibilityReceiptV2 = ClaimEligibilityReceiptV2 & {
  readonly [VERIFIED_RECEIPT]: true;
};
export type ClaimEligibilityVerificationV2 =
  | Readonly<{ ok: true; receipt: VerifiedClaimEligibilityReceiptV2 }>
  | Readonly<{ ok: false; errors: readonly Readonly<{ code: string; message: string }>[] }>;

type UnsignedReceipt = Omit<ClaimEligibilityReceiptV2, "receipt_root_sha256" | "signature">;

export function claimEligibilityReceiptRootV2(receipt: UnsignedReceipt): string {
  return evidenceSha256HexV2(`${ROOT_DOMAIN}${canonicalEvidenceJsonV2(receipt)}`);
}

export function claimEligibilityReceiptSignaturePayloadV2(rootSha256: string): string {
  sha256(rootSha256, "claim eligibility receipt root");
  return `${SIGNATURE_DOMAIN}${rootSha256}`;
}

function canonicalSignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === value;
}

function parseReceipt(input: unknown): ClaimEligibilityReceiptV2 {
  exactRecord(input, RECEIPT_KEYS, "claim eligibility receipt");
  if (input.schema_version !== 2 || input.receipt_type !== "hacc_claim_eligibility_receipt") {
    throw new Error("claim eligibility receipt has an unsupported schema or type");
  }
  safeId(input.receipt_id, "claim eligibility receipt ID");
  safeId(input.protocol_id, "claim eligibility protocol ID");
  safeId(input.endpoint_contract_id, "endpoint contract ID");
  sha256(input.endpoint_contract_sha256, "endpoint contract hash");
  if (input.endpoint_contract_example_only !== false) throw new Error("example endpoint contracts are not claim eligible");
  sha256(input.power_analysis_sha256, "power analysis hash");
  if (typeof input.prospective_power_passed !== "boolean") throw new Error("prospective power disposition must be boolean");
  safeId(input.corpus_id, "confirmatory corpus ID");
  sha256(input.corpus_manifest_sha256, "confirmatory corpus manifest hash");
  if (typeof input.confirmatory_corpus_eligible !== "boolean") throw new Error("corpus eligibility must be boolean");
  if (!Array.isArray(input.provider_allocations) || input.provider_allocations.length === 0) {
    throw new Error("provider allocations must be non-empty");
  }
  const providers = new Set<string>();
  let total = 0;
  for (const [index, allocation] of input.provider_allocations.entries()) {
    exactRecord(allocation, ALLOCATION_KEYS, `provider allocation[${index}]`);
    safeId(allocation.provider, `provider allocation[${index}] provider`);
    if (providers.has(allocation.provider)) throw new Error(`provider allocation repeats ${allocation.provider}`);
    providers.add(allocation.provider);
    if (!Number.isSafeInteger(allocation.pairs) || (allocation.pairs as number) <= 0) {
      throw new Error(`provider allocation[${index}] pairs must be a positive safe integer`);
    }
    total += allocation.pairs as number;
  }
  if (!Number.isSafeInteger(input.planned_pair_count) || (input.planned_pair_count as number) <= 0) {
    throw new Error("planned pair count must be a positive safe integer");
  }
  if (total !== input.planned_pair_count) throw new Error("provider allocations do not sum to planned pair count");
  timestamp(input.issued_at, "claim eligibility receipt issue time");
  if (input.preregistration_frozen_before_outcomes !== true) {
    throw new Error("endpoint, power, and corpus preregistration must be frozen before outcomes open");
  }
  sha256(input.claim_artifacts_sha256, "confirmatory claim artifacts hash");
  safeId(input.signer_id, "claim eligibility signer ID");
  sha256(input.signing_public_key_sha256, "claim eligibility public-key fingerprint");
  sha256(input.receipt_root_sha256, "claim eligibility receipt root");
  exactRecord(input.signature, SIGNATURE_KEYS, "claim eligibility signature");
  if (input.signature.algorithm !== "ed25519") throw new Error("claim eligibility signature must use Ed25519");
  safeId(input.signature.signer_id, "claim eligibility signature signer ID");
  if (!canonicalSignature(input.signature.signature_base64)) throw new Error("claim eligibility signature is not canonical Ed25519");
  return input as unknown as ClaimEligibilityReceiptV2;
}

export function verifyClaimEligibilityReceiptV2(
  input: unknown,
  options: Readonly<{ trust: ClaimEligibilityTrustV2; expected_protocol_id: string }>,
): ClaimEligibilityVerificationV2 {
  const errors: Array<{ code: string; message: string }> = [];
  let receipt: ClaimEligibilityReceiptV2;
  try {
    receipt = parseReceipt(input);
    safeId(options.trust.signer_id, "trusted claim eligibility signer ID");
    safeId(options.expected_protocol_id, "expected claim protocol ID");
  } catch (error) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze([Object.freeze({ code: "invalid_structure", message: error instanceof Error ? error.message : "invalid receipt" })]),
    });
  }
  if (receipt.protocol_id !== options.expected_protocol_id) errors.push({ code: "protocol_substitution", message: "receipt protocol does not match report" });
  if (receipt.signer_id !== options.trust.signer_id || receipt.signature.signer_id !== options.trust.signer_id) {
    errors.push({ code: "signer_substitution", message: "receipt signer does not match frozen trust" });
  }
  let publicKey: ReturnType<typeof createPublicKey> | null = null;
  try {
    publicKey = createPublicKey(options.trust.public_key_pem);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("claim eligibility key must use Ed25519");
    if (publicKeyFingerprintV2(options.trust.public_key_pem) !== receipt.signing_public_key_sha256) {
      errors.push({ code: "key_substitution", message: "receipt key fingerprint does not match trust" });
    }
  } catch (error) {
    errors.push({ code: "invalid_trust_key", message: error instanceof Error ? error.message : "invalid trust key" });
  }
  const { receipt_root_sha256: _root, signature: _signature, ...unsigned } = receipt;
  void _root; void _signature;
  const root = claimEligibilityReceiptRootV2(unsigned);
  if (root !== receipt.receipt_root_sha256) errors.push({ code: "root_mismatch", message: "receipt root does not match contents" });
  if (publicKey && !verify(
    null,
    Buffer.from(claimEligibilityReceiptSignaturePayloadV2(receipt.receipt_root_sha256), "utf8"),
    publicKey,
    Buffer.from(receipt.signature.signature_base64, "base64"),
  )) errors.push({ code: "invalid_signature", message: "claim eligibility signature verification failed" });
  return errors.length === 0
    ? Object.freeze({ ok: true, receipt: receipt as VerifiedClaimEligibilityReceiptV2 })
    : Object.freeze({ ok: false, errors: Object.freeze(errors.map((item) => Object.freeze(item))) });
}
