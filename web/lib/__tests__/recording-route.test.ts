import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
  ulawToWav: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@/lib/audio", () => ({ ulawToWav: mocks.ulawToWav }));
vi.mock("@/lib/http", () => ({
  isUuid: (value: unknown) => typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
}));
vi.mock("@/lib/recording-privacy", async () => import("../recording-privacy"));
vi.mock("server-only", () => ({}));

import { DELETE, GET, POST } from "../../app/api/calls/[id]/recording/route";
import { recordingConsentReceiptHmac } from "../recording-consent-authority";

const APP_ORIGIN = "https://voice.example.test";
const CALL_ID = "00000000-0000-4000-8000-000000000011";
const ORG_ID = "00000000-0000-4000-8000-000000000012";
const CONSENT_ID = "00000000-0000-4000-8000-000000000013";
const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const GRANTED_AT = "2026-07-16T19:59:00.000Z";
const UPLOAD_TOKEN = `rec_${"u".repeat(43)}`;
const UPLOAD_TOKEN_HASH = createHash("sha256").update(UPLOAD_TOKEN).digest("hex");
const MCP_SECRET = "recording-consent-test-secret-that-is-at-least-32-bytes";

function storedConsent(overrides: Record<string, unknown> = {}) {
  return {
    granted: true,
    receipt_hmac_sha256: recordingConsentReceiptHmac(CONSENT_ID),
    granted_at: GRANTED_AT,
    notice_version: "recording-v1",
    retention_days: 7,
    source: "authenticated_web_session",
    upload_token_hash: UPLOAD_TOKEN_HASH,
    upload_expires_at: "2026-07-16T21:59:00.000Z",
    ...overrides,
  };
}

function ownedCall(overrides: Record<string, unknown> = {}) {
  return {
    id: CALL_ID,
    direction: "web",
    status: "active",
    metadata: { recording_consent: storedConsent() },
    ...overrides,
  };
}

function context() {
  return { params: Promise.resolve({ id: CALL_ID }) };
}

