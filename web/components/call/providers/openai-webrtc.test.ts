import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIWebRtcTransport } from "./openai-webrtc";
import type { RealtimeTransportStart } from "./types";

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

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  readonly sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = "closed";
    this.onclose?.();
  });
  send(value: string) {
    if (this.readyState !== "open") throw new Error("data channel closed");
    this.sent.push(value);
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  receive(value: unknown) {
    this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) });
  }
  fail() {
    this.onerror?.();
  }
}

class FakePeer {
  static readonly instances: FakePeer[] = [];
  connectionState: RTCPeerConnectionState = "new";
  ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  readonly setLocalDescription = vi.fn(async () => {});
  readonly setRemoteDescription = vi.fn(async () => {});
  readonly close = vi.fn(() => { this.connectionState = "closed"; });
  readonly createOffer = vi.fn(async () => ({ type: "offer", sdp: "v=0\r\no=test-offer" }));
  readonly createDataChannel = vi.fn(() => this.channel);
  constructor() { FakePeer.instances.push(this); }
}

function harness(recording = false) {
  const remoteSource = { connect: vi.fn(), disconnect: vi.fn() };
  const audioContext = {
    destination: { kind: "speakers" },
    createMediaStreamSource: vi.fn(() => remoteSource),
  } as unknown as AudioContext;
  const track = { kind: "audio" } as MediaStreamTrack;
  const mic = { getTracks: () => [track] } as unknown as MediaStream;
  const handlers = { onTranscript: vi.fn(), onError: vi.fn(), onClose: vi.fn() };
  const recordingDestination = recording
    ? ({ kind: "recording" } as unknown as MediaStreamAudioDestinationNode)
    : undefined;
  const args: RealtimeTransportStart = {
    connection: {
      provider: "openai",
      transport: "webrtc",
      model: "gpt-realtime-2.1",
      voice: "marin",
      endpoint: "https://api.openai.com/v1/realtime/calls",
      token: "ephemeral-token",
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
    mic,
    audioContext,
    recordingDestination,
    handlers,
  };
  return { args, handlers, audioContext, remoteSource, recordingDestination, track };
}

function installFetch(sdp: () => Promise<Response>) {
  const gatewayRequests: Record<string, unknown>[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input) !== "https://voice.example.test/api/mcp") return sdp();
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    gatewayRequests.push(body);
    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {} },
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
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, gatewayRequests };
}

async function settle() {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakePeer.instances.length = 0;
});

