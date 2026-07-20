import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BootstrapClient, BootstrapClientError } from "../lib/bootstrap-client.js";
import { BoundedOutbox, OutboxOverflowError } from "../lib/bounded-outbox.js";
import { loadBridgeConfig } from "../lib/config.js";
import { FakeSocket, ACCOUNT_SID, CALL_SID, STREAM_SID } from "./support.js";

const NOW = Date.parse("2026-07-16T19:00:00.000Z");
const BRIDGE_TOKEN = "bridge.bootstrap.parent.token.signature";
const EVENT_TOKEN = "bridge.events.child.token.signature";
const MCP_TOKEN = "bridge.mcp.child.token.signature";
const RENEWAL_TOKEN = "bridge.renewal.child.token.signature";
const SESSION_ID = "bridge-session-1";
const INSTANCE_ID = "bridge-instance-1";

const ENV = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://app.example.test",
  BRIDGE_PUBLIC_STREAM_URL: "wss://bridge.example.test/stream",
  TWILIO_ACCOUNT_SID: ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: "twilio-auth-token-with-enough-entropy",
  OPENAI_API_KEY: "openai-test-key",
  BRIDGE_INSTANCE_ID: "bridge-config-test",
};

function requestArguments(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    bridgeToken: BRIDGE_TOKEN,
    accountSid: ACCOUNT_SID,
    callSid: CALL_SID,
    streamSid: STREAM_SID,
    mode: "agent",
    bridgeInstanceId: INSTANCE_ID,
    ...overrides,
  };
}

function exchangePayload(connection, overrides = {}) {
  return {
    schema_version: 3,
    session_id: SESSION_ID,
    bridge_instance_id: INSTANCE_ID,
    call_id: "application-call-1",
    connection,
    provider: "openai",
    model: "gpt-realtime-test",
    ws_url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-test",
    session_update: { type: "session.update", session: { instructions: "Stay scoped." } },
    rotation: 0,
    rotation_endpoint: "/api/telephony/bridge/capabilities/rotate",
    active_catalog_authority: {
      catalog_digest: "a".repeat(64),
      capability_epoch: 0,
    },
    refresh_after: new Date(NOW + 25 * 60_000).toISOString(),
    event_capability: {
      token: EVENT_TOKEN,
      expires_at: new Date(NOW + 30 * 60_000).toISOString(),
      audience: "telephony_events",
      purpose: "event_journal",
    },
    mcp_capability: {
      token: MCP_TOKEN,
      expires_at: new Date(NOW + 30 * 60_000).toISOString(),
      audience: "bridge_mcp",
      purpose: "tool_invocation",
    },
    renewal_capability: {
      token: RENEWAL_TOKEN,
      expires_at: new Date(NOW + 30 * 60_000).toISOString(),
      audience: "bridge_refresh",
      purpose: "capability_rotation",
    },
    expires_at: new Date(NOW + 30 * 60_000).toISOString(),
    ...overrides,
  };
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function capturedFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected bootstrap exchange to fail");
}

function assertBootstrapFailure(error, code, status) {
  assert(error instanceof BootstrapClientError);
  assert.equal(error.name, "BootstrapClientError");
  assert.equal(error.message, "bootstrap exchange failed");
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert(!error.message.includes(BRIDGE_TOKEN));
  assert(!error.stack.includes(BRIDGE_TOKEN));
}

