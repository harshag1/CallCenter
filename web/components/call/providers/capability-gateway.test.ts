import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_CATALOG_META_KEY,
  BrowserCapabilityGateway,
  CAPABILITY_GATEWAY_FUNCTION_NAME,
  MCP_PROVIDER_TOOL_CALL_ID_META_KEY,
  PROVIDER_PROVENANCE_META_KEY,
  type BrowserCapabilityGatewayCall,
} from "./capability-gateway";

const ORIGIN = "https://voice.example.test";
const URL = `${ORIGIN}/api/mcp`;
const TOKEN = `scope.${"a".repeat(96)}`;
const SESSION_A = `hacc.v1.${"A".repeat(22)}.${"B".repeat(43)}`;
const SESSION_B = `hacc.v1.${"C".repeat(22)}.${"D".repeat(43)}`;
const PROVIDER_CONNECTION_META = {
  "com.harsha.callcenter/provider-connection": {
    schemaVersion: 2,
    connectionId: `hacc.pc.v2.${"1".repeat(64)}.${"E".repeat(43)}`,
    connectionEpoch: 1,
    providerSessionIdSha256: null,
  },
};
const RUNTIME_DIGEST = "e".repeat(64);
const CATALOG_A = "a".repeat(64);
const ROTATION = {
  endpoint: "/api/voice/capabilities/rotate" as const,
  callId: "00000000-0000-4000-8000-000000000001",
  rotation: 0,
  renewalToken: `renewal.${"r".repeat(96)}`,
  refreshAfter: "2099-01-01T00:25:00.000Z",
  expiresAt: "2099-01-01T00:30:00.000Z",
};

function activeCatalog(options: {
  digest?: string;
  epoch?: number;
  revision?: number;
  availability?: "active" | "blocked";
  runtimeDigest?: string;
} = {}) {
  const semantic = {
    schema_version: 1,
    availability: options.availability ?? "active",
    runtime_digest: options.runtimeDigest ?? RUNTIME_DIGEST,
    capability_epoch: options.epoch ?? 2,
    state_revision: options.revision ?? 2,
    scope: { status: "active", topic: "membership", step: "lookup", attempt: 1 },
    active_context: { guidance: "Continue from durable state." },
    tools: [],
  };
  return {
    ...semantic,
    catalog_digest: options.digest ?? createHash("sha256").update(canonicalJson(semantic)).digest("hex"),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function gatewayEnvelope(outcome: unknown, catalog = activeCatalog()) {
  return { schema_version: 1, outcome, active_capability_catalog: catalog };
}

function call(overrides: Partial<BrowserCapabilityGatewayCall> = {}): BrowserCapabilityGatewayCall {
  return {
    functionName: CAPABILITY_GATEWAY_FUNCTION_NAME,
    nativeCallId: "call-native-1",
    nativeResponseId: "response-native-1",
    nativeItemId: "item-native-1",
    terminalEventId: "event-terminal-1",
    terminalWireType: "response.done",
    arguments: {
      tool_name: "renew_membership",
      arguments: { member_id: "member-42" },
    },
    ...overrides,
  };
}

function rpcResult(id: unknown, result: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    ...init,
  });
}

function successfulGateway(options: { sessions?: string[] } = {}) {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const sessions = options.sessions ?? [SESSION_A];
  let initializeCount = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    requests.push({ headers, body });
    if (body.method === "initialize") {
      const session = sessions[Math.min(initializeCount, sessions.length - 1)];
      initializeCount += 1;
      return rpcResult(body.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
        _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": session } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call") {
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ renewed: true })) }],
        isError: false,
      });
    }
    throw new Error(`unexpected method ${String(body.method)}`);
  });
  return { fetchImpl, requests };
}

