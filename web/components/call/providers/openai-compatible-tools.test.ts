import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserCapabilityGateway } from "./capability-gateway";
import { OpenAICompatibleBrowserToolLoop } from "./openai-compatible-tools";

const ORIGIN = "https://voice.example.test";
const SESSION = `hacc.v1.${"A".repeat(22)}.${"B".repeat(43)}`;
const TOKEN = `scope.${"a".repeat(96)}`;
const INITIAL_CATALOG_DIGEST = "a".repeat(64);
const ROTATION = {
  endpoint: "/api/voice/capabilities/rotate" as const,
  callId: "00000000-0000-4000-8000-000000000001",
  rotation: 0,
  renewalToken: `renewal.${"r".repeat(96)}`,
  refreshAfter: "2099-01-01T00:25:00.000Z",
  expiresAt: "2099-01-01T00:30:00.000Z",
};

function gatewayEnvelope(outcome: unknown) {
  const catalog = {
    schema_version: 1,
    availability: "active",
    runtime_digest: "e".repeat(64),
    capability_epoch: 2,
    state_revision: 2,
    scope: { status: "active", topic: "membership", step: "lookup", attempt: 1 },
    active_context: { guidance: "Continue." },
    tools: [],
  };
  return {
    schema_version: 1,
    outcome,
    active_capability_catalog: {
      ...catalog,
      catalog_digest: createHash("sha256").update(canonicalJson(catalog)).digest("hex"),
    },
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

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close = vi.fn();
}

function settle() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Waits for the exact serialized event tail captured after observe(). */
function drain(loop: OpenAICompatibleBrowserToolLoop): Promise<void> {
  return (loop as unknown as { eventTail: Promise<void> }).eventTail;
}

function harness(provider: "openai" | "xai" = "openai") {
  let rpc = 0;
  const mcpCalls: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: {},
        },
      }), { headers: { "MCP-Session-Id": SESSION } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    mcpCalls.push(body);
    const id = ((body.params as Record<string, unknown>)._meta as Record<string, unknown>)["hacc/provider_tool_call_id"];
    const targetName = String((body.params as Record<string, unknown>).name ?? "");
    const isError = targetName === "deny_action";
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify(gatewayEnvelope(isError ? { error: "denied", code: "guardrail_denied" } : { dispatched: id })),
        }],
        isError,
      },
    }));
  });
  const gateway = new BrowserCapabilityGateway({
    provider,
    url: `${ORIGIN}/api/mcp`,
    token: TOKEN,
    expectedOrigin: ORIGIN,
    fetchImpl,
    randomId: () => `rpc-${++rpc}`,
    activeCatalogDigest: INITIAL_CATALOG_DIGEST,
    activeCatalogEpoch: 1,
    activeRuntimeDigest: "e".repeat(64),
    activeStateRevision: 1,
    rotation: ROTATION,
  });
  const socket = new FakeSocket();
  const onError = vi.fn();
  const closeProtocol = vi.fn();
  const loop = new OpenAICompatibleBrowserToolLoop({
    gateway,
    sendJson: (value) => socket.send(JSON.stringify(value)),
    onError,
    closeProtocol,
  });
  return { loop, gateway, socket, onError, closeProtocol, mcpCalls };
}

function argumentsDone(overrides: Record<string, unknown> = {}) {
  return {
    type: "response.function_call_arguments.done",
    event_id: "evt-arguments",
    response_id: "response-1",
    item_id: "item-1",
    call_id: "call-1",
    name: "capability_gateway",
    arguments: JSON.stringify({
      tool_name: "renew_membership",
      arguments: { member_id: "member-42" },
    }),
    ...overrides,
  };
}

