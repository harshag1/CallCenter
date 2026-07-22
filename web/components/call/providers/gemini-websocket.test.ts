import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_GATEWAY_FUNCTION_NAME } from "./capability-gateway";
import {
  buildGeminiBrowserFunctionDeclarations,
  buildGeminiBrowserSetup,
  GeminiWebSocketTransport,
  isGeminiSetupCompleteMessage,
} from "./gemini-websocket";
import type { RealtimeTransportStart } from "./types";
import { OutboundSpeechGate, createOutboundSpeechGatePolicy } from "@/lib/realtime/outbound-speech-gate";

const ORIGIN = "https://voice.example.test";
const TOKEN = `scope.${"a".repeat(96)}`;
const MCP_SESSION_ID = `hacc.v1.${"A".repeat(22)}.${"B".repeat(43)}`;
const INITIAL_CATALOG_DIGEST = "a".repeat(64);
const RESULT_CATALOG_DIGEST = "3abcd5265643ebb4c444771637530b52cde40c255231d25e0dd15f267a971154";
const TOOL_PROXY_ROTATION = {
  endpoint: "/api/voice/capabilities/rotate" as const,
  callId: "00000000-0000-4000-8000-000000000001",
  rotation: 0,
  renewalToken: `renewal.${"r".repeat(96)}`,
  refreshAfter: "2099-01-01T00:25:00.000Z",
  expiresAt: "2099-01-01T00:30:00.000Z",
};

function gatewayEnvelope(outcome: unknown) {
  return {
    schema_version: 1,
    outcome,
    active_capability_catalog: {
      schema_version: 1,
      availability: "active",
      runtime_digest: "e".repeat(64),
      capability_epoch: 2,
      state_revision: 2,
      scope: { status: "active", topic: "membership", step: "lookup", attempt: 1 },
      active_context: { guidance: "Continue." },
      catalog_digest: RESULT_CATALOG_DIGEST,
      tools: [],
    },
  };
}

function gatewayResponse(id: string | number, result: unknown, sessionId?: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
    },
  });
}

function requestBody(init?: RequestInit) {
  return JSON.parse(String(init?.body)) as {
    id?: string | number;
    method: string;
    params?: Record<string, unknown>;
  };
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly url: string;
  closeCode: number | undefined;
  closeReason: string | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("fake socket is not open");
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(value: unknown) {
    this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) });
  }
}

