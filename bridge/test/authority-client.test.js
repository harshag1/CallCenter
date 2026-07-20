import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AuthorityClient,
  AuthorityClientError,
  providerCallRpcId,
} from "../lib/authority-client.js";

const SCOPE = "signed-call-scope.payload";
const ACTIVE_CATALOG_AUTHORITY = Object.freeze({
  catalogDigest: "a".repeat(64),
  capabilityEpoch: 0,
});
const IDENTITY = Object.freeze({
  provider: "openai",
  responseId: "response_1",
  itemId: "item_1",
  callId: "call_1",
  activeCatalogAuthority: ACTIVE_CATALOG_AUTHORITY,
});
const MCP_SESSION_ID = `hacc.v1.${Buffer.alloc(16, 1).toString("base64url")}.${Buffer.alloc(32, 2).toString("base64url")}`;
const MCP_SESSION_ID_2 = `hacc.v1.${Buffer.alloc(16, 3).toString("base64url")}.${Buffer.alloc(32, 4).toString("base64url")}`;

function gateway(toolName = "membership_lookup", args = {}) {
  return { tool_name: toolName, arguments: args };
}

function catalogEnvelope(outcome = { ok: true }, overrides = {}) {
  const catalog = {
    schema_version: 1,
    availability: "active",
    runtime_digest: "b".repeat(64),
    capability_epoch: 0,
    state_revision: 0,
    scope: { status: "routing", topic: null, step: "$flow.routing", attempt: 0 },
    active_context: {},
    catalog_digest: ACTIVE_CATALOG_AUTHORITY.catalogDigest,
    tools: [],
    ...overrides,
  };
  return { schema_version: 1, outcome, active_capability_catalog: catalog };
}

function rpcResponse(id, result = {
  content: [{ type: "text", text: JSON.stringify(catalogEnvelope()) }],
  isError: false,
}, init = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function mcpFetch(toolFetch, onRequest = () => {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    onRequest({ url, init, body });
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
        headers: {
          "Content-Type": "application/json",
          "MCP-Session-Id": MCP_SESSION_ID,
        },
      });
    }
    if (body.method === "notifications/initialized") {
      assert.equal(init.headers["MCP-Session-Id"], MCP_SESSION_ID);
      assert.equal(init.headers["MCP-Protocol-Version"], "2025-11-25");
      return new Response(null, { status: 202 });
    }
    assert.equal(body.method, "tools/call");
    assert.equal(init.headers["MCP-Session-Id"], MCP_SESSION_ID);
    assert.equal(init.headers["MCP-Protocol-Version"], "2025-11-25");
    return toolFetch(url, init);
  };
}

function client(fetchImpl, options = {}) {
  return new AuthorityClient({
    appOrigin: "https://voice.example",
    scopeToken: SCOPE,
    fetchImpl: mcpFetch(fetchImpl),
    maximumAttempts: 1,
    ...options,
  });
}

describe("provider call correlation", () => {
  it("is deterministic, bounded, domain-separated, and provenance-sensitive", () => {
    const first = providerCallRpcId(IDENTITY);
    assert.equal(first, providerCallRpcId({ ...IDENTITY }));
    assert.match(first, /^bridge-call:v1:[a-f0-9]{64}$/);
    assert.ok(Buffer.byteLength(first, "utf8") < 256);
    assert.notEqual(first, providerCallRpcId({ ...IDENTITY, provider: "xai" }));
    assert.notEqual(first, providerCallRpcId({ ...IDENTITY, responseId: "response_2" }));
    assert.notEqual(first, providerCallRpcId({ ...IDENTITY, itemId: undefined }));
    assert.throws(() => providerCallRpcId({ ...IDENTITY, callId: "bad\ncall" }), /callId/);
    assert.throws(() => providerCallRpcId({ ...IDENTITY, responseId: undefined }), /responseId/);
  });
});

