import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveBuilderModelConfig,
  streamBuilderModel,
  type BuilderModelStreamEvent,
} from "../agent/builder-model";

const encoder = new TextEncoder();

function eventStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(
  stream: AsyncGenerator<BuilderModelStreamEvent>,
): Promise<BuilderModelStreamEvent[]> {
  const events: BuilderModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("builder model provider selection", () => {
  it("preserves the existing xAI model as the default", () => {
    expect(resolveBuilderModelConfig({})).toEqual({
      provider: "xai",
      model: "grok-4.20-non-reasoning",
    });
  });

  it.each([
    ["xai", "grok-custom"],
    ["openai", "gpt-custom"],
    ["gemini", "gemini-custom"],
  ] as const)("selects %s and honors the deployment model pin", (provider, model) => {
    expect(resolveBuilderModelConfig({
      HACC_BUILDER_PROVIDER: provider,
      HACC_BUILDER_MODEL: model,
    })).toEqual({ provider, model });
  });

  it("rejects unknown providers and malformed model ids", () => {
    expect(() => resolveBuilderModelConfig({
      HACC_BUILDER_PROVIDER: "arbitrary",
    })).toThrow(/must be one of/);
    expect(() => resolveBuilderModelConfig({
      HACC_BUILDER_PROVIDER: "openai",
      HACC_BUILDER_MODEL: "model id with spaces",
    })).toThrow(/valid provider model id/);
  });
});

describe("builder model compatibility stream", () => {
  it.each([
    {
      provider: "xai",
      keyName: "XAI_API_KEY",
      key: "xai-test-key",
      endpoint: "https://api.x.ai/v1/chat/completions",
    },
    {
      provider: "openai",
      keyName: "OPENAI_API_KEY",
      key: "openai-test-key",
      endpoint: "https://api.openai.com/v1/chat/completions",
    },
    {
      provider: "gemini",
      keyName: "GEMINI_API_KEY",
      key: "gemini-test-key",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    },
  ] as const)(
    "uses the server-owned $provider endpoint and credential",
    async ({ provider, keyName, key, endpoint }) => {
      const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, init });
        return new Response(eventStream([
          'data: {"choices":[{"delta":{"content":"Ready"}}]}\n\n',
          "data: [DONE]\n\n",
        ]), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const events = await collect(streamBuilderModel(
        [{ role: "user", content: "Build the flow" }],
        { model: "pinned-model" },
        {
          HACC_BUILDER_PROVIDER: provider,
          [keyName]: key,
        },
      ));

      expect(events).toEqual([
        { type: "text", delta: "Ready" },
        { type: "done" },
      ]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requests[0]!.input).toBe(endpoint);
      expect((requests[0]!.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${key}`);
      const body = JSON.parse(String(requests[0]!.init?.body));
      expect(body).toMatchObject({
        model: "pinned-model",
        messages: [{ role: "user", content: "Build the flow" }],
        stream: true,
      });
    },
  );

  it("assembles split text and tool-call deltas into one provider-neutral result", async () => {
    const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(eventStream([
        'data: {"choices":[{"delta":{"content":"I will inspect it. "}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"show_","arguments":"{\\"id\\":"}}]}}]}\n',
        '\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"flow","arguments":"\\"flow-1\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(streamBuilderModel(
      [{ role: "user", content: "Show the flow" }],
      {
        tools: [{
          type: "function",
          function: {
            name: "show_flow",
            description: "Show a flow",
            parameters: { type: "object" },
          },
        }],
      },
      { HACC_BUILDER_PROVIDER: "openai", OPENAI_API_KEY: "test-key" },
    ));

    expect(events).toEqual([
      { type: "text", delta: "I will inspect it. " },
      {
        type: "tool_calls",
        calls: [{
          id: "call_1",
          name: "show_flow",
          arguments: '{"id":"flow-1"}',
        }],
      },
      { type: "done" },
    ]);
    const body = JSON.parse(String(requests[0]!.init?.body));
    expect(body.tool_choice).toBe("auto");
    expect(body.tools[0].function.name).toBe("show_flow");
  });

  it("fails before network I/O when the selected provider key is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect(streamBuilderModel(
      [{ role: "user", content: "Build" }],
      {},
      { HACC_BUILDER_PROVIDER: "gemini" },
    ))).rejects.toThrow(
      "GEMINI_API_KEY is required when HACC_BUILDER_PROVIDER=gemini",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not reflect a provider error body into application errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "secret prompt and provider details",
      { status: 429, headers: { "x-request-id": "safe-request-id" } },
    )));

    await expect(collect(streamBuilderModel(
      [{ role: "user", content: "private prompt" }],
      {},
      { HACC_BUILDER_PROVIDER: "openai", OPENAI_API_KEY: "test-key" },
    ))).rejects.toThrow(
      "builder model request failed for openai (429) [request safe-request-id]",
    );
  });

  it("rejects incomplete provider tool calls instead of entering the dispatch loop", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(eventStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]), { status: 200 })));

    await expect(collect(streamBuilderModel(
      [{ role: "user", content: "Run something" }],
      {},
      { HACC_BUILDER_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" },
    ))).rejects.toThrow("builder model returned an incomplete tool call");
  });
});
