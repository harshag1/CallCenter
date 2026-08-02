import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildXaiBrowserSessionUpdate,
  verifyXaiBrowserSessionAcknowledgement,
  XaiWebSocketTransport,
} from "./xai-websocket";
import type { RealtimeTransportStart } from "./types";
import { OutboundSpeechGate, createOutboundSpeechGatePolicy } from "@/lib/realtime/outbound-speech-gate";

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

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closeCode: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string, readonly protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket closed");
    this.sent.push(data);
  }

  close(code = 1000) {
    this.closeCode = code;
    this.readyState = 3;
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

function sessionUpdate() {
  return {
    type: "session.update",
    session: {
      voice: "ara",
      instructions: "Follow the durable flow.",
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcm", rate: 24_000 }, transcription: { model: "grok-transcribe" } },
        output: { format: { type: "audio/pcm", rate: 24_000 } },
      },
      tools: [{
        type: "function",
        name: "capability_gateway",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            tool_name: { type: "string" },
            arguments: { type: "object" },
          },
          required: ["tool_name", "arguments"],
        },
      }],
      resumption: { enabled: true },
    },
  };
}

function acknowledged(overrides: Record<string, unknown> = {}) {
  return {
    type: "session.updated",
    session: {
      voice: "ara",
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcm", rate: 24_000 } },
        output: { format: { type: "audio/pcm", rate: 24_000 } },
      },
      resumption: { enabled: false },
      ...overrides,
    },
  };
}

