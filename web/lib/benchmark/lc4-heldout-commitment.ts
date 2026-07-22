import { createCipheriv } from "node:crypto";
import { z } from "zod";
import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";

export const LC4_HELDOUT_COMMITMENT_PROTOCOL = "HACC-LC4-HELDOUT-COMMITMENT-v1" as const;
export const LC4_HELDOUT_CORPUS_PROTOCOL = "HACC-LC4-v1" as const;
export const LC4_HELDOUT_TEMPLATE_COUNT = 24 as const;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z][a-z0-9_.-]{1,95}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_CANONICAL_CORPUS_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 200_000;
const MAX_STRING_BYTES = 1024 * 1024;

const IdentifierSchema = z.string().regex(SAFE_ID);
const Sha256Schema = z.string().regex(SHA256);

const GeneratedTemplateSchema = z.object({
  template_id: IdentifierSchema,
  family_slot: z.number().int().min(1).max(6),
  structural_variant_slot: z.number().int().min(1).max(4),
  payload: z.unknown(),
}).strict();

export type Lc4GeneratedHeldoutTemplate = z.infer<typeof GeneratedTemplateSchema>;

export type Lc4DeterministicHeldoutGenerator = Readonly<{
  generatorId: string;
  generatorVersion: string;
  generatorSourceSha256: string;
  corpusSchemaSha256: string;
  generate(seed: Uint8Array): readonly Lc4GeneratedHeldoutTemplate[];
}>;

export type Lc4HeldoutCustody = Readonly<{
  seedCustodianId: string;
  keyCustodianId: string;
  preparationOperatorId: string;
  custodyProcedureSha256: string;
}>;

export type Lc4HeldoutSealInput = Readonly<{
  generator: Lc4DeterministicHeldoutGenerator;
  seed: Uint8Array;
  encryptionKey: Uint8Array;
  nonce: Uint8Array;
  custody: Lc4HeldoutCustody;
  createdAt: string;
}>;

const CommitmentContextBaseSchema = z.object({
  schema_version: z.literal(1),
  commitment_protocol: z.literal(LC4_HELDOUT_COMMITMENT_PROTOCOL),
  corpus_protocol: z.literal(LC4_HELDOUT_CORPUS_PROTOCOL),
  status: z.literal("sealed-not-unsealed"),
  held_out: z.literal(true),
  preregistration_status: z.literal("not-preregistered"),
  provider_calls_authorized: z.literal(false),
  created_at: z.string().datetime(),
  generator: z.object({
    id: IdentifierSchema,
    version: z.string().min(1).max(128),
    source_sha256: Sha256Schema,
    corpus_schema_sha256: Sha256Schema,
  }).strict(),
  corpus: z.object({
    format: z.literal("canonical-json-utf8"),
    template_count: z.literal(LC4_HELDOUT_TEMPLATE_COUNT),
    canonical_byte_length: z.number().int().positive().max(MAX_CANONICAL_CORPUS_BYTES),
    plaintext_commitment_sha256: Sha256Schema,
  }).strict(),
  custody: z.object({
    seed_custodian_id: IdentifierSchema,
    key_custodian_id: IdentifierSchema,
    preparation_operator_id: IdentifierSchema,
    custody_procedure_sha256: Sha256Schema,
    separation: z.literal("three-party-distinct"),
    seed_commitment_sha256: Sha256Schema,
    key_commitment_sha256: Sha256Schema,
  }).strict(),
  encryption: z.object({
    algorithm: z.literal("aes-256-gcm"),
    nonce_source: z.literal("external-csprng"),
    nonce_base64: z.string().regex(BASE64),
  }).strict(),
}).strict();

const CommitmentContextSchema = CommitmentContextBaseSchema.superRefine((context, ctx) => {
  const custodians = [
    context.custody.seed_custodian_id,
    context.custody.key_custodian_id,
    context.custody.preparation_operator_id,
  ];
  if (new Set(custodians).size !== custodians.length) {
    ctx.addIssue({ code: "custom", path: ["custody"], message: "seed, key, and preparation custody must remain distinct" });
  }
  if (decodeBase64(context.encryption.nonce_base64, "nonce").byteLength !== 12) {
    ctx.addIssue({ code: "custom", path: ["encryption", "nonce_base64"], message: "AES-GCM nonce must be exactly 12 bytes" });
  }
});

export type Lc4HeldoutCommitmentContext = z.infer<typeof CommitmentContextSchema>;