function responseDone(overrides: Record<string, unknown> = {}) {
  return {
    type: "response.done",
    event_id: "evt-terminal",
    response: {
      id: "response-1",
      status: "completed",
      output: [{
        type: "function_call",
        id: "item-1",
        call_id: "call-1",
        name: "capability_gateway",
        arguments: JSON.stringify({
          tool_name: "renew_membership",
          arguments: { member_id: "member-42" },
        }),
      }],
    },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible browser function loop", () => {
  it("does not execute pre-terminal calls, then submits the complete native batch before one continuation", async () => {
    const test = harness("xai");
    test.loop.observe(argumentsDone());
    test.loop.observe(argumentsDone({
      event_id: "evt-arguments-2",
      item_id: "item-2",
      call_id: "call-2",
      arguments: JSON.stringify({ tool_name: "get_flow_state", arguments: {} }),
    }));
    await settle();
    expect(test.mcpCalls).toHaveLength(0);
    expect(test.socket.sent).toEqual([]);

    test.loop.observe(responseDone({
      response: {
        id: "response-1",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "item-1",
            call_id: "call-1",
            name: "capability_gateway",
            arguments: JSON.stringify({
              tool_name: "renew_membership",
              arguments: { member_id: "member-42" },
            }),
          },
          {
            type: "function_call",
            id: "item-2",
            call_id: "call-2",
            name: "capability_gateway",
            arguments: JSON.stringify({ tool_name: "get_flow_state", arguments: {} }),
          },
        ],
      },
    }));
    await vi.waitFor(() => expect(test.mcpCalls).toHaveLength(2));
    await drain(test.loop);
    expect(test.socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify(gatewayEnvelope({ dispatched: "call-1" })),
        },
      },
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-2",
          output: JSON.stringify(gatewayEnvelope({ dispatched: "call-2" })),
        },
      },
      { type: "response.create" },
    ]);
    const metadata = (test.mcpCalls[0]?.params as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(metadata).toMatchObject({
      "hacc/provider_tool_call_id": "call-1",
      "com.harsha.callcenter/provider-provenance": {
        provider: "xai",
        nativeCallId: "call-1",
        nativeResponseId: "response-1",
        nativeItemId: "item-1",
        terminalEventId: "evt-terminal",
        terminalWireType: "response.done",
      },
    });
  });

  it("ignores exact terminal replay but closes on changed call identity or undeclared native functions", async () => {
    const exact = harness();
    exact.loop.observe(argumentsDone());
    exact.loop.observe(responseDone());
    await drain(exact.loop);
    exact.loop.observe(responseDone());
    await drain(exact.loop);
    expect(exact.mcpCalls).toHaveLength(1);
    expect(exact.socket.sent).toHaveLength(2);
    expect((exact.loop as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);

    const conflict = harness();
    conflict.loop.observe(argumentsDone());
    conflict.loop.observe(argumentsDone({
      arguments: JSON.stringify({ tool_name: "get_flow_state", arguments: {} }),
    }));
    await settle();
    expect(conflict.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("reused") }));
    expect(conflict.closeProtocol).toHaveBeenCalledWith(1002, "provider function protocol failed");
    expect(conflict.mcpCalls).toHaveLength(0);

    const unknown = harness();
    unknown.loop.observe(argumentsDone({ name: "renew_membership" }));
    unknown.loop.observe(responseDone({
      response: {
        id: "response-1",
        status: "completed",
        output: [{
          type: "function_call",
          id: "item-1",
          call_id: "call-1",
          name: "renew_membership",
          arguments: JSON.stringify({
            tool_name: "renew_membership",
            arguments: { member_id: "member-42" },
          }),
        }],
      },
    }));
    await settle();
    await settle();
    expect(unknown.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("undeclared") }));
    expect(unknown.socket.sent).toEqual([]);
  });

  it("rejects two native calls that claim one provider item identity", async () => {
    const test = harness();
    test.loop.observe(argumentsDone({
      event_id: "evt-item-owner-a",
      item_id: "item-one-owner",
      call_id: "call-item-owner-a",
    }));
    test.loop.observe(argumentsDone({
      event_id: "evt-item-owner-b",
      item_id: "item-one-owner",
      call_id: "call-item-owner-b",
    }));
    await drain(test.loop);
    expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("item-one-owner"),
    }));
    expect(test.closeProtocol).toHaveBeenCalledWith(1002, "provider function protocol failed");
    expect(test.mcpCalls).toHaveLength(0);
    expect((test.loop as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });

  it("discards calls from documented unsuccessful responses and rejects unknown statuses", async () => {
    const failed = harness();
    failed.loop.observe(argumentsDone());
    failed.loop.observe(responseDone({
      response: {
        id: "response-1",
        status: "failed",
        output: [{
          type: "function_call",
          id: "item-1",
          call_id: "call-1",
          name: "capability_gateway",
          arguments: JSON.stringify({
            tool_name: "renew_membership",
            arguments: { member_id: "member-42" },
          }),
        }],
      },
    }));
    await settle();
    expect(failed.mcpCalls).toHaveLength(0);
    expect(failed.socket.sent).toEqual([]);

    const unknown = harness();
    unknown.loop.observe(argumentsDone());
    unknown.loop.observe(responseDone({
      response: {
        id: "response-1",
        status: "mysterious",
        output: [{
          type: "function_call",
          id: "item-1",
          call_id: "call-1",
          name: "capability_gateway",
          arguments: JSON.stringify({
            tool_name: "renew_membership",
            arguments: { member_id: "member-42" },
          }),
        }],
      },
    }));
    await settle();
    expect(unknown.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("unknown terminal status"),
    }));
    expect(unknown.closeProtocol).toHaveBeenCalledWith(1002, "provider function protocol failed");
  });

  it("preserves successful envelopes and explicitly wraps MCP error results", async () => {
    const test = harness();
    const deniedArguments = JSON.stringify({ tool_name: "deny_action", arguments: {} });
    test.loop.observe(argumentsDone({ arguments: deniedArguments }));
    test.loop.observe(responseDone({
      response: {
        id: "response-1",
        status: "completed",
        output: [{
          type: "function_call",
          id: "item-1",
          call_id: "call-1",
          name: "capability_gateway",
          arguments: deniedArguments,
        }],
      },
    }));
    await vi.waitFor(() => expect(test.socket.sent).toHaveLength(2));
    expect(JSON.parse(test.socket.sent[0]!)).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-1",
        output: JSON.stringify({
          error: gatewayEnvelope({ error: "denied", code: "guardrail_denied" }),
        }),
      },
    });
  });

  it("fails closed on a partial provider send", async () => {

    const partial = harness();
    let sends = 0;
    partial.socket.send = (value: string) => {
      sends += 1;
      if (sends === 2) throw new Error("socket write failed");
      partial.socket.sent.push(value);
    };
    partial.loop.observe(argumentsDone());
    partial.loop.observe(argumentsDone({
      event_id: "evt-arguments-2",
      item_id: "item-2",
      call_id: "call-2",
    }));
    partial.loop.observe(responseDone({
      response: {
        id: "response-1",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "item-1",
            call_id: "call-1",
            name: "capability_gateway",
            arguments: JSON.stringify({
              tool_name: "renew_membership",
              arguments: { member_id: "member-42" },
            }),
          },
          {
            type: "function_call",
            id: "item-2",
            call_id: "call-2",
            name: "capability_gateway",
            arguments: JSON.stringify({
              tool_name: "renew_membership",
              arguments: { member_id: "member-42" },
            }),
          },
        ],
      },
    }));
    await vi.waitFor(() => expect(partial.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "socket write failed",
    })));
    expect(partial.closeProtocol).toHaveBeenCalledWith(1002, "provider function protocol failed");
    expect((partial.loop as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });
});
