import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  transport: {
    start: vi.fn(),
    drainToolCalls: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock("./providers", () => ({
  createBrowserRealtimeTransport: mocks.createTransport,
}));
vi.mock("@/lib/recording-privacy", async () => import("../../lib/recording-privacy"));

import { RealtimeCall } from "./realtime";
import type { RealtimeTransportStart } from "./providers/types";

const CALL_ID = "00000000-0000-4000-8000-000000000021";
const CONSENT_ID = "00000000-0000-4000-8000-000000000022";
const RECORDING_UPLOAD_TOKEN = `rec_${"u".repeat(43)}`;

const toolProxyRotation = {
  endpoint: "/api/voice/capabilities/rotate" as const,
  callId: CALL_ID,
  rotation: 0,
  renewalToken: "renewal-capability-token",
  refreshAfter: "2026-07-16T20:25:00.000Z",
  expiresAt: "2026-07-16T20:30:00.000Z",
};

const connection = {
  provider: "openai" as const,
  transport: "webrtc" as const,
  model: "gpt-realtime",
  voice: "marin",
  endpoint: "https://api.openai.example/v1/realtime/calls",
  token: "ephemeral-token",
  toolProxyUrl: "/api/mcp",
  toolProxyToken: "mcp-capability-token",
  toolProxyRotation,
  activeCatalogAuthority: {
    catalogDigest: "a".repeat(64),
    capabilityEpoch: 0,
    runtimeDigest: "b".repeat(64),
    stateRevision: 0,
  },
};

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly destination = {} as AudioDestinationNode;
  readonly recordingDestination = { stream: {} } as MediaStreamAudioDestinationNode;
  readonly recordingSource = { connect: vi.fn(), disconnect: vi.fn() };
  readonly resume = vi.fn(async () => {});
  readonly close = vi.fn(async () => {});
  readonly createMediaStreamDestination = vi.fn(() => this.recordingDestination);
  readonly createMediaStreamSource = vi.fn(() => this.recordingSource);

  constructor(readonly options?: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }
}

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);
  state: RecordingState = "inactive";
  readonly mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;

  constructor(readonly stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    if (this.state === "inactive") throw new DOMException("inactive", "InvalidStateError");
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }

  emit(blob: Blob) {
    this.ondataavailable?.({ data: blob } as BlobEvent);
  }
}

function freshConsent() {
  return {
    granted: true as const,
    consentId: CONSENT_ID,
    grantedAt: new Date(Date.now()).toISOString(),
    noticeVersion: "recording-v1",
    retentionDays: 7,
  };
}

function successfulFetch(providerConnection: typeof connection | Record<string, unknown> = connection) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/voice/token") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { recordingConsent?: unknown };
      return Response.json({
        callId: CALL_ID,
        connection: providerConnection,
        ...(body.recordingConsent ? { recordingUploadToken: RECORDING_UPLOAD_TOKEN } : {}),
      });
    }
    return Response.json({ ok: true });
  });
}