describe("bridge infrastructure boundaries", () => {
  it("loads a closed, bounded production configuration with a canonical stream URL", () => {
    const config = loadBridgeConfig(ENV);
    assert.equal(config.publicStreamUrl, "wss://bridge.example.test/stream");
    assert.equal(config.appOrigin, ENV.APP_ORIGIN);
    assert.equal(config.strictTwilioProtocol, true);
    assert.equal(config.allowedClientTools.join(","), "capability_gateway");
    assert.equal(config.limits.playbackMarkBytes, 800);
    assert.equal(config.limits.maximumConcurrentSessions, 1_000);
    assert.equal(Object.hasOwn(config, "bridgeTokenSecret"), false);
    assert.equal(Object.hasOwn(config.limits, "replayCacheEntries"), false);
    assert(Object.isFrozen(config));
    assert(Object.isFrozen(config.limits));
  });

  it("rejects insecure production, malformed authority paths, and ambiguous Twilio URLs", () => {
    for (const patch of [
      { APP_ORIGIN: "http://app.example.test" },
      { BRIDGE_ALLOW_INSECURE_LOCAL_TESTS: "true" },
      { BRIDGE_PUBLIC_STREAM_URL: "wss://bridge.example.test/stream?token=bad" },
      { BRIDGE_PUBLIC_STREAM_URL: "WSS://bridge.example.test/stream" },
      { BRIDGE_PUBLIC_STREAM_URL: "wss://bridge.example.test/other" },
      { BRIDGE_SESSION_PATH: "https://attacker.example/session" },
      { BRIDGE_EVENTS_PATH: "/api/../escape" },
      { TWILIO_ACCOUNT_SID: CALL_SID },
      { BRIDGE_ALLOWED_CLIENT_TOOLS: "capability_gateway,capability_gateway" },
    ]) {
      assert.throws(() => loadBridgeConfig({ ...ENV, ...patch }));
    }
    const local = loadBridgeConfig({
      ...ENV,
      NODE_ENV: "test",
      APP_ORIGIN: "http://127.0.0.1:3000",
      BRIDGE_PUBLIC_STREAM_URL: "ws://127.0.0.1:8080/stream",
      BRIDGE_ALLOW_INSECURE_LOCAL_TESTS: "true",
    });
    assert.equal(local.allowInsecureLocalTests, true);
    assert.equal(local.strictTwilioProtocol, false);
  });

  it("accepts ordered batches atomically and prioritizes clear after discarding stale audio", () => {
    const socket = new FakeSocket({ readyState: 0 });
    const failures = [];
    const outbox = new BoundedOutbox({
      name: "test_outbox",
      maxMessages: 3,
      maxBytes: 1_024,
      highWaterBytes: 10,
      onFatal: (error) => failures.push(error),
    });
    outbox.attach(socket);
    outbox.enqueueBatch([
      { data: '{"id":"audio"}', metadata: { kind: "audio" } },
      { data: '{"id":"mark"}', metadata: { kind: "mark" } },
    ]);
    assert.throws(() => outbox.enqueueBatch([
      { data: '{"id":"x"}' },
      { data: '{"id":"y"}' },
    ]), OutboxOverflowError);
    assert.equal(outbox.size, 2);
    assert.equal(failures.length, 1);

    assert.deepEqual(outbox.discard((metadata) => metadata?.kind === "audio"), {
      messages: 1,
      bytes: Buffer.byteLength('{"id":"audio"}'),
    });
    outbox.enqueueFront('{"id":"clear"}', { kind: "clear" });
    socket.open();
    outbox.drain();
    assert.deepEqual(socket.sent, [{ id: "clear" }, { id: "mark" }]);

    socket.bufferedAmount = 100;
    outbox.enqueue('{"id":"held"}');
    assert.equal(outbox.size, 1);
    socket.bufferedAmount = 0;
    outbox.drain();
    assert.equal(socket.sent.at(-1).id, "held");
  });
});

