import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  generateCode: vi.fn(),
  hmacCode: vi.fn(),
  normalizeEmailAddress: vi.fn(),
  normalizePhoneNumber: vi.fn(),
  readAuthJsonObject: vi.fn(),
  hasExactKeys: vi.fn(),
  getSession: vi.fn(),
  issueEmailVerificationCode: vi.fn(),
  issuePhoneVerificationMarker: vi.fn(),
  reservePhoneVerificationAttempt: vi.fn(),
  anonymousAuthAbuseSourceHmac: vi.fn(),
  sendLoginCode: vi.fn(),
  startPhoneVerification: vi.fn(),
  checkPhoneVerification: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@/lib/auth", () => ({
  AUTH_NO_STORE_HEADERS: { "Cache-Control": "no-store" },
  AuthRequestInputError: class AuthRequestInputError extends Error {
    constructor(readonly status: number) { super("invalid"); }
  },
  generateCode: mocks.generateCode,
  hmacCode: mocks.hmacCode,
  normalizeEmailAddress: mocks.normalizeEmailAddress,
  normalizePhoneNumber: mocks.normalizePhoneNumber,
  readAuthJsonObject: mocks.readAuthJsonObject,
  hasExactKeys: mocks.hasExactKeys,
  getSession: mocks.getSession,
  issueEmailVerificationCode: mocks.issueEmailVerificationCode,
  issuePhoneVerificationMarker: mocks.issuePhoneVerificationMarker,
  reservePhoneVerificationAttempt: mocks.reservePhoneVerificationAttempt,
  anonymousAuthAbuseSourceHmac: mocks.anonymousAuthAbuseSourceHmac,
}));
vi.mock("@/lib/email", () => ({ sendLoginCode: mocks.sendLoginCode }));
vi.mock("@/lib/sms", () => ({
  startPhoneVerification: mocks.startPhoneVerification,
  checkPhoneVerification: mocks.checkPhoneVerification,
}));
vi.mock("@/lib/log", () => ({ log: () => ({ error: mocks.logError }) }));
vi.mock("@/lib/public-origin", async () => import("../public-origin"));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST as sendEmailCode } from "../../app/api/auth/send-code/route";
import { POST as sendPhoneCode } from "../../app/api/auth/send-phone-code/route";
import { POST as verifyPhoneCode } from "../../app/api/auth/verify-phone-code/route";

const EMAIL_MARKER = "00000000-0000-4000-8000-000000000001";

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://app.example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.example.test",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