describe("browser realtime call privacy and lifecycle", () => {
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
  const mic = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => mic);

  beforeEach(() => {
    vi.clearAllMocks();
    FakeAudioContext.instances.length = 0;
    FakeMediaRecorder.instances.length = 0;
    mocks.createTransport.mockReturnValue(mocks.transport);
    mocks.transport.start.mockResolvedValue(undefined);
    mocks.transport.drainToolCalls.mockResolvedValue({
      settledNativeCallIds: [],
      unresolvedNativeCallIds: [],
    });
    mocks.transport.stop.mockResolvedValue(undefined);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not create, capture, or upload a recording without explicit consent", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const handlers = { onTranscript: vi.fn(), onState: vi.fn() };
    const call = new RealtimeCall(handlers);

    await call.start("agent-id");
    const start = mocks.transport.start.mock.calls[0][0] as RealtimeTransportStart;
    expect(start.recordingDestination).toBeUndefined();
    expect(FakeAudioContext.instances[0].createMediaStreamDestination).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    await call.stop();

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/recording"))).toBe(false);
    expect(handlers.onState.mock.calls.map(([state]) => state)).toEqual(["connecting", "live", "ended"]);
  });

  it("binds opted-in capture and upload to the exact consent receipt", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const consent = freshConsent();
    const call = new RealtimeCall({ onTranscript: vi.fn(), onState: vi.fn() });

    await call.start("agent-id", { recordingConsent: consent });
    const tokenRequest = fetchMock.mock.calls.find(([input]) => String(input) === "/api/voice/token")![1]!;
    expect(JSON.parse(String(tokenRequest.body))).toMatchObject({ recordingConsent: consent });
    const start = mocks.transport.start.mock.calls[0][0] as RealtimeTransportStart;
    expect(start.recordingDestination).toBe(FakeAudioContext.instances[0].recordingDestination);
    expect(FakeAudioContext.instances[0].recordingSource.connect).toHaveBeenCalledWith(start.recordingDestination);

    FakeMediaRecorder.instances[0].emit(new Blob(["x".repeat(5_000)], { type: "audio/webm" }));
    await call.stop();
    const upload = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/recording"));
    expect(upload).toBeDefined();
    expect(new Headers(upload![1]?.headers).get("x-recording-consent-id")).toBe(CONSENT_ID);
    expect(new Headers(upload![1]?.headers).get("x-recording-upload-token")).toBe(RECORDING_UPLOAD_TOKEN);
    expect(upload![1]?.body).toBeInstanceOf(Blob);
  });

  it("fails closed before media capture when opted-in minting omits upload authority", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ callId: CALL_ID, connection }));
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall({ onTranscript: vi.fn(), onState: vi.fn() });

    await expect(call.start("agent-id", { recordingConsent: freshConsent() }))
      .rejects.toThrow("omitted its recording upload capability");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/end"))).toBe(true);
  });

  it("fails closed before media capture when a no-consent session receives upload authority", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      callId: CALL_ID,
      connection,
      recordingUploadToken: RECORDING_UPLOAD_TOKEN,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall({ onTranscript: vi.fn(), onState: vi.fn() });

    await expect(call.start("agent-id")).rejects.toThrow("unexpected recording upload capability");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/end"))).toBe(true);
  });

  it("rejects stale consent before token minting or media capture", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall({ onTranscript: vi.fn(), onState: vi.fn() });

    await expect(call.start("agent-id", {
      recordingConsent: {
        ...freshConsent(),
        grantedAt: "2000-01-01T00:00:00.000Z",
      },
    })).rejects.toThrow("invalid or stale");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("drains every bounded audit batch at shutdown and emits exact loss accounting", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall({ onTranscript: vi.fn(), onState: vi.fn() });
    await call.start("agent-id");
    const transportHandlers = (mocks.transport.start.mock.calls[0][0] as RealtimeTransportStart).handlers;
    for (let index = 0; index < 600; index += 1) {
      transportHandlers.onTranscript("agent", `turn-${index}`);
    }
    await call.stop();

    const persisted = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith("/events"))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as {
        events: { type: string; payload: Record<string, unknown> }[];
      }).events);
    expect(persisted).toHaveLength(501);
    expect(persisted[0]).toEqual({ type: "client_event_overflow", payload: { dropped: 101 } });
    expect(persisted.filter((event) => event.type === "client_event_overflow")).toHaveLength(1);
    expect(persisted.at(-1)).toEqual({ type: "agent_said", payload: { text: "turn-599" } });
  });

  it("closes the server call and local media when transport startup fails", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    mocks.transport.start.mockRejectedValueOnce(new Error("provider setup mismatch"));
    const call = new RealtimeCall({ onTranscript: vi.fn(), onState: vi.fn() });

    await expect(call.start("agent-id")).rejects.toThrow("provider setup mismatch");
    expect(track.stop).toHaveBeenCalled();
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/end"))).toBe(true);
  });

  it("turns a remote provider close into one complete, idempotent shutdown", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const handlers = { onTranscript: vi.fn(), onState: vi.fn() };
    const call = new RealtimeCall(handlers);
    await call.start("agent-id");

    const transportHandlers = (mocks.transport.start.mock.calls[0][0] as RealtimeTransportStart).handlers;
    transportHandlers.onClose();
    transportHandlers.onClose();
    await call.stop();

    expect(mocks.transport.stop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/end"))).toHaveLength(1);
    expect(handlers.onState.mock.calls.map(([state]) => state)).toEqual(["connecting", "live", "ended"]);
    const persistedEvents = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith("/events"))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as {
        events: { type: string; payload: Record<string, unknown> }[];
      }).events);
    expect(persistedEvents).toContainEqual({
      type: "state",
      payload: { state: "provider_closed", provider: "openai" },
    });
  });

  it("reconciles a committed native receipt before provider-close terminalization", async () => {
    const order: string[] = [];
    mocks.transport.drainToolCalls.mockImplementationOnce(async () => {
      order.push("drain");
      return {
        settledNativeCallIds: ["provider-call-committed"],
        unresolvedNativeCallIds: [],
      };
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/voice/token") return Response.json({ callId: CALL_ID, connection });
      if (url.endsWith("/events")) {
        const body = JSON.parse(String(init?.body)) as {
          events: { type: string; payload: Record<string, unknown> }[];
        };
        if (body.events.some((event) =>
          event.type === "tool_gateway_shutdown_reconciliation"
          && event.payload.nativeCallId === "provider-call-committed"
        )) order.push("receipt-persisted");
      }
      if (url.endsWith("/end")) order.push("terminalized");
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall({ onTranscript: vi.fn(), onState: vi.fn() });
    await call.start("agent-id");

    const transportHandlers = (mocks.transport.start.mock.calls[0][0] as RealtimeTransportStart).handlers;
    transportHandlers.onClose();
    await call.stop();

    expect(mocks.transport.drainToolCalls).toHaveBeenCalledWith(1_500);
    expect(order).toEqual(["drain", "receipt-persisted", "terminalized"]);
  });

  it("persists an exact unresolved native identity before terminalizing without redispatch", async () => {
    const order: string[] = [];
    mocks.transport.drainToolCalls.mockResolvedValueOnce({
      settledNativeCallIds: [],
      unresolvedNativeCallIds: ["provider-call-uncertain"],
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/voice/token") return Response.json({ callId: CALL_ID, connection });
      if (url.endsWith("/events")) {
        const body = JSON.parse(String(init?.body)) as {
          events: { type: string; payload: Record<string, unknown> }[];
        };
        const unresolved = body.events.find((event) =>
          event.type === "tool_gateway_shutdown_reconciliation"
          && event.payload.nativeCallId === "provider-call-uncertain"
        );
        if (unresolved) {
          expect(unresolved.payload).toMatchObject({
            status: "unresolved",
            exactReceiptRecovered: false,
            doNotRedispatch: true,
          });
          order.push("unresolved-persisted");
        }
      }
      if (url.endsWith("/end")) order.push("terminalized");
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall({ onTranscript: vi.fn(), onState: vi.fn() });
    await call.start("agent-id");

    const transportHandlers = (mocks.transport.start.mock.calls[0][0] as RealtimeTransportStart).handlers;
    transportHandlers.onClose();
    await call.stop();

    expect(order).toEqual(["unresolved-persisted", "terminalized"]);
    expect(mocks.transport.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the server call nonterminal when shutdown identity reconciliation is unknown", async () => {
    mocks.transport.drainToolCalls.mockRejectedValueOnce(new Error("drain unavailable"));
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall({ onTranscript: vi.fn(), onState: vi.fn() });
    await call.start("agent-id");

    const transportHandlers = (mocks.transport.start.mock.calls[0][0] as RealtimeTransportStart).handlers;
    transportHandlers.onClose();
    await call.stop();

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/end"))).toBe(false);
    const persisted = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith("/events"))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as {
        events: { type: string; payload: Record<string, unknown> }[];
      }).events);
    expect(persisted).toContainEqual({
      type: "tool_gateway_shutdown_reconciliation",
      payload: { status: "unresolved", reason: "drain_failed", doNotRedispatch: true },
    });
  });

  it("persists stable provider error metadata without raw error text", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const handlers = { onTranscript: vi.fn(), onState: vi.fn() };
    const call = new RealtimeCall(handlers);
    await call.start("agent-id");
    const transportHandlers = (mocks.transport.start.mock.calls[0][0] as RealtimeTransportStart).handlers;

    transportHandlers.onError(new Error(
      "Authorization: Bearer provider-live-secret; caller alice@example.test",
    ));
    await call.stop();

    const serializedRequests = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith("/events"))
      .map(([, init]) => String(init?.body));
    expect(serializedRequests.join("")).not.toContain("provider-live-secret");
    expect(serializedRequests.join("")).not.toContain("alice@example.test");
    const persistedEvents = serializedRequests.flatMap((body) => (JSON.parse(body) as {
      events: { type: string; payload: Record<string, unknown> }[];
    }).events);
    expect(persistedEvents).toContainEqual({
      type: "error",
      payload: { code: "provider_runtime_error", provider: "openai" },
    });
    expect(handlers.onState).toHaveBeenCalledWith("error");
  });

  it("cannot resurrect after stop wins a deferred transport-start boundary", async () => {
    let releaseTransportStart!: () => void;
    const transportStartGate = new Promise<void>((resolve) => { releaseTransportStart = resolve; });
    mocks.transport.start.mockReturnValueOnce(transportStartGate);
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const handlers = { onTranscript: vi.fn(), onState: vi.fn() };
    const call = new RealtimeCall(handlers);

    const starting = call.start("agent-id");
    await vi.waitFor(() => expect(mocks.transport.start).toHaveBeenCalledTimes(1));
    await call.stop();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledTimes(1);

    releaseTransportStart();
    await expect(starting).rejects.toThrow("start was cancelled");
    expect(handlers.onState.mock.calls.map(([state]) => state)).toEqual(["connecting", "ended"]);
    expect(handlers.onState).not.toHaveBeenCalledWith("live");
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/end"))).toHaveLength(1);
    expect(mocks.transport.stop).toHaveBeenCalled();
  });

  it("tears down locally and terminates within budget when every shutdown fetch hangs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "/api/voice/token") {
        return Response.json({ callId: CALL_ID, connection, recordingUploadToken: RECORDING_UPLOAD_TOKEN });
      }
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const handlers = { onTranscript: vi.fn(), onState: vi.fn() };
    const call = new RealtimeCall(handlers);
    await call.start("agent-id", { recordingConsent: freshConsent() });
    FakeMediaRecorder.instances[0].emit(new Blob(["x".repeat(5_000)], { type: "audio/webm" }));

    const stopping = call.stop();
    await vi.advanceTimersByTimeAsync(0);
    // Recording, event, and end requests have no power to retain microphone/audio resources.
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledTimes(1);
    expect(handlers.onState).not.toHaveBeenLastCalledWith("ended");

    await vi.advanceTimersByTimeAsync(12_000);
    await stopping;
    expect(handlers.onState).toHaveBeenLastCalledWith("ended");
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/recording"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/end"))).toHaveLength(1);

    const attemptedAuditEvents = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith("/events"))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as {
        events: { type: string; payload: Record<string, unknown> }[];
      }).events);
    expect(attemptedAuditEvents).toContainEqual({ type: "recording_upload_failed", payload: { status: 0 } });
    expect(attemptedAuditEvents.filter((event) => event.type === "client_persistence_loss"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ stage: "recording", reason: "timeout" }) }),
        expect.objectContaining({ payload: expect.objectContaining({ stage: "events", reason: "timeout" }) }),
        expect.objectContaining({ payload: expect.objectContaining({ stage: "call_end", reason: "timeout" }) }),
      ]));
  });

  it("independently ends Gemini browser calls at the official 15-minute audio-only wall", async () => {
    vi.useFakeTimers();
    const fetchMock = successfulFetch({
      provider: "gemini",
      transport: "websocket",
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      token: "ephemeral",
      wsUrl: "wss://gemini.example/live",
      setup: { setup: {} },
      toolProxyUrl: "/api/mcp",
      toolProxyToken: "scope-token",
      toolProxyRotation,
      activeCatalogAuthority: {
        catalogDigest: "a".repeat(64),
        capabilityEpoch: 0,
        runtimeDigest: "b".repeat(64),
        stateRevision: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const handlers = { onTranscript: vi.fn(), onState: vi.fn() };
    const call = new RealtimeCall(handlers);
    await call.start("agent-id");

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/end"))).toBe(true);
    expect(handlers.onState).toHaveBeenLastCalledWith("ended");
  });

  it("makes concurrent shutdown callers join the same recording and persistence lifecycle", async () => {
    let markEndStarted!: () => void;
    let releaseEnd!: () => void;
    const endStarted = new Promise<void>((resolve) => { markEndStarted = resolve; });
    const endGate = new Promise<void>((resolve) => { releaseEnd = resolve; });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "/api/voice/token") return Response.json({ callId: CALL_ID, connection });
      if (String(input).endsWith("/end")) {
        markEndStarted();
        await endGate;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const handlers = { onTranscript: vi.fn(), onState: vi.fn() };
    const call = new RealtimeCall(handlers);
    await call.start("agent-id");

    const first = call.stop();
    const second = call.stop();
    expect(second).toBe(first);
    await endStarted;
    expect(handlers.onState).not.toHaveBeenLastCalledWith("ended");
    releaseEnd();
    await Promise.all([first, second]);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/end"))).toHaveLength(1);
    expect(handlers.onState.mock.calls.filter(([state]) => state === "ended")).toHaveLength(1);
  });
});
