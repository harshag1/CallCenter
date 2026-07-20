// Author: Harsha Gundala
// vault.ts — AES-256-GCM primitives. Credential sinks use versioned, context-bound AEAD.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { envVaultMasterKey } from "./high-authority-secrets";

function key(): Buffer {
  return envVaultMasterKey();
}

const CREDENTIAL_ENVELOPE_VERSION = "hacc_v2";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_CREDENTIAL_PLAINTEXT_BYTES = 32 * 1024;
const MAX_CREDENTIAL_ENVELOPE_BYTES = 256 * 1024;

export type CredentialSecretContext = Readonly<{
  orgId: string;
  sinkKind: "env_var" | "mcp_server";
  sinkId: string;
  slotId: string;
}>;

function canonicalCredentialContext(context: CredentialSecretContext): string {
  if (
    !context
    || typeof context !== "object"
    || !UUID_PATTERN.test(context.orgId)
    || !SLOT_ID_PATTERN.test(context.slotId)
    || (context.sinkKind !== "env_var" && context.sinkKind !== "mcp_server")
    || (context.sinkKind === "env_var"
      ? !ENV_NAME_PATTERN.test(context.sinkId)
      : !SLOT_ID_PATTERN.test(context.sinkId))
  ) throw new Error("invalid credential encryption context");
  return JSON.stringify([
    "harshas-amazing-call-center/credential-vault",
    2,
    context.orgId.toLowerCase(),
    context.sinkKind,
    context.sinkKind === "mcp_server" ? context.sinkId.toLowerCase() : context.sinkId,
    context.slotId.toLowerCase(),
  ]);
}

function decodeCanonicalBase64Url(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid credential ciphertext");
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length === 0
    || decoded.toString("base64url") !== value
    || (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) throw new Error("invalid credential ciphertext");
  return decoded;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(":");
}

export function decryptSecret(encoded: string): string {
  const [iv, tag, ct] = encoded.split(":").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** New credential writes always use this context-bound v2 envelope. */
export function encryptCredentialSecret(
  plaintext: string,
  context: CredentialSecretContext
): string {
  if (
    typeof plaintext !== "string"
    || plaintext.length === 0
    || Buffer.byteLength(plaintext, "utf8") > MAX_CREDENTIAL_PLAINTEXT_BYTES
  ) throw new Error("invalid credential plaintext");
  const aad = Buffer.from(canonicalCredentialContext(context), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [CREDENTIAL_ENVELOPE_VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => typeof part === "string" ? part : part.toString("base64url"))
    .join(":");
}

/**
 * Credential readers reject legacy unbound ciphertext. Existing rows must be
 * explicitly re-entered/re-registered; there is no implicit downgrade fallback.
 */
export function decryptCredentialSecret(
  encoded: string,
  context: CredentialSecretContext
): string {
  try {
    if (
      typeof encoded !== "string"
      || encoded.length === 0
      || Buffer.byteLength(encoded, "utf8") > MAX_CREDENTIAL_ENVELOPE_BYTES
    ) throw new Error("invalid credential ciphertext");
    const parts = encoded.split(":");
    if (parts.length !== 4 || parts[0] !== CREDENTIAL_ENVELOPE_VERSION) {
      throw new Error("invalid credential ciphertext");
    }
    const iv = decodeCanonicalBase64Url(parts[1], 12);
    const tag = decodeCanonicalBase64Url(parts[2], 16);
    const ciphertext = decodeCanonicalBase64Url(parts[3]);
    const aad = Buffer.from(canonicalCredentialContext(context), "utf8");
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (plaintext.length === 0 || Buffer.byteLength(plaintext, "utf8") > MAX_CREDENTIAL_PLAINTEXT_BYTES) {
      throw new Error("invalid credential ciphertext");
    }
    return plaintext;
  } catch {
    throw new Error("credential ciphertext authentication failed");
  }
}
