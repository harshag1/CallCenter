import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  canonicalJson,
  immutableJson,
  sha256Hex,
  type ArtifactDescriptor,
} from "./artifacts";
import type { ServerRealtimeProvider } from "../realtime/client/types";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const PACKET_HASH_DOMAIN = "hacc/provider-transport-evidence-packet/v1\n";
const PACKET_SIGNATURE_DOMAIN = "hacc/provider-transport-evidence-packet-signature/v1\n";
const EVIDENCE_DESCRIPTOR_DOMAIN = "hacc/provider-transport-evidence-descriptor/v1\n";

const ROOT_KEYS = Object.freeze([
  "schema_version",
  "packet_type",
  "bindings",
  "packet_sha256",
  "signature",
].sort());
const BINDING_KEYS = Object.freeze([
  "plan_sha256",
  "freeze_lock_sha256",
  "provider",
  "model",
  "run_id",
  "pair_id",
  "provider_evidence_descriptor",
  "provider_evidence_descriptor_sha256",
  "wire_chain_head_sha256",
  "usage_observations_sha256",
  "input_audio_manifest_sha256",
  "output_audio_manifest_sha256",
  "artifact_manifest_sha256",
  "read_only_receipt_linkage_sha256",
  "kernel_attestation_hash",
  "kernel_transcript_sha256",
  "signing_key_id",
  "signing_public_key_sha256",
].sort());
const DESCRIPTOR_KEYS = Object.freeze([
  "path",
  "media_type",
  "byte_length",
  "sha256",
].sort());
const SIGNATURE_KEYS = Object.freeze([
  "algorithm",
  "key_id",
  "signature_base64",
].sort());
const TRUST_KEYS = Object.freeze([
  "keyId",
  "publicKeySha256",
  "publicKeyPem",
].sort());

export type ProviderTransportPacketSubject = Readonly<{
  plan_sha256: string;
  freeze_lock_sha256: string;
  provider: ServerRealtimeProvider;
  model: string;
  run_id: string;
  pair_id: string;
  provider_evidence_descriptor: ArtifactDescriptor;
  provider_evidence_descriptor_sha256: string;
  wire_chain_head_sha256: string;
  usage_observations_sha256: string;
  input_audio_manifest_sha256: string;
  output_audio_manifest_sha256: string;
  artifact_manifest_sha256: string;
  read_only_receipt_linkage_sha256: string;
  kernel_attestation_hash: string;
  kernel_transcript_sha256: string;
}>;

export type ProviderTransportPacketSigner = Readonly<{
  algorithm: "ed25519";
  keyId: string;
  publicKeySha256: string;
  sign(payload: string): string;
}>;

export type ProviderTransportPacketTrust = Readonly<{
  keyId: string;
  publicKeySha256: string;
  publicKeyPem: string;
}>;

export type ProviderTransportPacketBindings = ProviderTransportPacketSubject & Readonly<{
  signing_key_id: string;
  signing_public_key_sha256: string;
}>;

export type ProviderTransportPacket = Readonly<{
  schema_version: 1;
  packet_type: "provider_transport_evidence";
  bindings: ProviderTransportPacketBindings;
  packet_sha256: string;
  signature: Readonly<{
    algorithm: "ed25519";
    key_id: string;
    signature_base64: string;
  }>;
}>;

export type ProviderTransportPacketVerification = Readonly<{
  valid: boolean;
  expected_packet_sha256: string | null;
  signature_verified: boolean;
  errors: readonly string[];
}>;

type UnsignedProviderTransportPacket = Readonly<{
  schema_version: 1;
  packet_type: "provider_transport_evidence";
  bindings: ProviderTransportPacketBindings;
}>;

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  record(value, label);
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}

function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function safeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe identifier`);
  }
}

function nonEmpty(value: unknown, label: string, maximum = 512): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
}

function normalizedArtifactPath(value: unknown, label: string): asserts value is string {
  nonEmpty(value, label, 1_024);
  if (
    value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a normalized relative POSIX path`);
  }
}

function canonicalSignature(value: unknown, label: string): asserts value is string {
  nonEmpty(value, label, 1_024);
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== 64 || bytes.toString("base64") !== value) {
    throw new Error(`${label} must be one canonical 64-byte Ed25519 signature`);
  }
}