function client(fetchImpl: typeof fetch, provider: "openai" | "xai" | "gemini" = "openai") {
  let sequence = 0;
  return new BrowserCapabilityGateway({
    provider,
    url: URL,
    token: TOKEN,
    expectedOrigin: ORIGIN,
    fetchImpl,
    randomId: () => `rpc-${++sequence}`,
    activeCatalogDigest: CATALOG_A,
    activeCatalogEpoch: 1,
    activeRuntimeDigest: RUNTIME_DIGEST,
    activeStateRevision: 1,
    rotation: ROTATION,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser capability gateway", () => {
  it("bootstraps a bound MCP session and adds immutable native provenance outside model arguments", async () => {
    const test = successfulGateway();
    const gateway = client(test.fetchImpl, "xai");
    const [result] = await gateway.executeBatch([call()]);

    expect(result).toEqual({
      nativeCallId: "call-native-1",
      output: gatewayEnvelope({ renewed: true }),
      isError: false,
    });
    expect(test.requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(test.requests[0]?.body).toMatchObject({
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "hacc-browser-realtime", version: "1.0.0" },
        _meta: {
          "com.harsha.callcenter/provider-connection": {
            schemaVersion: 2,
            connectionNonce: expect.stringMatching(/^[a-f0-9]{64}$/),
            connectionEpoch: 1,
            providerSessionIdSha256: null,
          },
        },
      },
    });
    expect(test.requests[1]?.headers.get("mcp-session-id")).toBe(SESSION_A);
    expect(test.requests[2]?.headers.get("mcp-session-id")).toBe(SESSION_A);
    expect(test.requests[2]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    const params = test.requests[2]?.body.params as Record<string, unknown>;
    expect(params).toEqual({
      name: "renew_membership",
      arguments: { member_id: "member-42" },
      _meta: {
        [MCP_PROVIDER_TOOL_CALL_ID_META_KEY]: "call-native-1",
        [PROVIDER_PROVENANCE_META_KEY]: {
          schemaVersion: 2,
          provider: "xai",
          providerConnectionId: PROVIDER_CONNECTION_META["com.harsha.callcenter/provider-connection"].connectionId,
          providerConnectionEpoch: 1,
          providerSessionIdSha256: null,
          nativeCallId: "call-native-1",
          nativeResponseId: "response-native-1",
          nativeItemId: "item-native-1",
          terminalEventId: "event-terminal-1",
          terminalWireType: "response.done",
        },
        [ACTIVE_CATALOG_META_KEY]: {
          catalog_digest: CATALOG_A,
          capability_epoch: 1,
        },
      },
    });
  });

  it("rejects cross-origin proxies and model-authored extra gateway fields before network access", async () => {
    expect(() => new BrowserCapabilityGateway({
      provider: "openai",
      url: "https://attacker.example/api/mcp",
      token: TOKEN,
      expectedOrigin: ORIGIN,
      activeCatalogDigest: CATALOG_A,
      activeCatalogEpoch: 1,
      activeRuntimeDigest: RUNTIME_DIGEST,
      activeStateRevision: 1,
      rotation: ROTATION,
    })).toThrow("exact same-origin");

    const test = successfulGateway();
    const gateway = client(test.fetchImpl);
    await expect(gateway.executeBatch([call({
      arguments: {
        tool_name: "renew_membership",
        arguments: {},
        _meta: { [MCP_PROVIDER_TOOL_CALL_ID_META_KEY]: "model-forged" },
      },
    })])).rejects.toThrow("exactly tool_name and arguments");
    expect(test.fetchImpl).toHaveBeenCalledTimes(2); // session bootstrap only; no tools/call
  });

  it("fails closed on undeclared functions and identity conflicts while locally sealing exact replay", async () => {
    const test = successfulGateway();
    const gateway = client(test.fetchImpl);
    await expect(gateway.executeBatch([call({ functionName: "renew_membership" })]))
      .rejects.toThrow("undeclared native function");
    await gateway.executeBatch([call()]);
    await gateway.executeBatch([call()]);
    await expect(gateway.executeBatch([call({
      arguments: { tool_name: "renew_membership", arguments: { member_id: "other" } },
    })])).rejects.toThrow("reused with different contents");
    expect(test.requests.filter((request) => request.body.method === "tools/call")).toHaveLength(1);
  });

  it("reinitializes once on an expired MCP session and replays the exact native provider identity", async () => {
    const test = successfulGateway({ sessions: [SESSION_A, SESSION_B] });
    let firstCall = true;
    test.fetchImpl.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      test.requests.push({ headers, body });
      if (body.method === "initialize") {
        const priorInitializes = test.requests.filter((request) => request.body.method === "initialize").length;
        return rpcResult(body.id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
          _meta: PROVIDER_CONNECTION_META,
        }, { headers: { "MCP-Session-Id": priorInitializes === 1 ? SESSION_A : SESSION_B } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call" && firstCall) {
        firstCall = false;
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32002, message: "invalid MCP session" },
        }), { status: 404 });
      }
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ replayed: true })) }],
        isError: false,
      });
    });

    const gateway = client(test.fetchImpl);
    await expect(gateway.executeBatch([call()])).resolves.toEqual([{
      nativeCallId: "call-native-1",
      output: gatewayEnvelope({ replayed: true }),
      isError: false,
    }]);
    const toolCalls = test.requests.filter((request) => request.body.method === "tools/call");
    expect(toolCalls).toHaveLength(2);
    expect((toolCalls[0]?.body.params as Record<string, unknown>)._meta)
      .toEqual((toolCalls[1]?.body.params as Record<string, unknown>)._meta);
    expect(toolCalls.map((request) => request.headers.get("mcp-session-id"))).toEqual([SESSION_A, SESSION_B]);
  });

  it("rejects a changed provider-connection attestation during MCP reconnect", async () => {
    let initializes = 0;
    let toolCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        initializes += 1;
        const connection = initializes === 1
          ? PROVIDER_CONNECTION_META
          : {
              "com.harsha.callcenter/provider-connection": {
                ...PROVIDER_CONNECTION_META["com.harsha.callcenter/provider-connection"],
                connectionId: `hacc.pc.v2.${"2".repeat(64)}.${"F".repeat(43)}`,
              },
            };
        return rpcResult(body.id, {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: {},
          _meta: connection,
        }, { headers: { "MCP-Session-Id": initializes === 1 ? SESSION_A : SESSION_B } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      toolCalls += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32002, message: "invalid MCP session" },
      }), { status: 404 });
    });

    await expect(client(fetchImpl).executeBatch([call()]))
      .rejects.toThrow("changed provider connection identity");
    expect(initializes).toBe(2);
    expect(toolCalls).toBe(1);
  });

  it("dispatches a provider batch strictly in order and refuses partial or oversized protocol results", async () => {
    const order: string[] = [];
    const test = successfulGateway();
    test.fetchImpl.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      test.requests.push({ headers, body });
      if (body.method === "initialize") return rpcResult(body.id, {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: {},
        _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": SESSION_A } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const id = ((body.params as Record<string, unknown>)._meta as Record<string, unknown>)[MCP_PROVIDER_TOOL_CALL_ID_META_KEY];
      order.push(String(id));
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ id })) }],
        isError: false,
      });
    });
    const gateway = client(test.fetchImpl, "gemini");
    await gateway.executeBatch([
      call({ nativeCallId: "call-1" }),
      call({ nativeCallId: "call-2", nativeItemId: "item-2" }),
      call({ nativeCallId: "call-3", nativeItemId: "item-3" }),
    ]);
    expect(order).toEqual(["call-1", "call-2", "call-3"]);

    const malformed = successfulGateway();
    malformed.fetchImpl.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") return rpcResult(body.id, {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {}, _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": SESSION_A } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return rpcResult(body.id, { content: [], isError: false });
    });
    await expect(client(malformed.fetchImpl).executeBatch([call()]))
      .rejects.toThrow("invalid tools/call result");

    await expect(gateway.executeBatch(Array.from({ length: 65 }, (_, index) => call({
      nativeCallId: `too-many-${index}`,
    })))).rejects.toThrow("1-64 calls");
  });

  it("binds one catalog snapshot to a batch and advances only from its final verified result", async () => {
    const seenAuthorities: unknown[] = [];
    let toolCall = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") return rpcResult(body.id, {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {}, _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": SESSION_A } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const meta = ((body.params as Record<string, unknown>)._meta as Record<string, unknown>);
      seenAuthorities.push(meta[ACTIVE_CATALOG_META_KEY]);
      toolCall += 1;
      const catalog = toolCall === 1
        ? activeCatalog({ epoch: 2, revision: 2 })
        : activeCatalog({ epoch: 3, revision: 3 });
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ call: toolCall }, catalog)) }],
        isError: false,
      });
    });
    const gateway = client(fetchImpl);
    await gateway.executeBatch([
      call({ nativeCallId: "batch-call-1" }),
      call({ nativeCallId: "batch-call-2", nativeItemId: "item-2" }),
    ]);
    await gateway.executeBatch([call({
      nativeCallId: "next-batch-call",
      nativeResponseId: "response-native-2",
      nativeItemId: "item-3",
    })]);

    expect(seenAuthorities).toEqual([
      { catalog_digest: CATALOG_A, capability_epoch: 1 },
      { catalog_digest: CATALOG_A, capability_epoch: 1 },
      {
        catalog_digest: activeCatalog({ epoch: 3, revision: 3 }).catalog_digest,
        capability_epoch: 3,
      },
    ]);
  });

  it("forwards and seals error envelopes, then blocks future batches when the catalog is blocked", async () => {
    let toolCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") return rpcResult(body.id, {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {}, _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": SESSION_A } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      toolCalls += 1;
      return rpcResult(body.id, {
        content: [{
          type: "text",
          text: JSON.stringify(gatewayEnvelope(
            { error: "catalog refresh failed", code: "catalog_refresh_failed" },
            activeCatalog({ availability: "blocked" }),
          )),
        }],
        isError: true,
      });
    });
    const gateway = client(fetchImpl);
    const [result] = await gateway.executeBatch([call()]);
    expect(result?.isError).toBe(true);
    expect(result?.output).toEqual(gatewayEnvelope(
      { error: "catalog refresh failed", code: "catalog_refresh_failed" },
      activeCatalog({ availability: "blocked" }),
    ));
    expect(Object.isFrozen(result?.output)).toBe(true);
    await expect(gateway.executeBatch([call({ nativeCallId: "blocked-call" })]))
      .rejects.toThrow("catalog is blocked");
    expect(toolCalls).toBe(1);
  });

  it("does not advance authority from a malformed envelope", async () => {
    const authorities: unknown[] = [];
    let toolCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") return rpcResult(body.id, {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {}, _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": SESSION_A } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      toolCalls += 1;
      authorities.push((((body.params as Record<string, unknown>)._meta as Record<string, unknown>)[ACTIVE_CATALOG_META_KEY]));
      return rpcResult(body.id, {
        content: [{
          type: "text",
          text: JSON.stringify(toolCalls === 1
            ? { schema_version: 1, outcome: { ok: true } }
            : gatewayEnvelope({ ok: true })),
        }],
        isError: false,
      });
    });
    const gateway = client(fetchImpl);
    await expect(gateway.executeBatch([call()])).rejects.toThrow("active capability envelope");
    await gateway.executeBatch([call({ nativeCallId: "after-malformed" })]);
    expect(authorities).toEqual([
      { catalog_digest: CATALOG_A, capability_epoch: 1 },
      { catalog_digest: CATALOG_A, capability_epoch: 1 },
    ]);
  });

  it("recomputes the canonical catalog digest and rejects content substitution", async () => {
    const valid = activeCatalog({ epoch: 2, revision: 2 });
    const tampered = {
      ...valid,
      active_context: { guidance: "Attacker substituted this context." },
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") return rpcResult(body.id, {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {}, _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": SESSION_A } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ ok: true }, tampered)) }],
        isError: false,
      });
    });

    await expect(client(fetchImpl).executeBatch([call()]))
      .rejects.toThrow("catalog digest mismatch");
  });

  it("pins returned catalogs to the admitted runtime and rejects epoch or revision rollback", async () => {
    let response = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") return rpcResult(body.id, {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {}, _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": SESSION_A } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      response += 1;
      const catalog = response === 1
        ? activeCatalog({ epoch: 2, revision: 2 })
        : response === 2
          ? activeCatalog({ epoch: 3, revision: 3, runtimeDigest: "f".repeat(64) })
          : activeCatalog({ epoch: 1, revision: 1 });
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ response }, catalog)) }],
        isError: false,
      });
    });
    const gateway = client(fetchImpl);
    await gateway.executeBatch([call({ nativeCallId: "advance" })]);
    await expect(gateway.executeBatch([call({ nativeCallId: "runtime-substitution" })]))
      .rejects.toThrow("changed the admitted runtime");
    await expect(gateway.executeBatch([call({ nativeCallId: "authority-rollback" })]))
      .rejects.toThrow("rolled authority backward");
  });

  it("drains a committed exact receipt without redispatch before final identity erasure", async () => {
    let release!: () => void;
    const committed = new Promise<void>((resolve) => { release = resolve; });
    let toolCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") return rpcResult(body.id, {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {}, _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": SESSION_A } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      toolCalls += 1;
      await committed;
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ committed: true })) }],
        isError: false,
      });
    });
    const gateway = client(fetchImpl);
    const execution = gateway.executeBatch([call({ nativeCallId: "committed-native-id" })]);
    await vi.waitFor(() => expect(toolCalls).toBe(1));

    const draining = gateway.drainAndClose(1_000);
    await expect(gateway.executeBatch([call({ nativeCallId: "late-new-call" })]))
      .rejects.toThrow("draining");
    release();

    await expect(execution).resolves.toMatchObject([{ nativeCallId: "committed-native-id" }]);
    await expect(draining).resolves.toEqual({
      settledNativeCallIds: ["committed-native-id"],
      unresolvedNativeCallIds: [],
    });
    expect(toolCalls).toBe(1);
  });

  it("preserves exact local replay after settlement and erases only at final close", async () => {
    const test = successfulGateway();
    const gateway = client(test.fetchImpl);
    const providerCall = call({ nativeCallId: "settled-before-close" });

    const first = await gateway.executeBatch([providerCall]);
    const replay = await gateway.executeBatch([providerCall]);
    expect(replay[0]).toBe(first[0]);
    expect(test.requests.filter((request) => request.body.method === "tools/call")).toHaveLength(1);

    await expect(gateway.drainAndClose(100)).resolves.toEqual({
      settledNativeCallIds: [],
      unresolvedNativeCallIds: [],
    });
    expect(() => gateway.executeBatch([providerCall])).toThrow("stopped");
  });

  it("reports the exact uncertain native identity when the bounded drain expires", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") return rpcResult(body.id, {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {}, _meta: PROVIDER_CONNECTION_META,
      }, { headers: { "MCP-Session-Id": SESSION_A } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const gateway = client(fetchImpl);
    const execution = gateway.executeBatch([call({ nativeCallId: "uncertain-native-id" })]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));

    await expect(gateway.drainAndClose(1)).resolves.toEqual({
      settledNativeCallIds: [],
      unresolvedNativeCallIds: ["uncertain-native-id"],
    });
    await expect(execution).rejects.toThrow("stopped");
  });

  it("aborts in-flight bootstrap when the owning transport stops", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const gateway = client(fetchImpl);
    const pending = gateway.initialize();
    gateway.close();
    await expect(pending).rejects.toThrow("stopped");
  });
});

