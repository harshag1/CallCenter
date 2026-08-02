import {
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import { canonicalJson, immutableJson, sha256Hex } from "../../artifacts";
import type {
  HarnessTreatmentManifest,
  SignedHarnessTreatment,
  TreatmentExecutionBinding,
  TreatmentId,
  TreatmentSigningAuthority,
  TreatmentSwitches,
  TreatmentVerificationAuthority,
} from "./types";

const MANIFEST_DOMAIN = "harshas-amazing-call-center/benchmark-v2/harness-treatment/v1\n";
const SIGNATURE_DOMAIN = "harshas-amazing-call-center/benchmark-v2/harness-treatment-signature/v1\n";
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IMPLEMENTATION_KEYS = Object.freeze([
  "condition_compiler_sha256", "context_delivery_sha256", "state_authority_sha256",
  "capability_disclosure_sha256", "effect_admission_sha256", "effect_evidence_sha256",
  "asynchronous_work_sha256", "repair_control_sha256", "speech_release_sha256",
].sort());

const NATIVE_SWITCHES: TreatmentSwitches = Object.freeze({
  context_delivery: "chronological_provider_history",
  state_authority: "provider_session",
  capability_disclosure: "complete_registered_catalog",
  effect_admission: "shared_gateway_schema",
  effect_evidence: "provider_acknowledgement",
  asynchronous_work: "provider_inline",
  repair_control: "provider_default",
  speech_release: "provider_output",
});

const HACC_SWITCHES: TreatmentSwitches = Object.freeze({
  context_delivery: "compiled_turn_contract",
  state_authority: "hacc_event_log",
  capability_disclosure: "scoped_capability_frontier",
  effect_admission: "revision_bound_policy_lease",
  effect_evidence: "authoritative_effect_receipt",
  asynchronous_work: "durable_revision_bound_worker",
  repair_control: "deterministic_reconciliation",
  speech_release: "claim_grant_and_playback_ledger",
});

const DEFINITIONS: Readonly<Record<TreatmentId, Readonly<{
  arm: "native" | "hacc";
  confirmatory_eligible: boolean;
  intervention_family: "registered_native" | "hacc";
  switches: TreatmentSwitches;
}>>> = Object.freeze({
  registered_native: Object.freeze({
    arm: "native",
    confirmatory_eligible: true,
    intervention_family: "registered_native",
    switches: NATIVE_SWITCHES,
  }),
  full_hacc: Object.freeze({
    arm: "hacc",
    confirmatory_eligible: true,
    intervention_family: "hacc",
    switches: HACC_SWITCHES,
  }),
  hacc_without_context_compiler: Object.freeze({
    arm: "hacc",
    confirmatory_eligible: false,
    intervention_family: "hacc",
    switches: Object.freeze({
      ...HACC_SWITCHES,
      context_delivery: "chronological_provider_history",
    }),
  }),
  hacc_without_capability_scoping: Object.freeze({
    arm: "hacc",
    confirmatory_eligible: false,
    intervention_family: "hacc",
    switches: Object.freeze({
      ...HACC_SWITCHES,
      capability_disclosure: "complete_registered_catalog",
    }),
  }),
  hacc_without_effect_receipts: Object.freeze({
    arm: "hacc",
    confirmatory_eligible: false,
    intervention_family: "hacc",
    switches: Object.freeze({
      ...HACC_SWITCHES,
      effect_evidence: "provider_acknowledgement",
    }),
  }),
});

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(sortedExpected)) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function publicKeyObject(key: TreatmentSigningAuthority["private_key"] | TreatmentVerificationAuthority["public_key"]): KeyObject {
  if (key instanceof KeyObject && key.type === "public") return key;
  return createPublicKey(key);
}

export function treatmentAuthorityFingerprint(publicKey: TreatmentVerificationAuthority["public_key"]): string {
  const der = publicKeyObject(publicKey).export({ type: "spki", format: "der" });
  return sha256Hex(der);
}

function manifestDigest(body: Omit<HarnessTreatmentManifest, "manifest_sha256">): string {
  return sha256Hex(`${MANIFEST_DOMAIN}${canonicalJson(body)}`);
}

export function createHarnessTreatmentManifest(treatmentId: TreatmentId): HarnessTreatmentManifest {
  const definition = DEFINITIONS[treatmentId];
  if (!definition) throw new Error(`unknown benchmark treatment: ${String(treatmentId)}`);
  const body = immutableJson({
    schema_version: 1,
    treatment_id: treatmentId,
    arm: definition.arm,
    confirmatory_eligible: definition.confirmatory_eligible,
    intervention_family: definition.intervention_family,
    switches: definition.switches,
  }) as unknown as Omit<HarnessTreatmentManifest, "manifest_sha256">;
  return immutableJson({ ...body, manifest_sha256: manifestDigest(body) }) as unknown as HarnessTreatmentManifest;
}