const CommitmentManifestSchema = z.object({
  ...CommitmentContextBaseSchema.shape,
  encryption: CommitmentContextBaseSchema.shape.encryption.extend({
    aad_sha256: Sha256Schema,
    authentication_tag_base64: z.string().regex(BASE64),
    ciphertext_sha256: Sha256Schema,
    ciphertext_byte_length: z.number().int().positive().max(MAX_CANONICAL_CORPUS_BYTES + 64),
  }).strict(),
  manifest_sha256: Sha256Schema,
}).strict().superRefine((manifest, ctx) => {
  const custodians = [
    manifest.custody.seed_custodian_id,
    manifest.custody.key_custodian_id,
    manifest.custody.preparation_operator_id,
  ];
  if (new Set(custodians).size !== custodians.length) {
    ctx.addIssue({ code: "custom", path: ["custody"], message: "seed, key, and preparation custody must remain distinct" });
  }
  if (decodeBase64(manifest.encryption.nonce_base64, "nonce").byteLength !== 12) {
    ctx.addIssue({ code: "custom", path: ["encryption", "nonce_base64"], message: "AES-GCM nonce must be exactly 12 bytes" });
  }
  if (decodeBase64(manifest.encryption.authentication_tag_base64, "authentication tag").byteLength !== 16) {
    ctx.addIssue({ code: "custom", path: ["encryption", "authentication_tag_base64"], message: "AES-GCM authentication tag must be exactly 16 bytes" });
  }
});

export type Lc4HeldoutCommitmentManifest = z.infer<typeof CommitmentManifestSchema>;

const SealedBundleSchema = z.object({
  manifest: CommitmentManifestSchema,
  ciphertext_base64: z.string().regex(BASE64),
}).strict();

export type Lc4SealedHeldoutBundle = z.infer<typeof SealedBundleSchema>;

export type Lc4HeldoutCommitmentVerification = Readonly<{
  valid: boolean;
  errors: readonly string[];
  manifest_sha256: string | null;
  ciphertext_sha256: string | null;
  cryptographic_scope: "commitment-only-without-custody-key";
}>;

function immutable<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function hashDomain(domain: string, value: string | Uint8Array): string {
  const prefix = new TextEncoder().encode(`harshas-amazing-call-center/${domain}/v1\n`);
  const body = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const combined = new Uint8Array(prefix.byteLength + body.byteLength);
  combined.set(prefix, 0);
  combined.set(body, prefix.byteLength);
  return sha256Hex(combined);
}

function decodeBase64(value: string, label: string): Uint8Array {
  if (!BASE64.test(value)) throw new Error(`${label} is not canonical base64`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`${label} is not canonical base64`);
  return new Uint8Array(decoded);
}

function assertExactBytes(value: Uint8Array, length: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`${label} must be exactly ${length} bytes`);
  }
}

function assertGeneratorMetadata(generator: Lc4DeterministicHeldoutGenerator): void {
  if (!SAFE_ID.test(generator.generatorId)) throw new Error("held-out generator id is invalid");
  if (!generator.generatorVersion.trim() || generator.generatorVersion.length > 128) throw new Error("held-out generator version is invalid");
  if (!SHA256.test(generator.generatorSourceSha256)) throw new Error("held-out generator source hash is invalid");
  if (!SHA256.test(generator.corpusSchemaSha256)) throw new Error("held-out corpus schema hash is invalid");
  if (typeof generator.generate !== "function") throw new Error("held-out generator implementation is absent");
}

