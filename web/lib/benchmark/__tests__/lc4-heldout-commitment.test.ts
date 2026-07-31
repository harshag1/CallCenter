import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../artifacts";
import * as heldoutModule from "../lc4-heldout-commitment";
import {
  LC4_HELDOUT_COMMITMENT_PROTOCOL,
  LC4_HELDOUT_TEMPLATE_COUNT,
  sealLc4HeldoutCandidate,
  verifyLc4HeldoutCommitment,
  type Lc4DeterministicHeldoutGenerator,
  type Lc4HeldoutSealInput,
  type Lc4SealedHeldoutBundle,
} from "../lc4-heldout-commitment";

const PRIVATE_MARKER = "toy-private-lab-logistics-value";

function bytes(length: number, offset: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + offset) % 256);
}

function generator(): Lc4DeterministicHeldoutGenerator {
  return {
    generatorId: "lc4.generic.toy-generator",
    generatorVersion: "1.0.0-test-only",
    generatorSourceSha256: sha256Hex("toy-generator-source"),
    corpusSchemaSha256: sha256Hex("toy-corpus-schema"),
    generate(seed) {
      const seedDigest = sha256Hex(seed);
      return Array.from({ length: LC4_HELDOUT_TEMPLATE_COUNT }, (_, index) => ({
        template_id: `sealed-template.${String(index + 1).padStart(2, "0")}`,
        family_slot: Math.floor(index / 4) + 1,
        structural_variant_slot: index % 4 + 1,
        payload: {
          synthetic_domain: "lab-logistics-test-only",
          opaque_value: `${PRIVATE_MARKER}-${seedDigest.slice(index, index + 8)}`,
          ordinal: index + 1,
        },
      }));
    },
  };
}

function input(overrides: Partial<Lc4HeldoutSealInput> = {}): Lc4HeldoutSealInput {
  return {
    generator: generator(),
    seed: bytes(32, 11),
    encryptionKey: bytes(32, 77),
    nonce: bytes(12, 151),
    custody: {
      seedCustodianId: "custodian.seed",
      keyCustodianId: "custodian.key",
      preparationOperatorId: "operator.seal",
      custodyProcedureSha256: sha256Hex("toy-custody-procedure"),
    },
    createdAt: "2026-07-21T21:00:00.000Z",
    ...overrides,
  };
}

function mutable(bundle: Lc4SealedHeldoutBundle): Record<string, unknown> {
  return structuredClone(bundle) as unknown as Record<string, unknown>;
}

