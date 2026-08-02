import { createHash } from "node:crypto";
import twilioSdk from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  qOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  q: vi.fn(),
  qOne: mocks.qOne,
  getPool: vi.fn(),
}));
vi.mock("@/lib/voice", async () => import("../voice"));
vi.mock("@/lib/telephony", async () => import("../telephony"));
vi.mock("@/lib/http", async () => import("../http"));
vi.mock("@/lib/log", async () => import("../log"));

import { GET as twimlGet, POST as twimlPost } from "../../app/api/telephony/twiml/route";
import { POST as statusPost } from "../../app/api/telephony/status/route";
import { verifyTwilioStreamUpgrade, verifyTwilioWebhook } from "../telephony";
import { signScope, verifyScope } from "../voice";

const PUBLIC_ORIGIN = "https://voice.example.test";
const SPOOFED_ORIGIN = "https://request-host.attacker.test";
const AUTH_TOKEN = "test_twilio_auth_token_123456789";
const NEXT_AUTH_TOKEN = "next_test_twilio_auth_token_987654321";
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const CALL_SID = `CA${"b".repeat(32)}`;
const CALL_ID = "00000000-0000-4000-8000-000000000011";
const AGENT_ID = "00000000-0000-4000-8000-000000000012";
const ORG_ID = "00000000-0000-4000-8000-000000000013";
const TO = "+14155550101";
const FROM = "+14155550102";
const TRANSFER = "+14155550103";
const SUBSTITUTED_TRANSFER = "+14155550104";

function objectFromForm(form: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of form) {
    const prior = result[key];
    if (prior === undefined) result[key] = value;
    else if (Array.isArray(prior)) prior.push(value);
    else result[key] = [prior, value];
  }
  return result;
}

function signedTwilioRequest(options: {
  path: string;
  method: "GET" | "POST";
  form?: URLSearchParams;
  actualOrigin?: string;
  signingOrigin?: string;
  signature?: string;
  signingToken?: string;
}): Request {
  const form = options.form ?? new URLSearchParams();
  const canonicalUrl = `${options.signingOrigin ?? PUBLIC_ORIGIN}${options.path}`;
  const signature = options.signature ?? twilioSdk.getExpectedTwilioSignature(
    options.signingToken ?? AUTH_TOKEN,
    canonicalUrl,
    options.method === "POST" ? objectFromForm(form) : {}
  );
  return new Request(`${options.actualOrigin ?? PUBLIC_ORIGIN}${options.path}`, {
    method: options.method,
    headers: {
      "X-Twilio-Signature": signature,
      ...(options.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(options.method === "POST" ? { body: form.toString() } : {}),
  });
}

function voiceIdentity(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    AccountSid: ACCOUNT_SID,
    CallSid: CALL_SID,
    To: TO,
    From: FROM,
    ...overrides,
  });
}