export function assertHarnessTreatmentManifest(value: unknown): asserts value is HarnessTreatmentManifest {
  assertExactKeys(value, [
    "schema_version", "treatment_id", "arm", "confirmatory_eligible",
    "intervention_family", "switches", "manifest_sha256",
  ], "treatment manifest");
  const manifest = value as unknown as HarnessTreatmentManifest;
  if (!SHA256.test(manifest.manifest_sha256)) throw new Error("treatment manifest digest is invalid");
  const expected = createHarnessTreatmentManifest(manifest.treatment_id);
  if (canonicalJson(manifest) !== canonicalJson(expected)) {
    throw new Error("treatment manifest is not an exact registered treatment definition");
  }
}

function assertExecutionBinding(value: unknown): asserts value is TreatmentExecutionBinding {
  assertExactKeys(value, ["schema_version", "shared_semantics_sha256", "runtime_implementation"], "treatment execution binding");
  const binding = value as unknown as TreatmentExecutionBinding;
  if (binding.schema_version !== 1 || !SHA256.test(binding.shared_semantics_sha256)) {
    throw new Error("treatment execution binding is invalid");
  }
  assertExactKeys(binding.runtime_implementation, IMPLEMENTATION_KEYS, "treatment runtime implementation");
  for (const [name, digest] of Object.entries(binding.runtime_implementation)) {
    if (!SHA256.test(digest)) throw new Error(`treatment runtime implementation ${name} is invalid`);
  }
}

function signaturePayload(manifest: HarnessTreatmentManifest, binding: TreatmentExecutionBinding): Buffer {
  return Buffer.from(`${SIGNATURE_DOMAIN}${canonicalJson({ manifest, execution_binding: binding })}`, "utf8");
}

export function signHarnessTreatment(
  manifest: HarnessTreatmentManifest,
  executionBinding: TreatmentExecutionBinding,
  authority: TreatmentSigningAuthority,
): SignedHarnessTreatment {
  assertHarnessTreatmentManifest(manifest);
  assertExecutionBinding(executionBinding);
  if (!authority.key_id || authority.key_id.trim() !== authority.key_id || authority.key_id.length > 128) {
    throw new Error("treatment signing key_id must be a canonical non-empty string");
  }
  const publicKey = publicKeyObject(authority.private_key);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("treatment signing key must be Ed25519");
  const binding = immutableJson(executionBinding) as unknown as TreatmentExecutionBinding;
  const payload = signaturePayload(manifest, binding);
  const signature = sign(null, payload, authority.private_key).toString("base64");
  return immutableJson({
    manifest,
    execution_binding: binding,
    signature: {
      schema_version: 1,
      algorithm: "ed25519",
      key_id: authority.key_id,
      public_key_fingerprint_sha256: treatmentAuthorityFingerprint(publicKey),
      signed_payload_sha256: sha256Hex(payload),
      signature_base64: signature,
    },
  }) as unknown as SignedHarnessTreatment;
}

export function verifySignedHarnessTreatment(
  signed: SignedHarnessTreatment,
  authority: TreatmentVerificationAuthority,
): void {
  assertExactKeys(signed, ["manifest", "execution_binding", "signature"], "signed treatment");
  assertHarnessTreatmentManifest(signed.manifest);
  assertExecutionBinding(signed.execution_binding);
  assertExactKeys(signed.signature, [
    "schema_version", "algorithm", "key_id", "public_key_fingerprint_sha256",
    "signed_payload_sha256", "signature_base64",
  ], "treatment signature");
  if (signed.signature.schema_version !== 1 || signed.signature.algorithm !== "ed25519") {
    throw new Error("unsupported treatment signature contract");
  }
  if (signed.signature.key_id !== authority.key_id) throw new Error("treatment signing authority key_id mismatch");
  const publicKey = publicKeyObject(authority.public_key);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("treatment verification key must be Ed25519");
  const fingerprint = treatmentAuthorityFingerprint(publicKey);
  if (signed.signature.public_key_fingerprint_sha256 !== fingerprint) {
    throw new Error("treatment signing authority fingerprint mismatch");
  }
  const payload = signaturePayload(signed.manifest, signed.execution_binding);
  if (signed.signature.signed_payload_sha256 !== sha256Hex(payload)) {
    throw new Error("treatment signed payload digest mismatch");
  }
  if (!BASE64.test(signed.signature.signature_base64)) throw new Error("treatment signature is not canonical base64");
  const bytes = Buffer.from(signed.signature.signature_base64, "base64");
  if (bytes.toString("base64") !== signed.signature.signature_base64) {
    throw new Error("treatment signature is not canonical base64");
  }
  if (!verify(null, payload, publicKey, bytes)) throw new Error("treatment signature verification failed");
}

export function isConfirmatoryTreatment(treatment: HarnessTreatmentManifest): boolean {
  assertHarnessTreatmentManifest(treatment);
  return treatment.confirmatory_eligible;
}

export const REGISTERED_TREATMENT_IDS = Object.freeze(Object.keys(DEFINITIONS).sort()) as readonly TreatmentId[];