describe("same-origin authority boundary", () => {
  it("rejects cross-origin endpoints, plaintext production origins, and provider keys", () => {
    const noFetch = async () => { throw new Error("unused"); };
    assert.throws(() => new AuthorityClient({
      appOrigin: "https://voice.example",
      endpoint: "https://attacker.example/api/mcp",
      scopeToken: SCOPE,
      fetchImpl: noFetch,
    }), /same-origin/);
    assert.throws(() => new AuthorityClient({
      appOrigin: "http://voice.example",
      scopeToken: SCOPE,
      fetchImpl: noFetch,
    }), /HTTPS/);
    assert.throws(() => new AuthorityClient({
      appOrigin: "https://voice.example/path",
      scopeToken: SCOPE,
      fetchImpl: noFetch,
    }), /without credentials, path/);
    assert.throws(() => new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: "sk-proj-not-a-real-key",
      fetchImpl: noFetch,
    }), (error) => error instanceof AuthorityClientError && error.code === "provider_key_refused");
    assert.throws(() => new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: SCOPE,
      fetchImpl: noFetch,
      headers: { "X-Api-Key": "provider-secret" },
    }), (error) => error.code === "invalid_options");

    assert.doesNotThrow(() => new AuthorityClient({
      appOrigin: "http://127.0.0.1:3000",
      scopeToken: SCOPE,
      fetchImpl: noFetch,
      allowInsecureLocalhostForTests: true,
    }));
  });

  it("allows only capability_gateway and sends no provider credential", async () => {
    let observed;
    const authority = client(async (url, init) => {
      observed = { url, init, body: JSON.parse(init.body) };
      return rpcResponse(observed.body.id);
    });

    const result = await authority.callCapabilityGateway({
      ...IDENTITY,
      name: "capability_gateway",
      arguments: gateway("get_membership", { operation: "get_state" }),
    });
    assert.equal(observed.url, "https://voice.example/api/mcp");
    assert.equal(observed.init.method, "POST");
    assert.equal(observed.init.headers.Authorization, `Bearer ${SCOPE}`);
    assert.equal(observed.init.headers["MCP-Session-Id"], MCP_SESSION_ID);
    assert.equal(observed.init.headers["MCP-Protocol-Version"], "2025-11-25");
    assert.equal(Object.keys(observed.init.headers).some((key) => /openai|xai|api.key/i.test(key)), false);
    assert.deepEqual(observed.body, {
      jsonrpc: "2.0",
      id: providerCallRpcId(IDENTITY),
      method: "tools/call",
      params: {
        name: "get_membership",
        arguments: { operation: "get_state" },
        _meta: {
          "hacc/provider_tool_call_id": IDENTITY.callId,
          "com.harsha.callcenter/active-catalog": {
            catalog_digest: ACTIVE_CATALOG_AUTHORITY.catalogDigest,
            capability_epoch: ACTIVE_CATALOG_AUTHORITY.capabilityEpoch,
          },
        },
      },
    });
    assert.deepEqual(result, {
      output: catalogEnvelope(),
      isError: false,
      activeCatalogAuthority: { ...ACTIVE_CATALOG_AUTHORITY, availability: "active" },
    });
    assert.equal(Object.isFrozen(result), true);

    assert.throws(() => authority.callCapabilityGateway({
      ...IDENTITY,
      name: "run_action",
      arguments: gateway(),
    }), (error) => error.code === "tool_not_allowed");
    assert.throws(() => authority.callCapabilityGateway({
      ...IDENTITY,
      name: "capability_gateway",
      arguments: gateway(),
      _meta: { idempotency_key: "attacker-selected" },
    }), (error) => error.code === "invalid_call");

    assert.throws(() => { authority.endpoint = "https://attacker.example/api/mcp"; }, TypeError);
    assert.throws(() => { authority.fetch = async () => { throw new Error("credential observer"); }; }, TypeError);
  });
});

