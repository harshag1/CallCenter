import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_ROTATION_OVERLAP_SECONDS,
  CAPABILITY_ROTATION_TTL_SECONDS,
  capabilityRotationTimes,
  issueBridgeCapabilityRotation,
  issueBrowserCapabilityRotation,
} from "../capability-rotation";
import { verifyScope } from "../voice";

const BASE_MS = Date.parse("2026-07-16T20:00:00.000Z");
const BASE_SECONDS = BASE_MS / 1_000;
const ROOT = "A".repeat(22);
const IDS = {
  callId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  orgId: "33333333-3333-4333-8333-333333333333",
};
const BRIDGE = {
  ...IDS,
  provider: "openai" as const,
  sessionId: "bridge-session-1",
  bridgeInstanceId: "bridge-instance-1",
  accountSid: `AC${"a".repeat(32)}`,
  callSid: `CA${"b".repeat(32)}`,
  to: "+14155550100",
  streamSid: `MZ${"c".repeat(32)}`,
};

beforeEach(() => {
  process.env.MCP_GATEWAY_SECRET = "rotation-test-secret-that-is-at-least-32-bytes";
  vi.useFakeTimers();
  vi.setSystemTime(BASE_MS);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MCP_GATEWAY_SECRET;
});

describe("capability rotation issuance", () => {
  it("issues deterministic, pairwise-distinct browser generations and survives the original 30-minute wall", () => {
    const initial = issueBrowserCapabilityRotation(
      { ...IDS, provider: "openai" }, ROOT, 0, BASE_SECONDS,
    );
    expect(initial.refresh_after).toBe("2026-07-16T20:25:00.000Z");
    expect(initial.expires_at).toBe("2026-07-16T20:30:00.000Z");
    expect(initial.mcp_capability.token).not.toBe(initial.renewal_capability.token);
    expect(issueBrowserCapabilityRotation(
      { ...IDS, provider: "openai" }, ROOT, 0, BASE_SECONDS,
    )).toEqual(initial);

    const initialRenewal = verifyScope(initial.renewal_capability.token, {
      audience: "browser_refresh",
      purpose: "capability_rotation",
      method: "POST",
      provider: "openai",
      ...IDS,
    });
    const initialMcp = verifyScope(initial.mcp_capability.token, {
      audience: "mcp",
      purpose: "tool-invocation",
      method: "POST",
      provider: "openai",
      ...IDS,
    });
    expect(initialRenewal?.jti).toBe(ROOT);
    expect(initialMcp?.jti).not.toBe(ROOT);

    vi.setSystemTime(BASE_MS + 25 * 60_000);
    const rotated = issueBrowserCapabilityRotation(
      { ...IDS, provider: "openai" }, ROOT, 1, BASE_SECONDS + 25 * 60,
    );
    expect(rotated.rotation).toBe(1);
    expect(rotated.expires_at).toBe("2026-07-16T20:55:00.000Z");
    expect(rotated.mcp_capability.token).not.toBe(initial.mcp_capability.token);
    expect(rotated.renewal_capability.token).not.toBe(initial.renewal_capability.token);

    vi.setSystemTime(BASE_MS + 31 * 60_000);
    expect(verifyScope(initial.mcp_capability.token, {
      audience: "mcp", purpose: "tool-invocation", method: "POST", provider: "openai", ...IDS,
    })).toBeNull();
    expect(verifyScope(rotated.mcp_capability.token, {
      audience: "mcp", purpose: "tool-invocation", method: "POST", provider: "openai", ...IDS,
    })).not.toBeNull();
  });

  it("binds byte-stable bridge generations to one call/stream/session/instance with three distinct capabilities", () => {
    const initial = issueBridgeCapabilityRotation(BRIDGE, ROOT, 0, BASE_SECONDS);
    expect(issueBridgeCapabilityRotation(BRIDGE, ROOT, 0, BASE_SECONDS)).toEqual(initial);
    expect(initial).toMatchObject({
      schema_version: 1,
      session_id: BRIDGE.sessionId,
      bridge_instance_id: BRIDGE.bridgeInstanceId,
      call_id: BRIDGE.callId,
      rotation: 0,
      connection: {
        account_sid: BRIDGE.accountSid,
        call_sid: BRIDGE.callSid,
        stream_sid: BRIDGE.streamSid,
        mode: "agent",
      },
    });
    expect(new Set([
      initial.event_capability.token,
      initial.mcp_capability.token,
      initial.renewal_capability.token,
    ])).toHaveLength(3);

    const refresh = verifyScope(initial.renewal_capability.token, {
      audience: "bridge_refresh",
      purpose: "capability_rotation",
      method: "POST",
      provider: "openai",
      callId: BRIDGE.callId,
      agentId: BRIDGE.agentId,
      orgId: BRIDGE.orgId,
      providerCallId: BRIDGE.callSid,
      providerAccountId: BRIDGE.accountSid,
      providerTo: BRIDGE.to,
      providerStreamId: BRIDGE.streamSid,
      transportProvider: "twilio",
    });
    expect(refresh?.jti).toBe(ROOT);
    expect(verifyScope(initial.event_capability.token, {
      audience: "telephony_events",
      purpose: "event_journal",
      method: "POST",
      provider: "twilio",
      callId: BRIDGE.callId,
      providerCallId: BRIDGE.callSid,
      providerAccountId: BRIDGE.accountSid,
      providerTo: BRIDGE.to,
      providerStreamId: BRIDGE.streamSid,
    })).not.toBeNull();

    vi.setSystemTime(BASE_MS + 25 * 60_000);
    const rotated = issueBridgeCapabilityRotation(
      BRIDGE,
      ROOT,
      1,
      BASE_SECONDS + 25 * 60,
    );
    vi.setSystemTime(BASE_MS + 31 * 60_000);
    expect(verifyScope(initial.mcp_capability.token, {
      audience: "bridge_mcp",
      purpose: "tool_invocation",
      method: "POST",
      provider: "openai",
      callId: BRIDGE.callId,
      agentId: BRIDGE.agentId,
      orgId: BRIDGE.orgId,
      providerCallId: BRIDGE.callSid,
      providerAccountId: BRIDGE.accountSid,
      providerTo: BRIDGE.to,
      providerStreamId: BRIDGE.streamSid,
      transportProvider: "twilio",
    })).toBeNull();
    expect(verifyScope(rotated.mcp_capability.token, {
      audience: "bridge_mcp",
      purpose: "tool_invocation",
      method: "POST",
      provider: "openai",
      callId: BRIDGE.callId,
      agentId: BRIDGE.agentId,
      orgId: BRIDGE.orgId,
      providerCallId: BRIDGE.callSid,
      providerAccountId: BRIDGE.accountSid,
      providerTo: BRIDGE.to,
      providerStreamId: BRIDGE.streamSid,
      transportProvider: "twilio",
    })).not.toBeNull();
  });

  it("fixes the renewal threshold at a bounded five-minute overlap", () => {
    const times = capabilityRotationTimes(BASE_SECONDS);
    expect(times.expiresAt - times.issuedAt).toBe(CAPABILITY_ROTATION_TTL_SECONDS);
    expect(times.expiresAt - times.refreshAfter).toBe(CAPABILITY_ROTATION_OVERLAP_SECONDS);
    expect(() => capabilityRotationTimes(-1)).toThrow("issuedAt");
  });
});