describe("Twilio callback trust boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T20:00:00.000Z"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", PUBLIC_ORIGIN);
    vi.stubEnv("BRIDGE_WS_URL", "wss://bridge.example.test/twilio/media");
    vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
    vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
    vi.stubEnv("TELEPHONY_RECEIPT_SECRET", "domain-specific-telephony-receipt-secret-123456789");
    vi.stubEnv("MCP_GATEWAY_SECRET", "test-capability-secret-that-is-longer-than-thirty-two-bytes");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("validates the official signature against PUBLIC_ORIGIN, never the request host", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM agents WHERE phone_number")) {
        return { id: AGENT_ID, org_id: ORG_ID, version: 1 };
      }
      if (sql.includes("INSERT INTO calls")) {
        return { id: CALL_ID, agent_id: AGENT_ID, org_id: ORG_ID, to_number: TO };
      }
      return null;
    });
    const form = voiceIdentity();

    const accepted = await twimlPost(signedTwilioRequest({
      path: "/api/telephony/twiml",
      method: "POST",
      form,
      actualOrigin: SPOOFED_ORIGIN,
    }));
    expect(accepted.status).toBe(200);
    const xml = await accepted.text();
    expect(xml).toContain('<Stream url="wss://bridge.example.test/twilio/media">');
    expect(xml).toContain('<Parameter name="mode" value="agent"/>');
    expect(xml.match(/<Parameter /g)).toHaveLength(2);
    expect(xml).not.toContain('name="capability"');
    expect(xml).not.toContain('name="scope"');
    expect(xml).not.toContain('name="callId"');
    const bridgeToken = xml.match(/<Parameter name="bridgeToken" value="([A-Za-z0-9_.-]+)"\/>/)?.[1];
    expect(bridgeToken).toBeTruthy();
    expect(
      Buffer.byteLength("bridgeToken", "utf8") + Buffer.byteLength(bridgeToken!, "utf8")
    ).toBeLessThanOrEqual(500);
    expect(verifyScope(bridgeToken!, {
      audience: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
      callId: CALL_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      bridgeOriginSha256: createHash("sha256")
        .update("wss://bridge.example.test/twilio/media", "utf8")
        .digest("hex"),
    })).not.toBeNull();
    expect(mocks.qOne).toHaveBeenCalledTimes(2);
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("AND NOT EXISTS");
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("duplicate.phone_number = $1");
    expect(String(mocks.qOne.mock.calls[1][0])).toContain("ON CONFLICT (twilio_call_sid)");
    expect(String(mocks.qOne.mock.calls[1][0])).toContain("calls.to_number = EXCLUDED.to_number");
    expect(mocks.qOne.mock.calls[1][1]).toEqual([
      AGENT_ID, 1, FROM, TO, CALL_SID, ACCOUNT_SID, ORG_ID,
    ]);

    mocks.qOne.mockClear();
    const rejected = await twimlPost(signedTwilioRequest({
      path: "/api/telephony/twiml",
      method: "POST",
      form,
      actualOrigin: SPOOFED_ORIGIN,
      signingOrigin: SPOOFED_ORIGIN,
    }));
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("validates a Media Stream upgrade against the exact configured WSS URL", () => {
    const bridgeUrl = "wss://bridge.example.test/twilio/media";
    const validSignature = twilioSdk.getExpectedTwilioSignature(AUTH_TOKEN, bridgeUrl, {});
    const requestWithSpoofedHost = new Request(`${SPOOFED_ORIGIN}/twilio/media`, {
      headers: { "X-Twilio-Signature": validSignature },
    });
    expect(verifyTwilioStreamUpgrade(requestWithSpoofedHost)).toBe(true);

    const attackerSignature = twilioSdk.getExpectedTwilioSignature(
      AUTH_TOKEN,
      `${SPOOFED_ORIGIN}/twilio/media`,
      {}
    );
    expect(verifyTwilioStreamUpgrade(new Request(`${SPOOFED_ORIGIN}/twilio/media`, {
      headers: { "X-Twilio-Signature": attackerSignature },
    }))).toBe(false);
    expect(verifyTwilioStreamUpgrade(new Request(`${SPOOFED_ORIGIN}/different-path`, {
      headers: { "X-Twilio-Signature": validSignature },
    }))).toBe(false);
  });

  it("accepts a distinct staged token across webhook and Media Stream promotion", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN_NEXT", NEXT_AUTH_TOKEN);
    const form = voiceIdentity();
    const webhook = signedTwilioRequest({
      path: "/api/telephony/twiml",
      method: "POST",
      form,
      signingToken: NEXT_AUTH_TOKEN,
    });
    await expect(verifyTwilioWebhook(webhook)).resolves.toMatchObject({
      canonicalUrl: `${PUBLIC_ORIGIN}/api/telephony/twiml`,
    });

    const bridgeUrl = "wss://bridge.example.test/twilio/media";
    const nextSignature = twilioSdk.getExpectedTwilioSignature(NEXT_AUTH_TOKEN, bridgeUrl, {});
    expect(verifyTwilioStreamUpgrade(new Request(`${SPOOFED_ORIGIN}/twilio/media`, {
      headers: { "X-Twilio-Signature": nextSignature },
    }))).toBe(true);
  });

  it("fails closed on malformed or duplicate staged token configuration", async () => {
    const form = voiceIdentity();
    const request = () => signedTwilioRequest({
      path: "/api/telephony/twiml",
      method: "POST",
      form,
    });
    vi.stubEnv("TWILIO_AUTH_TOKEN_NEXT", "too-short");
    await expect(verifyTwilioWebhook(request())).resolves.toBeNull();
    vi.stubEnv("TWILIO_AUTH_TOKEN_NEXT", AUTH_TOKEN);
    await expect(verifyTwilioWebhook(request())).resolves.toBeNull();
  });

  it("rejects unsigned TwiML and status callbacks before any database access", async () => {
    const twiml = await twimlPost(new Request(`${PUBLIC_ORIGIN}/api/telephony/twiml`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: voiceIdentity().toString(),
    }));
    expect(twiml.status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();

    const status = await statusPost(new Request(
      `${PUBLIC_ORIGIN}/api/telephony/status?callId=${CALL_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: voiceIdentity({ CallStatus: "completed", SequenceNumber: "4" }).toString(),
      }
    ));
    expect(status.status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("rejects signed duplicate parameters and oversized callback URLs before database access", async () => {
    const duplicateForm = voiceIdentity();
    duplicateForm.append("CallSid", `CA${"9".repeat(32)}`);
    const ambiguousIdentity = await twimlPost(signedTwilioRequest({
      path: "/api/telephony/twiml",
      method: "POST",
      form: duplicateForm,
    }));
    expect(ambiguousIdentity.status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();

    const duplicateQueryPath =
      `/api/telephony/status?callId=${CALL_ID}&callId=00000000-0000-4000-8000-000000000099`;
    const ambiguousCall = await statusPost(signedTwilioRequest({
      path: duplicateQueryPath,
      method: "POST",
      form: voiceIdentity({ CallStatus: "completed", SequenceNumber: "0" }),
    }));
    expect(ambiguousCall.status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();

    const oversizedPath = `/api/telephony/twiml?padding=${"a".repeat(9 * 1024)}`;
    const oversized = await twimlPost(signedTwilioRequest({
      path: oversizedPath,
      method: "POST",
      form: voiceIdentity(),
    }));
    expect(oversized.status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("accepts an officially signed status callback with identity and sequence bindings", async () => {
    mocks.qOne.mockResolvedValue({ id: CALL_ID });
    const form = voiceIdentity({ CallStatus: "ringing", SequenceNumber: "2" });
    const response = await statusPost(signedTwilioRequest({
      path: `/api/telephony/status?callId=${CALL_ID}`,
      method: "POST",
      form,
      actualOrigin: SPOOFED_ORIGIN,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, applied: true });
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
    expect(mocks.qOne.mock.calls[0][1]).toEqual([
      CALL_ID,
      CALL_SID,
      ACCOUNT_SID,
      "ringing",
      30,
      2,
      "dialing",
      false,
      TO,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("twilio_status_sequence");
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("twilio_status_rank < 100");
  });

  it("creates terminal delivery proof only from the signed monotonic completed callback", async () => {
    mocks.qOne.mockResolvedValue({ id: CALL_ID });
    const response = await statusPost(signedTwilioRequest({
      path: `/api/telephony/status?callId=${CALL_ID}`,
      method: "POST",
      form: voiceIdentity({ CallStatus: "completed", SequenceNumber: "4" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, applied: true });
    const sql = String(mocks.qOne.mock.calls[0]?.[0]);
    const params = mocks.qOne.mock.calls[0]?.[1] as unknown[];
    const delivery = JSON.parse(String(params[9])) as Record<string, unknown>;
    expect(delivery).toEqual({
      status: "delivered",
      evidence_source: "verified_status_webhook",
      verified_terminal: true,
      provider_message_id: CALL_SID,
      provider_status: "completed",
      account_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      recipient_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sequence: 4,
      terminal_proof_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(params.slice(10)).toEqual([
      "delivered",
      "provider_terminal_delivered",
      delivery.account_binding_sha256,
      delivery.recipient_binding_sha256,
    ]);
    expect(JSON.stringify(delivery)).not.toContain(TO);
    expect(JSON.stringify(delivery)).not.toContain(ACCOUNT_SID);
    expect(sql).toContain("metadata || jsonb_build_object('delivery_receipt', $10::jsonb)");
    expect(sql).toContain("execution.capability = 'place_call'");
    expect(sql).toContain("execution.result->>'status' = 'accepted'");
    expect(sql).toContain("execution.result->'delivery'->>'provider_message_id' = $2");
    expect(sql).toContain("execution.result->'delivery'->>'account_binding_sha256' = $13");
    expect(sql).toContain("execution.result->'delivery'->>'recipient_binding_sha256' = $14");
  });

  it("treats Twilio's zero-based terminal sequence as authoritative delivery proof", async () => {
    mocks.qOne.mockResolvedValue({ id: CALL_ID });
    const response = await statusPost(signedTwilioRequest({
      path: `/api/telephony/status?callId=${CALL_ID}`,
      method: "POST",
      form: voiceIdentity({ CallStatus: "completed", SequenceNumber: "0" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, applied: true });
    const params = mocks.qOne.mock.calls[0]?.[1] as unknown[];
    expect(JSON.parse(String(params[9]))).toMatchObject({
      status: "delivered",
      evidence_source: "verified_status_webhook",
      verified_terminal: true,
      provider_status: "completed",
      sequence: 0,
    });
    expect(params[10]).toBe("delivered");
    expect(params[11]).toBe("provider_terminal_delivered");
  });

  it("records a signed terminal failure distinctly from delivered", async () => {
    mocks.qOne.mockResolvedValue({ id: CALL_ID });
    const response = await statusPost(signedTwilioRequest({
      path: `/api/telephony/status?callId=${CALL_ID}`,
      method: "POST",
      form: voiceIdentity({ CallStatus: "no-answer", SequenceNumber: "4" }),
    }));

    expect(response.status).toBe(200);
    const params = mocks.qOne.mock.calls[0]?.[1] as unknown[];
    expect(JSON.parse(String(params[9]))).toMatchObject({
      status: "terminal_failure",
      evidence_source: "verified_status_webhook",
      verified_terminal: true,
      provider_status: "no-answer",
      sequence: 4,
    });
    expect(params[10]).toBe("terminal_failure");
    expect(params[11]).toBe("provider_terminal_failure");
  });

  it("rejects signed CallSid, AccountSid, and To identity substitutions before storage", async () => {
    const substitutions: readonly Record<string, string>[] = [
      { CallSid: "CA-not-a-sid" },
      { AccountSid: `AC${"9".repeat(32)}` },
      { To: "+not-a-number" },
    ];
    for (const substitution of substitutions) {
      const form = voiceIdentity({
        CallStatus: "completed",
        SequenceNumber: "4",
        ...substitution,
      });
      const response = await statusPost(signedTwilioRequest({
        path: `/api/telephony/status?callId=${CALL_ID}`,
        method: "POST",
        form,
      }));
      expect(response.status).toBe(400);
      expect(mocks.qOne).not.toHaveBeenCalled();
    }

    const twimlIdentityMismatch = voiceIdentity({ AccountSid: `AC${"9".repeat(32)}` });
    expect((await twimlPost(signedTwilioRequest({
      path: "/api/telephony/twiml",
      method: "POST",
      form: twimlIdentityMismatch,
    }))).status).toBe(403);
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("rejects a signed control-character caller identity before database access", async () => {
    const response = await twimlPost(signedTwilioRequest({
      path: "/api/telephony/twiml",
      method: "POST",
      form: voiceIdentity({ From: "anonymous\r\nX-Injected: true" }),
    }));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("<Hangup/>");
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("fails closed for a signed inbound callback when number authority is ambiguous", async () => {
    mocks.qOne.mockResolvedValue(null);
    const response = await twimlPost(signedTwilioRequest({
      path: "/api/telephony/twiml",
      method: "POST",
      form: voiceIdentity(),
    }));

    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain("This number is not assigned to an agent.");
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Stream");
    expect(xml).not.toContain("bridgeToken");
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("AND NOT EXISTS");
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("duplicate.id <> agents.id");
    expect(mocks.qOne.mock.calls[0][1]).toEqual([TO]);
  });

  it("rejects transfer target substitution even when Twilio signed the resulting callback", async () => {
    const capability = signScope(
      { callId: CALL_ID, agentId: AGENT_ID, orgId: ORG_ID },
      {
        audience: "telephony-transfer",
        purpose: "human-transfer",
        method: "GET",
        provider: "twilio",
        ttlSeconds: 120,
        providerCallId: CALL_SID,
        providerAccountId: ACCOUNT_SID,
        providerTo: TO,
        authorizedTarget: TRANSFER,
      }
    );
    const query = voiceIdentity();
    query.set("transfer", SUBSTITUTED_TRANSFER);
    query.set("capability", capability);
    const path = `/api/telephony/twiml?${query.toString()}`;

    const response = await twimlGet(signedTwilioRequest({ path, method: "GET" }));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("<Hangup/>");
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("dials only the exact target authorized by the transfer capability", async () => {
    const capability = signScope(
      { callId: CALL_ID, agentId: AGENT_ID, orgId: ORG_ID },
      {
        audience: "telephony-transfer",
        purpose: "human-transfer",
        method: "GET",
        provider: "twilio",
        ttlSeconds: 120,
        providerCallId: CALL_SID,
        providerAccountId: ACCOUNT_SID,
        providerTo: TO,
        authorizedTarget: TRANSFER,
      }
    );
    mocks.qOne.mockResolvedValue({ id: CALL_ID, agent_id: AGENT_ID, org_id: ORG_ID, to_number: TO });
    const query = voiceIdentity();
    query.set("transfer", TRANSFER);
    query.set("capability", capability);
    const path = `/api/telephony/twiml?${query.toString()}`;

    const response = await twimlGet(signedTwilioRequest({ path, method: "GET" }));
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain(`<Dial>${TRANSFER}</Dial>`);
    expect(xml).not.toContain(SUBSTITUTED_TRANSFER);
    expect(xml).not.toContain("<Stream");
    expect(xml).not.toContain("bridgeToken");
    expect(mocks.qOne.mock.calls[0][1]).toEqual([
      CALL_ID, AGENT_ID, ORG_ID, CALL_SID, ACCOUNT_SID, TO,
    ]);
  });
});
