import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyTwilioStreamUpgrade: vi.fn(),
  bridgeSession: vi.fn(),
  upgrade: vi.fn(),
  socket: { id: "fake-socket" },
}));

vi.mock("@/lib/telephony", () => ({
  verifyTwilioStreamUpgrade: mocks.verifyTwilioStreamUpgrade,
}));
vi.mock("@/lib/bridge", () => ({
  BridgeSession: mocks.bridgeSession,
}));
vi.mock("@vercel/functions", () => ({
  experimental_upgradeWebSocket: mocks.upgrade,
}));

import { GET, legacyWebBridgeEnabled } from "../../app/api/bridge/route";

const request = () => new Request("https://voice.example.test/api/bridge", {
  headers: { "X-Twilio-Signature": "signed-by-provider" },
});

describe("legacy in-process WebSocket bridge kill switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENABLE_LEGACY_WEB_BRIDGE", "");
    mocks.upgrade.mockImplementation((callback: (socket: unknown) => void) => {
      callback(mocks.socket);
      return new Response("upgraded");
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("is disabled by default before signature checking or WebSocket allocation", async () => {
    expect(legacyWebBridgeEnabled()).toBe(false);
    const response = await GET(request());

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.verifyTwilioStreamUpgrade).not.toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(mocks.bridgeSession).not.toHaveBeenCalled();
  });

  it("cannot be enabled in production even when the compatibility flag is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_LEGACY_WEB_BRIDGE", "true");

    expect(legacyWebBridgeEnabled()).toBe(false);
    expect((await GET(request())).status).toBe(410);
    expect(mocks.verifyTwilioStreamUpgrade).not.toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it("requires a verified Twilio stream upgrade when explicitly enabled for development", async () => {
    vi.stubEnv("ENABLE_LEGACY_WEB_BRIDGE", "true");
    mocks.verifyTwilioStreamUpgrade.mockReturnValue(false);
    const req = request();
    const response = await GET(req);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.verifyTwilioStreamUpgrade).toHaveBeenCalledWith(req);
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(mocks.bridgeSession).not.toHaveBeenCalled();
  });

  it("allocates a bridge session only after the development gate and signature both pass", async () => {
    vi.stubEnv("ENABLE_LEGACY_WEB_BRIDGE", "true");
    mocks.verifyTwilioStreamUpgrade.mockReturnValue(true);
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.upgrade).toHaveBeenCalledTimes(1);
    expect(mocks.bridgeSession).toHaveBeenCalledWith(mocks.socket);
  });

  it("keeps every telephony bridge runtime fail-closed for audio persistence", async () => {
    const sources = await Promise.all([
      readFile(new URL("../bridge.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../bridge/lib/session.js", import.meta.url), "utf8"),
    ]);
    for (const source of sources) {
      expect(source).not.toMatch(/\bcall_recordings\b/);
      expect(source).not.toMatch(/\brecording_path\b/);
    }
  });
});
