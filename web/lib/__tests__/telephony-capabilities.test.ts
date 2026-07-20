import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requirePublicOrigin } from "../public-origin";
import { deriveScopedJti, signScope, verifyScope, type ScopeExpectation } from "../voice";

const SECRET = "test-capability-secret-that-is-longer-than-thirty-two-bytes";
const CALL_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_CALL_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const ORG_ID = "00000000-0000-4000-8000-000000000004";
const CALL_SID = `CA${"a".repeat(32)}`;
const OTHER_CALL_SID = `CA${"b".repeat(32)}`;
const ACCOUNT_SID = `AC${"c".repeat(32)}`;
const OTHER_ACCOUNT_SID = `AC${"d".repeat(32)}`;
const STREAM_SID = `MZ${"e".repeat(32)}`;
const OTHER_STREAM_SID = `MZ${"f".repeat(32)}`;
const TO = "+14155550101";
const OTHER_TO = "+14155550102";
const TRANSFER = "+14155550103";
const OTHER_TRANSFER = "+14155550104";
const BRIDGE_ORIGIN_SHA256 = createHash("sha256")
  .update("wss://bridge.example.test/twilio/media", "utf8")
  .digest("hex");
const OTHER_BRIDGE_ORIGIN_SHA256 = "0".repeat(64);

const identity = { callId: CALL_ID, agentId: AGENT_ID, orgId: ORG_ID } as const;