function parseDescriptor(value: unknown): ArtifactDescriptor {
  exactKeys(value, DESCRIPTOR_KEYS, "provider evidence descriptor");
  normalizedArtifactPath(value.path, "provider evidence descriptor path");
  nonEmpty(value.media_type, "provider evidence descriptor media type", 256);
  if (
    !Number.isSafeInteger(value.byte_length)
    || (value.byte_length as number) < 1
  ) {
    throw new Error("provider evidence descriptor byte length must be a positive safe integer");
  }
  sha256(value.sha256, "provider evidence content hash");
  return immutableJson(value) as unknown as ArtifactDescriptor;
}

export function providerTransportEvidenceDescriptorSha256(
  descriptorInput: ArtifactDescriptor,
): string {
  const descriptor = parseDescriptor(immutableJson(descriptorInput));
  return sha256Hex(`${EVIDENCE_DESCRIPTOR_DOMAIN}${canonicalJson(descriptor)}`);
}

function parseSubject(value: unknown): ProviderTransportPacketSubject {
  exactKeys(value, BINDING_KEYS.filter((key) => !key.startsWith("signing_")), "provider transport packet subject");
  sha256(value.plan_sha256, "provider transport plan hash");
  sha256(value.freeze_lock_sha256, "provider transport freeze-lock hash");
  if (value.provider !== "openai" && value.provider !== "xai" && value.provider !== "gemini") {
    throw new Error("provider transport provider is invalid");
  }
  nonEmpty(value.model, "provider transport model", 512);
  safeId(value.run_id, "provider transport run ID");
  safeId(value.pair_id, "provider transport pair ID");
  const descriptor = parseDescriptor(value.provider_evidence_descriptor);
  sha256(value.provider_evidence_descriptor_sha256, "provider evidence descriptor hash");
  const expectedDescriptorHash = providerTransportEvidenceDescriptorSha256(descriptor);
  if (value.provider_evidence_descriptor_sha256 !== expectedDescriptorHash) {
    throw new Error("provider evidence descriptor hash does not match its descriptor");
  }
  sha256(value.wire_chain_head_sha256, "provider wire-chain head");
  sha256(value.usage_observations_sha256, "provider usage-observation hash");
  sha256(value.input_audio_manifest_sha256, "provider input-audio manifest hash");
  sha256(value.output_audio_manifest_sha256, "provider output-audio manifest hash");
  sha256(value.artifact_manifest_sha256, "provider artifact-manifest hash");
  sha256(value.read_only_receipt_linkage_sha256, "provider read-only receipt linkage hash");
  sha256(value.kernel_attestation_hash, "provider kernel attestation hash");
  sha256(value.kernel_transcript_sha256, "provider kernel transcript hash");
  return immutableJson({
    plan_sha256: value.plan_sha256,
    freeze_lock_sha256: value.freeze_lock_sha256,
    provider: value.provider,
    model: value.model,
    run_id: value.run_id,
    pair_id: value.pair_id,
    provider_evidence_descriptor: descriptor,
    provider_evidence_descriptor_sha256: value.provider_evidence_descriptor_sha256,
    wire_chain_head_sha256: value.wire_chain_head_sha256,
    usage_observations_sha256: value.usage_observations_sha256,
    input_audio_manifest_sha256: value.input_audio_manifest_sha256,
    output_audio_manifest_sha256: value.output_audio_manifest_sha256,
    artifact_manifest_sha256: value.artifact_manifest_sha256,
    read_only_receipt_linkage_sha256: value.read_only_receipt_linkage_sha256,
    kernel_attestation_hash: value.kernel_attestation_hash,
    kernel_transcript_sha256: value.kernel_transcript_sha256,
  }) as unknown as ProviderTransportPacketSubject;
}

function parseBindings(value: unknown): ProviderTransportPacketBindings {
  exactKeys(value, BINDING_KEYS, "provider transport packet bindings");
  const subjectObject = Object.fromEntries(
    Object.entries(value).filter(([key]) => !key.startsWith("signing_")),
  );
  const subject = parseSubject(subjectObject);
  safeId(value.signing_key_id, "provider transport signing key ID");
  sha256(value.signing_public_key_sha256, "provider transport signing public-key fingerprint");
  return immutableJson({
    ...subject,
    signing_key_id: value.signing_key_id,
    signing_public_key_sha256: value.signing_public_key_sha256,
  }) as unknown as ProviderTransportPacketBindings;
}

