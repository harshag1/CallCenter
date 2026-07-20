import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CapabilityRotationClient,
  CapabilityRotationError,
} from "../lib/capability-rotation-client.js";
import { ACCOUNT_SID, CALL_SID, STREAM_SID } from "./support.js";

const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const SESSION_ID = "bridge-rotation-session";
const INSTANCE_ID = "bridge-rotation-instance";
const CALL_ID = "application-call-1";
const OLD_EVENT = "old.event.capability.signature";
const OLD_MCP = "old.mcp.capability.signature";
const OLD_RENEWAL = "old.renewal.capability.signature";
const NEW_EVENT = "new.event.capability.signature";
const NEW_MCP = "new.mcp.capability.signature";
const NEW_RENEWAL = "new.renewal.capability.signature";
const OLD_EXPIRY = new Date(NOW + 5 * 60_000).toISOString();
const NEW_REFRESH_AFTER = new Date(NOW + 25 * 60_000).toISOString();
const NEW_EXPIRY = new Date(NOW + 30 * 60_000).toISOString();

const CONNECTION = Object.freeze({
  account_sid: ACCOUNT_SID,
  call_sid: CALL_SID,
  stream_sid: STREAM_SID,
  mode: "agent",
});

function request(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    bridgeInstanceId: INSTANCE_ID,
    expectedCallId: CALL_ID,
    rotation: 1,
    connection: CONNECTION,
    eventToken: OLD_EVENT,
    mcpToken: OLD_MCP,
    renewalToken: OLD_RENEWAL,
    expiresAt: OLD_EXPIRY,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    schema_version: 1,
    session_id: SESSION_ID,
    bridge_instance_id: INSTANCE_ID,
    call_id: CALL_ID,
    connection: CONNECTION,
    rotation: 1,
    refresh_after: NEW_REFRESH_AFTER,
    event_capability: {
      token: NEW_EVENT,
      expires_at: NEW_EXPIRY,
      audience: "telephony_events",
      purpose: "event_journal",
    },
    mcp_capability: {
      token: NEW_MCP,
      expires_at: NEW_EXPIRY,
      audience: "bridge_mcp",
      purpose: "tool_invocation",
    },
    renewal_capability: {
      token: NEW_RENEWAL,
      expires_at: NEW_EXPIRY,
      audience: "bridge_refresh",
      purpose: "capability_rotation",
    },
    expires_at: NEW_EXPIRY,
    ...overrides,
  };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl, overrides = {}) {
  return new CapabilityRotationClient({
    appOrigin: "https://app.example.test",
    fetchImpl,
    now: () => NOW,
    sleep: async () => {},
    ...overrides,
  });
}

