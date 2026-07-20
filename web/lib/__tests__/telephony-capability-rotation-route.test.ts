import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rotateCapabilityLease: vi.fn(),
}));

vi.mock("@/lib/capability-rotation-store", () => ({
  rotateCapabilityLease: mocks.rotateCapabilityLease,
}));

import { POST } from "../../app/api/telephony/bridge/capabilities/rotate/route";
import { deriveRotatedScopedJti, signScope, verifyScope } from "../voice";

const BASE_MS = Date.parse("2026-07-16T20:00:00.000Z");
const ROTATION_MS = BASE_MS + 25 * 60_000;
const ROOT = "R".repeat(22);
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const CALL_SID = `CA${"b".repeat(32)}`;
const STREAM_SID = `MZ${"c".repeat(32)}`;
const OTHER_STREAM_SID = `MZ${"d".repeat(32)}`;
const TO = "+14155550100";
const SESSION_ID = "bridge-session-1";
const BRIDGE_INSTANCE_ID = "bridge-instance-1";

const connection = Object.freeze({
  account_sid: ACCOUNT_SID,
  call_sid: CALL_SID,
  stream_sid: STREAM_SID,
  mode: "agent" as const,
});

function renewalToken(issuedAt = BASE_MS / 1_000, generation = 0): string {
  return signScope(
    { callId: CALL_ID, agentId: AGENT_ID, orgId: ORG_ID },
    {
      audience: "bridge_refresh",
      purpose: "capability_rotation",
      method: "POST",
      provider: "openai",
      ttlSeconds: 30 * 60,
      issuedAt,
      jti: generation === 0 ? ROOT : deriveRotatedScopedJti(ROOT, generation, "bridge_refresh"),
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      providerStreamId: STREAM_SID,
      transportProvider: "twilio",
    },
  );
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    session_id: SESSION_ID,
    bridge_instance_id: BRIDGE_INSTANCE_ID,
    rotation: 1,
    connection,
    ...overrides,
  };
}

function request(
  payload: string | Record<string, unknown> = body(),
  options: Readonly<{
    token?: string;
    idempotencyKey?: string;
    contentType?: string;
  }> = {},
): Request {
  return new Request("https://voice.example.test/api/telephony/bridge/capabilities/rotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token ?? renewalToken()}`,
      "Content-Type": options.contentType ?? "application/json",
      "Idempotency-Key": options.idempotencyKey ?? `${SESSION_ID}:1`,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

function lease(generation = 1, issuedAt = ROTATION_MS / 1_000) {
  const refreshJti = deriveRotatedScopedJti(ROOT, generation, "bridge_refresh");
  return Object.freeze({
    transport: "telephony" as const,
    call_id: CALL_ID,
    session_id: SESSION_ID,
    bridge_instance_id: BRIDGE_INSTANCE_ID,
    stream_sid: STREAM_SID,
    provider: "openai" as const,
    rotation_root_jti: ROOT,
    generation,
    current_refresh_jti: refreshJti,
    previous_refresh_jti: ROOT,
    last_consumed_refresh_jti: ROOT,
    last_idempotency_key: `${SESSION_ID}:${generation}`,
    issued_at: issuedAt,
    refresh_after_epoch: issuedAt + 25 * 60,
    expires_at_epoch: issuedAt + 30 * 60,
  });
}

describe("telephony bridge capability rotation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(ROTATION_MS);
    vi.stubEnv("MCP_GATEWAY_SECRET", "rotation-route-test-secret-is-at-least-32-bytes");
    mocks.rotateCapabilityLease.mockResolvedValue({ status: "rotated", lease: lease() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("rotates an exact live bridge binding and returns three pairwise-distinct child capabilities", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(Object.keys(payload).sort()).toEqual([
      "bridge_instance_id", "call_id", "connection", "event_capability", "expires_at",
      "mcp_capability", "refresh_after", "renewal_capability", "rotation", "schema_version",
      "session_id",
    ].sort());
    expect(payload).toMatchObject({
      schema_version: 1,
      session_id: SESSION_ID,
      bridge_instance_id: BRIDGE_INSTANCE_ID,
      call_id: CALL_ID,
      connection,
      rotation: 1,
      refresh_after: "2026-07-16T20:50:00.000Z",
      expires_at: "2026-07-16T20:55:00.000Z",
    });
    expect(new Set([
      payload.event_capability.token,
      payload.mcp_capability.token,
      payload.renewal_capability.token,
    ]).size).toBe(3);
    expect(verifyScope(payload.mcp_capability.token, {
      audience: "bridge_mcp",
      purpose: "tool_invocation",
      method: "POST",
      provider: "openai",
      callId: CALL_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      providerStreamId: STREAM_SID,
      transportProvider: "twilio",
    })).not.toBeNull();
    expect(mocks.rotateCapabilityLease).toHaveBeenCalledWith(expect.objectContaining({
      transport: "telephony",
      sessionId: SESSION_ID,
      bridgeInstanceId: BRIDGE_INSTANCE_ID,
      streamSid: STREAM_SID,
      requestedGeneration: 1,
      idempotencyKey: `${SESSION_ID}:1`,
      nowEpoch: ROTATION_MS / 1_000,
    }));
  });

  it("reconstructs an exact lost-response retry byte-for-byte", async () => {
    const first = await POST(request());
    mocks.rotateCapabilityLease.mockResolvedValueOnce({ status: "replayed", lease: lease() });
    const replay = await POST(request());
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(await first.text());
  });

  it("rejects idempotency and signed transport substitutions before lease mutation", async () => {
    expect((await POST(request(body(), { idempotencyKey: `${SESSION_ID}:01` }))).status).toBe(400);
    expect(mocks.rotateCapabilityLease).not.toHaveBeenCalled();

    expect((await POST(request(body({
      connection: { ...connection, stream_sid: OTHER_STREAM_SID },
    })))).status).toBe(401);
    expect(mocks.rotateCapabilityLease).not.toHaveBeenCalled();
  });

  it("rejects duplicate-key and non-JSON machine requests before lease mutation", async () => {
    const duplicate = JSON.stringify(body()).replace(
      '"rotation":1',
      '"rotation":1,"rot\\u0061tion":2',
    );
    expect((await POST(request(duplicate))).status).toBe(400);
    expect((await POST(request(body(), { contentType: "text/plain" }))).status).toBe(415);
    expect(mocks.rotateCapabilityLease).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404],
    ["too_early", 425],
    ["expired", 401],
    ["conflict", 409],
  ] as const)("maps %s store results without issuing a bearer", async (status, expected) => {
    mocks.rotateCapabilityLease.mockResolvedValueOnce({ status });
    const response = await POST(request());
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain("eyJ");
  });

  it("rejects the consumed generation-zero renewal bearer after its 30-minute wall", async () => {
    vi.setSystemTime(BASE_MS + 30 * 60_000 + 1);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.rotateCapabilityLease).not.toHaveBeenCalled();
  });
});
