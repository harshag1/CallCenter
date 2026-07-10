import WebSocket from "ws";
import { PCM16_MONO_24KHZ, assertPcm16Format, pcm16ToBase64 } from "./audio";
import { OpenAICompatibleEventNormalizer, safeParseWireEvent } from "./events";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  Pcm16Audio,
  Pcm16Format,
  RealtimeClientState,
  RealtimeEventListener,
  RealtimeToolResult,
  RealtimeWebSocket,
  RealtimeWebSocketFactory,
  RealtimeWireEventListener,
} from "./types";

type OpenAICompatibleProvider = "openai" | "xai";

export type OpenAICompatibleRealtimeClientOptions = {
  provider: OpenAICompatibleProvider;
  url: string;
  headers?: Record<string, string>;
  sessionUpdate: Record<string, unknown>;
  inputAudioFormat?: Pcm16Format;
  outputAudioFormat?: Pcm16Format;
  socketFactory?: RealtimeWebSocketFactory;
  connectTimeoutMs?: number;
  maximumWireEventBytes?: number;
  includeProviderEvents?: boolean;
  /** Test-only escape hatch; authenticated plaintext is restricted to loopback. */
  allowInsecureLocalhostForTests?: boolean;
  now?: () => number;
};

export type HostedOpenAICompatibleClientOptions = Omit<
  OpenAICompatibleRealtimeClientOptions,
  "provider" | "url" | "headers"
> & {
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
};

export type HostedXaiRealtimeClientOptions = HostedOpenAICompatibleClientOptions & {
  /** Server-issued `conversation.created.conversation.id` from a prior session. */
  conversationId?: string;
  /** Opt in on a fresh session so xAI will retain replayable conversation turns. */
  enableResumption?: boolean;
};

const defaultSocketFactory: RealtimeWebSocketFactory = (url, options) => (
  new WebSocket(url, { headers: options.headers }) as unknown as RealtimeWebSocket
);

/**
 * Server-side client for the realtime wire protocol shared by OpenAI and xAI.
 * `connect()` does not resolve on TCP/WebSocket open: it resolves only after the
 * provider acknowledges our `session.update`, avoiding turns sent against stale
 * defaults.
 */
export class OpenAICompatibleRealtimeClient implements NormalizedRealtimeClient {
  readonly provider: OpenAICompatibleProvider;
  private currentState: RealtimeClientState = "idle";
  private socket: RealtimeWebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly eventListeners = new Set<RealtimeEventListener>();
  private readonly wireListeners = new Set<RealtimeWireEventListener>();
  private readonly socketFactory: RealtimeWebSocketFactory;
  private readonly connectionUrl: string;
  private readonly connectionHeaders: Record<string, string>;
  private readonly inputAudioFormat: Pcm16Format;
  private readonly outputAudioFormat: Pcm16Format;
  private readonly sessionUpdate: Record<string, unknown>;
  private readonly normalizer: OpenAICompatibleEventNormalizer;
  private readonly now: () => number;
  private readonly connectTimeoutMs: number;
  private readonly maximumWireEventBytes?: number;
  private readonly xaiResumptionEnabled: boolean;
  private meteredInputAudioBytes = 0;
  private meteredOutputAudioBytes = 0;
  private meteredBillableTextInputEvents = 0;
  private pendingXaiResumption: Extract<NormalizedRealtimeEvent, { type: "session.resumption" }> | null = null;
  private pendingToolBatch: Set<string> | null = null;

