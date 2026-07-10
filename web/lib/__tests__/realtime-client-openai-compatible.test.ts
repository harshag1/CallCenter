import { describe, expect, it, vi } from "vitest";
import { base64ToPcm16, chunkPcm16, pcm16DurationMs, pcm16ToBase64 } from "../realtime/client/audio";
import {
  OpenAICompatibleEventNormalizer,
  normalizeOpenAICompatibleUsage,
  safeParseWireEvent,
} from "../realtime/client/events";
import {
  OpenAICompatibleRealtimeClient,
  createXaiRealtimeClient,
  validateManualPcmSessionAcknowledgement,
  withManualPcmSession,
} from "../realtime/client/openai-compatible";
import type {
  NormalizedRealtimeEvent,
  RealtimeWebSocket,
  RealtimeWebSocketFactory,
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
    turn_detection: { type: "server_vad" },
  },
};

class FakeSocket implements RealtimeWebSocket {
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string) {
    this.sent.push(data);
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

function fakeClient(provider: "openai" | "xai" = "openai") {
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
  });
  return { client, socket, factoryArgs: () => factoryArgs };
}

async function connect(client: OpenAICompatibleRealtimeClient, socket: FakeSocket) {
  const connected = client.connect();
  socket.emit("open");
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
      ...(provider === "xai" ? { turn_detection: null } : {}),
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
    response: { id: responseId, status: "completed", output: [] },
  }));
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
    expect(normalizer.normalize({ type: "response.output_audio.delta", delta: "***" })[0])
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
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.find((event) => event.type === "tool.cancelled")).toMatchObject({
      callIds: ["incomplete_call", "bad_json"],
    });
  });

  it.each(["cancelled", "failed", "incomplete", undefined])(
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
    expect(events[0]).toMatchObject({ type: "tool.cancelled", callIds: ["call_late"] });
    },
  );
});

describe("OpenAI-compatible realtime client", () => {
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

  it("submits every tool result before one continuation response", async () => {
    const { client, socket } = fakeClient("xai");
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

  it("emits byte-derived xAI audio minutes and billable user-text counts", async () => {
    const { client, socket } = fakeClient("xai");
    const observed: NormalizedRealtimeEvent[] = [];
    client.onEvent((event) => observed.push(event));
    await connect(client, socket);
    client.sendTurn({ ...PCM, data: Uint8Array.from([1, 0, 2, 0]) });
    client.sendTextTurn("hello", false);
    socket.emit("message", JSON.stringify({ type: "response.output_audio.delta", delta: "AQI=" }));
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
});

describe("manual PCM session compilation", () => {
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
        turn_detection: null,
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
      mismatches: expect.arrayContaining(["xAI session.turn_detection is not null"]),
    });
    expect(validateManualPcmSessionAcknowledgement("xai", sessionAcknowledgement("xai"), PCM, PCM, true))
      .toMatchObject({
        ok: false,
        mismatches: expect.arrayContaining(["xAI resumption.enabled was not acknowledged"]),
      });
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