describe("auth delivery and phone verification security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", "https://app.example.test");
    mocks.q.mockResolvedValue([]);
    mocks.qOne.mockResolvedValue(null);
    mocks.generateCode.mockReturnValue("483920");
    mocks.hmacCode.mockReturnValue("subject-bound-hmac");
    mocks.normalizeEmailAddress.mockReturnValue("owner@example.test");
    mocks.normalizePhoneNumber.mockReturnValue("+14155550123");
    mocks.readAuthJsonObject.mockImplementation((request: Request) => request.json());
    mocks.hasExactKeys.mockReturnValue(true);
    mocks.getSession.mockResolvedValue({
      email: "owner@example.test",
      orgId: "00000000-0000-4000-8000-000000000001",
      orgDomain: "example.test",
      phoneNumber: null,
      phoneVerifiedAt: null,
      authSessionTokenHash: "session-token-hash",
    });
    mocks.anonymousAuthAbuseSourceHmac.mockReturnValue("source-hmac");
    mocks.issueEmailVerificationCode.mockResolvedValue(null);
    mocks.issuePhoneVerificationMarker.mockResolvedValue(null);
    mocks.reservePhoneVerificationAttempt.mockResolvedValue(null);
    mocks.sendLoginCode.mockResolvedValue(undefined);
    mocks.startPhoneVerification.mockResolvedValue(undefined);
    mocks.checkPhoneVerification.mockResolvedValue(false);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("race-safely reserves an email OTP slot and subject-binds its digest", async () => {
    mocks.issueEmailVerificationCode.mockResolvedValueOnce(EMAIL_MARKER);
    const response = await sendEmailCode(jsonRequest("/api/auth/send-code", {
      email: "owner@example.test",
    }));
    expect(response.status).toBe(200);
    expect(mocks.issueEmailVerificationCode).toHaveBeenCalledWith(
      "owner@example.test",
      "subject-bound-hmac",
      "source-hmac",
    );
    expect(mocks.hmacCode).toHaveBeenCalledWith("483920", "owner@example.test");
    expect(mocks.sendLoginCode).toHaveBeenCalledWith(
      "owner@example.test",
      "483920",
      EMAIL_MARKER
    );
  });

  it("fails closed before code generation or funded email when no trusted client source exists", async () => {
    mocks.anonymousAuthAbuseSourceHmac.mockReturnValueOnce(null);
    const response = await sendEmailCode(jsonRequest("/api/auth/send-code", {
      email: "owner@example.test",
    }));
    expect(response.status).toBe(429);
    expect(mocks.generateCode).not.toHaveBeenCalled();
    expect(mocks.hmacCode).not.toHaveBeenCalled();
    expect(mocks.issueEmailVerificationCode).not.toHaveBeenCalled();
    expect(mocks.sendLoginCode).not.toHaveBeenCalled();
  });

  it("retires an undelivered email OTP without logging the provider message", async () => {
    mocks.issueEmailVerificationCode.mockResolvedValueOnce(EMAIL_MARKER);
    mocks.sendLoginCode.mockRejectedValueOnce(new Error("provider echoed owner@example.test and 483920"));
    const response = await sendEmailCode(jsonRequest("/api/auth/send-code", {
      email: "owner@example.test",
    }));
    expect(response.status).toBe(502);
    expect(mocks.q).toHaveBeenCalledWith(
      "UPDATE auth_codes SET used = true WHERE id = $1",
      [EMAIL_MARKER]
    );
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("owner@example.test");
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("483920");
  });

  it("does not change staged phone state when Twilio dispatch fails", async () => {
    mocks.issuePhoneVerificationMarker.mockResolvedValueOnce("phone-marker");
    mocks.startPhoneVerification.mockRejectedValueOnce(new Error("private provider response"));
    const response = await sendPhoneCode(jsonRequest("/api/auth/send-phone-code", {
      phone: "+14155550123",
    }));
    expect(response.status).toBe(502);
    expect(mocks.issuePhoneVerificationMarker).toHaveBeenCalledWith("+14155550123");
    expect(mocks.q).toHaveBeenCalledTimes(1);
    expect(mocks.q).toHaveBeenCalledWith(
      "UPDATE phone_codes SET used = true WHERE id = $1",
      ["phone-marker"]
    );
  });

  it("requires and consumes a live, attempt-limited dispatch marker before phone ownership", async () => {
    mocks.reservePhoneVerificationAttempt.mockResolvedValueOnce("phone-marker");
    mocks.qOne.mockResolvedValueOnce({ id: "phone-marker" });
    mocks.checkPhoneVerification.mockResolvedValueOnce(true);
    const response = await verifyPhoneCode(jsonRequest("/api/auth/verify-phone-code", {
      phone: "+14155550123",
      code: "483920",
    }));
    expect(response.status).toBe(200);
    expect(mocks.reservePhoneVerificationAttempt).toHaveBeenCalledWith("+14155550123");
    expect(mocks.qOne.mock.calls[0][0]).toContain("WITH target_user");
    expect(mocks.qOne.mock.calls[0][0]).toContain("UPDATE users u");
    expect(mocks.qOne.mock.calls[0][0]).toContain("p.phone_number = $3");
    expect(mocks.qOne.mock.calls[0][0]).toContain("p.code_hmac = 'twilio-verify'");
    expect(mocks.qOne.mock.calls[0][0]).toContain("p.expires_at > statement_timestamp()");
    expect(mocks.qOne.mock.calls[0][0]).toContain("s.token = $4");
    expect(mocks.qOne.mock.calls[0][0]).toContain("s.org_id = u.org_id");
    expect(mocks.qOne.mock.calls[0][0]).toContain("s.is_active");
    expect(mocks.qOne.mock.calls[0][0]).toContain("s.expires_at > statement_timestamp()");
    expect(mocks.qOne.mock.calls[0][0]).toContain("s.last_used_at > statement_timestamp() - interval '7 days'");
    expect(mocks.qOne.mock.calls[0][0]).toContain("s.last_used_at <= statement_timestamp() + interval '5 minutes'");
    expect(mocks.qOne.mock.calls[0][0]).toContain("u.phone_number = $3");
    expect(mocks.qOne.mock.calls[0][0]).toContain("AND u.org_id = $5");
    expect(mocks.qOne.mock.calls[0][1]).toEqual([
      "phone-marker",
      "owner@example.test",
      "+14155550123",
      "session-token-hash",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("never calls Twilio verification without a live dispatch marker", async () => {
    const response = await verifyPhoneCode(jsonRequest("/api/auth/verify-phone-code", {
      phone: "+14155550123",
      code: "483920",
    }));
    expect(response.status).toBe(401);
    expect(mocks.checkPhoneVerification).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it.each([
    "the dispatch marker expired",
    "the presented session was revoked or expired",
    "the email, organization, token tuple was swapped",
  ])("refuses an approved provider response when %s during the provider wait", async () => {
    mocks.reservePhoneVerificationAttempt.mockResolvedValueOnce("phone-marker");
    mocks.checkPhoneVerification.mockResolvedValueOnce(true);
    mocks.qOne.mockResolvedValueOnce(null);
    const response = await verifyPhoneCode(jsonRequest("/api/auth/verify-phone-code", {
      phone: "+14155550123",
      code: "483920",
    }));
    expect(response.status).toBe(401);
    expect(mocks.checkPhoneVerification).toHaveBeenCalledOnce();
    expect(mocks.qOne).toHaveBeenCalledOnce();
    expect(mocks.qOne.mock.calls[0][1]).toContain("session-token-hash");
  });

  it.each([
    ["missing Origin", { origin: "" }],
    ["same-site subdomain", { origin: "https://evil.example.test", "sec-fetch-site": "same-site" }],
  ])("rejects %s before session or provider work", async (_label, headers) => {
    const req = jsonRequest("/api/auth/send-phone-code", { phone: "+14155550123" });
    for (const [key, value] of Object.entries(headers)) {
      if (value) req.headers.set(key, value);
      else req.headers.delete(key);
    }
    const response = await sendPhoneCode(req);
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.issuePhoneVerificationMarker).not.toHaveBeenCalled();
    expect(mocks.startPhoneVerification).not.toHaveBeenCalled();
  });
});
