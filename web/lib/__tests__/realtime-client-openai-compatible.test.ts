import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { base64ToPcm16, chunkPcm16, pcm16DurationMs, pcm16ToBase64 } from "../realtime/client/audio";
import {
  OpenAICompatibleEventNormalizer,
  normalizeOpenAICompatibleUsage,
  safeParseWireEvent,
} from "../realtime/client/events";
import {
  OpenAICompatibleRealtimeClient,
  XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR,
  XAI_FUNCTION_TOOL_ALIAS_POLICY_SHA256,
  buildSessionConfigurationAcknowledgement,
  createOpenAIRealtimeClient,
  createXaiRealtimeClient,
  realtimeToolFrontierSha256,
  validateManualPcmSessionAcknowledgement,
  withManualPcmSession,
} from "../realtime/client/openai-compatible";
import { verifyRealtimeWireObservationChain } from "../realtime/client/wire-evidence";
import { assertRealtimeTransportFailureDiagnostic } from "../realtime/client/transport-diagnostics";
import { LC4_DEV_TIMEOUT_CONTRACT } from "../benchmark/lc4-development-timeout-contract";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
} from "../realtime/client/types";
import type {
  NormalizedRealtimeEvent,
  RealtimeWebSocket,
  RealtimeWebSocketFactory,
  RealtimeWireObservation,
} from "../realtime/client/types";

const PCM = { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 } as const;
const baseSession = {
  type: "session.update",
  session: {
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        transcription: { model: "transcriber" },
        turn_detection: { type: "server_vad" },
      },
      output: { format: { type: "audio/pcmu" }, voice: "marin" },
    },
    turn_detection: { type: null },
  },
};

const localProxySession = {
  ...baseSession,
  session: {
    ...baseSession.session,
    tools: [LOCAL_TOOL_PROXY_FUNCTION],
  },
};

class FakeSocket implements RealtimeWebSocket {
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;
  onSend: ((data: string) => void) | null = null;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string) {
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }

  terminate() {
    this.terminated = true;
  }

  on(event: "open" | "message" | "error" | "close", listener: (...args: never[]) => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, listeners);
  }

  emit(event: "open" | "message" | "error" | "close", ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function fakeClient(
  provider: "openai" | "xai" = "openai",
  overrides: Partial<ConstructorParameters<typeof OpenAICompatibleRealtimeClient>[0]> = {},
) {
  const socket = new FakeSocket();
  let factoryArgs: Parameters<RealtimeWebSocketFactory> | undefined;
  const factory: RealtimeWebSocketFactory = (...args) => {
    factoryArgs = args;
    return socket;
  };
  const client = new OpenAICompatibleRealtimeClient({
    provider,
    url: `wss://${provider}.example/realtime`,
    headers: { Authorization: "Bearer redacted" },
    sessionUpdate: baseSession,
    socketFactory: factory,
    connectTimeoutMs: 1_000,
    ...overrides,
  });
  return { client, socket, factoryArgs: () => factoryArgs };
}

async function connect(client: OpenAICompatibleRealtimeClient, socket: FakeSocket) {
  const connected = client.connect();
  socket.emit("open");
  if (client.provider === "xai") {
    socket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_1" },
    }));
  }
  socket.emit("message", JSON.stringify(sessionAcknowledgement(client.provider)));
  await connected;
}

function sessionAcknowledgement(
  provider: "openai" | "xai",
  rate = 24_000,
  resumption = false,
) {
  return {
    type: "session.updated",
    session: {
      id: "sess_1",
      ...(provider === "xai" ? { turn_detection: { type: null } } : {}),
      ...(resumption ? { resumption: { enabled: true } } : {}),
      audio: {
        input: {
          format: { type: "audio/pcm", rate },
          ...(provider === "openai" ? { turn_detection: null } : {}),
        },
        output: { format: { type: "audio/pcm", rate } },
      },
    },
  };
}

function recordForTest(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected test fixture object");
  }
  return value as Record<string, unknown>;
}

function terminalToolOutput(callId: string, name: string, argumentsText = "{}", itemId = `item_${callId}`) {
  return {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsText,
    status: "completed",
  };
}

function deliverToolBatch(
  socket: FakeSocket,
  calls: Array<{ callId: string; name: string }>,
  responseId = "r_tools",
) {
  for (const call of calls) {
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: responseId,
      call_id: call.callId,
      name: call.name,
      arguments: "{}",
    }));
  }
  socket.emit("message", JSON.stringify({
    type: "response.done",
    response: {
      id: responseId,
      status: "completed",
      output: calls.map((call) => terminalToolOutput(call.callId, call.name)),
    },
  }));
}

async function acknowledgeHistoryItems(
  socket: FakeSocket,
  expectedCount: number,
  wireType: "conversation.item.added" | "conversation.item.created" = "conversation.item.added",
) {
  for (let index = 0; index < expectedCount; index += 1) {
    await vi.waitFor(() => {
      expect(socket.sent.map((value) => JSON.parse(value)).filter((event) => (
        event.type === "conversation.item.create"
      ))).toHaveLength(index + 1);
    });
    const created = socket.sent.map((value) => JSON.parse(value)).filter((event) => (
      event.type === "conversation.item.create"
    ))[index] as { item: Record<string, unknown> };
    socket.emit("message", JSON.stringify({
      type: wireType,
      item: created.item,
    }));
  }
}

describe("PCM realtime audio", () => {
  it("round-trips exact signed PCM16 bytes and computes duration", () => {
    const audio = { ...PCM, data: Uint8Array.from([0, 128, 255, 127]) };
    const encoded = pcm16ToBase64(audio);
    expect(encoded).toBe("AID/fw==");
    expect(base64ToPcm16(encoded)).toEqual(audio.data);
    expect(pcm16DurationMs(audio)).toBeCloseTo(2 / 24_000 * 1_000);
  });

  it("rejects non-canonical base64 and partial PCM samples", () => {
    expect(() => base64ToPcm16("not base64" )).toThrow(/canonical base64/);
    expect(() => base64ToPcm16("AQ==")).toThrow(/partial PCM16 sample/);
  });

  it("chunks only on complete sample boundaries", () => {
    const audio = { ...PCM, data: new Uint8Array(2_400) };
    const chunks = chunkPcm16(audio, 10);
    expect(chunks).toHaveLength(5);
    expect(chunks.map((chunk) => chunk.data.byteLength)).toEqual([480, 480, 480, 480, 480]);
  });
});