export function providerTransportPacketPublicKeyFingerprint(publicKeyPem: string): string {
  if (
    typeof publicKeyPem !== "string"
    || publicKeyPem.trim().length === 0
    || publicKeyPem.length > 64 * 1_024
    || publicKeyPem.includes("\0")
  ) {
    throw new Error("provider transport public key must be non-empty PEM under 64 KiB");
  }
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("provider transport public key must be Ed25519");
  }
  const canonicalPem = key.export({ type: "spki", format: "pem" }).toString();
  if (canonicalPem !== publicKeyPem) {
    throw new Error("provider transport public key must be canonical SPKI PEM");
  }
  return sha256Hex(new Uint8Array(key.export({ type: "spki", format: "der" })));
}

function validatedTrust(value: unknown): Readonly<{
  trust: ProviderTransportPacketTrust;
  publicKey: ReturnType<typeof createPublicKey>;
}> {
  exactKeys(value, TRUST_KEYS, "plan-pinned provider transport trust");
  safeId(value.keyId, "plan-pinned provider transport key ID");
  sha256(value.publicKeySha256, "plan-pinned provider transport public-key fingerprint");
  if (typeof value.publicKeyPem !== "string") {
    throw new Error("plan-pinned provider transport public key must be PEM");
  }
  const fingerprint = providerTransportPacketPublicKeyFingerprint(value.publicKeyPem);
  if (fingerprint !== value.publicKeySha256) {
    throw new Error("plan-pinned provider transport public-key fingerprint mismatch");
  }
  return Object.freeze({
    trust: Object.freeze({
      keyId: value.keyId,
      publicKeySha256: value.publicKeySha256,
      publicKeyPem: value.publicKeyPem,
    }),
    publicKey: createPublicKey(value.publicKeyPem),
  });
}