function mutationRequest(method: "POST" | "DELETE", options: {
  body?: BodyInit;
  headers?: Record<string, string>;
  origin?: string;
} = {}) {
  return new Request(`${APP_ORIGIN}/api/calls/${CALL_ID}/recording`, {
    method,
    headers: {
      origin: options.origin ?? APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(method === "POST" ? {
        "content-type": "audio/webm;codecs=opus",
        "x-recording-consent-id": CONSENT_ID,
        "x-recording-upload-token": UPLOAD_TOKEN,
      } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

describe("call recording privacy route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", APP_ORIGIN);
    vi.stubEnv("CALL_RECORDING_RETENTION_DAYS", "30");
    vi.stubEnv("MCP_GATEWAY_SECRET", MCP_SECRET);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    mocks.getSession.mockResolvedValue({ orgId: ORG_ID });
    mocks.q.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects cross-origin writes before authentication or database access", async () => {
    const response = await POST(mutationRequest("POST", {
      origin: "https://attacker.example",
      body: Uint8Array.from([1]),
    }), context());

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Origin", { origin: "" }],
    ["null Origin", { origin: "null" }],
    ["same-site subdomain", { origin: "https://evil.example.test", "sec-fetch-site": "same-site" }],
    ["missing Fetch Metadata", { "sec-fetch-site": "" }],
  ])("rejects %s before authentication or database access", async (_label, headers) => {
    const response = await POST(mutationRequest("POST", {
      body: Uint8Array.from([1]),
      headers,
    }), context());
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Origin", { origin: "" }],
    ["null Origin", { origin: "null" }],
    ["same-site subdomain", { origin: "https://evil.example.test", "sec-fetch-site": "same-site" }],
    ["missing Fetch Metadata", { "sec-fetch-site": "" }],
  ])("rejects DELETE with %s before authentication or database access", async (_label, headers) => {
    const response = await DELETE(mutationRequest("DELETE", { headers }), context());
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("requires an active owned web call with matching stored consent", async () => {
    mocks.qOne.mockResolvedValueOnce(ownedCall({ status: "ended" }));
    expect((await POST(mutationRequest("POST", {
      body: Uint8Array.from([1]),
    }), context())).status).toBe(409);

    mocks.qOne.mockResolvedValueOnce(ownedCall());
    expect((await POST(mutationRequest("POST", {
      body: Uint8Array.from([1]),
      headers: { "x-recording-consent-id": "00000000-0000-4000-8000-000000000099" },
    }), context())).status).toBe(403);

    mocks.qOne.mockResolvedValueOnce(ownedCall({ direction: "inbound" }));
    expect((await POST(mutationRequest("POST", {
      body: Uint8Array.from([1]),
    }), context())).status).toBe(404);

    mocks.qOne.mockResolvedValueOnce(ownedCall());
    expect((await POST(mutationRequest("POST", {
      body: Uint8Array.from([1]),
      headers: { "x-recording-upload-token": `rec_${"v".repeat(43)}` },
    }), context())).status).toBe(403);
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("rejects malformed recording capability headers before database or body access", async () => {
    const response = await POST(mutationRequest("POST", {
      body: Uint8Array.from([1]),
      headers: { "x-recording-consent-id": "not-a-uuid" },
    }), context());
    expect(response.status).toBe(403);
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("persists a bounded consent-bound recording with TTL anchored to consent", async () => {
    mocks.qOne
      .mockResolvedValueOnce(ownedCall())
      .mockResolvedValueOnce({ id: CALL_ID });
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const response = await POST(mutationRequest("POST", { body: bytes }), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      byteLength: 4,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      retainedUntil: "2026-07-23T19:59:00.000Z",
    });
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).toHaveBeenCalledTimes(2);
    const [insertSql, insertArgs] = mocks.qOne.mock.calls[1];
    expect(insertSql).toContain("c.metadata->'recording_consent' = $3::jsonb");
    expect(insertSql).toContain("JOIN recording_consent_receipts receipt");
    expect(insertSql).toContain("receipt.upload_token_hash = (($3::jsonb)->>'upload_token_hash')");
    expect(insertSql).toContain("receipt.upload_expires_at > statement_timestamp()");
    expect(insertSql).toContain("c.status = 'active'");
    expect(insertSql).toContain("NOT (c.metadata ? 'recording_deletion')");
    expect(insertSql).toContain("'replaced'");
    expect(insertSql).toContain("'recording_upload_consumed_at'");
    expect(insertSql).toContain("- 'upload_token_hash'");
    expect(insertArgs).toEqual([
      CALL_ID,
      ORG_ID,
      JSON.stringify(storedConsent()),
      "audio/webm",
      expect.any(Buffer),
      recordingConsentReceiptHmac(CONSENT_ID),
      GRANTED_AT,
      "recording-v1",
      "2026-07-23T19:59:00.000Z",
      4,
      body.sha256,
      `db:${CALL_ID}`,
    ]);
    expect(Array.from(insertArgs[4] as Buffer)).toEqual(Array.from(bytes));
  });

  it("fails a final locked authority recheck instead of persisting across a consent race", async () => {
    mocks.qOne
      .mockResolvedValueOnce(ownedCall())
      .mockResolvedValueOnce(null);
    const response = await POST(mutationRequest("POST", { body: Uint8Array.from([1, 2]) }), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "recording authority changed" });
    expect(mocks.qOne.mock.calls[1][0]).toContain("FOR UPDATE OF c");
  });

  it("fails the final database clock check when a slow body crosses upload expiry", async () => {
    mocks.qOne
      .mockResolvedValueOnce(ownedCall({
        metadata: {
          recording_consent: storedConsent({
            granted_at: "2026-07-16T18:00:00.001Z",
            upload_expires_at: "2026-07-16T20:00:00.001Z",
          }),
        },
      }))
      .mockResolvedValueOnce(null);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const response = await POST(mutationRequest("POST", { body: Uint8Array.from([1, 2]) }), context());
    expect(response.status).toBe(409);
    expect(mocks.qOne.mock.calls[1][0]).toContain("receipt.upload_expires_at > statement_timestamp()");
  });

  it("consumes an upload capability once so an exact replay cannot overwrite the recording", async () => {
    mocks.qOne
      .mockResolvedValueOnce(ownedCall())
      .mockResolvedValueOnce({ id: CALL_ID })
      .mockResolvedValueOnce(ownedCall({
        metadata: {
          recording_consent: {
            ...storedConsent(),
            upload_token_hash: undefined,
          },
        },
      }));
    expect((await POST(mutationRequest("POST", { body: Uint8Array.from([1]) }), context())).status).toBe(200);
    expect((await POST(mutationRequest("POST", { body: Uint8Array.from([1]) }), context())).status).toBe(403);
    expect(mocks.qOne).toHaveBeenCalledTimes(3);
  });

  it("rejects unsupported, oversized, and expired recording uploads", async () => {
    mocks.qOne.mockResolvedValueOnce(ownedCall());
    expect((await POST(mutationRequest("POST", {
      body: Uint8Array.from([1]),
      headers: { "content-type": "text/html" },
    }), context())).status).toBe(415);

    mocks.qOne.mockResolvedValueOnce(ownedCall());
    expect((await POST(mutationRequest("POST", {
      body: Uint8Array.from([1]),
      headers: { "content-length": String(25 * 1024 * 1024 + 1) },
    }), context())).status).toBe(413);

    mocks.qOne.mockResolvedValueOnce(ownedCall({
      metadata: {
        recording_consent: storedConsent({
          granted_at: "2026-07-16T17:59:00.000Z",
          upload_expires_at: "2026-07-16T19:59:00.000Z",
        }),
      },
    }));
    const expired = await POST(mutationRequest("POST", {
      body: Uint8Array.from([1]),
    }), context());
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "recording upload authority expired" });
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("serves a private recording and supports explicit download export", async () => {
    mocks.qOne.mockResolvedValueOnce({
      mime: "audio/webm",
      data: Buffer.from([8, 9, 10]),
      retained_until: "2026-07-23T19:59:00.000Z",
      sha256: "a".repeat(64),
      consent_notice_version: "recording-v1",
    });
    const response = await GET(
      new Request(`${APP_ORIGIN}/api/calls/${CALL_ID}/recording?download=1`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="call-${CALL_ID}.webm"`);
    expect(response.headers.get("etag")).toBe(`"sha256-${"a".repeat(64)}"`);
    expect(response.headers.get("x-recording-retained-until")).toBe("2026-07-23T19:59:00.000Z");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([8, 9, 10]);
    expect(mocks.q).toHaveBeenCalledTimes(1);
  });

  it("forces hostile legacy MIME to an inert attachment with a sandboxed response", async () => {
    mocks.qOne.mockResolvedValueOnce({
      mime: "text/html",
      data: Buffer.from("<script>alert(1)</script>"),
      retained_until: "2026-07-23T19:59:00.000Z",
      sha256: null,
      consent_notice_version: "recording-v1",
    });
    const response = await GET(new Request(`${APP_ORIGIN}/api/calls/${CALL_ID}/recording`), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="call-${CALL_ID}.bin"`);
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns not found after the lazy expiration gate finds no retained recording", async () => {
    mocks.qOne.mockResolvedValueOnce(null);
    const response = await GET(
      new Request(`${APP_ORIGIN}/api/calls/${CALL_ID}/recording`),
      context(),
    );
    expect(response.status).toBe(404);
    expect(mocks.q).toHaveBeenCalledTimes(1);
    expect(mocks.q.mock.calls[0][0]).toContain("retention_expired");
    const playbackSql = mocks.qOne.mock.calls[0][0];
    expect(playbackSql).toContain("JOIN recording_consent_receipts receipt");
    expect(playbackSql).toContain("r.consent_receipt_hmac_sha256 IS NOT NULL");
    expect(playbackSql).toContain("r.consent_granted_at IS NOT NULL");
    expect(playbackSql).toContain("r.consent_notice_version IS NOT NULL");
    expect(playbackSql).toContain("c.metadata->'recording_consent'->>'granted' = 'true'");
    expect(playbackSql).toContain("c.metadata->'recording_consent'->>'source' = 'authenticated_web_session'");
    expect(playbackSql).toContain("receipt.granted_at = r.consent_granted_at");
    expect(playbackSql).toContain("receipt.notice_version = r.consent_notice_version");
    expect(playbackSql).toContain("NOT (c.metadata ? 'recording_deletion')");
  });

  it("deletes an owned recording atomically and is idempotent", async () => {
    mocks.qOne.mockResolvedValueOnce({ authorized: true, deleted: true });
    const deleted = await DELETE(mutationRequest("DELETE"), context());
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, deleted: true });
    expect(mocks.qOne.mock.calls[0][0]).toContain("user_deleted");
    expect(mocks.qOne.mock.calls[0][0]).toContain("recording_deletion");
    expect(mocks.qOne.mock.calls[0][0]).toContain("- 'recording_consent'");

    mocks.qOne.mockResolvedValueOnce({ authorized: true, deleted: false });
    const replay = await DELETE(mutationRequest("DELETE"), context());
    expect(await replay.json()).toEqual({ ok: true, deleted: false });
  });

  it("makes a DELETE tombstone win over attempted POST recreation", async () => {
    mocks.qOne
      .mockResolvedValueOnce({ authorized: true, deleted: true })
      .mockResolvedValueOnce(ownedCall({
        metadata: {
          recording_deletion: { deleted_at: "2026-07-16T20:00:00.000Z", actor: "authenticated_org_session" },
        },
      }));
    expect((await DELETE(mutationRequest("DELETE"), context())).status).toBe(200);
    const recreated = await POST(mutationRequest("POST", { body: Uint8Array.from([1]) }), context());
    expect(recreated.status).toBe(403);
    expect(mocks.qOne).toHaveBeenCalledTimes(2);
  });
});