function normalizeJson(value: unknown, label: string): JsonValue {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new Error(`${label} exceeds the JSON node limit`);
    if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds the JSON depth limit`);
    if (candidate === null) return null;
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error(`${label} contains a non-finite number`);
      return candidate;
    }
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > MAX_STRING_BYTES) throw new Error(`${label} contains an oversized string`);
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map((item) => visit(item, depth + 1));
    if (typeof candidate !== "object" || candidate === undefined) throw new Error(`${label} contains a non-JSON value`);
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} contains a non-plain object`);
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`${label} contains a forbidden object key`);
      output[key] = visit((candidate as Record<string, unknown>)[key], depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

function normalizeTemplates(input: unknown): readonly Lc4GeneratedHeldoutTemplate[] {
  const parsed = z.array(GeneratedTemplateSchema).length(LC4_HELDOUT_TEMPLATE_COUNT).parse(input);
  const ids = new Set<string>();
  const slots = new Set<string>();
  const normalized = parsed.map((template) => {
    if (ids.has(template.template_id)) throw new Error("held-out generator emitted duplicate template ids");
    ids.add(template.template_id);
    const slot = `${template.family_slot}/${template.structural_variant_slot}`;
    if (slots.has(slot)) throw new Error("held-out generator emitted duplicate structural slots");
    slots.add(slot);
    return immutable({ ...template, payload: normalizeJson(template.payload, "held-out template payload") });
  });
  if (slots.size !== LC4_HELDOUT_TEMPLATE_COUNT) throw new Error("held-out generator did not cover the complete six-by-four slot matrix");
  return Object.freeze(normalized);
}

function contextFromManifest(manifest: Lc4HeldoutCommitmentManifest): Lc4HeldoutCommitmentContext {
  return CommitmentContextSchema.parse({
    schema_version: manifest.schema_version,
    commitment_protocol: manifest.commitment_protocol,
    corpus_protocol: manifest.corpus_protocol,
    status: manifest.status,
    held_out: manifest.held_out,
    preregistration_status: manifest.preregistration_status,
    provider_calls_authorized: manifest.provider_calls_authorized,
    created_at: manifest.created_at,
    generator: manifest.generator,
    corpus: manifest.corpus,
    custody: manifest.custody,
    encryption: {
      algorithm: manifest.encryption.algorithm,
      nonce_source: manifest.encryption.nonce_source,
      nonce_base64: manifest.encryption.nonce_base64,
    },
  });
}

function manifestBody(manifest: Omit<Lc4HeldoutCommitmentManifest, "manifest_sha256"> | Lc4HeldoutCommitmentManifest): unknown {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifest_sha256"));
}

/**
 * Generate and seal a held-out candidate without returning seed, key, or plaintext.
 * The generator must be pure and side-effect free. This module performs no stdout,
 * stderr, filesystem, network, provider, preregistration, or unseal operation.
 */
export function sealLc4HeldoutCandidate(input: Lc4HeldoutSealInput): Lc4SealedHeldoutBundle {
  assertGeneratorMetadata(input.generator);
  assertExactBytes(input.seed, 32, "held-out seed");
  assertExactBytes(input.encryptionKey, 32, "held-out encryption key");
  assertExactBytes(input.nonce, 12, "held-out encryption nonce");
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("held-out creation time must be ISO-8601");
  const custody = {
    seed_custodian_id: input.custody.seedCustodianId,
    key_custodian_id: input.custody.keyCustodianId,
    preparation_operator_id: input.custody.preparationOperatorId,
    custody_procedure_sha256: input.custody.custodyProcedureSha256,
  };
  for (const [label, id] of Object.entries(custody).filter(([key]) => key.endsWith("_id"))) {
    if (!SAFE_ID.test(id)) throw new Error(`${label} is invalid`);
  }
  if (!SHA256.test(custody.custody_procedure_sha256)) throw new Error("custody procedure hash is invalid");
  if (new Set([custody.seed_custodian_id, custody.key_custodian_id, custody.preparation_operator_id]).size !== 3) {
    throw new Error("seed, key, and preparation custody must remain distinct");
  }

  const seed = new Uint8Array(input.seed);
  const key = new Uint8Array(input.encryptionKey);
  const nonce = new Uint8Array(input.nonce);
  const generatorSeed = new Uint8Array(seed);
  let plaintext: Buffer | null = null;
  try {
    let generated: readonly Lc4GeneratedHeldoutTemplate[];
    try {
      generated = input.generator.generate(generatorSeed);
    } catch {
      throw new Error("held-out generator failed without exposing its internal error");
    }
    const templates = normalizeTemplates(generated);
    const corpus = immutable({
      schema_version: 1,
      corpus_protocol: LC4_HELDOUT_CORPUS_PROTOCOL,
      generator_id: input.generator.generatorId,
      generator_version: input.generator.generatorVersion,
      templates,
    });
    plaintext = Buffer.from(canonicalJson(corpus), "utf8");
    if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_CANONICAL_CORPUS_BYTES) {
      throw new Error("held-out canonical corpus exceeds the sealed size boundary");
    }
    const context = CommitmentContextSchema.parse({
      schema_version: 1,
      commitment_protocol: LC4_HELDOUT_COMMITMENT_PROTOCOL,
      corpus_protocol: LC4_HELDOUT_CORPUS_PROTOCOL,
      status: "sealed-not-unsealed",
      held_out: true,
      preregistration_status: "not-preregistered",
      provider_calls_authorized: false,
      created_at: input.createdAt,
      generator: {
        id: input.generator.generatorId,
        version: input.generator.generatorVersion,
        source_sha256: input.generator.generatorSourceSha256,
        corpus_schema_sha256: input.generator.corpusSchemaSha256,
      },
      corpus: {
        format: "canonical-json-utf8",
        template_count: LC4_HELDOUT_TEMPLATE_COUNT,
        canonical_byte_length: plaintext.byteLength,
        plaintext_commitment_sha256: hashDomain("lc4-heldout-plaintext", plaintext),
      },
      custody: {
        ...custody,
        separation: "three-party-distinct",
        seed_commitment_sha256: hashDomain("lc4-heldout-seed", seed),
        key_commitment_sha256: hashDomain("lc4-heldout-key", key),
      },
      encryption: {
        algorithm: "aes-256-gcm",
        nonce_source: "external-csprng",
        nonce_base64: Buffer.from(nonce).toString("base64"),
      },
    });
    const aad = Buffer.from(canonicalJson(context), "utf8");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    const manifestWithoutHash = {
      ...context,
      encryption: {
        ...context.encryption,
        aad_sha256: hashDomain("lc4-heldout-aad", aad),
        authentication_tag_base64: authenticationTag.toString("base64"),
        ciphertext_sha256: hashDomain("lc4-heldout-ciphertext", ciphertext),
        ciphertext_byte_length: ciphertext.byteLength,
      },
    };
    const manifest = CommitmentManifestSchema.parse({
      ...manifestWithoutHash,
      manifest_sha256: hashDomain("lc4-heldout-manifest", canonicalJson(manifestWithoutHash)),
    });
    return immutable(SealedBundleSchema.parse({
      manifest,
      ciphertext_base64: ciphertext.toString("base64"),
    }));
  } finally {
    seed.fill(0);
    key.fill(0);
    nonce.fill(0);
    generatorSeed.fill(0);
    plaintext?.fill(0);
  }
}