export function createProviderTransportPacketSigner(input: Readonly<{
  keyId: string;
  privateKeyPem: string;
  publicKeyPem?: string;
}>): ProviderTransportPacketSigner {
  safeId(input.keyId, "provider transport signing key ID");
  if (
    typeof input.privateKeyPem !== "string"
    || input.privateKeyPem.trim().length === 0
    || input.privateKeyPem.length > 64 * 1_024
    || input.privateKeyPem.includes("\0")
  ) {
    throw new Error("provider transport private key must be non-empty PEM under 64 KiB");
  }
  const privateKey = createPrivateKey(input.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("provider transport private key must be Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeySha256 = sha256Hex(new Uint8Array(
    publicKey.export({ type: "spki", format: "der" }),
  ));
  if (
    input.publicKeyPem !== undefined
    && providerTransportPacketPublicKeyFingerprint(input.publicKeyPem) !== publicKeySha256
  ) {
    throw new Error("provider transport public key does not match the private signing key");
  }
  return Object.freeze({
    algorithm: "ed25519" as const,
    keyId: input.keyId,
    publicKeySha256,
    sign(payload: string): string {
      return signBytes(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
    },
  });
}

function unsignedBody(
  packet: UnsignedProviderTransportPacket | ProviderTransportPacket,
): UnsignedProviderTransportPacket {
  return Object.freeze({
    schema_version: packet.schema_version,
    packet_type: packet.packet_type,
    bindings: packet.bindings,
  });
}

export function providerTransportPacketSha256(
  packet: UnsignedProviderTransportPacket | ProviderTransportPacket,
): string {
  return sha256Hex(`${PACKET_HASH_DOMAIN}${canonicalJson(unsignedBody(packet))}`);
}

export function createProviderTransportPacket(input: Readonly<{
  subject: ProviderTransportPacketSubject;
  signer: ProviderTransportPacketSigner;
  planPinnedTrust: ProviderTransportPacketTrust;
}>): ProviderTransportPacket {
  const subject = parseSubject(immutableJson(input.subject));
  const trusted = validatedTrust(immutableJson(input.planPinnedTrust));
  if (input.signer.algorithm !== "ed25519") {
    throw new Error("provider transport signer must use Ed25519");
  }
  safeId(input.signer.keyId, "provider transport signer key ID");
  sha256(input.signer.publicKeySha256, "provider transport signer public-key fingerprint");
  if (
    input.signer.keyId !== trusted.trust.keyId
    || input.signer.publicKeySha256 !== trusted.trust.publicKeySha256
  ) {
    throw new Error("provider transport signer differs from the plan-pinned trust root");
  }
  const unsigned = Object.freeze({
    schema_version: 1 as const,
    packet_type: "provider_transport_evidence" as const,
    bindings: Object.freeze({
      ...subject,
      signing_key_id: trusted.trust.keyId,
      signing_public_key_sha256: trusted.trust.publicKeySha256,
    }),
  });
  const packetSha256 = providerTransportPacketSha256(unsigned);
  const signatureBase64 = input.signer.sign(`${PACKET_SIGNATURE_DOMAIN}${packetSha256}`);
  canonicalSignature(signatureBase64, "provider transport packet signature");
  if (!verifyBytes(
    null,
    Buffer.from(`${PACKET_SIGNATURE_DOMAIN}${packetSha256}`, "utf8"),
    trusted.publicKey,
    Buffer.from(signatureBase64, "base64"),
  )) {
    throw new Error("provider transport signer did not produce a signature valid under plan-pinned trust");
  }
  return immutableJson({
    ...unsigned,
    packet_sha256: packetSha256,
    signature: {
      algorithm: "ed25519",
      key_id: trusted.trust.keyId,
      signature_base64: signatureBase64,
    },
  }) as unknown as ProviderTransportPacket;
}

function parsePacket(value: unknown): ProviderTransportPacket {
  exactKeys(value, ROOT_KEYS, "provider transport packet");
  if (value.schema_version !== 1 || value.packet_type !== "provider_transport_evidence") {
    throw new Error("provider transport packet has an unsupported schema or type");
  }
  const bindings = parseBindings(value.bindings);
  sha256(value.packet_sha256, "provider transport packet hash");
  exactKeys(value.signature, SIGNATURE_KEYS, "provider transport packet signature");
  if (value.signature.algorithm !== "ed25519") {
    throw new Error("provider transport packet signature algorithm is invalid");
  }
  safeId(value.signature.key_id, "provider transport packet signature key ID");
  canonicalSignature(value.signature.signature_base64, "provider transport packet signature");
  if (value.signature.key_id !== bindings.signing_key_id) {
    throw new Error("provider transport signature key differs from its signed binding");
  }
  return immutableJson({
    schema_version: 1,
    packet_type: "provider_transport_evidence",
    bindings,
    packet_sha256: value.packet_sha256,
    signature: value.signature,
  }) as unknown as ProviderTransportPacket;
}

export function verifyProviderTransportPacket(input: Readonly<{
  packet: unknown;
  expectedSubject: ProviderTransportPacketSubject;
  planPinnedTrust: ProviderTransportPacketTrust;
}>): ProviderTransportPacketVerification {
  const errors: string[] = [];
  let expectedPacketSha256: string | null = null;
  let signatureVerified = false;
  try {
    const packet = parsePacket(immutableJson(input.packet));
    const subject = parseSubject(immutableJson(input.expectedSubject));
    const trusted = validatedTrust(immutableJson(input.planPinnedTrust));
    const expectedBindings = immutableJson({
      ...subject,
      signing_key_id: trusted.trust.keyId,
      signing_public_key_sha256: trusted.trust.publicKeySha256,
    });
    if (canonicalJson(packet.bindings) !== canonicalJson(expectedBindings)) {
      errors.push("provider transport packet bindings differ from the expected plan and artifacts");
    }
    expectedPacketSha256 = providerTransportPacketSha256(packet);
    if (packet.packet_sha256 !== expectedPacketSha256) {
      errors.push("provider transport packet hash mismatch");
    }
    if (
      packet.bindings.signing_key_id !== trusted.trust.keyId
      || packet.bindings.signing_public_key_sha256 !== trusted.trust.publicKeySha256
      || packet.signature.key_id !== trusted.trust.keyId
    ) {
      errors.push("provider transport signing identity differs from plan-pinned trust");
    } else {
      signatureVerified = verifyBytes(
        null,
        Buffer.from(`${PACKET_SIGNATURE_DOMAIN}${packet.packet_sha256}`, "utf8"),
        trusted.publicKey,
        Buffer.from(packet.signature.signature_base64, "base64"),
      );
      if (!signatureVerified) {
        errors.push("provider transport packet signature verification failed");
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "provider transport packet is invalid");
  }
  return Object.freeze({
    valid: errors.length === 0,
    expected_packet_sha256: expectedPacketSha256,
    signature_verified: signatureVerified,
    errors: Object.freeze(errors),
  });
}

export function serializeProviderTransportPacket(packet: ProviderTransportPacket): string {
  const parsed = parsePacket(immutableJson(packet));
  if (parsed.packet_sha256 !== providerTransportPacketSha256(parsed)) {
    throw new Error("cannot serialize a provider transport packet with an invalid hash");
  }
  return `${canonicalJson(parsed)}\n`;
}