describe("browser capability rotation", () => {
  const baseMs = Date.parse("2026-07-16T20:00:00.000Z");
  const callId = "00000000-0000-4000-8000-000000000099";
  const initialMcp = `mcp0.${"a".repeat(96)}`;
  const initialRenewal = `renew0.${"b".repeat(96)}`;
  const nextMcp = `mcp1.${"c".repeat(96)}`;
  const nextRenewal = `renew1.${"d".repeat(96)}`;

  function iso(ms: number) { return new Date(ms).toISOString(); }

  function rotationResponse() {
    const expiresAt = baseMs + 55 * 60_000;
    const refreshAfter = expiresAt - 5 * 60_000;
    return {
      schema_version: 1,
      call_id: callId,
      rotation: 1,
      refresh_after: iso(refreshAfter),
      expires_at: iso(expiresAt),
      mcp_capability: {
        token: nextMcp,
        expires_at: iso(expiresAt),
        audience: "mcp",
        purpose: "tool-invocation",
      },
      renewal_capability: {
        token: nextRenewal,
        expires_at: iso(expiresAt),
        audience: "browser_refresh",
        purpose: "capability_rotation",
      },
    };
  }

  function rotatingGateway(fetchImpl: typeof fetch, now: () => number) {
    let rpc = 0;
    return new BrowserCapabilityGateway({
      provider: "openai",
      url: URL,
      token: initialMcp,
      expectedOrigin: ORIGIN,
      fetchImpl,
      randomId: () => `rotation-rpc-${++rpc}`,
      activeCatalogDigest: CATALOG_A,
      activeCatalogEpoch: 1,
      activeRuntimeDigest: RUNTIME_DIGEST,
      activeStateRevision: 1,
      now,
      rotation: {
        endpoint: "/api/voice/capabilities/rotate",
        callId,
        rotation: 0,
        renewalToken: initialRenewal,
        refreshAfter: iso(baseMs + 25 * 60_000),
        expiresAt: iso(baseMs + 30 * 60_000),
      },
    });
  }

  it("rotates at 25 minutes and executes past the original 30-minute wall after a fresh MCP handshake", async () => {
    let now = baseMs;
    let initialize = 0;
    const observed: Array<{ url: string; authorization: string | null; key: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      observed.push({
        url,
        authorization: headers.get("authorization"),
        key: headers.get("idempotency-key"),
        body,
      });
      if (url.endsWith("/api/voice/capabilities/rotate")) {
        return new Response(JSON.stringify(rotationResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (body.method === "initialize") {
        initialize += 1;
        return rpcResult(body.id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
          _meta: PROVIDER_CONNECTION_META,
        }, { headers: { "MCP-Session-Id": initialize === 1 ? SESSION_A : SESSION_B } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ ok: true })) }],
        isError: false,
      });
    });
    const gateway = rotatingGateway(fetchImpl, () => now);

    await gateway.executeBatch([call({ nativeCallId: "before-wall", nativeItemId: "item-before" })]);
    now = baseMs + 25 * 60_000;
    await gateway.executeBatch([call({ nativeCallId: "at-rotation", nativeItemId: "item-rotation" })]);
    now = baseMs + 31 * 60_000;
    await gateway.executeBatch([call({ nativeCallId: "past-old-wall", nativeItemId: "item-past" })]);

    const rotations = observed.filter((entry) => entry.url.endsWith("/api/voice/capabilities/rotate"));
    expect(rotations).toHaveLength(1);
    expect(rotations[0]).toMatchObject({
      authorization: `Bearer ${initialRenewal}`,
      key: `${callId}:1`,
      body: { schema_version: 1, call_id: callId, rotation: 1 },
    });
    expect(initialize).toBe(2);
    const initializeRequests = observed.filter((entry) => entry.body.method === "initialize");
    const connectionNonces = initializeRequests.map((entry) => {
      const params = entry.body.params as Record<string, unknown>;
      const metadata = params._meta as Record<string, unknown>;
      const connection = metadata["com.harsha.callcenter/provider-connection"] as Record<string, unknown>;
      return connection.connectionNonce;
    });
    expect(connectionNonces).toHaveLength(2);
    expect(connectionNonces[0]).toBe(connectionNonces[1]);
    const toolAuthorizations = observed
      .filter((entry) => entry.body.method === "tools/call")
      .map((entry) => entry.authorization);
    expect(toolAuthorizations).toEqual([
      `Bearer ${initialMcp}`,
      `Bearer ${nextMcp}`,
      `Bearer ${nextMcp}`,
    ]);
    const durableConnectionIds = observed
      .filter((entry) => entry.body.method === "tools/call")
      .map((entry) => {
        const params = entry.body.params as Record<string, unknown>;
        const metadata = params._meta as Record<string, unknown>;
        const provenance = metadata[PROVIDER_PROVENANCE_META_KEY] as Record<string, unknown>;
        return provenance.providerConnectionId;
      });
    expect(new Set(durableConnectionIds).size).toBe(1);
    gateway.close();
  });

  it("rotates autonomously while idle before the original capabilities expire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseMs);
    let initialize = 0;
    const observed: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      observed.push({ url, authorization: headers.get("authorization"), body });
      if (url.endsWith("/api/voice/capabilities/rotate")) {
        return new Response(JSON.stringify(rotationResponse()), { status: 200 });
      }
      if (body.method === "initialize") {
        initialize += 1;
        return rpcResult(body.id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
          _meta: PROVIDER_CONNECTION_META,
        }, { headers: { "MCP-Session-Id": initialize === 1 ? SESSION_A : SESSION_B } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ ok: true })) }],
        isError: false,
      });
    });
    const gateway = rotatingGateway(fetchImpl, Date.now);
    await gateway.initialize();

    await vi.advanceTimersByTimeAsync(25 * 60_000);
    expect(observed.filter((entry) =>
      entry.url.endsWith("/api/voice/capabilities/rotate")
    )).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await gateway.executeBatch([call({ nativeCallId: "after-idle-wall", nativeItemId: "idle-item" })]);
    const toolRequest = observed.find((entry) => entry.body.method === "tools/call");
    expect(toolRequest?.authorization).toBe(`Bearer ${nextMcp}`);
    expect(initialize).toBe(2);
    gateway.close();
  });

  it("retries a lost rotation response with byte-identical body and idempotency binding", async () => {
    let now = baseMs + 25 * 60_000;
    let rotationAttempts = 0;
    const rotationRequests: Array<{ body: string; authorization: string | null; key: string | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (String(input).endsWith("/api/voice/capabilities/rotate")) {
        rotationAttempts += 1;
        rotationRequests.push({
          body: String(init?.body),
          authorization: headers.get("authorization"),
          key: headers.get("idempotency-key"),
        });
        if (rotationAttempts === 1) throw new Error("response lost");
        return new Response(JSON.stringify(rotationResponse()), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return rpcResult(body.id, {
          protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: {}, _meta: PROVIDER_CONNECTION_META,
        }, { headers: { "MCP-Session-Id": SESSION_B } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ ok: true })) }], isError: false,
      });
    });
    const gateway = rotatingGateway(fetchImpl, () => now);
    const pending = call({ nativeCallId: "lost-rotation", nativeItemId: "lost-item" });
    await expect(gateway.executeBatch([pending])).rejects.toThrow("response lost");
    await gateway.executeBatch([pending]);
    expect(rotationRequests).toHaveLength(2);
    expect(rotationRequests[1]).toEqual(rotationRequests[0]);
    expect(rotationAttempts).toBe(2);
    now += 1;
    gateway.close();
  });

  it("fails closed without network access once both current capabilities expired", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const gateway = rotatingGateway(fetchImpl, () => baseMs + 30 * 60_000);
    await expect(gateway.executeBatch([call({ nativeCallId: "expired" })]))
      .rejects.toThrow("expired before rotation completed");
    expect(fetchImpl).not.toHaveBeenCalled();
    gateway.close();
  });
});