  constructor(options: OpenAICompatibleRealtimeClientOptions) {
    if (options.provider !== "openai" && options.provider !== "xai") {
      throw new Error(`Unsupported OpenAI-compatible provider: ${String(options.provider)}`);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(options.url);
    } catch {
      throw new Error("Realtime client URL must be valid");
    }
    if (parsedUrl.protocol !== "wss:" && parsedUrl.protocol !== "ws:") {
      throw new Error("Realtime client URL must use ws:// or wss://");
    }
    if (parsedUrl.username || parsedUrl.password) throw new Error("Realtime client URL cannot contain credentials");
    if (
      parsedUrl.protocol === "ws:"
      && !(options.allowInsecureLocalhostForTests && isLoopbackHost(parsedUrl.hostname))
    ) {
      throw new Error("Realtime connections require wss:// except explicit loopback tests");
    }
    if (options.sessionUpdate.type !== "session.update" || !isRecord(options.sessionUpdate.session)) {
      throw new Error("Realtime client requires a session.update payload");
    }
    if (options.connectTimeoutMs !== undefined && (!Number.isFinite(options.connectTimeoutMs) || options.connectTimeoutMs <= 0)) {
      throw new Error("connectTimeoutMs must be positive");
    }
    if (
      options.maximumWireEventBytes !== undefined
      && (!Number.isInteger(options.maximumWireEventBytes) || options.maximumWireEventBytes <= 0)
    ) {
      throw new Error("maximumWireEventBytes must be a positive integer");
    }
    this.provider = options.provider;
    this.connectionUrl = parsedUrl.toString();
    this.connectionHeaders = { ...options.headers };
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.maximumWireEventBytes = options.maximumWireEventBytes;
    this.inputAudioFormat = options.inputAudioFormat ?? PCM16_MONO_24KHZ;
    this.outputAudioFormat = options.outputAudioFormat ?? PCM16_MONO_24KHZ;
    assertPcm16Format(this.inputAudioFormat);
    assertPcm16Format(this.outputAudioFormat);
    assertProviderPcmFormat(options.provider, this.inputAudioFormat, "input");
    assertProviderPcmFormat(options.provider, this.outputAudioFormat, "output");
    this.sessionUpdate = withManualPcmSession(
      options.provider,
      structuredClone(options.sessionUpdate),
      this.inputAudioFormat,
      this.outputAudioFormat,
    );
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? Date.now;
    this.xaiResumptionEnabled = options.provider === "xai"
      && record(record(this.sessionUpdate.session).resumption).enabled === true;
    this.normalizer = new OpenAICompatibleEventNormalizer({
      provider: options.provider,
      outputAudioFormat: this.outputAudioFormat,
      includeProviderEvents: options.includeProviderEvents,
      xaiResumptionEnabled: this.xaiResumptionEnabled,
      now: this.now,
    });
  }

  get state(): RealtimeClientState {
    return this.currentState;
  }

