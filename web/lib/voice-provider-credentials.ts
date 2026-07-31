import "server-only";

import { randomUUID } from "node:crypto";
import { q, qOne } from "./db";
import { allowsLocalDevelopmentFundedAi } from "./deployment-funded-ai";
import { authorizeLocalDeploymentBrowserFunding } from "./realtime/browser-funding-authority";
import type {
  BrowserProviderFundingAuthority,
  VoiceProviderId,
} from "./realtime/types";
import {
  decryptCredentialSecret,
  encryptCredentialSecret,
  type CredentialSecretContext,
} from "./vault";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MIN_CREDENTIAL_BYTES = 16;
const MAX_CREDENTIAL_BYTES = 4 * 1024;

export const TENANT_BROWSER_VOICE_PROVIDERS = Object.freeze([
  "xai",
  "openai",
] as const);
export type TenantBrowserVoiceProvider =
  (typeof TENANT_BROWSER_VOICE_PROVIDERS)[number];

export type VoiceProviderCredentialStatus = Readonly<{
  provider: TenantBrowserVoiceProvider;
  configured: boolean;
  updatedAt: string | null;
}>;

export type BrowserVoiceFundingAuthority =
  BrowserProviderFundingAuthority<VoiceProviderId>;

type StoredCredentialRow = Readonly<{
  provider: string;
  credential_encrypted: string;
  encryption_slot_id: string;
  updated_at: string | Date;
}>;

export type VoiceProviderCredentialDependencies = Readonly<{
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  queryOne: (sql: string, params?: unknown[]) => Promise<unknown | null>;
  encrypt: (plaintext: string, context: CredentialSecretContext) => string;
  decrypt: (ciphertext: string, context: CredentialSecretContext) => string;
  randomUUID: () => string;
  allowsLocalFunding: () => boolean;
}>;

const defaultDependencies: VoiceProviderCredentialDependencies = {
  query: q as VoiceProviderCredentialDependencies["query"],
  queryOne: qOne as VoiceProviderCredentialDependencies["queryOne"],
  encrypt: encryptCredentialSecret,
  decrypt: decryptCredentialSecret,
  randomUUID,
  allowsLocalFunding: allowsLocalDevelopmentFundedAi,
};

export class VoiceProviderCredentialError extends Error {
  constructor(
    readonly code: "invalid_input" | "unavailable" | "corrupt_record",
  ) {
    super(
      code === "invalid_input"
        ? "invalid voice provider credential input"
        : code === "corrupt_record"
          ? "voice provider credential failed context authentication"
          : "voice provider credential store unavailable",
    );
    this.name = "VoiceProviderCredentialError";
  }
}

export function isTenantBrowserVoiceProvider(
  value: unknown,
): value is TenantBrowserVoiceProvider {
  return value === "xai" || value === "openai";
}

export function isValidVoiceProviderCredential(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || CONTROL_CHARACTER.test(value)
  ) return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= MIN_CREDENTIAL_BYTES && bytes <= MAX_CREDENTIAL_BYTES;
}

function requireOrgId(orgId: unknown): asserts orgId is string {
  if (typeof orgId !== "string" || !UUID_PATTERN.test(orgId)) {
    throw new VoiceProviderCredentialError("invalid_input");
  }
}

function requireProvider(
  provider: unknown,
): asserts provider is TenantBrowserVoiceProvider {
  if (!isTenantBrowserVoiceProvider(provider)) {
    throw new VoiceProviderCredentialError("invalid_input");
  }
}

function context(
  orgId: string,
  provider: TenantBrowserVoiceProvider,
  slotId: string,
): CredentialSecretContext {
  return {
    orgId,
    sinkKind: "voice_provider",
    sinkId: provider,
    slotId,
  };
}

function canonicalDate(value: string | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new VoiceProviderCredentialError("corrupt_record");
  }
  return date.toISOString();
}

/**
 * Replace one tenant/provider root. Plaintext exists only in this server call
 * and the context-authenticated vault primitive; it is never returned.
 */
export async function replaceVoiceProviderCredential(
  input: Readonly<{
    orgId: string;
    provider: TenantBrowserVoiceProvider;
    credential: string;
  }>,
  dependencies: VoiceProviderCredentialDependencies = defaultDependencies,
): Promise<VoiceProviderCredentialStatus> {
  requireOrgId(input.orgId);
  requireProvider(input.provider);
  if (!isValidVoiceProviderCredential(input.credential)) {
    throw new VoiceProviderCredentialError("invalid_input");
  }
  const slotId = dependencies.randomUUID();
  if (!SLOT_ID_PATTERN.test(slotId)) {
    throw new VoiceProviderCredentialError("unavailable");
  }
  let encrypted: string;
  try {
    encrypted = dependencies.encrypt(
      input.credential,
      context(input.orgId, input.provider, slotId),
    );
  } catch {
    throw new VoiceProviderCredentialError("unavailable");
  }
  if (
    typeof encrypted !== "string"
    || !encrypted.startsWith("hacc_v2:")
    || Buffer.byteLength(encrypted, "utf8") > 32 * 1024
  ) {
    throw new VoiceProviderCredentialError("unavailable");
  }
  let row: { updated_at: string | Date } | null;
  try {
    row = await dependencies.queryOne(
      `INSERT INTO hacc_private.voice_provider_credentials
         (org_id, provider, credential_encrypted, encryption_slot_id)
       VALUES ($1::uuid,$2,$3,$4::uuid)
       ON CONFLICT (org_id, provider) DO UPDATE
       SET credential_encrypted = EXCLUDED.credential_encrypted,
           encryption_slot_id = EXCLUDED.encryption_slot_id,
           updated_at = clock_timestamp()
       RETURNING updated_at`,
      [input.orgId, input.provider, encrypted, slotId],
    ) as { updated_at: string | Date } | null;
  } catch {
    throw new VoiceProviderCredentialError("unavailable");
  }
  if (!row) throw new VoiceProviderCredentialError("unavailable");
  return Object.freeze({
    provider: input.provider,
    configured: true,
    updatedAt: canonicalDate(row.updated_at),
  });
}

