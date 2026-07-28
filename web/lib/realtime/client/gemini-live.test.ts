import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  CAPABILITY_GATEWAY_TOOL,
  type ProviderFunctionTool,
} from "../../benchmark/capability-gateway";
import {
  RealtimeDynamicControlLimitError,
  type NormalizedRealtimeEvent,
  type RealtimeWebSocket,
  type RealtimeWebSocketFactory,
  type RealtimeWireObservation,
} from "./types";
import {
  realtimeWireObservationReference,
  verifyRealtimeWireObservationChain,
} from "./wire-evidence";
import { assertRealtimeTransportFailureDiagnostic } from "./transport-diagnostics";
import {
  buildGeminiFunctionDeclarations,
  buildGeminiLiveSetup,
  GEMINI_CAPABILITY_GATEWAY_NAME,
  GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
  GEMINI_LIVE_MAX_AUDIO_ONLY_SESSION_MS,
  GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ,
  GEMINI_PROVIDER_TRANSCRIPTION_POLICY,
  GeminiLiveClient,
  normalizeGeminiUsage,
} from "./gemini-live";

type SocketEvent = "open" | "message" | "error" | "close";

class FakeSocket implements RealtimeWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  failNextSend = false;
  private readonly listeners = new Map<SocketEvent, Array<(...args: unknown[]) => void>>();

  send(data: string) {
    if (this.readyState !== 1) throw new Error("fake socket is not open");
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("injected send failure");
    }
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
    tools: [CAPABILITY_GATEWAY_TOOL],
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
  test.socket.receive({ setupComplete: {} });
  await settle();
  await connected;
}

/** Every provider response fixture must have an observed outbound generation trigger. */
function triggerProviderTurn(test: ReturnType<typeof harness>) {
  test.client.sendTextTurn("Fixture caller requests the next provider response.");
}

function inputAudio(...bytes: number[]) {
  return {
    encoding: "pcm16" as const,
    sampleRateHz: GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
    channels: 1 as const,
    data: Uint8Array.from(bytes),
  };
}

afterEach(() => vi.useRealTimers());

