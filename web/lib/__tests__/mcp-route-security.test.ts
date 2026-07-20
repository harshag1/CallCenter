import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyScope: vi.fn(),
  activeCapabilityAuthorityFor: vi.fn(),
  callActiveCapability: vi.fn(),
  qOne: vi.fn(),
  resolveVoiceProviderConfig: vi.fn(),
}));

vi.mock("@/lib/voice", () => ({ verifyScope: mocks.verifyScope }));
vi.mock("@/lib/mcp", () => ({
  activeCapabilityAuthorityFor: mocks.activeCapabilityAuthorityFor,
  callActiveCapability: mocks.callActiveCapability,
}));
vi.mock("@/lib/db", () => ({ qOne: mocks.qOne }));
vi.mock("@/lib/realtime/config", () => ({
  resolveVoiceProviderConfig: mocks.resolveVoiceProviderConfig,
}));
vi.mock("@/lib/mcp-client", async () => import("../mcp-client"));

import { POST } from "../../app/api/mcp/route";
// The standalone bridge is intentionally plain ESM JavaScript so it can run without the web
// build. This cross-package test exercises its real client against the real route boundary.
import { AuthorityClient } from "../../../bridge/lib/authority-client.js";

const originalGatewaySecret = process.env.MCP_GATEWAY_SECRET;
const scope = {
  aud: "mcp",
  callId: "call-1",
  agentId: "agent-1",
  orgId: "org-1",
  provider: "gemini",
  jti: "scope-token-identity-1",
};
const otherScope = {
  ...scope,
  callId: "call-2",
  provider: "openai",
  jti: "scope-token-identity-2",
};
const rotatedScope = { ...scope, jti: "scope-token-identity-3" };
const bridgeScope = {
  aud: "bridge_mcp",
  callId: "call-1",
  agentId: "agent-1",
  orgId: "org-1",
  provider: "openai",
  jti: "bridge-scope-identity-1",
  providerCallId: `CA${"1".repeat(32)}`,
  providerAccountId: `AC${"2".repeat(32)}`,
  providerTo: "+14155550100",
  providerStreamId: `MZ${"3".repeat(32)}`,
  transportProvider: "twilio",
};
const otherBridgeScope = {
  ...bridgeScope,
  jti: "bridge-scope-identity-2",
  providerStreamId: `MZ${"4".repeat(32)}`,
};
const CATALOG_DIGEST = "a".repeat(64);
const LEASE_SCOPE_DIGEST = "b".repeat(64);
const ACTIVE_CATALOG = Object.freeze({
  schema_version: 1,
  availability: "active",
  runtime_digest: "c".repeat(64),
  capability_epoch: 7,
  state_revision: 11,
  scope: {
    status: "active",
    topic: "returns",
    step: "reserve",
    attempt: 0,
  },
  active_context: {},
  catalog_digest: CATALOG_DIGEST,
  tools: [{
    logical_name: "reserve_slot",
    description: "Reserve the selected slot.",
    input_schema: {
      type: "object",
      properties: { slot: { type: "string" } },
      required: ["slot"],
      additionalProperties: false,
    },
    effect: "write",
    invocation: {
      mode: "host_bound_action",
      tool_name: "reserve_slot",
      arguments_from: "$MODEL_ARGUMENTS",
      lease_scope_digest: LEASE_SCOPE_DIGEST,
      policy: { idempotency: "per_arguments" },
    },
    allowed_outcomes: ["completed", "rejected", "indeterminate"],
  }],
});
const ACTIVE_AUTHORITY = Object.freeze({
  catalog: ACTIVE_CATALOG,
  privateBindings: Object.freeze({}),
});
const EXPECTED_CATALOG = Object.freeze({
  catalog_digest: CATALOG_DIGEST,
  capability_epoch: 7,
});

function gatewayEnvelope(outcome: unknown, catalog = ACTIVE_CATALOG) {
  return {
    schema_version: 1,
    outcome,
    active_capability_catalog: catalog,
  };
}