/** Validate a public sealed commitment against an independently published digest. */
export function verifyLc4HeldoutCommitment(
  input: unknown,
  expectedManifestSha256: string,
): Lc4HeldoutCommitmentVerification {
  const errors: string[] = [];
  if (!SHA256.test(expectedManifestSha256)) errors.push("expected public manifest commitment is invalid");
  const parsed = SealedBundleSchema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze(["sealed bundle schema validation failed"]),
      manifest_sha256: null,
      ciphertext_sha256: null,
      cryptographic_scope: "commitment-only-without-custody-key" as const,
    });
  }
  const { manifest } = parsed.data;
  let ciphertext: Uint8Array | null = null;
  try {
    ciphertext = decodeBase64(parsed.data.ciphertext_base64, "ciphertext");
  } catch {
    errors.push("ciphertext encoding is invalid");
  }
  let context: Lc4HeldoutCommitmentContext | null = null;
  try {
    context = contextFromManifest(manifest);
  } catch {
    errors.push("commitment context is invalid");
  }
  if (context) {
    const expectedAad = hashDomain("lc4-heldout-aad", canonicalJson(context));
    if (manifest.encryption.aad_sha256 !== expectedAad) errors.push("associated-data commitment mismatch");
  }
  if (ciphertext) {
    if (ciphertext.byteLength !== manifest.encryption.ciphertext_byte_length) errors.push("ciphertext byte length mismatch");
    const expectedCiphertext = hashDomain("lc4-heldout-ciphertext", ciphertext);
    if (manifest.encryption.ciphertext_sha256 !== expectedCiphertext) errors.push("ciphertext commitment mismatch");
  }
  const expectedManifest = hashDomain("lc4-heldout-manifest", canonicalJson(manifestBody(manifest)));
  if (manifest.manifest_sha256 !== expectedManifest) errors.push("manifest commitment mismatch");
  if (manifest.manifest_sha256 !== expectedManifestSha256) errors.push("independently published manifest commitment mismatch");
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    manifest_sha256: manifest.manifest_sha256,
    ciphertext_sha256: manifest.encryption.ciphertext_sha256,
    cryptographic_scope: "commitment-only-without-custody-key" as const,
  });
}