function audioHarness() {
  const processor = {
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
    connect: vi.fn((node: unknown) => node),
    disconnect: vi.fn(),
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const mute = {
    gain: { value: 1 },
    connect: vi.fn((node: unknown) => node),
    disconnect: vi.fn(),
  };
  const destination = {};
  const audioContext = {
    sampleRate: 48_000,
    destination,
    currentTime: 0,
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
    createGain: vi.fn(() => mute),
  } as unknown as AudioContext;
  return { audioContext, processor, source, mute, destination };
}

function transportArgs(overrides: Partial<RealtimeTransportStart> = {}) {
  const audio = audioHarness();
  const handlers = {
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const args: RealtimeTransportStart = {
    connection: {
      provider: "gemini",
      transport: "websocket",
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      token: "ephemeral",
      wsUrl: "wss://gemini.example.test/live?access_token=secret",
      setup: {
        setup: {
          model: "models/gemini-3.1-flash-live-preview",
          systemInstruction: { parts: [{ text: "Follow the flow." }] },
          sessionResumption: {},
          tools: [{ functionDeclarations: [{ name: "stale_tool" }] }],
        },
      },
      toolProxyUrl: `${ORIGIN}/api/mcp`,
      toolProxyToken: TOKEN,
      toolProxyRotation: TOOL_PROXY_ROTATION,
      activeCatalogAuthority: {
        catalogDigest: INITIAL_CATALOG_DIGEST,
        capabilityEpoch: 1,
        runtimeDigest: "e".repeat(64),
        stateRevision: 1,
      },
    },
    mic: {} as MediaStream,
    audioContext: audio.audioContext,
    recordingDestination: {} as MediaStreamAudioDestinationNode,
    handlers,
    ...overrides,
  };
  return { args, handlers, ...audio };
}

function installBrowserGlobals() {
  vi.stubGlobal("location", { origin: ORIGIN });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
}

function installGatewayFetch(options: { errorTargets?: ReadonlySet<string> } = {}) {
  const calls: ReturnType<typeof requestBody>[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    const request = requestBody(init);
    if (request.method === "initialize") {
      return gatewayResponse(request.id!, {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: { name: "hacc", version: "1.0.0" },
      }, MCP_SESSION_ID);
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    calls.push(request);
    const params = request.params ?? {};
    const target = String(params.name ?? "");
    const isError = options.errorTargets?.has(target) ?? false;
    const outcome = isError
      ? { error: "denied", code: "guardrail_denied", retryable: false }
      : { ok: true, target };
    return gatewayResponse(request.id!, {
      content: [{ type: "text", text: JSON.stringify(gatewayEnvelope(outcome)) }],
      isError,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWebSocket.instances.length = 0;
});

describe("Gemini browser capability gateway transport", () => {
  it("publishes one immutable local gateway declaration and removes unsupported resumption", () => {
    const declarations = buildGeminiBrowserFunctionDeclarations();
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatchObject({
      name: CAPABILITY_GATEWAY_FUNCTION_NAME,
      behavior: "BLOCKING",
      parametersJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tool_name: { type: "string" },
          arguments: { type: "object", additionalProperties: true },
        },
        required: ["tool_name", "arguments"],
      },
    });
    expect(declarations[0]).not.toHaveProperty("parameters");

    const frame = buildGeminiBrowserSetup({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        sessionResumption: {},
        tools: [{ functionDeclarations: [{ name: "provider_direct_tool" }] }],
      },
    });
    expect(frame).toMatchObject({ setup: { tools: [{ functionDeclarations: declarations }] } });
    expect((frame.setup as Record<string, unknown>)).not.toHaveProperty("sessionResumption");
    expect((frame.setup as Record<string, unknown>)).not.toHaveProperty("inputAudioTranscription");
    expect((frame.setup as Record<string, unknown>)).not.toHaveProperty("outputAudioTranscription");
    expect(JSON.stringify(frame)).not.toContain("provider_direct_tool");
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen((frame.setup as Record<string, unknown>).tools)).toBe(true);
  });

  it("fails closed if a browser connection payload tries to enable provider transcription", () => {
    for (const transcription of [
      { inputAudioTranscription: {} },
      { outputAudioTranscription: {} },
      { inputAudioTranscription: undefined },
    ]) {
      expect(() => buildGeminiBrowserSetup({
        setup: {
          model: "models/gemini-3.1-flash-live-preview",
          ...transcription,
        },
      })).toThrow(/provider transcription .* is disabled/);
    }
  });

  it("recognizes only Gemini's empty, exclusive setup acknowledgement", () => {
    expect(isGeminiSetupCompleteMessage({ setupComplete: {} })).toBe(true);
    expect(isGeminiSetupCompleteMessage({ setupComplete: {}, usageMetadata: {} })).toBe(true);
    expect(isGeminiSetupCompleteMessage({ setupComplete: { model: "fabricated" } })).toBe(false);
    expect(isGeminiSetupCompleteMessage({ setupComplete: {}, toolCall: {} })).toBe(false);
  });

  it("executes only terminal capability_gateway calls with exact host-bound provenance", async () => {
    installBrowserGlobals();
    const gateway = installGatewayFetch({ errorTargets: new Set(["forbidden_action"]) });
    const transport = new GeminiWebSocketTransport();
    const test = transportArgs();

    const started = transport.start(test.args);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const setup = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
    expect(test.audioContext.createScriptProcessor).toHaveBeenCalledWith(2048, 1, 1);
    expect(JSON.stringify(setup)).not.toContain("stale_tool");
    expect(JSON.stringify(setup)).not.toContain("sessionResumption");
    expect(setup).toMatchObject({
      setup: {
        tools: [{ functionDeclarations: [{ name: CAPABILITY_GATEWAY_FUNCTION_NAME, behavior: "BLOCKING" }] }],
      },
    });

    socket.receive({ setupComplete: {} });
    await started;
    expect(transport.setupReadinessEvidence).toEqual({
      acknowledgement: "setupComplete",
      fieldEchoAvailable: false,
      strictParityVerified: false,
      clientSentModel: "models/gemini-3.1-flash-live-preview",
      clientSentVoice: "Kore",
      clientSentToolNames: [CAPABILITY_GATEWAY_FUNCTION_NAME],
      providerTranscriptionPolicy: { input: "disabled", output: "disabled" },
    });

    socket.receive({
      toolCall: {
        functionCalls: [{
          id: "provider-call-1",
          name: CAPABILITY_GATEWAY_FUNCTION_NAME,
          args: { tool_name: "membership_lookup", arguments: { member_id: "M-1" } },
        }],
      },
    });
    await vi.waitFor(() => expect(gateway.calls).toHaveLength(1));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(gateway.calls[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: "membership_lookup",
        arguments: { member_id: "M-1" },
        _meta: {
          "hacc/provider_tool_call_id": "provider-call-1",
          "com.harsha.callcenter/provider-provenance": {
            schemaVersion: 1,
            provider: "gemini",
            nativeCallId: "provider-call-1",
            nativeResponseId: "gemini-toolCall:provider-call-1",
            terminalWireType: "toolCall",
          },
        },
      },
    });
    expect(JSON.parse(socket.sent[1]!)).toEqual({
      toolResponse: {
        functionResponses: [{
          id: "provider-call-1",
          name: CAPABILITY_GATEWAY_FUNCTION_NAME,
          response: {
            ...gatewayEnvelope({ ok: true, target: "membership_lookup" }),
          },
        }],
      },
    });

    socket.receive({
      toolCall: {
        functionCalls: [{
          id: "provider-call-2",
          name: CAPABILITY_GATEWAY_FUNCTION_NAME,
          args: { tool_name: "forbidden_action", arguments: {} },
        }],
      },
    });
    await vi.waitFor(() => expect(gateway.calls).toHaveLength(2));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(JSON.parse(socket.sent[2]!)).toMatchObject({
      toolResponse: {
        functionResponses: [{
          id: "provider-call-2",
          response: {
            error: gatewayEnvelope({
              error: "denied",
              code: "guardrail_denied",
              retryable: false,
            }),
          },
        }],
      },
    });

    const postInitialize = gateway.fetchMock.mock.calls.filter(([, init]) => requestBody(init).method !== "initialize");
    expect(postInitialize.every(([, init]) => new Headers(init?.headers).get("mcp-session-id") === MCP_SESSION_ID)).toBe(true);
    expect(new Headers(gateway.fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    await transport.stop();
    expect(test.handlers.onClose).not.toHaveBeenCalled();
  });

  it("closes without redispatch when a native call identity changes", async () => {
    installBrowserGlobals();
    const gateway = installGatewayFetch();
    const transport = new GeminiWebSocketTransport();
    const test = transportArgs();
    const started = transport.start(test.args);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({ setupComplete: {} });
    await started;

    const first = {
      id: "provider-call-stable",
      name: CAPABILITY_GATEWAY_FUNCTION_NAME,
      args: { tool_name: "membership_lookup", arguments: { member_id: "M-1" } },
    };
    socket.receive({ toolCall: { functionCalls: [first] } });
    await vi.waitFor(() => expect(gateway.calls).toHaveLength(1));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    socket.receive({
      toolCall: {
        functionCalls: [{
          ...first,
          args: { tool_name: "membership_lookup", arguments: { member_id: "M-2" } },
        }],
      },
    });

    await vi.waitFor(() => expect(socket.closeCode).toBe(1002));
    expect(gateway.calls).toHaveLength(1);
    expect(test.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("reused with different contents"),
    }));
  });

  it("rejects fabricated readiness and closes malformed events after readiness", async () => {
    installBrowserGlobals();
    installGatewayFetch();
    const fabricated = new GeminiWebSocketTransport();
    const fabricatedTest = transportArgs();
    const fabricatedStart = fabricated.start(fabricatedTest.args);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();
    firstSocket.receive({ setupComplete: { model: "not-an-echo" } });
    await expect(fabricatedStart).rejects.toThrow("invalid or non-exclusive setup acknowledgement");
    expect(fabricatedTest.processor.onaudioprocess).toBeNull();
    expect(firstSocket.closeCode).toBe(1002);

    const ready = new GeminiWebSocketTransport();
    const readyTest = transportArgs();
    const readyStart = ready.start(readyTest.args);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const secondSocket = FakeWebSocket.instances[1]!;
    secondSocket.open();
    secondSocket.receive({ setupComplete: {} });
    await readyStart;
    secondSocket.receive("{");
    expect(secondSocket.closeCode).toBe(1002);
    expect(readyTest.handlers.onError).toHaveBeenCalledWith(expect.any(Error));
    await ready.stop();
  });

  it("never surfaces provider-controlled error text", async () => {
    installBrowserGlobals();
    installGatewayFetch();
    const transport = new GeminiWebSocketTransport();
    const test = transportArgs();
    const started = transport.start(test.args);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({ setupComplete: {} });
    await started;

    socket.receive({
      error: {
        message: "Authorization: Bearer gemini-live-secret; caller alice@example.test",
      },
    });

    expect(test.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Gemini Live provider error",
    }));
    expect(JSON.stringify(test.handlers.onError.mock.calls)).not.toContain("gemini-live-secret");
    expect(JSON.stringify(test.handlers.onError.mock.calls)).not.toContain("alice@example.test");
  });

  it("quarantines Gemini PCM until turnComplete and records exact scheduled bytes", async () => {
    installBrowserGlobals();
    installGatewayFetch();
    const transport = new GeminiWebSocketTransport();
    const test = transportArgs();
    const playbackSource = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    const createBuffer = vi.fn((_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: vi.fn(),
    }));
    Object.assign(test.audioContext, {
      createBuffer,
      createBufferSource: vi.fn(() => playbackSource),
    });
    const onEvidence = vi.fn();
    test.args.outboundSpeechGate = {
      gate: new OutboundSpeechGate({
        policy: createOutboundSpeechGatePolicy({ evidencePolicy: "independent_asr_required" }),
        independentAsr: vi.fn(async (input) => ({
          text: "The safe answer",
          audioSha256: input.audioSha256,
          audioBytes: input.audioBytes,
          sampleRateHz: input.audio.sampleRateHz,
          channels: 1 as const,
          complete: true as const,
          engine: "test-independent-asr",
          receiptSha256: "d".repeat(64),
        })),
      }),
      onEvidence,
    };
    const started = transport.start(test.args);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({ setupComplete: {} });
    await started;

    socket.receive({
      serverContent: {
        modelTurn: {
          parts: [{
            inlineData: {
              mimeType: "audio/pcm;rate=24000",
              data: Buffer.from([1, 0, 2, 0]).toString("base64"),
            },
          }],
        },
        turnComplete: true,
      },
    });

    await vi.waitFor(() => expect(onEvidence).toHaveBeenCalledTimes(1));
    expect(createBuffer).toHaveBeenCalledTimes(1);
    expect(onEvidence.mock.calls[0][0]).toMatchObject({
      provider: "gemini",
      decision: { action: "release", evidenceCoverage: "exact_buffered_pcm" },
      playout: { status: "released_to_audio_context", audioBytes: 4 },
    });
    expect(transport.outboundSpeechGateSupport.supported).toBe(true);
    await transport.stop();
  });

  it("closes a mixed server-message union before dispatching any tool", async () => {
    installBrowserGlobals();
    const gateway = installGatewayFetch();
    const transport = new GeminiWebSocketTransport();
    const test = transportArgs();
    const started = transport.start(test.args);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({ setupComplete: {} });
    await started;

    socket.receive({
      serverContent: { turnComplete: true },
      toolCall: {
        functionCalls: [{
          id: "must-not-dispatch",
          name: CAPABILITY_GATEWAY_FUNCTION_NAME,
          args: { tool_name: "membership_lookup", arguments: {} },
        }],
      },
    });

    expect(socket.closeCode).toBe(1002);
    expect(gateway.calls).toHaveLength(0);
    expect(test.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("mutually exclusive"),
    }));
    await transport.stop();
  });

  it("aborts gateway initialization when stopped during startup", async () => {
    installBrowserGlobals();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GeminiWebSocketTransport();
    const test = transportArgs();
    const started = transport.start(test.args);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await transport.stop();
    await expect(started).rejects.toThrow("stopped");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(test.audioContext.createMediaStreamSource).not.toHaveBeenCalled();
  });
});