describe("MCP lifecycle and durable provider identity", () => {
  it("completes the canonical handshake before carrying native identity in trusted top-level metadata", async () => {
    const requests = [];
    const authority = new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: SCOPE,
      maximumAttempts: 1,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url, init, body });
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
            headers: {
              "Content-Type": "application/json",
              "MCP-Session-Id": MCP_SESSION_ID,
            },
          });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return rpcResponse(body.id);
      },
    });

    const result = await authority.callCapabilityGateway({
      ...IDENTITY,
      arguments: gateway("reserve_slot", {
        operation: "reserve",
        _meta: { "hacc/provider_tool_call_id": "model-controlled-shadow" },
      }),
    });
    assert.deepEqual(result, {
      output: catalogEnvelope(),
      isError: false,
      activeCatalogAuthority: { ...ACTIVE_CATALOG_AUTHORITY, availability: "active" },
    });
    assert.equal(requests.length, 3);

    const [initialize, initialized, tool] = requests;
    assert.equal(initialize.url, "https://voice.example/api/mcp");
    assert.equal(initialize.init.headers.Authorization, `Bearer ${SCOPE}`);
    assert.equal(Object.hasOwn(initialize.init.headers, "MCP-Session-Id"), false);
    assert.deepEqual(initialize.body, {
      jsonrpc: "2.0",
      id: "bridge-initialize:v1",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "harshas-amazing-call-center-bridge", version: "1.0.0" },
      },
    });
    assert.deepEqual(initialized.body, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(initialized.init.headers["MCP-Session-Id"], MCP_SESSION_ID);
    assert.equal(initialized.init.headers["MCP-Protocol-Version"], "2025-11-25");
    assert.equal(tool.init.headers["MCP-Session-Id"], MCP_SESSION_ID);
    assert.equal(tool.init.headers["MCP-Protocol-Version"], "2025-11-25");
    assert.equal(tool.body.id, providerCallRpcId(IDENTITY));
    assert.notEqual(tool.body.id, IDENTITY.callId);
    assert.deepEqual(tool.body.params._meta, {
      "hacc/provider_tool_call_id": IDENTITY.callId,
      "com.harsha.callcenter/active-catalog": {
        catalog_digest: ACTIVE_CATALOG_AUTHORITY.catalogDigest,
        capability_epoch: ACTIVE_CATALOG_AUTHORITY.capabilityEpoch,
      },
    });
    assert.equal(
      tool.body.params.arguments._meta["hacc/provider_tool_call_id"],
      "model-controlled-shadow",
    );
  });

  it("coalesces initialization across distinct concurrent provider calls", async () => {
    const methods = [];
    const authority = new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: SCOPE,
      maximumAttempts: 1,
      fetchImpl: mcpFetch(async (_url, init) => rpcResponse(JSON.parse(init.body).id), ({ body }) => {
        methods.push(body.method);
      }),
    });

    await Promise.all([
      authority.callCapabilityGateway({ ...IDENTITY, arguments: gateway("lookup_member", { n: 1 }) }),
      authority.callCapabilityGateway({
        ...IDENTITY,
        callId: "call_2",
        responseId: "response_2",
        itemId: "item_2",
        arguments: gateway("renew_membership", { n: 2 }),
      }),
    ]);
    assert.equal(methods.filter((method) => method === "initialize").length, 1);
    assert.equal(methods.filter((method) => method === "notifications/initialized").length, 1);
    assert.equal(methods.filter((method) => method === "tools/call").length, 2);
  });

  it("rejects missing, malformed, or noncanonical MCP sessions before tool dispatch", async () => {
    const sessions = [
      null,
      "opaque-session",
      `${MCP_SESSION_ID}extra`,
      `hacc.v1.${"A".repeat(22)}.${"B".repeat(43)}`,
    ];
    for (let index = 0; index < sessions.length; index += 1) {
      let dispatched = 0;
      const authority = new AuthorityClient({
        appOrigin: "https://voice.example",
        scopeToken: SCOPE,
        maximumAttempts: 1,
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(init.body);
          if (body.method !== "initialize") dispatched += 1;
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
            },
          }), {
            headers: {
              "Content-Type": "application/json",
              ...(sessions[index] === null ? {} : { "MCP-Session-Id": sessions[index] }),
            },
          });
        },
      });
      await assert.rejects(
        authority.callCapabilityGateway({
          ...IDENTITY,
          callId: `invalid_session_${index}`,
          arguments: gateway(),
        }),
        (error) => error.code === "invalid_mcp_session" &&
          error.executionStarted === false && error.indeterminate === false,
      );
      assert.equal(dispatched, 0);
    }
  });

  it("validates the negotiated protocol surface before publishing session state", async () => {
    const invalidResults = [
      {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
      },
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
      },
      {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
      },
    ];
    for (let index = 0; index < invalidResults.length; index += 1) {
      let requests = 0;
      const authority = new AuthorityClient({
        appOrigin: "https://voice.example",
        scopeToken: SCOPE,
        maximumAttempts: 1,
        fetchImpl: async (_url, init) => {
          requests += 1;
          const body = JSON.parse(init.body);
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: invalidResults[index],
          }), {
            headers: { "Content-Type": "application/json", "MCP-Session-Id": MCP_SESSION_ID },
          });
        },
      });
      await assert.rejects(
        authority.callCapabilityGateway({
          ...IDENTITY,
          callId: `invalid_init_${index}`,
          arguments: gateway(),
        }),
        (error) => error.code === "invalid_initialize_result" && error.executionStarted === false,
      );
      assert.equal(requests, 1);
    }
  });

  it("classifies malformed initialize correlation as pre-execution and determinate", async () => {
    const authority = new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: SCOPE,
      maximumAttempts: 1,
      fetchImpl: async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "substituted-initialize-id",
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
        },
      }), {
        headers: { "Content-Type": "application/json", "MCP-Session-Id": MCP_SESSION_ID },
      }),
    });
    await assert.rejects(
      authority.callCapabilityGateway({ ...IDENTITY, arguments: gateway() }),
      (error) => error.code === "rpc_identity_mismatch" &&
        error.indeterminate === false && error.executionStarted === false,
    );
  });

  it("bounds the native provider identity exactly to the authority route limit", async () => {
    let observedNativeId;
    const authority = client(async (_url, init) => {
      const body = JSON.parse(init.body);
      observedNativeId = body.params._meta["hacc/provider_tool_call_id"];
      return rpcResponse(body.id);
    });
    const maximum = `c${"a".repeat(255)}`;
    await authority.callCapabilityGateway({ ...IDENTITY, callId: maximum, arguments: gateway() });
    assert.equal(observedNativeId, maximum);
    assert.equal(Buffer.byteLength(observedNativeId, "utf8"), 256);
    assert.throws(
      () => authority.callCapabilityGateway({
        ...IDENTITY,
        callId: `c${"a".repeat(256)}`,
        arguments: gateway(),
      }),
      (error) => error.code === "invalid_call_identity",
    );
  });

  it("coalesces one safe reinitialization when the server rejects a stale session before dispatch", async () => {
    let initializeCount = 0;
    let staleRejects = 0;
    const executedNativeIds = [];
    const authority = new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: SCOPE,
      maximumAttempts: 1,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === "initialize") {
          initializeCount += 1;
          const sessionId = initializeCount === 1 ? MCP_SESSION_ID : MCP_SESSION_ID_2;
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
            },
          }), {
            headers: { "Content-Type": "application/json", "MCP-Session-Id": sessionId },
          });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (init.headers["MCP-Session-Id"] === MCP_SESSION_ID) {
          staleRejects += 1;
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32002, message: "invalid MCP session" },
          }), { status: 404, headers: { "Content-Type": "application/json" } });
        }
        assert.equal(init.headers["MCP-Session-Id"], MCP_SESSION_ID_2);
        executedNativeIds.push(body.params._meta["hacc/provider_tool_call_id"]);
        return rpcResponse(body.id);
      },
    });

    await Promise.all([
      authority.callCapabilityGateway({
        ...IDENTITY,
        callId: "reconnect_call_1",
        arguments: gateway("lookup_member", { n: 1 }),
      }),
      authority.callCapabilityGateway({
        ...IDENTITY,
        callId: "reconnect_call_2",
        responseId: "response_reconnect_2",
        itemId: "item_reconnect_2",
        arguments: gateway("lookup_member", { n: 2 }),
      }),
    ]);
    assert.equal(initializeCount, 2);
    assert.equal(staleRejects, 2);
    assert.deepEqual(executedNativeIds.sort(), ["reconnect_call_1", "reconnect_call_2"]);
  });
});

