import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyScope: vi.fn(),
  rotateCapabilityLease: vi.fn(),
  issueBrowserCapabilityRotation: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/voice", () => ({ verifyScope: mocks.verifyScope }));
vi.mock("@/lib/capability-rotation-store", () => ({
  rotateCapabilityLease: mocks.rotateCapabilityLease,
}));
vi.mock("@/lib/capability-rotation", () => ({
  MAX_CAPABILITY_ROTATION: 1_000_000,
  issueBrowserCapabilityRotation: mocks.issueBrowserCapabilityRotation,
}));
vi.mock("@/lib/public-origin", async () => import("../public-origin"));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST } from "../../app/api/voice/capabilities/rotate/route";

const APP_ORIGIN = "https://voice.example.test";
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "refresh-token.signature";
const BASE_MS = Date.parse("2026-07-16T20:25:00.000Z");
const BASE_SECONDS = BASE_MS / 1_000;
const IDEMPOTENCY_KEY = `${CALL_ID}:1`;

const scope = Object.freeze({
  aud: "browser_refresh",
  purpose: "capability_rotation",
  method: "POST",
  provider: "openai",
  callId: CALL_ID,
  agentId: AGENT_ID,
  orgId: ORG_ID,
  iat: BASE_SECONDS - 25 * 60,
  exp: BASE_SECONDS + 5 * 60,
  jti: "A".repeat(22),
});

const lease = Object.freeze({
  transport: "browser",
  call_id: CALL_ID,
  session_id: CALL_ID,
  bridge_instance_id: null,
  stream_sid: null,
  provider: "openai",
  rotation_root_jti: "A".repeat(22),
  generation: 1,
  current_refresh_jti: "B".repeat(22),
  previous_refresh_jti: "A".repeat(22),
  last_consumed_refresh_jti: "A".repeat(22),
  last_idempotency_key: IDEMPOTENCY_KEY,
  issued_at: BASE_SECONDS,
  refresh_after_epoch: BASE_SECONDS + 25 * 60,
  expires_at_epoch: BASE_SECONDS + 30 * 60,
});

const bundle = Object.freeze({
  schema_version: 1,
  call_id: CALL_ID,
  rotation: 1,
  refresh_after: "2026-07-16T20:50:00.000Z",
  expires_at: "2026-07-16T20:55:00.000Z",
  mcp_capability: {
    token: "next-mcp.signature",
    expires_at: "2026-07-16T20:55:00.000Z",
    audience: "mcp",
    purpose: "tool-invocation",
  },
  renewal_capability: {
    token: "next-refresh.signature",
    expires_at: "2026-07-16T20:55:00.000Z",
    audience: "browser_refresh",
    purpose: "capability_rotation",
  },
});

function request(options: {
  body?: string;
  headers?: Record<string, string | null>;
} = {}): Request {
  const headers = new Headers({
    origin: APP_ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
    "idempotency-key": IDEMPOTENCY_KEY,
  });
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request(`${APP_ORIGIN}/api/voice/capabilities/rotate`, {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify({
      schema_version: 1,
      call_id: CALL_ID,
      rotation: 1,
    }),
  });
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("expires")).toBe("0");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("vary")).toBe("Origin, Sec-Fetch-Site");
}

describe("POST /api/voice/capabilities/rotate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    vi.stubEnv("PUBLIC_ORIGIN", APP_ORIGIN);
    mocks.getSession.mockResolvedValue({ orgId: ORG_ID });
    mocks.verifyScope.mockReturnValue(scope);
    mocks.rotateCapabilityLease.mockResolvedValue({ status: "rotated", lease });
    mocks.issueBrowserCapabilityRotation.mockReturnValue(bundle);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("rotates an authenticated same-origin request with the exact idempotency binding", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    expect(await response.json()).toEqual(bundle);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.verifyScope).toHaveBeenCalledWith(TOKEN, {
      audience: "browser_refresh",
      purpose: "capability_rotation",
      method: "POST",
      provider: ["xai", "openai", "gemini"],
      callId: CALL_ID,
      orgId: ORG_ID,
    });
    expect(mocks.rotateCapabilityLease).toHaveBeenCalledWith({
      transport: "browser",
      scope,
      sessionId: CALL_ID,
      requestedGeneration: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      nowEpoch: BASE_SECONDS,
    });
    expect(mocks.issueBrowserCapabilityRotation).toHaveBeenCalledWith(
      { callId: CALL_ID, agentId: AGENT_ID, orgId: ORG_ID, provider: "openai" },
      lease.rotation_root_jti,
      lease.generation,
      lease.issued_at,
    );
  });

  it.each([
    ["a missing Origin", { origin: null }, undefined, 403],
    [
      "a same-site subdomain",
      { origin: "https://subdomain.voice.example.test", "sec-fetch-site": "same-site" },
      undefined,
      403,
    ],
    ["text/plain", { "content-type": "text/plain" }, undefined, 415],
    [
      "a duplicate JSON key",
      {},
      `{"schema_version":1,"call_id":"${CALL_ID}","rotation":1,"rotat\\u0069on":1}`,
      400,
    ],
  ])("rejects %s before authentication or lease access", async (
    _label,
    headers,
    body,
    expectedStatus,
  ) => {
    const response = await POST(request({ headers, body }));

    expect(response.status).toBe(expectedStatus);
    expectPrivateNoStore(response);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.verifyScope).not.toHaveBeenCalled();
    expect(mocks.rotateCapabilityLease).not.toHaveBeenCalled();
    expect(mocks.issueBrowserCapabilityRotation).not.toHaveBeenCalled();
  });

  it("rejects a non-exact idempotency key before consuming the lease", async () => {
    const response = await POST(request({
      headers: { "idempotency-key": `${CALL_ID}:01` },
    }));

    expect(response.status).toBe(400);
    expectPrivateNoStore(response);
    expect(await response.json()).toEqual({ error: "idempotency binding mismatch" });
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.verifyScope).toHaveBeenCalledTimes(1);
    expect(mocks.rotateCapabilityLease).not.toHaveBeenCalled();
  });

  it("returns a byte-identical 200 response for an exact lost-response replay", async () => {
    mocks.rotateCapabilityLease
      .mockResolvedValueOnce({ status: "rotated", lease })
      .mockResolvedValueOnce({ status: "replayed", lease });

    const first = await POST(request());
    const replay = await POST(request());
    const firstText = await first.text();
    const replayText = await replay.text();

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expectPrivateNoStore(first);
    expectPrivateNoStore(replay);
    expect(replayText).toBe(firstText);
    expect(JSON.parse(replayText)).toEqual(bundle);
    expect(mocks.rotateCapabilityLease).toHaveBeenCalledTimes(2);
    for (const [input] of mocks.rotateCapabilityLease.mock.calls) {
      expect(input.idempotencyKey).toBe(IDEMPOTENCY_KEY);
      expect(input.requestedGeneration).toBe(1);
    }
    expect(mocks.issueBrowserCapabilityRotation).toHaveBeenCalledTimes(2);
  });
});
