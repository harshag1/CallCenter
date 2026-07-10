import { describe, expect, it } from "vitest";
import type { NormalizedRealtimeEvent, RealtimeWebSocket, RealtimeWebSocketFactory } from "./types";
import {
  GEMINI_CAPABILITY_GATEWAY_NAME,
  GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
  GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ,
  GeminiLiveClient,
} from "./gemini-live";

type SocketEvent = "open" | "message" | "error" | "close";

class FakeSocket implements RealtimeWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<SocketEvent, Array<(...args: unknown[]) => void>>();

  send(data: string) {
    if (this.readyState !== 1) throw new Error("fake socket is not open");
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.dispatch("close", code, Buffer.from(reason));
  }

  terminate() {
    this.readyState = 3;
    this.dispatch("close", 1006, Buffer.from("terminated"));
  }

  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): unknown;
  on(event: SocketEvent, listener: (...args: never[]) => void): unknown {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  open() {
    this.readyState = 1;
    this.dispatch("open");
  }

  receive(message: Record<string, unknown> | string) {
    this.dispatch("message", typeof message === "string" ? message : JSON.stringify(message));
  }

  receiveRaw(message: unknown) {
    this.dispatch("message", message);
  }

  serverClose(code = 1006, reason = "server closed") {
    this.readyState = 3;
    this.dispatch("close", code, Buffer.from(reason));
  }

  transportError(error: unknown) {
    this.dispatch("error", error);
  }

  private dispatch(event: SocketEvent, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function harness(overrides: Partial<ConstructorParameters<typeof GeminiLiveClient>[0]> = {}) {
  let socket: FakeSocket | undefined;
  const sockets: FakeSocket[] = [];
  let connectedUrl = "";
  let connectedHeaders: Record<string, string> | undefined;
  const events: NormalizedRealtimeEvent[] = [];
  const factory: RealtimeWebSocketFactory = (url, options) => {
    connectedUrl = url;
    connectedHeaders = options.headers;
    socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const client = new GeminiLiveClient({
    apiKey: "gemini-key/+",
    model: "gemini-3.1-flash-live-preview",
    voice: "Kore",
    instructions: "Follow the durable workflow.",
    executeCapabilityGateway: async () => ({ ok: true }),
    webSocketFactory: factory,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return {
    client,
    events,
    sockets,
    get socket() {
      if (!socket) throw new Error("connect() has not created a socket");
      return socket;
    },
    get connectedUrl() { return connectedUrl; },
    get connectedHeaders() { return connectedHeaders; },
  };
}

async function settle() {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function connectReady(test: ReturnType<typeof harness>) {
  const connected = test.client.connect();
  test.socket.open();
  test.socket.receive({ setupComplete: { sessionId: "session-1" } });
  await settle();
  await connected;
}

function inputAudio(...bytes: number[]) {
  return {
    encoding: "pcm16" as const,
    sampleRateHz: GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
    channels: 1 as const,
    data: Uint8Array.from(bytes),
  };
}

describe("GeminiLiveClient", () => {
  it("sends setup first, fixes the gateway tool, and frames mono PCM16 with manual activity", async () => {
    const test = harness({ resumeHandle: "resume-old" });
    const connected = test.client.connect();
    test.socket.open();

    expect(test.socket.sent).toHaveLength(1);
    expect(() => test.client.startActivity()).toThrow("setup is not complete");
    const setup = JSON.parse(test.socket.sent[0]);
    expect(setup).toMatchObject({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
        },
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: true },
          activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
        },
        sessionResumption: { handle: "resume-old" },
      },
    });
    expect(setup.setup.tools).toHaveLength(1);
    expect(setup.setup.tools[0].functionDeclarations).toHaveLength(1);
    expect(setup.setup.tools[0].functionDeclarations[0]).toMatchObject({
      name: GEMINI_CAPABILITY_GATEWAY_NAME,
      behavior: "BLOCKING",
    });
    expect(setup.setup.sessionResumption).not.toHaveProperty("transparent");
    expect(new URL(test.connectedUrl).searchParams.get("key")).toBe("gemini-key/+");
    expect(test.connectedHeaders).toEqual({});

    test.socket.receive({ setupComplete: { sessionId: "session-1" } });
    await settle();
    await connected;

    test.client.appendInputAudio(inputAudio(1, 0, 2, 0));
    test.client.commitInputAudio();
    expect(test.socket.sent.slice(1).map((message) => JSON.parse(message))).toEqual([
      { realtimeInput: { activityStart: {} } },
      {
        realtimeInput: {
          audio: { data: "AQACAA==", mimeType: "audio/pcm;rate=16000" },
        },
      },
      { realtimeInput: { activityEnd: {} } },
    ]);
    expect(test.client.state).toBe("ready");
    expect(test.events.some((event) => event.type === "session.ready" && event.sessionId === "session-1")).toBe(true);
  });

  it("fails closed on mixed or non-setup events before setup acknowledgement", async () => {
    let executions = 0;
    const test = harness({
      executeCapabilityGateway: async () => {
        executions += 1;
        return { ok: true };
      },
    });
    const connected = test.client.connect();
    test.socket.open();
    test.socket.receive({
      setupComplete: {},
      toolCall: {
        functionCalls: [{ id: "early", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: {} }],
      },
    });
    await expect(connected).rejects.toThrow("invalid or non-exclusive setup acknowledgement");
    await settle();

    expect(executions).toBe(0);
    expect(test.client.state).toBe("failed");
    expect(test.socket.sent).toHaveLength(1);
    expect(test.events.some(
      (event) => event.type === "error" && event.code === "invalid_setup_ack" && event.fatal,
    )).toBe(true);
  });

  it("processes every content part and assembles cumulative input and output transcripts", async () => {
    const test = harness();
    await connectReady(test);
    test.client.sendTurn(inputAudio(1, 0));

    test.socket.receive({
      serverContent: {
        inputTranscription: { text: "hel" },
        outputTranscription: { text: "Good" },
        modelTurn: {
          parts: [
            { text: "internal text channel" },
            { inlineData: { data: "AQA=", mimeType: "audio/pcm;rate=24000" } },
            { executableCode: { language: "PYTHON", code: "pass" } },
            { inlineData: { data: "AgA=", mimeType: "audio/pcm;rate=24000" } },
          ],
        },
      },
    });
    test.socket.receive({
      serverContent: {
        inputTranscription: { text: "hello", finished: true },
        outputTranscription: { text: "Good day", finished: true },
        generationComplete: true,
        turnComplete: true,
      },
    });
    await settle();

    const contentParts = test.events.filter(
      (event) => event.type === "provider.event" && event.data.name === "content.part",
    );
    expect(contentParts).toHaveLength(4);

    const audio = test.events.filter((event) => event.type === "output.audio");
    expect(audio).toHaveLength(2);
    expect(audio.map((event) => event.type === "output.audio" ? Array.from(event.audio) : [])).toEqual([[1, 0], [2, 0]]);
    expect(audio.every(
      (event) => event.type === "output.audio" && event.format.sampleRateHz === GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ,
    )).toBe(true);

    const input = test.events.filter((event) => event.type === "input.transcript");
    expect(input.map((event) => event.type === "input.transcript"
      ? { text: event.text, delta: event.delta, phase: event.phase }
      : null)).toEqual([
      { text: "hel", delta: "hel", phase: "delta" },
      { text: "hello", delta: "lo", phase: "final" },
    ]);
    const output = test.events.filter((event) => event.type === "output.transcript");
    expect(output.map((event) => event.type === "output.transcript"
      ? { text: event.text, delta: event.delta, phase: event.phase, source: event.source }
      : null)).toEqual([
      { text: "Good", delta: "Good", phase: "delta", source: "audio" },
      { text: "Good day", delta: " day", phase: "final", source: "audio" },
    ]);
    expect(test.events.filter((event) => event.type === "response.completed")).toHaveLength(1);
  });

  it("clones normalized PCM bytes per listener so one observer cannot corrupt another", async () => {
    const test = harness();
    let secondListenerFirstByte: number | undefined;
    test.client.onEvent((event) => {
      if (event.type === "output.audio") event.audio[0] = 99;
    });
    test.client.onEvent((event) => {
      if (event.type === "output.audio") secondListenerFirstByte = event.audio[0];
    });
    await connectReady(test);
    test.socket.receive({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "AQA=", mimeType: "audio/pcm;rate=24000" } }] },
      },
    });
    await settle();

    expect(secondListenerFirstByte).toBe(1);
    const captured = test.events.find((event) => event.type === "output.audio");
    expect(captured?.type === "output.audio" ? captured.audio[0] : undefined).toBe(1);
  });

  it("keeps late, independently delivered transcription on the completed Gemini response", async () => {
    const test = harness();
    await connectReady(test);
    test.socket.receive({ serverContent: { outputTranscription: { text: "Good" } } });
    test.socket.receive({ serverContent: { generationComplete: true, turnComplete: true } });
    test.socket.receive({
      serverContent: { outputTranscription: { text: "Good afternoon", finished: true } },
    });
    await settle();

    const transcripts = test.events.filter((event) => event.type === "output.transcript");
    const firstResponseId = transcripts[0]?.type === "output.transcript" ? transcripts[0].responseId : undefined;
    const late = transcripts.at(-1);
    expect(late?.type === "output.transcript" ? late : undefined).toMatchObject({
      text: "Good afternoon",
      delta: " afternoon",
      phase: "final",
      responseId: firstResponseId,
      revised: true,
    });
    expect(test.events.filter((event) => event.type === "response.started")).toHaveLength(1);
  });

  it("reports cumulative transcript corrections without concatenating the rejected hypothesis", async () => {
    const test = harness();
    await connectReady(test);
    test.client.sendTurn(inputAudio(1, 0));
    test.socket.receive({ serverContent: { inputTranscription: { text: "I need a cap" } } });
    test.socket.receive({ serverContent: { inputTranscription: { text: "I need a cat", finished: true } } });
    await settle();

    const transcripts = test.events.filter((event) => event.type === "input.transcript");
    const corrected = transcripts.at(-1);
    expect(corrected?.type === "input.transcript" ? corrected : undefined).toMatchObject({
      text: "I need a cat",
      phase: "final",
      revised: true,
    });
    expect(corrected?.type === "input.transcript" ? corrected.text : "").not.toContain("capI need");
  });

  it("does not misattribute independently ordered prior-turn transcript fragments to a new turn", async () => {
    const test = harness();
    await connectReady(test);
    test.client.sendTurn(inputAudio(1, 0));
    test.socket.receive({
      serverContent: {
        inputTranscription: { text: "turn one caller" },
        outputTranscription: { text: "turn one agent" },
        turnComplete: true,
      },
    });
    await settle();

    test.client.sendTurn(inputAudio(2, 0));
    test.socket.receive({
      serverContent: {
        inputTranscription: { text: "late turn one caller fragment" },
        outputTranscription: { text: "late turn one agent fragment" },
        modelTurn: { parts: [{ text: "new response began" }] },
      },
    });
    await settle();

    expect(test.events.some(
      (event) => event.type === "input.transcript" && event.itemId === "gemini-input-2",
    )).toBe(false);
    const responseStarts = test.events.filter((event) => event.type === "response.started");
    const secondResponseId = responseStarts.at(-1)?.type === "response.started"
      ? responseStarts.at(-1)?.responseId
      : undefined;
    expect(test.events.some(
      (event) => event.type === "output.transcript" && event.responseId === secondResponseId,
    )).toBe(false);
    const unattributed = test.events.filter(
      (event) => event.type === "provider.event" && event.data.name === "transcription.unattributed",
    );
    expect(unattributed).toHaveLength(2);
    expect(unattributed.map((event) => event.type === "provider.event" ? event.data.direction : "")).toEqual([
      "input",
      "output",
    ]);
  });

  it("matches batched function response IDs, rejects non-gateway tools, and deduplicates retries", async () => {
    let executions = 0;
    const test = harness({
      executeCapabilityGateway: async () => {
        executions += 1;
        const output: Record<string, unknown> = { ok: true, receipt: BigInt(7) };
        output.self = output;
        return output;
      },
    });
    await connectReady(test);
    const sentBefore = test.socket.sent.length;
    test.socket.receive({
      toolCall: {
        functionCalls: [
          {
            id: "call-1",
            name: GEMINI_CAPABILITY_GATEWAY_NAME,
            args: { operation: "lookup", arguments: { id: "M-1" } },
          },
          { id: "call-2", name: "dangerous_leaf_tool", args: {} },
        ],
      },
    });
    await settle();

    expect(executions).toBe(1);
    expect(test.events.filter((event) => event.type === "tool.calls")).toHaveLength(1);
    const response = JSON.parse(test.socket.sent[sentBefore]);
    expect(response.toolResponse.functionResponses.map((item: { id: string }) => item.id)).toEqual(["call-1", "call-2"]);
    expect(response.toolResponse.functionResponses[0]).toMatchObject({
      id: "call-1",
      name: GEMINI_CAPABILITY_GATEWAY_NAME,
      response: { output: { ok: true, receipt: "7", self: "[Circular]" } },
    });
    expect(response.toolResponse.functionResponses[1]).toMatchObject({
      id: "call-2",
      name: "dangerous_leaf_tool",
      response: { error: { message: expect.stringContaining("Only capability_gateway") } },
    });

    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "call-1",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { operation: "lookup", arguments: { id: "M-1" } },
        }],
      },
    });
    await settle();
    expect(executions).toBe(1);
    expect(test.events.filter((event) => event.type === "tool.calls")).toHaveLength(2);
    const retried = JSON.parse(test.socket.sent.at(-1)!);
    expect(retried.toolResponse.functionResponses).toHaveLength(1);
    expect(retried.toolResponse.functionResponses[0].id).toBe("call-1");
  });

  it("rejects a duplicate function-call ID whose canonical name or arguments changed", async () => {
    let executions = 0;
    const test = harness({
      executeCapabilityGateway: async () => ({ execution: ++executions }),
    });
    await connectReady(test);
    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "stable-id",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { operation: "lookup", arguments: { id: "A" } },
        }],
      },
    });
    await settle();
    expect(executions).toBe(1);

    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "stable-id",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { operation: "delete", arguments: { id: "B" } },
        }],
      },
    });
    await settle();

    expect(executions).toBe(1);
    const response = JSON.parse(test.socket.sent.at(-1)!);
    expect(response.toolResponse.functionResponses[0]).toMatchObject({
      id: "stable-id",
      response: { error: { message: expect.stringContaining("reused with a different") } },
    });
    expect(response.toolResponse.functionResponses[0].response).not.toHaveProperty("output");
    expect(test.events.some(
      (event) => event.type === "error" && event.code === "duplicate_tool_call_conflict",
    )).toBe(true);
  });

  it("isolates protocol processing from mutations attempted by raw wire observers", async () => {
    let rawWasDeepFrozen = false;
    let wireWasDeepFrozen = false;
    let executedOperation = "";
    const mutate = (message: Readonly<Record<string, unknown>>) => {
      const toolCall = message.toolCall as Record<string, unknown>;
      const calls = toolCall.functionCalls as Array<Record<string, unknown>>;
      const call = calls[0];
      const args = call.args as Record<string, unknown>;
      try { call.name = "mutated_tool"; } catch { /* expected for frozen wire data */ }
      try { args.operation = "mutated_operation"; } catch { /* expected for frozen wire data */ }
    };
    const test = harness({
      executeCapabilityGateway: async ({ arguments: args }) => {
        executedOperation = String(args.operation);
        return { ok: true };
      },
      onRawMessage: (message) => {
        if (!message.toolCall || typeof message.toolCall !== "object") return;
        const toolCall = message.toolCall as Record<string, unknown>;
        const calls = toolCall.functionCalls as object[];
        rawWasDeepFrozen = Object.isFrozen(message)
          && Object.isFrozen(toolCall)
          && Object.isFrozen(calls)
          && Object.isFrozen(calls[0]);
        mutate(message);
      },
    });
    test.client.onWireEvent((message) => {
      if (!message.toolCall || typeof message.toolCall !== "object") return;
      const toolCall = message.toolCall as Record<string, unknown>;
      const calls = toolCall.functionCalls as object[];
      wireWasDeepFrozen = Object.isFrozen(message)
        && Object.isFrozen(toolCall)
        && Object.isFrozen(calls)
        && Object.isFrozen(calls[0]);
      mutate(message);
    });
    await connectReady(test);

    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "immutable-1",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { operation: "original_operation", arguments: {} },
        }],
      },
    });
    await settle();

    expect(rawWasDeepFrozen).toBe(true);
    expect(wireWasDeepFrozen).toBe(true);
    expect(executedOperation).toBe("original_operation");
    const batches = test.events.filter((event) => event.type === "tool.calls");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.type === "tool.calls" ? batches[0].calls[0] : undefined).toMatchObject({
      callId: "immutable-1",
      name: GEMINI_CAPABILITY_GATEWAY_NAME,
      argumentsJson: { operation: "original_operation", arguments: {} },
    });
    const response = JSON.parse(test.socket.sent.at(-1)!);
    expect(response.toolResponse.functionResponses[0]).toMatchObject({
      id: "immutable-1",
      name: GEMINI_CAPABILITY_GATEWAY_NAME,
    });
  });

  it("supports an external gateway executor through the normalized tool-result API", async () => {
    const test = harness({ executeCapabilityGateway: undefined });
    await connectReady(test);
    const sentBefore = test.socket.sent.length;
    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "manual-1",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { operation: "check", arguments: {} },
        }],
      },
    });
    await settle();
    expect(test.socket.sent).toHaveLength(sentBefore);

    test.client.submitToolResults([{ callId: "manual-1", output: { eligible: true } }], true);
    expect(test.socket.sent).toHaveLength(sentBefore + 1);
    expect(JSON.parse(test.socket.sent.at(-1)!)).toEqual({
      toolResponse: {
        functionResponses: [{
          id: "manual-1",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          response: { output: { eligible: true } },
        }],
      },
    });
    expect(test.events.some(
      (event) => event.type === "provider.event" && event.data.name === "response_creation_is_implicit",
    )).toBe(true);
  });

  it("keeps internal and external tool execution mutually exclusive and caps whole result batches", async () => {
    const internal = harness();
    await connectReady(internal);
    expect(() => internal.client.submitToolResults([{ callId: "x", output: {} }]))
      .toThrow("internal tool execution");

    const external = harness({ executeCapabilityGateway: undefined, maxToolResponseBytes: 180 });
    await connectReady(external);
    external.socket.receive({
      toolCall: {
        functionCalls: [
          { id: "batch-1", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: { operation: "a", arguments: {} } },
          { id: "batch-2", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: { operation: "b", arguments: {} } },
        ],
      },
    });
    await settle();
    const sentBefore = external.socket.sent.length;
    expect(() => external.client.submitToolResults([
      { callId: "batch-1", output: { value: "a".repeat(30) } },
      { callId: "batch-2", output: { value: "b".repeat(30) } },
    ])).toThrow("batch was too large");
    expect(external.socket.sent).toHaveLength(sentBefore);
  });

  it("aborts cancelled gateway work and never sends its late result", async () => {
    let signal: AbortSignal | undefined;
    const test = harness({
      executeCapabilityGateway: ({ signal: received }) => {
        signal = received;
        return new Promise((_resolve, reject) => {
          received.addEventListener("abort", () => reject(received.reason), { once: true });
        });
      },
    });
    await connectReady(test);
    const sentBefore = test.socket.sent.length;
    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "cancel-1",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { operation: "slow", arguments: {} },
        }],
      },
    });
    await settle();
    expect(signal?.aborted).toBe(false);

    test.socket.receive({ toolCallCancellation: { ids: ["cancel-1"] } });
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(test.socket.sent).toHaveLength(sentBefore);
    expect(test.events.some(
      (event) => event.type === "tool.cancelled" && event.callIds[0] === "cancel-1",
    )).toBe(true);
  });

  it("binds stale socket events and pending tool results to their original connection epoch", async () => {
    let resolveTool: ((value: unknown) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    let executions = 0;
    const test = harness({
      executeCapabilityGateway: ({ signal }) => {
        executions += 1;
        oldSignal = signal;
        return new Promise((resolve) => { resolveTool = resolve; });
      },
    });
    await connectReady(test);
    const firstSocket = test.socket;
    firstSocket.receive({
      toolCall: {
        functionCalls: [{
          id: "old-call",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { operation: "slow", arguments: {} },
        }],
      },
    });
    await settle();
    expect(executions).toBe(1);

    firstSocket.serverClose();
    expect(oldSignal?.aborted).toBe(true);
    const reconnected = test.client.connect();
    const secondSocket = test.socket;
    secondSocket.open();
    secondSocket.receive({ setupComplete: { sessionId: "session-2" } });
    await settle();
    await reconnected;
    const secondSentAfterSetup = secondSocket.sent.length;

    resolveTool?.({ should_not_escape: true });
    firstSocket.receive({
      toolCall: {
        functionCalls: [{
          id: "stale-call",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { operation: "stale", arguments: {} },
        }],
      },
    });
    firstSocket.serverClose(1006, "late old close");
    await settle();

    expect(test.client.state).toBe("ready");
    expect(executions).toBe(1);
    expect(secondSocket.sent).toHaveLength(secondSentAfterSetup);
  });

  it("rejects setup immediately on close and never lets the cleared setup timer fire", async () => {
    const test = harness({ connectTimeoutMs: 10 });
    const connected = test.client.connect();
    test.socket.open();
    test.client.close();
    await expect(connected).rejects.toThrow("closed before setup completed");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(test.client.state).toBe("closed");
    expect(test.events.some(
      (event) => event.type === "error" && event.code === "setup_timeout",
    )).toBe(false);
  });

  it("survives malformed JSON and records usage, go-away, and resumable handles", async () => {
    let publishedResumeHandle = "";
    const test = harness({
      onRawMessage: (message) => {
        if (message.sessionResumptionUpdate && typeof message.sessionResumptionUpdate === "object") {
          publishedResumeHandle = String(
            (message.sessionResumptionUpdate as Record<string, unknown>).newHandle ?? "",
          );
        }
      },
    });
    await connectReady(test);
    test.socket.receive("{not-json");
    test.socket.receive({
      usageMetadata: {
        promptTokenCount: 120,
        cachedContentTokenCount: 20,
        responseTokenCount: 40,
        totalTokenCount: 160,
        promptTokensDetails: [
          { modality: "AUDIO", tokenCount: 100 },
          { modality: "TEXT", tokenCount: 20 },
        ],
        responseTokensDetails: [{ modality: "AUDIO", tokenCount: 40 }],
      },
      sessionResumptionUpdate: {
        resumable: true,
        newHandle: "resume-new",
        lastConsumedClientMessageIndex: "12",
      },
    });
    test.socket.receive({ goAway: { timeLeft: "2.5s" } });
    await settle();

    expect(test.events.some(
      (event) => event.type === "error" && event.message === "Gemini returned malformed JSON",
    )).toBe(true);
    const usage = test.events.find((event) => event.type === "usage");
    expect(usage?.type === "usage" ? usage.usage : undefined).toMatchObject({
      totalInputTokens: 120,
      cachedInputTokens: 20,
      totalOutputTokens: 40,
      totalTokens: 160,
      inputAudioTokens: 100,
      inputTextTokens: 20,
      outputAudioTokens: 40,
    });
    expect(test.client.resumeState).toMatchObject({ handle: "resume-new", resumable: true });
    expect(publishedResumeHandle).toMatch(/^sha256:/);
    expect(publishedResumeHandle).not.toContain("resume-new");
    expect(test.events.some(
      (event) => event.type === "session.resumption" && event.handle.startsWith("sha256:") && event.resumable,
    )).toBe(true);
    expect(test.events.some(
      (event) => event.type === "connection.go_away" && event.disconnectInMs === 2_500,
    )).toBe(true);

    test.socket.receive({ sessionResumptionUpdate: { resumable: false } });
    await settle();
    expect(test.client.resumeState).toMatchObject({ handle: undefined, resumable: false });
  });

  it("rejects oversized binary wire frames before decoding them", async () => {
    const test = harness({ maxIncomingMessageBytes: 64 });
    await connectReady(test);
    test.socket.receiveRaw(Buffer.alloc(65, 0x7b));
    await settle();

    expect(test.client.state).toBe("ready");
    expect(test.events.some(
      (event) => event.type === "error" && event.message.includes("exceeded 64 bytes"),
    )).toBe(true);
  });

  it("captures one wall and monotonic arrival timestamp for every event derived from a wire frame", async () => {
    let wall = 1_000;
    let monotonic = 50;
    const test = harness({
      now: () => wall++,
      monotonicNow: () => monotonic++,
    });
    await connectReady(test);
    test.client.sendTurn(inputAudio(1, 0));
    const before = test.events.length;
    test.socket.receive({
      serverContent: { generationComplete: true, turnComplete: true },
      usageMetadata: { promptTokenCount: 10, responseTokenCount: 2, totalTokenCount: 12 },
    });
    await settle();

    const derived = test.events.slice(before);
    expect(derived.length).toBeGreaterThan(2);
    expect(new Set(derived.map((event) => event.receivedAtMs)).size).toBe(1);
    expect(new Set(derived.map((event) => event.receivedAtMonotonicMs)).size).toBe(1);
    const usage = derived.find((event) => event.type === "usage");
    expect(usage?.type === "usage" ? usage : undefined).toMatchObject({
      scope: "response",
      turnId: "gemini-turn-1",
      responseId: expect.stringMatching(/^gemini-response-/),
      usage: { raw: { promptTokenCount: 10, responseTokenCount: 2, totalTokenCount: 12 } },
    });
  });

  it("treats missing or non-24k raw PCM MIME as fatal and emits no mislabeled audio", async () => {
    const test = harness();
    await connectReady(test);
    test.socket.receive({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "AQA=", mimeType: "audio/pcm;rate=16000" } }] },
      },
    });
    await settle();

    expect(test.client.state).toBe("failed");
    expect(test.events.some((event) => event.type === "output.audio")).toBe(false);
    expect(test.events.some(
      (event) => event.type === "error" && event.code === "invalid_output_audio_format" && event.fatal,
    )).toBe(true);
  });

  it("preserves terminal semantics for zero-content rejection and post-generation interruption", async () => {
    const rejected = harness();
    await connectReady(rejected);
    rejected.socket.receive({
      serverContent: { turnComplete: true, turnCompleteReason: "RESPONSE_REJECTED" },
    });
    await settle();
    expect(rejected.events.filter((event) => event.type === "response.started")).toHaveLength(1);
    const rejectedCompletion = rejected.events.find((event) => event.type === "response.completed");
    expect(rejectedCompletion?.type === "response.completed" ? rejectedCompletion.status : undefined)
      .toBe("failed:RESPONSE_REJECTED");
    expect(rejected.events.some(
      (event) => event.type === "error" && event.code === "response_rejected",
    )).toBe(true);

    const interrupted = harness();
    await connectReady(interrupted);
    interrupted.socket.receive({ serverContent: { generationComplete: true } });
    interrupted.socket.receive({ serverContent: { interrupted: true } });
    interrupted.socket.receive({ serverContent: { turnComplete: true } });
    await settle();
    const completions = interrupted.events.filter((event) => event.type === "response.completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.type === "response.completed" ? completions[0].status : undefined)
      .toBe("interrupted");
  });

  it("never exposes an authenticated key-bearing URL through transport diagnostics", async () => {
    const key = "super-secret/+token";
    const factoryEvents: NormalizedRealtimeEvent[] = [];
    const factoryClient = new GeminiLiveClient({
      apiKey: key,
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      instructions: "test",
      executeCapabilityGateway: async () => ({}),
      webSocketFactory: (url) => { throw new Error(`failed ${url}`); },
      onEvent: (event) => factoryEvents.push(event),
    });
    await expect(factoryClient.connect()).rejects.toThrow("WebSocket factory failed");
    expect(JSON.stringify(factoryEvents)).not.toContain(key);
    expect(JSON.stringify(factoryEvents)).not.toContain(encodeURIComponent(key));

    const transport = harness({ apiKey: key });
    await connectReady(transport);
    transport.socket.transportError(new Error(`transport ${transport.connectedUrl}`));
    await settle();
    const evidence = JSON.stringify(transport.events);
    expect(evidence).not.toContain(key);
    expect(evidence).not.toContain(encodeURIComponent(key));
    expect(transport.events.some(
      (event) => event.type === "error" && event.message === "Gemini Live WebSocket failed",
    )).toBe(true);
  });

  it("rejects a connection that closes before setup completes", async () => {
    const test = harness();
    const connected = test.client.connect();
    test.socket.open();
    test.socket.serverClose(1006, "setup rejected");
    await expect(connected).rejects.toThrow("closed before setup completed");
    expect(test.client.state).toBe("closed");
  });
});
