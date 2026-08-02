import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { WebSocket } from "ws";

import {
  computeTwilioSignature,
  mintBridgeToken,
  verifyAndConsumeBridgeToken,
} from "../lib/auth.js";
import { AuthorityClient } from "../lib/authority-client.js";
import { BootstrapClient } from "../lib/bootstrap-client.js";
import { EventJournal } from "../lib/event-journal.js";
import { createLogger } from "../lib/logger.js";
import { createBridgeServer } from "../server.js";
import {
  ACCOUNT_SID,
  CALL_SID,
  FakeSocket,
  STREAM_SID,
  bridgeConfig,
  connected,
  media,
  providerConfiguration,
  start,
  stop,
  waitFor,
} from "./support.js";

const TEST_BOOTSTRAP_SECRET = "integration-bootstrap-secret-with-32-real-bytes";
const ALTERNATE_CALL_SID = `CA${"d".repeat(32)}`;
const ALTERNATE_STREAM_SID = `MZ${"e".repeat(32)}`;
const MCP_SESSION_ID = `hacc.v1.${Buffer.alloc(16, 1).toString("base64url")}.${Buffer.alloc(32, 2).toString("base64url")}`;

function quietLogger() {
  const sink = { log() {}, warn() {}, error() {} };
  return createLogger({ sink, now: () => "2026-07-16T00:00:00.000Z" });
}

function signature(config, authToken = config.twilioAuthToken) {
  return computeTwilioSignature({
    authToken,
    configuredUrl: config.publicStreamUrl,
  });
}