describe("LC4 independent held-out seal-only preparation", () => {
  it("seals a deterministic generic corpus without returning seed, key, or plaintext", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let sealed: Lc4SealedHeldoutBundle;
    try {
      sealed = sealLc4HeldoutCandidate(input());
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }

    expect(sealed!.manifest).toMatchObject({
      commitment_protocol: LC4_HELDOUT_COMMITMENT_PROTOCOL,
      status: "sealed-not-unsealed",
      held_out: true,
      held_out_scope: "seed-derived-content-values-and-surface-realization",
      topology_status: "public-and-development-exercised",
      domain_vocabulary_status: "public-in-frozen-power-plan",
      preregistration_status: "not-preregistered",
      provider_calls_authorized: false,
      corpus: { template_count: 24 },
      custody: { separation: "three-party-distinct" },
      encryption: { algorithm: "aes-256-gcm", nonce_source: "external-csprng" },
    });
    const publicArtifact = JSON.stringify(sealed!);
    expect(publicArtifact).not.toContain(PRIVATE_MARKER);
    expect(publicArtifact).not.toContain(Buffer.from(input().seed).toString("hex"));
    expect(publicArtifact).not.toContain(Buffer.from(input().encryptionKey).toString("hex"));
    expect(publicArtifact).not.toContain("lab-logistics-test-only");
    expect(verifyLc4HeldoutCommitment(sealed!, sealed!.manifest.manifest_sha256)).toMatchObject({
      valid: true,
      errors: [],
      cryptographic_scope: "commitment-only-without-custody-key",
    });
  });

  it("is reproducible for fixed test custody inputs while keeping generator and encryption changes distinct", () => {
    const first = sealLc4HeldoutCandidate(input());
    const replay = sealLc4HeldoutCandidate(input());
    const changedSeed = sealLc4HeldoutCandidate(input({ seed: bytes(32, 12) }));
    const changedNonce = sealLc4HeldoutCandidate(input({ nonce: bytes(12, 152) }));

    expect(replay).toEqual(first);
    expect(changedSeed.manifest.corpus.plaintext_commitment_sha256).not.toBe(first.manifest.corpus.plaintext_commitment_sha256);
    expect(changedSeed.manifest.encryption.ciphertext_sha256).not.toBe(first.manifest.encryption.ciphertext_sha256);
    expect(changedNonce.manifest.corpus.plaintext_commitment_sha256).toBe(first.manifest.corpus.plaintext_commitment_sha256);
    expect(changedNonce.manifest.encryption.ciphertext_sha256).not.toBe(first.manifest.encryption.ciphertext_sha256);
  });

  it("verifies commitments without accepting custody secrets or exposing an unseal API", () => {
    const sealed = sealLc4HeldoutCandidate(input());
    const verification = verifyLc4HeldoutCommitment(sealed, sealed.manifest.manifest_sha256);

    expect(verification.valid).toBe(true);
    expect(Object.keys(verification).sort()).toEqual([
      "ciphertext_sha256", "cryptographic_scope", "errors", "manifest_sha256", "valid",
    ]);
    expect(heldoutModule).not.toHaveProperty("unsealLc4HeldoutCandidate");
    expect(heldoutModule).not.toHaveProperty("decryptLc4HeldoutCandidate");
  });

  it("rejects ciphertext, AAD, manifest, tag, custody, and count mutations without unsealing", () => {
    const sealed = sealLc4HeldoutCandidate(input());
    const mutations: Record<string, unknown>[] = [];

    const ciphertext = mutable(sealed);
    ciphertext.ciphertext_base64 = `${sealed.ciphertext_base64.slice(0, -4)}AAAA`;
    mutations.push(ciphertext);

    const aad = mutable(sealed);
    (aad.manifest as Record<string, unknown>).created_at = "2026-07-21T21:00:01.000Z";
    mutations.push(aad);

    const source = mutable(sealed);
    ((source.manifest as Record<string, unknown>).generator as Record<string, unknown>).source_sha256 = sha256Hex("mutated-source");
    mutations.push(source);

    const tag = mutable(sealed);
    ((tag.manifest as Record<string, unknown>).encryption as Record<string, unknown>).authentication_tag_base64 = Buffer.alloc(16, 9).toString("base64");
    mutations.push(tag);

    const custody = mutable(sealed);
    const custodyRecord = (custody.manifest as Record<string, unknown>).custody as Record<string, unknown>;
    custodyRecord.key_custodian_id = custodyRecord.seed_custodian_id;
    mutations.push(custody);

    const count = mutable(sealed);
    ((count.manifest as Record<string, unknown>).corpus as Record<string, unknown>).template_count = 23;
    mutations.push(count);

    for (const mutation of mutations) {
      expect(verifyLc4HeldoutCommitment(mutation, sealed.manifest.manifest_sha256).valid).toBe(false);
    }
    expect(verifyLc4HeldoutCommitment(sealed, sha256Hex("wrong-public-commitment"))).toMatchObject({
      valid: false,
      errors: ["independently published manifest commitment mismatch"],
    });
  });

  it("enforces key-custody separation and exact cryptographic material sizes", () => {
    expect(() => sealLc4HeldoutCandidate(input({
      custody: {
        seedCustodianId: "custodian.same",
        keyCustodianId: "custodian.same",
        preparationOperatorId: "operator.seal",
        custodyProcedureSha256: sha256Hex("toy-custody-procedure"),
      },
    }))).toThrow(/custody must remain distinct/);
    expect(() => sealLc4HeldoutCandidate(input({ seed: bytes(31, 1) }))).toThrow(/seed must be exactly 32 bytes/);
    expect(() => sealLc4HeldoutCandidate(input({ encryptionKey: bytes(31, 1) }))).toThrow(/key must be exactly 32 bytes/);
    expect(() => sealLc4HeldoutCandidate(input({ nonce: bytes(11, 1) }))).toThrow(/nonce must be exactly 12 bytes/);
  });

  it("rejects incomplete or duplicate six-by-four generator output before encryption", () => {
    const shortGenerator = { ...generator(), generate: (seed: Uint8Array) => generator().generate(seed).slice(0, 23) };
    expect(() => sealLc4HeldoutCandidate(input({ generator: shortGenerator }))).toThrow();

    const duplicateGenerator = {
      ...generator(),
      generate(seed: Uint8Array) {
        const templates = generator().generate(seed).map((template) => structuredClone(template));
        templates[1]!.family_slot = templates[0]!.family_slot;
        templates[1]!.structural_variant_slot = templates[0]!.structural_variant_slot;
        return templates;
      },
    };
    expect(() => sealLc4HeldoutCandidate(input({ generator: duplicateGenerator }))).toThrow(/duplicate structural slots/);
  });

  it("sanitizes generator failures so future seed-dependent errors cannot leak", () => {
    const failing = {
      ...generator(),
      generate() {
        throw new Error(`${PRIVATE_MARKER}: secret branch and seed-derived value`);
      },
    };
    let message = "";
    try {
      sealLc4HeldoutCandidate(input({ generator: failing }));
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toBe("held-out generator failed without exposing its internal error");
    expect(message).not.toContain(PRIVATE_MARKER);
  });
});