describe("CapabilityRotationClient", () => {
  it("advances one generation with byte-stable retries and exact pinned bindings", async () => {
    const requests = [];
    const sleeps = [];
    const rotationClient = client(async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      if (requests.length === 1) return response({ error: "temporary" }, 503);
      return response(payload());
    }, { sleep: async (ms) => { sleeps.push(ms); } });

    const rotated = await rotationClient.rotate(request());
    assert.equal(rotated.rotation, 1);
    assert.equal(rotated.sessionId, SESSION_ID);
    assert.equal(rotated.bridgeInstanceId, INSTANCE_ID);
    assert.equal(rotated.callId, CALL_ID);
    assert.equal(rotated.eventCapability.token, NEW_EVENT);
    assert.equal(rotated.mcpCapability.token, NEW_MCP);
    assert.equal(rotated.renewalCapability.token, NEW_RENEWAL);
    assert(Object.isFrozen(rotated));
    assert(Object.isFrozen(rotated.connection));
    assert.deepEqual(sleeps, [50]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "https://app.example.test/api/telephony/bridge/capabilities/rotate");
    assert.equal(requests[0].init.body, requests[1].init.body);
    assert.equal(requests[0].init.headers.Authorization, `Bearer ${OLD_RENEWAL}`);
    assert.equal(requests[0].init.headers["Idempotency-Key"], `${SESSION_ID}:1`);
    assert.deepEqual(requests[0].body, {
      schema_version: 1,
      session_id: SESSION_ID,
      bridge_instance_id: INSTANCE_ID,
      rotation: 1,
      connection: CONNECTION,
    });
    assert.equal(requests[0].init.body.includes(OLD_RENEWAL), false);
    assert.equal(requests[0].init.body.includes(OLD_EVENT), false);
    assert.equal(requests[0].init.body.includes(OLD_MCP), false);
  });

  it("recovers a lost or corrupt successful response through the same idempotent request", async () => {
    const requests = [];
    const rotationClient = client(async (_url, init) => {
      requests.push(init);
      if (requests.length === 1) {
        return new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return response(payload());
    }, { sleep: async () => {} });

    const result = await rotationClient.rotate(request());
    assert.equal(result.rotation, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[0].headers.Authorization, requests[1].headers.Authorization);
    assert.equal(requests[0].headers["Idempotency-Key"], requests[1].headers["Idempotency-Key"]);
  });

  it("fails before fetch once the current renewal capability expires", async () => {
    let calls = 0;
    const rotationClient = client(async () => { calls += 1; return response(payload()); }, {
      now: () => Date.parse(OLD_EXPIRY),
    });
    await assert.rejects(
      rotationClient.rotate(request()),
      (error) => error instanceof CapabilityRotationError && error.code === "rotation_capability_expired",
    );
    assert.equal(calls, 0);
  });

  it("rejects an implausibly long-lived current generation before fetch", async () => {
    let calls = 0;
    const rotationClient = client(async () => { calls += 1; return response(payload()); });
    await assert.rejects(
      rotationClient.rotate(request({ expiresAt: new Date(NOW + 365 * 24 * 60 * 60_000).toISOString() })),
      (error) => error instanceof CapabilityRotationError &&
        error.code === "rotation_capability_expiry_invalid",
    );
    assert.equal(calls, 0);
  });

  it("rejects generation, call, stream, instance, and expiry substitution", async () => {
    const cases = [
      { rotation: 2 },
      { session_id: "other-session" },
      { bridge_instance_id: "other-instance" },
      { call_id: "other-call" },
      { connection: { ...CONNECTION, stream_sid: `MZ${"d".repeat(32)}` } },
      { refresh_after: new Date(NOW + 24 * 60_000).toISOString() },
      { unexpected: true },
    ];
    for (const patch of cases) {
      const rotationClient = client(async () => response(payload(patch)));
      await assert.rejects(
        rotationClient.rotate(request()),
        (error) => error instanceof CapabilityRotationError &&
          ["rotation_binding_mismatch", "rotation_expiry_invalid", "rotation_response_invalid"].includes(error.code),
      );
    }
  });

  it("requires exact separated event, MCP, and renewal capabilities", async () => {
    const cases = [
      { event_capability: { ...payload().event_capability, audience: "bridge_mcp" } },
      { mcp_capability: { ...payload().mcp_capability, purpose: "event_journal" } },
      { renewal_capability: { ...payload().renewal_capability, audience: "bridge_mcp" } },
      { renewal_capability: { ...payload().renewal_capability, token: NEW_MCP } },
      { event_capability: { ...payload().event_capability, expires_at: OLD_EXPIRY } },
    ];
    for (const patch of cases) {
      const rotationClient = client(async () => response(payload(patch)));
      await assert.rejects(
        rotationClient.rotate(request()),
        (error) => error instanceof CapabilityRotationError && error.code.startsWith("rotation_"),
      );
    }
  });

  it("rejects a generation with more than the fixed 30-minute freshness window", async () => {
    const distantExpiry = new Date(NOW + 365 * 24 * 60 * 60_000).toISOString();
    const distantRefresh = new Date(Date.parse(distantExpiry) - 5 * 60_000).toISOString();
    const rotationClient = client(async () => response(payload({
      refresh_after: distantRefresh,
      expires_at: distantExpiry,
      event_capability: { ...payload().event_capability, expires_at: distantExpiry },
      mcp_capability: { ...payload().mcp_capability, expires_at: distantExpiry },
      renewal_capability: { ...payload().renewal_capability, expires_at: distantExpiry },
    })));

    await assert.rejects(
      rotationClient.rotate(request()),
      (error) => error instanceof CapabilityRotationError && error.code === "rotation_expiry_invalid",
    );
  });

  it("requires every next generation to extend the current expiry", async () => {
    const currentExpiry = new Date(NOW + 20 * 60_000).toISOString();
    const shorterExpiry = new Date(NOW + 10 * 60_000).toISOString();
    const shorterRefresh = new Date(NOW + 5 * 60_000).toISOString();
    const rotationClient = client(async () => response(payload({
      refresh_after: shorterRefresh,
      expires_at: shorterExpiry,
      event_capability: { ...payload().event_capability, expires_at: shorterExpiry },
      mcp_capability: { ...payload().mcp_capability, expires_at: shorterExpiry },
      renewal_capability: { ...payload().renewal_capability, expires_at: shorterExpiry },
    })));

    await assert.rejects(
      rotationClient.rotate(request({ expiresAt: currentExpiry })),
      (error) => error instanceof CapabilityRotationError && error.code === "rotation_expiry_invalid",
    );
  });

  it("rejects reuse of any prior event, MCP, or renewal bearer in the next generation", async () => {
    const reusedTokens = [
      { event_capability: { ...payload().event_capability, token: OLD_EVENT } },
      { event_capability: { ...payload().event_capability, token: OLD_MCP } },
      { event_capability: { ...payload().event_capability, token: OLD_RENEWAL } },
      { mcp_capability: { ...payload().mcp_capability, token: OLD_EVENT } },
      { mcp_capability: { ...payload().mcp_capability, token: OLD_MCP } },
      { renewal_capability: { ...payload().renewal_capability, token: OLD_RENEWAL } },
    ];
    for (const patch of reusedTokens) {
      const rotationClient = client(async () => response(payload(patch)));
      await assert.rejects(
        rotationClient.rotate(request()),
        (error) => error instanceof CapabilityRotationError &&
          error.code === "rotation_capability_separation_invalid",
      );
    }
  });

  it("rejects a malformed current generation with reused bearer authority before fetch", async () => {
    let calls = 0;
    const rotationClient = client(async () => { calls += 1; return response(payload()); });
    await assert.rejects(
      rotationClient.rotate(request({ mcpToken: OLD_EVENT })),
      (error) => error instanceof CapabilityRotationError &&
        error.code === "rotation_capability_separation_invalid",
    );
    assert.equal(calls, 0);
  });

  it("honors an external abort while fetch is pending without retrying", async () => {
    let calls = 0;
    let observedSignal;
    const rotationClient = client(async (_url, init) => {
      calls += 1;
      observedSignal = init.signal;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const pending = rotationClient.rotate(request(), { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("must not escape"));

    await assert.rejects(
      pending,
      (error) => error instanceof CapabilityRotationError &&
        error.code === "rotation_aborted" && error.message === "capability rotation failed",
    );
    assert.equal(calls, 1);
    assert.equal(observedSignal.aborted, true);
  });

  it("rejects a pre-aborted rotation without issuing an authority request", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const rotationClient = client(async () => { calls += 1; return response(payload()); });

    await assert.rejects(
      rotationClient.rotate(request(), { signal: controller.signal }),
      (error) => error instanceof CapabilityRotationError && error.code === "rotation_aborted",
    );
    assert.equal(calls, 0);
  });

  it("pins the endpoint to the exact same-origin bridge rotation path", () => {
    for (const options of [
      { appOrigin: "http://app.example.test" },
      { appOrigin: "https://user:secret@app.example.test" },
      { appOrigin: "https://app.example.test/path" },
      { appOrigin: "https://app.example.test", endpointPath: "/api/mcp" },
      { appOrigin: "https://app.example.test", endpointPath: "https://evil.example/rotate" },
    ]) {
      assert.throws(() => new CapabilityRotationClient({ ...options, fetchImpl: async () => response(payload()) }));
    }
  });
});