/** Loads one root only for the authenticated tenant/provider minting boundary. */
export async function loadVoiceProviderCredential(
  input: Readonly<{
    orgId: string;
    provider: TenantBrowserVoiceProvider;
  }>,
  dependencies: VoiceProviderCredentialDependencies = defaultDependencies,
): Promise<string | null> {
  requireOrgId(input.orgId);
  requireProvider(input.provider);
  let row: StoredCredentialRow | null;
  try {
    row = await dependencies.queryOne(
      `SELECT provider, credential_encrypted, encryption_slot_id, updated_at
       FROM hacc_private.voice_provider_credentials
       WHERE org_id = $1::uuid AND provider = $2`,
      [input.orgId, input.provider],
    ) as StoredCredentialRow | null;
  } catch {
    throw new VoiceProviderCredentialError("unavailable");
  }
  if (!row) return null;
  if (
    row.provider !== input.provider
    || !SLOT_ID_PATTERN.test(row.encryption_slot_id)
    || typeof row.credential_encrypted !== "string"
    || !row.credential_encrypted.startsWith("hacc_v2:")
  ) {
    throw new VoiceProviderCredentialError("corrupt_record");
  }
  let plaintext: string;
  try {
    plaintext = dependencies.decrypt(
      row.credential_encrypted,
      context(input.orgId, input.provider, row.encryption_slot_id),
    );
  } catch {
    throw new VoiceProviderCredentialError("corrupt_record");
  }
  if (!isValidVoiceProviderCredential(plaintext)) {
    throw new VoiceProviderCredentialError("corrupt_record");
  }
  return plaintext;
}

export async function voiceProviderCredentialStatuses(
  orgId: string,
  dependencies: VoiceProviderCredentialDependencies = defaultDependencies,
): Promise<readonly VoiceProviderCredentialStatus[]> {
  requireOrgId(orgId);
  let rows: StoredCredentialRow[];
  try {
    rows = await dependencies.query(
      `SELECT provider, credential_encrypted, encryption_slot_id, updated_at
       FROM hacc_private.voice_provider_credentials
       WHERE org_id = $1::uuid AND provider = ANY($2::text[])
       ORDER BY provider`,
      [orgId, [...TENANT_BROWSER_VOICE_PROVIDERS]],
    ) as StoredCredentialRow[];
  } catch {
    throw new VoiceProviderCredentialError("unavailable");
  }
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return Object.freeze(TENANT_BROWSER_VOICE_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    if (
      row
      && (
        !SLOT_ID_PATTERN.test(row.encryption_slot_id)
        || !row.credential_encrypted.startsWith("hacc_v2:")
      )
    ) throw new VoiceProviderCredentialError("corrupt_record");
    return Object.freeze({
      provider,
      configured: Boolean(row),
      updatedAt: row ? canonicalDate(row.updated_at) : null,
    });
  }));
}

export async function deleteVoiceProviderCredential(
  input: Readonly<{
    orgId: string;
    provider: TenantBrowserVoiceProvider;
  }>,
  dependencies: VoiceProviderCredentialDependencies = defaultDependencies,
): Promise<boolean> {
  requireOrgId(input.orgId);
  requireProvider(input.provider);
  try {
    const rows = await dependencies.query(
      `DELETE FROM hacc_private.voice_provider_credentials
       WHERE org_id = $1::uuid AND provider = $2
       RETURNING provider`,
      [input.orgId, input.provider],
    ) as { provider: string }[];
    return rows.length === 1 && rows[0]?.provider === input.provider;
  } catch {
    throw new VoiceProviderCredentialError("unavailable");
  }
}

/**
 * Exact loopback development uses only its process-local deployment authority;
 * a tenant root is never carried over plaintext HTTP. Outside that local mode,
 * authenticated tenant BYOK is the sole browser funding path for OpenAI/xAI.
 */
export async function resolveBrowserVoiceFundingAuthority(
  input: Readonly<{
    orgId: string;
    provider: "xai" | "openai" | "gemini";
  }>,
  dependencies: VoiceProviderCredentialDependencies = defaultDependencies,
): Promise<BrowserVoiceFundingAuthority | null> {
  requireOrgId(input.orgId);
  if (dependencies.allowsLocalFunding()) {
    // Once the process is in explicit loopback mode, never even materialize a
    // stored tenant root. A missing/invalid deployment key fails this request.
    return authorizeLocalDeploymentBrowserFunding(input.provider);
  }
  if (isTenantBrowserVoiceProvider(input.provider)) {
    const apiKey = await loadVoiceProviderCredential({
      orgId: input.orgId,
      provider: input.provider,
    }, dependencies);
    if (apiKey) {
      return Object.freeze({
        source: "tenant_byok" as const,
        provider: input.provider,
        apiKey,
      });
    }
  }
  return null;
}
