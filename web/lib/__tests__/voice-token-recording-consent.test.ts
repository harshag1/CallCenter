import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  loadActiveAgent: vi.fn(),
  buildVoiceSession: vi.fn(),
  createBrowserRealtimeConnection: vi.fn(),
  allowsLocalDevelopmentFundedAi: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/voice", () => ({
  loadActiveAgent: mocks.loadActiveAgent,
  buildVoiceSession: mocks.buildVoiceSession,
}));
vi.mock("@/lib/realtime/registry", () => ({
  createBrowserRealtimeConnection: mocks.createBrowserRealtimeConnection,
}));
vi.mock("@/lib/deployment-funded-ai", () => ({
  allowsLocalDevelopmentFundedAi: mocks.allowsLocalDevelopmentFundedAi,
}));
vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@/lib/public-origin", () => ({
  requirePublicOrigin: () => "https://voice.example.test",
}));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));
vi.mock("@/lib/http", () => ({
  isUuid: (value: unknown) => typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
}));
vi.mock("@/lib/recording-privacy", async () => import("../recording-privacy"));
vi.mock("server-only", () => ({}));

import { POST } from "../../app/api/voice/token/route";
import { recordingConsentReceiptHmac } from "../recording-consent-authority";

const APP_ORIGIN = "https://voice.example.test";
const AGENT_ID = "00000000-0000-4000-8000-000000000031";
const CALL_ID = "00000000-0000-4000-8000-000000000032";
const CONSENT_ID = "00000000-0000-4000-8000-000000000033";
const MCP_SECRET = "recording-consent-test-secret-that-is-at-least-32-bytes";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${APP_ORIGIN}/api/voice/token`, {
    method: "POST",
    headers: {
      origin: APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function consent() {
  return {
    granted: true,
    consentId: CONSENT_ID,
    grantedAt: new Date(Date.now()).toISOString(),
    noticeVersion: "recording-v1",
    retentionDays: 7,
  };
}

describe("voice token recording-consent boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", APP_ORIGIN);
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(true);
    vi.stubEnv("CALL_RECORDING_RETENTION_DAYS", "30");
    vi.stubEnv("MCP_GATEWAY_SECRET", MCP_SECRET);
    mocks.getSession.mockResolvedValue({ orgId: "org-1" });
    mocks.loadActiveAgent.mockResolvedValue({ id: AGENT_ID });
    mocks.buildVoiceSession.mockResolvedValue({
      callId: CALL_ID,
      sessionSpec: { provider: "openai", model: "gpt-realtime" },
    });
    mocks.createBrowserRealtimeConnection.mockResolvedValue({
      provider: "openai",
      transport: "webrtc",
      model: "gpt-realtime",
      voice: "marin",
      endpoint: "https://api.openai.example/v1/realtime/calls",
      token: "ephemeral-token",
    });
    mocks.q.mockResolvedValue([]);
    mocks.qOne.mockResolvedValue({ id: CALL_ID });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects cross-origin token minting before session lookup", async () => {
    const response = await POST(request({ agentId: AGENT_ID }, {
      origin: "https://attacker.example",
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.createBrowserRealtimeConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Origin", { origin: "" }],
    ["null Origin", { origin: "null" }],
    ["same-site subdomain", { origin: "https://evil.example.test", "sec-fetch-site": "same-site" }],
    ["missing Fetch Metadata", { "sec-fetch-site": "" }],
  ])("rejects %s before session lookup", async (_label, headers) => {
    const response = await POST(request({ agentId: AGENT_ID }, headers));
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.createBrowserRealtimeConnection).not.toHaveBeenCalled();
  });

  it("rejects simple-form and duplicate-key bodies before session lookup", async () => {
    const simple = await POST(request({ agentId: AGENT_ID }, { "content-type": "text/plain" }));
    expect(simple.status).toBe(415);
    const duplicate = new Request(`${APP_ORIGIN}/api/voice/token`, {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: `{"agentId":"${AGENT_ID}","agent\\u0049d":"${CONSENT_ID}"}`,
    });
    expect((await POST(duplicate)).status).toBe(400);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("fails production deployment-funded sessions closed under direct, repeated, and concurrent attempts", async () => {
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(false);

    const responses = await Promise.all(
      Array.from({ length: 12 }, () => POST(request({ agentId: AGENT_ID }))),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(503));
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual(
      Array(12).fill({ error: "deployment_funded_ai_disabled" }),
    );
    expect(mocks.getSession).toHaveBeenCalledTimes(12);
    expect(mocks.loadActiveAgent).not.toHaveBeenCalled();
    expect(mocks.buildVoiceSession).not.toHaveBeenCalled();
    expect(mocks.createBrowserRealtimeConnection).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("denies a direct request before allocating a call or minting a token when funded authority is unavailable", async () => {
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(false);
    const response = await POST(request({ agentId: AGENT_ID }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "deployment_funded_ai_disabled" });
    expect(mocks.loadActiveAgent).not.toHaveBeenCalled();
    expect(mocks.buildVoiceSession).not.toHaveBeenCalled();
    expect(mocks.createBrowserRealtimeConnection).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("mints a private token without enabling recording by default", async () => {
    const response = await POST(request({ agentId: AGENT_ID }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const payload = await response.json();
    expect(payload).toMatchObject({ callId: CALL_ID });
    expect(payload).not.toHaveProperty("recordingUploadToken");
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.createBrowserRealtimeConnection).toHaveBeenCalledTimes(1);
  });

  it("stores canonical consent before returning a provider connection", async () => {
    const receipt = consent();
    const response = await POST(request({ agentId: AGENT_ID, recordingConsent: receipt }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.recordingUploadToken).toMatch(/^rec_[A-Za-z0-9_-]{43}$/);
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
    const [sql, args] = mocks.qOne.mock.calls[0];
    const receiptHmac = recordingConsentReceiptHmac(CONSENT_ID);
    const uploadTokenHash = createHash("sha256").update(payload.recordingUploadToken).digest("hex");
    const uploadExpiresAt = new Date(Date.parse(receipt.grantedAt) + 2 * 60 * 60_000).toISOString();
    expect(sql).toContain("INSERT INTO recording_consent_receipts");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("c.direction = 'web' AND c.status = 'active'");
    expect(sql).toContain("recording_consent");
    expect(args[0]).toBe(CALL_ID);
    expect(args[1]).toBe("org-1");
    expect(args[2]).toBe(receiptHmac);
    expect(JSON.parse(args[8])).toEqual({
      granted: true,
      receipt_hmac_sha256: receiptHmac,
      granted_at: receipt.grantedAt,
      notice_version: "recording-v1",
      retention_days: 7,
      source: "authenticated_web_session",
      upload_token_hash: uploadTokenHash,
      upload_expires_at: uploadExpiresAt,
    });
    expect(JSON.stringify(args)).not.toContain(CONSENT_ID);
    expect(JSON.stringify(args)).not.toContain(payload.recordingUploadToken);
    expect(mocks.qOne.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createBrowserRealtimeConnection.mock.invocationCallOrder[0],
    );
  });

  it("consumes a consent receipt once and fails the allocated call before provider construction on replay", async () => {
    mocks.qOne.mockResolvedValueOnce(null);
    const response = await POST(request({ agentId: AGENT_ID, recordingConsent: consent() }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "recording consent was already used" });
    expect(mocks.createBrowserRealtimeConnection).not.toHaveBeenCalled();
    expect(mocks.q).toHaveBeenCalledWith(
      "UPDATE calls SET status = 'failed', ended_at = now() WHERE id = $1",
      [CALL_ID],
    );
  });

  it("separates recording-authority configuration and database failures from provider failures", async () => {
    vi.stubEnv("MCP_GATEWAY_SECRET", "short");
    const unsafe = await POST(request({ agentId: AGENT_ID, recordingConsent: consent() }));
    expect(unsafe.status).toBe(500);
    expect(await unsafe.json()).toEqual({ error: "recording authority is not configured safely" });
    expect(mocks.createBrowserRealtimeConnection).not.toHaveBeenCalled();

    vi.stubEnv("MCP_GATEWAY_SECRET", MCP_SECRET);
    mocks.qOne.mockRejectedValueOnce(new Error("database unavailable"));
    const unavailable = await POST(request({ agentId: AGENT_ID, recordingConsent: consent() }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "recording authority unavailable" });
    expect(mocks.createBrowserRealtimeConnection).not.toHaveBeenCalled();
  });

  it("rejects stale consent and unknown request fields before creating a call", async () => {
    const stale = { ...consent(), grantedAt: "2000-01-01T00:00:00.000Z" };
    expect((await POST(request({ agentId: AGENT_ID, recordingConsent: stale }))).status).toBe(400);
    expect((await POST(request({
      agentId: AGENT_ID,
      recordingConsent: { ...consent(), noticeVersion: "never-displayed" },
    }))).status).toBe(400);
    expect((await POST(request({ agentId: AGENT_ID, admin: true }))).status).toBe(400);
    expect(mocks.loadActiveAgent).not.toHaveBeenCalled();
    expect(mocks.buildVoiceSession).not.toHaveBeenCalled();
  });

  it("fails the allocated call closed without reflecting provider secrets", async () => {
    mocks.createBrowserRealtimeConnection.mockRejectedValueOnce(
      new Error("upstream rejected sk-do-not-reflect"),
    );
    const response = await POST(request({ agentId: AGENT_ID }));
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).toBe('{"error":"voice provider unavailable"}');
    expect(text).not.toContain("sk-do-not-reflect");
    expect(mocks.q).toHaveBeenCalledWith(
      "UPDATE calls SET status = 'failed', ended_at = now() WHERE id = $1",
      [CALL_ID],
    );
  });
});