describe("bounded JSON-RPC execution", () => {
  it("retries indeterminate HTTP failures with the exact same stable id", async () => {
    const requests = [];
    const sleeps = [];
    const authority = new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: SCOPE,
      maximumAttempts: 2,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: mcpFetch(async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        if (requests.length === 1) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "temporary" },
          }), { status: 503, headers: { "Content-Type": "application/json" } });
        }
        return rpcResponse(body.id);
      }),
    });

    const result = await authority.callCapabilityGateway({
      ...IDENTITY,
      arguments: gateway("reserve_slot", { action: "reserve" }),
    });
    assert.equal(result.isError, false);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].id, requests[1].id);
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(sleeps, [50]);

    const cached = await authority.callCapabilityGateway({
      ...IDENTITY,
      arguments: gateway("reserve_slot", { action: "reserve" }),
    });
    assert.equal(cached, result);
    assert.equal(requests.length, 2);
  });

  it("coalesces exact concurrency and rejects identity reuse with changed arguments", async () => {
    let resolveFetch;
    let signalDispatched;
    const dispatched = new Promise((resolve) => { signalDispatched = resolve; });
    let count = 0;
    const authority = client((_url, init) => {
      count += 1;
      const id = JSON.parse(init.body).id;
      signalDispatched();
      return new Promise((resolve) => { resolveFetch = () => resolve(rpcResponse(id)); });
    });
    const first = authority.callCapabilityGateway({
      ...IDENTITY,
      arguments: gateway("run_action", { action: "one" }),
    });
    const duplicate = authority.callCapabilityGateway({
      ...IDENTITY,
      arguments: gateway("run_action", { action: "one" }),
    });
    const conflict = authority.callCapabilityGateway({
      ...IDENTITY,
      arguments: gateway("run_action", { action: "two" }),
    });
    await assert.rejects(conflict, (error) => error.code === "provider_call_identity_conflict");
    await dispatched;
    assert.equal(count, 1);
    resolveFetch();
    assert.equal(await first, await duplicate);

    await assert.rejects(
      authority.callCapabilityGateway({
        ...IDENTITY,
        responseId: "response_rebound",
        arguments: gateway("run_action", { action: "one" }),
      }),
      (error) => error.code === "provider_call_identity_conflict",
    );
    assert.equal(count, 1);
  });

  it("rejects response identity mismatches, duplicate keys, and dual result/error", async () => {
    const cases = [
      (id) => rpcResponse(`${id}-wrong`),
      (id) => new Response(`{"jsonrpc":"2.0","id":"${id}","result":{},"result":{"changed":true}}`, {
        headers: { "Content-Type": "application/json" },
      }),
      (id) => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {},
        error: { code: -1, message: "ambiguous" },
      }), { headers: { "Content-Type": "application/json" } }),
    ];
    const expectedCodes = ["rpc_identity_mismatch", "invalid_json", "invalid_rpc_response"];
    for (let index = 0; index < cases.length; index += 1) {
      const authority = client(async (_url, init) => cases[index](JSON.parse(init.body).id));
      await assert.rejects(
        authority.callCapabilityGateway({
          ...IDENTITY,
          callId: `call_${index}`,
          arguments: gateway(),
        }),
        (error) => error instanceof AuthorityClientError && error.code === expectedCodes[index],
      );
    }
  });

  it("caps advertised and streamed response bodies", async () => {
    const advertised = client(async () => new Response("{}", {
      headers: { "Content-Type": "application/json", "Content-Length": "1000" },
    }), { maximumResponseBytes: 256 });
    await assert.rejects(
      advertised.callCapabilityGateway({ ...IDENTITY, arguments: gateway() }),
      (error) => error.code === "response_too_large" && error.indeterminate === true,
    );

    const streamed = client(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(150)));
        controller.enqueue(new TextEncoder().encode("y".repeat(150)));
        controller.close();
      },
    }), { headers: { "Content-Type": "application/json" } }), { maximumResponseBytes: 256 });
    await assert.rejects(
      streamed.callCapabilityGateway({ ...IDENTITY, callId: "call_stream", arguments: gateway() }),
      (error) => error.code === "response_too_large",
    );
  });

  it("requires the exact same-origin MCP tools/call result shape", async () => {
    const invalidResults = [
      {},
      { content: [], isError: false },
      { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }], isError: false },
      { content: [{ type: "image", data: "secret" }], isError: false },
      { content: [{ type: "text", text: "ok", extra: true }], isError: false },
      { content: [{ type: "text", text: "not-json" }], isError: false },
      { content: [{ type: "text", text: "ok" }], isError: "false" },
      { content: [{ type: "text", text: "ok" }], isError: false, unexpected: true },
    ];
    for (let index = 0; index < invalidResults.length; index += 1) {
      const authority = client(async (_url, init) => rpcResponse(JSON.parse(init.body).id, invalidResults[index]));
      await assert.rejects(
        authority.callCapabilityGateway({
          ...IDENTITY,
          callId: `bad_result_${index}`,
          arguments: gateway(),
        }),
        (error) => error.code === "invalid_tool_result" && error.indeterminate === true,
      );
    }
  });

  it("validates the complete public catalog envelope and rejects private authority disclosure", async () => {
    const directTool = {
      logical_name: "lookup_member",
      description: "Look up the current member.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      effect: "read",
      invocation: { mode: "direct", tool_name: "lookup_member", arguments_from: "$MODEL_ARGUMENTS" },
      allowed_outcomes: ["completed", "rejected"],
    };
    const invalidEnvelopes = [
      { schema_version: 1, active_capability_catalog: catalogEnvelope().active_capability_catalog },
      catalogEnvelope({}, { catalog_digest: "A".repeat(64) }),
      catalogEnvelope({}, { availability: "blocked", tools: [directTool] }),
      catalogEnvelope({}, {
        tools: [{
          ...directTool,
          invocation: { ...directTool.invocation, capability_grant: "private-grant" },
        }],
      }),
      catalogEnvelope({}, { scope: { status: "active", topic: null, step: "", attempt: 0 } }),
    ];
    for (let index = 0; index < invalidEnvelopes.length; index += 1) {
      const authority = client(async (_url, init) => rpcResponse(JSON.parse(init.body).id, {
        content: [{ type: "text", text: JSON.stringify(invalidEnvelopes[index]) }],
        isError: false,
      }));
      await assert.rejects(
        authority.callCapabilityGateway({
          ...IDENTITY,
          callId: `invalid_catalog_${index}`,
          arguments: gateway(),
        }),
        (error) => error.code === "invalid_active_catalog_result" &&
          error.indeterminate === true && error.executionStarted === true,
      );
    }

    const blockedEnvelope = catalogEnvelope(
      { error: "catalog refresh failed" },
      { availability: "blocked", catalog_digest: "c".repeat(64), capability_epoch: 2, tools: [] },
    );
    const blocked = client(async (_url, init) => rpcResponse(JSON.parse(init.body).id, {
      content: [{ type: "text", text: JSON.stringify(blockedEnvelope) }],
      isError: true,
    }));
    const result = await blocked.callCapabilityGateway({
      ...IDENTITY,
      callId: "blocked_catalog",
      arguments: gateway(),
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.activeCatalogAuthority, {
      catalogDigest: "c".repeat(64),
      capabilityEpoch: 2,
      availability: "blocked",
    });
  });

  it("rejects missing, mutable-shaped, or malformed catalog expectations before fetch", () => {
    let calls = 0;
    const authority = client(async () => { calls += 1; return rpcResponse("unused"); });
    for (const [index, activeCatalogAuthority] of [
      undefined,
      { catalogDigest: "A".repeat(64), capabilityEpoch: 0 },
      { catalogDigest: "a".repeat(64), capabilityEpoch: -1 },
      { catalogDigest: "a".repeat(64), capabilityEpoch: 0, privateGrant: "forbidden" },
    ].entries()) {
      assert.throws(
        () => authority.callCapabilityGateway({
          ...IDENTITY,
          callId: `bad_catalog_expectation_${index}`,
          activeCatalogAuthority,
          arguments: gateway(),
        }),
        (error) => error.code === "invalid_active_catalog_authority" && error.executionStarted === false,
      );
    }
    assert.equal(calls, 0);
  });

  it("times out a dispatched request as indeterminate without leaking secrets", async () => {
    const authority = client((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }), { timeoutMs: 5 });
    await assert.rejects(
      authority.callCapabilityGateway({ ...IDENTITY, callId: "call_timeout", arguments: gateway() }),
      (error) => {
        assert.equal(error.code, "timeout");
        assert.equal(error.indeterminate, true);
        assert.equal(error.retryable, false);
        assert.equal(error.executionStarted, null);
        assert.equal(error.message.includes(SCOPE), false);
        return true;
      },
    );
  });

  it("close aborts retry backoff and forbids a post-hangup redispatch", async () => {
    let toolRequests = 0;
    let signalBackoff;
    const backoffStarted = new Promise((resolve) => { signalBackoff = resolve; });
    const authority = new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: SCOPE,
      maximumAttempts: 2,
      sleep: () => {
        signalBackoff();
        return new Promise(() => {});
      },
      fetchImpl: mcpFetch(async (_url, init) => {
        toolRequests += 1;
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: "temporary" },
        }), { status: 503, headers: { "Content-Type": "application/json" } });
      }),
    });

    const pending = authority.callCapabilityGateway({
      ...IDENTITY,
      callId: "close_during_backoff",
      arguments: gateway("reserve_slot", { slot: "10:00" }),
    });
    await backoffStarted;
    authority.close();
    await assert.rejects(
      pending,
      (error) => error.code === "authority_closed" &&
        error.retryable === false && error.indeterminate === true,
    );
    assert.equal(toolRequests, 1);
    await assert.rejects(
      authority.callCapabilityGateway({
        ...IDENTITY,
        callId: "after_close",
        responseId: "after_close_response",
        arguments: gateway(),
      }),
      (error) => error.code === "authority_closed" && error.executionStarted === false,
    );
  });

  it("applies one deadline across initialization and notification retries", async () => {
    let requests = 0;
    const authority = new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: SCOPE,
      timeoutMs: 10,
      maximumAttempts: 3,
      fetchImpl: async (_url, init) => {
        requests += 1;
        const body = JSON.parse(init.body);
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
            headers: { "Content-Type": "application/json", "MCP-Session-Id": MCP_SESSION_ID },
          });
        }
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      },
    });
    const started = Date.now();
    await assert.rejects(
      authority.callCapabilityGateway({
        ...IDENTITY,
        callId: "initialization_deadline",
        arguments: gateway(),
      }),
      (error) => error.code === "timeout" &&
        error.executionStarted === false && error.indeterminate === false,
    );
    assert(Date.now() - started < 100, "one operation deadline should prevent nested retry amplification");
    assert.equal(requests, 2);
  });

  it("applies the same deadline to response body consumption", async () => {
    const authority = client(async () => new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
    }), { headers: { "Content-Type": "application/json" } }), { timeoutMs: 5 });
    await assert.rejects(
      authority.callCapabilityGateway({ ...IDENTITY, callId: "call_body_timeout", arguments: gateway() }),
      (error) => error.code === "timeout" && error.indeterminate === true && error.executionStarted === true,
    );
  });

  it("bounds retained settled results by bytes without redispatching an evicted replay", async () => {
    let calls = 0;
    const authority = client(async (_url, init) => {
      calls += 1;
      return rpcResponse(JSON.parse(init.body).id, {
        content: [{ type: "text", text: JSON.stringify(catalogEnvelope({ payload: "x".repeat(256) })) }],
        isError: false,
      });
    }, { maximumRetainedResultBytes: 128 });
    const result = await authority.callCapabilityGateway({
      ...IDENTITY,
      callId: "call_evicted",
      arguments: gateway(),
    });
    assert.equal(result.output.outcome.payload.length, 256);
    await assert.rejects(
      authority.callCapabilityGateway({ ...IDENTITY, callId: "call_evicted", arguments: gateway() }),
      (error) => error.code === "replay_result_evicted" &&
        error.executionStarted === true && error.indeterminate === true,
    );
    assert.equal(calls, 1);
  });

  it("rejects cyclic, unsafe, and oversized request arguments before fetch", async () => {
    let calls = 0;
    const authority = client(async () => { calls += 1; throw new Error("should not fetch"); });
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(
      () => authority.callCapabilityGateway({ ...IDENTITY, arguments: gateway("cyclic_tool", cyclic) }),
      /cycle/,
    );
    const unsafe = Object.create(null);
    Object.defineProperty(unsafe, "__proto__", { value: "bad", enumerable: true });
    assert.throws(
      () => authority.callCapabilityGateway({
        ...IDENTITY,
        callId: "call_unsafe",
        arguments: gateway("unsafe_tool", unsafe),
      }),
      /unsafe key/,
    );
    assert.throws(
      () => authority.callCapabilityGateway({
        ...IDENTITY,
        callId: "call_big",
        arguments: gateway("large_tool", { body: "x".repeat(300_000) }),
      }),
      (error) => error.code === "request_too_large" && error.executionStarted === false,
    );
    assert.throws(
      () => authority.callCapabilityGateway({
        ...IDENTITY,
        callId: "call_many_nodes",
        arguments: gateway("wide_tool", { values: Array.from({ length: 4_097 }, () => null) }),
      }),
      (error) => error.code === "json_too_complex" && error.executionStarted === false,
    );
    const accessor = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => "must-not-run" });
    assert.throws(
      () => authority.callCapabilityGateway({
        ...IDENTITY,
        callId: "call_accessor",
        arguments: gateway("accessor_tool", accessor),
      }),
      (error) => error.code === "invalid_json" && error.executionStarted === false,
    );
    assert.equal(calls, 0);
  });

  it("fails closed on weakened or ambiguous capability_gateway envelopes", () => {
    let calls = 0;
    const authority = client(async () => { calls += 1; throw new Error("should not fetch"); });
    const invalid = [
      { action: "lookup_member", arguments: {} },
      { tool_name: "lookup_member", arguments: {}, extra: true },
      { tool_name: "LookupMember", arguments: {} },
      { tool_name: "a", arguments: {} },
      { tool_name: "lookup_member", arguments: [] },
      { tool_name: "lookup_member", arguments: null },
    ];
    for (let index = 0; index < invalid.length; index += 1) {
      assert.throws(
        () => authority.callCapabilityGateway({
          ...IDENTITY,
          callId: `invalid_gateway_${index}`,
          arguments: invalid[index],
        }),
        (error) => error.code === "invalid_arguments" && error.executionStarted === false,
      );
    }
    assert.equal(calls, 0);
  });
});