function request(body: unknown, options: {
  authorization?: string;
  sessionId?: string;
  url?: string;
  contentType?: string;
} = {}) {
  return new Request(options.url ?? "https://voice.example/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": options.contentType ?? "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
      ...(options.sessionId ? { "MCP-Session-Id": options.sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string, authorization = "Bearer valid-token") {
  return new Request("https://voice.example/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body,
  });
}

async function initialize(token = "valid-token"): Promise<string> {
  const response = await POST(request({
    jsonrpc: "2.0",
    id: `initialize-${token}`,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  }, { authorization: `Bearer ${token}` }));
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toMatch(/^hacc\.v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  return sessionId!;
}

function toolCall(
  persistentProviderToolCallId: string,
  options: { id?: string | number; argumentIdentity?: string } = {}
) {
  return {
    jsonrpc: "2.0",
    id: options.id ?? "transport-request-1",
    method: "tools/call",
    params: {
      name: "reserve_slot",
      arguments: {
        slot: "10:00",
        _meta: {
          "hacc/provider_tool_call_id": options.argumentIdentity ?? "model-controlled-id",
        },
      },
      _meta: {
        "hacc/provider_tool_call_id": persistentProviderToolCallId,
        "com.harsha.callcenter/active-catalog": EXPECTED_CATALOG,
      },
    },
  };
}

describe("MCP gateway request boundary", () => {
  beforeEach(() => {
    process.env.MCP_GATEWAY_SECRET = "test-mcp-gateway-secret-that-is-at-least-32-bytes";
    vi.clearAllMocks();
    mocks.verifyScope.mockImplementation((token, expected) => {
      const isDirectExpectation =
        expected.audience === "mcp" &&
        expected.purpose === "tool-invocation" &&
        expected.method === "POST" &&
        JSON.stringify(expected.provider) === JSON.stringify(["xai", "openai", "gemini"]);
      if (isDirectExpectation) return token === "valid-token"
        ? scope
        : token === "other-token"
          ? otherScope
          : token === "rotated-token"
            ? rotatedScope
            : null;
      const isBridgeExpectation =
        expected.audience === "bridge_mcp" &&
        expected.purpose === "tool_invocation" &&
        expected.method === "POST" &&
        expected.transportProvider === "twilio" &&
        JSON.stringify(expected.provider) === JSON.stringify(["xai", "openai", "gemini"]);
      if (isBridgeExpectation) {
        return token === "bridge-token"
          ? bridgeScope
          : token === "other-bridge-token"
            ? otherBridgeScope
            : null;
      }
      return null;
    });
    mocks.activeCapabilityAuthorityFor.mockResolvedValue(ACTIVE_AUTHORITY);
    mocks.callActiveCapability.mockResolvedValue({ ok: true });
    mocks.qOne.mockImplementation((sql: string, params) => {
      if (sql.includes("telephony_stream_bindings")) {
        const claims = params[6] === bridgeScope.providerStreamId
          ? bridgeScope
          : params[6] === otherBridgeScope.providerStreamId
            ? otherBridgeScope
            : null;
        return Promise.resolve(claims &&
          params[0] === claims.callId && params[1] === claims.agentId && params[2] === claims.orgId &&
          params[3] === claims.providerCallId && params[4] === claims.providerAccountId &&
          params[5] === claims.providerTo
          ? { settings: { provider: claims.provider }, voice: "test-voice" }
          : null);
      }
      return Promise.resolve({
        settings: { provider: params[0] === "call-2" ? "openai" : "gemini" },
        voice: "test-voice",
      });
    });
    mocks.resolveVoiceProviderConfig.mockImplementation((settings) => ({
      provider: settings.provider,
    }));
  });

  afterAll(() => {
    if (originalGatewaySecret === undefined) delete process.env.MCP_GATEWAY_SECRET;
    else process.env.MCP_GATEWAY_SECRET = originalGatewaySecret;
  });

  it.each([
    [
      "top-level escaped duplicate",
      String.raw`{"jsonrpc":"2.0","id":1,"method":"ping","meth\u006fd":"tools/call"}`,
    ],
    [
      "nested escaped duplicate",
      String.raw`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"reserve_slot","arguments":{"slot":"10:00","sl\u006ft":"11:00"}}}`,
    ],
  ])("rejects %s JSON keys before database or capability access", async (_label, body) => {
    const response = await POST(rawRequest(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.activeCapabilityAuthorityFor).not.toHaveBeenCalled();
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("accepts scope only from an exact Bearer header and server-issues a bound session", async () => {
    const response = await POST(request(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { url: "https://voice.example/api/mcp?scope=valid-token" }
    ));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.verifyScope).not.toHaveBeenCalled();

    const sessionId = await initialize();
    const ping = await POST(request(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { authorization: "Bearer valid-token", sessionId }
    ));
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(mocks.verifyScope).toHaveBeenLastCalledWith("valid-token", {
      audience: "mcp",
      purpose: "tool-invocation",
      method: "POST",
      provider: ["xai", "openai", "gemini"],
    });
  });

  it("keeps the standard MCP tool list empty because logical authority is host-bound", async () => {
    const sessionId = await initialize();
    const response = await POST(request({
      jsonrpc: "2.0",
      id: "list-tools",
      method: "tools/list",
    }, { authorization: "Bearer valid-token", sessionId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "list-tools",
      result: { tools: [] },
    });
    expect(mocks.activeCapabilityAuthorityFor).not.toHaveBeenCalled();
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("rejects oversized durable tool arguments before capability admission", async () => {
    const sessionId = await initialize();
    const oversized = toolCall("provider-native-oversized-arguments");
    (oversized.params.arguments as Record<string, unknown>).payload = "x".repeat(33 * 1024);
    const response = await POST(request(oversized, {
      authorization: "Bearer valid-token",
      sessionId,
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "transport-request-1",
      error: { code: -32602, message: "tool arguments exceed the durable replay limit" },
    });
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("rejects catalog epochs outside PostgreSQL int32 before capability admission", async () => {
    const sessionId = await initialize();
    const overflow = toolCall("provider-native-overflow-epoch");
    const metadata = overflow.params._meta as Record<string, unknown>;
    metadata["com.harsha.callcenter/active-catalog"] = {
      catalog_digest: CATALOG_DIGEST,
      capability_epoch: Number.MAX_SAFE_INTEGER,
    };
    const response = await POST(request(overflow, {
      authorization: "Bearer valid-token",
      sessionId,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: -32602 },
    });
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("accepts bridge MCP authority only after exact active Twilio stream binding", async () => {
    const sessionId = await initialize("bridge-token");

    expect(mocks.verifyScope).toHaveBeenNthCalledWith(1, "bridge-token", {
      audience: "mcp",
      purpose: "tool-invocation",
      method: "POST",
      provider: ["xai", "openai", "gemini"],
    });
    expect(mocks.verifyScope).toHaveBeenNthCalledWith(2, "bridge-token", {
      audience: "bridge_mcp",
      purpose: "tool_invocation",
      method: "POST",
      provider: ["xai", "openai", "gemini"],
      transportProvider: "twilio",
    });
    expect(mocks.qOne).toHaveBeenLastCalledWith(
      expect.stringMatching(/telephony_stream_bindings[\s\S]*c\.status = 'active'[\s\S]*b\.mode = 'agent'[\s\S]*b\.stopped_at IS NULL/),
      [
        bridgeScope.callId,
        bridgeScope.agentId,
        bridgeScope.orgId,
        bridgeScope.providerCallId,
        bridgeScope.providerAccountId,
        bridgeScope.providerTo,
        bridgeScope.providerStreamId,
      ]
    );

    const response = await POST(request(toolCall("bridge-provider-native-call-1"), {
      authorization: "Bearer bridge-token",
      sessionId,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: "transport-request-1",
      result: {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ ok: true })) }],
        isError: false,
      },
    });
    expect(mocks.callActiveCapability).toHaveBeenCalledWith(
      bridgeScope,
      "reserve_slot",
      { slot: "10:00", _meta: { "hacc/provider_tool_call_id": "model-controlled-id" } },
      {
        invocationId: expect.stringMatching(/^mcp-provider:v1:[a-f0-9]{64}$/),
        expectedCatalog: EXPECTED_CATALOG,
      }
    );
  });

  it("runs the standalone bridge AuthorityClient through initialize, session, and durable replay", async () => {
    const observed: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      observed.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      });
      return POST(new Request(input, init));
    };
    const call = {
      provider: "openai",
      responseId: "response_1",
      itemId: "item_1",
      callId: "provider-native-call-1",
      name: "capability_gateway",
      arguments: {
        tool_name: "reserve_slot",
        arguments: { slot: "10:00" },
      },
      activeCatalogAuthority: {
        catalogDigest: CATALOG_DIGEST,
        capabilityEpoch: 7,
      },
    };
    const createAuthority = () => new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: "bridge-token",
      fetchImpl,
      maximumAttempts: 1,
    });

    await expect(createAuthority().callCapabilityGateway(call)).resolves.toEqual({
      output: gatewayEnvelope({ ok: true }),
      isError: false,
      activeCatalogAuthority: {
        catalogDigest: CATALOG_DIGEST,
        capabilityEpoch: 7,
        availability: "active",
      },
    });
    // A fresh bridge process gets a new MCP session but must replay the same provider-native
    // identity into the same durable action receipt.
    await expect(createAuthority().callCapabilityGateway(call)).resolves.toEqual({
      output: gatewayEnvelope({ ok: true }),
      isError: false,
      activeCatalogAuthority: {
        catalogDigest: CATALOG_DIGEST,
        capabilityEpoch: 7,
        availability: "active",
      },
    });

    const methods = observed.map(({ body }) => body.method);
    expect(methods).toEqual([
      "initialize", "notifications/initialized", "tools/call",
      "initialize", "notifications/initialized", "tools/call",
    ]);
    const toolRequests = observed.filter(({ body }) => body.method === "tools/call");
    expect(toolRequests).toHaveLength(2);
    for (const request of toolRequests) {
      expect(request.headers.get("authorization")).toBe("Bearer bridge-token");
      expect(request.headers.get("mcp-session-id")).toMatch(/^hacc\.v1\./);
      expect(request.body).toMatchObject({
        method: "tools/call",
        params: {
          name: "reserve_slot",
          arguments: { slot: "10:00" },
          _meta: {
            "hacc/provider_tool_call_id": "provider-native-call-1",
            "com.harsha.callcenter/active-catalog": EXPECTED_CATALOG,
          },
        },
      });
    }
    const invocationIds = mocks.callActiveCapability.mock.calls.map((entry) => entry[3].invocationId);
    expect(invocationIds).toHaveLength(2);
    expect(invocationIds[0]).toBe(invocationIds[1]);
  });

  it("rejects cross-audience MCP session substitution before dispatch", async () => {
    const directSession = await initialize("valid-token");
    const bridgeSession = await initialize("bridge-token");

    const bridgeWithDirectSession = await POST(request(toolCall("bridge-cross-audience"), {
      authorization: "Bearer bridge-token",
      sessionId: directSession,
    }));
    const directWithBridgeSession = await POST(request(toolCall("direct-cross-audience"), {
      authorization: "Bearer valid-token",
      sessionId: bridgeSession,
    }));

    expect(bridgeWithDirectSession.status).toBe(404);
    expect(directWithBridgeSession.status).toBe(404);
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("rejects bridge session substitution across stream bindings", async () => {
    const firstStreamSession = await initialize("bridge-token");
    const secondStreamSession = await initialize("other-bridge-token");

    const firstWithSecondStream = await POST(request(toolCall("first-cross-stream"), {
      authorization: "Bearer bridge-token",
      sessionId: secondStreamSession,
    }));
    const secondWithFirstStream = await POST(request(toolCall("second-cross-stream"), {
      authorization: "Bearer other-bridge-token",
      sessionId: firstStreamSession,
    }));

    expect(firstWithSecondStream.status).toBe(404);
    expect(secondWithFirstStream.status).toBe(404);
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("rejects missing, stopped, observing, or provider-mismatched bridge bindings", async () => {
    mocks.qOne.mockResolvedValueOnce(null);
    const inactiveBinding = await POST(request({
      jsonrpc: "2.0",
      id: "init-inactive-bridge",
      method: "initialize",
    }, { authorization: "Bearer bridge-token" }));
    expect(inactiveBinding.status).toBe(401);

    mocks.qOne.mockResolvedValueOnce({ settings: { provider: "gemini" }, voice: "test-voice" });
    const wrongProvider = await POST(request({
      jsonrpc: "2.0",
      id: "init-wrong-bridge-provider",
      method: "initialize",
    }, { authorization: "Bearer bridge-token" }));
    expect(wrongProvider.status).toBe(401);
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("rejects missing, forged, and cross-authority sessions before dispatch", async () => {
    const sessionId = await initialize();
    const candidates = [
      request(toolCall("provider-call-1"), { authorization: "Bearer valid-token" }),
      request(toolCall("provider-call-1"), {
        authorization: "Bearer valid-token",
        sessionId: `${sessionId.slice(0, -1)}${sessionId.endsWith("A") ? "B" : "A"}`,
      }),
      request(toolCall("provider-call-1"), {
        authorization: "Bearer rotated-token",
        sessionId,
      }),
    ];
    for (const candidate of candidates) {
      const response = await POST(candidate);
      expect(response.status).toBe(404);
    }
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("rejects terminal/missing calls and signed provider claims that do not match the pinned call", async () => {
    mocks.qOne.mockResolvedValueOnce(null);
    const missingCall = await POST(request({
      jsonrpc: "2.0",
      id: "init-missing-call",
      method: "initialize",
    }, { authorization: "Bearer valid-token" }));
    expect(missingCall.status).toBe(401);

    mocks.qOne.mockResolvedValueOnce({ settings: { provider: "openai" }, voice: "test-voice" });
    const wrongProvider = await POST(request({
      jsonrpc: "2.0",
      id: "init-wrong-provider",
      method: "initialize",
    }, { authorization: "Bearer valid-token" }));
    expect(wrongProvider.status).toBe(401);
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("uses the exact trusted provider ID and ignores JSON-RPC and arguments identities", async () => {
    const sessionId = await initialize();
    const response = await POST(request(toolCall("provider-call-α-001", {
      id: 7,
      argumentIdentity: "attacker-controlled",
    }), { authorization: "Bearer valid-token", sessionId }));

    expect(response.status).toBe(200);
    expect(mocks.callActiveCapability).toHaveBeenCalledWith(
      scope,
      "reserve_slot",
      {
        slot: "10:00",
        _meta: { "hacc/provider_tool_call_id": "attacker-controlled" },
      },
      {
        invocationId: expect.stringMatching(/^mcp-provider:v1:[a-f0-9]{64}$/),
        expectedCatalog: EXPECTED_CATALOG,
      }
    );
    const invocationId = mocks.callActiveCapability.mock.calls[0][3].invocationId as string;
    expect(invocationId).not.toContain("provider-call");
    expect(invocationId).not.toContain("attacker");
  });

  it("marks gateway errors from the bounded final envelope", async () => {
    mocks.callActiveCapability.mockResolvedValueOnce(() => undefined);
    const sessionId = await initialize();
    const response = await POST(request(toolCall("invalid-outcome-call"), {
      authorization: "Bearer valid-token",
      sessionId,
    }));
    const body = await response.json();
    const envelope = JSON.parse(body.result.content[0].text);
    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(envelope).toMatchObject({
      schema_version: 1,
      outcome: {
        code: "invalid_tool_result",
        do_not_retry_same_provider_call: true,
      },
      active_capability_catalog: ACTIVE_CATALOG,
    });
  });

  it("returns a zero-authority blocked catalog when only post-result refresh fails", async () => {
    mocks.activeCapabilityAuthorityFor.mockRejectedValueOnce(new Error("catalog unavailable"));
    const sessionId = await initialize();
    const response = await POST(request(toolCall("post-refresh-failure"), {
      authorization: "Bearer valid-token",
      sessionId,
    }));
    const body = await response.json();
    const envelope = JSON.parse(body.result.content[0].text);
    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(false);
    expect(envelope.outcome).toEqual({ ok: true });
    expect(envelope.active_capability_catalog).toMatchObject({
      availability: "blocked",
      capability_epoch: EXPECTED_CATALOG.capability_epoch,
      scope: { status: "failed", step: "$catalog.refresh_failed" },
      active_context: {
        blocked: true,
        reason: "catalog_refresh_failed",
        prior_catalog_digest: EXPECTED_CATALOG.catalog_digest,
      },
      tools: [],
    });
    expect(mocks.callActiveCapability.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.activeCapabilityAuthorityFor.mock.invocationCallOrder[0]);
    expect(mocks.activeCapabilityAuthorityFor).toHaveBeenCalledTimes(1);
  });

  it("keeps durable identity stable across reconnect sessions and JSON-RPC id resets", async () => {
    const firstSession = await initialize();
    const secondSession = await initialize();
    expect(secondSession).not.toBe(firstSession);

    await POST(request(toolCall("persistent-provider-call", { id: 99 }), {
      authorization: "Bearer valid-token",
      sessionId: firstSession,
    }));
    await POST(request(toolCall("persistent-provider-call", { id: 1 }), {
      authorization: "Bearer valid-token",
      sessionId: secondSession,
    }));

    const invocationIds = mocks.callActiveCapability.mock.calls.map((call) => call[3].invocationId);
    expect(invocationIds).toHaveLength(2);
    expect(invocationIds[0]).toBe(invocationIds[1]);
  });

  it("keeps durable identity stable across bearer rotation while reauthorizing the session", async () => {
    const firstSession = await initialize("valid-token");
    const rotatedSession = await initialize("rotated-token");
    await POST(request(toolCall("persistent-provider-call"), {
      authorization: "Bearer valid-token",
      sessionId: firstSession,
    }));
    await POST(request(toolCall("persistent-provider-call"), {
      authorization: "Bearer rotated-token",
      sessionId: rotatedSession,
    }));

    const invocationIds = mocks.callActiveCapability.mock.calls.map((call) => call[3].invocationId);
    expect(invocationIds).toHaveLength(2);
    expect(invocationIds[0]).toBe(invocationIds[1]);
  });

  it("separates provider IDs even when their JSON-RPC ids and session are identical", async () => {
    const sessionId = await initialize();
    for (const providerId of ["provider-call-one", "provider-call-two"]) {
      await POST(request(toolCall(providerId, { id: 7 }), {
        authorization: "Bearer valid-token",
        sessionId,
      }));
    }
    const invocationIds = mocks.callActiveCapability.mock.calls.map((call) => call[3].invocationId);
    expect(invocationIds[0]).not.toBe(invocationIds[1]);
  });

  it("binds durable provider identity to the authenticated org/call/provider authority", async () => {
    const firstSession = await initialize("valid-token");
    const secondSession = await initialize("other-token");
    await POST(request(toolCall("same-provider-call"), {
      authorization: "Bearer valid-token",
      sessionId: firstSession,
    }));
    await POST(request(toolCall("same-provider-call"), {
      authorization: "Bearer other-token",
      sessionId: secondSession,
    }));
    const invocationIds = mocks.callActiveCapability.mock.calls.map((call) => call[3].invocationId);
    expect(invocationIds[0]).not.toBe(invocationIds[1]);
  });

  it("requires a bounded persistent ID in top-level params._meta before active gateway dispatch", async () => {
    const sessionId = await initialize();
    const base = toolCall("provider-call-1") as Record<string, unknown>;
    const params = base.params as Record<string, unknown>;
    const candidates = [
      { ...base, params: { ...params, _meta: undefined } },
      {
        ...base,
        params: {
          ...params,
          _meta: { "com.harsha.callcenter/active-catalog": EXPECTED_CATALOG },
        },
      },
      {
        ...base,
        params: {
          ...params,
          _meta: {
            "hacc/provider_tool_call_id": "bad\nid",
            "com.harsha.callcenter/active-catalog": EXPECTED_CATALOG,
          },
        },
      },
      {
        ...base,
        params: {
          ...params,
          _meta: {
            "hacc/provider_tool_call_id": "α".repeat(129),
            "com.harsha.callcenter/active-catalog": EXPECTED_CATALOG,
          },
        },
      },
    ];
    for (const candidate of candidates) {
      const response = await POST(request(candidate, {
        authorization: "Bearer valid-token",
        sessionId,
      }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(-32602);
    }
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("requires exact host-owned active catalog authority before receipt admission", async () => {
    const sessionId = await initialize();
    const base = toolCall("provider-call-1") as Record<string, unknown>;
    const params = base.params as Record<string, unknown>;
    const metadata = params._meta as Record<string, unknown>;
    const withCatalog = (catalog: unknown) => ({
      ...base,
      params: {
        ...params,
        _meta: {
          "hacc/provider_tool_call_id": metadata["hacc/provider_tool_call_id"],
          ...(catalog === undefined
            ? {}
            : { "com.harsha.callcenter/active-catalog": catalog }),
        },
      },
    });
    const candidates = [
      withCatalog(undefined),
      withCatalog({ catalog_digest: CATALOG_DIGEST }),
      withCatalog({ catalog_digest: CATALOG_DIGEST.toUpperCase(), capability_epoch: 7 }),
      withCatalog({ catalog_digest: CATALOG_DIGEST, capability_epoch: -1 }),
      withCatalog({ catalog_digest: CATALOG_DIGEST, capability_epoch: 7, extra: true }),
    ];
    for (const candidate of candidates) {
      const response = await POST(request(candidate, {
        authorization: "Bearer valid-token",
        sessionId,
      }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatchObject({
        code: -32602,
        message: expect.stringContaining("com.harsha.callcenter/active-catalog"),
      });
    }
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
    expect(mocks.activeCapabilityAuthorityFor).not.toHaveBeenCalled();
  });

  it("rejects missing arguments, unsafe ids, batches, and non-JSON content before dispatch", async () => {
    const sessionId = await initialize();
    const cases = [
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_action", _meta: { "hacc/provider_tool_call_id": "call-1" } },
      }, { authorization: "Bearer valid-token", sessionId }),
      request({
        jsonrpc: "2.0",
        id: "bad\nid",
        method: "tools/call",
        params: { name: "run_action", arguments: {} },
      }, { authorization: "Bearer valid-token", sessionId }),
      request([{ jsonrpc: "2.0", id: 1, method: "ping" }], {
        authorization: "Bearer valid-token",
        sessionId,
      }),
      request({ jsonrpc: "2.0", id: 1, method: "ping" }, {
        authorization: "Bearer valid-token",
        sessionId,
        contentType: "text/plain",
      }),
    ];
    for (const candidate of cases) {
      const response = await POST(candidate);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });

  it("caps request bodies before parsing", async () => {
    const response = await POST(new Request("https://voice.example/api/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        "Content-Type": "application/json",
        "Content-Length": String(256 * 1024 + 1),
      },
      body: "{}",
    }));
    expect(response.status).toBe(413);
    expect(mocks.callActiveCapability).not.toHaveBeenCalled();
  });
});
