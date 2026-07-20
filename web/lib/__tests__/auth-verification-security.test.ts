import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  qOne: vi.fn(),
  hmacCode: vi.fn(),
  verifyEmailCodeAndEstablishSession: vi.fn(),
  hasExactKeys: vi.fn(),
  normalizeEmailAddress: vi.fn(),
  normalizePhoneNumber: vi.fn(),
  readAuthJsonObject: vi.fn(),
  revokePresentedSessions: vi.fn(),
  sessionCookie: vi.fn(),
  staleSessionCookieDeletions: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ qOne: mocks.qOne }));
vi.mock("@/lib/auth", () => ({
  AUTH_NO_STORE_HEADERS: { "Cache-Control": "no-store" },
  AuthRequestInputError: class AuthRequestInputError extends Error {
    constructor(readonly status: number) { super("invalid"); }
  },
  hmacCode: mocks.hmacCode,
  verifyEmailCodeAndEstablishSession: mocks.verifyEmailCodeAndEstablishSession,
  hasExactKeys: mocks.hasExactKeys,
  normalizeEmailAddress: mocks.normalizeEmailAddress,
  normalizePhoneNumber: mocks.normalizePhoneNumber,
  readAuthJsonObject: mocks.readAuthJsonObject,
  revokePresentedSessions: mocks.revokePresentedSessions,
  sessionCookie: mocks.sessionCookie,
  staleSessionCookieDeletions: mocks.staleSessionCookieDeletions,
}));

import { POST } from "../../app/api/auth/verify-code/route";

function request(code: string): Request {
  return new Request("https://app.example.test/api/auth/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test", code }),
  });
}

describe("OTP verification security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hmacCode.mockReturnValue("submitted-hmac");
    mocks.hasExactKeys.mockReturnValue(true);
    mocks.normalizeEmailAddress.mockReturnValue("owner@example.test");
    mocks.normalizePhoneNumber.mockReturnValue(null);
    mocks.readAuthJsonObject.mockImplementation((req: Request) => req.json());
    mocks.revokePresentedSessions.mockResolvedValue(undefined);
    mocks.verifyEmailCodeAndEstablishSession.mockResolvedValue(null);
    mocks.staleSessionCookieDeletions.mockReturnValue([]);
    mocks.sessionCookie.mockReturnValue({
      name: "session_token",
      value: "raw-session-token",
      httpOnly: true,
      path: "/",
    });
    mocks.qOne.mockResolvedValue(null);
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(["production", "development", "test"])(
    "has no universal demo-code bypass in %s",
    async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    process.env.ALLOW_INSECURE_DEV_OTP = "true"; // stale config must have no effect
    const response = await POST(request("111111"));
    expect(response.status).toBe(401);
    expect(mocks.verifyEmailCodeAndEstablishSession).toHaveBeenCalledWith({
      email: "owner@example.test",
      codeHmac: "submitted-hmac",
      phoneNumber: null,
    });
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.hmacCode).toHaveBeenCalledWith("111111", "owner@example.test");
  });

  it("sets a cookie only after transactional OTP consume and session establishment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mocks.verifyEmailCodeAndEstablishSession.mockResolvedValueOnce("raw-session-token");
    mocks.qOne.mockResolvedValueOnce({ id: "agent-1" });
    const response = await POST(request("483920"));
    expect(response.status).toBe(200);
    expect(mocks.verifyEmailCodeAndEstablishSession).toHaveBeenCalledOnce();
    expect(mocks.revokePresentedSessions).toHaveBeenCalledWith(null);
    expect(mocks.qOne).toHaveBeenCalledOnce();
  });

  it("rejects malformed codes without hashing or querying", async () => {
    const response = await POST(request("1111111"));
    expect(response.status).toBe(401);
    expect(mocks.hmacCode).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });
});