describe("telephony v2 capabilities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T20:00:00.000Z"));
    vi.stubEnv("MCP_GATEWAY_SECRET", SECRET);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("binds bootstrap to its exchange audience, method, Twilio identity, and exact trusted bridge origin", () => {
    const token = signScope(identity, {
      audience: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
      ttlSeconds: 300,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      bridgeOriginSha256: BRIDGE_ORIGIN_SHA256,
    });
    const expected: ScopeExpectation = {
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
      bridgeOriginSha256: BRIDGE_ORIGIN_SHA256,
    };

    expect(verifyScope(token, expected)).toMatchObject({
      v: 2,
      ...identity,
      aud: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      bridgeOriginSha256: BRIDGE_ORIGIN_SHA256,
      iat: 1_784_232_000,
      exp: 1_784_232_300,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });

    const substitutions: ScopeExpectation[] = [
      { ...expected, audience: "telephony_events", purpose: "event_journal" },
      { ...expected, purpose: "tool_invocation" },
      { ...expected, method: "GET" },
      { ...expected, provider: "xai" },
      { ...expected, callId: OTHER_CALL_ID },
      { ...expected, providerCallId: OTHER_CALL_SID },
      { ...expected, providerAccountId: OTHER_ACCOUNT_SID },
      { ...expected, providerTo: OTHER_TO },
      { ...expected, bridgeOriginSha256: OTHER_BRIDGE_ORIGIN_SHA256 },
    ];
    for (const substituted of substitutions) expect(verifyScope(token, substituted)).toBeNull();
  });

  it("keeps stream-bound event and realtime-tool child capabilities distinct", () => {
    const events = signScope(identity, {
      audience: "telephony_events",
      purpose: "event_journal",
      method: "POST",
      provider: "twilio",
      ttlSeconds: 1_800,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      providerStreamId: STREAM_SID,
    });
    const eventExpectation: ScopeExpectation = {
      audience: "telephony_events",
      purpose: "event_journal",
      method: "POST",
      provider: "twilio",
      ...identity,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      providerStreamId: STREAM_SID,
    };
    expect(verifyScope(events, eventExpectation)?.providerStreamId).toBe(STREAM_SID);
    expect(verifyScope(events, { ...eventExpectation, providerStreamId: OTHER_STREAM_SID })).toBeNull();

    const tools = signScope(identity, {
      audience: "bridge_mcp",
      purpose: "tool_invocation",
      method: "POST",
      provider: "openai",
      ttlSeconds: 1_800,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      providerStreamId: STREAM_SID,
      transportProvider: "twilio",
    });
    const toolExpectation: ScopeExpectation = {
      audience: "bridge_mcp",
      purpose: "tool_invocation",
      method: "POST",
      provider: "openai",
      transportProvider: "twilio",
      ...identity,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      providerStreamId: STREAM_SID,
    };
    expect(verifyScope(tools, toolExpectation)).not.toBeNull();
    expect(verifyScope(tools, { ...toolExpectation, provider: "xai" })).toBeNull();
    expect(verifyScope(tools, { ...toolExpectation, providerStreamId: OTHER_STREAM_SID })).toBeNull();
    expect(verifyScope(tools, {
      ...toolExpectation,
      audience: "telephony_events",
      purpose: "event_journal",
      provider: "twilio",
    })).toBeNull();
  });

  it("binds transfer authorization to one exact E.164 target", () => {
    const token = signScope(identity, {
      audience: "telephony-transfer",
      purpose: "human-transfer",
      method: "GET",
      provider: "twilio",
      ttlSeconds: 120,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      authorizedTarget: TRANSFER,
    });
    const expected: ScopeExpectation = {
      audience: "telephony-transfer",
      purpose: "human-transfer",
      method: "GET",
      provider: "twilio",
      ...identity,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      authorizedTarget: TRANSFER,
    };

    expect(verifyScope(token, expected)?.authorizedTarget).toBe(TRANSFER);
    expect(verifyScope(token, { ...expected, authorizedTarget: OTHER_TRANSFER })).toBeNull();
  });

  it("expires narrow capabilities and enforces audience-specific maximum lifetimes", () => {
    const token = signScope(identity, {
      audience: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
      ttlSeconds: 1,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      bridgeOriginSha256: BRIDGE_ORIGIN_SHA256,
    });
    const expected: ScopeExpectation = {
      audience: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      bridgeOriginSha256: BRIDGE_ORIGIN_SHA256,
    };
    expect(verifyScope(token, expected)).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(verifyScope(token, expected)).toBeNull();

    expect(() => signScope(identity, {
      audience: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
      ttlSeconds: 301,
      providerCallId: CALL_SID,
      providerAccountId: ACCOUNT_SID,
      providerTo: TO,
      bridgeOriginSha256: BRIDGE_ORIGIN_SHA256,
    })).toThrow(/ttl must be between 1 and 300/);
  });

  it("derives deterministic but audience-separated child identities for retry-safe exchange", () => {
    const parentJti = "a".repeat(22);
    const eventJti = deriveScopedJti(parentJti, "telephony_events");
    const mcpJti = deriveScopedJti(parentJti, "bridge_mcp");

    expect(eventJti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(mcpJti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(eventJti).not.toBe(mcpJti);
    expect(deriveScopedJti(parentJti, "telephony_events")).toBe(eventJti);
    expect(() => deriveScopedJti("too-short", "telephony_events")).toThrow(/derivation input/);
  });

  it("rejects legacy-shaped and tampered capability bodies even when they carry a valid v2-domain HMAC", () => {
    const body = Buffer.from(JSON.stringify({
      v: 1,
      callId: CALL_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      exp: Math.floor(Date.now() / 1_000) + 300,
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", SECRET)
      .update("harshas-amazing-call-center/capability/v2\n", "utf8")
      .update(body, "ascii")
      .digest("base64url");
    const legacyToken = `${body}.${signature}`;

    expect(verifyScope(legacyToken, {
      audience: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
    })).toBeNull();
    expect(verifyScope(`${body.slice(0, -1)}A.${signature}`, {
      audience: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
    })).toBeNull();
  });
});

describe("trusted public origin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("normalizes only the configured HTTPS origin and ignores no request-derived authority", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", "https://voice.example.test/");
    expect(requirePublicOrigin()).toBe("https://voice.example.test");
  });

  it.each([
    undefined,
    "http://voice.example.test",
    "https://user:secret@voice.example.test",
    "https://voice.example.test/callback-base",
    "https://voice.example.test?spoofed=1",
    "https://voice.example.test/#fragment",
    " https://voice.example.test",
  ])("fails closed for an unsafe PUBLIC_ORIGIN value: %s", (origin) => {
    vi.stubEnv("NODE_ENV", "production");
    if (origin === undefined) vi.stubEnv("PUBLIC_ORIGIN", "");
    else vi.stubEnv("PUBLIC_ORIGIN", origin);
    expect(() => requirePublicOrigin()).toThrow(/PUBLIC_ORIGIN/);
  });
});