describe("GeminiLiveClient", () => {
  it("enforces the official audio-only session wall and forbids a looser override", async () => {
    expect(() => harness({
      maximumSessionDurationMs: GEMINI_LIVE_MAX_AUDIO_ONLY_SESSION_MS + 1,
    })).toThrow("maximumSessionDurationMs");

    vi.useFakeTimers();
    const test = harness({ maximumSessionDurationMs: 25 });
    const connected = test.client.connect();
    test.socket.open();
    test.socket.receive({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(0);
    await connected;
    expect(test.client.state).toBe("ready");

    await vi.advanceTimersByTimeAsync(25);
    expect(test.client.state).toBe("closed");
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "session_duration_limit",
      fatal: true,
    }));
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "connection.closed",
      code: 1000,
      reason: "session duration limit",
    }));
  });

  it("sends the exact compiled gateway schema and frames mono PCM16 with manual activity", async () => {
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
    expect(setup.setup.tools[0].functionDeclarations[0]).toEqual({
      name: CAPABILITY_GATEWAY_TOOL.name,
      description: CAPABILITY_GATEWAY_TOOL.description,
      behavior: "BLOCKING",
      parametersJsonSchema: CAPABILITY_GATEWAY_TOOL.parameters,
    });
    expect(setup.setup.tools[0].functionDeclarations[0].parametersJsonSchema).toMatchObject({
      additionalProperties: false,
      required: ["tool_name", "arguments"],
      properties: {
        tool_name: expect.any(Object),
        arguments: expect.any(Object),
      },
    });
    expect(setup.setup.tools[0].functionDeclarations[0].parametersJsonSchema.properties)
      .not.toHaveProperty("operation");
    expect(setup.setup.tools[0].functionDeclarations[0].parametersJsonSchema.properties)
      .not.toHaveProperty("grant");
    expect(setup.setup.tools[0].functionDeclarations[0].parametersJsonSchema.properties)
      .not.toHaveProperty("capability_grant");
    expect(setup.setup.sessionResumption).not.toHaveProperty("transparent");
    expect(setup.setup).not.toHaveProperty("inputAudioTranscription");
    expect(setup.setup).not.toHaveProperty("outputAudioTranscription");
    expect(GEMINI_PROVIDER_TRANSCRIPTION_POLICY).toEqual({
      input: "disabled",
      output: "disabled",
    });
    expect(new URL(test.connectedUrl).searchParams.get("key")).toBe("gemini-key/+");
    expect(test.connectedHeaders).toEqual({});

    expect(test.client.setupReadinessEvidence).toBeNull();
    expect(test.client.sessionConfigurationAcknowledgement).toBeNull();
    test.socket.receive({ setupComplete: {} });
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
    expect(test.events.some((event) => event.type === "session.ready" && event.sessionId === undefined)).toBe(true);
    const ready = test.events.find((event) => event.type === "session.ready");
    expect(ready?.type === "session.ready" ? ready.configuration : undefined).toMatchObject({
      schemaVersion: 1,
      strictParityVerified: false,
      paidBenchmarkReady: false,
      session: { status: "unverifiable", requestedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      fields: {
        model: { status: "unverifiable", requestedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        voice: { status: "unverifiable", requestedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        instructions: { status: "unverifiable", requestedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        tools: { status: "unverifiable", requestedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        tool_choice: { status: "not_requested" },
        input_audio: { status: "unverifiable" },
        output_audio: { status: "unverifiable" },
        turn_detection: { status: "unverifiable" },
      },
    });
    expect(test.client.setupReadinessEvidence).toMatchObject({
      acknowledgement: "setupComplete",
      fieldEchoAvailable: false,
      configuration: { strictParityVerified: false, paidBenchmarkReady: false },
      clientSentFunctionDeclarationsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      clientSentToolNames: [GEMINI_CAPABILITY_GATEWAY_NAME],
      clientSentModel: "models/gemini-3.1-flash-live-preview",
      clientSentVoice: "Kore",
      providerTranscriptionPolicy: { input: "disabled", output: "disabled" },
    });
    expect(test.client.sessionConfigurationAcknowledgement).toMatchObject({
      schemaVersion: 1,
      strictParityVerified: false,
      paidBenchmarkReady: false,
      session: { status: "unverifiable" },
    });
    expect(Object.isFrozen(test.client.sessionConfigurationAcknowledgement)).toBe(true);
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "provider.event",
      data: expect.objectContaining({
        name: "session.setup_completed",
        acknowledgement_scope: "readiness_only",
        configuration_verification_scope: "none",
        field_echo_available: false,
        client_sent_tool_names: [GEMINI_CAPABILITY_GATEWAY_NAME],
        provider_transcription_policy: { input: "disabled", output: "disabled" },
      }),
    }));
  });

  it("puts the response plan on wire before activityEnd can trigger generation", async () => {
    const test = harness({ instructions: "BASE GEMINI SAFETY AND FLOW GUARDRAILS" });
    await connectReady(test);
    const setup = JSON.parse(test.socket.sent[0]);
    expect(setup.setup.systemInstruction).toEqual({
      parts: [{ text: "BASE GEMINI SAFETY AND FLOW GUARDRAILS" }],
    });
    test.socket.sent.length = 0;
    const control = [
      "<hacc_response_plan>",
      "{\"revision\":19,\"response_mode\":\"reconcile\"}",
      "</hacc_response_plan>",
      "<capability_snapshot>",
      "{\"actions\":[{\"name\":\"reconcile_booking\"}]}",
      "</capability_snapshot>",
    ].join("\n");

    test.client.appendInputAudio(inputAudio(1, 0));
    test.client.prepareResponse({
      additionalInstructions: control,
      contextSha256: createHash("sha256").update(control).digest("hex"),
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
    });
    expect(() => test.client.appendInputAudio(inputAudio(2, 0)))
      .toThrow("after preparing the next Gemini response");
    test.client.commitInputAudio();
    test.client.createResponse();

    expect(test.socket.sent.map((message) => JSON.parse(message))).toEqual([
      { realtimeInput: { activityStart: {} } },
      { realtimeInput: { audio: { data: "AQA=", mimeType: "audio/pcm;rate=16000" } } },
      {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: control }] }],
          turnComplete: false,
        },
      },
      { realtimeInput: { activityEnd: {} } },
    ]);
    expect(test.socket.sent.some((message) => message.includes('"realtimeInput":{"text"'))).toBe(false);
  });

  it("sends an official clientContent text turn without opening an audio activity", async () => {
    const test = harness();
    await connectReady(test);
    test.socket.sent.length = 0;

    test.client.sendTextTurn("Call capability_gateway exactly once.");

    expect(test.socket.sent.map((message) => JSON.parse(message))).toEqual([{
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "Call capability_gateway exactly once." }] }],
        turnComplete: true,
      },
    }]);
    expect(test.socket.sent.some((message) => message.includes("activityStart"))).toBe(false);
    expect(test.socket.sent.some((message) => message.includes("activityEnd"))).toBe(false);
    expect(test.socket.sent.some((message) => message.includes("realtimeInput"))).toBe(false);
  });

  it("rejects oversized dynamic control before wire delivery", async () => {
    const test = harness();
    await connectReady(test);
    test.client.appendInputAudio(inputAudio(1, 0));
    const sentBefore = test.socket.sent.length;
    const control = "x".repeat(4_097);
    let error: unknown;
    try {
      test.client.prepareResponse({
        additionalInstructions: control,
        contextSha256: createHash("sha256").update(control).digest("hex"),
        contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RealtimeDynamicControlLimitError);
    expect(error).toMatchObject({
      provider: "gemini",
      actualBytes: 4_097,
      maximumBytes: 4_096,
    });
    expect((error as Error).message).toContain("provider limit is 4096");
    expect(test.socket.sent).toHaveLength(sentBefore);
  });

  it("binds a real wire-shaped tool round trip to distinct local call and continuation phases", async () => {
    const observations: RealtimeWireObservation[] = [];
    const test = harness({ executeCapabilityGateway: undefined });
    test.client.onWireObservation((observation) => observations.push(observation));
    await connectReady(test);
    const control = "Call capability_gateway exactly once, then continue from its receipt.";
    test.client.appendInputAudio(inputAudio(1, 0, 2, 0));
    test.client.prepareResponse({
      additionalInstructions: control,
      contextSha256: createHash("sha256").update(control).digest("hex"),
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
    });
    test.client.commitInputAudio();
    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "provider-call-roundtrip",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { tool_name: "lookup_member", arguments: { member_id: "M-1" } },
        }],
      },
    });
    await settle();
    const callEvent = test.events.find((event) => event.type === "tool.calls");
    const call = callEvent?.type === "tool.calls" ? callEvent.calls[0] : undefined;
    expect(call).toMatchObject({
      callId: "provider-call-roundtrip",
      responseIdSource: "client_local",
      causalBinding: {
        connectionEpoch: 1,
        inputTurn: 1,
        trigger: "audio_activity_end",
        providerCallId: "provider-call-roundtrip",
        localResponseId: expect.stringMatching(/^gemini-local-response-1-1$/),
      },
    });
    const toolCallObservation = observations.find((entry) => entry.wireType === "toolCall")!;
    expect(toolCallObservation.identities).toHaveProperty("callIdSha256");
    expect(toolCallObservation.identities).not.toHaveProperty("responseIdSha256");
    const controlObservation = observations.find((entry) => (
      entry.direction === "outbound" && entry.wireType === "clientContent"
    ));
    expect(controlObservation?.projection).toMatchObject({
      dynamicControl: {
        sha256: createHash("sha256").update(control).digest("hex"),
        byteLength: Buffer.byteLength(control, "utf8"),
        authority: "advisory_only_gateway_and_speech_gate_enforced",
      },
    });
    expect(JSON.stringify(controlObservation?.projection)).not.toContain(control);

    test.client.submitToolResults([{
      callId: "provider-call-roundtrip",
      output: { ok: true, membership: "active" },
    }]);
    test.socket.receive({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: "AQA=", mimeType: "audio/pcm;rate=24000" } }],
        },
        generationComplete: true,
      },
    });
    test.socket.receive({
      serverContent: { turnComplete: true },
      usageMetadata: {
        promptTokenCount: 753,
        responseTokenCount: 77,
        totalTokenCount: 1_514,
      },
    });
    await settle();

    const callResponseId = call?.responseId;
    const started = test.events.filter((event) => event.type === "response.started");
    expect(started).toHaveLength(2);
    const continuationResponseId = started[1]?.type === "response.started"
      ? started[1].responseId
      : undefined;
    expect(continuationResponseId).toMatch(/^gemini-local-response-1-1-continuation-2$/);
    expect(continuationResponseId).not.toBe(callResponseId);
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "tool.results.submitted",
      responseId: callResponseId,
      responseIdSource: "client_local",
      callIds: ["provider-call-roundtrip"],
      continuationRequested: true,
    }));
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "output.audio",
      responseId: continuationResponseId,
    }));
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "response.completed",
      responseId: continuationResponseId,
      responseIdSource: "client_local",
      status: "completed",
    }));
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "usage",
      scope: "response",
      responseId: continuationResponseId,
      usage: expect.objectContaining({
        totalTokens: 1_514,
        meteringSource: "provider_reported",
      }),
    }));
    const terminal = test.events.find((event) => (
      event.type === "response.completed" && event.responseId === continuationResponseId
    ));
    const usage = test.events.find((event) => (
      event.type === "usage" && event.responseId === continuationResponseId
    ));
    expect(terminal?.wireObservation).toEqual(usage?.wireObservation);
    expect(terminal?.wireObservation).toMatchObject({ availability: "observed" });
    expect(observations.map((entry) => `${entry.direction}:${entry.wireType}`)).toEqual([
      "outbound:setup",
      "inbound:setupComplete",
      "outbound:realtimeInput.activityStart",
      "outbound:realtimeInput.audio",
      "outbound:clientContent",
      "outbound:realtimeInput.activityEnd",
      "inbound:toolCall",
      "outbound:toolResponse",
      "inbound:serverContent",
      "inbound:serverContent",
    ]);
  });

  it("fails closed when Gemini terminalizes before a blocking tool result", async () => {
    const test = harness({ executeCapabilityGateway: undefined });
    await connectReady(test);
    triggerProviderTurn(test);
    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "blocking-call",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: {},
        }],
      },
    });
    test.socket.receive({ serverContent: { turnComplete: true } });
    await settle();
    expect(test.client.state).toBe("failed");
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "turn_completed_before_tool_results",
      fatal: true,
    }));
  });

  it("cannot serialize provider transcription through an extra canary option", () => {
    const setup = buildGeminiLiveSetup({
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      instructions: "Follow the durable workflow.",
      tools: [CAPABILITY_GATEWAY_TOOL],
      inputAudioTranscription: { languageCode: "en-US" },
      outputAudioTranscription: {},
    } as Parameters<typeof buildGeminiLiveSetup>[0] & Record<string, unknown>);

    expect(setup.setup).not.toHaveProperty("inputAudioTranscription");
    expect(setup.setup).not.toHaveProperty("outputAudioTranscription");
    expect(JSON.stringify(setup)).not.toContain("languageCode");
  });

  it("emits a complete bidirectional, redacted, hash-chained wire evidence stream", async () => {
    const observations: RealtimeWireObservation[] = [];
    const test = harness({
      executeCapabilityGateway: async () => ({ ok: true, private_result: "SECRET-RESULT" }),
    });
    test.client.onWireObservation((observation) => observations.push(observation));
    await connectReady(test);

    test.client.appendInputAudio(inputAudio(1, 0, 2, 0));
    test.client.commitInputAudio();
    test.socket.receive({
      sessionResumptionUpdate: {
        resumable: true,
        newHandle: "SECRET-RESUME-HANDLE",
      },
    });
    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "provider-call-evidence",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { tool_name: "lookup_member", arguments: { member_id: "MEMBER-SECRET" } },
        }],
      },
    });
    await settle();
    test.socket.receive({
      serverContent: {
        modelTurn: {
          parts: [
            { text: "PRIVATE MODEL TEXT" },
            { inlineData: { data: "AQA=", mimeType: "audio/pcm;rate=24000" } },
          ],
        },
        turnComplete: true,
      },
      usageMetadata: {
        promptTokenCount: 10,
        responseTokenCount: 2,
        totalTokenCount: 12,
      },
    });
    await settle();

    expect(observations.map(({ direction, wireType }) => `${direction}:${wireType}`)).toEqual([
      "outbound:setup",
      "inbound:setupComplete",
      "outbound:realtimeInput.activityStart",
      "outbound:realtimeInput.audio",
      "outbound:realtimeInput.activityEnd",
      "inbound:sessionResumptionUpdate",
      "inbound:toolCall",
      "outbound:toolResponse",
      "inbound:serverContent",
    ]);
    expect(verifyRealtimeWireObservationChain(observations)).toEqual({
      valid: true,
      eventCount: observations.length,
      chainHead: observations.at(-1)?.observationSha256,
      errors: [],
    });
    const setupAcknowledgement = observations.find((entry) => entry.wireType === "setupComplete")!;
    const toolCallObservation = observations.find((entry) => entry.wireType === "toolCall")!;
    const serverContentObservation = observations.find((entry) => entry.wireType === "serverContent")!;
    expect(test.events.find((event) => event.type === "session.ready")?.wireObservation)
      .toEqual(realtimeWireObservationReference(setupAcknowledgement));
    for (const event of test.events.filter((candidate) => (
      candidate.wireType === "toolCall"
    ))) {
      expect(event.wireObservation).toEqual(realtimeWireObservationReference(toolCallObservation));
    }
    for (const event of test.events.filter((candidate) => (
      candidate.type === "output.audio"
      || candidate.type === "response.completed"
      || candidate.type === "usage"
      || (candidate.type === "provider.event" && candidate.data.name === "content.part")
    ))) {
      expect(event.wireObservation).toEqual(realtimeWireObservationReference(serverContentObservation));
    }

    const setupSession = observations.find((entry) => entry.wireType === "setup")
      ?.projection.session as Record<string, unknown>;
    expect(setupSession).toMatchObject({
      present: true,
      toolCount: 1,
      manualActivityDetection: true,
      providerTranscriptionPolicy: { input: "disabled", output: "disabled" },
      inputFormat: { encoding: "pcm16", sampleRateHz: 16_000, channels: 1 },
      outputFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    });
    expect(setupSession.fieldSha256).toMatchObject({
      model: expect.stringMatching(/^[a-f0-9]{64}$/),
      voice: expect.stringMatching(/^[a-f0-9]{64}$/),
      instructions: expect.stringMatching(/^[a-f0-9]{64}$/),
      tools: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(observations.find((entry) => entry.wireType === "setupComplete")?.projection.session)
      .toEqual({
        acknowledgement: "readiness_only",
        fieldEchoAvailable: false,
        strictParityVerified: false,
        paidBenchmarkReady: false,
      });

    const call = (observations.find((entry) => entry.wireType === "toolCall")
      ?.projection.gatewayCalls as Record<string, unknown>[])[0]!;
    const result = (observations.find((entry) => entry.wireType === "toolResponse")
      ?.projection.gatewayResults as Record<string, unknown>[])[0]!;
    expect(call.callIdSha256).toBe(result.callIdSha256);
    expect(call).toMatchObject({
      gateway: GEMINI_CAPABILITY_GATEWAY_NAME,
      argumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetToolNameSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetArgumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result).toMatchObject({
      resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      resultBytes: expect.any(Number),
    });
    expect(observations.find((entry) => entry.wireType === "serverContent")?.projection)
      .toMatchObject({
        audio: {
          direction: "output",
          chunks: [{
            validCanonicalBase64: true,
            byteLength: 2,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }],
        },
        text: [{
          kind: "model_text",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          byteLength: 18,
        }],
        usage: { totalInputTokens: 10, totalOutputTokens: 2, totalTokens: 12 },
        terminal: { status: "completed" },
      });

    const published = JSON.stringify(observations);
    for (const secret of [
      "gemini-key/+",
      "Follow the durable workflow.",
      "AQACAA==",
      "AQA=",
      "MEMBER-SECRET",
      "SECRET-RESULT",
      "SECRET-RESUME-HANDLE",
      "PRIVATE MODEL TEXT",
      CAPABILITY_GATEWAY_TOOL.description,
    ]) {
      expect(published).not.toContain(secret);
    }
  });

  it("does not lend provider-frame attribution to re-entrant raw observer actions", async () => {
    const holder: { client?: GeminiLiveClient } = {};
    const test = harness({
      onRawMessage: () => holder.client?.createResponse(),
    });
    holder.client = test.client;
    test.client.onWireObservation(() => undefined);
    await connectReady(test);

    const synthetic = test.events.find((event) => (
      event.type === "provider.event" && event.data.name === "response_creation_is_implicit"
    ));
    expect(synthetic?.wireObservation).toEqual({
      availability: "unavailable",
      reason: "client_generated",
    });
  });

  it("omits session resumption by default and ignores unsolicited provider handles", async () => {
    const test = harness();
    const connected = test.client.connect();
    test.socket.open();
    const setup = JSON.parse(test.socket.sent[0]);
    expect(setup.setup).not.toHaveProperty("sessionResumption");
    test.socket.receive({ setupComplete: {} });
    await connected;
    test.socket.receive({
      sessionResumptionUpdate: { resumable: true, newHandle: "unsolicited-handle" },
    });
    await settle();

    expect(test.client.resumeState).toEqual({ resumable: false });
    expect(test.events.some((event) => event.type === "session.resumption")).toBe(false);
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "provider.event",
      data: { name: "session_resumption_ignored", reason: "not_explicitly_enabled" },
    }));
  });

  it("translates arbitrary common function tools losslessly and isolates them from caller mutation", () => {
    const parameters: ProviderFunctionTool["parameters"] = {
      type: "object",
      additionalProperties: false,
      properties: { nested: { type: "array", items: { type: "integer", minimum: 0 } } },
      required: ["nested"],
    };
    const tools: ProviderFunctionTool[] = [{
      type: "function" as const,
      name: "custom_lookup",
      description: "Look up one custom record.",
      parameters,
    }];
    const declarations = buildGeminiFunctionDeclarations(tools);
    expect(declarations).toEqual([{
      name: tools[0].name,
      description: tools[0].description,
      behavior: "BLOCKING",
      parametersJsonSchema: parameters,
    }]);
    const mutableParameters = parameters as unknown as {
      properties: { nested: { items: { minimum: number } } };
    };
    mutableParameters.properties.nested.items.minimum = 99;
    expect(declarations[0]?.parametersJsonSchema).toMatchObject({
      properties: { nested: { items: { minimum: 0 } } },
    });
    expect(Object.isFrozen(declarations[0])).toBe(true);
    expect(Object.isFrozen(declarations[0]?.parametersJsonSchema)).toBe(true);
  });

  it("rejects ambiguous or unsafe provider tool surfaces before opening a socket", () => {
    const duplicate = {
      type: "function",
      name: "duplicate",
      description: "Duplicate tool.",
      parameters: { type: "object", properties: {} },
    } as ProviderFunctionTool;
    expect(() => buildGeminiFunctionDeclarations([duplicate, duplicate])).toThrow("duplicated");

    const nonObject = {
      ...duplicate,
      name: "non_object",
      parameters: { type: "array", items: { type: "string" } },
    } as unknown as ProviderFunctionTool;
    expect(() => buildGeminiFunctionDeclarations([nonObject])).toThrow("must describe an object");

    const unsafe = JSON.parse(JSON.stringify({
      ...duplicate,
      name: "unsafe",
      parameters: { type: "object", properties: {} },
    })) as ProviderFunctionTool;
    Object.defineProperty(unsafe.parameters, "__proto__", {
      value: { type: "string" },
      enumerable: true,
    });
    expect(() => buildGeminiFunctionDeclarations([unsafe])).toThrow("unsafe object key");
  });

  it("treats setupComplete as readiness only, permits usage metadata, and rejects fabricated echoed fields", async () => {
    const accepted = harness();
    const connected = accepted.client.connect();
    accepted.socket.open();
    accepted.socket.receive({
      setupComplete: {},
      usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
    });
    await connected;
    await settle();
    expect(accepted.client.state).toBe("ready");
    expect(accepted.events).toContainEqual(expect.objectContaining({
      type: "usage",
      scope: "session",
      usage: expect.objectContaining({ totalInputTokens: 3, totalTokens: 3 }),
    }));

    const fabricated = harness();
    const rejected = fabricated.client.connect();
    fabricated.socket.open();
    fabricated.socket.receive({ setupComplete: { sessionId: "not-in-the-protocol" } });
    await expect(rejected).rejects.toThrow("invalid or non-exclusive setup acknowledgement");
    expect(fabricated.client.state).toBe("failed");
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

  it("fails closed before deriving effects from a mixed post-setup server-message union", async () => {
    const test = harness();
    await connectReady(test);
    test.socket.receive({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "AQA=", mimeType: "audio/pcm;rate=24000" } }] },
      },
      toolCall: {
        functionCalls: [{
          id: "must-not-dispatch",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { tool_name: "lookup_member", arguments: {} },
        }],
      },
    });
    await settle();

    expect(test.client.state).toBe("failed");
    expect(test.events.some((event) => event.type === "output.audio")).toBe(false);
    expect(test.events.some((event) => event.type === "tool.calls")).toBe(false);
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "mixed_server_message_union",
      fatal: true,
    }));
  });

  it("treats repeated setup acknowledgement and malformed usage metadata as fatal drift", async () => {
    for (const message of [
      { setupComplete: {} },
      { usageMetadata: "not-an-object" },
    ]) {
      const test = harness();
      await connectReady(test);
      test.socket.receive(message);
      await settle();
      expect(test.client.state).toBe("failed");
    }
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
    triggerProviderTurn(test);
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
    triggerProviderTurn(test);
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
      delta: "Good afternoon",
      phase: "final",
      responseId: firstResponseId,
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

  it("matches batched function response IDs and deduplicates exact retries", async () => {
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
    triggerProviderTurn(test);
    const sentBefore = test.socket.sent.length;
    test.socket.receive({
      toolCall: {
        functionCalls: [
          {
            id: "call-1",
            name: GEMINI_CAPABILITY_GATEWAY_NAME,
            args: { operation: "lookup", arguments: { id: "M-1" } },
          },
          {
            id: "call-2",
            name: GEMINI_CAPABILITY_GATEWAY_NAME,
            args: { operation: "lookup", arguments: { id: "M-2" } },
          },
        ],
      },
    });
    await settle();

    expect(executions).toBe(2);
    expect(test.events.filter((event) => event.type === "tool.calls")).toHaveLength(1);
    const response = JSON.parse(test.socket.sent[sentBefore]);
    expect(response.toolResponse.functionResponses.map((item: { id: string }) => item.id)).toEqual(["call-1", "call-2"]);
    expect(response.toolResponse.functionResponses[0]).toMatchObject({
      id: "call-1",
      name: GEMINI_CAPABILITY_GATEWAY_NAME,
      response: { ok: true, receipt: "7", self: "[Circular]" },
    });
    expect(response.toolResponse.functionResponses[1]).toMatchObject({
      id: "call-2",
      name: GEMINI_CAPABILITY_GATEWAY_NAME,
      response: { ok: true, receipt: "7", self: "[Circular]" },
    });

    const sentBeforeReplay = test.socket.sent.length;
    test.socket.receive({
      toolCall: {
        functionCalls: [
          {
            id: "call-1",
            name: GEMINI_CAPABILITY_GATEWAY_NAME,
            args: { operation: "lookup", arguments: { id: "M-1" } },
          },
          {
            id: "call-2",
            name: GEMINI_CAPABILITY_GATEWAY_NAME,
            args: { operation: "lookup", arguments: { id: "M-2" } },
          },
        ],
      },
    });
    await settle();
    expect(executions).toBe(2);
    expect(test.events.filter((event) => event.type === "tool.calls")).toHaveLength(1);
    expect(test.socket.sent).toHaveLength(sentBeforeReplay + 1);
    const retried = JSON.parse(test.socket.sent.at(-1)!);
    expect(retried.toolResponse.functionResponses.map((entry: { id: string }) => entry.id))
      .toEqual(["call-1", "call-2"]);
  });

  it("rejects an entire tool batch before execution when any member is undeclared or malformed", async () => {
    for (const invalid of [
      { id: "bad-name", name: "dangerous_leaf_tool", args: {} },
      { id: "bad-args", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: [] },
    ]) {
      let executions = 0;
      const test = harness({
        executeCapabilityGateway: async () => ({ execution: ++executions }),
      });
      await connectReady(test);
      const sentBefore = test.socket.sent.length;
      test.socket.receive({
        toolCall: {
          functionCalls: [
            {
              id: "valid-member",
              name: GEMINI_CAPABILITY_GATEWAY_NAME,
              args: { tool_name: "lookup_member", arguments: {} },
            },
            invalid,
          ],
        },
      });
      await settle();

      expect(test.client.state).toBe("failed");
      expect(executions).toBe(0);
      expect(test.socket.sent).toHaveLength(sentBefore);
      expect(test.events.some((event) => event.type === "tool.calls")).toBe(false);
      expect(test.events).toContainEqual(expect.objectContaining({
        type: "error",
        code: invalid.name === "dangerous_leaf_tool"
          ? "undeclared_tool_call"
          : "invalid_tool_call_arguments",
        fatal: true,
      }));
    }
  });

  it("rejects a duplicate function-call ID whose canonical name or arguments changed", async () => {
    let executions = 0;
    const test = harness({
      executeCapabilityGateway: async () => ({ execution: ++executions }),
    });
    await connectReady(test);
    triggerProviderTurn(test);
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
    const sentBeforeConflict = test.socket.sent.length;

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
    expect(test.socket.sent).toHaveLength(sentBeforeConflict);
    expect(test.client.state).toBe("failed");
    expect(test.events.some(
      (event) => event.type === "error"
        && event.code === "duplicate_tool_call_conflict"
        && event.fatal,
    )).toBe(true);
  });

  it("rejects unbounded function-call identities before they can reach the gateway", async () => {
    let executions = 0;
    const test = harness({
      executeCapabilityGateway: async () => ({ execution: ++executions }),
    });
    await connectReady(test);
    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "x".repeat(257),
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { action: "lookup", arguments: {}, capability_grant: "grant" },
        }],
      },
    });
    await settle();

    expect(executions).toBe(0);
    expect(test.client.state).toBe("failed");
    expect(test.events.some(
      (event) => event.type === "error" && event.code === "invalid_tool_call_identity" && event.fatal,
    )).toBe(true);
  });

  it("never carries provider call-id response caches across an unverifiable reconnect", async () => {
    let executions = 0;
    const test = harness({
      executeCapabilityGateway: async ({ arguments: args }) => ({
        execution: ++executions,
        action: args.action,
      }),
    });
    await connectReady(test);
    triggerProviderTurn(test);
    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "connection-scoped-id",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { action: "first", arguments: {}, capability_grant: "grant" },
        }],
      },
    });
    await settle();
    expect(executions).toBe(1);

    test.socket.serverClose();
    const reconnect = test.client.connect();
    test.socket.open();
    test.socket.receive({ setupComplete: {} });
    await reconnect;
    triggerProviderTurn(test);
    test.socket.receive({
      toolCall: {
        functionCalls: [{
          id: "connection-scoped-id",
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: { action: "second", arguments: {}, capability_grant: "grant" },
        }],
      },
    });
    await settle();

    expect(executions).toBe(2);
    const response = JSON.parse(test.socket.sent.at(-1)!);
    expect(response.toolResponse.functionResponses[0]).toMatchObject({
      id: "connection-scoped-id",
      response: { execution: 2, action: "second" },
    });
    expect(test.events.some(
      (event) => event.type === "error" && event.code === "duplicate_tool_call_conflict",
    )).toBe(false);
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
    triggerProviderTurn(test);

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
      responseId: expect.stringMatching(/^gemini-local-response-/),
      responseIdSource: "client_local",
      terminalWireType: "toolCall",
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
    triggerProviderTurn(test);
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
          response: { eligible: true },
        }],
      },
    });
    expect(test.events.some(
      (event) => event.type === "provider.event" && event.data.name === "response_creation_is_implicit",
    )).toBe(true);
  });

  it("requires one exact external result batch before admitting another tool batch", async () => {
    const complete = harness({ executeCapabilityGateway: undefined });
    await connectReady(complete);
    triggerProviderTurn(complete);
    complete.socket.receive({
      toolCall: {
        functionCalls: [
          { id: "complete-a", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: { operation: "a" } },
          { id: "complete-b", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: { operation: "b" } },
        ],
      },
    });
    await settle();
    const sentBefore = complete.socket.sent.length;
    expect(() => complete.client.submitToolResults([
      { callId: "complete-a", output: { ok: true } },
    ])).toThrow(/batch mismatch.*complete-b/);
    expect(complete.socket.sent).toHaveLength(sentBefore);
    complete.client.submitToolResults([
      { callId: "complete-a", output: { ok: true } },
      { callId: "complete-b", output: { ok: true } },
    ]);
    expect(JSON.parse(complete.socket.sent.at(-1)!).toolResponse.functionResponses)
      .toHaveLength(2);

    const overlapping = harness({ executeCapabilityGateway: undefined });
    await connectReady(overlapping);
    triggerProviderTurn(overlapping);
    overlapping.socket.receive({
      toolCall: {
        functionCalls: [{ id: "pending-a", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: {} }],
      },
    });
    await settle();
    overlapping.socket.receive({
      toolCall: {
        functionCalls: [{ id: "overlap-b", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: {} }],
      },
    });
    await settle();
    expect(overlapping.client.state).toBe("failed");
    expect(overlapping.events.filter((event) => event.type === "tool.calls")).toHaveLength(1);
    expect(overlapping.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "overlapping_tool_batch",
      fatal: true,
    }));
  });

  it("snapshots external result identity once and fails closed on an indeterminate send", async () => {
    const accessors = harness({ executeCapabilityGateway: undefined });
    await connectReady(accessors);
    triggerProviderTurn(accessors);
    accessors.socket.receive({
      toolCall: {
        functionCalls: [{ id: "snapshot-call", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: {} }],
      },
    });
    await settle();
    const accessorResult = Object.defineProperties({}, {
      callId: { enumerable: true, get: () => "snapshot-call" },
      output: { enumerable: true, value: { ok: true } },
    });
    const sentBeforeAccessor = accessors.socket.sent.length;
    expect(() => accessors.client.submitToolResults([accessorResult as never]))
      .toThrow(/callId must be a concrete string/);
    expect(accessors.socket.sent).toHaveLength(sentBeforeAccessor);
    accessors.client.submitToolResults([{ callId: "snapshot-call", output: { ok: true } }]);

    const uncertain = harness({ executeCapabilityGateway: undefined });
    await connectReady(uncertain);
    triggerProviderTurn(uncertain);
    uncertain.socket.receive({
      toolCall: {
        functionCalls: [{ id: "uncertain-call", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: {} }],
      },
    });
    await settle();
    uncertain.socket.failNextSend = true;
    expect(() => uncertain.client.submitToolResults([
      { callId: "uncertain-call", output: { ok: true } },
    ])).toThrow(/indeterminate outcome/);
    expect(uncertain.client.state).toBe("failed");
    expect(uncertain.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "tool_response_send_failed",
      fatal: true,
    }));
    expect(() => uncertain.client.submitToolResults([
      { callId: "uncertain-call", output: { ok: true } },
    ])).toThrow(/setup is not complete/);

    const internal = harness({ executeCapabilityGateway: async () => ({ ok: true }) });
    await connectReady(internal);
    triggerProviderTurn(internal);
    internal.socket.failNextSend = true;
    internal.socket.receive({
      toolCall: {
        functionCalls: [{ id: "internal-send", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: {} }],
      },
    });
    await settle();
    expect(internal.client.state).toBe("failed");
    expect(internal.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "tool_response_send_failed",
      fatal: true,
    }));
  });

  it("waits for every internal tool result and suppresses in-flight exact replays", async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    let executions = 0;
    const test = harness({
      executeCapabilityGateway: ({ callId }) => {
        executions += 1;
        return new Promise((resolve) => resolvers.set(callId, resolve));
      },
    });
    await connectReady(test);
    triggerProviderTurn(test);
    const batch = {
      toolCall: {
        functionCalls: [
          { id: "slow-a", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: { operation: "a" } },
          { id: "slow-b", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: { operation: "b" } },
        ],
      },
    };
    const sentBefore = test.socket.sent.length;
    test.socket.receive(batch);
    await settle();
    test.socket.receive(structuredClone(batch));
    await settle();
    expect(executions).toBe(2);
    expect(test.events.filter((event) => event.type === "tool.calls")).toHaveLength(1);
    expect(test.socket.sent).toHaveLength(sentBefore);

    resolvers.get("slow-a")?.({ result: "a" });
    await settle();
    expect(test.socket.sent).toHaveLength(sentBefore);
    resolvers.get("slow-b")?.({ result: "b" });
    await settle();
    const response = JSON.parse(test.socket.sent.at(-1)!);
    expect(response.toolResponse.functionResponses.map((entry: { id: string }) => entry.id))
      .toEqual(["slow-a", "slow-b"]);
  });

  it("fails closed at 64 calls per batch and a 10k-default bounded identity ledger", async () => {
    expect(() => harness({ maximumTrackedToolCallIdentities: 10_001 }))
      .toThrow(/maximumTrackedToolCallIdentities/);

    const oversized = harness();
    await connectReady(oversized);
    triggerProviderTurn(oversized);
    oversized.socket.receive({
      toolCall: {
        functionCalls: Array.from({ length: 65 }, (_, index) => ({
          id: `bounded-${index}`,
          name: GEMINI_CAPABILITY_GATEWAY_NAME,
          args: {},
        })),
      },
    });
    await settle();
    expect(oversized.client.state).toBe("failed");
    expect(oversized.events.some((event) => event.type === "tool.calls")).toBe(false);
    expect(oversized.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "tool_call_batch_too_large",
      fatal: true,
    }));

    const capacity = harness({
      executeCapabilityGateway: undefined,
      maximumTrackedToolCallIdentities: 1,
    });
    await connectReady(capacity);
    triggerProviderTurn(capacity);
    capacity.socket.receive({
      toolCall: {
        functionCalls: [{ id: "ledger-one", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: {} }],
      },
    });
    await settle();
    capacity.client.submitToolResults([{ callId: "ledger-one", output: { ok: true } }]);
    capacity.socket.receive({
      toolCall: {
        functionCalls: [{ id: "ledger-two", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: {} }],
      },
    });
    await settle();
    expect(capacity.client.state).toBe("failed");
    expect(capacity.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "tool_call_identity_capacity_exceeded",
      fatal: true,
    }));
  });

  it("fails closed on partial exact tool-batch replay without re-emitting executable work", async () => {
    let executions = 0;
    const test = harness({
      executeCapabilityGateway: async () => ({ execution: ++executions }),
    });
    await connectReady(test);
    triggerProviderTurn(test);
    test.socket.receive({
      toolCall: {
        functionCalls: [
          { id: "replay-a", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: { operation: "a" } },
          { id: "replay-b", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: { operation: "b" } },
        ],
      },
    });
    await settle();
    test.socket.receive({
      toolCall: {
        functionCalls: [
          { id: "replay-a", name: GEMINI_CAPABILITY_GATEWAY_NAME, args: { operation: "a" } },
        ],
      },
    });
    await settle();

    expect(executions).toBe(2);
    expect(test.events.filter((event) => event.type === "tool.calls")).toHaveLength(1);
    expect(test.client.state).toBe("failed");
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "partial_tool_batch_replay",
      fatal: true,
    }));
  });

  it("keeps internal and external tool execution mutually exclusive and caps whole result batches", async () => {
    const internal = harness();
    await connectReady(internal);
    expect(() => internal.client.submitToolResults([{ callId: "x", output: {} }]))
      .toThrow("internal tool execution");

    const external = harness({ executeCapabilityGateway: undefined, maxToolResponseBytes: 180 });
    await connectReady(external);
    triggerProviderTurn(external);
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
    triggerProviderTurn(test);
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
      (event) => event.type === "tool.cancelled"
        && event.responseId.startsWith("gemini-local-response-")
        && event.callIds[0] === "cancel-1",
    )).toBe(true);
  });

  it("fails closed on malformed or unknown tool cancellation identities", async () => {
    for (const ids of [
      [],
      ["never-issued"],
      ["duplicate", "duplicate"],
      [42],
      ["bad id with spaces"],
      Array.from({ length: 65 }, (_, index) => `call-${index}`),
    ]) {
      const test = harness();
      await connectReady(test);
      test.socket.receive({ toolCallCancellation: { ids } });
      await settle();

      expect(test.client.state).toBe("failed");
      expect(test.events).toContainEqual(expect.objectContaining({
        type: "error",
        code: "invalid_tool_cancellation",
        fatal: true,
      }));
      expect(test.events.some((event) => event.type === "tool.cancelled")).toBe(false);
    }
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
    triggerProviderTurn(test);
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
    secondSocket.receive({ setupComplete: {} });
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

  it("records usage, go-away, and resumable handles", async () => {
    let publishedResumeHandle = "";
    const test = harness({
      resumeHandle: "resume-old",
      onRawMessage: (message) => {
        if (message.sessionResumptionUpdate && typeof message.sessionResumptionUpdate === "object") {
          publishedResumeHandle = String(
            (message.sessionResumptionUpdate as Record<string, unknown>).newHandle ?? "",
          );
        }
      },
    });
    await connectReady(test);
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

  it("omits unavailable usage counters instead of emitting non-JSON undefined values", () => {
    expect(normalizeGeminiUsage({ promptTokenCount: 12, responseTokenCount: 4 })).toEqual({
      totalInputTokens: 12,
      totalOutputTokens: 4,
      meteringSource: "provider_reported",
      raw: { promptTokenCount: 12, responseTokenCount: 4 },
    });
  });

  it("fails closed when a provider frame cannot be parsed or preserved", async () => {
    const malformed = harness();
    await connectReady(malformed);
    malformed.socket.receive("{not-json");
    await settle();
    expect(malformed.client.state).toBe("failed");
    expect(malformed.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "invalid_provider_message",
      message: "Gemini returned malformed JSON",
      fatal: true,
    }));

    const test = harness({ maxIncomingMessageBytes: 64 });
    await connectReady(test);
    test.socket.receiveRaw(Buffer.alloc(65, 0x7b));
    await settle();

    expect(test.client.state).toBe("failed");
    expect(test.events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "invalid_provider_message",
      message: expect.stringContaining("exceeded 64 bytes"),
      fatal: true,
    }));
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
      responseId: expect.stringMatching(/^gemini-local-response-/),
      usage: { raw: { promptTokenCount: 10, responseTokenCount: 2, totalTokenCount: 12 } },
    });
  });

  it("treats missing or non-24k raw PCM MIME as fatal and emits no mislabeled audio", async () => {
    const test = harness();
    await connectReady(test);
    triggerProviderTurn(test);
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
    triggerProviderTurn(rejected);
    rejected.socket.receive({
      serverContent: { turnComplete: true, turnCompleteReason: "RESPONSE_REJECTED" },
    });
    await settle();
    expect(rejected.events.filter((event) => event.type === "response.started")).toHaveLength(1);
    const rejectedCompletion = rejected.events.find((event) => event.type === "response.completed");
    expect(rejectedCompletion?.type === "response.completed" ? rejectedCompletion : undefined)
      .toMatchObject({ status: "failed", reason: "RESPONSE_REJECTED" });
    expect(rejected.events.some(
      (event) => event.type === "error" && event.code === "response_rejected",
    )).toBe(true);

    const interrupted = harness();
    await connectReady(interrupted);
    triggerProviderTurn(interrupted);
    interrupted.socket.receive({ serverContent: { generationComplete: true } });
    interrupted.socket.receive({ serverContent: { interrupted: true } });
    interrupted.socket.receive({ serverContent: { turnComplete: true } });
    await settle();
    const completions = interrupted.events.filter((event) => event.type === "response.completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.type === "response.completed" ? completions[0].status : undefined)
      .toBe("interrupted");
    const interruption = interrupted.events.find((event) => event.type === "turn.interrupted");
    expect(interruption?.type === "turn.interrupted" ? interruption.responseId : undefined)
      .toBe(completions[0]?.type === "response.completed" ? completions[0].responseId : undefined);
  });

  it("never exposes an authenticated key-bearing URL through transport diagnostics", async () => {
    const key = "super-secret/+token";
    const factoryEvents: NormalizedRealtimeEvent[] = [];
    const factoryClient = new GeminiLiveClient({
      apiKey: key,
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      instructions: "test",
      tools: [CAPABILITY_GATEWAY_TOOL],
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
    const transportError = transport.events.find((event) => event.type === "error");
    if (transportError?.type !== "error" || !transportError.transportDiagnostic) {
      throw new Error("missing Gemini WebSocket failure diagnostic");
    }
    assertRealtimeTransportFailureDiagnostic(transportError.transportDiagnostic);
    expect(transportError.transportDiagnostic).toMatchObject({
      origin: "websocket_error",
      category: "network",
      responseGenerationRequested: false,
      responseGenerationStarted: false,
      responseTerminalObserved: false,
    });
  });

  it("emits content-free lifecycle evidence when a server closes an active response", async () => {
    const test = harness();
    await connectReady(test);
    triggerProviderTurn(test);
    test.socket.receive({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: "AQA=", mimeType: "audio/pcm;rate=24000" } }],
        },
      },
    });
    await settle();
    const privateReason = "provider internal trace private-close-SENTINEL";
    test.socket.serverClose(1011, privateReason);
    await settle();

    const closed = test.events.find((event) => event.type === "connection.closed");
    if (closed?.type !== "connection.closed" || !closed.transportDiagnostic) {
      throw new Error("missing Gemini close diagnostic");
    }
    assertRealtimeTransportFailureDiagnostic(closed.transportDiagnostic);
    expect(closed.transportDiagnostic).toMatchObject({
      origin: "websocket_close",
      category: "server_close",
      closeCodeClass: "server_error",
      responseGenerationRequested: true,
      responseGenerationStarted: true,
      responseTerminalObserved: false,
    });
    expect(closed.transportDiagnostic.reasonSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(closed.transportDiagnostic)).not.toContain(privateReason);
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
