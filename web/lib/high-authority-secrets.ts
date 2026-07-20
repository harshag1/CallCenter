import "server-only";

import { createHash, createHmac } from "node:crypto";

type SecretFormat = "hex-32" | "opaque";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const OBVIOUS_PLACEHOLDER = /(?:change(?:me|this)|replace(?:me|this)|yoursecret|placeholder|notasecret|defaultsecret|exampleonly|insertsecret|todo)/i;
const MAX_OPAQUE_SECRET_BYTES = 256;
const MIN_DISTINCT_BYTES = 8;

/**
 * These values cross independent trust domains. A configured value may never
 * be reused between entries, even when the value is represented as canonical
 * hex/base64 in one domain and as opaque text in another.
 */
const SECRET_DOMAIN_ENVIRONMENTS = Object.freeze([
  "ENV_VAULT_MASTER_KEY",
  "MCP_GATEWAY_SECRET",
  "AUTH_CODE_HMAC_SECRET",
  "CAMPAIGN_COMMITMENT_SECRET",
  "TELEPHONY_RECEIPT_SECRET",
  "XAI_SIP_SIGNING_SECRET",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SECRET",
  "RESEND_API_KEY",
] as const);

type HighAuthoritySecretEnvironment = typeof SECRET_DOMAIN_ENVIRONMENTS[number];

function canonicalDecode(value: string, format: SecretFormat): Buffer {
  if (format === "hex-32") {
    if (!/^[a-f0-9]{64}$/i.test(value)) {
      throw new Error("ENV_VAULT_MASTER_KEY missing/invalid");
    }
    return Buffer.from(value, "hex");
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (
    byteLength < 32 ||
    byteLength > MAX_OPAQUE_SECRET_BYTES ||
    value.trim() !== value ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error("secret material must contain 32-256 control-free bytes without surrounding whitespace");
  }
  return Buffer.from(value, "utf8");
}

function repeatedPrefixLength(value: Buffer): number | null {
  for (let width = 1; width <= Math.min(16, Math.floor(value.length / 2)); width += 1) {
    if (value.length % width !== 0) continue;
    let repeated = true;
    for (let offset = width; offset < value.length; offset += 1) {
      if (value[offset] !== value[offset % width]) {
        repeated = false;
        break;
      }
    }
    if (repeated) return width;
  }
  return null;
}

function assertPlausibleSecretMaterial(
  envName: HighAuthoritySecretEnvironment,
  value: string,
  format: SecretFormat
): Buffer {
  const decoded = canonicalDecode(value, format);
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    new Set(decoded).size < MIN_DISTINCT_BYTES ||
    repeatedPrefixLength(decoded) !== null ||
    OBVIOUS_PLACEHOLDER.test(normalized)
  ) {
    throw new Error(`${envName} is an unsafe placeholder`);
  }
  return decoded;
}

function representationFingerprints(value: string): ReadonlySet<string> {
  const representations: Buffer[] = [Buffer.from(value, "utf8")];
  if (/^[a-f0-9]+$/i.test(value) && value.length % 2 === 0) {
    representations.push(Buffer.from(value, "hex"));
  }
  for (const prefix of ["", "whsec_"]) {
    const candidate = prefix && value.startsWith(prefix) ? value.slice(prefix.length) : prefix ? "" : value;
    if (!candidate || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(candidate)) continue;
    for (const encoding of ["base64", "base64url"] as const) {
      try {
        const decoded = Buffer.from(candidate, encoding);
        const canonical = decoded.toString(encoding);
        if (
          decoded.length >= 16 &&
          (canonical === candidate || canonical.replace(/=+$/u, "") === candidate.replace(/=+$/u, ""))
        ) representations.push(decoded);
      } catch {
        // An opaque provider secret need not be encoded material.
      }
    }
  }
  return new Set(representations.map((representation) =>
    createHash("sha256").update(representation).digest("hex")
  ));
}

function assertNoCrossDomainReuse(
  envName: HighAuthoritySecretEnvironment,
  value: string
): void {
  const fingerprints = representationFingerprints(value);
  for (const otherName of SECRET_DOMAIN_ENVIRONMENTS) {
    if (otherName === envName) continue;
    const otherValue = process.env[otherName];
    if (!otherValue) continue;
    const otherFingerprints = representationFingerprints(otherValue);
    if ([...fingerprints].some((fingerprint) => otherFingerprints.has(fingerprint))) {
      throw new Error(`${envName} must not reuse secret material from ${otherName}`);
    }
  }
}

function validatedEnvironmentSecret(
  envName: HighAuthoritySecretEnvironment,
  format: SecretFormat
): string {
  const value = process.env[envName];
  if (!value) {
    if (envName === "ENV_VAULT_MASTER_KEY") {
      throw new Error("ENV_VAULT_MASTER_KEY missing/invalid");
    }
    throw new Error(`${envName} is required`);
  }
  assertPlausibleSecretMaterial(envName, value, format);
  assertNoCrossDomainReuse(envName, value);
  return value;
}

/** Validated AES-256 credential-vault root. */
export function envVaultMasterKey(): Buffer {
  return Buffer.from(validatedEnvironmentSecret("ENV_VAULT_MASTER_KEY", "hex-32"), "hex");
}

/**
 * One high-entropy framework root is intentionally expanded into separately
 * labelled MCP-session, scope, Flow-lease, and consent-receipt MAC domains.
 */
export function mcpGatewaySecret(): string {
  return validatedEnvironmentSecret("MCP_GATEWAY_SECRET", "opaque");
}

/** Provider webhook verification is a separate trust domain from framework MACs. */
export function xaiSipSigningSecret(): string {
  return validatedEnvironmentSecret("XAI_SIP_SIGNING_SECRET", "opaque");
}

export function validateMcpGatewaySecret(secret: string): string {
  assertPlausibleSecretMaterial("MCP_GATEWAY_SECRET", secret, "opaque");
  assertNoCrossDomainReuse("MCP_GATEWAY_SECRET", secret);
  return secret;
}

export function deriveDomainSeparatedSecretKey(secret: string, domain: string): Buffer {
  if (
    typeof domain !== "string" ||
    domain.length < 16 ||
    domain.length > 200 ||
    CONTROL_CHARACTER.test(domain.replace(/\n$/u, ""))
  ) throw new Error("invalid secret derivation domain");
  return createHmac("sha256", validateMcpGatewaySecret(secret))
    .update(domain, "utf8")
    .digest();
}