function harness() {
  let rpc = 0;
  const gatewayRequests: Record<string, unknown>[] = [];
  const gatewayFetch = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    gatewayRequests.push(body);
    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: {},
          _meta: {
            "com.harsha.callcenter/provider-connection": {
              schemaVersion: 2,
              connectionId: `hacc.pc.v2.${"1".repeat(64)}.${"E".repeat(43)}`,
              connectionEpoch: 1,
              providerSessionIdSha256: null,
            },
          },
        },
      }), { headers: { "MCP-Session-Id": `hacc.v1.${"A".repeat(22)}.${"B".repeat(43)}` } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const params = body.params as Record<string, unknown>;
    const nativeId = (params._meta as Record<string, unknown>)["hacc/provider_tool_call_id"];
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(gatewayEnvelope({ called: nativeId })) }],
        isError: false,
      },
    }));
  });
  vi.stubGlobal("location", { origin: "https://voice.example.test" });
  vi.stubGlobal("fetch", gatewayFetch);
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++rpc).padStart(12, "0")}`);
  const processor = {
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
    connect: vi.fn((node: unknown) => node),
    disconnect: vi.fn(),
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const mute = { gain: { value: 1 }, connect: vi.fn((node: unknown) => node), disconnect: vi.fn() };
  const audioContext = {
    sampleRate: 48_000,
    currentTime: 0,
    destination: {},
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
    createGain: vi.fn(() => mute),
  } as unknown as AudioContext;
  const handlers = { onTranscript: vi.fn(), onError: vi.fn(), onClose: vi.fn() };
  const args: RealtimeTransportStart = {
    connection: {
      provider: "xai",
      transport: "websocket",
      model: "grok-voice-think-fast-1.0",
      voice: "ara",
      token: "ephemeral",
      wsUrl: "wss://api.x.ai/v1/realtime?model=grok",
      protocols: ["xai-client-secret.ephemeral"],
      sessionUpdate: sessionUpdate(),
      toolProxyUrl: "https://voice.example.test/api/mcp",
      toolProxyToken: `scope.${"a".repeat(96)}`,
      toolProxyRotation: TOOL_PROXY_ROTATION,
      activeCatalogAuthority: {
        catalogDigest: INITIAL_CATALOG_DIGEST,
        capabilityEpoch: 1,
        runtimeDigest: "e".repeat(64),
        stateRevision: 1,
      },
    },
    mic: {} as MediaStream,
    audioContext,
    recordingDestination: undefined,
    handlers,
  };
  return { args, audioContext, processor, source, mute, handlers, gatewayFetch, gatewayRequests };
}

async function settle() {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function initializeXaiSession(socket: FakeWebSocket, id = "s-1") {
  socket.open();
  expect(socket.sent).toEqual([]);
  socket.receive({ type: "session.created", session: { id } });
  expect(JSON.parse(socket.sent[0])).toMatchObject({
    type: "session.update",
    session: { resumption: { enabled: false } },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances.length = 0;
});

describe("xAI browser transport", () => {
  it("forces resumption off without mutating the server-provided update", () => {
    const raw = sessionUpdate();
    const update = buildXaiBrowserSessionUpdate(raw);
    expect(update).toMatchObject({ session: { resumption: { enabled: false } } });
    expect(raw.session.resumption.enabled).toBe(true);
  });

  it("verifies the acknowledged voice/audio/VAD boundary and reports unverifiable fields honestly", () => {
    const sent = buildXaiBrowserSessionUpdate(sessionUpdate());
    expect(verifyXaiBrowserSessionAcknowledgement(acknowledged(), sent, "s-1")).toEqual({
      acknowledgement: "session.updated",
      strictParityVerified: false,
      verifiedFields: ["voice", "input_audio_format", "output_audio_format", "turn_detection_type", "resumption_disabled"],
      unverifiableFields: [
        "model",
        "instructions",
        "tools",
        "tool_choice",
        "input_audio_configuration_except_format",
        "output_audio_configuration_except_format",
        "turn_detection_parameters",
      ],
      sessionIdentity: {
        source: "session.created",
        updatedContinuity: "unverifiable_session_updated_omitted_identity",
      },
      conversationIdentity: {
        source: "conversation.created",
        status: "not_observed_before_readiness",
      },
      modelIdentity: {
        source: "provider_echo",
        status: "unverifiable_provider_omitted",
      },
    });
    expect(() => verifyXaiBrowserSessionAcknowledgement(acknowledged({
      audio: {
        input: { format: { type: "audio/pcm", rate: 16_000 } },
        output: { format: { type: "audio/pcm", rate: 24_000 } },
      },
    }), sent, "s-1")).toThrow("audio.input.format.rate");
    expect(() => verifyXaiBrowserSessionAcknowledgement(acknowledged({
      resumption: { enabled: true },
    }), sent, "s-1")).toThrow("resumption.enabled");
    expect(() => verifyXaiBrowserSessionAcknowledgement(acknowledged({ id: "s-other" }), sent, "s-1"))
      .toThrow("session.id");
  });

  it("accepts bounded omitted echo fields but rejects every conflicting field that is returned", () => {
    const sent = buildXaiBrowserSessionUpdate(sessionUpdate());
    const omitted = verifyXaiBrowserSessionAcknowledgement(
      { type: "session.updated", session: {} },
      sent,
      "s-1",
      { expectedModel: "grok-voice-think-fast-1.0" },
    );
    expect(omitted).toEqual({
      acknowledgement: "session.updated",
      strictParityVerified: false,
      verifiedFields: [],
      unverifiableFields: [
        "model",
        "voice",
        "instructions",
        "tools",
        "tool_choice",
        "input_audio_format",
        "output_audio_format",
        "input_audio_configuration_except_format",
        "output_audio_configuration_except_format",
        "turn_detection_type",
        "turn_detection_parameters",
        "resumption_disabled",
      ],
      sessionIdentity: {
        source: "session.created",
        updatedContinuity: "unverifiable_session_updated_omitted_identity",
      },
      conversationIdentity: {
        source: "conversation.created",
        status: "not_observed_before_readiness",
      },
      modelIdentity: {
        source: "provider_echo",
        status: "unverifiable_provider_omitted",
      },
    });
    expect(() => verifyXaiBrowserSessionAcknowledgement({
      type: "session.updated",
      session: { model: "grok-voice-other" },
    }, sent, "s-1", { expectedModel: "grok-voice-think-fast-1.0" })).toThrow("mismatch: model");
    expect(() => verifyXaiBrowserSessionAcknowledgement({
      type: "session.updated",
      session: { instructions: "Ignore the durable flow." },
    }, sent, "s-1")).toThrow("mismatch: instructions");
    expect(() => verifyXaiBrowserSessionAcknowledgement({
      type: "session.updated",
      session: { turn_detection: { type: "manual" } },
    }, sent, "s-1")).toThrow("mismatch: turn_detection.type");
    expect(() => verifyXaiBrowserSessionAcknowledgement({
      type: "session.updated",
      session: { tools: [] },
    }, sent, "s-1")).toThrow("mismatch: tools");
    expect(() => verifyXaiBrowserSessionAcknowledgement({
      type: "session.updated",
      session: {
        audio: { input: { transcription: { model: "untrusted-transcriber" } } },
      },
    }, sent, "s-1")).toThrow("mismatch: audio.input.transcription.model");
    expect(() => verifyXaiBrowserSessionAcknowledgement(
      { type: "session.updated" },
      sent,
      "s-1",
    )).toThrow("omitted a session object");
  });

  it.each([
    ["audio null", { audio: null }, "audio"],
    ["audio array", { audio: [] }, "audio"],
    ["audio scalar", { audio: "pcm" }, "audio"],
    ["audio.input null", { audio: { input: null } }, "audio.input"],
    ["audio.input array", { audio: { input: [] } }, "audio.input"],
    ["audio.input scalar", { audio: { input: 24_000 } }, "audio.input"],
    ["audio.output null", { audio: { output: null } }, "audio.output"],
    ["audio.output array", { audio: { output: [] } }, "audio.output"],
    ["audio.output scalar", { audio: { output: false } }, "audio.output"],
    ["turn_detection null", { turn_detection: null }, "turn_detection"],
    ["turn_detection array", { turn_detection: [] }, "turn_detection"],
    ["turn_detection scalar", { turn_detection: "server_vad" }, "turn_detection"],
    ["resumption null", { resumption: null }, "resumption"],
    ["resumption array", { resumption: [] }, "resumption"],
    ["resumption scalar", { resumption: false }, "resumption"],
  ])("rejects a present malformed acknowledged %s container", (_label, session, mismatch) => {
    const sent = buildXaiBrowserSessionUpdate(sessionUpdate());
    expect(() => verifyXaiBrowserSessionAcknowledgement(
      { type: "session.updated", session },
      sent,
      "s-1",
    )).toThrow(`mismatch: ${mismatch}`);
  });

  it("does not enable microphone delivery until session.updated passes verification", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("btoa", (value: string) => Buffer.from(value, "binary").toString("base64"));
    const test = harness();
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await settle();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    expect(socket.sent).toEqual([]);
    expect(test.processor.onaudioprocess).toBeNull();
    socket.receive({
      type: "session.created",
      session: { id: "s-1", model: "grok-voice-think-fast-1.0" },
    });
    expect(JSON.parse(socket.sent[0])).toMatchObject({ session: { resumption: { enabled: false } } });
    expect(test.processor.onaudioprocess).toBeNull();

    socket.receive(acknowledged());
    await started;
    expect(test.processor.onaudioprocess).toBeTypeOf("function");
    expect(transport.sessionReadinessEvidence?.strictParityVerified).toBe(false);
    test.processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => Float32Array.from([0, 0.5, -0.5, 0]) },
    } as unknown as AudioProcessingEvent);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "input_audio_buffer.append",
      audio: expect.any(String),
    });
    await transport.stop();
    expect(test.handlers.onClose).not.toHaveBeenCalled();
  });

  it("accepts documented conversation.created ordering before session.updated and binds its identity", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const test = harness();
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await settle();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "conversation.created", conversation: { id: "c-1" } });
    expect(socket.sent).toEqual([]);
    socket.receive({
      type: "session.created",
      session: { id: "s-1", model: "grok-voice-think-fast-1.0" },
    });
    expect(socket.sent).toHaveLength(1);
    socket.receive({ type: "session.updated", session: {} });
    await started;

    expect(transport.sessionReadinessEvidence).toMatchObject({
      verifiedFields: ["model"],
      sessionIdentity: {
        source: "session.created",
        updatedContinuity: "unverifiable_session_updated_omitted_identity",
      },
      conversationIdentity: {
        source: "conversation.created",
        status: "verified",
      },
      modelIdentity: {
        source: "session.created",
        status: "verified",
      },
    });
    expect(test.processor.onaudioprocess).toBeTypeOf("function");
    await transport.stop();
  });

  it("rejects a conflicting session.created model before an empty acknowledgement can authorize audio", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const test = harness();
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await settle();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({
      type: "session.created",
      session: { id: "s-1", model: "grok-voice-other" },
    });

    await expect(started).rejects.toThrow("session.created model differs from the requested model");
    expect(socket.sent).toEqual([]);
    expect(test.processor.onaudioprocess).toBeNull();
    expect(socket.closeCode).toBe(1002);
  });

  it("accepts bounded ping control metadata while still withholding audio before readiness", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const test = harness();
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await settle();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "ping", event_id: "ping-1" });
    expect(socket.sent).toEqual([]);
    expect(test.processor.onaudioprocess).toBeNull();
    socket.receive({
      type: "session.created",
      session: { id: "s-1", model: "grok-voice-think-fast-1.0" },
    });
    socket.receive({ type: "session.updated", session: {} });
    await started;
    expect(test.processor.onaudioprocess).toBeTypeOf("function");
    await transport.stop();
  });

  it("rejects malformed or duplicate conversation identities before enabling the mic", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const malformed = harness();
    const malformedTransport = new XaiWebSocketTransport();
    const malformedStarted = malformedTransport.start(malformed.args);
    await settle();
    const malformedSocket = FakeWebSocket.instances[0];
    malformedSocket.open();
    malformedSocket.receive({ type: "conversation.created", conversation: { id: " not-canonical " } });
    await expect(malformedStarted).rejects.toThrow("conversation.created omitted a valid conversation identity");
    expect(malformed.processor.onaudioprocess).toBeNull();
    expect(malformedSocket.closeCode).toBe(1002);

    const duplicate = harness();
    const duplicateTransport = new XaiWebSocketTransport();
    const duplicateStarted = duplicateTransport.start(duplicate.args);
    await settle();
    const duplicateSocket = FakeWebSocket.instances[1];
    duplicateSocket.open();
    duplicateSocket.receive({ type: "conversation.created", conversation: { id: "c-1" } });
    duplicateSocket.receive({ type: "conversation.created", conversation: { id: "c-2" } });
    await expect(duplicateStarted).rejects.toThrow("duplicate conversation.created");
    expect(duplicate.processor.onaudioprocess).toBeNull();
    expect(duplicateSocket.closeCode).toBe(1002);
  });

  it("fails closed on a mismatched acknowledgement without ever enabling the mic", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const test = harness();
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await settle();
    const socket = FakeWebSocket.instances[0];
    initializeXaiSession(socket);
    socket.receive(acknowledged({ voice: "wrong" }));

    await expect(started).rejects.toThrow("acknowledgement mismatch: voice");
    expect(test.processor.onaudioprocess).toBeNull();
    expect(socket.closeCode).toBe(1002);
    expect(transport.sessionReadinessEvidence).toBeNull();
  });

  it("does not send configuration when session.created omits its identity", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const test = harness();
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await settle();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "session.created", session: {} });

    await expect(started).rejects.toThrow("session.created omitted a valid session identity");
    expect(socket.sent).toEqual([]);
    expect(socket.closeCode).toBe(1002);
  });

  it("rejects session.updated before creation and duplicate session.created", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const early = harness();
    const earlyTransport = new XaiWebSocketTransport();
    const earlyStarted = earlyTransport.start(early.args);
    await settle();
    const earlySocket = FakeWebSocket.instances[0];
    earlySocket.open();
    earlySocket.receive(acknowledged());
    await expect(earlyStarted).rejects.toThrow("before session.created initialized the session");
    expect(earlySocket.sent).toEqual([]);

    const duplicate = harness();
    const duplicateTransport = new XaiWebSocketTransport();
    const duplicateStarted = duplicateTransport.start(duplicate.args);
    await settle();
    const duplicateSocket = FakeWebSocket.instances[1];
    initializeXaiSession(duplicateSocket, "s-original");
    duplicateSocket.receive({ type: "session.created", session: { id: "s-replacement" } });
    await expect(duplicateStarted).rejects.toThrow("duplicate session.created");
    expect(duplicateSocket.closeCode).toBe(1002);
  });

  it("rejects provider output before acknowledgement and bounds post-ready messages", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const early = harness();
    const earlyTransport = new XaiWebSocketTransport();
    const earlyStart = earlyTransport.start(early.args);
    await settle();
    const earlySocket = FakeWebSocket.instances[0];
    initializeXaiSession(earlySocket, "s-early");
    earlySocket.receive({ type: "response.audio.delta", delta: "AQAA" });
    await expect(earlyStart).rejects.toThrow("before session.updated verification");

    const ready = harness();
    const readyTransport = new XaiWebSocketTransport();
    const readyStart = readyTransport.start(ready.args);
    await settle();
    const readySocket = FakeWebSocket.instances[1];
    initializeXaiSession(readySocket, "s-ready");
    readySocket.receive(acknowledged());
    await readyStart;
    readySocket.receive("{");
    expect(ready.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("malformed JSON") }));
    expect(readySocket.closeCode).toBe(1002);
  });

  it("never surfaces provider-controlled error text", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const test = harness();
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await settle();
    const socket = FakeWebSocket.instances[0];
    initializeXaiSession(socket);
    socket.receive(acknowledged());
    await started;

    socket.receive({
      type: "error",
      error: {
        message: "Authorization: Bearer xai-live-secret; caller alice@example.test",
      },
    });

    expect(test.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "xAI realtime provider error",
    }));
    expect(JSON.stringify(test.handlers.onError.mock.calls)).not.toContain("xai-live-secret");
    expect(JSON.stringify(test.handlers.onError.mock.calls)).not.toContain("alice@example.test");
  });

  it("quarantines xAI PCM until the terminal response passes the configured gate", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const test = harness();
    const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    const createBuffer = vi.fn((_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: vi.fn(),
    }));
    Object.assign(test.audioContext, {
      createBuffer,
      createBufferSource: vi.fn(() => source),
    });
    const onEvidence = vi.fn();
    test.args.outboundSpeechGate = {
      gate: new OutboundSpeechGate({
        policy: createOutboundSpeechGatePolicy({ evidencePolicy: "provider_transcript_allowed" }),
      }),
      onEvidence,
    };
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await settle();
    const socket = FakeWebSocket.instances[0];
    initializeXaiSession(socket);
    socket.receive(acknowledged());
    await started;

    socket.receive({ type: "response.created", response: { id: "speech-1" } });
    socket.receive({
      type: "response.audio.delta",
      response_id: "speech-1",
      delta: Buffer.from([1, 0, 2, 0]).toString("base64"),
    });
    expect(createBuffer).not.toHaveBeenCalled();
    socket.receive({
      type: "response.audio_transcript.done",
      response_id: "speech-1",
      transcript: "The safe answer",
    });
    expect(test.handlers.onTranscript).not.toHaveBeenCalled();
    socket.receive({
      type: "response.done",
      response: { id: "speech-1", status: "completed", output: [] },
    });

    await vi.waitFor(() => expect(onEvidence).toHaveBeenCalledTimes(1));
    expect(createBuffer).toHaveBeenCalledTimes(1);
    expect(onEvidence.mock.calls[0][0]).toMatchObject({
      provider: "xai",
      responseId: "speech-1",
      decision: { action: "release", evidenceCoverage: "provider_transcript_unbound" },
      playout: { status: "released_to_audio_context", audioBytes: 4 },
    });
    expect(test.handlers.onTranscript).toHaveBeenCalledWith("agent", "The safe answer");
    await transport.stop();
  });

  it("rejects start promptly when stopped while waiting for session acknowledgement", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const test = harness();
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await transport.stop();
    await expect(started).rejects.toThrow("stopped during startup");
    expect(socket.closeCode).toBe(1000);
    expect(test.processor.onaudioprocess).toBeNull();
    expect(test.handlers.onError).not.toHaveBeenCalled();
    expect(test.handlers.onClose).not.toHaveBeenCalled();
  });

  it("dispatches only terminal capability_gateway calls with host-owned native provenance", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const test = harness();
    const transport = new XaiWebSocketTransport();
    const started = transport.start(test.args);
    await settle();
    const socket = FakeWebSocket.instances[0];
    initializeXaiSession(socket);
    socket.receive(acknowledged());
    await started;
    socket.sent.length = 0;

    socket.receive({
      type: "response.function_call_arguments.done",
      event_id: "evt-args",
      response_id: "response-1",
      item_id: "item-1",
      call_id: "call-1",
      name: "capability_gateway",
      arguments: JSON.stringify({
        tool_name: "get_flow_state",
        arguments: { _meta: { provider_call_id: "model-forged" } },
      }),
    });
    await settle();
    expect(test.gatewayRequests.filter((request) => request.method === "tools/call")).toHaveLength(0);
    socket.receive({
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
            tool_name: "get_flow_state",
            arguments: { _meta: { provider_call_id: "model-forged" } },
          }),
        }],
      },
    });
    await vi.waitFor(() => {
      expect(test.gatewayRequests.filter((request) => request.method === "tools/call")).toHaveLength(1);
    });
    const toolRequest = test.gatewayRequests.find((request) => request.method === "tools/call")!;
    const params = toolRequest.params as Record<string, unknown>;
    expect(params.arguments).toEqual({ _meta: { provider_call_id: "model-forged" } });
    expect(params._meta).toMatchObject({
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
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify(gatewayEnvelope({ called: "call-1" })),
        },
      },
      { type: "response.create" },
    ]);
  });
});