describe("provider-neutral conversation history hydration", () => {
  const sourceSha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const canonicalJsonForHistory = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJsonForHistory).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonForHistory(object[key])}`
    )).join(",")}}`;
  };

  it.each(["openai", "xai"] as const)(
    "hydrates exact ordered user, assistant, and synthetic tool history on %s without generation",
    async (provider) => {
      const { client, socket } = fakeClient(provider, { sessionUpdate: localProxySession });
      const observations: RealtimeWireObservation[] = [];
      const normalizedEvents: NormalizedRealtimeEvent[] = [];
      client.onWireObservation((observation) => observations.push(observation));
      client.onEvent((event) => normalizedEvents.push(event));
      await connect(client, socket);
      const largeToolOutput = `result:${"z".repeat(9_180)}`;
      expect(Buffer.byteLength(largeToolOutput, "utf8")).toBe(9_187);
      const turns = [
        {
          role: "user" as const,
          text: "Please check the exact membership record.",
          sourceSha256: sourceSha256("caller-audio-1"),
        },
        {
          role: "assistant" as const,
          text: "I will inspect the membership record now.",
          sourceSha256: sourceSha256("assistant-audio-1"),
        },
        {
          role: "tool" as const,
          toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
          toolArguments: {
            tool_name: "membership.lookup",
            arguments: { memberId: "m_17", includeExpiry: true },
          },
          output: largeToolOutput,
          sourceSha256: sourceSha256("tool-receipt-1"),
        },
        {
          role: "assistant" as const,
          text: "The verified record is available.",
          sourceSha256: sourceSha256("assistant-audio-2"),
        },
      ];
      const pending = client.hydrateConversationHistory(turns);
      await acknowledgeHistoryItems(socket, 5);
      const receipt = await pending;

      const sent = socket.sent.map((value) => JSON.parse(value));
      const historyFrames = sent.filter((event) => event.type === "conversation.item.create");
      expect(historyFrames).toHaveLength(5);
      expect(historyFrames.map((event) => event.item.type)).toEqual([
        "message",
        "message",
        "function_call",
        "function_call_output",
        "message",
      ]);
      for (const [index, frame] of historyFrames.entries()) {
        expect(frame.item.id).toMatch(
          new RegExp(`^item_hacc_${String(index + 1).padStart(4, "0")}_[a-f0-9]{17}$`),
        );
        expect(Buffer.byteLength(frame.item.id, "utf8")).toBe(32);
      }
      expect(new Set(historyFrames.map((frame) => frame.item.id)).size).toBe(historyFrames.length);
      expect(historyFrames[0].item).toMatchObject({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: turns[0].text }],
      });
      expect(historyFrames[1].item).toMatchObject({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: turns[1].text }],
      });
      expect(historyFrames[2].item).toMatchObject({
        type: "function_call",
        name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        arguments: "{\"arguments\":{\"includeExpiry\":true,\"memberId\":\"m_17\"},\"tool_name\":\"membership.lookup\"}",
      });
      expect(historyFrames[2].item.call_id).toMatch(/^call_hacc_0003_001_[a-f0-9]{13}$/);
      expect(Buffer.byteLength(historyFrames[2].item.call_id, "utf8")).toBe(32);
      expect(historyFrames[3].item).toEqual(expect.objectContaining({
        type: "function_call_output",
        call_id: historyFrames[2].item.call_id,
        output: largeToolOutput,
      }));
      expect(sent.some((event) => event.type === "response.create")).toBe(false);
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        provider,
        connectionEpoch: 1,
        status: "acknowledged",
        turnCount: 4,
        providerItemCount: 5,
        historySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        items: [
          { providerItemOrdinal: 1, historyTurnOrdinal: 1, kind: "user_message" },
          { providerItemOrdinal: 2, historyTurnOrdinal: 2, kind: "assistant_message" },
          {
            providerItemOrdinal: 3,
            historyTurnOrdinal: 3,
            kind: "synthetic_tool_call",
            syntheticCallIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          {
            providerItemOrdinal: 4,
            historyTurnOrdinal: 3,
            kind: "synthetic_tool_output",
            syntheticCallIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          { providerItemOrdinal: 5, historyTurnOrdinal: 4, kind: "assistant_message" },
        ],
      });
      for (const item of receipt.items) {
        expect(item.outboundObservation).toMatchObject({
          availability: "observed",
          observationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(item.inboundObservation).toMatchObject({
          availability: "observed",
          observationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      }
      const historyObservations = observations.filter((observation) => (
        recordForTest(observation.projection).conversationHistoryItem !== undefined
      ));
      expect(historyObservations).toHaveLength(10);
      expect(historyObservations.every((observation) => (
        recordForTest(observation.projection).gatewayCalls === undefined
        && recordForTest(observation.projection).gatewayResults === undefined
      ))).toBe(true);
      expect(historyObservations.map((observation) => (
        recordForTest(recordForTest(observation.projection).conversationHistoryItem).kind
      ))).toEqual([
        "user_message", "user_message",
        "assistant_message", "assistant_message",
        "synthetic_tool_call", "synthetic_tool_call",
        "synthetic_tool_output", "synthetic_tool_output",
        "assistant_message", "assistant_message",
      ]);
      expect(verifyRealtimeWireObservationChain(observations)).toMatchObject({ valid: true });
      const serializedEvidence = JSON.stringify(observations);
      expect(serializedEvidence).not.toContain(turns[0].text);
      expect(serializedEvidence).not.toContain(largeToolOutput);
      for (const turn of turns) {
        expect(JSON.stringify(historyFrames)).not.toContain(turn.sourceSha256);
      }
      if (provider === "xai") {
        client.close();
        expect(normalizedEvents.findLast((event) => (
          event.type === "usage" && event.scope === "session"
        ))).toMatchObject({
          type: "usage",
          usage: { billableTextInputEvents: 4 },
        });
      }
    },
  );

  it("keeps all 1,024 legal provider history item IDs unique and exactly 32 bytes", async () => {
    const { client, socket } = fakeClient("openai", { sessionUpdate: localProxySession });
    await connect(client, socket);
    socket.onSend = (data) => {
      const event = JSON.parse(data) as { type?: string; item?: Record<string, unknown> };
      if (event.type !== "conversation.item.create" || event.item === undefined) return;
      queueMicrotask(() => {
        socket.emit("message", JSON.stringify({
          type: "conversation.item.added",
          item: event.item,
        }));
      });
    };
    const turns = Array.from({ length: 512 }, (_, index) => ({
      role: "tool" as const,
      toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      toolArguments: {
        tool_name: "membership.lookup",
        arguments: { ordinal: index + 1 },
      },
      output: `result-${index + 1}`,
      sourceSha256: sourceSha256(`maximum-history-tool-${index + 1}`),
    }));

    const receipt = await client.hydrateConversationHistory(turns);
    const historyFrames = socket.sent
      .map((value) => JSON.parse(value))
      .filter((event) => event.type === "conversation.item.create");
    const itemIds = historyFrames.map((frame) => String(frame.item.id));

    expect(receipt.providerItemCount).toBe(1_024);
    expect(historyFrames).toHaveLength(1_024);
    expect(new Set(itemIds).size).toBe(1_024);
    expect(itemIds.every((itemId) => Buffer.byteLength(itemId, "utf8") === 32)).toBe(true);
    expect(itemIds[0]).toMatch(/^item_hacc_0001_[a-f0-9]{17}$/);
    expect(itemIds.at(-1)).toMatch(/^item_hacc_1024_[a-f0-9]{17}$/);
    const callIds = historyFrames
      .filter((frame) => frame.item.type === "function_call")
      .map((frame) => String(frame.item.call_id));
    expect(callIds).toHaveLength(512);
    expect(new Set(callIds).size).toBe(512);
    expect(callIds.every((callId) => Buffer.byteLength(callId, "utf8") === 32)).toBe(true);
    expect(callIds[0]).toMatch(/^call_hacc_0001_001_[a-f0-9]{13}$/);
    expect(callIds.at(-1)).toMatch(/^call_hacc_0512_001_[a-f0-9]{13}$/);
    expect(socket.sent.some((value) => JSON.parse(value).type === "response.create")).toBe(false);
  });

  it("rejects 1,025 provider history items before sending any history frame", async () => {
    const { client, socket } = fakeClient("openai", { sessionUpdate: localProxySession });
    await connect(client, socket);
    const singleCallTurns = Array.from({ length: 510 }, (_, index) => ({
      role: "tool" as const,
      toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      toolArguments: { tool_name: "membership.lookup", arguments: { ordinal: index + 1 } },
      output: `result-${index + 1}`,
      sourceSha256: sourceSha256(`overflow-history-tool-${index + 1}`),
    }));
    const twoCallBatch = {
      role: "tool_batch" as const,
      calls: [1, 2].map((ordinal) => ({
        toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        toolArguments: { tool_name: "membership.lookup", arguments: { ordinal } },
        output: `batch-result-${ordinal}`,
        sourceSha256: sourceSha256(`overflow-history-batch-${ordinal}`),
      })),
    };
    const finalMessage = {
      role: "user" as const,
      text: "This would be provider item 1,025.",
      sourceSha256: sourceSha256("overflow-history-message"),
    };

    await expect(client.hydrateConversationHistory([
      ...singleCallTurns,
      twoCallBatch,
      finalMessage,
    ])).rejects.toThrow("Conversation history exceeds 1024 provider items");
    expect(socket.sent.map((value) => JSON.parse(value)).filter((event) => (
      event.type === "conversation.item.create"
    ))).toHaveLength(0);
  });

  it.each(["openai", "xai"] as const)(
    "hydrates a canonical two-call tool batch on %s as all calls followed by all outputs",
    async (provider) => {
      const multiToolSession = {
        ...baseSession,
        session: {
          ...baseSession.session,
          tools: [
            { type: "function", name: "records.lookup", parameters: { type: "object" } },
            { type: "function", name: "rates.quote", parameters: { type: "object" } },
          ],
        },
      };
      const { client, socket } = fakeClient(provider, { sessionUpdate: multiToolSession });
      const events: NormalizedRealtimeEvent[] = [];
      client.onEvent((event) => events.push(event));
      await connect(client, socket);
      const firstSource = sourceSha256("batch-call-one");
      const secondSource = sourceSha256("batch-call-two");
      const calls = [
        {
          toolName: "records.lookup",
          toolArguments: { include_history: true, member_id: "m_17" },
          output: "{\"member\":\"active\"}",
          sourceSha256: firstSource,
        },
        {
          toolName: "rates.quote",
          toolArguments: { plan: "annual", seats: 3 },
          output: "{\"currency\":\"USD\",\"total\":420}",
          sourceSha256: secondSource,
        },
      ] as const;
      const pending = client.hydrateConversationHistory([{
        role: "tool_batch",
        calls,
      }]);
      await acknowledgeHistoryItems(
        socket,
        4,
        provider === "openai" ? "conversation.item.created" : "conversation.item.added",
      );
      const receipt = await pending;
      const frames = socket.sent.map((value) => JSON.parse(value)).filter((event) => (
        event.type === "conversation.item.create"
      ));
      expect(frames.map((frame) => frame.item.type)).toEqual([
        "function_call",
        "function_call",
        "function_call_output",
        "function_call_output",
      ]);
      expect(frames[0].item).toMatchObject({
        name: "records.lookup",
        arguments: "{\"include_history\":true,\"member_id\":\"m_17\"}",
      });
      expect(frames[1].item).toMatchObject({
        name: "rates.quote",
        arguments: "{\"plan\":\"annual\",\"seats\":3}",
      });
      expect(frames[0].item.call_id).toMatch(/^call_hacc_0001_001_[a-f0-9]{13}$/);
      expect(frames[1].item.call_id).toMatch(/^call_hacc_0001_002_[a-f0-9]{13}$/);
      expect(Buffer.byteLength(frames[0].item.call_id, "utf8")).toBe(32);
      expect(Buffer.byteLength(frames[1].item.call_id, "utf8")).toBe(32);
      expect(frames[2].item).toMatchObject({
        call_id: frames[0].item.call_id,
        output: calls[0].output,
      });
      expect(frames[3].item).toMatchObject({
        call_id: frames[1].item.call_id,
        output: calls[1].output,
      });
      const visible = [{
        role: "tool_batch",
        calls: calls.map((call) => ({
          toolName: call.toolName,
          toolArguments: call.toolArguments,
          output: call.output,
        })),
      }];
      const expectedHistorySha256 = createHash("sha256")
        .update("harshas-amazing-call-center/realtime-conversation-history/provider-visible/v2\n")
        .update(canonicalJsonForHistory(visible))
        .digest("hex");
      const expectedSourceBindingSha256 = createHash("sha256")
        .update("harshas-amazing-call-center/realtime-conversation-history/source-binding/v2\n")
        .update(canonicalJsonForHistory({
          historySha256: expectedHistorySha256,
          sources: [{
            ordinal: 1,
            role: "tool_batch",
            calls: [
              { callOrdinal: 1, sourceSha256: firstSource },
              { callOrdinal: 2, sourceSha256: secondSource },
            ],
          }],
        }))
        .digest("hex");
      expect(receipt).toMatchObject({
        status: "acknowledged",
        turnCount: 1,
        providerItemCount: 4,
        historySha256: expectedHistorySha256,
        sourceBindingSha256: expectedSourceBindingSha256,
        items: [
          {
            historyTurnOrdinal: 1,
            providerItemOrdinal: 1,
            kind: "synthetic_tool_call",
            sourceSha256: firstSource,
          },
          {
            historyTurnOrdinal: 1,
            providerItemOrdinal: 2,
            kind: "synthetic_tool_call",
            sourceSha256: secondSource,
          },
          {
            historyTurnOrdinal: 1,
            providerItemOrdinal: 3,
            kind: "synthetic_tool_output",
            sourceSha256: firstSource,
          },
          {
            historyTurnOrdinal: 1,
            providerItemOrdinal: 4,
            kind: "synthetic_tool_output",
            sourceSha256: secondSource,
          },
        ],
      });
      expect(socket.sent.some((value) => JSON.parse(value).type === "response.create")).toBe(false);
      if (provider === "xai") {
        client.close();
        expect(events.findLast((event) => (
          event.type === "usage" && event.scope === "session"
        ))).toMatchObject({ type: "usage", usage: { billableTextInputEvents: 2 } });
      }
    },
  );

  it("normalizes singleton tool sugar to the identical canonical one-call batch", async () => {
    const singleton = fakeClient("openai", { sessionUpdate: localProxySession });
    const canonical = fakeClient("openai", { sessionUpdate: localProxySession });
    await connect(singleton.client, singleton.socket);
    await connect(canonical.client, canonical.socket);
    const call = {
      toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      toolArguments: { tool_name: "membership.lookup", arguments: { member_id: "m_17" } },
      output: "{\"status\":\"active\"}",
      sourceSha256: sourceSha256("singleton-normalization-source"),
    } as const;
    const singletonPending = singleton.client.hydrateConversationHistory([{
      role: "tool",
      ...call,
    }]);
    const canonicalPending = canonical.client.hydrateConversationHistory([{
      role: "tool_batch",
      calls: [call],
    }]);
    await Promise.all([
      acknowledgeHistoryItems(singleton.socket, 2),
      acknowledgeHistoryItems(canonical.socket, 2),
    ]);
    const [singletonReceipt, canonicalReceipt] = await Promise.all([
      singletonPending,
      canonicalPending,
    ]);
    expect(singletonReceipt.historySha256).toBe(canonicalReceipt.historySha256);
    expect(singletonReceipt.sourceBindingSha256).toBe(canonicalReceipt.sourceBindingSha256);
    expect(singletonReceipt.providerItemCount).toBe(2);
    expect(singleton.socket.sent.map((value) => JSON.parse(value)).filter((event) => (
      event.type === "conversation.item.create"
    ))).toEqual(canonical.socket.sent.map((value) => JSON.parse(value)).filter((event) => (
      event.type === "conversation.item.create"
    )));
  });

  it("hydrates more than 48 chronological turns with one acknowledgement barrier per item", async () => {
    const { client, socket } = fakeClient("openai");
    await connect(client, socket);
    const turns = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `${index % 2 === 0 ? "caller" : "assistant"} history turn ${index + 1}`,
      sourceSha256: sourceSha256(`history-source-${index + 1}`),
    }));
    const pending = client.hydrateConversationHistory(turns);
    await acknowledgeHistoryItems(socket, 60);
    await expect(pending).resolves.toMatchObject({
      status: "acknowledged",
      turnCount: 60,
      providerItemCount: 60,
    });
    expect(socket.sent.map((value) => JSON.parse(value)).filter((event) => (
      event.type === "conversation.item.create"
    ))).toHaveLength(60);
    expect(socket.sent.some((value) => JSON.parse(value).type === "response.create")).toBe(false);
  });

  it("keeps provider-visible history identity independent from host source bindings", async () => {
    const openai = fakeClient("openai");
    const xai = fakeClient("xai");
    await connect(openai.client, openai.socket);
    await connect(xai.client, xai.socket);
    const visible = {
      role: "assistant" as const,
      text: "The same exact audible assistant history.",
    };
    const openaiPending = openai.client.hydrateConversationHistory([{
      ...visible,
      sourceSha256: sourceSha256("openai-capture-receipt"),
    }]);
    const xaiPending = xai.client.hydrateConversationHistory([{
      ...visible,
      sourceSha256: sourceSha256("xai-capture-receipt"),
    }]);
    await Promise.all([
      acknowledgeHistoryItems(openai.socket, 1, "conversation.item.created"),
      acknowledgeHistoryItems(xai.socket, 1, "conversation.item.added"),
    ]);
    const [openaiReceipt, xaiReceipt] = await Promise.all([openaiPending, xaiPending]);
    expect(openaiReceipt.historySha256).toBe(xaiReceipt.historySha256);
    expect(openaiReceipt.sourceBindingSha256).not.toBe(xaiReceipt.sourceBindingSha256);
    const openaiItem = JSON.parse(openai.socket.sent.at(-1)!).item;
    const xaiItem = JSON.parse(xai.socket.sent.at(-1)!).item;
    expect(openaiItem).toEqual(xaiItem);
  });

  it("accepts a matching GA item.done lifecycle event without treating it as generation", async () => {
    const { client, socket } = fakeClient("openai");
    await connect(client, socket);
    const pending = client.hydrateConversationHistory([{
      role: "assistant",
      text: "completed historical assistant item",
      sourceSha256: sourceSha256("done-history-source"),
    }]);
    await acknowledgeHistoryItems(socket, 1, "conversation.item.added");
    const created = JSON.parse(socket.sent.at(-1)!) as { item: Record<string, unknown> };
    socket.emit("message", JSON.stringify({
      type: "conversation.item.done",
      item: created.item,
    }));
    await expect(pending).resolves.toMatchObject({ status: "acknowledged" });
    expect(client.state).toBe("ready");
    expect(socket.sent.some((value) => JSON.parse(value).type === "response.create")).toBe(false);
  });

  it("accepts a late item.done for the prior item while the next history item is pending", async () => {
    const { client, socket } = fakeClient("openai", { sessionUpdate: localProxySession });
    await connect(client, socket);
    const pending = client.hydrateConversationHistory([
      {
        role: "user",
        text: "Please check the historical record.",
        sourceSha256: sourceSha256("late-done-user"),
      },
      {
        role: "tool",
        toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        toolArguments: { tool_name: "records.lookup", arguments: { id: "m_17" } },
        output: "{\"status\":\"active\"}",
        sourceSha256: sourceSha256("late-done-tool"),
      },
    ]);

    await vi.waitFor(() => {
      expect(socket.sent.map((value) => JSON.parse(value)).filter((event) => (
        event.type === "conversation.item.create"
      ))).toHaveLength(1);
    });
    const first = socket.sent.map((value) => JSON.parse(value)).find((event) => (
      event.type === "conversation.item.create"
    )) as { item: Record<string, unknown> };
    socket.emit("message", JSON.stringify({
      type: "conversation.item.added",
      item: first.item,
    }));

    await vi.waitFor(() => {
      expect(socket.sent.map((value) => JSON.parse(value)).filter((event) => (
        event.type === "conversation.item.create"
      ))).toHaveLength(2);
    });
    socket.emit("message", JSON.stringify({
      type: "conversation.item.done",
      item: first.item,
    }));
    let frames = socket.sent.map((value) => JSON.parse(value)).filter((event) => (
      event.type === "conversation.item.create"
    )) as Array<{ item: Record<string, unknown> }>;
    socket.emit("message", JSON.stringify({
      type: "conversation.item.added",
      item: frames[1].item,
    }));
    await vi.waitFor(() => {
      expect(socket.sent.map((value) => JSON.parse(value)).filter((event) => (
        event.type === "conversation.item.create"
      ))).toHaveLength(3);
    });
    frames = socket.sent.map((value) => JSON.parse(value)).filter((event) => (
      event.type === "conversation.item.create"
    )) as Array<{ item: Record<string, unknown> }>;
    socket.emit("message", JSON.stringify({
      type: "conversation.item.added",
      item: frames[2].item,
    }));
    await expect(pending).resolves.toMatchObject({
      status: "acknowledged",
      providerItemCount: 3,
    });
    expect(client.state).toBe("ready");
    expect(socket.sent.some((value) => JSON.parse(value).type === "response.create")).toBe(false);
  });

  it("validates an entire history batch before sending and rejects oversized content", async () => {
    const { client, socket } = fakeClient("openai");
    await connect(client, socket);
    socket.sent.length = 0;
    await expect(client.hydrateConversationHistory([
      {
        role: "user",
        text: "valid first turn",
        sourceSha256: sourceSha256("valid-source"),
      },
      {
        role: "tool",
        toolName: "records.lookup",
        toolArguments: {},
        output: "x".repeat(64 * 1_024 + 1),
        sourceSha256: sourceSha256("oversized-source"),
      },
    ])).rejects.toThrow(/output is .* UTF-8 bytes/);
    expect(socket.sent).toEqual([]);
    expect(client.state).toBe("ready");
    await expect(client.hydrateConversationHistory([{
      role: "user",
      text: "boxed hashes are not primitive evidence",
      sourceSha256: new String(sourceSha256("boxed-source")) as unknown as string,
    }])).rejects.toThrow(/sourceSha256 is invalid/);
    expect(socket.sent).toEqual([]);
  });

  it("rejects empty, oversized, and undeclared tool batches before any wire item", async () => {
    const declaredSession = {
      ...baseSession,
      session: {
        ...baseSession.session,
        tools: [{ type: "function", name: "records.lookup", parameters: { type: "object" } }],
      },
    };
    const { client, socket } = fakeClient("openai", { sessionUpdate: declaredSession });
    await connect(client, socket);
    socket.sent.length = 0;

    await expect(client.hydrateConversationHistory([{
      role: "tool_batch",
      calls: [],
    }])).rejects.toThrow(/tool batch must be non-empty/);
    expect(socket.sent).toEqual([]);

    const oversizedCalls = Array.from({ length: 5 }, (_, index) => ({
      toolName: "records.lookup",
      toolArguments: { ordinal: index + 1 },
      output: "x".repeat(60 * 1_024),
      sourceSha256: sourceSha256(`oversized-batch-source-${index + 1}`),
    }));
    await expect(client.hydrateConversationHistory([{
      role: "tool_batch",
      calls: oversizedCalls,
    }])).rejects.toThrow(/tool batch is .* UTF-8 bytes/);
    expect(socket.sent).toEqual([]);

    await expect(client.hydrateConversationHistory([{
      role: "tool_batch",
      calls: [
        {
          toolName: "records.lookup",
          toolArguments: { member_id: "m_17" },
          output: "{\"status\":\"active\"}",
          sourceSha256: sourceSha256("declared-batch-source"),
        },
        {
          toolName: "billing.charge",
          toolArguments: { amount: 420 },
          output: "{\"charged\":true}",
          sourceSha256: sourceSha256("undeclared-batch-source"),
        },
      ],
    }])).rejects.toThrow(/tool billing\.charge is not declared/);
    expect(socket.sent).toEqual([]);
    expect(client.state).toBe("ready");
  });

  it("rejects wrong-state, mid-turn, concurrent, and repeated hydration", async () => {
    const turn = [{
      role: "user" as const,
      text: "one historical caller turn",
      sourceSha256: sourceSha256("one-history-source"),
    }];
    const idle = fakeClient("openai");
    await expect(idle.client.hydrateConversationHistory(turn)).rejects.toThrow(/requires a ready/);
    expect(idle.socket.sent).toEqual([]);

    const active = fakeClient("openai");
    await connect(active.client, active.socket);
    active.client.sendTextTurn("live caller turn", false);
    await expect(active.client.hydrateConversationHistory(turn)).rejects.toThrow(/before the first live/);

    const once = fakeClient("xai");
    await connect(once.client, once.socket);
    const reentrantErrors: string[] = [];
    once.client.onWireObservation((observation) => {
      if (
        observation.direction !== "outbound"
        || observation.wireType !== "conversation.item.create"
      ) return;
      try {
        once.client.sendTextTurn("observer must not interleave", false);
      } catch (error) {
        reentrantErrors.push(error instanceof Error ? error.message : String(error));
      }
    });
    const pending = once.client.hydrateConversationHistory(turn);
    expect(reentrantErrors).toEqual([
      expect.stringMatching(/cannot interleave conversation history hydration/),
    ]);
    const sentDuringHydration = once.socket.sent.length;
    expect(() => once.client.sendTextTurn("must not interleave", false))
      .toThrow(/cannot interleave conversation history hydration/);
    expect(once.socket.sent).toHaveLength(sentDuringHydration);
    await expect(once.client.hydrateConversationHistory(turn)).rejects.toThrow(/exactly once/);
    await acknowledgeHistoryItems(once.socket, 1);
    await expect(pending).resolves.toMatchObject({ status: "acknowledged" });
    await expect(once.client.hydrateConversationHistory(turn)).rejects.toThrow(/exactly once/);
  });

  it("fails closed if a provider starts generation while history acknowledgement is pending", async () => {
    const { client, socket } = fakeClient("openai");
    await connect(client, socket);
    const pending = client.hydrateConversationHistory([{
      role: "user",
      text: "historical caller content",
      sourceSha256: sourceSha256("interleaved-provider-source"),
    }]);
    socket.emit("message", JSON.stringify({
      type: "response.created",
      response: { id: "unrequested-response", status: "in_progress" },
    }));
    await expect(pending).rejects.toThrow(/Provider emitted response.created/);
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
  });

  it("retains a sanitized provider rejection instead of misclassifying it as interleaving", async () => {
    const { client, socket } = fakeClient("openai");
    const events: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => events.push(event));
    await connect(client, socket);
    const pending = client.hydrateConversationHistory([{
      role: "user",
      text: "history the provider will reject",
      sourceSha256: sourceSha256("provider-rejection-source"),
    }]);
    socket.emit("message", JSON.stringify({
      type: "error",
      error: {
        code: "invalid_request_error",
        message: "private provider rejection account@example.test secret-marker",
      },
    }));
    await expect(pending).rejects.toThrow(/Provider rejected conversation history item 1/);
    expect(client.state).toBe("failed");
    const failure = events.findLast((event) => event.type === "error");
    expect(failure).toMatchObject({
      type: "error",
      code: "conversation_history_provider_rejected",
      fatal: true,
      transportDiagnostic: {
        origin: "provider_wire",
        category: "provider_request",
        safeRawCode: "invalid_request_error",
        messageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(failure)).not.toContain("account@example.test");
    expect(JSON.stringify(failure)).not.toContain("secret-marker");
  });

  it("keeps xAI provider resumption mutually exclusive with manual history hydration", async () => {
    const historicalTurn = [{
      role: "user" as const,
      text: "must not be appended over resumed provider history",
      sourceSha256: sourceSha256("resumed-history-source"),
    }];
    const resumedFirst = fakeClient("xai", {
      url: "wss://xai.example/realtime?conversation_id=conv_prior",
    });
    await connect(resumedFirst.client, resumedFirst.socket);
    resumedFirst.socket.emit("message", JSON.stringify({
      type: "conversation.item.added",
      item: {
        id: "provider_replayed_item",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "provider replay" }],
      },
    }));
    await expect(resumedFirst.client.hydrateConversationHistory(historicalTurn))
      .rejects.toThrow(/cannot be combined with xAI conversation resumption/);

    const hydrationFirst = fakeClient("xai", {
      url: "wss://xai.example/realtime?conversation_id=conv_prior",
    });
    await connect(hydrationFirst.client, hydrationFirst.socket);
    await expect(hydrationFirst.client.hydrateConversationHistory(historicalTurn))
      .rejects.toThrow(/cannot be combined with xAI conversation resumption/);
    hydrationFirst.socket.emit("message", JSON.stringify({
      type: "conversation.item.added",
      item: {
        id: "provider_replayed_item",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "provider replay" }],
      },
    }));
    expect(hydrationFirst.client.state).toBe("ready");
    expect(hydrationFirst.socket.sent.map((value) => JSON.parse(value)).filter((event) => (
      event.type === "conversation.item.create"
    ))).toEqual([]);
  });

  it("records xAI identity-only tool acknowledgements without treating omitted content as echoed", async () => {
    const { client, socket } = fakeClient("xai", { sessionUpdate: localProxySession });
    const observations: RealtimeWireObservation[] = [];
    client.onWireObservation((observation) => observations.push(observation));
    await connect(client, socket);
    const pending = client.hydrateConversationHistory([{
      role: "tool",
      toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      toolArguments: {
        tool_name: "membership.lookup",
        arguments: { member_id: "m_17" },
      },
      output: "{\"status\":\"active\"}",
      sourceSha256: sourceSha256("xai-identity-only-tool-source"),
    }]);

    await vi.waitFor(() => {
      expect(socket.sent.filter((value) => (
        JSON.parse(value).type === "conversation.item.create"
      ))).toHaveLength(1);
    });
    const call = JSON.parse(socket.sent.at(-1)!) as {
      item: Record<string, unknown>;
    };
    expect(call.item.id).toMatch(/^item_hacc_/);
    socket.emit("message", JSON.stringify({
      type: "conversation.item.added",
      item: { ...call.item, arguments: "" },
    }));

    await vi.waitFor(() => {
      expect(socket.sent.filter((value) => (
        JSON.parse(value).type === "conversation.item.create"
      ))).toHaveLength(2);
    });
    const output = JSON.parse(socket.sent.at(-1)!) as {
      item: Record<string, unknown>;
    };
    expect(output.item.id).toMatch(/^item_hacc_/);
    socket.emit("message", JSON.stringify({
      type: "conversation.item.added",
      item: output.item,
    }));

    await expect(pending).resolves.toMatchObject({
      status: "identity_acknowledged_content_unverifiable",
      items: [
        {
          kind: "synthetic_tool_call",
          providerContentOmission: {
            field: "arguments",
            observedShape: "empty_string",
          },
        },
        {
          kind: "synthetic_tool_output",
        },
      ],
    });
    const history = observations.filter((observation) => (
      recordForTest(observation.projection).conversationHistoryItem !== undefined
    ));
    expect(history).toHaveLength(4);
    expect(recordForTest(recordForTest(history[1]!.projection).conversationHistoryItem))
      .toMatchObject({
        kind: "synthetic_tool_call",
        argumentsBytes: 0,
        argumentsPresent: true,
        argumentsJsonValid: false,
      });
    expect(recordForTest(recordForTest(history[3]!.projection).conversationHistoryItem))
      .toMatchObject({
        kind: "synthetic_tool_output",
        outputBytes: Buffer.byteLength("{\"status\":\"active\"}", "utf8"),
        outputPresent: true,
      });
  });

  it.each([
    ["openai", "conversation.item.created"],
    ["xai", "conversation.item.added"],
  ] as const)(
    "rejects a nonempty changed tool payload in a %s history acknowledgement",
    async (provider, wireType) => {
      const { client, socket } = fakeClient(provider, { sessionUpdate: localProxySession });
      await connect(client, socket);
      const pending = client.hydrateConversationHistory([{
        role: "tool",
        toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        toolArguments: { tool_name: "membership.lookup", arguments: { member_id: "m_17" } },
        output: "{\"status\":\"active\"}",
        sourceSha256: sourceSha256(`${provider}-changed-tool-source`),
      }]);
      const frame = JSON.parse(socket.sent.at(-1)!) as {
        item: Record<string, unknown>;
      };
      socket.emit("message", JSON.stringify({
        type: wireType,
        item: { ...frame.item, arguments: "{\"changed\":true}" },
      }));
      await expect(pending).rejects.toThrow(/altered synthetic conversation history tool call/);
      expect(client.state).toBe("failed");
    },
  );

  it("rejects an OpenAI empty arguments echo rather than treating it as identity-only", async () => {
    const { client, socket } = fakeClient("openai", { sessionUpdate: localProxySession });
    await connect(client, socket);
    const pending = client.hydrateConversationHistory([{
      role: "tool",
      toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      toolArguments: { tool_name: "membership.lookup", arguments: { member_id: "m_17" } },
      output: "{\"status\":\"active\"}",
      sourceSha256: sourceSha256("openai-empty-arguments-source"),
    }]);
    const frame = JSON.parse(socket.sent.at(-1)!) as { item: Record<string, unknown> };
    socket.emit("message", JSON.stringify({
      type: "conversation.item.created",
      item: { ...frame.item, arguments: "" },
    }));
    await expect(pending).rejects.toThrow(/altered synthetic conversation history tool call/);
    expect(client.state).toBe("failed");
  });

  it.each([
    ["name", { name: "different_tool" }],
    ["call id", { call_id: "different_call" }],
    ["type", { type: "function_call_output" }],
  ] as const)(
    "rejects an xAI identity-only acknowledgement with a changed %s",
    async (_label, mutation) => {
      const { client, socket } = fakeClient("xai", { sessionUpdate: localProxySession });
      await connect(client, socket);
      const pending = client.hydrateConversationHistory([{
        role: "tool",
        toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        toolArguments: { tool_name: "membership.lookup", arguments: { member_id: "m_17" } },
        output: "{\"status\":\"active\"}",
        sourceSha256: sourceSha256(`xai-changed-${String(_label)}-source`),
      }]);
      const frame = JSON.parse(socket.sent.at(-1)!) as { item: Record<string, unknown> };
      socket.emit("message", JSON.stringify({
        type: "conversation.item.added",
        item: { ...frame.item, ...mutation, arguments: "" },
      }));
      await expect(pending).rejects.toThrow(/altered synthetic conversation history tool call/);
      expect(client.state).toBe("failed");
    },
  );

  it("rejects an xAI omitted synthetic tool output without retained provider evidence", async () => {
    const { client, socket } = fakeClient("xai", { sessionUpdate: localProxySession });
    await connect(client, socket);
    const pending = client.hydrateConversationHistory([{
      role: "tool",
      toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      toolArguments: { tool_name: "membership.lookup", arguments: { member_id: "m_17" } },
      output: "{\"status\":\"active\"}",
      sourceSha256: sourceSha256("xai-empty-output-source"),
    }]);
    await vi.waitFor(() => {
      expect(socket.sent.filter((value) => (
        JSON.parse(value).type === "conversation.item.create"
      ))).toHaveLength(1);
    });
    const call = JSON.parse(socket.sent.at(-1)!) as { item: Record<string, unknown> };
    socket.emit("message", JSON.stringify({
      type: "conversation.item.added",
      item: call.item,
    }));
    await vi.waitFor(() => {
      expect(socket.sent.filter((value) => (
        JSON.parse(value).type === "conversation.item.create"
      ))).toHaveLength(2);
    });
    const output = JSON.parse(socket.sent.at(-1)!) as { item: Record<string, unknown> };
    socket.emit("message", JSON.stringify({
      type: "conversation.item.added",
      item: { ...output.item, output: "" },
    }));
    await expect(pending).rejects.toThrow(/altered synthetic conversation history tool output/);
    expect(client.state).toBe("failed");
  });

  it("fails the connection on mismatched or duplicate provider acknowledgements", async () => {
    const mismatched = fakeClient("openai");
    await connect(mismatched.client, mismatched.socket);
    const mismatchPending = mismatched.client.hydrateConversationHistory([{
      role: "assistant",
      text: "exact assistant history",
      sourceSha256: sourceSha256("assistant-history-source"),
    }]);
    const frame = JSON.parse(mismatched.socket.sent.at(-1)!) as {
      item: { content: Array<{ text: string }> };
    };
    frame.item.content[0]!.text = "provider-altered history";
    mismatched.socket.emit("message", JSON.stringify({
      type: "conversation.item.created",
      item: frame.item,
    }));
    await expect(mismatchPending).rejects.toThrow(/altered conversation history message content/);
    expect(mismatched.client.state).toBe("failed");

    const duplicated = fakeClient("xai");
    await connect(duplicated.client, duplicated.socket);
    const duplicatePending = duplicated.client.hydrateConversationHistory([{
      role: "user",
      text: "exact caller history",
      sourceSha256: sourceSha256("caller-history-source"),
    }]);
    await acknowledgeHistoryItems(duplicated.socket, 1);
    await duplicatePending;
    const created = JSON.parse(duplicated.socket.sent.at(-1)!) as { item: Record<string, unknown> };
    duplicated.socket.emit("message", JSON.stringify({
      type: "conversation.item.created",
      item: created.item,
    }));
    expect(duplicated.client.state).toBe("failed");
  });

  it("seals hydrated synthetic call IDs against later executable reuse", async () => {
    const { client, socket } = fakeClient("openai", { sessionUpdate: localProxySession });
    const events: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => events.push(event));
    await connect(client, socket);
    const pending = client.hydrateConversationHistory([{
      role: "tool",
      toolName: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      toolArguments: { tool_name: "membership.lookup", arguments: { member_id: "m_17" } },
      output: "{\"status\":\"active\"}",
      sourceSha256: sourceSha256("sealed-history-tool-source"),
    }]);
    await acknowledgeHistoryItems(socket, 2);
    await pending;
    const historyCall = socket.sent.map((value) => JSON.parse(value)).find((event) => (
      event.type === "conversation.item.create" && event.item.type === "function_call"
    )).item as {
      id: string;
      call_id: string;
      name: string;
      arguments: string;
    };
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "response_reusing_history",
      call_id: historyCall.call_id,
      name: historyCall.name,
      arguments: historyCall.arguments,
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: {
        id: "response_reusing_history",
        status: "completed",
        output: [{
          type: "function_call",
          id: historyCall.id,
          call_id: historyCall.call_id,
          name: historyCall.name,
          arguments: historyCall.arguments,
          status: "completed",
        }],
      },
    }));
    expect(client.state).toBe("failed");
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "invalid_provider_tool_call_identity",
      message: expect.stringContaining("reused hydrated conversation history tool call id"),
      fatal: true,
    }));
    expect(events.some((event) => event.type === "tool.dispatch")).toBe(false);
  });

  it("rejects a pending hydration immediately when the connection closes", async () => {
    const { client, socket } = fakeClient("openai");
    await connect(client, socket);
    const pending = client.hydrateConversationHistory([{
      role: "user",
      text: "pending history item",
      sourceSha256: sourceSha256("close-history-source"),
    }], 10_000);
    client.close();
    await expect(pending).rejects.toThrow(/closed before conversation history item acknowledgement/);
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
  });

  it("times out waiting for an exact item acknowledgement and leaves no usable partial session", async () => {
    const { client, socket } = fakeClient("openai");
    await connect(client, socket);
    vi.useFakeTimers();
    try {
      const pending = client.hydrateConversationHistory([{
        role: "user",
        text: "history requiring acknowledgement",
        sourceSha256: sourceSha256("timeout-history-source"),
      }], 10);
      const rejected = expect(pending).rejects.toThrow(/timed out after 10 ms/);
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      expect(client.state).toBe("failed");
      expect(socket.terminated).toBe(true);
      expect(socket.sent.some((value) => JSON.parse(value).type === "response.create")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("safe realtime event normalization", () => {
  it("never throws for malformed or oversized WebSocket frames", () => {
    expect(safeParseWireEvent("not-json")).toMatchObject({ ok: false, code: "invalid_json" });
    expect(safeParseWireEvent(JSON.stringify({ noType: true }))).toMatchObject({ ok: false, code: "invalid_event" });
    expect(safeParseWireEvent(JSON.stringify({ type: "event", value: "large" }), 4)).toMatchObject({
      ok: false,
      code: "wire_event_too_large",
    });
    expect(safeParseWireEvent({ type: "event" })).toMatchObject({ ok: false, code: "unsupported_wire_data" });
  });

  it("turns cumulative xAI transcription updates into stable text and suffixes", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({
      provider: "xai",
      outputAudioFormat: PCM,
      now: () => 42,
    });
    expect(normalizer.normalize({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "caller_1",
      transcript: "book",
    })[0]).toMatchObject({ type: "input.transcript", text: "book", delta: "book", phase: "delta" });
    expect(normalizer.normalize({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "caller_1",
      transcript: "booking",
    })[0]).toMatchObject({ type: "input.transcript", text: "booking", delta: "ing" });
    expect(normalizer.normalize({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "caller_1",
      transcript: "cancel",
    })[0]).toMatchObject({ type: "input.transcript", text: "cancel", revised: true });
  });

  it("normalizes output PCM and reports corrupt deltas as protocol errors", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    expect(normalizer.normalize({ type: "response.output_audio.delta", delta: "AQI=", response_id: "r1" })[0])
      .toMatchObject({ type: "output.audio", audio: Uint8Array.from([1, 2]), responseId: "r1", format: PCM });
    expect(normalizer.normalize({ type: "response.output_audio.delta", response_id: "r2", delta: "***" })[0])
      .toMatchObject({ type: "error", code: "invalid_audio_delta", fatal: false });
  });

  it("emits one ordered call batch for a multi-tool xAI response", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "xai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.output_item.added",
      response_id: "r1",
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "" },
    });
    normalizer.normalize({
      type: "response.function_call_arguments.delta",
      response_id: "r1",
      call_id: "call_1",
      delta: "{\"member\":",
    });
    normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      call_id: "call_1",
      name: "lookup",
      arguments: "{\"member\":42}",
    });
    normalizer.normalize({
      type: "response.output_item.done",
      response_id: "r1",
      item: {
        type: "function_call",
        id: "item_2",
        call_id: "call_2",
        name: "quote",
        arguments: "{\"tier\":\"pro\"}",
        status: "completed",
      },
    });

    const events = normalizer.normalize({
      type: "response.done",
      response: {
        id: "r1",
        status: "completed",
        output: [
          { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "{\"member\":42}" },
          {
            type: "function_call",
            id: "item_2",
            call_id: "call_2",
            name: "quote",
            arguments: "{\"tier\":\"pro\"}",
            status: "completed",
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_token_details: { text_tokens: 2, audio_tokens: 8 },
          output_token_details: { text_tokens: 1, audio_tokens: 3 },
        },
      },
    });

    expect(events.map((event) => event.type)).toEqual(["tool.calls", "usage", "response.completed"]);
    expect(events[0]).toMatchObject({
      type: "tool.calls",
      responseId: "r1",
      calls: [
        { callId: "call_1", name: "lookup", argumentsJson: { member: 42 } },
        { callId: "call_2", name: "quote", argumentsJson: { tier: "pro" } },
      ],
    });
    expect(events[1]).toMatchObject({
      type: "usage",
      usage: { inputTextTokens: 2, inputAudioTokens: 8, outputTextTokens: 1, outputAudioTokens: 3, totalTokens: 14 },
    });
  });

  it("normalizes provider usage without manufacturing absent counters", () => {
    expect(normalizeOpenAICompatibleUsage({ input_tokens: 7, output_token_details: { audio_tokens: 3 } })).toEqual({
      totalInputTokens: 7,
      outputAudioTokens: 3,
      meteringSource: "provider_reported",
      raw: { input_tokens: 7, output_token_details: { audio_tokens: 3 } },
    });
    expect(normalizeOpenAICompatibleUsage({ type: "duration", seconds: 90 })).toMatchObject({
      inputAudioMinutes: 1.5,
      meteringSource: "provider_reported",
      raw: { type: "duration", seconds: 90 },
    });
  });

  it("retains input-transcription usage as a separately scoped accounting event", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    const events = normalizer.normalize({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "caller_9",
      transcript: "hello",
      usage: {
        input_tokens: 8,
        output_tokens: 2,
        total_tokens: 10,
        input_token_details: { audio_tokens: 8 },
        output_token_details: { text_tokens: 2 },
      },
    });
    expect(events.map((event) => event.type)).toEqual(["input.transcript", "usage"]);
    expect(events[1]).toMatchObject({
      type: "usage",
      scope: "input_transcription",
      itemId: "caller_9",
      usage: { inputAudioTokens: 8, outputTextTokens: 2, totalTokens: 10 },
    });
  });

  it("normalizes xAI conversation IDs only as resumable when caching was enabled", () => {
    const disabled = new OpenAICompatibleEventNormalizer({ provider: "xai", outputAudioFormat: PCM });
    expect(disabled.normalize({ type: "conversation.created", conversation: { id: "conv_1" } })[0])
      .toMatchObject({ type: "session.resumption", handle: "conv_1", conversationId: "conv_1", resumable: false });
    const enabled = new OpenAICompatibleEventNormalizer({
      provider: "xai",
      outputAudioFormat: PCM,
      xaiResumptionEnabled: true,
    });
    expect(enabled.normalize({ type: "conversation.created", conversation: { id: "conv_2" } })[0])
      .toMatchObject({ type: "session.resumption", handle: "conv_2", conversationId: "conv_2", resumable: true });
  });

  it("rejects incomplete items and malformed arguments inside completed responses", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      call_id: "incomplete_call",
      name: "mutate",
      arguments: "{}",
    });
    normalizer.normalize({
      type: "response.output_item.done",
      response_id: "r1",
      item: { type: "function_call", call_id: "incomplete_call", status: "incomplete" },
    });
    normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      call_id: "bad_json",
      name: "mutate",
      arguments: "{broken",
    });
    const events = normalizer.normalize({
      type: "response.done",
      response: { id: "r1", status: "completed", output: [] },
    });
    expect(events.some((event) => event.type === "tool.calls")).toBe(false);
    expect(events.filter((event) => event.type === "error")).toHaveLength(2);
    expect(events.filter((event) => event.type === "error").every((event) => event.fatal)).toBe(true);
    expect(events.find((event) => event.type === "tool.cancelled")).toMatchObject({
      callIds: ["incomplete_call", "bad_json"],
    });
  });

  it.each(["cancelled", "failed", "incomplete"])(
    "never exposes tool calls from a %s response as executable",
    (status) => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r_cancelled",
      call_id: "call_late",
      name: "charge_card",
      arguments: "{\"amount\":100}",
    });
    const events = normalizer.normalize({
      type: "response.done",
      response: { id: "r_cancelled", status, output: [] },
    });
    expect(events.map((event) => event.type)).toEqual(["tool.cancelled", "response.completed"]);
    expect(events[0]).toMatchObject({
      type: "tool.cancelled",
      responseId: "r_cancelled",
      callIds: ["call_late"],
    });
    },
  );

  it.each([undefined, "in_progress", "completed:turn_complete"])(
    "seals but rejects a non-enumerated terminal status %s",
    (status) => {
      const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
      normalizer.normalize({
        type: "response.function_call_arguments.done",
        response_id: "r_bad_status",
        call_id: "call_never_execute",
        name: "charge_card",
        arguments: "{}",
      });
      const events = normalizer.normalize({
        type: "response.done",
        response: { id: "r_bad_status", status, output: [] },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool.cancelled",
        responseId: "r_bad_status",
        callIds: ["call_never_execute"],
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "error",
        code: "invalid_response_terminal_status",
        fatal: true,
      }));
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      expect(normalizer.normalize({
        type: "response.done",
        response: { id: "r_bad_status", status: "completed", output: [] },
      })[0]).toMatchObject({ type: "error", code: "response_id_conflict", fatal: true });
    },
  );

  it("normalizes cancellation as an exact terminal state and seals every pending call", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r_cancelled_alias",
      call_id: "call_cancelled_alias",
      name: "reserve",
      arguments: "{}",
    });
    const events = normalizer.normalize({
      type: "response.cancelled",
      response_id: "r_cancelled_alias",
      reason: "client_cancelled",
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "tool.cancelled",
        responseId: "r_cancelled_alias",
        callIds: ["call_cancelled_alias"],
      }),
      expect.objectContaining({
        type: "response.completed",
        responseId: "r_cancelled_alias",
        status: "cancelled",
        reason: "client_cancelled",
      }),
    ]);
    expect(normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r_cancelled_alias",
      call_id: "call_after_cancel",
      name: "unsafe",
      arguments: "{}",
    })[0]).toMatchObject({ type: "error", code: "stale_response_event", fatal: true });
  });

  it("rejects contradictory terminal status fields after sealing the response", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    expect(normalizer.normalize({
      type: "response.done",
      status: "cancelled",
      response: { id: "r_status_conflict", status: "completed", output: [] },
    })[0]).toMatchObject({
      type: "error",
      code: "response_terminal_status_conflict",
      fatal: true,
    });
    expect(normalizer.normalize({
      type: "response.done",
      response: { id: "r_status_conflict", status: "completed", output: [] },
    })[0]).toMatchObject({ type: "error", code: "response_id_conflict", fatal: true });
  });

  it("requires response provenance and rejects contradictory redundant IDs", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    expect(normalizer.normalize({
      type: "response.output_audio.delta",
      delta: "AQI=",
    })[0]).toMatchObject({ type: "error", code: "missing_response_id", fatal: true });
    expect(normalizer.normalize({
      type: "response.done",
      response_id: "r_top",
      response: { id: "r_nested", status: "completed", output: [] },
    })[0]).toMatchObject({ type: "error", code: "response_id_conflict", fatal: true });
    expect(normalizer.normalize({
      type: "response.output_item.added",
      response_id: "r_items",
      item_id: "item_top",
      item: { id: "item_nested", type: "message" },
    })[0]).toMatchObject({ type: "error", code: "response_item_id_conflict", fatal: true });
    expect(normalizer.normalize({
      type: "response.created",
      response: { id: " response_with_space" },
    })[0]).toMatchObject({ type: "error", code: "response_id_conflict", fatal: true });
    expect(normalizer.normalize({
      type: "rate_limits.updated",
      event_id: null,
    })[0]).toMatchObject({ type: "error", code: "invalid_native_event_id", fatal: true });
  });

  it("fails closed at a bounded unique-identity capacity without breaking exact replay", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({
      provider: "openai",
      outputAudioFormat: PCM,
      maximumTrackedIdentities: 2,
    });
    const first = {
      type: "response.created",
      event_id: "evt_capacity_1",
      response: { id: "r_capacity", status: "in_progress" },
    };
    expect(normalizer.normalize(first)[0]).toMatchObject({ type: "response.started", responseId: "r_capacity" });
    expect(normalizer.normalize(structuredClone(first))).toEqual([]);
    expect(normalizer.normalize({
      type: "response.output_audio.delta",
      event_id: "evt_capacity_2",
      response_id: "r_capacity",
      delta: "AQI=",
    })[0]).toMatchObject({
      type: "error",
      code: "provider_identity_capacity_exceeded",
      fatal: true,
    });
    expect(() => new OpenAICompatibleEventNormalizer({
      provider: "openai",
      outputAudioFormat: PCM,
      maximumTrackedIdentities: 0,
    })).toThrow(/positive integer/);
  });

  it("deduplicates exact native retransmissions but rejects rewritten event IDs", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    const first = {
      type: "response.output_audio.delta",
      event_id: "evt_1",
      response_id: "r1",
      item_id: "item_1",
      delta: "AQI=",
    };
    expect(normalizer.normalize(first)[0]).toMatchObject({ type: "output.audio", responseId: "r1" });
    expect(normalizer.normalize({
      delta: "AQI=",
      item_id: "item_1",
      response_id: "r1",
      event_id: "evt_1",
      type: "response.output_audio.delta",
    })).toEqual([]);
    expect(normalizer.normalize({ ...first, delta: "AwQ=" })).toEqual([
      expect.objectContaining({
        type: "error",
        code: "native_event_id_conflict",
        fatal: true,
        nativeEventId: "evt_1",
      }),
    ]);
  });

  it("fails closed when one pending call ID is rewritten", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      call_id: "call_same",
      item_id: "item_same",
      name: "charge_card",
      arguments: "{\"amount\":100}",
    });
    expect(normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      call_id: "call_same",
      item_id: "item_same",
      name: "refund_card",
      arguments: "{\"amount\":900}",
    })).toEqual([
      expect.objectContaining({
        type: "error",
        code: "tool_call_identity_conflict",
        fatal: true,
      }),
    ]);

    const terminal = normalizer.normalize({
      type: "response.done",
      response: { id: "r1", status: "completed", output: [] },
    });
    expect(terminal.some((event) => event.type === "tool.calls")).toBe(false);
    expect(terminal).toContainEqual(expect.objectContaining({
      type: "tool.cancelled",
      callIds: ["call_same"],
    }));
  });

  it("never reopens a settled call ID under a later response", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "xai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      call_id: "call_once",
      name: "reserve",
      arguments: "{}",
    });
    expect(normalizer.normalize({
      type: "response.done",
      response: {
        id: "r1",
        status: "completed",
        output: [terminalToolOutput("call_once", "reserve")],
      },
    }).some((event) => event.type === "tool.calls")).toBe(true);

    expect(normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r2",
      call_id: "call_once",
      name: "reserve",
      arguments: "{}",
    })).toEqual([
      expect.objectContaining({
        type: "error",
        code: "tool_call_identity_conflict",
        fatal: true,
        message: expect.stringContaining("belongs to r1"),
      }),
    ]);
    expect(normalizer.normalize({
      type: "response.done",
      response: { id: "r2", status: "completed", output: [] },
    }).some((event) => event.type === "tool.calls")).toBe(false);
  });

  it("keeps cancelled call IDs reserved until their response drains", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    expect(normalizer.normalize({
      type: "response.function_call_arguments.cancelled",
      response_id: "r_cancel",
      call_id: "call_cancelled",
    })[0]).toMatchObject({ type: "tool.cancelled", callIds: ["call_cancelled"] });
    expect(normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r_reuse",
      call_id: "call_cancelled",
      name: "unsafe_reuse",
      arguments: "{}",
    })[0]).toMatchObject({ type: "error", code: "tool_call_identity_conflict", fatal: true });

    const reusedTerminal = normalizer.normalize({
      type: "response.done",
      response: { id: "r_reuse", status: "completed", output: [] },
    });
    expect(reusedTerminal.some((event) => event.type === "tool.calls")).toBe(false);
  });

  it("rejects delayed response events using explicit or item-bound provenance", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.output_audio.delta",
      response_id: "r_old",
      item_id: "item_old",
      delta: "AQI=",
    });
    normalizer.normalize({
      type: "response.done",
      response: { id: "r_old", status: "completed", output: [] },
    });

    expect(normalizer.normalize({
      type: "response.output_audio.delta",
      response_id: "r_old",
      delta: "AwQ=",
    })[0]).toMatchObject({ type: "error", code: "stale_response_event", fatal: true });
    expect(normalizer.normalize({
      type: "response.output_audio_transcript.delta",
      item_id: "item_old",
      delta: "late",
    })[0]).toMatchObject({ type: "error", code: "stale_response_event", fatal: true });
  });

  it("binds terminal-only output items so late unscoped deltas are rejected", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.done",
      response: {
        id: "r_terminal_item",
        status: "completed",
        output: [{ type: "message", id: "item_terminal_only" }],
      },
    });
    expect(normalizer.normalize({
      type: "response.output_audio_transcript.delta",
      item_id: "item_terminal_only",
      delta: "too late",
    })[0]).toMatchObject({ type: "error", code: "stale_response_event", fatal: true });
  });

  it("deduplicates an exact terminal response but rejects a conflicting replay", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    const terminal = {
      type: "response.done",
      response: { id: "r_terminal", status: "completed", output: [] },
    };
    expect(normalizer.normalize(terminal).at(-1)).toMatchObject({
      type: "response.completed",
      responseId: "r_terminal",
    });
    expect(normalizer.normalize(structuredClone(terminal))).toEqual([]);
    expect(normalizer.normalize({
      type: "response.done",
      response: { id: "r_terminal", status: "failed", output: [] },
    })).toEqual([
      expect.objectContaining({ type: "error", code: "response_id_conflict", fatal: true }),
    ]);
  });

  it("deduplicates an exact response start but rejects rewritten start metadata", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    const started = {
      type: "response.created",
      response: { id: "r_started", status: "in_progress", metadata: { turn: 7 } },
    };
    expect(normalizer.normalize(started)[0]).toMatchObject({ type: "response.started", responseId: "r_started" });
    expect(normalizer.normalize(structuredClone(started))).toEqual([]);
    expect(normalizer.normalize({
      type: "response.created",
      response: { id: "r_started", status: "in_progress", metadata: { turn: 8 } },
    })[0]).toMatchObject({ type: "error", code: "response_id_conflict", fatal: true });
  });

  it("rejects response item IDs rebound to another response", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.output_audio.delta",
      response_id: "r1",
      item_id: "item_shared",
      delta: "AQI=",
    });
    expect(normalizer.normalize({
      type: "response.output_audio.delta",
      response_id: "r2",
      item_id: "item_shared",
      delta: "AwQ=",
    })[0]).toMatchObject({ type: "error", code: "response_item_id_conflict", fatal: true });
  });

  it("reserves one reverse item owner across function calls in the same response", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r_item_owner",
      item_id: "item_one_owner",
      call_id: "call_item_owner_a",
      name: "lookup",
      arguments: "{}",
    });
    expect(normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r_item_owner",
      item_id: "item_one_owner",
      call_id: "call_item_owner_b",
      name: "mutate",
      arguments: "{}",
    })[0]).toMatchObject({
      type: "error",
      code: "tool_call_identity_conflict",
      fatal: true,
      message: expect.stringContaining("item_one_owner"),
    });
  });

  it("seals an invalid terminal response so a corrected replay cannot execute it", () => {
    const normalizer = new OpenAICompatibleEventNormalizer({ provider: "openai", outputAudioFormat: PCM });
    normalizer.normalize({
      type: "response.function_call_arguments.done",
      response_id: "r_invalid_terminal",
      call_id: "call_pending_at_invalid_terminal",
      name: "mutate",
      arguments: "{}",
    });
    const invalid = normalizer.normalize({
      type: "response.done",
      response: {
        id: "r_invalid_terminal",
        status: "completed",
        output: [
          terminalToolOutput("call_pending_at_invalid_terminal", "mutate"),
          { type: "message", id: "duplicate_item" },
          { type: "message", id: "duplicate_item" },
        ],
      },
    });
    expect(invalid[0]).toMatchObject({ type: "error", code: "response_item_id_conflict", fatal: true });
    expect(invalid).toContainEqual(expect.objectContaining({
      type: "tool.cancelled",
      responseId: "r_invalid_terminal",
      callIds: ["call_pending_at_invalid_terminal"],
    }));
    expect(normalizer.normalize({
      type: "response.done",
      response: { id: "r_invalid_terminal", status: "completed", output: [] },
    })[0]).toMatchObject({ type: "error", code: "response_id_conflict", fatal: true });
  });
});