  connect(): Promise<void> {
    if (this.currentState === "ready") return Promise.resolve();
    if (this.currentState === "connecting" && this.connectPromise) return this.connectPromise;
    if (this.currentState !== "idle") {
      return Promise.reject(new Error(`Realtime client cannot connect from ${this.currentState} state`));
    }

    this.currentState = "connecting";
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });

    try {
      const socket = this.socketFactory(this.connectionUrl, { headers: { ...this.connectionHeaders } });
      this.socket = socket;
      socket.on("open", () => this.onSocketOpen());
      socket.on("message", (data) => this.onSocketMessage(data));
      socket.on("error", (error) => this.onSocketError(error));
      socket.on("close", (code, reason) => this.onSocketClose(code, reason));
    } catch (error) {
      this.failConnection(errorMessage(error), "socket_factory_failed");
      return this.connectPromise;
    }

    const timeoutMs = this.connectTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      this.failConnection("connectTimeoutMs must be positive", "invalid_connect_timeout");
      return this.connectPromise;
    }
    this.connectTimer = setTimeout(() => {
      this.failConnection(
        `Realtime session acknowledgement timed out after ${timeoutMs} ms`,
        "session_ack_timeout",
      );
    }, timeoutMs);
    return this.connectPromise;
  }

  onEvent(listener: RealtimeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onWireEvent(listener: RealtimeWireEventListener): () => void {
    this.wireListeners.add(listener);
    return () => this.wireListeners.delete(listener);
  }

  appendInputAudio(audio: Pcm16Audio): void {
    this.assertNoPendingToolBatch();
    const encoded = pcm16ToBase64(audio, this.inputAudioFormat);
    this.sendReady({
      type: "input_audio_buffer.append",
      audio: encoded,
    });
    if (this.provider === "xai") this.meteredInputAudioBytes += audio.data.byteLength;
  }

  commitInputAudio(): void {
    this.assertNoPendingToolBatch();
    this.sendReady({ type: "input_audio_buffer.commit" });
  }

  clearInputAudio(): void {
    this.sendReady({ type: "input_audio_buffer.clear" });
  }

  createResponse(overrides: Record<string, unknown> = {}): void {
    this.assertNoPendingToolBatch();
    this.sendReady({
      type: "response.create",
      ...(Object.keys(overrides).length ? { response: overrides } : {}),
    });
  }

  cancelResponse(): void {
    this.sendReady({ type: "response.cancel" });
  }

  /** Appends exact PCM bytes, explicitly commits the turn, then requests one response. */
  sendTurn(audio: Pcm16Audio | readonly Pcm16Audio[]): void {
    this.assertNoPendingToolBatch();
    const chunks = Array.isArray(audio) ? audio : [audio];
    if (!chunks.length) throw new Error("A realtime turn needs at least one PCM audio chunk");
    // Validate/encode the entire local batch before touching the provider buffer.
    const encoded = chunks.map((chunk) => ({
      audio: pcm16ToBase64(chunk, this.inputAudioFormat),
      bytes: chunk.data.byteLength,
    }));
    for (const chunk of encoded) {
      this.sendReady({ type: "input_audio_buffer.append", audio: chunk.audio });
      if (this.provider === "xai") this.meteredInputAudioBytes += chunk.bytes;
    }
    this.commitInputAudio();
    this.createResponse();
  }

  /** Sends one billable user text item; function outputs do not use this path. */
  sendTextTurn(text: string, createResponse = true): void {
    this.assertNoPendingToolBatch();
    if (!text.trim()) throw new Error("A realtime text turn cannot be empty");
    this.sendReady({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    if (this.provider === "xai") this.meteredBillableTextInputEvents += 1;
    if (createResponse) this.createResponse();
  }

  /**
   * Submits a complete function-call batch before requesting the next model
   * response. This matters for xAI, which can issue multiple calls in one turn.
   */
  submitToolResults(results: readonly RealtimeToolResult[], createResponse = true): void {
    if (!results.length) throw new Error("submitToolResults requires at least one result");
    if (!this.pendingToolBatch) {
      throw new Error("No completed provider tool-call batch is awaiting results");
    }
    const seen = new Set<string>();
    for (const result of results) {
      if (!result.callId) throw new Error("Tool result callId cannot be empty");
      if (seen.has(result.callId)) throw new Error(`Duplicate tool result for ${result.callId}`);
      seen.add(result.callId);
    }
    const missing = [...this.pendingToolBatch].filter((callId) => !seen.has(callId));
    const unknown = [...seen].filter((callId) => !this.pendingToolBatch!.has(callId));
    if (missing.length || unknown.length) {
      throw new Error(
        `Tool result batch mismatch (missing: ${missing.join(", ") || "none"}; `
        + `unknown: ${unknown.join(", ") || "none"})`,
      );
    }
    // Serialization can fail (cycles, BigInt). Do it before sending any part of
    // the batch so a local error cannot leave xAI with a partial result set.
    const serialized = results.map((result) => ({
      callId: result.callId,
      output: serializeToolOutput(result.output),
    }));
    for (const result of serialized) {
      this.sendReady({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: result.callId,
          output: result.output,
        },
      });
    }
    this.pendingToolBatch = null;
    if (createResponse) this.createResponse();
  }

  close(code = 1000, reason = "client closed"): void {
    if (this.currentState === "closed" || this.currentState === "failed") return;
    if (this.currentState === "idle") {
      this.currentState = "closed";
      return;
    }
    this.currentState = "closing";
    this.pendingXaiResumption = null;
    this.pendingToolBatch = null;
    this.clearConnectTimer();
    this.rejectPendingConnect(new Error("Realtime client closed before session acknowledgement"));
    this.emitPendingXaiMeter("client.close");
    try {
      this.socket?.close(code, reason);
    } catch {
      this.currentState = "closed";
    }
  }

  private onSocketOpen(): void {
    if (this.currentState !== "connecting") return;
    try {
      this.sendRaw(this.sessionUpdate);
    } catch (error) {
      this.failConnection(errorMessage(error), "session_update_send_failed");
    }
  }

  private onSocketMessage(data: unknown): void {
    if (this.currentState === "failed" || this.currentState === "closed" || this.currentState === "closing") return;
    const parsed = safeParseWireEvent(data, this.maximumWireEventBytes);
    if (!parsed.ok) {
      this.emit({
        type: "error",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType: "client.parse",
        code: parsed.code,
        message: parsed.message,
        fatal: false,
      });
      return;
    }

    if (parsed.event.type === "session.updated" && this.currentState === "connecting") {
      const acknowledgement = validateManualPcmSessionAcknowledgement(
        this.provider,
        parsed.event,
        this.inputAudioFormat,
        this.outputAudioFormat,
        this.xaiResumptionEnabled,
      );
      if (!acknowledgement.ok) {
        this.notifyWireListeners(parsed.event);
        const message = `Provider session acknowledgement mismatch: ${acknowledgement.mismatches.join("; ")}`;
        this.emit({
          type: "error",
          provider: this.provider,
          receivedAtMs: this.now(),
          wireType: "session.updated",
          code: "session_ack_mismatch",
          message,
          fatal: true,
          details: { mismatches: acknowledgement.mismatches },
        });
        this.failConnection(message, "session_ack_mismatch", false);
        return;
      }
    }

    let normalized: NormalizedRealtimeEvent[];
    try {
      normalized = this.normalizer.normalize(parsed.event);
    } catch (error) {
      normalized = [{
        type: "error",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType: String(parsed.event.type),
        code: "normalization_failed",
        message: errorMessage(error),
        fatal: false,
      }];
    }

    // Normalize before exposing the raw object so an observer cannot mutate the
    // protocol input that drives session state.
    this.notifyWireListeners(parsed.event);

    for (const normalizedEvent of normalized) {
      let event = normalizedEvent;
      if (
        event.type === "session.resumption"
        && event.resumable
        && this.currentState === "connecting"
      ) {
        // xAI can announce the conversation ID before it acknowledges that
        // resumption caching is enabled. Hold the claim until that ack passes.
        this.pendingXaiResumption = event;
        continue;
      }
      if (this.provider === "xai" && event.type === "output.audio") {
        this.meteredOutputAudioBytes += event.audio.byteLength;
      }
      if (this.provider === "xai" && event.type === "usage" && event.scope === "response") {
        event = this.attachXaiMeter(event);
      }
      if (event.type === "tool.calls") {
        if (this.pendingToolBatch?.size) {
          const message = "Provider emitted an overlapping tool-call batch before the prior batch was resolved";
          this.emit({
            type: "error",
            provider: this.provider,
            receivedAtMs: this.now(),
            wireType: event.wireType,
            code: "overlapping_tool_batch",
            message,
            fatal: true,
          });
          this.failConnection(message, "overlapping_tool_batch", false);
          break;
        }
        this.pendingToolBatch = new Set(event.calls.map((call) => call.callId));
      } else if (event.type === "tool.cancelled" && this.pendingToolBatch) {
        for (const callId of event.callIds) this.pendingToolBatch.delete(callId);
        if (this.pendingToolBatch.size === 0) this.pendingToolBatch = null;
      }
      if (event.type === "session.ready" && this.currentState === "connecting") {
        this.currentState = "ready";
        this.clearConnectTimer();
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
      }
      if (event.type === "error" && event.wireType === "error" && this.currentState === "connecting") {
        this.emit({ ...event, fatal: true });
        this.failConnection(event.message, event.code ?? "provider_session_error", false);
      } else {
        this.emit(event);
      }
      if (event.type === "session.ready" && this.pendingXaiResumption) {
        this.emit(this.pendingXaiResumption);
        this.pendingXaiResumption = null;
      }
    }
  }

  private onSocketError(error: unknown): void {
    if (this.currentState === "closing" || this.currentState === "closed") return;
    this.failConnection(errorMessage(error) || "Realtime WebSocket failed", "transport_error");
  }

  private onSocketClose(code?: number, reason?: unknown): void {
    const wasConnecting = this.currentState === "connecting";
    const wasFailed = this.currentState === "failed";
    this.pendingXaiResumption = null;
    this.pendingToolBatch = null;
    if (!wasFailed) this.currentState = "closed";
    this.clearConnectTimer();
    if (wasConnecting) this.rejectPendingConnect(new Error("Realtime WebSocket closed before session acknowledgement"));
    this.emitPendingXaiMeter("socket.close");
    this.emit({
      type: "connection.closed",
      provider: this.provider,
      receivedAtMs: this.now(),
      wireType: "socket.close",
      ...optional("code", code),
      ...optional("reason", closeReason(reason)),
      ...optional("clean", code === undefined ? undefined : code === 1000),
    });
  }

  private failConnection(message: string, code: string, emit = true): void {
    if (this.currentState === "failed" || this.currentState === "closed") return;
    this.currentState = "failed";
    this.pendingXaiResumption = null;
    this.pendingToolBatch = null;
    this.clearConnectTimer();
    this.rejectPendingConnect(new Error(message));
    this.emitPendingXaiMeter("client.failure");
    if (emit) {
      this.emit({
        type: "error",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType: "client.transport",
        code,
        message,
        fatal: true,
      });
    }
    try {
      this.socket?.terminate?.();
    } catch {
      // The state and rejected connect promise already capture the failure.
    }
  }

  private rejectPendingConnect(error: Error): void {
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private sendReady(event: Record<string, unknown>): void {
    if (this.currentState !== "ready") {
      throw new Error(`Realtime session is not ready (state: ${this.currentState})`);
    }
    this.sendRaw(event);
  }

  private assertNoPendingToolBatch(): void {
    if (this.pendingToolBatch?.size) {
      throw new Error(
        `Resolve the complete tool-call batch before continuing: ${[...this.pendingToolBatch].join(", ")}`,
      );
    }
  }

  private sendRaw(event: Record<string, unknown>): void {
    if (!this.socket) throw new Error("Realtime WebSocket is not connected");
    this.socket.send(JSON.stringify(event));
  }

  private emit(event: NormalizedRealtimeEvent): void {
    for (const listener of this.eventListeners) {
      safelyNotify(() => listener(observerSnapshot(event)));
    }
  }

  private notifyWireListeners(event: Record<string, unknown>): void {
    for (const listener of this.wireListeners) {
      safelyNotify(() => listener(observerSnapshot(event)));
    }
  }

  private attachXaiMeter(event: Extract<NormalizedRealtimeEvent, { type: "usage" }>): NormalizedRealtimeEvent {
    const measured = this.takeXaiMeter();
    const providerReported = Object.keys(event.usage.raw).length > 0;
    return {
      ...event,
      usage: {
        ...event.usage,
        inputAudioMinutes: event.usage.inputAudioMinutes ?? measured.inputAudioMinutes,
        outputAudioMinutes: event.usage.outputAudioMinutes ?? measured.outputAudioMinutes,
        billableTextInputEvents:
          event.usage.billableTextInputEvents ?? measured.billableTextInputEvents,
        meteringSource: providerReported ? "mixed" : "client_measured",
      },
    };
  }

  private emitPendingXaiMeter(wireType: string): void {
    if (
      this.provider !== "xai"
      || (this.meteredInputAudioBytes === 0
        && this.meteredOutputAudioBytes === 0
        && this.meteredBillableTextInputEvents === 0)
    ) return;
    const usage = this.takeXaiMeter();
    this.emit({
      type: "usage",
      provider: "xai",
      receivedAtMs: this.now(),
      wireType,
      scope: "session",
      usage: { ...usage, meteringSource: "client_measured", raw: {} },
    });
  }

  private takeXaiMeter() {
    const usage = {
      inputAudioMinutes: bytesToPcmMinutes(this.meteredInputAudioBytes, this.inputAudioFormat.sampleRateHz),
      outputAudioMinutes: bytesToPcmMinutes(this.meteredOutputAudioBytes, this.outputAudioFormat.sampleRateHz),
      billableTextInputEvents: this.meteredBillableTextInputEvents,
    };
    this.meteredInputAudioBytes = 0;
    this.meteredOutputAudioBytes = 0;
    this.meteredBillableTextInputEvents = 0;
    return usage;
  }
}

export function createOpenAIRealtimeClient(
  options: HostedOpenAICompatibleClientOptions,
): OpenAICompatibleRealtimeClient {
  requireCredential(options.apiKey, "OpenAI");
  const { apiKey, model, headers, ...clientOptions } = options;
  return new OpenAICompatibleRealtimeClient({
    ...clientOptions,
    provider: "openai",
    url: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    headers: { ...headers, Authorization: `Bearer ${apiKey}` },
  });
}

export function createXaiRealtimeClient(
  options: HostedXaiRealtimeClientOptions,
): OpenAICompatibleRealtimeClient {
  requireCredential(options.apiKey, "xAI");
  const {
    apiKey,
    model,
    headers,
    conversationId,
    enableResumption,
    sessionUpdate,
    ...clientOptions
  } = options;
  if (conversationId !== undefined && !conversationId.trim()) {
    throw new Error("xAI conversationId cannot be empty");
  }
  const url = new URL("wss://api.x.ai/v1/realtime");
  url.searchParams.set("model", model);
  if (conversationId) url.searchParams.set("conversation_id", conversationId);
  return new OpenAICompatibleRealtimeClient({
    ...clientOptions,
    provider: "xai",
    url: url.toString(),
    headers: { ...headers, Authorization: `Bearer ${apiKey}` },
    sessionUpdate: enableResumption || conversationId
      ? enableXaiResumption(sessionUpdate)
      : sessionUpdate,
  });
}

/** Clones and pins the provider payload to PCM with explicit client commits. */
export function withManualPcmSession(
  provider: OpenAICompatibleProvider,
  update: Record<string, unknown>,
  input: Pcm16Format = PCM16_MONO_24KHZ,
  output: Pcm16Format = PCM16_MONO_24KHZ,
): Record<string, unknown> {
  assertPcm16Format(input);
  assertPcm16Format(output);
  assertProviderPcmFormat(provider, input, "input");
  assertProviderPcmFormat(provider, output, "output");
  const sourceSession = record(update.session);
  const sourceAudio = record(sourceSession.audio);
  const sourceInput = record(sourceAudio.input);
  const sourceOutput = record(sourceAudio.output);
  const inputWithoutDetection = { ...sourceInput };
  const sessionWithoutDetection = { ...sourceSession };
  delete inputWithoutDetection.turn_detection;
  delete sessionWithoutDetection.turn_detection;
  const audio = {
    ...sourceAudio,
    input: {
      ...inputWithoutDetection,
      format: { type: "audio/pcm", rate: input.sampleRateHz },
      ...(provider === "openai" ? { turn_detection: null } : {}),
    },
    output: {
      ...sourceOutput,
      format: { type: "audio/pcm", rate: output.sampleRateHz },
    },
  };
  return {
    ...update,
    type: "session.update",
    session: {
      ...sessionWithoutDetection,
      audio,
      ...(provider === "xai" ? { turn_detection: null } : {}),
    },
  };
}

export type ManualPcmAcknowledgement =
  | { ok: true }
  | { ok: false; mismatches: string[] };

/** Verifies the provider echoed the exact transport invariants the benchmark requested. */
export function validateManualPcmSessionAcknowledgement(
  provider: OpenAICompatibleProvider,
  event: Record<string, unknown>,
  input: Pcm16Format = PCM16_MONO_24KHZ,
  output: Pcm16Format = PCM16_MONO_24KHZ,
  expectXaiResumption = false,
): ManualPcmAcknowledgement {
  assertPcm16Format(input);
  assertPcm16Format(output);
  assertProviderPcmFormat(provider, input, "input");
  assertProviderPcmFormat(provider, output, "output");
  const mismatches: string[] = [];
  if (event.type !== "session.updated") mismatches.push("event type is not session.updated");
  const session = record(event.session);
  const audio = record(session.audio);
  const acknowledgedInput = record(audio.input);
  const acknowledgedOutput = record(audio.output);
  validateAcknowledgedFormat("input", record(acknowledgedInput.format), input, mismatches);
  validateAcknowledgedFormat("output", record(acknowledgedOutput.format), output, mismatches);

  if (provider === "openai") {
    if (acknowledgedInput.turn_detection !== null) {
      mismatches.push("OpenAI audio.input.turn_detection is not null");
    }
    if (session.turn_detection !== undefined && session.turn_detection !== null) {
      mismatches.push("OpenAI returned an active session-level turn detector");
    }
  } else {
    if (session.turn_detection !== null) mismatches.push("xAI session.turn_detection is not null");
    if (acknowledgedInput.turn_detection !== undefined && acknowledgedInput.turn_detection !== null) {
      mismatches.push("xAI returned an active audio.input turn detector");
    }
    if (expectXaiResumption && record(session.resumption).enabled !== true) {
      mismatches.push("xAI resumption.enabled was not acknowledged");
    }
  }
  return mismatches.length ? { ok: false, mismatches } : { ok: true };
}

function validateAcknowledgedFormat(
  label: "input" | "output",
  actual: Record<string, unknown>,
  expected: Pcm16Format,
  mismatches: string[],
): void {
  if (actual.type !== "audio/pcm") mismatches.push(`${label} format is not audio/pcm`);
  if (actual.rate !== expected.sampleRateHz) {
    mismatches.push(`${label} rate is ${String(actual.rate)}, expected ${expected.sampleRateHz}`);
  }
}

function enableXaiResumption(update: Record<string, unknown>): Record<string, unknown> {
  const session = record(update.session);
  return {
    ...update,
    session: {
      ...session,
      resumption: { ...record(session.resumption), enabled: true },
    },
  };
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  const serialized = JSON.stringify(output);
  return serialized === undefined ? "null" : serialized;
}

function requireCredential(value: string, provider: string): void {
  if (!value.trim()) throw new Error(`${provider} API key is required`);
}

const XAI_PCM_RATES = new Set([8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000]);

function assertProviderPcmFormat(
  provider: OpenAICompatibleProvider,
  format: Pcm16Format,
  direction: "input" | "output",
): void {
  const supported = provider === "openai" ? format.sampleRateHz === 24_000 : XAI_PCM_RATES.has(format.sampleRateHz);
  if (!supported) {
    throw new Error(`${provider} does not support ${format.sampleRateHz} Hz PCM ${direction} audio`);
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function bytesToPcmMinutes(bytes: number, sampleRateHz: number): number {
  return bytes / 2 / sampleRateHz / 60;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function closeReason(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason || undefined;
  if (ArrayBuffer.isView(reason)) {
    return Buffer.from(reason.buffer, reason.byteOffset, reason.byteLength).toString("utf8") || undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safelyNotify(notify: () => void): void {
  try {
    notify();
  } catch {
    // A benchmark observer must not be able to corrupt the protocol state machine.
  }
}

function observerSnapshot<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function optional<Key extends string, Value>(key: Key, value: Value | undefined): Partial<Record<Key, Value>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, Value>;
}