function openClient(url, signatureHeader) {
  const socket = new WebSocket(url, {
    headers: signatureHeader ? { "X-Twilio-Signature": signatureHeader } : {},
    perMessageDeflate: false,
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rejectedClient(url, signatureHeader) {
  const socket = new WebSocket(url, {
    headers: signatureHeader ? { "X-Twilio-Signature": signatureHeader } : {},
    perMessageDeflate: false,
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function closeResult(socket) {
  return new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function activeCatalogEnvelope(outcome = { ok: true, membership: "gold" }) {
  return {
    schema_version: 1,
    outcome,
    active_capability_catalog: {
      schema_version: 1,
      availability: "active",
      runtime_digest: "b".repeat(64),
      capability_epoch: 0,
      state_revision: 0,
      scope: { status: "routing", topic: null, step: "$flow.routing", attempt: 0 },
      active_context: {},
      catalog_digest: "a".repeat(64),
      tools: [],
    },
  };
}

function createExchangeHarness({ config, requested }) {
  const requests = [];
  const eventBatches = [];
  const bootstrapBodies = [];
  const consumed = new Map();
  const responseByJti = new Map();
  let issuedCapabilities;

  const replayCache = {
    consume(jti, expiresAt, _nowSeconds, binding) {
      const prior = consumed.get(jti);
      if (prior) {
        return sameRecord(prior.binding, binding) && prior.expiresAt === expiresAt
          ? { ok: true }
          : { ok: false, code: "replayed" };
      }
      consumed.set(jti, { expiresAt, binding });
      return { ok: true };
    },
  };

  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body);
    requests.push({ url, method: init.method, headers, body });

    if (url === `${config.appOrigin}${config.sessionPath}`) {
      const authorization = headers.get("authorization") ?? "";
      const bridgeToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (headers.get("idempotency-key") !== body.session_id) {
        return new Response("idempotency mismatch", { status: 409 });
      }
      const verification = await verifyAndConsumeBridgeToken({
        token: bridgeToken,
        accountSid: body.connection?.account_sid,
        callSid: body.connection?.call_sid,
        streamSid: body.connection?.stream_sid,
        sessionId: body.session_id,
        mode: body.connection?.mode,
        secret: TEST_BOOTSTRAP_SECRET,
        replayCache,
      });
      if (!verification.ok) {
        return new Response(JSON.stringify({ ok: false, code: verification.code }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      let raw = responseByJti.get(verification.claims.jti);
      if (!raw) {
        const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
        const refreshAfter = new Date(Date.parse(expiresAt) - 5 * 60_000).toISOString();
        issuedCapabilities = Object.freeze({
          event: `event.${verification.claims.jti}.journal-capability`,
          mcp: `mcp.${verification.claims.jti}.tool-capability`,
          renewal: `renewal.${verification.claims.jti}.rotation-capability`,
        });
        raw = JSON.stringify({
          schema_version: 3,
          session_id: body.session_id,
          bridge_instance_id: body.bridge_instance_id,
          call_id: "application-call-1",
          connection: body.connection,
          provider: requested.provider,
          model: requested.model,
          ws_url: requested.wsUrl,
          session_update: requested.sessionUpdate,
          rotation: 0,
          rotation_endpoint: "/api/telephony/bridge/capabilities/rotate",
          active_catalog_authority: {
            catalog_digest: "a".repeat(64),
            capability_epoch: 0,
          },
          refresh_after: refreshAfter,
          event_capability: {
            token: issuedCapabilities.event,
            expires_at: expiresAt,
            audience: "telephony_events",
            purpose: "event_journal",
          },
          mcp_capability: {
            token: issuedCapabilities.mcp,
            expires_at: expiresAt,
            audience: "bridge_mcp",
            purpose: "tool_invocation",
          },
          renewal_capability: {
            token: issuedCapabilities.renewal,
            expires_at: expiresAt,
            audience: "bridge_refresh",
            purpose: "capability_rotation",
          },
          expires_at: expiresAt,
        });
        responseByJti.set(verification.claims.jti, raw);
      }
      bootstrapBodies.push(raw);
      return new Response(raw, { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === `${config.appOrigin}${config.authorityPath}`) {
      if (headers.get("authorization") !== `Bearer ${issuedCapabilities?.mcp}`) {
        return new Response("wrong capability audience", { status: 401 });
      }
      if (body.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "MCP-Session-Id": MCP_SESSION_ID },
        });
      }
      if (headers.get("mcp-session-id") !== MCP_SESSION_ID ||
          headers.get("mcp-protocol-version") !== "2025-11-25") {
        return new Response("invalid MCP session", { status: 404 });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method !== "tools/call") {
        return new Response("unsupported MCP method", { status: 400 });
      }
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(activeCatalogEnvelope()) }],
          isError: false,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url === `${config.appOrigin}${config.eventsPath}`) {
      if (headers.get("authorization") !== `Bearer ${issuedCapabilities?.event}`) {
        return new Response("wrong capability audience", { status: 401 });
      }
      eventBatches.push(body);
      return new Response(JSON.stringify({ ok: true, batch_id: body.batch_id }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`unexpected URL ${url}`);
  };

  return {
    fetchImpl,
    requests,
    eventBatches,
    bootstrapBodies,
    get issuedCapabilities() { return issuedCapabilities; },
  };
}

describe("bridge server integration", () => {
  it("does not retain the shutdown deadline after a clean drain", async (t) => {
    const childScript = [
      'import { createBridgeServer } from "./server.js";',
      'import { bridgeConfig } from "./test/support.js";',
      'const logger = { info() {}, warn() {}, error() {}, child() { return this; } };',
      'const config = bridgeConfig({ limits: { shutdownMs: 8_000 } });',
      'const bridge = createBridgeServer({ config, logger });',
      'await bridge.start({ port: 0, host: "127.0.0.1" });',
      'process.once("SIGTERM", () => { void bridge.stop("sigterm"); });',
      'process.send("ready", () => process.disconnect());',
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });

    await within(once(child, "message"), 2_000, `child did not become ready: ${stderr}`);
    const startedAt = performance.now();
    assert.equal(child.kill("SIGTERM"), true);
    const [exitCode, signal] = await within(
      once(child, "exit"),
      2_000,
      `clean drain retained the 8s shutdown timer: ${stderr}`,
    );
    const elapsedMs = performance.now() - startedAt;
    assert.equal(exitCode, 0, stderr);
    assert.equal(signal, null, stderr);
    assert(elapsedMs < 2_000, `clean shutdown took ${elapsedMs.toFixed(1)}ms`);
  });

  it("forces live transport handles when a session misses the shutdown deadline", async (t) => {
    const config = bridgeConfig({ limits: { shutdownMs: 30 } });
    const bridge = createBridgeServer({ config, logger: quietLogger() });
    t.after(() => bridge.stop("test_cleanup"));
    await bridge.start({ port: 0, host: "127.0.0.1" });
    const terminated = { twilio: 0, provider: 0 };
    bridge.sessions.add({
      shutdown: () => new Promise(() => {}),
      twilioSocket: { terminate: () => { terminated.twilio += 1; } },
      providerSocket: { terminate: () => { terminated.provider += 1; } },
    });

    const startedAt = performance.now();
    const result = await bridge.stop("test_deadline");
    const elapsedMs = performance.now() - startedAt;
    assert.deepEqual(result, { result: "deadline", activeSessions: 1 });
    assert.deepEqual(terminated, { twilio: 1, provider: 1 });
    assert(elapsedMs >= 20, `shutdown bypassed its deadline in ${elapsedMs.toFixed(1)}ms`);
    assert(elapsedMs < 1_000, `shutdown deadline took ${elapsedMs.toFixed(1)}ms`);
  });

  it("authenticates the exact public Twilio URL, caps pre-start sockets, and reaps loiterers", async (t) => {
    const config = bridgeConfig({
      twilioAuthTokenNext: "next-twilio-auth-token-with-enough-entropy",
      limits: { maximumConcurrentSessions: 1, twilioStartMs: 30, shutdownMs: 100 },
    });
    const bridge = createBridgeServer({ config, logger: quietLogger() });
    t.after(() => bridge.stop("test_cleanup"));
    const address = await bridge.start({ port: 0, host: "127.0.0.1" });
    const url = `ws://127.0.0.1:${address.port}/stream`;

    await assert.rejects(rejectedClient(url), /401/);
    assert.equal(bridge.sessions.size, 0);

    const loiterer = await openClient(url, signature(config, config.twilioAuthTokenNext));
    const closed = closeResult(loiterer);
    await waitFor(() => bridge.sessions.size === 1, "pre-start session registration");
    await assert.rejects(rejectedClient(url, signature(config)), /503/);
    const result = await closed;
    assert.equal(result.code, 1008);
    await waitFor(() => bridge.sessions.size === 0, "loiterer cleanup");
    await bridge.stop("test_complete");
  });

  it("wires one-use exchange, split capabilities, ack gate, tools, and journal end to end", async (t) => {
    const config = bridgeConfig({ limits: { twilioStartMs: 500, shutdownMs: 250 } });
    const requested = providerConfiguration();
    const provider = new FakeSocket({ readyState: 0 });
    const exchange = createExchangeHarness({ config, requested });

    const bootstrapClient = new BootstrapClient({
      appOrigin: config.appOrigin,
      endpointPath: config.sessionPath,
      fetchImpl: exchange.fetchImpl,
      timeoutMs: 200,
    });
    const bridge = createBridgeServer({
      config,
      logger: quietLogger(),
      sessionDependencies: {
        bootstrapClient,
        createProviderSocket: () => provider,
        createAuthorityClient: (capability) => new AuthorityClient({
          appOrigin: config.appOrigin,
          endpoint: config.authorityPath,
          scopeToken: capability.token,
          fetchImpl: exchange.fetchImpl,
          timeoutMs: 200,
          maximumAttempts: 1,
        }),
        createJournal: ({ capability, sessionId }) => new EventJournal({
          appOrigin: config.appOrigin,
          endpointPath: config.eventsPath,
          scope: capability.token,
          sessionId,
          fetchImpl: exchange.fetchImpl,
          maxAttempts: 1,
          retryBaseMs: 1,
          retryMaxMs: 1,
          shutdownDeadlineMs: 200,
          terminalReserveEvents: 8,
          terminalReserveBytes: 32 * 1024,
        }),
      },
    });
    t.after(() => bridge.stop("test_cleanup"));
    const address = await bridge.start({ port: 0, host: "127.0.0.1" });
    const url = `ws://127.0.0.1:${address.port}/stream`;
    const bridgeToken = mintBridgeToken({
      accountSid: ACCOUNT_SID,
      callSid: CALL_SID,
      mode: "agent",
      secret: TEST_BOOTSTRAP_SECRET,
    });

    const twilio = await openClient(url, signature(config));
    twilio.send(JSON.stringify(connected()));
    twilio.send(JSON.stringify(start({ bridgeToken })));
    await waitFor(() => exchange.bootstrapBodies.length === 1 && bridge.sessions.size === 1, "authenticated bootstrap");
    const activeSession = bridge.sessions.values().next().value;
    assert.equal(provider.sent.length, 0);

    const bootstrapRequest = exchange.requests.find((request) => request.url.endsWith(config.sessionPath));
    await bootstrapClient.createSession({
      sessionId: bootstrapRequest.body.session_id,
      bridgeToken,
      accountSid: ACCOUNT_SID,
      callSid: CALL_SID,
      streamSid: STREAM_SID,
      mode: "agent",
      bridgeInstanceId: config.instanceId,
    });
    assert.equal(exchange.bootstrapBodies.length, 2);
    assert.equal(exchange.bootstrapBodies[0], exchange.bootstrapBodies[1]);
    const callCapabilities = exchange.issuedCapabilities;

    twilio.send(JSON.stringify(media(2)));
    await waitFor(() => bridge.sessions.values().next().value?.snapshot().provider_outbox.messages === 1, "pre-ack media queue");
    provider.open();
    await waitFor(() => provider.sent.length === 1, "session update");
    assert.deepEqual(provider.sent.map((event) => event.type), ["session.update"]);
    const acknowledged = structuredClone(requested.sessionUpdate.session);
    acknowledged.id = "provider-session-integration";
    provider.receive({ type: "session.updated", session: acknowledged });
    await waitFor(() => provider.sent.some((event) => event.type === "input_audio_buffer.append"), "ack-gated media release");

    provider.receive({ type: "response.created", response: { id: "r_e2e", status: "in_progress" } });
    provider.receive({
      type: "response.function_call_arguments.done",
      response_id: "r_e2e",
      item_id: "tool_e2e_item",
      call_id: "tool_e2e",
      name: "capability_gateway",
      arguments: '{"tool_name":"membership_lookup","arguments":{}}',
    });
    assert.equal(exchange.requests.filter((request) => request.url.endsWith(config.authorityPath)).length, 0);
    provider.receive({
      type: "response.done",
      response: {
        id: "r_e2e",
        status: "completed",
        output: [{
          type: "function_call",
          id: "tool_e2e_item",
          call_id: "tool_e2e",
          name: "capability_gateway",
          arguments: '{"tool_name":"membership_lookup","arguments":{}}',
          status: "completed",
        }],
      },
    });
    await waitFor(
      () => provider.sent.some((event) => event.type === "conversation.item.create")
        || activeSession.state === "closed",
      "authority result round trip",
    );
    assert.notEqual(
      activeSession.state,
      "closed",
      JSON.stringify({ requests: exchange.requests.map((request) => request.url), eventBatches: exchange.eventBatches }),
    );
    const authorityRequests = exchange.requests.filter((request) => request.url.endsWith(config.authorityPath));
    assert.deepEqual(authorityRequests.map((request) => request.body.method), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.equal(authorityRequests[0].headers.has("mcp-session-id"), false);
    assert.equal(authorityRequests[1].headers.get("mcp-session-id"), MCP_SESSION_ID);
    assert.equal(authorityRequests[2].headers.get("mcp-session-id"), MCP_SESSION_ID);
    assert.equal(authorityRequests[2].body.params.name, "membership_lookup");
    assert.equal(authorityRequests[2].body.params._meta["hacc/provider_tool_call_id"], "tool_e2e");
    assert.deepEqual(authorityRequests[2].body.params._meta["com.harsha.callcenter/active-catalog"], {
      catalog_digest: "a".repeat(64),
      capability_epoch: 0,
    });
    assert.deepEqual(authorityRequests[2].body.params.arguments, {});
    const output = provider.sent.find((event) => event.type === "conversation.item.create");
    assert.deepEqual(JSON.parse(output.item.output), activeCatalogEnvelope());

    const firstClosed = closeResult(twilio);
    twilio.send(JSON.stringify(stop(3)));
    assert.equal((await firstClosed).code, 1000);
    await waitFor(() => bridge.sessions.size === 0, "journaled first session close");
    await waitFor(() => exchange.eventBatches.some((batch) => batch.complete === true), "completion acknowledgement");

    const replay = await openClient(url, signature(config));
    const replayClosed = closeResult(replay);
    replay.send(JSON.stringify(connected()));
    replay.send(JSON.stringify(start({ bridgeToken })));
    assert.equal((await replayClosed).code, 1008);

    const wrongCallToken = mintBridgeToken({
      accountSid: ACCOUNT_SID,
      callSid: CALL_SID,
      mode: "agent",
      secret: TEST_BOOTSTRAP_SECRET,
    });
    await assert.rejects(bootstrapClient.createSession({
      sessionId: "wrong-call-session",
      bridgeToken: wrongCallToken,
      accountSid: ACCOUNT_SID,
      callSid: ALTERNATE_CALL_SID,
      streamSid: STREAM_SID,
      mode: "agent",
      bridgeInstanceId: config.instanceId,
    }), (error) => error?.code === "bootstrap_http_401" && error?.status === 401);

    const streamBoundToken = mintBridgeToken({
      accountSid: ACCOUNT_SID,
      callSid: CALL_SID,
      mode: "agent",
      secret: TEST_BOOTSTRAP_SECRET,
    });
    await bootstrapClient.createSession({
      sessionId: "stream-bound-session",
      bridgeToken: streamBoundToken,
      accountSid: ACCOUNT_SID,
      callSid: CALL_SID,
      streamSid: STREAM_SID,
      mode: "agent",
      bridgeInstanceId: config.instanceId,
    });
    await assert.rejects(bootstrapClient.createSession({
      sessionId: "stream-substitution-session",
      bridgeToken: streamBoundToken,
      accountSid: ACCOUNT_SID,
      callSid: CALL_SID,
      streamSid: ALTERNATE_STREAM_SID,
      mode: "agent",
      bridgeInstanceId: config.instanceId,
    }), (error) => error?.code === "bootstrap_http_401" && error?.status === 401);

    const wrongMcpAudience = await exchange.fetchImpl(`${config.appOrigin}${config.authorityPath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${exchange.issuedCapabilities.event}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "wrong-mcp-audience" }),
    });
    const wrongEventAudience = await exchange.fetchImpl(`${config.appOrigin}${config.eventsPath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${exchange.issuedCapabilities.mcp}` },
      body: JSON.stringify({ batch_id: "wrong-event-audience" }),
    });
    assert.equal(wrongMcpAudience.status, 401);
    assert.equal(wrongEventAudience.status, 401);

    assert.equal(bootstrapRequest.method, "POST");
    assert.equal(bootstrapRequest.headers.get("authorization"), `Bearer ${bridgeToken}`);
    assert.equal(bootstrapRequest.headers.get("idempotency-key"), bootstrapRequest.body.session_id);
    assert(authorityRequests.every((request) =>
      request.headers.get("authorization") === `Bearer ${callCapabilities.mcp}`));
    const eventRequest = exchange.requests.find((request) => request.url.endsWith(config.eventsPath));
    assert.equal(eventRequest.headers.get("authorization"), `Bearer ${callCapabilities.event}`);
    assert.notEqual(callCapabilities.event, callCapabilities.mcp);
    assert.notEqual(callCapabilities.event, bridgeToken);
    assert.notEqual(callCapabilities.mcp, bridgeToken);
    for (const request of exchange.requests) {
      assert.equal(request.url.includes(bridgeToken), false);
      assert.equal(JSON.stringify(request.body).includes(bridgeToken), false);
      assert.equal(JSON.stringify(request.body).includes(config.providerKeys.openai), false);
    }
    assert(exchange.eventBatches.some((batch) => batch.events.some((event) => event.type === "tool.batch_settled")));
    assert(exchange.eventBatches.some((batch) => batch.complete === true && batch.events.length === 0));
    await bridge.stop("test_complete");
  });
});