describe("bootstrap schema v3 exchange", () => {
  it("uses an exact POST body, header-only bearer, stable idempotency key, and byte-stable retry", async () => {
    const requests = [];
    const client = new BootstrapClient({
      appOrigin: "https://app.example.test",
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url, init, body });
        return jsonResponse(exchangePayload(body.connection));
      },
      now: () => NOW,
    });

    const first = await client.createSession(requestArguments());
    const retry = await client.createSession(requestArguments());

    assert.deepEqual(first, retry);
    assert.equal(first.callId, "application-call-1");
    assert.equal(first.eventCapability.token, EVENT_TOKEN);
    assert.equal(first.eventCapability.audience, "telephony_events");
    assert.equal(first.eventCapability.purpose, "event_journal");
    assert.equal(first.mcpCapability.token, MCP_TOKEN);
    assert.equal(first.mcpCapability.audience, "bridge_mcp");
    assert.equal(first.mcpCapability.purpose, "tool_invocation");
    assert.equal(first.renewalCapability.token, RENEWAL_TOKEN);
    assert.equal(first.renewalCapability.audience, "bridge_refresh");
    assert.equal(first.renewalCapability.purpose, "capability_rotation");
    assert.equal(first.rotation, 0);
    assert.equal(first.rotationEndpoint, "/api/telephony/bridge/capabilities/rotate");
    assert.deepEqual(first.activeCatalogAuthority, {
      catalogDigest: "a".repeat(64),
      capabilityEpoch: 0,
    });
    assert(Object.isFrozen(first));
    assert(Object.isFrozen(first.connection));
    assert(Object.isFrozen(first.eventCapability));
    assert(Object.isFrozen(first.mcpCapability));
    assert(Object.isFrozen(first.renewalCapability));
    assert(Object.isFrozen(first.activeCatalogAuthority));

    const expectedBody = {
      schema_version: 3,
      session_id: SESSION_ID,
      bridge_instance_id: INSTANCE_ID,
      connection: {
        account_sid: ACCOUNT_SID,
        call_sid: CALL_SID,
        stream_sid: STREAM_SID,
        mode: "agent",
      },
    };
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, "https://app.example.test/api/telephony/bridge/session");
      assert.equal(request.init.method, "POST");
      assert.equal(request.init.redirect, "error");
      assert.equal(request.init.credentials, "omit");
      assert.equal(request.init.headers.Authorization, `Bearer ${BRIDGE_TOKEN}`);
      assert.equal(request.init.headers.Accept, "application/json");
      assert.equal(request.init.headers["Content-Type"], "application/json");
      assert.equal(request.init.headers["Idempotency-Key"], SESSION_ID);
      assert.deepEqual(request.body, expectedBody);
      assert(!request.url.includes(BRIDGE_TOKEN));
      assert(!request.init.body.includes(BRIDGE_TOKEN));
    }
    assert.equal(requests[0].init.body, requests[1].init.body);
  });

  it("returns typed, redacted HTTP 401 and 403 failures without consuming their bodies", async () => {
    for (const status of [401, 403]) {
      let cancelled = false;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`sensitive:${BRIDGE_TOKEN}`));
        },
        cancel() { cancelled = true; },
      });
      const client = new BootstrapClient({
        appOrigin: "https://app.example.test",
        fetchImpl: async () => new Response(body, { status }),
      });
      const error = await capturedFailure(client.createSession(requestArguments()));
      assertBootstrapFailure(error, `bootstrap_http_${status}`, status);
      assert.equal(cancelled, true);
    }
  });

  it("redacts upstream network failures", async () => {
    const client = new BootstrapClient({
      appOrigin: "https://app.example.test",
      fetchImpl: async () => { throw new Error(`upstream leaked ${BRIDGE_TOKEN}`); },
    });
    const error = await capturedFailure(client.createSession(requestArguments()));
    assertBootstrapFailure(error, "bootstrap_network_error");
  });

  it("applies one deadline across a slow fetch and a stalled response body", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; },
    });
    const client = new BootstrapClient({
      appOrigin: "https://app.example.test",
      timeoutMs: 200,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const started = Date.now();
    const error = await capturedFailure(client.createSession(requestArguments()));
    const elapsed = Date.now() - started;
    assertBootstrapFailure(error, "bootstrap_timeout");
    assert(elapsed < 270, `deadline was restarted after fetch (${elapsed}ms)`);
    assert.equal(cancelled, true);
  });

  it("times out even when the fetch implementation ignores AbortSignal", async () => {
    const client = new BootstrapClient({
      appOrigin: "https://app.example.test",
      timeoutMs: 100,
      fetchImpl: async () => new Promise(() => {}),
    });
    const error = await capturedFailure(client.createSession(requestArguments()));
    assertBootstrapFailure(error, "bootstrap_timeout");
  });

  it("honors an external abort while bootstrap fetch is pending", async () => {
    let calls = 0;
    let observedSignal;
    const client = new BootstrapClient({
      appOrigin: "https://app.example.test",
      fetchImpl: async (_url, init) => {
        calls += 1;
        observedSignal = init.signal;
        return new Promise(() => {});
      },
      now: () => NOW,
    });
    const controller = new AbortController();
    const pending = client.createSession(requestArguments(), { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error(`must not escape ${BRIDGE_TOKEN}`));

    const error = await capturedFailure(pending);
    assertBootstrapFailure(error, "bootstrap_aborted");
    assert.equal(calls, 1);
    assert.equal(observedSignal.aborted, true);
  });

  it("rejects a pre-aborted bootstrap without issuing an authority request", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const client = new BootstrapClient({
      appOrigin: "https://app.example.test",
      fetchImpl: async () => { calls += 1; return jsonResponse({}); },
      now: () => NOW,
    });

    assertBootstrapFailure(
      await capturedFailure(client.createSession(requestArguments(), { signal: controller.signal })),
      "bootstrap_aborted",
    );
    assert.equal(calls, 0);
  });

  it("rejects advertised and streamed responses over the byte cap", async () => {
    const advertised = new BootstrapClient({
      appOrigin: "https://app.example.test",
      maximumResponseBytes: 1_024,
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Length": "1025" },
      }),
    });
    assertBootstrapFailure(
      await capturedFailure(advertised.createSession(requestArguments())),
      "bootstrap_response_too_large",
    );

    const streamed = new BootstrapClient({
      appOrigin: "https://app.example.test",
      maximumResponseBytes: 1_024,
      fetchImpl: async () => new Response("x".repeat(1_025), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    assertBootstrapFailure(
      await capturedFailure(streamed.createSession(requestArguments())),
      "bootstrap_response_too_large",
    );
  });

  it("rejects schema, session, and exact connection binding mismatches predictably", async () => {
    const cases = [
      {
        mutate: (payload) => ({ ...payload, schema_version: 2 }),
        code: "bootstrap_binding_mismatch",
      },
      {
        mutate: (payload) => ({ ...payload, session_id: "different-session" }),
        code: "bootstrap_binding_mismatch",
      },
      {
        mutate: (payload) => ({ ...payload, bridge_instance_id: "different-instance" }),
        code: "bootstrap_binding_mismatch",
      },
      {
        mutate: (payload) => ({
          ...payload,
          connection: { ...payload.connection, stream_sid: `MZ${"d".repeat(32)}` },
        }),
        code: "bootstrap_connection_mismatch",
      },
      {
        mutate: (payload) => ({ ...payload, unexpected: true }),
        code: "bootstrap_response_invalid",
      },
      {
        mutate: (payload) => ({
          ...payload,
          active_catalog_authority: { ...payload.active_catalog_authority, catalog_digest: "A".repeat(64) },
        }),
        code: "bootstrap_active_catalog_authority_invalid",
      },
      {
        mutate: (payload) => ({
          ...payload,
          active_catalog_authority: { ...payload.active_catalog_authority, private_grant: "forbidden" },
        }),
        code: "bootstrap_active_catalog_authority_invalid",
      },
      {
        mutate: (payload) => ({
          ...payload,
          connection: { ...payload.connection, unexpected: true },
        }),
        code: "bootstrap_response_invalid",
      },
    ];

    for (const testCase of cases) {
      const client = new BootstrapClient({
        appOrigin: "https://app.example.test",
        fetchImpl: async (_url, init) => {
          const connection = JSON.parse(init.body).connection;
          return jsonResponse(testCase.mutate(exchangePayload(connection)));
        },
        now: () => NOW,
      });
      assertBootstrapFailure(
        await capturedFailure(client.createSession(requestArguments())),
        testCase.code,
      );
    }
  });

  it("enforces each child capability audience and purpose independently", async () => {
    for (const [field, claim, value, code] of [
      ["event_capability", "audience", "bridge_mcp", "bootstrap_event_capability_audience_invalid"],
      ["event_capability", "purpose", "tool_invocation", "bootstrap_event_capability_purpose_invalid"],
      ["mcp_capability", "audience", "telephony_events", "bootstrap_mcp_capability_audience_invalid"],
      ["mcp_capability", "purpose", "event_journal", "bootstrap_mcp_capability_purpose_invalid"],
      ["renewal_capability", "audience", "bridge_mcp", "bootstrap_renewal_capability_audience_invalid"],
      ["renewal_capability", "purpose", "tool_invocation", "bootstrap_renewal_capability_purpose_invalid"],
    ]) {
      const client = new BootstrapClient({
        appOrigin: "https://app.example.test",
        fetchImpl: async (_url, init) => {
          const connection = JSON.parse(init.body).connection;
          const payload = exchangePayload(connection);
          payload[field] = { ...payload[field], [claim]: value };
          return jsonResponse(payload);
        },
        now: () => NOW,
      });
      assertBootstrapFailure(
        await capturedFailure(client.createSession(requestArguments())),
        code,
      );
    }
  });

  it("requires parent and all three child bearer capabilities to be pairwise distinct", async () => {
    for (const mutate of [
      (payload) => ({ ...payload, mcp_capability: { ...payload.mcp_capability, token: EVENT_TOKEN } }),
      (payload) => ({ ...payload, event_capability: { ...payload.event_capability, token: BRIDGE_TOKEN } }),
      (payload) => ({ ...payload, mcp_capability: { ...payload.mcp_capability, token: BRIDGE_TOKEN } }),
      (payload) => ({ ...payload, renewal_capability: { ...payload.renewal_capability, token: MCP_TOKEN } }),
      (payload) => ({ ...payload, renewal_capability: { ...payload.renewal_capability, token: BRIDGE_TOKEN } }),
    ]) {
      const client = new BootstrapClient({
        appOrigin: "https://app.example.test",
        fetchImpl: async (_url, init) => {
          const connection = JSON.parse(init.body).connection;
          return jsonResponse(mutate(exchangePayload(connection)));
        },
        now: () => NOW,
      });
      assertBootstrapFailure(
        await capturedFailure(client.createSession(requestArguments())),
        "bootstrap_capability_separation_invalid",
      );
    }
  });

  it("bounds outer and child capability lifetimes with canonical expiries", async () => {
    const cases = [
      {
        mutate: (payload) => ({ ...payload, expires_at: new Date(NOW + 31 * 60_000 + 1).toISOString() }),
        code: "bootstrap_expiry_invalid",
      },
      {
        mutate: (payload) => ({
          ...payload,
          event_capability: { ...payload.event_capability, expires_at: new Date(NOW + 30 * 60_000 + 1).toISOString() },
        }),
        code: "bootstrap_event_capability_expiry_invalid",
      },
      {
        mutate: (payload) => ({
          ...payload,
          mcp_capability: { ...payload.mcp_capability, expires_at: new Date(NOW).toISOString() },
        }),
        code: "bootstrap_mcp_capability_expiry_invalid",
      },
    ];

    for (const testCase of cases) {
      const client = new BootstrapClient({
        appOrigin: "https://app.example.test",
        maximumLifetimeMs: 31 * 60_000,
        fetchImpl: async (_url, init) => {
          const connection = JSON.parse(init.body).connection;
          return jsonResponse(testCase.mutate(exchangePayload(connection)));
        },
        now: () => NOW,
      });
      assertBootstrapFailure(
        await capturedFailure(client.createSession(requestArguments())),
        testCase.code,
      );
    }
  });

  it("rejects a bootstrap generation beyond the fixed 30-minute freshness window", async () => {
    const distantExpiry = new Date(NOW + 120 * 60_000).toISOString();
    const distantRefresh = new Date(Date.parse(distantExpiry) - 5 * 60_000).toISOString();
    const client = new BootstrapClient({
      appOrigin: "https://app.example.test",
      maximumLifetimeMs: 4 * 60 * 60_000,
      fetchImpl: async (_url, init) => {
        const connection = JSON.parse(init.body).connection;
        const baseline = exchangePayload(connection);
        return jsonResponse({
          ...baseline,
          refresh_after: distantRefresh,
          expires_at: distantExpiry,
          event_capability: { ...baseline.event_capability, expires_at: distantExpiry },
          mcp_capability: { ...baseline.mcp_capability, expires_at: distantExpiry },
          renewal_capability: { ...baseline.renewal_capability, expires_at: distantExpiry },
        });
      },
      now: () => NOW,
    });

    assertBootstrapFailure(
      await capturedFailure(client.createSession(requestArguments())),
      "bootstrap_expiry_invalid",
    );
  });

  it("rejects non-JSON, unsupported-provider, unsafe URL, and invalid request inputs with typed codes", async () => {
    const nonJson = new BootstrapClient({
      appOrigin: "https://app.example.test",
      fetchImpl: async () => new Response("{}", { status: 200, headers: { "Content-Type": "text/plain" } }),
    });
    assertBootstrapFailure(
      await capturedFailure(nonJson.createSession(requestArguments())),
      "bootstrap_content_type_invalid",
    );

    for (const [patch, code] of [
      [{ provider: "unknown" }, "bootstrap_provider_unsupported"],
      [{ ws_url: "ws://api.openai.com/realtime" }, "bootstrap_ws_url_invalid"],
      [{ session_update: [] }, "bootstrap_session_update_invalid"],
    ]) {
      const client = new BootstrapClient({
        appOrigin: "https://app.example.test",
        fetchImpl: async (_url, init) => {
          const connection = JSON.parse(init.body).connection;
          return jsonResponse(exchangePayload(connection, patch));
        },
        now: () => NOW,
      });
      assertBootstrapFailure(
        await capturedFailure(client.createSession(requestArguments())),
        code,
      );
    }

    const neverCalled = () => assert.fail("invalid request must fail before fetch");
    const client = new BootstrapClient({ appOrigin: "https://app.example.test", fetchImpl: neverCalled });
    assertBootstrapFailure(
      await capturedFailure(client.createSession(requestArguments({ mode: "observe" }))),
      "bootstrap_request_invalid",
    );
  });
});
