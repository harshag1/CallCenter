import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("../realtime/registry", () => ({ createServerRealtimeConnection: vi.fn() }));
vi.mock("../stt", () => ({ transcribeUlaw: vi.fn() }));
vi.mock("../log", () => ({
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.logError }),
}));

import { BridgeSession, type BridgeSocket } from "../bridge";

describe("bridge Twilio REST preflight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.q.mockResolvedValue([]);
    mocks.qOne.mockResolvedValue({
      direction: "outbound",
      campaign_id: "00000000-0000-4000-8000-000000000001",
      twilio_call_sid: `CA${"b".repeat(32)}`,
    });
    vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
    vi.stubEnv("TWILIO_AUTH_TOKEN", "root-auth-token-for-webhook-verification-only");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not record a provider duration-cap event or fetch with root-token-only config", async () => {
    const socket: BridgeSocket = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    const session = new BridgeSession(socket);
    (session as unknown as { callId: string | null }).callId =
      "00000000-0000-4000-8000-000000000002";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await (session as unknown as { armOutboundGuard(callId: string): Promise<void> })
      .armOutboundGuard("00000000-0000-4000-8000-000000000002");
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.q.mock.calls.some(([sql, params]) =>
      String(sql).includes("INSERT INTO call_events")
      && String(params).includes("duration_cap")
    )).toBe(false);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("drops provider-controlled error text from bridge persistence and logs", async () => {
    const socket: BridgeSocket = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    const session = new BridgeSession(socket);
    const callId = "00000000-0000-4000-8000-000000000002";
    (session as unknown as { callId: string | null }).callId = callId;
    const hostile = new Error(
      "Authorization: Bearer provider-live-secret; caller alice@example.test",
    );

    (session as unknown as {
      onProviderEvent(event: { type: string; message: string }, provider: string): void;
    }).onProviderEvent({ type: "error", message: hostile.message }, "xai");
    await vi.waitFor(() => expect(mocks.q).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO call_events"),
      [callId, "error", JSON.stringify({ code: "provider_runtime_error", provider: "xai" })],
    ));

    (session as unknown as {
      onProviderSocketError(provider: string, error: unknown): void;
    }).onProviderSocketError("xai", hostile);
    expect(mocks.logError).toHaveBeenCalledWith("realtime provider ws error", {
      callId,
      code: "provider_runtime_error",
      provider: "xai",
    });
    const observable = JSON.stringify({ q: mocks.q.mock.calls, logs: mocks.logError.mock.calls });
    expect(observable).not.toContain("provider-live-secret");
    expect(observable).not.toContain("alice@example.test");
  });
});
