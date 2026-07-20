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

  it("deletes a provisional session when close interrupts the initialized handshake", async () => {
    let initializeCount = 0;
    let deleteCount = 0;
    const deletedSessions: string[] = [];
    const fetch: McpFetch = vi.fn(async (_input, init = {}) => {
      if (init.method === "DELETE") {
        deleteCount += 1;
        deletedSessions.push(headersFor(init).get("mcp-session-id") ?? "");
        expect(headersFor(init).get("mcp-protocol-version")).toBe("2025-11-25");
        return new Response(null, { status: 204 });
      }
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") {
        initializeCount += 1;
        return jsonResponse(rpc.id as number, INITIALIZE_RESULT, {
          "MCP-Session-Id": initializeCount === 1 ? "provisional-s1" : "published-s2",
        });
      }
      if (rpc.method === "notifications/initialized" && initializeCount === 1) {
        return new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
          if (init.signal?.aborted) rejectAbort();
          else init.signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      if (rpc.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });

    const initializing = client.initialize();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await expect(client.close()).resolves.toBeUndefined();
    await expect(initializing).rejects.toMatchObject({ code: "aborted" });
    expect(deleteCount).toBe(1);
    expect(deletedSessions).toEqual(["provisional-s1"]);

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

  it("serializes authenticated replies to concurrent SSE server requests", async () => {
    let activeReplies = 0;
    let maxActiveReplies = 0;
    const repliedIds: Array<string | number> = [];
    const fetch = initializeThen(async (rpc) => {
      if (rpc.method === undefined) {
        activeReplies += 1;
        maxActiveReplies = Math.max(maxActiveReplies, activeReplies);
        repliedIds.push(rpc.id as string | number);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeReplies -= 1;
        return new Response(null, { status: 202 });
      }
      expect(rpc.method).toBe("tools/call");
      const id = rpc.id as number;
      const requests = Array.from({ length: 8 }, (_, index) => [
        "event: message",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: `server-ping-${index}`,
          method: "ping",
        })}`,
        "",
      ].join("\n"));
      return new Response([
        ...requests,
        "event: message",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "{\"ok\":true}" }], isError: false },
        })}`,
        "",
        "",
      ].join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["lookup"],
      fetch,
    });

    await expect(client.callTool("lookup")).resolves.toMatchObject({ value: { ok: true } });
    await vi.waitFor(() => expect(repliedIds).toHaveLength(8));
    expect(maxActiveReplies).toBe(1);
    expect(repliedIds).toEqual(Array.from({ length: 8 }, (_, index) => `server-ping-${index}`));
  });

  it("drains authenticated SSE server replies before deleting the session", async () => {
    const order: string[] = [];
    const replyHeaders: Headers[] = [];
    let releaseFirstReply!: () => void;
    const firstReply = new Promise<Response>((resolve) => {
      releaseFirstReply = () => resolve(new Response(null, { status: 202 }));
    });
    const fetch: McpFetch = vi.fn(async (_input, init = {}) => {
      if (init.method === "DELETE") {
        order.push("delete");
        const headers = headersFor(init);
        expect(headers.get("authorization")).toBe("Bearer reply-secret");
        expect(headers.get("mcp-session-id")).toBe("reply-session");
        return new Response(null, { status: 204 });
      }
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") {
        return jsonResponse(rpc.id as number, INITIALIZE_RESULT, {
          "MCP-Session-Id": "reply-session",
        });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === undefined) {
        const id = String(rpc.id);
        order.push(id);
        replyHeaders.push(headersFor(init));
        return id === "server-ping-1" ? firstReply : new Response(null, { status: 202 });
      }
      expect(rpc.method).toBe("tools/call");
      const id = rpc.id as number;
      return new Response([
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-ping-1", method: "ping" })}`,
        "",
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-ping-2", method: "ping" })}`,
        "",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "{\"ok\":true}" }], isError: false },
        })}`,
        "",
        "",
      ].join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      authorization: "Bearer reply-secret",
      allowedTools: ["lookup"],
      fetch,
    });

    await expect(client.callTool("lookup")).resolves.toMatchObject({ value: { ok: true } });
    await vi.waitFor(() => expect(order).toEqual(["server-ping-1"]));
    const closing = client.close();
    await Promise.resolve();
    expect(order).toEqual(["server-ping-1"]);
    releaseFirstReply();
    await closing;

    expect(order).toEqual(["server-ping-1", "server-ping-2", "delete"]);
    expect(replyHeaders).toHaveLength(2);
    for (const headers of replyHeaders) {
      expect(headers.get("authorization")).toBe("Bearer reply-secret");
      expect(headers.get("mcp-session-id")).toBe("reply-session");
      expect(headers.get("mcp-protocol-version")).toBe("2025-11-25");
    }
  });

  it("does not let a stale session 404 expire a newer published session", async () => {
    let initializeCount = 0;
    let releaseOld!: () => void;
    let oldPosts = 0;
    const seenToolSessions: string[] = [];
    const fetch: McpFetch = vi.fn(async (_input, init = {}) => {
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") {
        initializeCount += 1;
        return jsonResponse(rpc.id as number, {
          ...INITIALIZE_RESULT,
          protocolVersion: initializeCount === 1 ? "2025-06-18" : "2025-11-25",
        }, {
          "MCP-Session-Id": `session-${initializeCount}`,
        });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/call") {
        const session = headersFor(init).get("mcp-session-id") ?? "";
        seenToolSessions.push(session);
        if (session === "session-1") {
          oldPosts += 1;
          return new Promise<Response>((resolve) => {
            releaseOld = () => resolve(new Response(null, { status: 404 }));
          });
        }
        return jsonResponse(rpc.id as number, {
          content: [{ type: "text", text: "new-session-ok" }],
        });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["lookup"],
      fetch,
    });

    await client.initialize();
    const staleCall = client.callTool("lookup");
    await vi.waitFor(() => expect(oldPosts).toBe(1));
    await client.close();
    await client.initialize();
    releaseOld();
    await expect(staleCall).rejects.toMatchObject({ code: "session_expired", httpStatus: 404 });
    await expect(client.callTool("lookup")).resolves.toMatchObject({ value: "new-session-ok" });

    expect(initializeCount).toBe(2);
    expect(seenToolSessions).toEqual(["session-1", "session-2"]);
  });

  it("pins delayed SSE replies to the request's original session and protocol", async () => {
    let initializeCount = 0;
    let releaseOld!: () => void;
    let oldPosts = 0;
    const pingSessions: Array<{ session: string | null; protocol: string | null }> = [];
    const fetch: McpFetch = vi.fn(async (_input, init = {}) => {
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") {
        initializeCount += 1;
        return jsonResponse(rpc.id as number, {
          ...INITIALIZE_RESULT,
          protocolVersion: initializeCount === 1 ? "2025-06-18" : "2025-11-25",
        }, {
          "MCP-Session-Id": `session-${initializeCount}`,
        });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === undefined) {
        pingSessions.push({
          session: headersFor(init).get("mcp-session-id"),
          protocol: headersFor(init).get("mcp-protocol-version"),
        });
        return new Response(null, { status: 202 });
      }
      if (rpc.method === "tools/call" && headersFor(init).get("mcp-session-id") === "session-1") {
        oldPosts += 1;
        const id = rpc.id as number;
        return new Promise<Response>((resolve) => {
          releaseOld = () => resolve(new Response([
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: "old-ping", method: "ping" })}`,
            "",
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: "old-result" }] },
            })}`,
            "",
            "",
          ].join("\n"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }));
        });
      }
      if (rpc.method === "tools/call") {
        return jsonResponse(rpc.id as number, {
          content: [{ type: "text", text: "new-result" }],
        });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["lookup"],
      fetch,
    });

    await client.initialize();
    const oldCall = client.callTool("lookup");
    await vi.waitFor(() => expect(oldPosts).toBe(1));
    await client.close();
    await client.initialize();
    releaseOld();
    await expect(oldCall).resolves.toMatchObject({ value: "old-result" });
    await vi.waitFor(() => expect(pingSessions).toHaveLength(1));
    expect(pingSessions).toEqual([{ session: "session-1", protocol: "2025-06-18" }]);
    await expect(client.callTool("lookup")).resolves.toMatchObject({ value: "new-result" });
    expect(initializeCount).toBe(2);
  });

  it("does not let a stale catalog overwrite a newer session's advertised tools", async () => {
    let initializeCount = 0;
    let listPosts = 0;
    const listSessions: string[] = [];
    let releaseOldList!: () => void;
    const fetch: McpFetch = vi.fn(async (_input, init = {}) => {
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") {
        initializeCount += 1;
        return jsonResponse(rpc.id as number, INITIALIZE_RESULT, {
          "MCP-Session-Id": `catalog-session-${initializeCount}`,
        });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/list") {
        listPosts += 1;
        const session = headersFor(init).get("mcp-session-id") ?? "";
        const cursor = (rpc.params as Record<string, unknown> | undefined)?.cursor;
        listSessions.push(session);
        if (session === "catalog-session-1" && cursor === undefined) {
          return new Promise<Response>((resolve) => {
            releaseOldList = () => resolve(jsonResponse(rpc.id as number, {
              tools: [{ name: "old-page-one", inputSchema: { type: "object" } }],
              nextCursor: "old-page-2",
            }));
          });
        }
        if (session === "catalog-session-1" && cursor === "old-page-2") {
          return jsonResponse(rpc.id as number, {
            tools: [{ name: "old-page-two", inputSchema: { type: "object" } }],
          });
        }
        return jsonResponse(rpc.id as number, {
          tools: [{ name: "new-only", inputSchema: { type: "object" } }],
        });
      }
      if (rpc.method === "tools/call") {
        return jsonResponse(rpc.id as number, {
          content: [{ type: "text", text: "new-tool-ok" }],
        });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });

    await client.initialize();
    const staleList = client.listTools();
    await vi.waitFor(() => expect(listPosts).toBe(1));
    await client.close();
    await client.initialize();
    await expect(client.listTools()).resolves.toEqual([
      { name: "new-only", inputSchema: { type: "object" } },
    ]);
    releaseOldList();
    await expect(staleList).resolves.toEqual([
      { name: "old-page-one", inputSchema: { type: "object" } },
      { name: "old-page-two", inputSchema: { type: "object" } },
    ]);
    await expect(client.callTool("old-page-two"))
      .rejects.toMatchObject({ code: "tool_not_allowed" });
    await expect(client.callTool("new-only")).resolves.toMatchObject({ value: "new-tool-ok" });
    expect(listPosts).toBe(3);
    expect(listSessions).toEqual([
      "catalog-session-1",
      "catalog-session-2",
      "catalog-session-1",
    ]);
  });

  it("joins concurrent close callers onto one teardown", async () => {
    let deleteCount = 0;
    let releaseDelete!: () => void;
    const fetch: McpFetch = vi.fn(async (_input, init = {}) => {
      if (init.method === "DELETE") {
        deleteCount += 1;
        return new Promise<Response>((resolve) => {
          releaseDelete = () => resolve(new Response(null, { status: 204 }));
        });
      }
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") {
        return jsonResponse(rpc.id as number, INITIALIZE_RESULT, {
          "MCP-Session-Id": "joined-session",
        });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });
    await client.initialize();

    let firstSettled = false;
    let secondSettled = false;
    const first = client.close().finally(() => { firstSettled = true; });
    const second = client.close().finally(() => { secondSettled = true; });
    await vi.waitFor(() => expect(deleteCount).toBe(1));
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    releaseDelete();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(deleteCount).toBe(1);
  });

  it("retains failed DELETE state so close can retry the exact session", async () => {
    let initializeCount = 0;
    const deleteHeaders: Headers[] = [];
    const fetch: McpFetch = vi.fn(async (_input, init = {}) => {
      if (init.method === "DELETE") {
        deleteHeaders.push(headersFor(init));
        return deleteHeaders.length === 1
          ? new Response(null, { status: 503 })
          : new Response(null, { status: 204 });
      }
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") {
        initializeCount += 1;
        return jsonResponse(rpc.id as number, INITIALIZE_RESULT, {
          "MCP-Session-Id": "retry-session",
        });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });
    await client.initialize();

    await expect(client.close()).rejects.toMatchObject({ code: "http_error", httpStatus: 503 });
    await expect(client.close()).resolves.toBeUndefined();
    expect(deleteHeaders).toHaveLength(2);
    for (const headers of deleteHeaders) {
      expect(headers.get("mcp-session-id")).toBe("retry-session");
      expect(headers.get("mcp-protocol-version")).toBe("2025-11-25");
    }
    expect(initializeCount).toBe(1);
  });

  it("rejects an SSE response with unbounded out-of-band message fan-out", async () => {
    const fetch = initializeThen((rpc) => {
      expect(rpc.method).toBe("tools/call");
      const id = rpc.id as number;
      const notifications = Array.from({ length: 33 }, (_, index) => [
        "event: message",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progress: index },
        })}`,
        "",
      ].join("\n"));
      return new Response([
        ...notifications,
        "event: message",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "late" }] },
        })}`,
        "",
        "",
      ].join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["lookup"],
      fetch,
    });

    await expect(client.callTool("lookup")).rejects.toMatchObject({ code: "invalid_response" });
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

  it("enforces total deadlines when custom fetch ignores abort signals", async () => {
    const neverSettles = new Promise<Response>(() => undefined);
    const initializeFetch = vi.fn(() => neverSettles) as unknown as McpFetch;
    const initializeClient = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch: initializeFetch,
    });
    await expect(initializeClient.initialize({ timeoutMs: 10 }))
      .rejects.toMatchObject({ code: "timeout" });
    expect(initializeFetch).toHaveBeenCalledTimes(1);

    let deleteCount = 0;
    const closeFetch: McpFetch = vi.fn(async (_input, init = {}) => {
      if (init.method === "DELETE") {
        deleteCount += 1;
        return deleteCount === 1 ? neverSettles : new Response(null, { status: 204 });
      }
      const rpc = rpcBody(init);
      if (rpc.method === "initialize") {
        return jsonResponse(rpc.id as number, INITIALIZE_RESULT, {
          "MCP-Session-Id": "deadline-session",
        });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(null, { status: 500 });
    });
    const closeClient = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      fetch: closeFetch,
    });
    await closeClient.initialize();
    await expect(closeClient.close({ timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout" });
    await expect(closeClient.close()).resolves.toBeUndefined();
    expect(deleteCount).toBe(2);
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

  it("does not extend the caller deadline while cancellation transport is hung", async () => {
    vi.useFakeTimers();
    try {
      let cancellations = 0;
      const neverSettles = new Promise<Response>(() => undefined);
      const fetch = fixtureFetch((rpc) => {
        if (rpc.method === "initialize") return jsonResponse(rpc.id as number, INITIALIZE_RESULT);
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (rpc.method === "notifications/cancelled") {
          cancellations += 1;
          return neverSettles;
        }
        if (rpc.method === "tools/call") return neverSettles;
        return new Response(null, { status: 500 });
      });
      const client = new StreamableHttpMcpClient({
        endpoint: "https://mcp.example/mcp",
        allowedTools: ["mutate"],
        fetch,
      });
      await client.initialize();

      let outcome: unknown;
      void client.callTool("mutate", {}, { timeoutMs: 25 }).then(
        () => { outcome = "resolved"; },
        (error: unknown) => { outcome = error; }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(25);

      expect(outcome).toMatchObject({ code: "timeout" });
      expect(cancellations).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("sends strict gateway-owned identities outside model-controlled arguments", async () => {
    let toolCall: Record<string, unknown> | null = null;
    const fetch = initializeThen((rpc) => {
      if (rpc.method === "tools/call") toolCall = rpc;
      return jsonResponse(rpc.id as number, {
        content: [],
        structuredContent: { ok: true },
      });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["reserve"],
      fetch,
    });

    await client.callTool(
      "reserve",
      {
        slot: "10am",
        _meta: {
          "hacc/invocation_id": "attackerattackerattacker",
          "hacc/idempotency_key": "0".repeat(64),
          "hacc/provider_tool_call_id": "model-controlled-id",
        },
      },
      {
        metadata: {
          "hacc/invocation_id": "abcdefghijklmnopqrstuvwx",
          "hacc/idempotency_key": "a".repeat(64),
        },
        persistentProviderToolCallId: "provider-call-α-001",
      }
    );

    expect(toolCall).not.toBeNull();
    const params = toolCall!.params as Record<string, unknown>;
    expect(params._meta).toEqual({
      "hacc/invocation_id": "abcdefghijklmnopqrstuvwx",
      "hacc/idempotency_key": "a".repeat(64),
      "hacc/provider_tool_call_id": "provider-call-α-001",
    });
    expect((params.arguments as Record<string, unknown>)._meta).toEqual({
      "hacc/invocation_id": "attackerattackerattacker",
      "hacc/idempotency_key": "0".repeat(64),
      "hacc/provider_tool_call_id": "model-controlled-id",
    });
  });

  it("rejects malformed gateway invocation metadata before network access", () => {
    const fetch = vi.fn() as unknown as McpFetch;
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });

    expect(() => client.callTool("reserve", {}, {
      metadata: {
        "hacc/invocation_id": "too-short",
        "hacc/idempotency_key": "a".repeat(64),
      },
    })).toThrowError(expect.objectContaining({ code: "invalid_configuration" }));

    for (const persistentProviderToolCallId of ["", "bad\nid", "α".repeat(129)]) {
      expect(() => client.callTool("reserve", {}, { persistentProviderToolCallId }))
        .toThrowError(expect.objectContaining({ code: "invalid_configuration" }));
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects accessor, proxy, and hidden trusted metadata without evaluating it", () => {
    const fetch = vi.fn() as unknown as McpFetch;
    const client = new StreamableHttpMcpClient({ endpoint: "https://mcp.example/mcp", fetch });
    let getterCalls = 0;
    const accessorMetadata = Object.defineProperties({}, {
      "hacc/invocation_id": {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "abcdefghijklmnopqrstuvwx";
        },
      },
      "hacc/idempotency_key": {
        enumerable: true,
        value: "a".repeat(64),
      },
    });
    expect(() => client.callTool("reserve", {}, { metadata: accessorMetadata as never }))
      .toThrowError(expect.objectContaining({ code: "invalid_configuration" }));
    expect(getterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxiedMetadata = new Proxy({
      "hacc/invocation_id": "abcdefghijklmnopqrstuvwx",
      "hacc/idempotency_key": "a".repeat(64),
    }, {
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("secret proxy detail");
      },
    });
    const proxyError = (() => {
      try {
        client.callTool("reserve", {}, { metadata: proxiedMetadata });
      } catch (error) {
        return error;
      }
    })();
    expect(proxyError).toMatchObject({ code: "invalid_configuration" });
    expect(String(proxyError)).not.toContain("secret proxy detail");
    expect(proxyTrapCalls).toBe(0);

    const hiddenMetadata = {
      "hacc/invocation_id": "abcdefghijklmnopqrstuvwx",
      "hacc/idempotency_key": "a".repeat(64),
    } as Record<string | symbol, unknown>;
    Object.defineProperty(hiddenMetadata, "hidden", { value: "forged" });
    expect(() => client.callTool("reserve", {}, { metadata: hiddenMetadata as never }))
      .toThrowError(expect.objectContaining({ code: "invalid_configuration" }));

    const optionAccessor = Object.defineProperty({}, "metadata", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return accessorMetadata;
      },
    });
    expect(() => client.callTool("reserve", {}, optionAccessor as never))
      .toThrowError(expect.objectContaining({ code: "invalid_configuration" }));
    expect(getterCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("snapshots trusted metadata before any asynchronous initialization work", async () => {
    let releaseInitialize!: () => void;
    let toolCall: Record<string, unknown> | null = null;
    const fetch = fixtureFetch((rpc) => {
      if (rpc.method === "initialize") {
        return new Promise<Response>((resolve) => {
          releaseInitialize = () => resolve(jsonResponse(rpc.id as number, INITIALIZE_RESULT));
        });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/call") {
        toolCall = rpc;
        return jsonResponse(rpc.id as number, { content: [] });
      }
      return new Response(null, { status: 500 });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: "https://mcp.example/mcp",
      allowedTools: ["reserve"],
      fetch,
    });
    const mutableMetadata = {
      "hacc/invocation_id": "abcdefghijklmnopqrstuvwx",
      "hacc/idempotency_key": "a".repeat(64),
    };

    const call = client.callTool("reserve", {}, { metadata: mutableMetadata });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    mutableMetadata["hacc/invocation_id"] = "zyxwvutsrqponmlkjihgfedc";
    mutableMetadata["hacc/idempotency_key"] = "b".repeat(64);
    releaseInitialize();
    await expect(call).resolves.toMatchObject({ value: null });
    expect((toolCall!.params as Record<string, unknown>)._meta).toEqual({
      "hacc/invocation_id": "abcdefghijklmnopqrstuvwx",
      "hacc/idempotency_key": "a".repeat(64),
    });
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
