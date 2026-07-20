export const RECORDING_CONSENT_NOTICE_VERSION = "recording-v1" as const;
export const RECORDING_CONSENT_MAX_AGE_MS = 15 * 60_000;
export const RECORDING_CONSENT_FUTURE_SKEW_MS = 60_000;
export const RECORDING_UPLOAD_TTL_MS = 2 * 60 * 60_000;
export const DEFAULT_RECORDING_RETENTION_DAYS = 30;
export const MAX_RECORDING_RETENTION_DAYS = 365;
export const MAX_BROWSER_RECORDING_BYTES = 25 * 1024 * 1024;
export const RECORDING_UPLOAD_TOKEN_PATTERN = /^rec_[A-Za-z0-9_-]{43}$/;
export const RECORDING_UPLOAD_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const RECORDING_CONSENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECORDING_BODY_CHUNKS = 4096;
const ALLOWED_BROWSER_RECORDING_MIMES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
]);

export type RecordingConsent = Readonly<{
  granted: true;
  consentId: string;
  grantedAt: string;
  noticeVersion: string;
  retentionDays?: number;
}>;

export type StoredRecordingConsent = Readonly<{
  granted: true;
  receipt_hmac_sha256: string;
  granted_at: string;
  notice_version: typeof RECORDING_CONSENT_NOTICE_VERSION;
  retention_days: number;
  source: "authenticated_web_session";
  upload_token_hash: string;
  upload_expires_at: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

export function parseRecordingConsent(value: unknown, nowMs = Date.now()): RecordingConsent | null {
  if (!isRecord(value) || !exactKeys(
    value,
    ["granted", "consentId", "grantedAt", "noticeVersion"],
    ["retentionDays"],
  )) return null;
  if (value.granted !== true || typeof value.consentId !== "string"
    || !RECORDING_CONSENT_ID_PATTERN.test(value.consentId)) return null;
  if (typeof value.grantedAt !== "string" || value.noticeVersion !== RECORDING_CONSENT_NOTICE_VERSION) return null;
  const grantedAtMs = Date.parse(value.grantedAt);
  if (!Number.isFinite(grantedAtMs)
    || grantedAtMs < nowMs - RECORDING_CONSENT_MAX_AGE_MS
    || grantedAtMs > nowMs + RECORDING_CONSENT_FUTURE_SKEW_MS) return null;
  if (new Date(grantedAtMs).toISOString() !== value.grantedAt) return null;
  if (value.retentionDays !== undefined
    && (typeof value.retentionDays !== "number" || !Number.isInteger(value.retentionDays) || value.retentionDays < 1
      || value.retentionDays > MAX_RECORDING_RETENTION_DAYS)) return null;
  return Object.freeze({
    granted: true,
    consentId: value.consentId,
    grantedAt: value.grantedAt,
    noticeVersion: value.noticeVersion,
    ...(value.retentionDays === undefined ? {} : { retentionDays: value.retentionDays as number }),
  });
}

export function configuredRecordingRetentionDays(
  raw: string | undefined,
  requested?: number,
): number {
  const configured = raw === undefined || raw === ""
    ? DEFAULT_RECORDING_RETENTION_DAYS
    : /^\d+$/.test(raw)
      ? Number(raw)
      : Number.NaN;
  if (!Number.isInteger(configured) || configured < 1 || configured > MAX_RECORDING_RETENTION_DAYS) {
    throw new Error(`CALL_RECORDING_RETENTION_DAYS must be an integer from 1 to ${MAX_RECORDING_RETENTION_DAYS}`);
  }
  if (requested === undefined) return configured;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_RECORDING_RETENTION_DAYS) {
    throw new Error("requested recording retention is invalid");
  }
  // A caller may request less retention, never more than the operator ceiling.
  return Math.min(configured, requested);
}

export function storedRecordingConsent(
  consent: RecordingConsent,
  configuredDays: number,
  uploadTokenHash: string,
  receiptHmacSha256: string,
): StoredRecordingConsent {
  if (!RECORDING_UPLOAD_TOKEN_HASH_PATTERN.test(uploadTokenHash)) {
    throw new Error("recording upload token hash is invalid");
  }
  if (!RECORDING_UPLOAD_TOKEN_HASH_PATTERN.test(receiptHmacSha256)) {
    throw new Error("recording consent receipt HMAC is invalid");
  }
  const uploadExpiresAt = new Date(Date.parse(consent.grantedAt) + RECORDING_UPLOAD_TTL_MS).toISOString();
  return Object.freeze({
    granted: true,
    receipt_hmac_sha256: receiptHmacSha256,
    granted_at: consent.grantedAt,
    notice_version: RECORDING_CONSENT_NOTICE_VERSION,
    retention_days: configuredRecordingRetentionDays(String(configuredDays), consent.retentionDays),
    source: "authenticated_web_session" as const,
    upload_token_hash: uploadTokenHash,
    upload_expires_at: uploadExpiresAt,
  });
}

export function parseStoredRecordingConsent(metadata: unknown): StoredRecordingConsent | null {
  if (!isRecord(metadata) || !isRecord(metadata.recording_consent)) return null;
  const value = metadata.recording_consent;
  if (!exactKeys(value, [
    "granted", "receipt_hmac_sha256", "granted_at", "notice_version", "retention_days", "source",
    "upload_token_hash", "upload_expires_at",
  ])) return null;
  if (value.granted !== true || value.source !== "authenticated_web_session"
    || typeof value.receipt_hmac_sha256 !== "string"
    || !RECORDING_UPLOAD_TOKEN_HASH_PATTERN.test(value.receipt_hmac_sha256)
    || typeof value.granted_at !== "string" || !Number.isFinite(Date.parse(value.granted_at))
    || value.notice_version !== RECORDING_CONSENT_NOTICE_VERSION
    || !Number.isInteger(value.retention_days) || Number(value.retention_days) < 1
    || Number(value.retention_days) > MAX_RECORDING_RETENTION_DAYS
    || typeof value.upload_token_hash !== "string"
    || !RECORDING_UPLOAD_TOKEN_HASH_PATTERN.test(value.upload_token_hash)
    || typeof value.upload_expires_at !== "string" || !Number.isFinite(Date.parse(value.upload_expires_at))
    || Date.parse(value.upload_expires_at) !== Date.parse(value.granted_at) + RECORDING_UPLOAD_TTL_MS
    || new Date(Date.parse(value.upload_expires_at)).toISOString() !== value.upload_expires_at) return null;
  return Object.freeze(value as unknown as StoredRecordingConsent);
}

export function normalizedBrowserRecordingMime(value: string | null): string | null {
  if (!value) return null;
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return ALLOWED_BROWSER_RECORDING_MIMES.has(mime) ? mime : null;
}

export class RecordingBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "recording_too_large" : "invalid_recording_body");
    this.name = "RecordingBodyError";
  }
}

export async function readBoundedRecordingBody(request: Request): Promise<Uint8Array> {
  const advertised = request.headers.get("content-length");
  if (advertised !== null) {
    if (!/^\d+$/.test(advertised)) throw new RecordingBodyError(400);
    try {
      if (BigInt(advertised) > BigInt(MAX_BROWSER_RECORDING_BYTES)) throw new RecordingBodyError(413);
    } catch (error) {
      if (error instanceof RecordingBodyError) throw error;
      throw new RecordingBodyError(400);
    }
  }
  if (!request.body) throw new RecordingBodyError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      byteLength += value.byteLength;
      if (chunkCount > MAX_RECORDING_BODY_CHUNKS || byteLength > MAX_BROWSER_RECORDING_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RecordingBodyError(413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) throw new RecordingBodyError(400);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