describe("OpenAI-compatible realtime client", () => {
  it.each(["openai", "xai"] as const)(
    "preserves immutable base instructions when preparing a %s response",
    async (provider) => {
      const socket = new FakeSocket();
      const client = new OpenAICompatibleRealtimeClient({
        provider,
        url: `wss://${provider}.example/realtime`,
        sessionUpdate: {
          ...baseSession,
          session: { ...baseSession.session, instructions: "BASE SAFETY AND FLOW GUARDRAILS" },
        },
        socketFactory: () => socket,
        connectTimeoutMs: 1_000,
      });
      const observations: RealtimeWireObservation[] = [];
      client.onWireObservation((observation) => observations.push(observation));
      await connect(client, socket);
      socket.sent.length = 0;
      const dynamic = "<hacc_response_plan>\n{\"revision\":19}\n</hacc_response_plan>";
      client.appendInputAudio({ ...PCM, data: Uint8Array.from([0, 0]) });
      client.prepareResponse({
        additionalInstructions: dynamic,
        contextSha256: createHash("sha256").update(dynamic).digest("hex"),
        contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
      });
      expect(() => client.createResponse({ instructions: "unbound replacement" }))
        .toThrow("Prepared response instructions cannot be overridden");
      client.commitInputAudio();
      client.createResponse();

      const frames = socket.sent.map((value) => JSON.parse(value));
      expect(frames.map((frame) => frame.type)).toEqual([
        "input_audio_buffer.append",
        "input_audio_buffer.commit",
        "response.create",
      ]);
      expect(frames[2]).toEqual({
        type: "response.create",
        response: {
          instructions: `BASE SAFETY AND FLOW GUARDRAILS\n${dynamic}`,
        },
      });
      const responseObservation = observations.find((entry) => (
        entry.direction === "outbound" && entry.wireType === "response.create"
      ));
      expect(responseObservation?.projection).toMatchObject({
        dynamicControl: {
          sha256: createHash("sha256").update(dynamic).digest("hex"),
          byteLength: Buffer.byteLength(dynamic, "utf8"),
          authority: "advisory_only_gateway_and_speech_gate_enforced",
        },
      });
      expect(JSON.stringify(responseObservation?.projection)).not.toContain(dynamic);
      expect(JSON.stringify(responseObservation?.projection)).not.toContain("BASE SAFETY");
    },
  );

  it("binds response preparation to buffered audio and clears stale preparation", async () => {
    const { client, socket } = fakeClient("openai");
    await connect(client, socket);
    socket.sent.length = 0;
    const dynamic = "<hacc_response_plan>{\"revision\":1}</hacc_response_plan>";
    const preparation = {
      additionalInstructions: dynamic,
      contextSha256: createHash("sha256").update(dynamic).digest("hex"),
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced" as const,
    };

    expect(() => client.prepareResponse(preparation)).toThrow("requires buffered uncommitted audio");
    client.appendInputAudio({ ...PCM, data: Uint8Array.from([0, 0]) });
    client.prepareResponse(preparation);
    expect(() => client.prepareResponse(preparation)).toThrow("already prepared");
    client.clearInputAudio();
    expect(() => client.commitInputAudio()).toThrow("not buffered for commit");

    client.appendInputAudio({ ...PCM, data: Uint8Array.from([0, 0]) });
    client.commitInputAudio();
    expect(() => client.prepareResponse(preparation)).toThrow("requires buffered uncommitted audio");
    client.createResponse();
    expect(socket.sent.map((frame) => JSON.parse(frame)).at(-1)).toEqual({ type: "response.create" });
  });
  it("waits for session.updated before becoming ready", async () => {
    const { client, socket, factoryArgs } = fakeClient();
    let resolved = false;
    const pending = client.connect().then(() => { resolved = true; });
    socket.emit("open");
    await Promise.resolve();

    expect(client.state).toBe("connecting");
    expect(resolved).toBe(false);
    expect(factoryArgs()).toEqual([
      "wss://openai.example/realtime",
      { headers: { Authorization: "Bearer redacted" } },
    ]);
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: "session.update",
      session: { audio: { input: { turn_detection: null, format: { type: "audio/pcm", rate: 24_000 } } } },
    });

    socket.emit("message", Buffer.from(JSON.stringify(sessionAcknowledgement("openai"))));
    await pending;
    expect(client.state).toBe("ready");
  });

  it("sends xAI session.update first and waits for the provider acknowledgement", async () => {
    const { client, socket } = fakeClient("xai");
    const pending = client.connect();
    socket.emit("open");
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      expect.objectContaining({ type: "session.update" }),
    ]);

    socket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_1" },
    }));
    expect(client.state).toBe("connecting");
    socket.emit("message", JSON.stringify(sessionAcknowledgement("xai")));
    await pending;
  });

  it("keeps an omitted xAI created-session identity unverifiable without blocking the update", async () => {
    const { client, socket } = fakeClient("xai");
    const pending = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "session.created", session: {} }));
    socket.emit("message", JSON.stringify(sessionAcknowledgement("xai")));
    await pending;
    expect(socket.sent).toHaveLength(1);
    expect(client.state).toBe("ready");
  });

  it("accepts xAI session.updated without treating session.created as a transport prerequisite", async () => {
    const { client, socket } = fakeClient("xai");
    const pending = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify(sessionAcknowledgement("xai")));
    await pending;
    expect(socket.sent).toHaveLength(1);
    expect(client.state).toBe("ready");
  });

  it("records omitted acknowledgement fields as unverifiable instead of provider proof", async () => {
    const { client, socket } = fakeClient();
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    const ready = observed.find((event) => event.type === "session.ready");
    expect(ready).toMatchObject({
      type: "session.ready",
      configuration: {
        schemaVersion: 1,
        strictParityVerified: false,
        paidBenchmarkReady: false,
        fields: {
          voice: { status: "unverifiable" },
          input_audio: { status: "unverifiable" },
          output_audio: { status: "unverifiable" },
          turn_detection: { status: "verified" },
        },
      },
    });
  });

  it("publishes paidBenchmarkReady only after an exact full provider acknowledgement", async () => {
    const strictSocket = new FakeSocket();
    const strictEvents: NormalizedRealtimeEvent[] = [];
    const strictClient = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: baseSession,
      socketFactory: () => strictSocket,
      connectTimeoutMs: 1_000,
      requireStrictSessionConfigurationParity: true,
    });
    strictClient.onEvent((event) => strictEvents.push(event));
    const strictPending = strictClient.connect();
    strictSocket.emit("open");
    const requestedWire = JSON.parse(strictSocket.sent[0]) as Record<string, unknown>;
    strictSocket.emit("message", JSON.stringify({
      type: "session.updated",
      session: { ...recordForTest(requestedWire.session), id: "sess_strict" },
    }));
    await strictPending;
    expect(strictEvents.find((event) => event.type === "session.ready")).toMatchObject({
      type: "session.ready",
      configuration: {
        strictParityVerified: true,
        paidBenchmarkReady: true,
      },
    });
  });

  it("emits a chained bidirectional evidence projection without retaining private wire content", async () => {
    const secrets = {
      apiKey: "api-key-must-never-enter-wire-evidence",
      prompt: "private prompt: ask for the caller's secret phrase",
      sessionId: "sess_private_identity",
      responseId: "response_private_identity",
      itemId: "item_private_identity",
      callId: "call_private_identity",
      arguments: "member-private-1234",
      result: "private renewal result",
      transcript: "private caller transcript",
      audioBase64: "AQACAA==",
    } as const;
    const socket = new FakeSocket();
    let wall = 1_700_000_000_000;
    let monotonic = 10_000;
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime?model=gpt-realtime-evidence",
      headers: { Authorization: `Bearer ${secrets.apiKey}` },
      sessionUpdate: {
        ...localProxySession,
        session: {
          ...localProxySession.session,
          instructions: secrets.prompt,
          tool_choice: "auto",
        },
      },
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
      requireStrictSessionConfigurationParity: true,
      now: () => wall += 1,
      monotonicNow: () => monotonic += 0.5,
    });
    const observations: RealtimeWireObservation[] = [];
    const normalizedEvents: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => normalizedEvents.push(event));
    client.onWireObservation((observation) => {
      // A hostile observer receives a detached, recursively frozen snapshot.
      try {
        (observation.projection as Record<string, unknown>).injected = secrets.prompt;
      } catch {
        // Expected in strict mode.
      }
    });
    client.onWireObservation((observation) => observations.push(observation));

    const pending = client.connect();
    socket.emit("open");
    const sentSessionUpdate = JSON.parse(socket.sent[0]) as Record<string, unknown>;
    socket.emit("message", JSON.stringify({
      type: "session.updated",
      event_id: "event_private_session_ack",
      session: {
        ...recordForTest(sentSessionUpdate.session),
        id: secrets.sessionId,
        model: "gpt-realtime-evidence",
      },
    }));
    await pending;
    expect(client.sessionConfigurationAcknowledgement).toMatchObject({
      strictParityVerified: true,
      paidBenchmarkReady: true,
    });

    client.appendInputAudio({ ...PCM, data: Uint8Array.from([1, 0, 2, 0]) });
    socket.emit("message", JSON.stringify({
      type: "response.output_audio.delta",
      event_id: "event_private_audio",
      response_id: "response_private_audio",
      delta: secrets.audioBase64,
    }));
    socket.emit("message", JSON.stringify({
      type: "response.output_audio_transcript.done",
      event_id: "event_private_transcript",
      response_id: "response_private_audio",
      transcript: secrets.transcript,
    }));

    const gatewayArguments = JSON.stringify({
      tool_name: "membership.lookup",
      arguments: { member_id: secrets.arguments },
    });
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      event_id: "event_private_tool_args",
      response_id: secrets.responseId,
      item_id: secrets.itemId,
      call_id: secrets.callId,
      name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      arguments: gatewayArguments,
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      event_id: "event_private_terminal",
      response: {
        id: secrets.responseId,
        status: "completed",
        output: [terminalToolOutput(
          secrets.callId,
          LOCAL_TOOL_PROXY_FUNCTION_NAME,
          gatewayArguments,
          secrets.itemId,
        )],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      },
    }));
    client.submitToolResults([{
      callId: secrets.callId,
      output: { status: secrets.result },
    }], false);

    expect(observations.map((observation) => observation.sequence))
      .toEqual(observations.map((_, index) => index + 1));
    expect(observations.map((observation) => observation.direction))
      .toEqual(expect.arrayContaining(["outbound", "inbound"]));
    for (const [index, observation] of observations.entries()) {
      expect(observation.connectionEpoch).toBe(1);
      expect(observation.previousObservationSha256)
        .toBe(index === 0 ? null : observations[index - 1].observationSha256);
      expect(observation.observationSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(observation.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(observation.projectionSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(observation.payloadBytes).toBeGreaterThan(0);
      expect(Object.isFrozen(observation)).toBe(true);
      expect(Object.isFrozen(observation.projection)).toBe(true);
      expect(observation.projection).not.toHaveProperty("injected");
    }
    expect(verifyRealtimeWireObservationChain(observations)).toEqual({
      valid: true,
      eventCount: observations.length,
      chainHead: observations.at(-1)?.observationSha256,
      errors: [],
    });
    const tampered = structuredClone(observations) as RealtimeWireObservation[];
    (tampered[0].projection as Record<string, unknown>).tampered = true;
    expect(verifyRealtimeWireObservationChain(tampered)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "observation 1 redacted projection hash does not match",
        "observation 1 chain hash does not match",
      ]),
    });
    const accessorEvidence = structuredClone(observations) as RealtimeWireObservation[];
    let getterCalls = 0;
    Object.defineProperty(accessorEvidence[0].projection, "privateAccessor", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return secrets.prompt;
      },
    });
    expect(verifyRealtimeWireObservationChain(accessorEvidence)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["observation 1 is not bounded canonical JSON evidence"]),
    });
    expect(getterCalls).toBe(0);

    const sessionUpdate = observations.find((observation) => (
      observation.direction === "outbound" && observation.wireType === "session.update"
    ));
    expect(sessionUpdate?.projection).toMatchObject({
      session: {
        present: true,
        toolCount: 1,
        inputFormat: PCM,
        outputFormat: PCM,
        configurationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        fieldSha256: {
          model: expect.stringMatching(/^[a-f0-9]{64}$/),
          instructions: expect.stringMatching(/^[a-f0-9]{64}$/),
          tools: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(sessionUpdate?.payloadSha256)
      .toBe(createHash("sha256").update(socket.sent[0], "utf8").digest("hex"));
    expect(sessionUpdate?.payloadBytes).toBe(Buffer.byteLength(socket.sent[0], "utf8"));
    const inputAudio = observations.find((observation) => (
      observation.direction === "outbound" && observation.wireType === "input_audio_buffer.append"
    ));
    expect(inputAudio?.projection).toMatchObject({
      audio: {
        validCanonicalBase64: true,
        byteLength: 4,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        format: PCM,
      },
    });
    expect(recordForTest(inputAudio?.projection.audio).sha256)
      .toBe(createHash("sha256").update(Uint8Array.from([1, 0, 2, 0])).digest("hex"));

    const gatewayCall = observations.find((observation) => (
      observation.wireType === "response.function_call_arguments.done"
    ));
    const gatewayResult = observations.find((observation) => (
      observation.direction === "outbound" && observation.wireType === "conversation.item.create"
    ));
    expect(gatewayCall?.projection).toMatchObject({
      gatewayCalls: [{
        gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        argumentsJsonValid: true,
        argumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        targetToolNameSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        targetArgumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
    expect(gatewayResult?.projection).toMatchObject({
      gatewayResults: [{
        gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        resultJsonValid: true,
        resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
    expect(gatewayResult?.identities.callIdSha256).toBe(gatewayCall?.identities.callIdSha256);
    expect(observations.find((observation) => observation.wireType === "response.done")?.projection)
      .toMatchObject({ terminal: { status: "completed" }, usage: { totalTokens: 10 } });
    for (const event of normalizedEvents.filter((candidate) => (
      candidate.type === "session.ready"
      || candidate.type === "output.audio"
      || candidate.type === "tool.dispatch"
      || candidate.type === "response.completed"
    ))) {
      expect(event.wireObservation).toMatchObject({
        availability: "observed",
        connectionEpoch: 1,
        sequence: expect.any(Number),
        observationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      if (event.wireObservation?.availability === "observed") {
        expect(observations[event.wireObservation.sequence - 1]?.observationSha256)
          .toBe(event.wireObservation.observationSha256);
      }
    }
    expect(normalizedEvents.find((event) => event.type === "tool.dispatch")?.wireObservation)
      .toMatchObject({
        observationSha256: observations.find((observation) => observation.wireType === "response.done")
          ?.observationSha256,
        callIdSha256: gatewayCall?.identities.callIdSha256,
      });

    const serializedEvidence = JSON.stringify(observations);
    for (const secret of Object.values(secrets)) expect(serializedEvidence).not.toContain(secret);
    expect(serializedEvidence).not.toContain(gatewayArguments);
    expect(serializedEvidence).not.toContain("membership.lookup");
  });

  it("never records an outbound wire observation for a frame the socket rejected", async () => {
    const socket = new FakeSocket();
    socket.send = () => { throw new Error("transport rejected frame"); };
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: baseSession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    const observations: RealtimeWireObservation[] = [];
    client.onWireObservation((observation) => observations.push(observation));
    const pending = client.connect();
    socket.emit("open");
    await expect(pending).rejects.toThrow("transport rejected frame");
    expect(observations).toEqual([]);
    expect(client.state).toBe("failed");
  });

  it("rejects an omitted strict acknowledgement before any audio is sent", async () => {
    const transportOnlySocket = new FakeSocket();
    const transportOnlyClient = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: baseSession,
      socketFactory: () => transportOnlySocket,
      connectTimeoutMs: 1_000,
      requireStrictSessionConfigurationParity: true,
    });
    const transportOnlyPending = transportOnlyClient.connect();
    transportOnlySocket.emit("open");
    expect(() => transportOnlyClient.appendInputAudio({
      ...PCM,
      data: Uint8Array.from([1, 0]),
    })).toThrow(/not ready/);
    transportOnlySocket.emit("message", JSON.stringify(sessionAcknowledgement("openai")));
    await expect(transportOnlyPending).rejects.toThrow(/strict configuration parity/);
    expect(transportOnlyClient.state).toBe("failed");
    expect(transportOnlySocket.terminated).toBe(true);
    expect(transportOnlySocket.sent.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ type: "session.update" }),
    ]);
    expect(transportOnlySocket.sent.some((value) => (
      (JSON.parse(value) as { type?: string }).type === "input_audio_buffer.append"
    ))).toBe(false);
  });

  it("uses session.created only for model proof when session.updated omits the model", async () => {
    const socket = new FakeSocket();
    const observed: NormalizedRealtimeEvent[] = [];
    const client = new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime?model=grok-voice-think-fast-1.0",
      sessionUpdate: baseSession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    client.onEvent((event) => observed.push(event));
    const pending = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_1", model: "grok-voice-think-fast-1.0" },
    }));
    socket.emit("message", JSON.stringify(sessionAcknowledgement("xai")));
    await pending;
    expect(observed.find((event) => event.type === "session.ready")).toMatchObject({
      type: "session.ready",
      configuration: {
        fields: {
          model: { status: "verified", acknowledgedBy: "session.created" },
          voice: { status: "not_requested" },
        },
      },
    });
  });

  it("fails closed on malformed, duplicate, or changing model identities", async () => {
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime?model=one&model=one",
      sessionUpdate: baseSession,
    })).toThrow(/more than one model/);
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: { type: "session.update", session: { model: 42 } },
    })).toThrow(/model must be a string/);

    const socket = new FakeSocket();
    const client = new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime?model=grok-voice-think-fast-1.0",
      sessionUpdate: baseSession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    const pending = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_1", model: "grok-voice-think-fast-1.0" },
    }));
    const updated = sessionAcknowledgement("xai") as unknown as Record<string, unknown>;
    recordForTest(updated.session).model = "grok-voice-fast-1.0";
    socket.emit("message", JSON.stringify(updated));
    await expect(pending).rejects.toThrow(/differs from requested model|changed model identity/);
    expect(client.state).toBe("failed");
  });

  it("validates redundant session IDs and pins one identity for the socket lifetime", async () => {
    const changedSocket = new FakeSocket();
    const changedClient = new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime?model=grok-voice-think-fast-1.0",
      sessionUpdate: baseSession,
      socketFactory: () => changedSocket,
      connectTimeoutMs: 1_000,
    });
    const changedPending = changedClient.connect();
    changedSocket.emit("open");
    changedSocket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_original", model: "grok-voice-think-fast-1.0" },
    }));
    changedSocket.emit("message", JSON.stringify(sessionAcknowledgement("xai")));
    await expect(changedPending).rejects.toThrow(/changed session identity/);
    expect(changedClient.state).toBe("failed");

    const contradictorySocket = new FakeSocket();
    const contradictoryClient = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: baseSession,
      socketFactory: () => contradictorySocket,
      connectTimeoutMs: 1_000,
    });
    const contradictoryPending = contradictoryClient.connect();
    contradictorySocket.emit("open");
    contradictorySocket.emit("message", JSON.stringify({
      ...sessionAcknowledgement("openai"),
      session_id: "sess_contradictory",
    }));
    await expect(contradictoryPending).rejects.toThrow(/contradictory session identities/);
    expect(contradictoryClient.state).toBe("failed");

    const emptySocket = new FakeSocket();
    const emptyClient = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: baseSession,
      socketFactory: () => emptySocket,
      connectTimeoutMs: 1_000,
    });
    const emptyPending = emptyClient.connect();
    emptySocket.emit("open");
    const emptyAcknowledgement = sessionAcknowledgement("openai");
    emptyAcknowledgement.session.id = "";
    emptySocket.emit("message", JSON.stringify(emptyAcknowledgement));
    await expect(emptyPending).rejects.toThrow(/session.id must be a non-empty canonical string/);
    expect(emptyClient.state).toBe("failed");
  });

  it("fails the connection when the provider explicitly acknowledges different instructions", async () => {
    const socket = new FakeSocket();
    const requested = structuredClone(baseSession) as typeof baseSession & {
      session: typeof baseSession.session & { instructions: string };
    };
    requested.session.instructions = "Never charge without fresh confirmation.";
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: requested,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    const pending = client.connect();
    socket.emit("open");
    const acknowledged = sessionAcknowledgement("openai") as ReturnType<typeof sessionAcknowledgement> & {
      session: ReturnType<typeof sessionAcknowledgement>["session"] & { instructions: string };
    };
    acknowledged.session.instructions = "Charge whenever convenient.";
    socket.emit("message", JSON.stringify(acknowledged));
    await expect(pending).rejects.toThrow(/instructions differs/);
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
  });

  it("rejects provider-side tool widening and handshake model substitution", async () => {
    const widenedSocket = new FakeSocket();
    const toolSession = structuredClone(baseSession) as unknown as Record<string, unknown>;
    recordForTest(toolSession.session).tools = [];
    const widenedClient = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: toolSession,
      socketFactory: () => widenedSocket,
      connectTimeoutMs: 1_000,
    });
    const widenedPending = widenedClient.connect();
    widenedSocket.emit("open");
    const widenedAck = sessionAcknowledgement("openai") as unknown as Record<string, unknown>;
    recordForTest(widenedAck.session).tools = [{ type: "function", name: "unrequested_mutation" }];
    widenedSocket.emit("message", JSON.stringify(widenedAck));
    await expect(widenedPending).rejects.toThrow(/tools differs/);
    expect(widenedClient.state).toBe("failed");

    const substitutedSocket = new FakeSocket();
    const substitutedClient = new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime?model=grok-voice-think-fast-1.0",
      sessionUpdate: baseSession,
      socketFactory: () => substitutedSocket,
      connectTimeoutMs: 1_000,
    });
    const substitutedPending = substitutedClient.connect();
    substitutedSocket.emit("open");
    substitutedSocket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_1", model: "grok-voice-think-fast-1.0" },
    }));
    const substitutedAck = sessionAcknowledgement("xai") as unknown as Record<string, unknown>;
    recordForTest(substitutedAck.session).model = "grok-voice-fast-1.0";
    substitutedSocket.emit("message", JSON.stringify(substitutedAck));
    await expect(substitutedPending).rejects.toThrow(/differs from requested model/);
    expect(substitutedClient.state).toBe("failed");
  });

  it("rejects nested tool-schema and tool-choice capability widening", async () => {
    const requestedTool = {
      type: "function",
      name: "lookup_member",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { member_id: { type: "string" } },
        required: ["member_id"],
      },
    };
    const omission = buildSessionConfigurationAcknowledgement({
      provider: "xai",
      requestedUpdate: {
        type: "session.update",
        session: { tools: [requestedTool] },
      },
      acknowledgedEvent: {
        type: "session.updated",
        session: { tools: [{ type: "function" }] },
      },
    });
    expect(omission.fields.tools).toMatchObject({
      status: "unverifiable",
      omission: {
        kind: "requested_paths_omitted",
        paths: ["tools[0].name", "tools[0].parameters"],
      },
    });

    const schemaSocket = new FakeSocket();
    const schemaClient = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: {
        ...baseSession,
        session: { ...baseSession.session, tools: [requestedTool], tool_choice: "auto" },
      },
      socketFactory: () => schemaSocket,
      connectTimeoutMs: 1_000,
    });
    const schemaPending = schemaClient.connect();
    schemaSocket.emit("open");
    const schemaAck = JSON.parse(schemaSocket.sent[0]) as Record<string, unknown>;
    const acknowledgedTool = recordForTest((recordForTest(schemaAck.session).tools as unknown[])[0]);
    const acknowledgedParameters = recordForTest(acknowledgedTool.parameters);
    acknowledgedParameters["x-provider-extension"] = { permits: "unrequested" };
    schemaSocket.emit("message", JSON.stringify({ type: "session.updated", session: schemaAck.session }));
    await expect(schemaPending).rejects.toThrow(/tools differs/);
    expect(schemaClient.state).toBe("failed");

    const choiceSocket = new FakeSocket();
    const choiceClient = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: {
        ...baseSession,
        session: {
          ...baseSession.session,
          tools: [requestedTool],
          tool_choice: { type: "function", name: "lookup_member" },
        },
      },
      socketFactory: () => choiceSocket,
      connectTimeoutMs: 1_000,
    });
    const choicePending = choiceClient.connect();
    choiceSocket.emit("open");
    const choiceAck = JSON.parse(choiceSocket.sent[0]) as Record<string, unknown>;
    recordForTest(recordForTest(choiceAck.session).tool_choice).fallback = "auto";
    choiceSocket.emit("message", JSON.stringify({ type: "session.updated", session: choiceAck.session }));
    await expect(choicePending).rejects.toThrow(/tool_choice differs/);
    expect(choiceClient.state).toBe("failed");
  });

  it("rejects an acknowledgement that did not preserve manual PCM invariants", async () => {
    const { client, socket } = fakeClient();
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    const pending = client.connect();
    socket.emit("open");
    const wrong = sessionAcknowledgement("openai") as Record<string, unknown>;
    const session = wrong.session as { audio: { input: { turn_detection: unknown } } };
    session.audio.input.turn_detection = { type: "server_vad" };
    socket.emit("message", JSON.stringify(wrong));
    await expect(pending).rejects.toThrow(/acknowledgement mismatch/);
    expect(client.state).toBe("failed");
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "session_ack_mismatch",
      fatal: true,
    }));
    expect(observed.some((event) => event.type === "session.ready")).toBe(false);
  });

  it("rejects application and tool traffic that races the configuration acknowledgement", async () => {
    const { client, socket } = fakeClient();
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    const pending = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "response_too_early",
      call_id: "call_too_early",
      name: "charge_card",
      arguments: "{}",
    }));

    await expect(pending).rejects.toThrow(/before session configuration was acknowledged/);
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
    expect(observed.some((event) => event.type === "tool.calls" || event.type === "tool.dispatch")).toBe(false);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "pre_ready_application_event",
      fatal: true,
    }));
  });

  it("accepts xAI keepalive pings before session configuration acknowledgement", async () => {
    const { client, socket } = fakeClient("xai");
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    const pending = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({
      type: "ping",
      event_id: "keepalive_1",
      timestamp: 1_752_000_000,
    }));

    expect(client.state).toBe("connecting");
    expect(observed).not.toContainEqual(expect.objectContaining({
      type: "error",
      code: "pre_ready_application_event",
    }));

    socket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_1" },
    }));
    socket.emit("message", JSON.stringify(sessionAcknowledgement("xai")));
    await pending;
    expect(client.state).toBe("ready");
  });

  it("revalidates every post-ready session.updated against the frozen configuration", async () => {
    const exact = fakeClient();
    const exactEvents: NormalizedRealtimeEvent[] = [];
    exact.client.onEvent((event) => exactEvents.push(event));
    await connect(exact.client, exact.socket);
    exact.socket.emit("message", JSON.stringify(sessionAcknowledgement("openai")));
    expect(exact.client.state).toBe("ready");
    expect(exactEvents.filter((event) => event.type === "session.ready")).toHaveLength(1);
    expect(exactEvents).toContainEqual(expect.objectContaining({
      type: "provider.event",
      data: expect.objectContaining({ name: "session.configuration_reverified" }),
    }));

    const widened = fakeClient();
    const widenedEvents: NormalizedRealtimeEvent[] = [];
    widened.client.onEvent((event) => widenedEvents.push(event));
    await connect(widened.client, widened.socket);
    const changed = sessionAcknowledgement("openai") as unknown as Record<string, unknown>;
    recordForTest(changed.session).tools = [{ type: "function", name: "charge_card" }];
    widened.socket.emit("message", JSON.stringify(changed));

    expect(widened.client.state).toBe("failed");
    expect(widened.socket.terminated).toBe(true);
    expect(widenedEvents.filter((event) => event.type === "session.ready")).toHaveLength(1);
    expect(widenedEvents).toContainEqual(expect.objectContaining({
      type: "error",
      code: "session_ack_mismatch",
      message: expect.stringContaining("frozen session requested none"),
      fatal: true,
    }));
  });

  it("uses explicit append, commit, response boundaries for true PCM turns", async () => {
    const { client, socket } = fakeClient();
    await connect(client, socket);
    socket.sent.length = 0;
    client.sendTurn({ ...PCM, data: Uint8Array.from([1, 0, 2, 0]) });
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "input_audio_buffer.append", audio: "AQACAA==" },
      { type: "input_audio_buffer.commit" },
      { type: "response.create" },
    ]);
  });

  it("binds xAI server-VAD control acknowledgement before audio and accepts only the provider-native turn order", async () => {
    const serverVadSession = {
      type: "session.update",
      session: {
        instructions: "immutable base",
        audio: {
          input: { format: { type: "audio/pcm", rate: 24_000 } },
          output: { format: { type: "audio/pcm", rate: 24_000 } },
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.85,
          silence_duration_ms: 500,
          prefix_padding_ms: 333,
          idle_timeout_ms: null,
        },
      },
    };
    const { client, socket } = fakeClient("xai", { sessionUpdate: serverVadSession });
    const events: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => events.push(event));
    client.onWireObservation(() => undefined);
    const connecting = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_server_vad" },
    }));
    const initialUpdate = JSON.parse(socket.sent.at(-1)!);
    socket.emit("message", JSON.stringify({
      type: "session.updated",
      session: { id: "sess_server_vad", ...initialUpdate.session },
    }));
    await connecting;
    socket.sent.length = 0;

    const additionalInstructions = "Classify and invoke only the current closed frontier.";
    await expect(client.prepareServerVadTurn!({
      additionalInstructions,
      contextSha256: createHash("sha256").update(additionalInstructions).digest("hex"),
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
      tools: [LOCAL_TOOL_PROXY_FUNCTION],
      toolFrontierSha256: realtimeToolFrontierSha256([LOCAL_TOOL_PROXY_FUNCTION]),
      transportParitySha256: client.serverVadTransportParitySha256!,
    }, 100)).rejects.toThrow("frozen matched-pair gateway schema");
    const tools: readonly Readonly<Record<string, unknown>>[] = [];
    const preparation = client.prepareServerVadTurn!({
      additionalInstructions,
      contextSha256: createHash("sha256").update(additionalInstructions).digest("hex"),
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
      tools,
      toolFrontierSha256: realtimeToolFrontierSha256(tools),
      transportParitySha256: client.serverVadTransportParitySha256!,
    }, 100);
    expect(() => client.appendInputAudio({ ...PCM, data: Uint8Array.from([1, 0]) }))
      .toThrow("acknowledged before audio");
    const perTurnUpdate = JSON.parse(socket.sent.at(-1)!);
    expect(perTurnUpdate).toMatchObject({
      type: "session.update",
      session: {
        instructions: `immutable base\n${additionalInstructions}`,
        tools: [],
        tool_choice: "auto",
        turn_detection: { type: "server_vad" },
      },
    });
    socket.emit("message", JSON.stringify({
      type: "session.updated",
      session: { id: "sess_server_vad", ...perTurnUpdate.session },
    }));
    const acknowledgement = await preparation;
    expect(acknowledgement).toMatchObject({
      provider: "xai",
      status: "acknowledged",
      turnOrdinal: 1,
      contextSha256: createHash("sha256").update(additionalInstructions).digest("hex"),
      outboundObservation: { availability: "observed" },
      inboundObservation: { availability: "observed" },
    });

    client.appendInputAudio({ ...PCM, data: Uint8Array.from([1, 0, 2, 0]) });
    expect(() => client.commitInputAudio()).toThrow("forbidden");
    expect(() => client.createResponse()).toThrow("Initial response.create is forbidden");
    socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started", event_id: "vad-start-1" }));
    socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_stopped", event_id: "vad-stop-1" }));
    socket.emit("message", JSON.stringify({ type: "input_audio_buffer.committed", event_id: "vad-commit-1", item_id: "item-1" }));
    socket.emit("message", JSON.stringify({
      type: "response.created",
      event_id: "response-start-1",
      response: { id: "response-1", status: "in_progress", output: [] },
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      event_id: "response-done-1",
      response: {
        id: "response-1",
        status: "completed",
        output: [{
          type: "function_call",
          id: "item-tool-1",
          call_id: "call-tool-1",
          name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
          arguments: JSON.stringify({ tool_name: "complete_current_stage", arguments: {} }),
        }],
        usage: { total_tokens: 1 },
      },
    }));

    expect(client.state).toBe("ready");
    expect(events).toContainEqual(expect.objectContaining({ type: "input.speech_activity", phase: "started" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "input.speech_activity", phase: "stopped" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "input.audio_committed", commitOrdinal: 1 }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.started",
      responseId: "response-1",
      causalBinding: expect.objectContaining({
        trigger: "server_vad_speech_stopped",
        turnOrdinal: 1,
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.calls",
      responseId: "response-1",
    }));
    // The provider may finish a tool-bearing root response between silence
    // delimiter frames. The post-stop guard must win over the now-pending tool
    // batch so the adapter can recognize an exact accepted delimiter prefix.
    expect(() => client.appendInputAudio({ ...PCM, data: new Uint8Array(960) }))
      .toThrow(XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR);
    const outboundTypes = socket.sent.map((frame) => JSON.parse(frame).type);
    expect(outboundTypes.filter((type) => type === "input_audio_buffer.commit")).toHaveLength(0);
    expect(outboundTypes.filter((type) => type === "response.create")).toHaveLength(0);
  });

  it("fails closed when xAI server-VAD stops speech before it starts", async () => {
    const { client, socket } = fakeClient("xai", {
      sessionUpdate: {
        type: "session.update",
        session: {
          audio: { input: {}, output: {} },
          turn_detection: { type: "server_vad", threshold: 0.85, silence_duration_ms: 500, prefix_padding_ms: 333, idle_timeout_ms: null },
        },
      },
    });
    const connecting = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_bad_order" },
    }));
    const initialUpdate = JSON.parse(socket.sent.at(-1)!);
    socket.emit("message", JSON.stringify({ type: "session.updated", session: { id: "sess_bad_order", ...initialUpdate.session } }));
    await connecting;
    const control = "Use only this turn's exact frontier.";
    const pending = client.prepareServerVadTurn!({
      additionalInstructions: control,
      contextSha256: createHash("sha256").update(control).digest("hex"),
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
      tools: [],
      toolFrontierSha256: realtimeToolFrontierSha256([]),
      transportParitySha256: client.serverVadTransportParitySha256!,
    }, 100);
    const update = JSON.parse(socket.sent.at(-1)!);
    socket.emit("message", JSON.stringify({ type: "session.updated", session: { id: "sess_bad_order", ...update.session } }));
    await pending;
    client.appendInputAudio({ ...PCM, data: Uint8Array.from([1, 0]) });
    socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_stopped", event_id: "bad-stop" }));
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
  });

  it("offers an opt-in ordered commit acknowledgement barrier without blocking ordinary turns", async () => {
    const { client, socket } = fakeClient("xai");
    const events: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => events.push(event));
    await connect(client, socket);

    client.appendInputAudio({ ...PCM, data: Uint8Array.from([1, 0]) });
    client.commitInputAudio();
    client.createResponse();
    socket.emit("message", JSON.stringify({
      type: "input_audio_buffer.committed",
      event_id: "evt_commit_1",
      item_id: "item_audio_1",
    }));
    const acknowledgement = await client.waitForInputAudioCommit(100);
    expect(acknowledgement).toMatchObject({
      provider: "xai",
      connectionEpoch: 1,
      commitOrdinal: 1,
      status: "acknowledged",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "input.audio_committed",
      commitOrdinal: 1,
    }));

    // No acknowledgement is required to keep the default, non-barrier path usable.
    client.appendInputAudio({ ...PCM, data: Uint8Array.from([2, 0]) });
    client.commitInputAudio();
    client.createResponse();
    client.appendInputAudio({ ...PCM, data: Uint8Array.from([3, 0]) });
    client.commitInputAudio();
    client.createResponse();
  });

  it("accepts an xAI commit acknowledgement after 5 seconds but before the bounded LC4 deadline", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = fakeClient("xai");
      await connect(client, socket);
      client.appendInputAudio({ ...PCM, data: Uint8Array.from([1, 0]) });
      client.commitInputAudio();

      const turn = (async () => {
        await client.waitForInputAudioCommit(
          LC4_DEV_TIMEOUT_CONTRACT.maximum_provider_control_or_commit_ack_ms,
        );
        client.createResponse();
      })();
      setTimeout(() => socket.emit("message", JSON.stringify({
        type: "input_audio_buffer.committed",
        event_id: "evt_delayed_commit",
        item_id: "item_delayed_audio",
      })), 6_000);

      await vi.advanceTimersByTimeAsync(5_999);
      expect(socket.sent.map((frame) => JSON.parse(frame).type))
        .not.toContain("response.create");
      await vi.advanceTimersByTimeAsync(1);
      await turn;
      expect(socket.sent.map((frame) => JSON.parse(frame).type)
        .filter((type) => type === "response.create")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed at the bounded LC4 commit deadline before response generation", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = fakeClient("xai");
      await connect(client, socket);
      client.appendInputAudio({ ...PCM, data: Uint8Array.from([1, 0]) });
      client.commitInputAudio();
      const pending = client.waitForInputAudioCommit(
        LC4_DEV_TIMEOUT_CONTRACT.maximum_provider_control_or_commit_ack_ms,
      );
      const rejected = expect(pending).rejects.toThrow(
        /timed out after 15000 ms/u,
      );

      await vi.advanceTimersByTimeAsync(
        LC4_DEV_TIMEOUT_CONTRACT.maximum_provider_control_or_commit_ack_ms,
      );
      await rejected;
      expect(socket.sent.map((frame) => JSON.parse(frame).type))
        .not.toContain("response.create");
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies manual-mode provider VAD activity and deduplicates native event replays", async () => {
    const diagnostic = fakeClient("xai");
    const observed: NormalizedRealtimeEvent[] = [];
    diagnostic.client.onEvent((event) => observed.push(event));
    await connect(diagnostic.client, diagnostic.socket);
    const speechStarted = {
      type: "input_audio_buffer.speech_started",
      event_id: "evt_speech_1",
      item_id: "item_audio_1",
      audio_start_ms: 0,
    };
    diagnostic.socket.emit("message", JSON.stringify(speechStarted));
    diagnostic.socket.emit("message", JSON.stringify(speechStarted));
    expect(observed.filter(
      (event) => event.type === "error" && event.code === "unexpected_manual_turn_detection_event",
    )).toHaveLength(1);
    expect(diagnostic.client.state).toBe("ready");

    const strict = fakeClient("xai", { unexpectedManualTurnDetectionPolicy: "fail" });
    const strictEvents: NormalizedRealtimeEvent[] = [];
    strict.client.onEvent((event) => strictEvents.push(event));
    await connect(strict.client, strict.socket);
    strict.socket.emit("message", JSON.stringify({
      ...speechStarted,
      event_id: "evt_speech_strict",
    }));
    expect(strict.client.state).toBe("failed");
    expect(strictEvents).toContainEqual(expect.objectContaining({
      type: "error",
      code: "unexpected_manual_turn_detection_event",
      fatal: true,
      details: expect.objectContaining({ classification: "manual_mode_provider_vad_activity" }),
    }));
  });

  it("requires explicit response and item targets for cancel/truncate repair", async () => {
    const { client, socket } = fakeClient();
    await connect(client, socket);
    socket.sent.length = 0;
    client.cancelResponse({ responseId: "resp_target" });
    client.cancelResponse({ responseId: "resp_target" });
    client.truncateOutputAudio({
      responseId: "resp_target",
      itemId: "item_target",
      contentIndex: 0,
      audioEndMs: 1_275,
    });
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "response.cancel", response_id: "resp_target" },
      {
        type: "conversation.item.truncate",
        item_id: "item_target",
        content_index: 0,
        audio_end_ms: 1_275,
      },
    ]);

    const before = socket.sent.length;
    expect(() => client.cancelResponse(undefined as never)).toThrow(/responseId/);
    expect(() => client.cancelResponse({ responseId: "response with spaces" })).toThrow(/canonical ASCII token/);
    expect(() => client.truncateOutputAudio({
      responseId: "resp_target",
      itemId: "item_target",
      contentIndex: 1,
      audioEndMs: 10,
    } as never)).toThrow(/contentIndex must be 0/);
    expect(() => client.truncateOutputAudio({
      responseId: "resp_target",
      itemId: "item_target",
      contentIndex: 0,
      audioEndMs: 1.5,
    })).toThrow(/non-negative safe integer/);
    expect(() => client.truncateOutputAudio({
      responseId: "response_not_cancelled",
      itemId: "item_target",
      contentIndex: 0,
      audioEndMs: 10,
    })).toThrow(/Cancel response response_not_cancelled/);
    expect(socket.sent).toHaveLength(before);
  });

  it("seals a locally cancelled response against late audio and executable work", async () => {
    const cancelled = fakeClient("openai");
    const cancelledEvents: NormalizedRealtimeEvent[] = [];
    cancelled.client.onEvent((event) => cancelledEvents.push(event));
    await connect(cancelled.client, cancelled.socket);
    cancelled.client.cancelResponse({ responseId: "r_local_cancel" });
    cancelled.socket.emit("message", JSON.stringify({
      type: "response.output_audio.delta",
      response_id: "r_local_cancel",
      delta: "AQI=",
    }));
    cancelled.socket.emit("message", JSON.stringify({
      type: "response.cancelled",
      response_id: "r_local_cancel",
      reason: "client_cancelled",
    }));
    expect(cancelled.client.state).toBe("ready");
    expect(cancelledEvents.some((event) => event.type === "output.audio")).toBe(false);
    expect(cancelledEvents).toContainEqual(expect.objectContaining({
      type: "response.completed",
      responseId: "r_local_cancel",
      status: "cancelled",
    }));

    const violated = fakeClient("openai");
    const violatedEvents: NormalizedRealtimeEvent[] = [];
    violated.client.onEvent((event) => violatedEvents.push(event));
    await connect(violated.client, violated.socket);
    violated.client.cancelResponse({ responseId: "r_cancel_violation" });
    violated.socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "r_cancel_violation",
      call_id: "call_after_local_cancel",
      name: "unsafe_mutation",
      arguments: "{}",
    }));
    violated.socket.emit("message", JSON.stringify({
      type: "response.done",
      response: {
        id: "r_cancel_violation",
        status: "completed",
        output: [terminalToolOutput("call_after_local_cancel", "unsafe_mutation")],
      },
    }));
    expect(violated.client.state).toBe("failed");
    expect(violatedEvents.some((event) => event.type === "tool.calls")).toBe(false);
    expect(violatedEvents).toContainEqual(expect.objectContaining({
      type: "error",
      code: "cancelled_response_became_executable",
      fatal: true,
    }));
  });

  it("submits every tool result before one continuation response", async () => {
    const { client, socket } = fakeClient("xai");
    const events: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => events.push(event));
    await connect(client, socket);
    deliverToolBatch(socket, [
      { callId: "call_1", name: "lookup" },
      { callId: "call_2", name: "quote" },
    ]);
    socket.sent.length = 0;
    client.submitToolResults([
      { callId: "call_1", output: { member: "active" } },
      { callId: "call_2", output: "quoted" },
    ]);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "call_1", output: "{\"member\":\"active\"}" },
      },
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "call_2", output: "quoted" },
      },
      { type: "response.create" },
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.results.submitted",
      responseId: "r_tools",
      responseIdSource: "provider",
      callIds: ["call_1", "call_2"],
      continuationRequested: true,
    }));

    socket.emit("message", JSON.stringify({
      type: "response.created",
      response: { id: "r_post_tool", status: "in_progress" },
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: { id: "r_post_tool", status: "completed", output: [] },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.started",
      responseId: "r_post_tool",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.completed",
      responseId: "r_post_tool",
      status: "completed",
    }));
  });

  it("requires the exact local gateway declaration before enabling authoritative dispatch", () => {
    const weakened = structuredClone(LOCAL_TOOL_PROXY_FUNCTION) as unknown as {
      parameters: { properties: { tool_name: { pattern: string } } };
    };
    weakened.parameters.properties.tool_name.pattern = ".*";
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: {
        ...baseSession,
        session: { ...baseSession.session, tools: [weakened] },
      },
      socketFactory: () => new FakeSocket(),
    })).toThrow(/exact local capability gateway contract/);

    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime",
      sessionUpdate: {
        ...baseSession,
        session: {
          ...baseSession.session,
          tools: [LOCAL_TOOL_PROXY_FUNCTION, LOCAL_TOOL_PROXY_FUNCTION],
        },
      },
      socketFactory: () => new FakeSocket(),
    })).toThrow(/more than once/);
  });

  it("emits one MCP-ready local dispatch batch with host-bound native provenance", async () => {
    const socket = new FakeSocket();
    const observed: NormalizedRealtimeEvent[] = [];
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: localProxySession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    socket.sent.length = 0;
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      event_id: "evt_arguments_native",
      response_id: "resp_native",
      item_id: "item_native",
      call_id: "call_native",
      name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      arguments: JSON.stringify({
        tool_name: "renew_membership",
        arguments: {
          member_id: "member_42",
          _meta: { provider_call_id: "model-forged", response_id: "model-forged" },
        },
      }),
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      event_id: "evt_terminal_native",
      response: {
        id: "resp_native",
        status: "completed",
        output: [terminalToolOutput(
          "call_native",
          LOCAL_TOOL_PROXY_FUNCTION_NAME,
          JSON.stringify({
            tool_name: "renew_membership",
            arguments: {
              member_id: "member_42",
              _meta: { provider_call_id: "model-forged", response_id: "model-forged" },
            },
          }),
          "item_native",
        )],
      },
    }));

    const dispatch = observed.find((event) => event.type === "tool.dispatch");
    expect(dispatch).toMatchObject({
      type: "tool.dispatch",
      provider: "openai",
      responseId: "resp_native",
      nativeEventId: "evt_terminal_native",
      gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      dispatches: [{
        callId: "call_native",
        request: {
          method: "tools/call",
          params: {
            name: "renew_membership",
            arguments: {
              member_id: "member_42",
              _meta: { provider_call_id: "model-forged", response_id: "model-forged" },
            },
            _meta: {
              [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: "call_native",
              [PROVIDER_PROVENANCE_META_KEY]: {
                schemaVersion: 1,
                provider: "openai",
                nativeCallId: "call_native",
                nativeResponseId: "resp_native",
                nativeItemId: "item_native",
                terminalEventId: "evt_terminal_native",
                terminalWireType: "response.done",
              },
            },
          },
        },
      }],
    });
    expect(Object.isFrozen(dispatch)).toBe(true);
    if (dispatch?.type === "tool.dispatch") {
      expect(Object.isFrozen(dispatch.dispatches[0]?.request.params._meta)).toBe(true);
      expect(dispatch.dispatches[0]?.provenance).toBe(
        dispatch.dispatches[0]?.request.params._meta[PROVIDER_PROVENANCE_META_KEY],
      );
    }
    expect(observed.filter((event) => event.type === "tool.dispatch")).toHaveLength(1);
    expect(observed.some((event) => event.type === "tool.calls")).toBe(false);

    expect(() => client.submitToolResults([{ callId: "model-forged", output: "no" }]))
      .toThrow(/unknown: model-forged/);
    expect(socket.sent).toEqual([]);
    client.submitToolResults([{ callId: "call_native", output: { renewed: true } }], false);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([{
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call_native",
        output: "{\"renewed\":true}",
      },
    }]);
  });

  it.each(["openai", "xai"] as const)(
    "hash-binds current control to an explicit %s tool continuation",
    async (provider) => {
      const socket = new FakeSocket();
      const observations: RealtimeWireObservation[] = [];
      const client = new OpenAICompatibleRealtimeClient({
        provider,
        url: `wss://${provider}.example/realtime`,
        sessionUpdate: localProxySession,
        socketFactory: () => socket,
        connectTimeoutMs: 1_000,
      });
      client.onWireObservation((observation) => observations.push(observation));
      await connect(client, socket);
      socket.sent.length = 0;

      const argumentsText = JSON.stringify({
        tool_name: "complete_current_stage",
        arguments: {},
      });
      socket.emit("message", JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "response_control_rebind",
        item_id: "item_control_rebind",
        call_id: "call_control_rebind",
        name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        arguments: argumentsText,
      }));
      socket.emit("message", JSON.stringify({
        type: "response.done",
        response: {
          id: "response_control_rebind",
          status: "completed",
          output: [terminalToolOutput(
            "call_control_rebind",
            LOCAL_TOOL_PROXY_FUNCTION_NAME,
            argumentsText,
            "item_control_rebind",
          )],
        },
      }));

      const control =
        "<hacc_response_plan>{\"revision\":20,\"phase\":\"canonical\"}</hacc_response_plan>";
      const contextSha256 = createHash("sha256").update(control).digest("hex");
      client.prepareToolContinuation({
        additionalInstructions: control,
        contextSha256,
        contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
      });
      client.submitToolResults([{
        callId: "call_control_rebind",
        output: { ok: false, code: "capability_request_rejected" },
      }], false);
      client.createResponse();

      const frames = socket.sent.map((value) => JSON.parse(value));
      expect(frames.at(-1)).toEqual({
        type: "response.create",
        response: { instructions: control },
      });
      const continuation = observations.findLast((entry) => (
        entry.direction === "outbound" && entry.wireType === "response.create"
      ));
      expect(continuation?.projection).toMatchObject({
        dynamicControl: {
          sha256: contextSha256,
          byteLength: Buffer.byteLength(control, "utf8"),
          authority: "advisory_only_gateway_and_speech_gate_enforced",
        },
      });
    },
  );

  for (const variant of [
    { id: "required", toolChoice: "required" as const },
    {
      id: "forced_function",
      toolChoice: { type: "function" as const, name: LOCAL_TOOL_PROXY_FUNCTION_NAME },
    },
  ] as const) {
    it(`admits a duplicated incremental-plus-terminal gateway call before completion for ${variant.id}`, async () => {
      const socket = new FakeSocket();
      const observed: NormalizedRealtimeEvent[] = [];
      const client = new OpenAICompatibleRealtimeClient({
        provider: "openai",
        url: "wss://openai.example/realtime",
        sessionUpdate: localProxySession,
        socketFactory: () => socket,
        connectTimeoutMs: 1_000,
      });
      client.onEvent((event) => observed.push(event));
      await connect(client, socket);
      observed.length = 0;
      socket.sent.length = 0;
      client.createResponse({ tool_choice: variant.toolChoice });

      const argumentsText = JSON.stringify({
        tool_name: "complete_current_stage",
        arguments: {},
      });
      socket.emit("message", JSON.stringify({
        type: "response.output_item.added",
        event_id: `evt_added_${variant.id}`,
        response_id: `resp_${variant.id}`,
        output_index: 0,
        item: {
          type: "function_call",
          id: `item_${variant.id}`,
          call_id: `call_${variant.id}`,
          name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
          arguments: "",
        },
      }));
      for (const delta of [argumentsText.slice(0, 17), argumentsText.slice(17)]) {
        socket.emit("message", JSON.stringify({
          type: "response.function_call_arguments.delta",
          response_id: `resp_${variant.id}`,
          item_id: `item_${variant.id}`,
          call_id: `call_${variant.id}`,
          delta,
        }));
      }
      socket.emit("message", JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: `resp_${variant.id}`,
        item_id: `item_${variant.id}`,
        call_id: `call_${variant.id}`,
        name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        arguments: argumentsText,
      }));
      socket.emit("message", JSON.stringify({
        type: "response.output_item.done",
        response_id: `resp_${variant.id}`,
        output_index: 0,
        item: terminalToolOutput(
          `call_${variant.id}`,
          LOCAL_TOOL_PROXY_FUNCTION_NAME,
          argumentsText,
          `item_${variant.id}`,
        ),
      }));
      socket.emit("message", JSON.stringify({
        type: "response.done",
        event_id: `evt_done_${variant.id}`,
        response: {
          id: `resp_${variant.id}`,
          status: "completed",
          output: [terminalToolOutput(
            `call_${variant.id}`,
            LOCAL_TOOL_PROXY_FUNCTION_NAME,
            argumentsText,
            `item_${variant.id}`,
          )],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      }));

      expect(JSON.parse(socket.sent[0]!)).toMatchObject({
        type: "response.create",
        response: { tool_choice: variant.toolChoice },
      });
      const terminal = observed.filter((event) => (
        event.type === "tool.dispatch"
        || event.type === "usage"
        || event.type === "response.completed"
      ));
      expect(terminal.map((event) => event.type)).toEqual([
        "tool.dispatch",
        "usage",
        "response.completed",
      ]);
      expect(terminal[0]).toMatchObject({
        type: "tool.dispatch",
        nativeEventId: `evt_done_${variant.id}`,
        responseId: `resp_${variant.id}`,
        dispatches: [{
          callId: `call_${variant.id}`,
          provenance: {
            nativeCallId: `call_${variant.id}`,
            nativeResponseId: `resp_${variant.id}`,
            nativeItemId: `item_${variant.id}`,
            terminalEventId: `evt_done_${variant.id}`,
            terminalWireType: "response.done",
          },
        }],
      });
      expect(observed.filter((event) => event.type === "tool.dispatch")).toHaveLength(1);
      expect(observed.some((event) => event.type === "tool.calls")).toBe(false);
    });
  }

  it("fails closed when model arguments try to overwrite local-dispatch provenance", async () => {
    const socket = new FakeSocket();
    const observed: NormalizedRealtimeEvent[] = [];
    const client = new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime",
      sessionUpdate: localProxySession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "resp_forged_meta",
      call_id: "call_forged_meta",
      name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      arguments: JSON.stringify({
        tool_name: "charge_card",
        arguments: { amount: 50 },
        _meta: { nativeCallId: "attacker-selected" },
      }),
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      event_id: "evt_forged_meta",
      response: {
        id: "resp_forged_meta",
        status: "completed",
        output: [terminalToolOutput(
          "call_forged_meta",
          LOCAL_TOOL_PROXY_FUNCTION_NAME,
          JSON.stringify({
            tool_name: "charge_card",
            arguments: { amount: 50 },
            _meta: { nativeCallId: "attacker-selected" },
          }),
        )],
      },
    }));
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
    expect(observed.some((event) => event.type === "tool.dispatch")).toBe(false);
    expect(observed.some((event) => event.type === "tool.calls")).toBe(false);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "invalid_local_tool_proxy_call",
      fatal: true,
      message: expect.stringContaining("provenance is host-owned"),
    }));
  });

  it("fails the whole local batch when one sibling call is malformed", async () => {
    const socket = new FakeSocket();
    const observed: NormalizedRealtimeEvent[] = [];
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: localProxySession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    const goodArguments = JSON.stringify({
      tool_name: "charge_card",
      arguments: { amount: 25 },
    });
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "resp_atomic_batch",
      item_id: "item_atomic_good",
      call_id: "call_atomic_good",
      name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      arguments: goodArguments,
    }));
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "resp_atomic_batch",
      item_id: "item_atomic_bad",
      call_id: "call_atomic_bad",
      name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      arguments: "{broken",
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: {
        id: "resp_atomic_batch",
        status: "completed",
        output: [
          terminalToolOutput(
            "call_atomic_good",
            LOCAL_TOOL_PROXY_FUNCTION_NAME,
            goodArguments,
            "item_atomic_good",
          ),
          terminalToolOutput(
            "call_atomic_bad",
            LOCAL_TOOL_PROXY_FUNCTION_NAME,
            "{broken",
            "item_atomic_bad",
          ),
        ],
      },
    }));
    expect(client.state).toBe("failed");
    expect(observed.some((event) => event.type === "tool.dispatch")).toBe(false);
    expect(observed.some((event) => event.type === "tool.calls")).toBe(false);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: expect.stringMatching(/invalid_tool_call(_batch)?/),
      fatal: true,
    }));
  });

  it("requires exact terminal output membership before any local call is executable", async () => {
    const socket = new FakeSocket();
    const observed: NormalizedRealtimeEvent[] = [];
    const client = new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime",
      sessionUpdate: localProxySession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "resp_omitted_call",
      item_id: "item_omitted_call",
      call_id: "call_omitted_call",
      name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      arguments: JSON.stringify({ tool_name: "charge_card", arguments: { amount: 25 } }),
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: { id: "resp_omitted_call", status: "completed", output: [] },
    }));
    expect(client.state).toBe("failed");
    expect(observed.some((event) => event.type === "tool.dispatch")).toBe(false);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "tool_call_terminal_membership_mismatch",
      fatal: true,
    }));
  });

  it("rejects duplicate native item ownership before either call can dispatch", async () => {
    const socket = new FakeSocket();
    const observed: NormalizedRealtimeEvent[] = [];
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: localProxySession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    for (const callId of ["call_item_owner_a", "call_item_owner_b"]) {
      socket.emit("message", JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_item_owner",
        item_id: "item_shared_owner",
        call_id: callId,
        name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        arguments: JSON.stringify({ tool_name: "lookup_member", arguments: {} }),
      }));
    }
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
    expect(observed.some((event) => event.type === "tool.dispatch")).toBe(false);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "invalid_provider_tool_call_identity",
      message: expect.stringContaining("item_shared_owner"),
      fatal: true,
    }));
  });

  it("fails closed on excessively deep or non-finite local gateway arguments", async () => {
    const deepArguments: Record<string, unknown> = {};
    let cursor = deepArguments;
    for (let depth = 0; depth < 70; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const cases = [
      JSON.stringify({ tool_name: "lookup_member", arguments: deepArguments }),
      "{\"tool_name\":\"charge_card\",\"arguments\":{\"amount\":1e400}}",
    ];
    for (const [index, argumentsText] of cases.entries()) {
      const socket = new FakeSocket();
      const observed: NormalizedRealtimeEvent[] = [];
      const client = new OpenAICompatibleRealtimeClient({
        provider: "openai",
        url: "wss://openai.example/realtime",
        sessionUpdate: localProxySession,
        socketFactory: () => socket,
        connectTimeoutMs: 1_000,
      });
      client.onEvent((event) => observed.push(event));
      await connect(client, socket);
      const callId = `call_bad_arguments_${index}`;
      socket.emit("message", JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: `resp_bad_arguments_${index}`,
        item_id: `item_bad_arguments_${index}`,
        call_id: callId,
        name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        arguments: argumentsText,
      }));
      socket.emit("message", JSON.stringify({
        type: "response.done",
        response: {
          id: `resp_bad_arguments_${index}`,
          status: "completed",
          output: [terminalToolOutput(
            callId,
            LOCAL_TOOL_PROXY_FUNCTION_NAME,
            argumentsText,
            `item_bad_arguments_${index}`,
          )],
        },
      }));
      expect(client.state).toBe("failed");
      expect(observed.some((event) => event.type === "tool.dispatch")).toBe(false);
      expect(observed).toContainEqual(expect.objectContaining({
        type: "error",
        code: "invalid_local_tool_proxy_call",
        fatal: true,
      }));
    }
  });

  it("rejects undeclared native functions when the local proxy contract is active", async () => {
    const socket = new FakeSocket();
    const observed: NormalizedRealtimeEvent[] = [];
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: localProxySession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    deliverToolBatch(socket, [{ callId: "call_widened", name: "charge_card" }], "resp_widened");
    expect(client.state).toBe("failed");
    expect(observed.some((event) => event.type === "tool.dispatch")).toBe(false);
    expect(observed.some((event) => event.type === "tool.calls")).toBe(false);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "invalid_local_tool_proxy_call",
      fatal: true,
    }));
  });

  it("rejects native call IDs that cannot fit the durable MCP invocation key", async () => {
    const socket = new FakeSocket();
    const observed: NormalizedRealtimeEvent[] = [];
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: localProxySession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    const oversizedCallId = `c${"a".repeat(256)}`;
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "resp_oversized_call",
      call_id: oversizedCallId,
      name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      arguments: JSON.stringify({ tool_name: "lookup_member", arguments: {} }),
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: {
        id: "resp_oversized_call",
        status: "completed",
        output: [terminalToolOutput(
          oversizedCallId,
          LOCAL_TOOL_PROXY_FUNCTION_NAME,
          JSON.stringify({ tool_name: "lookup_member", arguments: {} }),
        )],
      },
    }));
    expect(client.state).toBe("failed");
    expect(observed.some((event) => event.type === "tool.dispatch")).toBe(false);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "invalid_local_tool_proxy_call",
      message: expect.stringContaining("256-byte persistent identity limit"),
    }));
  });

  it("accepts one call ID repeated across its documented lifecycle phases", async () => {
    const { client, socket } = fakeClient("openai");
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    socket.emit("message", JSON.stringify({
      type: "response.output_item.added",
      response_id: "r_lifecycle",
      item: { type: "function_call", id: "item_lifecycle", call_id: "call_lifecycle", name: "lookup", arguments: "" },
    }));
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.delta",
      response_id: "r_lifecycle",
      item_id: "item_lifecycle",
      call_id: "call_lifecycle",
      delta: "{}",
    }));
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "r_lifecycle",
      item_id: "item_lifecycle",
      call_id: "call_lifecycle",
      name: "lookup",
      arguments: "{}",
    }));
    socket.emit("message", JSON.stringify({
      type: "response.output_item.done",
      response_id: "r_lifecycle",
      item: {
        type: "function_call",
        id: "item_lifecycle",
        call_id: "call_lifecycle",
        name: "lookup",
        arguments: "{}",
        status: "completed",
      },
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: {
        id: "r_lifecycle",
        status: "completed",
        output: [{
          type: "function_call",
          id: "item_lifecycle",
          call_id: "call_lifecycle",
          name: "lookup",
          arguments: "{}",
          status: "completed",
        }],
      },
    }));
    expect(client.state).toBe("ready");
    expect(observed.filter((event) => event.type === "tool.calls")).toHaveLength(1);
    expect(observed.find((event) => event.type === "tool.calls")).toMatchObject({
      calls: [{ callId: "call_lifecycle", responseId: "r_lifecycle", itemId: "item_lifecycle" }],
    });
  });

  it("accepts exact terminal retransmission once but rejects rewritten terminal identity", async () => {
    const exact = fakeClient("openai");
    const exactEvents: NormalizedRealtimeEvent[] = [];
    exact.client.onEvent((event) => exactEvents.push(event));
    await connect(exact.client, exact.socket);
    const argumentsDone = {
      type: "response.function_call_arguments.done",
      event_id: "evt_args_done",
      response_id: "r_exact_replay",
      call_id: "call_exact_replay",
      name: "lookup",
      arguments: "{}",
    };
    const responseDone = {
      type: "response.done",
      event_id: "evt_response_done",
      response: {
        id: "r_exact_replay",
        status: "completed",
        output: [terminalToolOutput("call_exact_replay", "lookup")],
      },
    };
    exact.socket.emit("message", JSON.stringify(argumentsDone));
    exact.socket.emit("message", JSON.stringify({ ...argumentsDone, event_id: "evt_args_done_replay" }));
    exact.socket.emit("message", JSON.stringify(responseDone));
    exact.socket.emit("message", JSON.stringify({ ...responseDone, event_id: "evt_response_done_replay" }));
    expect(exact.client.state).toBe("ready");
    expect(exactEvents.filter((event) => event.type === "tool.calls")).toHaveLength(1);
    expect(exactEvents.filter((event) => event.type === "response.completed")).toHaveLength(1);

    const rewritten = fakeClient("openai");
    await connect(rewritten.client, rewritten.socket);
    rewritten.socket.emit("message", JSON.stringify(argumentsDone));
    rewritten.socket.emit("message", JSON.stringify({
      ...argumentsDone,
      arguments: "{\"rewritten\":true}",
    }));
    expect(rewritten.client.state).toBe("failed");
    expect(rewritten.socket.terminated).toBe(true);
  });

  it("fails closed when the unique provider-identity ledger reaches its configured bound", async () => {
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: baseSession,
      maximumTrackedIdentities: 0,
    })).toThrow(/positive integer/);

    const socket = new FakeSocket();
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: baseSession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
      maximumTrackedIdentities: 2,
    });
    await connect(client, socket);
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "r_capacity",
      call_id: "call_capacity_1",
      name: "one",
      arguments: "{}",
    }));
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "r_capacity",
      call_id: "call_capacity_2",
      name: "two",
      arguments: "{}",
    }));
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
  });

  it("refuses partial continuation when xAI emitted a parallel call batch", async () => {
    const { client, socket } = fakeClient("xai");
    await connect(client, socket);
    socket.sent.length = 0;
    deliverToolBatch(socket, [
      { callId: "call_1", name: "lookup" },
      { callId: "call_2", name: "quote" },
    ]);
    expect(() => client.submitToolResults([{ callId: "call_1", output: "one" }]))
      .toThrow(/missing: call_2/);
    expect(() => client.createResponse()).toThrow(/Resolve the complete tool-call batch/);
    expect(socket.sent).toEqual([]);
    client.submitToolResults([
      { callId: "call_1", output: "one" },
      { callId: "call_2", output: "two" },
    ]);
    expect(socket.sent.map((value) => JSON.parse(value)).at(-1)).toEqual({ type: "response.create" });
  });

  it("snapshots tool results without invoking getters or toJSON hooks", async () => {
    const { client, socket } = fakeClient("xai");
    await connect(client, socket);
    deliverToolBatch(socket, [{ callId: "call_snapshot", name: "lookup" }]);
    socket.sent.length = 0;
    const callIdGetter = vi.fn(() => "call_snapshot");
    const outputGetter = vi.fn(() => ({ ok: true }));
    const accessorResult = {};
    Object.defineProperties(accessorResult, {
      callId: { enumerable: true, get: callIdGetter },
      output: { enumerable: true, get: outputGetter },
    });
    expect(() => client.submitToolResults([accessorResult as never], false)).toThrow(/accessor/);
    expect(callIdGetter).not.toHaveBeenCalled();
    expect(outputGetter).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);

    const toJSON = vi.fn(() => ({ forged: true }));
    expect(() => client.submitToolResults([{
      callId: "call_snapshot",
      output: { toJSON },
    }], false)).toThrow(/function values/);
    expect(toJSON).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);

    client.submitToolResults([{
      callId: "call_snapshot",
      output: { z: 1, a: 2 },
    }], false);
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      item: { call_id: "call_snapshot", output: "{\"a\":2,\"z\":1}" },
    });
  });

  it("enters a fatal indeterminate state after a partial tool-result send", async () => {
    const { client, socket } = fakeClient("xai");
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    deliverToolBatch(socket, [
      { callId: "call_partial_1", name: "lookup" },
      { callId: "call_partial_2", name: "quote" },
    ]);
    socket.sent.length = 0;
    const originalSend = socket.send.bind(socket);
    let sendAttempt = 0;
    socket.send = (data: string) => {
      sendAttempt += 1;
      if (sendAttempt === 2) throw new Error("simulated socket failure");
      originalSend(data);
    };
    expect(() => client.submitToolResults([
      { callId: "call_partial_1", output: "one" },
      { callId: "call_partial_2", output: "two" },
    ])).toThrow(/delivery became indeterminate/);
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
    expect(socket.sent.map((frame) => JSON.parse(frame).item?.call_id).filter(Boolean))
      .toEqual(["call_partial_1"]);
    expect(() => client.submitToolResults([
      { callId: "call_partial_1", output: "one" },
      { callId: "call_partial_2", output: "two" },
    ])).toThrow(/No completed provider tool-call batch/);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "tool_result_batch_send_failed",
      fatal: true,
    }));
  });

  it("rejects unproven tool outputs and overlapping provider batches", async () => {
    const { client, socket } = fakeClient("xai");
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    expect(() => client.submitToolResults([{ callId: "invented", output: "fake" }]))
      .toThrow(/No completed provider tool-call batch/);
    deliverToolBatch(socket, [{ callId: "call_1", name: "lookup" }], "r_first");
    deliverToolBatch(socket, [{ callId: "call_2", name: "quote" }], "r_overlap");
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "overlapping_tool_batch",
      fatal: true,
    }));
  });

  it.each([
    ["whitespace", " call_1"],
    ["path separators", "call/1"],
    ["control characters", "call_1\n"],
  ])("fails closed on malformed provider call IDs containing %s", async (_label, callId) => {
    const { client, socket } = fakeClient("xai");
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    deliverToolBatch(socket, [{ callId, name: "lookup" }]);
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
    expect(observed.some((event) => event.type === "tool.calls")).toBe(false);
    expect(observed).toContainEqual(expect.objectContaining({ type: "error", fatal: true }));
  });

  it("rejects contradictory redundant call identity before admitting either value", async () => {
    const { client, socket } = fakeClient("openai");
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    socket.emit("message", JSON.stringify({
      type: "response.output_item.done",
      response_id: "r_redundant_call",
      call_id: "call_top",
      item: {
        type: "function_call",
        id: "item_redundant_call",
        call_id: "call_nested",
        name: "lookup",
        arguments: "{}",
        status: "completed",
      },
    }));
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
    expect(observed).toContainEqual(expect.objectContaining({
      type: "error",
      code: "invalid_provider_tool_call_identity",
      fatal: true,
      message: expect.stringContaining("contradictory redundant tool call identity"),
    }));
  });

  it("fails closed when a provider duplicates one call ID in an event or later reuses it", async () => {
    const duplicated = fakeClient("xai");
    await connect(duplicated.client, duplicated.socket);
    duplicated.socket.emit("message", JSON.stringify({
      type: "response.done",
      response: {
        id: "r_duplicate",
        status: "completed",
        output: [
          { type: "function_call", id: "item_1", call_id: "call_duplicate", name: "lookup", arguments: "{}" },
          { type: "function_call", id: "item_2", call_id: "call_duplicate", name: "lookup", arguments: "{}" },
        ],
      },
    }));
    expect(duplicated.client.state).toBe("failed");
    expect(duplicated.socket.terminated).toBe(true);

    const reused = fakeClient("xai");
    await connect(reused.client, reused.socket);
    deliverToolBatch(reused.socket, [{ callId: "call_reused", name: "lookup" }], "r_first");
    reused.client.submitToolResults([{ callId: "call_reused", output: "ok" }], false);
    deliverToolBatch(reused.socket, [{ callId: "call_reused", name: "lookup" }], "r_second");
    expect(reused.client.state).toBe("failed");
    expect(reused.socket.terminated).toBe(true);
  });

  it("emits byte-derived xAI audio minutes and billable user-text counts", async () => {
    const { client, socket } = fakeClient("xai");
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    client.sendTurn({ ...PCM, data: Uint8Array.from([1, 0, 2, 0]) });
    client.sendTextTurn("hello", false);
    socket.emit("message", JSON.stringify({
      type: "response.output_audio.delta",
      response_id: "r_meter",
      delta: "AQI=",
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: { id: "r_meter", status: "completed", output: [] },
    }));
    const usage = observed.find((event) => event.type === "usage" && event.scope === "response");
    expect(usage).toMatchObject({
      type: "usage",
      scope: "response",
      usage: {
        inputAudioMinutes: 4 / 2 / 24_000 / 60,
        outputAudioMinutes: 2 / 2 / 24_000 / 60,
        billableTextInputEvents: 1,
        meteringSource: "client_measured",
      },
    });
  });

  it("validates local audio and tool batches before sending any partial batch", async () => {
    const { client, socket } = fakeClient("xai");
    await connect(client, socket);
    socket.sent.length = 0;
    expect(() => client.sendTurn([
      { ...PCM, data: Uint8Array.from([1, 0]) },
      { ...PCM, data: Uint8Array.from([1]) },
    ])).toThrow(/complete 16-bit samples/);
    expect(socket.sent).toEqual([]);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    deliverToolBatch(socket, [
      { callId: "call_1", name: "lookup" },
      { callId: "call_2", name: "quote" },
    ]);
    expect(() => client.submitToolResults([
      { callId: "call_1", output: "valid" },
      { callId: "call_2", output: cyclic },
    ])).toThrow();
    expect(socket.sent).toEqual([]);
  });

  it("surfaces malformed frames without breaking the acknowledged session", async () => {
    const { client, socket } = fakeClient();
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    socket.emit("message", "invalid-json");
    expect(client.state).toBe("ready");
    expect(observed.at(-1)).toMatchObject({ type: "error", code: "invalid_json", fatal: false });
  });

  it("rejects the connection when the provider rejects session configuration", async () => {
    const { client, socket } = fakeClient();
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    const pending = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({
      type: "error",
      error: { code: "invalid_session", message: "bad configuration" },
    }));
    await expect(pending).rejects.toThrow("bad configuration");
    expect(client.state).toBe("failed");
    expect(socket.terminated).toBe(true);
    expect(observed.at(-1)).toMatchObject({ type: "error", code: "invalid_session", fatal: true });
  });

  it("isolates observers that throw from the protocol state machine", async () => {
    const { client, socket } = fakeClient();
    const healthy = vi.fn();
    client.onEvent(() => { throw new Error("observer failed"); });
    client.onEvent(healthy);
    await connect(client, socket);
    expect(client.state).toBe("ready");
    expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ type: "session.ready" }));
  });

  it("normalizes wire events before raw observers can mutate them", async () => {
    const { client, socket } = fakeClient();
    const second = vi.fn();
    client.onWireEvent((event) => {
      event.type = "error";
      (event.session as { audio?: unknown }).audio = "corrupt";
    });
    client.onWireEvent(second);
    await connect(client, socket);
    expect(client.state).toBe("ready");
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ type: "session.updated" }));
    expect(Object.isFrozen(second.mock.calls[0][0])).toBe(true);
    expect(Object.isFrozen(second.mock.calls[0][0].session)).toBe(true);
  });

  it("deep-isolates normalized event payloads between observers", async () => {
    const { client, socket } = fakeClient("xai");
    const second = vi.fn();
    client.onEvent((event) => {
      if (event.type === "usage") event.usage.raw.injected = true;
    });
    client.onEvent(second);
    await connect(client, socket);
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: { id: "r1", status: "completed", output: [], usage: { total_tokens: 2 } },
    }));
    const usage = second.mock.calls.map(([event]) => event as NormalizedRealtimeEvent)
      .find((event) => event.type === "usage");
    expect(usage).toMatchObject({ type: "usage", usage: { raw: { total_tokens: 2 } } });
    expect(Object.isFrozen(usage)).toBe(true);
    if (usage?.type === "usage") expect(Object.isFrozen(usage.usage.raw)).toBe(true);
  });

  it("does not turn an expected close-before-ack into a timeout failure", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = fakeClient();
      const observed: NormalizedRealtimeEvent[] = [];
      client.onEvent((event) => observed.push(event));
      const pending = client.connect();
      socket.emit("open");
      client.close();
      await expect(pending).rejects.toThrow(/closed before session acknowledgement/);
      await vi.advanceTimersByTimeAsync(2_000);
      socket.emit("error", new Error("close-path noise"));
      expect(client.state).toBe("closing");
      expect(observed.some((event) => event.type === "error" && event.fatal)).toBe(false);
      socket.emit("close", 1000, "done");
      expect(client.state).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes provider wire failures without retaining provider plaintext", async () => {
    const { client, socket } = fakeClient();
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    client.sendTextTurn("diagnostic request");
    socket.emit("message", JSON.stringify({
      type: "response.created",
      response: { id: "response-diagnostic", status: "in_progress" },
    }));
    socket.emit("message", JSON.stringify({
      type: "error",
      error: {
        code: "insufficient_quota",
        message: "sensitive provider prose account@example.test secret-marker",
      },
    }));
    const event = observed.findLast((candidate) => candidate.type === "error");
    expect(event).toMatchObject({
      type: "error",
      transportDiagnostic: {
        schemaVersion: 1,
        origin: "provider_wire",
        category: "provider_quota",
        safeRawCode: "insufficient_quota",
        responseGenerationRequested: true,
        responseGenerationStarted: true,
        responseTerminalObserved: false,
      },
    });
    if (event?.type !== "error" || !event.transportDiagnostic) throw new Error("missing diagnostic");
    assertRealtimeTransportFailureDiagnostic(event.transportDiagnostic);
    expect(JSON.stringify(event.transportDiagnostic)).not.toContain("account@example.test");
    expect(JSON.stringify(event.transportDiagnostic)).not.toContain("secret-marker");
    expect(event.transportDiagnostic.messageSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distinguishes WebSocket error and close origins with content-free evidence", async () => {
    const errored = fakeClient();
    const errorEvents: NormalizedRealtimeEvent[] = [];
    errored.client.onEvent((event) => errorEvents.push(event));
    await connect(errored.client, errored.socket);
    errored.client.sendTextTurn("diagnostic request");
    errored.socket.emit("error", Object.assign(new Error("private network path"), { code: "ECONNRESET" }));
    const error = errorEvents.findLast((event) => event.type === "error");
    expect(error).toMatchObject({
      type: "error",
      transportDiagnostic: {
        origin: "websocket_error",
        category: "network",
        safeRawCode: "ECONNRESET",
        responseGenerationRequested: true,
        responseGenerationStarted: false,
        responseTerminalObserved: false,
      },
    });

    const closed = fakeClient("xai");
    const closeEvents: NormalizedRealtimeEvent[] = [];
    closed.client.onEvent((event) => closeEvents.push(event));
    await connect(closed.client, closed.socket);
    closed.socket.emit("close", 1011, Buffer.from("private close reason"));
    const close = closeEvents.findLast((event) => event.type === "connection.closed");
    expect(close).toMatchObject({
      type: "connection.closed",
      transportDiagnostic: {
        origin: "websocket_close",
        category: "server_close",
        closeCodeClass: "server_error",
        responseGenerationRequested: false,
        responseGenerationStarted: false,
        responseTerminalObserved: false,
      },
    });
    if (close?.type !== "connection.closed" || !close.transportDiagnostic) throw new Error("missing close diagnostic");
    assertRealtimeTransportFailureDiagnostic(close.transportDiagnostic);
    expect(JSON.stringify(close.transportDiagnostic)).not.toContain("private close reason");
    expect(close.transportDiagnostic.reasonSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("manual PCM session compilation", () => {
  it("normalizes only the exact xAI nested function wire alias and retains safe evidence", () => {
    const tool = {
      type: "function",
      name: "capability_gateway",
      description: "Dispatch one scoped capability.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { tool_name: { type: "string" } },
        required: ["tool_name"],
      },
    };
    const proofFor = (tools: unknown[], provider: "xai" | "openai" = "xai") => (
      buildSessionConfigurationAcknowledgement({
        provider,
        requestedUpdate: { type: "session.update", session: { tools: [tool] } },
        acknowledgedEvent: { type: "session.updated", session: { tools } },
      })
    );
    const nested = {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
    const exact = proofFor([nested]);
    expect(exact.fields.tools).toMatchObject({
      status: "verified",
      aliasNormalization: {
        kind: "xai_function_tool_wire_alias_v1",
        policySha256: XAI_FUNCTION_TOOL_ALIAS_POLICY_SHA256,
        sourcePaths: ["tools[0]", "tools[0].function"],
        keyInventory: [
          { path: "tools[0]", keys: ["function", "type"] },
          { path: "tools[0].function", keys: ["description", "name", "parameters"] },
        ],
        canonicalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        claimBoundary: "wire_alias_equivalence_only_paid_exact_call_still_required",
      },
    });
    expect(exact.session).toMatchObject({ status: "verified" });

    const omitted = proofFor([{ type: "function", function: {} }]);
    expect(omitted.fields.tools).toMatchObject({
      status: "unverifiable",
      omission: {
        paths: ["tools[0].description", "tools[0].name", "tools[0].parameters"],
      },
      aliasNormalization: { policySha256: XAI_FUNCTION_TOOL_ALIAS_POLICY_SHA256 },
    });

    const exactBoth = proofFor([{ ...tool, function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    } }]);
    expect(exactBoth.fields.tools.status).toBe("verified");

    const adversarial = [
      [{ ...tool, function: { ...nested.function, name: "other_gateway" } }],
      [{ ...nested, extra_callable: { name: "hidden" } }],
      [{ ...nested, function: { ...nested.function, additional_schema: {} } }],
      [{ ...nested, function: { ...nested.function, name: "other_gateway" } }],
      [{ ...nested, function: { ...nested.function, parameters: { type: "object", additionalProperties: true } } }],
      [nested, nested],
    ];
    for (const acknowledgedTools of adversarial) {
      const rejected = proofFor(acknowledgedTools);
      expect(rejected.fields.tools.status).toBe("mismatch");
      expect(rejected.fields.tools.contradiction?.paths.length).toBeGreaterThan(0);
    }
    expect(proofFor([nested], "openai").fields.tools.status).toBe("mismatch");
  });

  it("admits xAI's nested function acknowledgement at the real readiness boundary", async () => {
    const socket = new FakeSocket();
    const events: NormalizedRealtimeEvent[] = [];
    const client = new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime?model=grok-voice-think-fast-1.0",
      sessionUpdate: localProxySession,
      socketFactory: () => socket,
      connectTimeoutMs: 1_000,
    });
    client.onEvent((event) => events.push(event));
    const pending = client.connect();
    socket.emit("open");
    socket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_alias", model: "grok-voice-think-fast-1.0" },
    }));
    const sent = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
    const acknowledgedSession = structuredClone(recordForTest(sent.session));
    const sentTools = acknowledgedSession.tools as Array<Record<string, unknown>>;
    const flat = sentTools[0]!;
    sentTools[0] = {
      type: "function",
      function: {
        name: flat.name,
        description: flat.description,
        parameters: flat.parameters,
      },
    };
    socket.emit("message", JSON.stringify({
      type: "session.updated",
      session: { id: "sess_alias", ...acknowledgedSession },
    }));
    await expect(pending).resolves.toBeUndefined();
    expect(client.state).toBe("ready");
    expect(events.find((event) => event.type === "session.ready")).toMatchObject({
      configuration: {
        fields: {
          tools: {
            status: "verified",
            aliasNormalization: {
              policySha256: XAI_FUNCTION_TOOL_ALIAS_POLICY_SHA256,
              claimBoundary: "wire_alias_equivalence_only_paid_exact_call_still_required",
            },
          },
        },
      },
    });
  });

  it("hashes exact effective OpenAI session identity without mistaking provider defaults for drift", () => {
    const requested = {
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        instructions: "Follow the verified workflow.",
        tools: [{
          type: "mcp",
          server_label: "gateway",
          server_url: "https://example.test/mcp",
          authorization: "Bearer proof-must-not-leak-this",
        }],
        tool_choice: "auto",
        audio: {
          input: { format: { type: "audio/pcm", rate: 24_000 }, turn_detection: null },
          output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" },
        },
      },
    };
    const acknowledged = structuredClone(requested);
    (acknowledged.session.audio.input as Record<string, unknown>).noise_reduction = null;
    const proof = buildSessionConfigurationAcknowledgement({
      provider: "openai",
      requestedUpdate: requested,
      acknowledgedEvent: { type: "session.updated", session: acknowledged.session },
      requestedModel: "gpt-realtime-2.1",
    });
    expect(proof.strictParityVerified).toBe(true);
    expect(proof.paidBenchmarkReady).toBe(true);
    expect(proof.session).toMatchObject({ status: "verified" });
    expect(Object.values(proof.fields).map((field) => field.status))
      .not.toContain("unverifiable");
    expect(proof.fields.tools).toMatchObject({
      status: "verified",
      requestedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      acknowledgedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(proof)).not.toContain("proof-must-not-leak-this");
  });

  it("distinguishes explicit session drift from fields the provider did not echo", () => {
    const requested = {
      type: "session.update",
      session: {
        voice: "ara",
        instructions: "Use only the scoped gateway.",
        tools: [{ type: "mcp", server_label: "gateway", server_url: "https://example.test/mcp" }],
        audio: {
          input: { format: { type: "audio/pcm", rate: 24_000 } },
          output: { format: { type: "audio/pcm", rate: 24_000 } },
        },
        turn_detection: { type: null },
      },
    };
    const proof = buildSessionConfigurationAcknowledgement({
      provider: "xai",
      requestedUpdate: requested,
      requestedModel: "grok-voice-think-fast-1.0",
      acknowledgedEvent: {
        type: "session.updated",
        session: {
          voice: "ara",
          instructions: "Use every available tool.",
          audio: requested.session.audio,
          turn_detection: { type: null },
        },
      },
    });
    expect(proof.strictParityVerified).toBe(false);
    expect(proof.paidBenchmarkReady).toBe(false);
    expect(proof.session).toMatchObject({ status: "mismatch" });
    expect(proof.fields.instructions).toMatchObject({ status: "mismatch" });
    expect(proof.fields.tools).toMatchObject({
      status: "unverifiable",
      reason: expect.stringContaining("omitted"),
    });
    expect(proof.fields.model).toMatchObject({ status: "unverifiable" });
  });

  it("does not hide an explicit server-VAD contradiction behind omitted sibling paths", () => {
    const requested = {
      type: "session.update",
      session: {
        voice: "ara",
        instructions: "Use only the scoped gateway.",
        tools: [],
        tool_choice: "auto",
        audio: {
          input: { format: { type: "audio/pcm", rate: 24_000 } },
          output: { format: { type: "audio/pcm", rate: 24_000 } },
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.85,
          silence_duration_ms: 500,
          prefix_padding_ms: 333,
          idle_timeout_ms: null,
        },
      },
    };
    const proof = buildSessionConfigurationAcknowledgement({
      provider: "xai",
      requestedUpdate: requested,
      requestedModel: "grok-voice-think-fast-1.0",
      acknowledgedModel: { value: "grok-voice-think-fast-1.0", wireType: "session.updated" },
      acknowledgedEvent: {
        type: "session.updated",
        session: {
          ...requested.session,
          turn_detection: { type: "server_vad", threshold: 0.1 },
        },
      },
    });
    expect(proof.fields.turn_detection).toMatchObject({
      status: "mismatch",
      contradiction: {
        kind: "requested_paths_mismatched",
        paths: ["turn_detection.threshold"],
      },
      omission: {
        kind: "requested_paths_omitted",
        paths: [
          "turn_detection.idle_timeout_ms",
          "turn_detection.prefix_padding_ms",
          "turn_detection.silence_duration_ms",
        ],
      },
    });
    expect(proof.session).toMatchObject({ status: "mismatch" });
  });

  it("pins OpenAI VAD inside input audio without mutating the source", () => {
    const compiled = withManualPcmSession("openai", baseSession);
    expect(compiled).toMatchObject({
      session: {
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { model: "transcriber" },
            turn_detection: null,
          },
          output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" },
        },
      },
    });
    expect(baseSession.session.audio.input.turn_detection).toEqual({ type: "server_vad" });
  });

  it("pins xAI's session-level VAD to manual boundaries", () => {
    expect(withManualPcmSession("xai", baseSession)).toMatchObject({
      session: {
        turn_detection: { type: null },
        audio: {
          input: { format: { type: "audio/pcm", rate: 24_000 } },
          output: { format: { type: "audio/pcm", rate: 24_000 } },
        },
      },
    });
  });

  it("validates provider-specific acknowledgement shapes", () => {
    expect(validateManualPcmSessionAcknowledgement("openai", sessionAcknowledgement("openai"))).toEqual({ ok: true });
    expect(validateManualPcmSessionAcknowledgement("xai", sessionAcknowledgement("xai"))).toEqual({ ok: true });
    expect(validateManualPcmSessionAcknowledgement("xai", sessionAcknowledgement("openai"))).toMatchObject({
      ok: false,
      mismatches: expect.arrayContaining(["xAI session.turn_detection.type is not null"]),
    });
    expect(validateManualPcmSessionAcknowledgement("xai", sessionAcknowledgement("xai"), PCM, PCM, true))
      .toMatchObject({
        ok: false,
        mismatches: expect.arrayContaining(["xAI resumption.enabled was not acknowledged"]),
      });
  });

  it("keeps xAI's empty manual-turn acknowledgement explicitly unverifiable", () => {
    const requested = withManualPcmSession("xai", baseSession);
    const acknowledged = sessionAcknowledgement("xai") as Record<string, unknown>;
    recordForTest(acknowledged.session).turn_detection = {};

    expect(validateManualPcmSessionAcknowledgement("xai", acknowledged)).toEqual({ ok: true });
    const proof = buildSessionConfigurationAcknowledgement({
      provider: "xai",
      requestedUpdate: requested,
      requestedModel: "grok-voice-think-fast-1.0",
      acknowledgedModel: {
        value: "grok-voice-think-fast-1.0",
        wireType: "session.created",
      },
      acknowledgedEvent: acknowledged,
    });
    expect(proof.fields.turn_detection).toMatchObject({
      status: "unverifiable",
      reason: expect.stringContaining("turn_detection.type"),
      omission: {
        kind: "requested_paths_omitted",
        paths: ["turn_detection.type"],
        acknowledgedShape: "empty_object",
      },
    });
    expect(proof.strictParityVerified).toBe(false);
    expect(proof.paidBenchmarkReady).toBe(false);
  });

  it("enforces each hosted provider's documented PCM rates", () => {
    const pcm16 = { ...PCM, sampleRateHz: 16_000 };
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://openai.example/realtime",
      sessionUpdate: baseSession,
      inputAudioFormat: pcm16,
      outputAudioFormat: pcm16,
    })).toThrow(/openai does not support 16000 Hz/);
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime",
      sessionUpdate: baseSession,
      inputAudioFormat: pcm16,
      outputAudioFormat: pcm16,
    })).not.toThrow();
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://xai.example/realtime",
      sessionUpdate: baseSession,
      inputAudioFormat: { ...PCM, sampleRateHz: 12_345 },
    })).toThrow(/xai does not support 12345 Hz/);
  });

  it("never sends authorization headers over plaintext except explicit loopback tests", () => {
    const options = {
      provider: "xai" as const,
      sessionUpdate: baseSession,
      headers: { Authorization: "Bearer secret" },
    };
    expect(() => new OpenAICompatibleRealtimeClient({ ...options, url: "ws://remote.example/realtime" }))
      .toThrow(/require wss/);
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "ws://remote.example/realtime?auth=plaintext",
      sessionUpdate: baseSession,
    })).toThrow(/require wss/);
    expect(() => new OpenAICompatibleRealtimeClient({ ...options, url: "ws://localhost:9999/realtime" }))
      .toThrow(/require wss/);
    expect(() => new OpenAICompatibleRealtimeClient({
      ...options,
      url: "ws://localhost:9999/realtime",
      allowInsecureLocalhostForTests: true,
    })).not.toThrow();
    expect(() => new OpenAICompatibleRealtimeClient({
      ...options,
      url: "ws://remote.example/realtime",
      allowInsecureLocalhostForTests: true,
    })).toThrow(/require wss/);
  });

  it("requires two explicit grants before hosted raw sessions can expose provider-direct MCP", () => {
    const directSession = {
      ...baseSession,
      session: {
        ...baseSession.session,
        tools: [{
          type: "mcp",
          server_label: "external",
          server_url: "https://external-mcp.example.net/v1",
          authorization: "Bearer external-secret",
        }],
      },
    };
    const common = {
      apiKey: "redacted",
      model: "provider-model",
      sessionUpdate: directSession,
      socketFactory: () => new FakeSocket(),
    };
    expect(() => createOpenAIRealtimeClient(common)).toThrow(/requires both explicit experimental grants/);
    expect(() => createXaiRealtimeClient(common)).toThrow(/requires both explicit experimental grants/);
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://api.openai.com/v1/realtime?model=provider-model",
      sessionUpdate: directSession,
      socketFactory: () => new FakeSocket(),
    })).toThrow(/requires both explicit experimental grants/);
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "xai",
      url: "wss://api.x.ai/v1/realtime?model=provider-model",
      sessionUpdate: {
        ...directSession,
        session: {
          ...directSession.session,
          tools: [LOCAL_TOOL_PROXY_FUNCTION, ...directSession.session.tools],
        },
      },
      socketFactory: () => new FakeSocket(),
    })).toThrow(/requires both explicit experimental grants/);
    expect(() => createOpenAIRealtimeClient({
      ...common,
      experimentalProviderDirectMcp: { enabled: true },
    })).toThrow(/requires both/);
    expect(() => createXaiRealtimeClient({
      ...common,
      experimentalProviderDirectMcp: { enabled: true, allowConsequential: true },
    })).not.toThrow();
    expect(() => new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://api.openai.com/v1/realtime?model=provider-model",
      sessionUpdate: directSession,
      socketFactory: () => new FakeSocket(),
      experimentalProviderDirectMcp: { enabled: true, allowConsequential: true },
    })).not.toThrow();
  });

  it("gates and sends the same detached provider-tool snapshot", async () => {
    const socket = new FakeSocket();
    let typeReads = 0;
    const flippingTool = { name: "safe_read" } as Record<string, unknown>;
    Object.defineProperty(flippingTool, "type", {
      enumerable: true,
      get: () => (++typeReads === 1 ? "function" : "mcp"),
    });
    const client = new OpenAICompatibleRealtimeClient({
      provider: "openai",
      url: "wss://api.openai.com/v1/realtime?model=provider-model",
      sessionUpdate: {
        ...baseSession,
        session: { ...baseSession.session, tools: [flippingTool] },
      },
      socketFactory: () => socket,
    });
    const pending = client.connect();
    socket.emit("open");
    const sent = JSON.parse(socket.sent[0]) as { session: Record<string, unknown> };
    expect(typeReads).toBe(1);
    expect(sent.session.tools).toEqual([{ name: "safe_read", type: "function" }]);
    socket.emit("message", JSON.stringify({ type: "session.updated", session: sent.session }));
    await pending;
    client.close();
  });

  it("snapshots connection and session inputs against post-construction mutation", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedHeaders: Record<string, string> = {};
    const mutableHeaders = { Authorization: "Bearer original" };
    const mutableSession = structuredClone(baseSession) as typeof baseSession & { session: { tools?: unknown[] } };
    mutableSession.session.tools = [];
    const options = {
      provider: "openai" as const,
      url: "wss://original.example/realtime",
      headers: mutableHeaders,
      sessionUpdate: mutableSession,
      socketFactory: ((url, socketOptions) => {
        openedUrl = url;
        openedHeaders = socketOptions.headers;
        return socket;
      }) satisfies RealtimeWebSocketFactory,
      connectTimeoutMs: 1_000,
    };
    const client = new OpenAICompatibleRealtimeClient(options);
    options.url = "ws://attacker.example/realtime";
    mutableHeaders.Authorization = "Bearer changed";
    mutableSession.session.tools.push({ type: "function", name: "injected" });
    const pending = client.connect();
    socket.emit("open");
    expect(openedUrl).toBe("wss://original.example/realtime");
    expect(openedHeaders).toEqual({ Authorization: "Bearer original" });
    expect(JSON.parse(socket.sent[0]).session.tools).toEqual([]);
    socket.emit("message", JSON.stringify(sessionAcknowledgement("openai")));
    await pending;
  });

  it("constructs xAI resume URLs and opts the reconnect into replay", async () => {
    const socket = new FakeSocket();
    let connectedUrl = "";
    const factory: RealtimeWebSocketFactory = (url) => {
      connectedUrl = url;
      return socket;
    };
    const client = createXaiRealtimeClient({
      apiKey: "redacted",
      model: "grok-voice-think-fast-1.0",
      conversationId: "conv/with spaces",
      sessionUpdate: baseSession,
      socketFactory: factory,
      connectTimeoutMs: 1_000,
    });
    const events: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => events.push(event));
    const pending = client.connect();
    socket.emit("open");
    expect(socket.sent).toHaveLength(1);
    socket.emit("message", JSON.stringify({
      type: "session.created",
      session: { id: "sess_1", model: "grok-voice-think-fast-1.0" },
    }));
    const sent = JSON.parse(socket.sent[0]);
    expect(sent).toMatchObject({ session: { resumption: { enabled: true } } });
    const url = new URL(connectedUrl);
    expect(url.searchParams.get("model")).toBe("grok-voice-think-fast-1.0");
    expect(url.searchParams.get("conversation_id")).toBe("conv/with spaces");
    socket.emit("message", JSON.stringify({ type: "conversation.created", conversation: { id: "conv_new" } }));
    expect(events.some((event) => event.type === "session.resumption")).toBe(false);
    socket.emit("message", JSON.stringify(sessionAcknowledgement("xai", 24_000, true)));
    await pending;
    expect(client.state).toBe("ready");
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.resumption",
      conversationId: "conv_new",
      resumable: true,
    }));
  });
});
