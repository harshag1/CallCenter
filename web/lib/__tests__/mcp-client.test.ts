import { describe, expect, it, vi } from "vitest";
import {
  McpClientError,
  StreamableHttpMcpClient,
  extractSafeMcpToolResult,
  namespaceMcpToolName,
  namespaceMcpTools,
  type McpFetch,
  type McpToolDefinition,
} from "../mcp-client";

const INITIALIZE_RESULT = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: "fixture-server", version: "1.2.3" },
};

function jsonResponse(id: string | number, result: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function rpcBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function headersFor(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

type MockMcpFetch = McpFetch & {
  mock: { calls: Array<[string | URL | Request, RequestInit?]> };
};

function fixtureFetch(
  handler: (rpc: Record<string, unknown>, init: RequestInit, call: number) => Response | Promise<Response>
): MockMcpFetch {
  let call = 0;
  return vi.fn(async (_input, init = {}) => {
    call += 1;
    return handler(rpcBody(init), init, call);
  }) as MockMcpFetch;
}

function initializeThen(
  operation: (rpc: Record<string, unknown>, init: RequestInit, call: number) => Response | Promise<Response>,
  options: { session?: string; initialize?: Record<string, unknown> } = {}
): MockMcpFetch {
  return fixtureFetch((rpc, init, call) => {
    if (rpc.method === "initialize") {
      return jsonResponse(rpc.id as number, options.initialize ?? INITIALIZE_RESULT, {
        ...(options.session ? { "MCP-Session-Id": options.session } : {}),
      });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    return operation(rpc, init, call);
  });
}

describe("StreamableHttpMcpClient configuration", () => {
  it("requires HTTPS except for exact loopback development hosts", () => {
    expect(() => new StreamableHttpMcpClient({ endpoint: "http://remote.example/mcp" }))
      .toThrowError(expect.objectContaining({ code: "insecure_endpoint" }));
    expect(() => new StreamableHttpMcpClient({ endpoint: "ftp://localhost/mcp" }))
      .toThrowError(expect.objectContaining({ code: "insecure_endpoint" }));
    expect(() => new StreamableHttpMcpClient({ endpoint: "http://localhost/mcp" })).not.toThrow();
    expect(() => new StreamableHttpMcpClient({
      endpoint: "http://127.0.0.1/mcp",
      allowInsecureLocalhost: false,
    })).toThrowError(expect.objectContaining({ code: "insecure_endpoint" }));
    expect(() => new StreamableHttpMcpClient({ endpoint: "https://user:pass@example.com/mcp" }))
      .toThrowError(expect.objectContaining({ code: "invalid_configuration" }));
    expect(() => new StreamableHttpMcpClient({ endpoint: "https://169.254.169.254/mcp" }))
      .toThrowError(expect.objectContaining({ code: "insecure_endpoint" }));
    expect(() => new StreamableHttpMcpClient({ endpoint: "https://10.0.0.2/mcp" }))
      .toThrowError(expect.objectContaining({ code: "insecure_endpoint" }));
  });

  it("rejects header injection before making a request", () => {
    expect(() => new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      authorization: "Bearer good\r\nX-Evil: yes",
    })).toThrowError(expect.objectContaining({ code: "invalid_configuration" }));
  });
});

describe("MCP lifecycle and transport", () => {
  it("initializes exactly once, acknowledges initialization, and carries auth/session/version headers", async () => {
    const fetch = initializeThen((rpc, init) => {
      expect(rpc).toMatchObject({ jsonrpc: "2.0", method: "tools/list" });
      const headers = headersFor(init);
      expect(headers.get("authorization")).toBe("Bearer top-secret");
      expect(headers.get("mcp-session-id")).toBe("session_123");
      expect(headers.get("mcp-protocol-version")).toBe("2025-11-25");
      return jsonResponse(rpc.id as number, { tools: [] });
    }, { session: "session_123" });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      authorization: "Bearer top-secret",
      fetch,
    });

    const initialized = await client.initialize();
    expect(initialized).toEqual({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "fixture-server", version: "1.2.3" },
      capabilities: { tools: true, toolsListChanged: true },
    });
    expect(await client.listTools()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);

    const firstInit = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(rpcBody(firstInit)).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "harshas-amazing-call-center", version: "1.0.0" },
      },
    });
    expect(headersFor(firstInit).get("authorization")).toBe("Bearer top-secret");
    expect(headersFor(firstInit).get("mcp-session-id")).toBeNull();
    expect(headersFor(firstInit).get("accept")).toBe("application/json, text/event-stream");

    const notification = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(rpcBody(notification)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(headersFor(notification).get("mcp-session-id")).toBe("session_123");
  });

  it("publishes initialization only after the initialized notification is accepted", async () => {
    let releaseNotification!: () => void;
    const notificationResponse = new Promise<Response>((resolve) => {
      releaseNotification = () => resolve(new Response(null, { status: 202 }));
    });
    let toolListRequests = 0;
    const fetch = fixtureFetch((rpc) => {
      if (rpc.method === "initialize") return jsonResponse(rpc.id as number, INITIALIZE_RESULT);
      if (rpc.method === "notifications/initialized") return notificationResponse;
      if (rpc.method === "tools/list") {
        toolListRequests += 1;
        return jsonResponse(rpc.id as number, { tools: [] });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });

    const initializing = client.initialize();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const listing = client.listTools();
    await Promise.resolve();
    expect(toolListRequests).toBe(0);
    releaseNotification();
    await expect(initializing).resolves.toMatchObject({ protocolVersion: "2025-11-25" });
    await expect(listing).resolves.toEqual([]);
    expect(toolListRequests).toBe(1);
  });

  it("gives concurrent initialization waiters independent abort lifetimes", async () => {
    let releaseInitialize!: () => void;
    const fetch = fixtureFetch((rpc) => {
      if (rpc.method === "initialize") {
        return new Promise<Response>((resolve) => {
          releaseInitialize = () => resolve(jsonResponse(rpc.id as number, INITIALIZE_RESULT));
        });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });
    const controller = new AbortController();
    const first = client.initialize({ signal: controller.signal });
    const second = client.initialize();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "aborted" });
    releaseInitialize();
    await expect(second).resolves.toMatchObject({ protocolVersion: "2025-11-25" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not let a closing initialization publish a reopened session", async () => {
    let initializeCount = 0;
    let releaseFirstNotification!: () => void;
    const firstNotification = new Promise<Response>((resolve) => {
      releaseFirstNotification = () => resolve(new Response(null, { status: 202 }));
    });
    const fetch = fixtureFetch((rpc) => {
      if (rpc.method === "initialize") {
        initializeCount += 1;
        return jsonResponse(rpc.id as number, INITIALIZE_RESULT);
      }
      if (rpc.method === "notifications/initialized") {
        return initializeCount === 1 ? firstNotification : new Response(null, { status: 202 });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });
    const first = client.initialize();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await client.close();
    releaseFirstNotification();
    await expect(first).rejects.toMatchObject({ code: "aborted" });
    await expect(client.initialize()).resolves.toMatchObject({ protocolVersion: "2025-11-25" });
    expect(initializeCount).toBe(2);
  });

  it("accepts an SSE response and selects only the matching JSON-RPC response", async () => {
    let pingReplies = 0;
    const fetch = initializeThen((rpc) => {
      if (rpc.method === undefined) {
        expect(rpc).toEqual({ jsonrpc: "2.0", id: "server-ping", result: {} });
        pingReplies += 1;
        return new Response(null, { status: 202 });
      }
      expect(rpc.method).toBe("tools/call");
      const id = rpc.id as number;
      const body = [
        ": keepalive",
        "event: message",
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}`,
        "",
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-ping", method: "ping" })}`,
        "",
        "event: message",
        `id: event-${id}`,
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "{\"ok\":true}" }], isError: false },
        })}`,
        "",
        "",
      ].join("\n");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          // A valid SSE connection may remain open after the matching response.
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["lookup"],
      fetch,
    });

    const result = await client.callTool("lookup", { id: 42 });
    expect(result).toEqual({
      content: [{ type: "text", text: "{\"ok\":true}" }],
      isError: false,
      value: { ok: true },
    });
    await vi.waitFor(() => expect(pingReplies).toBe(1));
  });

  it("does not advance an SSE resume cursor for an incomplete event", async () => {
    let gets = 0;
    const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
      if (init.method === "GET") {
        gets += 1;
        return new Response(null, { status: 500 });
      }
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") return jsonResponse(rpc.id as number, INITIALIZE_RESULT);
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(`id: uncommitted\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: "lost" }] },
      })}`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as MockMcpFetch;
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["lookup"],
      fetch,
    });
    await expect(client.callTool("lookup")).rejects.toMatchObject({ code: "invalid_response" });
    expect(gets).toBe(0);
  });

  it("resumes a disconnected SSE request by event id without replaying the POST", async () => {
    let toolCallPosts = 0;
    const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
      if (init.method === "GET") {
        expect(headersFor(init).get("last-event-id")).toBe("resume-1");
        const id = 2;
        return new Response(`id: resume-2\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "resumed" }] },
        })}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") return jsonResponse(rpc.id as number, INITIALIZE_RESULT);
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/call") {
        toolCallPosts += 1;
        return new Response("id: resume-1\ndata:\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(null, { status: 500 });
    }) as MockMcpFetch;
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["lookup"],
      fetch,
    });

    await expect(client.callTool("lookup")).resolves.toMatchObject({ value: "resumed" });
    expect(toolCallPosts).toBe(1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(1);
  });

  it("enforces response body limits before and during reads", async () => {
    const advertisedFetch = initializeThen(() => new Response("x", {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Length": "10000" },
    }));
    const advertised = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch: advertisedFetch,
      maxResponseBytes: 512,
    });
    await expect(advertised.listTools()).rejects.toMatchObject({ code: "response_too_large" });

    const streamedFetch = initializeThen(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(300));
          controller.enqueue(new Uint8Array(300));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const streamed = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch: streamedFetch,
      maxResponseBytes: 512,
    });
    await expect(streamed.listTools()).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("honors caller aborts and total operation deadlines without retrying", async () => {
    const hangingFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      })
    ) as McpFetch;
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch: hangingFetch,
    });

    const controller = new AbortController();
    const aborted = client.initialize({ signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });
    expect(hangingFetch).toHaveBeenCalledTimes(1);

    await expect(client.initialize({ timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
    expect(hangingFetch).toHaveBeenCalledTimes(2);
  });

  it("sends explicit MCP cancellation when an in-flight tool request is aborted", async () => {
    let cancellations = 0;
    const fetch = fixtureFetch((rpc) => {
      if (rpc.method === "initialize") return jsonResponse(rpc.id as number, INITIALIZE_RESULT);
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "notifications/cancelled") {
        cancellations += 1;
        expect(rpc.params).toMatchObject({ requestId: 2 });
        return new Response(null, { status: 202 });
      }
      if (rpc.method === "tools/call") {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["mutate"],
      fetch,
    });
    const controller = new AbortController();
    const call = client.callTool("mutate", {}, { signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(cancellations).toBe(1));
  });

  it("applies deadlines while a custom response body reader is hung", async () => {
    const fetch = fixtureFetch((rpc) => {
      if (rpc.method === "initialize") return jsonResponse(rpc.id as number, INITIALIZE_RESULT);
      if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") {
        return new Response(null, { status: 202 });
      }
      if (rpc.method === "tools/list") {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });
    await expect(client.listTools({ timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("evaluates the deployment endpoint policy before any request", async () => {
    const fetch = vi.fn() as unknown as McpFetch;
    const policy = vi.fn(async (url: URL) => {
      expect(url.origin).toBe("https://mcp.example");
      return false;
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      endpointPolicy: policy,
      fetch,
    });
    await expect(client.initialize()).rejects.toMatchObject({ code: "insecure_endpoint" });
    expect(policy).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never includes endpoint, auth, or remote response text in errors", async () => {
    const secret = "never-show-this-token";
    const fetch = vi.fn(async () => new Response(`server leaked ${secret}`, {
      status: 401,
      headers: { "Content-Type": "text/plain" },
    })) as McpFetch;
    const client = new StreamableHttpMcpClient({
      endpoint: `https://mcp.example/private?tenant=${secret}`,
      authorization: `Bearer ${secret}`,
      fetch,
    });

    const error = await client.initialize().catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(McpClientError);
    expect(error).toMatchObject({ code: "http_error", httpStatus: 401 });
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("mcp.example");
    expect(String(error)).not.toContain("server leaked");
  });

  it("redacts JSON-RPC error messages while preserving the numeric code", async () => {
    const fetch = fixtureFetch((rpc) => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      error: { code: -32001, message: "secret database details" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });

    const error = await client.initialize().catch((candidate: unknown) => candidate);
    expect(error).toMatchObject({ code: "protocol_error", rpcCode: -32001 });
    expect(String(error)).not.toContain("database");
  });

  it("fails closed on unsupported versions and missing tools capability", async () => {
    const unsupportedFetch = initializeThen(() => new Response(null, { status: 500 }), {
      initialize: { ...INITIALIZE_RESULT, protocolVersion: "2024-11-05" },
    });
    const unsupported = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch: unsupportedFetch,
    });
    await expect(unsupported.initialize()).rejects.toMatchObject({ code: "unsupported_protocol" });
    expect(unsupportedFetch).toHaveBeenCalledTimes(1);

    const noToolsFetch = initializeThen(() => new Response(null, { status: 500 }), {
      initialize: { ...INITIALIZE_RESULT, capabilities: {} },
    });
    const noTools = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch: noToolsFetch,
    });
    await expect(noTools.listTools()).rejects.toMatchObject({ code: "missing_capability" });
    expect(noToolsFetch).toHaveBeenCalledTimes(2);
  });
});

describe("MCP tool discovery and execution", () => {
  it("paginates, filters the catalog, and enforces the allowlist before network access", async () => {
    const fetch = initializeThen((rpc) => {
      const params = rpc.params as Record<string, unknown> | undefined;
      if (rpc.method === "tools/list" && !params?.cursor) {
        return jsonResponse(rpc.id as number, {
          tools: [
            {
              name: "lookup",
              title: "Lookup",
              description: "Fetch a record.",
              inputSchema: { type: "object", properties: { id: { type: "string" } } },
              annotations: { destructiveHint: true },
              _meta: { secret: "not-forwarded" },
            },
            { name: "danger", inputSchema: { type: "object" } },
          ],
          nextCursor: "page-2",
        });
      }
      if (rpc.method === "tools/list" && params?.cursor === "page-2") {
        return jsonResponse(rpc.id as number, {
          tools: [{ name: "finish", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
        });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["lookup", "finish"],
      fetch,
    });

    expect(await client.listTools()).toEqual([
      {
        name: "lookup",
        title: "Lookup",
        description: "Fetch a record.",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      },
      {
        name: "finish",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      },
    ]);
    const callsBeforeDeniedTool = fetch.mock.calls.length;
    await expect(client.callTool("danger")).rejects.toMatchObject({ code: "tool_not_allowed" });
    expect(fetch).toHaveBeenCalledTimes(callsBeforeDeniedTool);
  });

  it("returns tool execution errors as results and safely prefers structured content", async () => {
    const fetch = initializeThen((rpc) => jsonResponse(rpc.id as number, {
      content: [{ type: "text", text: "fallback" }],
      structuredContent: { accepted: false, retryAfter: 10 },
      isError: true,
      _meta: { providerSecret: "drop-me" },
    }));
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["reserve"],
      fetch,
    });

    const result = await client.callTool("reserve", { slot: "10am" });
    expect(result).toEqual({
      content: [{ type: "text", text: "fallback" }],
      structuredContent: { accepted: false, retryAfter: 10 },
      isError: true,
      value: { accepted: false, retryAfter: 10 },
    });
    expect(JSON.stringify(result)).not.toContain("providerSecret");
  });

  it("does not call guessed names when no explicit allowlist was snapshotted", async () => {
    let calls = 0;
    const fetch = initializeThen((rpc) => {
      if (rpc.method === "tools/list") {
        return jsonResponse(rpc.id as number, {
          tools: [{ name: "advertised", inputSchema: { type: "object" } }],
        });
      }
      if (rpc.method === "tools/call") calls += 1;
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });
    await expect(client.callTool("guessed")).rejects.toMatchObject({ code: "tool_not_allowed" });
    expect(calls).toBe(0);
  });

  it("detects cursor loops and duplicate tool names", async () => {
    const loopFetch = initializeThen((rpc) => jsonResponse(rpc.id as number, {
      tools: [],
      nextCursor: "same-cursor",
    }));
    const loopClient = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch: loopFetch,
    });
    await expect(loopClient.listTools()).rejects.toMatchObject({ code: "pagination_limit" });

    let page = 0;
    const duplicateFetch = initializeThen((rpc) => {
      page += 1;
      return jsonResponse(rpc.id as number, {
        tools: [{ name: "same", inputSchema: { type: "object" } }],
        ...(page === 1 ? { nextCursor: "two" } : {}),
      });
    });
    const duplicateClient = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch: duplicateFetch,
    });
    await expect(duplicateClient.listTools()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects non-JSON arguments without invoking getters or the network", async () => {
    const fetch = vi.fn() as unknown as McpFetch;
    let getterCalls = 0;
    const args = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "should-not-run";
      },
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch,
    });

    expect(() => client.callTool("lookup", args)).toThrowError(
      expect.objectContaining({ code: "invalid_configuration" })
    );
    expect(getterCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("safe result extraction and namespacing", () => {
  it("validates content blocks and never falls back to arbitrary extension objects", () => {
    expect(extractSafeMcpToolResult({
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png", unsafe: "drop" },
        { type: "resource_link", uri: "https://example.com/a", name: "a" },
      ],
    })).toEqual({
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "resource_link", uri: "https://example.com/a", name: "a" },
      ],
      isError: false,
      value: null,
    });
    expect(() => extractSafeMcpToolResult({
      content: [{ type: "image", data: "not-base64", mimeType: "image/png" }],
    })).toThrowError(expect.objectContaining({ code: "invalid_response" }));
    expect(() => extractSafeMcpToolResult({
      content: [{ type: "future-content", executable: true }],
    })).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });

  it("creates deterministic, bounded, collision-resistant provider-safe names", () => {
    const first = namespaceMcpToolName("Billing & CRM", "customers.lookup");
    const same = namespaceMcpToolName("Billing & CRM", "customers.lookup");
    const different = namespaceMcpToolName("Billing-CRM", "customers.lookup");
    expect(first).toBe(same);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(64);

    const tools: McpToolDefinition[] = [{
      name: "customers.lookup",
      description: "Lookup",
      inputSchema: { type: "object" },
    }];
    expect(namespaceMcpTools("billing", tools)).toEqual([{
      name: namespaceMcpToolName("billing", "customers.lookup"),
      remoteName: "customers.lookup",
      namespace: "billing",
      description: "Lookup",
      inputSchema: { type: "object" },
    }]);
  });
});
