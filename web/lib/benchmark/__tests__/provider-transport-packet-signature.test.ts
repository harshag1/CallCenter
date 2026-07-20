import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, createArtifactDescriptor } from "../artifacts";
import {
  createProviderTransportPacket,
  createProviderTransportPacketSigner,
  providerTransportEvidenceDescriptorSha256,
  providerTransportPacketPublicKeyFingerprint,
  providerTransportPacketSha256,
  serializeProviderTransportPacket,
  verifyProviderTransportPacket,
  type ProviderTransportPacket,
  type ProviderTransportPacketSubject,
  type ProviderTransportPacketTrust,
} from "../provider-transport-packet-signature";

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

function mutable<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function signingIdentity(keyId = "provider-transport-test-v1") {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createProviderTransportPacketSigner({
    keyId,
    privateKeyPem,
    publicKeyPem,
  });
  const trust: ProviderTransportPacketTrust = Object.freeze({
    keyId,
    publicKeySha256: providerTransportPacketPublicKeyFingerprint(publicKeyPem),
    publicKeyPem,
  });
  return { privateKeyPem, publicKeyPem, signer, trust };
}

function subject(): ProviderTransportPacketSubject {
  const providerEvidence = createArtifactDescriptor(
    "provider/provider-transport-evidence.json",
    "{\"schema_version\":1}\n",
    "application/json",
  );
  return Object.freeze({
    plan_sha256: "1".repeat(64),
    freeze_lock_sha256: "2".repeat(64),
    provider: "openai" as const,
    model: "gpt-realtime-2.1-2026-07-01",
    run_id: "run-provider-packet-001",
    pair_id: "pair-provider-packet-001",
    provider_evidence_descriptor: providerEvidence,
    provider_evidence_descriptor_sha256: providerTransportEvidenceDescriptorSha256(providerEvidence),
    wire_chain_head_sha256: "3".repeat(64),
    usage_observations_sha256: "4".repeat(64),
    input_audio_manifest_sha256: "5".repeat(64),
    output_audio_manifest_sha256: "6".repeat(64),
    artifact_manifest_sha256: "7".repeat(64),
    read_only_receipt_linkage_sha256: "8".repeat(64),
    kernel_attestation_hash: "9".repeat(64),
    kernel_transcript_sha256: "a".repeat(64),
  });
}

function signed() {
  const identity = signingIdentity();
  const expectedSubject = subject();
  const packet = createProviderTransportPacket({
    subject: expectedSubject,
    signer: identity.signer,
    planPinnedTrust: identity.trust,
  });
  return { ...identity, expectedSubject, packet };
}

