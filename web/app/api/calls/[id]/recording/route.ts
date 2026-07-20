// Consent-bound upload, private playback/export, deletion, and lazy retention enforcement.

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { ulawToWav } from "@/lib/audio";
import { isUuid } from "@/lib/http";
import { recordingConsentReceiptHmac } from "@/lib/recording-consent-authority";
import {
  assertSameOriginBrowserMutation,
  PrivateRequestError,
} from "@/lib/private-json-request";
import {
  RecordingBodyError,
  configuredRecordingRetentionDays,
  normalizedBrowserRecordingMime,
  parseStoredRecordingConsent,
  readBoundedRecordingBody,
  RECORDING_CONSENT_ID_PATTERN,
  RECORDING_UPLOAD_TOKEN_PATTERN,
  type StoredRecordingConsent,
} from "@/lib/recording-privacy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

type OwnedCall = {
  id: string;
  direction: string;
  status: string;
  metadata: unknown;
};

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function invalidMutationResponse(error: unknown): Response {
  return json({ error: "forbidden" }, error instanceof PrivateRequestError ? error.status : 403);
}

function equalAscii(left: string, right: string): boolean {
  const supplied = Buffer.from(left, "ascii");
  const expected = Buffer.from(right, "ascii");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function matchesUploadAuthority(
  rawConsentId: string | null,
  rawUploadToken: string | null,
  consent: StoredRecordingConsent,
): boolean {
  if (!rawConsentId || !rawUploadToken || !RECORDING_UPLOAD_TOKEN_PATTERN.test(rawUploadToken)) return false;
  const receiptHmac = recordingConsentReceiptHmac(rawConsentId);
  const uploadHash = createHash("sha256").update(rawUploadToken).digest("hex");
  return equalAscii(receiptHmac, consent.receipt_hmac_sha256)
    && equalAscii(uploadHash, consent.upload_token_hash);
}

async function ownedCall(callId: string, orgId: string): Promise<OwnedCall | null> {
  return qOne<OwnedCall>(
    `SELECT c.id, c.direction, c.status, c.metadata
     FROM calls c JOIN agents a ON a.id = c.agent_id
     WHERE c.id = $1 AND a.org_id = $2`,
    [callId, orgId],
  );
}

async function expireOwnedRecording(callId: string, orgId: string): Promise<void> {
  await q(
    `WITH deletion_context AS MATERIALIZED (
       SELECT set_config('hacc.recording_delete_reason', 'retention_expired', true),
              set_config('hacc.recording_delete_actor', 'request_lifecycle_gate', true)
     ), target AS (
       SELECT r.call_id
       FROM call_recordings r
       JOIN calls c ON c.id = r.call_id
       JOIN agents a ON a.id = c.agent_id
       WHERE r.call_id = $1 AND a.org_id = $2 AND r.retained_until <= now()
       FOR UPDATE OF r
     ), deleted AS (
       DELETE FROM call_recordings r USING target t, deletion_context
       WHERE r.call_id = t.call_id
       RETURNING r.call_id
     )
     UPDATE calls SET recording_path = NULL
     WHERE id IN (SELECT call_id FROM deleted)`,
    [callId, orgId],
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginBrowserMutation(req);
  } catch (error) {
    return invalidMutationResponse(error);
  }
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "not found" }, 404);
  const suppliedConsentId = req.headers.get("x-recording-consent-id");
  const suppliedUploadToken = req.headers.get("x-recording-upload-token");
  if (!suppliedConsentId || !RECORDING_CONSENT_ID_PATTERN.test(suppliedConsentId)
    || !suppliedUploadToken || !RECORDING_UPLOAD_TOKEN_PATTERN.test(suppliedUploadToken)) {
    return json({ error: "recording consent required" }, 403);
  }
  const call = await ownedCall(id, session.orgId);
  if (!call || call.direction !== "web") return json({ error: "not found" }, 404);
  if (call.status !== "active") return json({ error: "call is not active" }, 409);
  const consent = parseStoredRecordingConsent(call.metadata);
  let uploadAuthorityMatches = false;
  try {
    uploadAuthorityMatches = Boolean(consent) && matchesUploadAuthority(
      suppliedConsentId,
      suppliedUploadToken,
      consent!,
    );
  } catch {
    return json({ error: "recording authority is not configured safely" }, 500);
  }
  if (!consent || !uploadAuthorityMatches) {
    return json({ error: "recording consent required" }, 403);
  }
  if (Date.parse(consent.upload_expires_at) <= Date.now()) {
    return json({ error: "recording upload authority expired" }, 410);
  }
  const mime = normalizedBrowserRecordingMime(req.headers.get("content-type"));
  if (!mime) return json({ error: "unsupported recording type" }, 415);
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedRecordingBody(req);
  } catch (error) {
    if (error instanceof RecordingBodyError) return json({ error: error.message }, error.status);
    return json({ error: "invalid_recording_body" }, 400);
  }
  let retentionDays: number;
  try {
    retentionDays = configuredRecordingRetentionDays(
      process.env.CALL_RECORDING_RETENTION_DAYS,
      consent.retention_days,
    );
  } catch {
    return json({ error: "recording retention is not configured safely" }, 500);
  }
  // Anchor retention to the consent instant so replayed uploads cannot renew TTL.
  const retainedUntilMs = Date.parse(consent.granted_at) + retentionDays * 86_400_000;
  if (!Number.isFinite(retainedUntilMs) || retainedUntilMs <= Date.now()) {
    return json({ error: "recording retention expired" }, 410);
  }
  const retainedUntil = new Date(retainedUntilMs).toISOString();
  const digest = createHash("sha256").update(bytes).digest("hex");
  const persisted = await qOne<{ id: string }>(
    `WITH authority AS (
       SELECT c.id, a.org_id
       FROM calls c
       JOIN agents a ON a.id = c.agent_id
       JOIN recording_consent_receipts receipt
         ON receipt.call_id = c.id
        AND receipt.org_id = a.org_id
        AND receipt.receipt_hmac_sha256 = $6
        AND receipt.granted_at = $7::timestamptz
        AND receipt.notice_version = $8
        AND receipt.retention_days = (($3::jsonb)->>'retention_days')::integer
        AND receipt.upload_token_hash = (($3::jsonb)->>'upload_token_hash')
        AND receipt.upload_expires_at = (($3::jsonb)->>'upload_expires_at')::timestamptz
       WHERE c.id = $1 AND a.org_id = $2
         AND c.direction = 'web' AND c.status = 'active'
         AND c.metadata->'recording_consent' = $3::jsonb
         AND NOT (c.metadata ? 'recording_deletion')
         AND receipt.upload_expires_at > statement_timestamp()
       FOR UPDATE OF c
     ), prior AS (
       SELECT r.call_id, r.byte_length, r.sha256, r.consent_id,
              r.consent_receipt_hmac_sha256, r.retained_until, authority.org_id
       FROM call_recordings r JOIN authority ON authority.id = r.call_id
       FOR UPDATE OF r
     ), audited_replacement AS (
       INSERT INTO call_recording_deletions (
         call_id, org_id, reason, actor, byte_length, sha256, consent_id,
         consent_receipt_hmac_sha256, retained_until
       )
       SELECT call_id, org_id, 'replaced', 'authenticated_upload_replacement',
              byte_length, sha256, consent_id, consent_receipt_hmac_sha256, retained_until
       FROM prior
       RETURNING call_id
     ), upserted AS (
       INSERT INTO call_recordings (
         call_id, mime, data, consent_receipt_hmac_sha256, consent_granted_at,
         consent_notice_version, retained_until, byte_length, sha256, updated_at
       )
       SELECT authority.id,$4,$5,$6,$7,$8,$9,$10,$11,now()
       FROM authority
       ON CONFLICT (call_id) DO UPDATE SET
         mime = EXCLUDED.mime,
         data = EXCLUDED.data,
         consent_id = NULL,
         consent_receipt_hmac_sha256 = EXCLUDED.consent_receipt_hmac_sha256,
         consent_granted_at = EXCLUDED.consent_granted_at,
         consent_notice_version = EXCLUDED.consent_notice_version,
         retained_until = EXCLUDED.retained_until,
         byte_length = EXCLUDED.byte_length,
         sha256 = EXCLUDED.sha256,
         updated_at = now()
       RETURNING call_id
     ), updated AS (
       UPDATE calls c
       SET recording_path = $12,
           metadata = jsonb_set(
             COALESCE(c.metadata, '{}'::jsonb)
               || jsonb_build_object('recording_upload_consumed_at', now()),
             '{recording_consent}',
             (c.metadata->'recording_consent') - 'upload_token_hash',
             false
           )
       FROM upserted u WHERE c.id = u.call_id
       RETURNING c.id
     )
     SELECT id FROM updated`,
    [
      id, session.orgId, JSON.stringify(consent), mime, Buffer.from(bytes), consent.receipt_hmac_sha256,
      consent.granted_at, consent.notice_version, retainedUntil, bytes.byteLength, digest, `db:${id}`,
    ],
  );
  if (!persisted) return json({ error: "recording authority changed" }, 409);
  return json({
    ok: true,
    byteLength: bytes.byteLength,
    sha256: digest,
    retainedUntil,
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "not found" }, 404);
  await expireOwnedRecording(id, session.orgId);
  const rec = await qOne<{
    mime: string;
    data: Buffer;
    retained_until: string;
    sha256: string | null;
    consent_notice_version: string | null;
  }>(
    `SELECT r.mime, r.data, r.retained_until, r.sha256, r.consent_notice_version
     FROM call_recordings r
     JOIN calls c ON c.id = r.call_id
     JOIN agents a ON a.id = c.agent_id
     JOIN recording_consent_receipts receipt
       ON receipt.call_id = r.call_id
      AND receipt.org_id = a.org_id
      AND receipt.receipt_hmac_sha256 = r.consent_receipt_hmac_sha256
      AND receipt.granted_at = r.consent_granted_at
      AND receipt.notice_version = r.consent_notice_version
     WHERE r.call_id = $1 AND a.org_id = $2 AND r.retained_until > now()
       AND r.consent_receipt_hmac_sha256 IS NOT NULL AND r.consent_granted_at IS NOT NULL
       AND r.consent_notice_version IS NOT NULL
       AND c.metadata->'recording_consent'->>'granted' = 'true'
       AND c.metadata->'recording_consent'->>'source' = 'authenticated_web_session'
       AND c.metadata->'recording_consent'->>'receipt_hmac_sha256' = r.consent_receipt_hmac_sha256
       AND c.metadata->'recording_consent'->>'notice_version' = r.consent_notice_version
       AND NOT (c.metadata ? 'recording_deletion')`,
    [id, session.orgId],
  );
  if (!rec) return json({ error: "not found" }, 404);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const isUlaw = /^audio\/basic(?:;\s*rate=8000)?$/i.test(rec.mime);
  const browserMime = normalizedBrowserRecordingMime(rec.mime);
  const safeInline = isUlaw || browserMime !== null;
  const data = isUlaw ? new Uint8Array(ulawToWav(rec.data)) : new Uint8Array(rec.data);
  const mime = isUlaw ? "audio/wav" : browserMime ?? "application/octet-stream";
  const extension = mime === "audio/wav" ? "wav"
    : mime === "audio/ogg" ? "ogg"
      : mime === "audio/mp4" ? "m4a"
        : mime === "audio/webm" ? "webm" : "bin";
  return new Response(data, {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": mime,
      "Content-Length": String(data.byteLength),
      "Content-Disposition": `${download || !safeInline ? "attachment" : "inline"}; filename="call-${id}.${extension}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Recording-Retained-Until": new Date(rec.retained_until).toISOString(),
      ...(rec.consent_notice_version ? { "X-Recording-Consent-Notice": rec.consent_notice_version } : {}),
      ...(rec.sha256 ? { ETag: `"sha256-${rec.sha256}"` } : {}),
    },
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginBrowserMutation(req);
  } catch (error) {
    return invalidMutationResponse(error);
  }
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "not found" }, 404);
  const outcome = await qOne<{ authorized: boolean; deleted: boolean }>(
    `WITH authority AS (
       SELECT c.id
       FROM calls c JOIN agents a ON a.id = c.agent_id
       WHERE c.id = $1 AND a.org_id = $2
       FOR UPDATE OF c
     ), deletion_context AS MATERIALIZED (
       SELECT set_config('hacc.recording_delete_reason', 'user_deleted', true),
              set_config('hacc.recording_delete_actor', 'authenticated_org_session', true)
     ), target AS (
       SELECT r.call_id
       FROM call_recordings r JOIN authority ON authority.id = r.call_id
       FOR UPDATE OF r
     ), deleted AS (
       DELETE FROM call_recordings r USING target t, deletion_context
       WHERE r.call_id = t.call_id
       RETURNING r.call_id
     ), revoked AS (
       UPDATE calls c
       SET recording_path = NULL,
           metadata = (COALESCE(c.metadata, '{}'::jsonb) - 'recording_consent')
             || jsonb_build_object('recording_deletion', jsonb_build_object(
                  'deleted_at', now(), 'actor', 'authenticated_org_session'
                ))
       FROM authority
       WHERE c.id = authority.id
       RETURNING c.id
     )
     SELECT EXISTS (SELECT 1 FROM authority) AS authorized,
            EXISTS (SELECT 1 FROM deleted) AS deleted`,
    [id, session.orgId],
  );
  if (!outcome?.authorized) return json({ error: "not found" }, 404);
  return json({ ok: true, deleted: outcome.deleted });
}