describe("OpenAI browser WebRTC transport", () => {
  it("fails closed before network or WebRTC side effects when PCM quarantine is requested", async () => {
    const network = installFetch(async () => new Response("v=0\r\no=answer"));
    const test = harness();
    test.args.outboundSpeechGate = {
      gate: {} as NonNullable<RealtimeTransportStart["outboundSpeechGate"]>["gate"],
      onEvidence: vi.fn(),
    };
    const transport = new OpenAIWebRtcTransport();

    await expect(transport.start(test.args)).rejects.toThrow("remote audio bypasses PCM quarantine");
    expect(network.fetchMock).not.toHaveBeenCalled();
    expect(FakePeer.instances).toHaveLength(0);
    expect(transport.outboundSpeechGateSupport.supported).toBe(false);
  });

  it("bounds SDP, waits for the data channel, and validates transcript events", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const network = installFetch(async () => new Response("v=0\r\no=test-answer", {
      status: 200,
      headers: { "Content-Type": "application/sdp" },
    }));
    const test = harness();
    const transport = new OpenAIWebRtcTransport();
    const started = transport.start(test.args);
    await settle();
    const peer = FakePeer.instances[0];
    expect(peer.addTrack).toHaveBeenCalledWith(test.track, test.args.mic);
    let resolved = false;
    void started.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    peer.channel.open();
    await started;

    peer.channel.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "hello",
    });
    peer.channel.receive({
      type: "response.output_audio_transcript.done",
      transcript: "welcome",
    });
    expect(test.handlers.onTranscript.mock.calls).toEqual([
      ["caller", "hello"],
      ["agent", "welcome"],
    ]);
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0\r\no=test-answer" });
    if (test.args.connection.provider !== "openai") throw new Error("OpenAI harness returned the wrong provider");
    const endpoint = test.args.connection.endpoint;
    const negotiation = network.fetchMock.mock.calls.find(([input]) => String(input) === endpoint);
    expect(negotiation?.[1]).toMatchObject({
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(negotiation?.[1]?.headers).get("authorization")).toBe("Bearer ephemeral-token");
  });

  it("routes remote audio to recording only when a destination was explicitly supplied", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    installFetch(async () => new Response("v=0\r\no=answer"));
    const without = harness(false);
    const transport = new OpenAIWebRtcTransport();
    const started = transport.start(without.args);
    await settle();
    const peer = FakePeer.instances[0];
    peer.channel.open();
    await started;
    peer.ontrack?.({ track: without.track, streams: [{} as MediaStream] });
    expect(without.remoteSource.connect).toHaveBeenCalledTimes(1);
    expect(without.remoteSource.connect).toHaveBeenCalledWith(without.audioContext.destination);

    await transport.stop();
    const withRecording = harness(true);
    const second = new OpenAIWebRtcTransport();
    const secondStart = second.start(withRecording.args);
    await settle();
    const secondPeer = FakePeer.instances[1];
    secondPeer.channel.open();
    await secondStart;
    secondPeer.ontrack?.({ track: withRecording.track, streams: [{} as MediaStream] });
    expect(withRecording.remoteSource.connect).toHaveBeenCalledWith(withRecording.recordingDestination);
  });

  it("fails closed on malformed post-readiness provider events", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    installFetch(async () => new Response("v=0\r\no=answer"));
    const test = harness();
    const transport = new OpenAIWebRtcTransport();
    const started = transport.start(test.args);
    await settle();
    const channel = FakePeer.instances[0].channel;
    channel.open();
    await started;
    channel.receive("{");
    expect(test.handlers.onTranscript).not.toHaveBeenCalled();
    expect(test.handlers.onError).toHaveBeenCalledTimes(1);
    expect(channel.close).toHaveBeenCalled();
    expect(FakePeer.instances[0].close).toHaveBeenCalled();
  });

  it("never surfaces provider-controlled error text", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    installFetch(async () => new Response("v=0\r\no=answer"));
    const test = harness();
    const transport = new OpenAIWebRtcTransport();
    const started = transport.start(test.args);
    await settle();
    const channel = FakePeer.instances[0].channel;
    channel.open();
    await started;

    channel.receive({
      type: "error",
      error: {
        message: "Authorization: Bearer sk-live-secret; caller alice@example.test",
      },
    });

    expect(test.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "OpenAI realtime provider error",
    }));
    expect(JSON.stringify(test.handlers.onError.mock.calls)).not.toContain("sk-live-secret");
    expect(JSON.stringify(test.handlers.onError.mock.calls)).not.toContain("alice@example.test");
  });

  it("fails closed on oversized or invalid SDP answers", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    installFetch(async () => new Response("not-sdp"));
    const test = harness();
    const transport = new OpenAIWebRtcTransport();
    await expect(transport.start(test.args)).rejects.toThrow("invalid SDP answer");
    expect(FakePeer.instances[0].close).toHaveBeenCalled();
  });

  it("rejects redirected SDP responses and never follows bearer redirects", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const redirected = new Response("v=0\r\no=answer");
    Object.defineProperty(redirected, "redirected", { value: true });
    installFetch(async () => redirected);
    const transport = new OpenAIWebRtcTransport();
    await expect(transport.start(harness().args)).rejects.toThrow("redirects are forbidden");
    expect(FakePeer.instances[0].close).toHaveBeenCalled();
  });

  it("rejects start promptly when stopped during gateway or data-channel readiness", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("location", { origin: "https://voice.example.test" });
    const blockedGatewayFetch = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", blockedGatewayFetch);
    const duringGateway = new OpenAIWebRtcTransport();
    const gatewayStart = duringGateway.start(harness().args);
    await vi.waitFor(() => expect(blockedGatewayFetch).toHaveBeenCalledTimes(1));
    await duringGateway.stop();
    await expect(gatewayStart).rejects.toThrow("stopped during startup");
    expect(FakePeer.instances).toHaveLength(0);

    installFetch(async () => new Response("v=0\r\no=answer"));
    const duringChannel = new OpenAIWebRtcTransport();
    const channelStart = duringChannel.start(harness().args);
    await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1));
    await vi.waitFor(() => expect(FakePeer.instances[0].setRemoteDescription).toHaveBeenCalled());
    await duringChannel.stop();
    await expect(channelStart).rejects.toThrow("stopped during startup");
    expect(FakePeer.instances[0].channel.close).toHaveBeenCalled();
    expect(FakePeer.instances[0].close).toHaveBeenCalled();
  });

  it("reports post-readiness data-channel failures and seals intentional shutdown", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    installFetch(async () => new Response("v=0\r\no=answer"));
    const test = harness();
    const transport = new OpenAIWebRtcTransport();
    const started = transport.start(test.args);
    await settle();
    const peer = FakePeer.instances[0];
    peer.channel.open();
    await started;

    peer.channel.fail();
    expect(test.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "OpenAI realtime data channel failed",
    }));
    peer.channel.close();
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange?.();
    expect(test.handlers.onClose).toHaveBeenCalledTimes(1);

    const local = harness();
    const localTransport = new OpenAIWebRtcTransport();
    const localStarted = localTransport.start(local.args);
    await settle();
    FakePeer.instances[1].channel.open();
    await localStarted;
    await localTransport.stop();
    expect(local.handlers.onClose).not.toHaveBeenCalled();
  });

  it("dispatches terminal capability_gateway calls through the local MCP authority", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const network = installFetch(async () => new Response("v=0\r\no=answer"));
    const test = harness();
    const transport = new OpenAIWebRtcTransport();
    const started = transport.start(test.args);
    await settle();
    const channel = FakePeer.instances[0].channel;
    channel.open();
    await started;
    channel.sent.length = 0;

    channel.receive({
      type: "response.function_call_arguments.done",
      event_id: "evt-arguments",
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
    expect(network.gatewayRequests.filter((request) => request.method === "tools/call")).toHaveLength(0);
    channel.receive({
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
      expect(network.gatewayRequests.filter((request) => request.method === "tools/call")).toHaveLength(1);
    });
    const request = network.gatewayRequests.find((candidate) => candidate.method === "tools/call")!;
    expect(request.params).toMatchObject({
      name: "get_flow_state",
      arguments: { _meta: { provider_call_id: "model-forged" } },
      _meta: {
        "hacc/provider_tool_call_id": "call-1",
        "com.harsha.callcenter/provider-provenance": {
          provider: "openai",
          nativeCallId: "call-1",
          nativeResponseId: "response-1",
          nativeItemId: "item-1",
          terminalEventId: "evt-terminal",
          terminalWireType: "response.done",
        },
      },
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    expect(channel.sent.map((frame) => JSON.parse(frame))).toEqual([
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

    channel.bufferedAmount = Number.NaN;
    const secondArguments = JSON.stringify({ tool_name: "get_flow_state", arguments: {} });
    channel.receive({
      type: "response.function_call_arguments.done",
      response_id: "response-2",
      item_id: "item-2",
      call_id: "call-2",
      name: "capability_gateway",
      arguments: secondArguments,
    });
    channel.receive({
      type: "response.done",
      event_id: "evt-terminal-2",
      response: {
        id: "response-2",
        status: "completed",
        output: [{
          type: "function_call",
          id: "item-2",
          call_id: "call-2",
          name: "capability_gateway",
          arguments: secondArguments,
        }],
      },
    });
    await vi.waitFor(() => expect(test.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("invalid buffer size"),
    })));
    expect(channel.close).toHaveBeenCalled();
    expect(FakePeer.instances[0].close).toHaveBeenCalled();
  });
});