describe("provider transport packet signatures", () => {
  it("creates a canonical immutable Ed25519 packet under plan-pinned trust", () => {
    const { packet, expectedSubject, trust } = signed();
    const verification = verifyProviderTransportPacket({
      packet,
      expectedSubject,
      planPinnedTrust: trust,
    });

    expect(verification).toEqual({
      valid: true,
      expected_packet_sha256: packet.packet_sha256,
      signature_verified: true,
      errors: [],
    });
    expect(packet.packet_sha256).toBe(providerTransportPacketSha256(packet));
    expect(Object.isFrozen(packet)).toBe(true);
    expect(Object.isFrozen(packet.bindings)).toBe(true);
    expect(Object.isFrozen(packet.bindings.provider_evidence_descriptor)).toBe(true);
    expect(serializeProviderTransportPacket(packet)).toBe(`${canonicalJson(packet)}\n`);
  });

  it.each([
    ["plan_sha256", "8".repeat(64)],
    ["freeze_lock_sha256", "8".repeat(64)],
    ["provider", "xai"],
    ["model", "grok-voice-think-fast-1.0"],
    ["run_id", "run-provider-packet-substituted"],
    ["pair_id", "pair-provider-packet-substituted"],
    ["wire_chain_head_sha256", "8".repeat(64)],
    ["usage_observations_sha256", "8".repeat(64)],
    ["input_audio_manifest_sha256", "8".repeat(64)],
    ["output_audio_manifest_sha256", "8".repeat(64)],
    ["artifact_manifest_sha256", "8".repeat(64)],
  ] as const)("rejects a rehashed %s substitution without a new trusted signature", (field, replacement) => {
    const { packet, expectedSubject, trust } = signed();
    const attacked = mutable(packet);
    (attacked.bindings as Record<string, unknown>)[field] = replacement;
    attacked.packet_sha256 = providerTransportPacketSha256(attacked as ProviderTransportPacket);

    const verification = verifyProviderTransportPacket({
      packet: attacked,
      expectedSubject,
      planPinnedTrust: trust,
    });
    expect(verification.valid).toBe(false);
    expect(verification.signature_verified).toBe(false);
    expect(verification.errors).toContain(
      "provider transport packet bindings differ from the expected plan and artifacts",
    );
    expect(verification.errors).toContain(
      "provider transport packet signature verification failed",
    );
  });

  it("binds the full provider evidence descriptor and its domain-separated digest", () => {
    const { packet, expectedSubject, trust } = signed();
    const attacked = mutable(packet);
    attacked.bindings.provider_evidence_descriptor.byte_length += 1;
    attacked.bindings.provider_evidence_descriptor_sha256 =
      providerTransportEvidenceDescriptorSha256(attacked.bindings.provider_evidence_descriptor);
    attacked.packet_sha256 = providerTransportPacketSha256(attacked as ProviderTransportPacket);

    const verification = verifyProviderTransportPacket({
      packet: attacked,
      expectedSubject,
      planPinnedTrust: trust,
    });
    expect(verification.valid).toBe(false);
    expect(verification.signature_verified).toBe(false);
    expect(verification.errors).toContain(
      "provider transport packet bindings differ from the expected plan and artifacts",
    );
  });

  it("rejects descriptor-content substitution and a forged descriptor digest", () => {
    const { packet, expectedSubject, trust } = signed();
    const contentAttack = mutable(packet);
    contentAttack.bindings.provider_evidence_descriptor.sha256 = "8".repeat(64);
    contentAttack.bindings.provider_evidence_descriptor_sha256 =
      providerTransportEvidenceDescriptorSha256(contentAttack.bindings.provider_evidence_descriptor);
    contentAttack.packet_sha256 = providerTransportPacketSha256(contentAttack as ProviderTransportPacket);
    expect(verifyProviderTransportPacket({
      packet: contentAttack,
      expectedSubject,
      planPinnedTrust: trust,
    })).toMatchObject({ valid: false, signature_verified: false });

    const digestAttack = mutable(packet);
    digestAttack.bindings.provider_evidence_descriptor_sha256 = "8".repeat(64);
    expect(verifyProviderTransportPacket({
      packet: digestAttack,
      expectedSubject,
      planPinnedTrust: trust,
    }).errors).toContain(
      "provider evidence descriptor hash does not match its descriptor",
    );
  });

  it("rejects attacker re-signing because verification uses only the plan-pinned key", () => {
    const pinned = signingIdentity("pinned-provider-key-v1");
    const attacker = signingIdentity("attacker-provider-key-v1");
    const expectedSubject = subject();
    const attackerPacket = createProviderTransportPacket({
      subject: expectedSubject,
      signer: attacker.signer,
      planPinnedTrust: attacker.trust,
    });

    const verification = verifyProviderTransportPacket({
      packet: attackerPacket,
      expectedSubject,
      planPinnedTrust: pinned.trust,
    });
    expect(verification.valid).toBe(false);
    expect(verification.signature_verified).toBe(false);
    expect(verification.errors).toContain(
      "provider transport signing identity differs from plan-pinned trust",
    );
  });

  it("refuses signer substitution during creation before emitting a packet", () => {
    const pinned = signingIdentity("pinned-provider-key-v1");
    const attacker = signingIdentity("attacker-provider-key-v1");
    expect(() => createProviderTransportPacket({
      subject: subject(),
      signer: attacker.signer,
      planPinnedTrust: pinned.trust,
    })).toThrow(/signer differs from the plan-pinned trust root/);
  });

  it("refuses a signer callback that claims the pinned identity but signs invalid bytes", () => {
    const pinned = signingIdentity("pinned-provider-key-v1");
    expect(() => createProviderTransportPacket({
      subject: subject(),
      signer: {
        algorithm: "ed25519",
        keyId: pinned.signer.keyId,
        publicKeySha256: pinned.signer.publicKeySha256,
        sign: () => Buffer.alloc(64).toString("base64"),
      },
      planPinnedTrust: pinned.trust,
    })).toThrow(/did not produce a signature valid under plan-pinned trust/);
  });

  it("rejects malformed structure, noncanonical signatures, and trust fingerprints", () => {
    const { packet, expectedSubject, trust } = signed();
    const extraKey = { ...mutable(packet), unsupported: true };
    expect(verifyProviderTransportPacket({
      packet: extraKey,
      expectedSubject,
      planPinnedTrust: trust,
    }).errors).toContain("provider transport packet has missing or unsupported fields");

    const malformedSignature = mutable(packet);
    malformedSignature.signature.signature_base64 = "not-base64";
    expect(verifyProviderTransportPacket({
      packet: malformedSignature,
      expectedSubject,
      planPinnedTrust: trust,
    }).errors).toContain(
      "provider transport packet signature must be one canonical 64-byte Ed25519 signature",
    );

    expect(verifyProviderTransportPacket({
      packet,
      expectedSubject,
      planPinnedTrust: { ...trust, publicKeySha256: "9".repeat(64) },
    }).errors).toContain(
      "plan-pinned provider transport public-key fingerprint mismatch",
    );
  });

  it("rejects non-Ed25519 keys and snapshots getter-backed subjects before signing", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPrivate = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => createProviderTransportPacketSigner({
      keyId: "rsa-is-not-allowed",
      privateKeyPem: rsaPrivate,
    })).toThrow(/must be Ed25519/);

    const { signer, trust } = signingIdentity();
    const original = subject();
    let reads = 0;
    const getterBacked = {
      ...original,
      get run_id() {
        reads += 1;
        return reads === 1 ? original.run_id : "run-mutated-after-first-read";
      },
    };
    const packet = createProviderTransportPacket({
      subject: getterBacked,
      signer,
      planPinnedTrust: trust,
    });
    expect(packet.bindings.run_id).toBe(original.run_id);
    expect(reads).toBe(1);
  });
});
