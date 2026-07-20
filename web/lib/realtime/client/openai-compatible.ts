import WebSocket from "ws";
import { createHash } from "node:crypto";
import { PCM16_MONO_24KHZ, assertPcm16Format, base64ToPcm16, pcm16ToBase64 } from "./audio";
import {
  OpenAICompatibleEventNormalizer,
  normalizeOpenAICompatibleUsage,
  safeParseWireEvent,
} from "./events";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationReference,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "./wire-evidence";
import type { RealtimeWireIdentityKind } from "./wire-evidence";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
  experimentalProviderDirectMcpEnabled,
  isLocalToolProxyFunction,
} from "./types";
import type {
  LocalToolProxyDispatch,
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  Pcm16Audio,
  Pcm16Format,
  RealtimeClientState,
  RealtimeEventListener,
  RealtimeOutputAudioTruncation,
  RealtimeResponseCancelTarget,
  RealtimeToolCall,
  RealtimeToolResult,
  RealtimeWebSocket,
  RealtimeWebSocketFactory,
  RealtimeWireEventListener,
  RealtimeWireObservation,
  RealtimeWireObservationListener,
  SessionConfigurationAcknowledgement,
  SessionConfigurationField,
  SessionConfigurationFieldProof,
  ProviderToolCallProvenance,
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
  /** Total unique provider identities retained without unsafe eviction. */
  maximumTrackedIdentities?: number;
  /** Paid benchmarks can require complete provider-echo parity before readiness. */
  requireStrictSessionConfigurationParity?: boolean;
  /** Both grants are required before provider-hosted MCP may leave the local authority boundary. */
  experimentalProviderDirectMcp?: Readonly<{
    enabled?: boolean;
    allowConsequential?: boolean;
  }>;
  /** Test-only escape hatch; authenticated plaintext is restricted to loopback. */
  allowInsecureLocalhostForTests?: boolean;
  now?: () => number;
  monotonicNow?: () => number;
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
const CLIENT_GENERATED_WIRE_ATTRIBUTION = Object.freeze({
  availability: "unavailable" as const,
  reason: "client_generated" as const,
});
const TRANSPORT_GENERATED_WIRE_ATTRIBUTION = Object.freeze({
  availability: "unavailable" as const,
  reason: "transport_generated" as const,
});

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
  private readonly wireObservationListeners = new Set<RealtimeWireObservationListener>();
  private readonly socketFactory: RealtimeWebSocketFactory;
  private readonly connectionUrl: string;
  private readonly connectionHeaders: Record<string, string>;
  private readonly inputAudioFormat: Pcm16Format;
  private readonly outputAudioFormat: Pcm16Format;
  private readonly sessionUpdate: Record<string, unknown>;
  private readonly normalizer: OpenAICompatibleEventNormalizer;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly connectTimeoutMs: number;
  private readonly maximumWireEventBytes?: number;
  private readonly xaiResumptionEnabled: boolean;
  private readonly maximumTrackedIdentities: number;
  private readonly requireStrictSessionConfigurationParity: boolean;
  private readonly requestedModel?: string;
  private readonly localToolProxyEnabled: boolean;
  private providerCreatedModel?: string;
  private providerSessionId?: string;
  private readonly providerToolCallIds = new Set<string>();
  private readonly providerWireToolCalls = new Map<string, ProviderWireToolCallIdentity>();
  private readonly providerCallByItemId = new Map<string, string>();
  private readonly cancellationSeals = new Set<string>();
  private meteredInputAudioBytes = 0;
  private meteredOutputAudioBytes = 0;
  private meteredBillableTextInputEvents = 0;
  private pendingXaiResumption: Extract<NormalizedRealtimeEvent, { type: "session.resumption" }> | null = null;
  private pendingToolBatch: Set<string> | null = null;
  private submittingToolResults = false;
  private connectionEpoch = 0;
  private wireSequence = 0;
  private wireObservationChainHead: string | null = null;
  private lastSessionConfigurationAcknowledgement: SessionConfigurationAcknowledgement | null = null;

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
    let detachedSessionUpdate: unknown;
    try {
      detachedSessionUpdate = structuredClone(options.sessionUpdate);
    } catch {
      throw new Error("Realtime session.update payload must be structured-cloneable");
    }
    if (
      !isRecord(detachedSessionUpdate)
      || detachedSessionUpdate.type !== "session.update"
      || !isRecord(detachedSessionUpdate.session)
    ) {
      throw new Error("Realtime client requires a session.update payload");
    }
    const sessionUpdateSnapshot = detachedSessionUpdate;
    const queryModels = parsedUrl.searchParams.getAll("model");
    if (queryModels.length > 1) throw new Error("Realtime client URL cannot select more than one model");
    const queryModel = queryModels[0];
    if (queryModel !== undefined) assertOpaqueIdentity(queryModel, "model", 256);
    const rawSessionModel = record(sessionUpdateSnapshot.session).model;
    if (rawSessionModel !== undefined && typeof rawSessionModel !== "string") {
      throw new Error("Realtime session model must be a string");
    }
    const sessionModel = stringValue(rawSessionModel);
    if (sessionModel !== undefined) assertOpaqueIdentity(sessionModel, "session model", 256);
    if (queryModel !== undefined && sessionModel !== undefined && queryModel !== sessionModel) {
      throw new Error(`Realtime model identity conflict between URL (${queryModel}) and session (${sessionModel})`);
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
    if (
      options.maximumTrackedIdentities !== undefined
      && (!Number.isInteger(options.maximumTrackedIdentities) || options.maximumTrackedIdentities < 1)
    ) {
      throw new Error("maximumTrackedIdentities must be a positive integer");
    }
    this.provider = options.provider;
    this.connectionUrl = parsedUrl.toString();
    this.connectionHeaders = { ...options.headers };
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.maximumWireEventBytes = options.maximumWireEventBytes;
    this.maximumTrackedIdentities = options.maximumTrackedIdentities ?? MAX_PROVIDER_TOOL_CALL_IDS;
    this.requireStrictSessionConfigurationParity = options.requireStrictSessionConfigurationParity === true;
    this.requestedModel = queryModel ?? sessionModel;
    const configuredTools = Array.isArray(record(sessionUpdateSnapshot.session).tools)
      ? record(sessionUpdateSnapshot.session).tools as unknown[]
      : [];
    assertProviderDirectMcpGate(configuredTools, options.experimentalProviderDirectMcp);
    const namedLocalProxyTools = configuredTools.filter((tool) => (
      isRecord(tool)
      && tool.type === "function"
      && tool.name === LOCAL_TOOL_PROXY_FUNCTION_NAME
    ));
    if (namedLocalProxyTools.length > 1) {
      throw new Error("Realtime session cannot declare the local capability gateway more than once");
    }
    if (namedLocalProxyTools.length === 1 && !isLocalToolProxyFunction(namedLocalProxyTools[0])) {
      throw new Error("Realtime session must declare the exact local capability gateway contract");
    }
    this.localToolProxyEnabled = namedLocalProxyTools.length === 1;
    if (
      this.localToolProxyEnabled
      && configuredTools.some((tool) => record(tool).type === "function" && !isLocalToolProxyFunction(tool))
    ) {
      throw new Error("Local capability gateway mode cannot expose additional provider-native functions");
    }
    this.inputAudioFormat = options.inputAudioFormat ?? PCM16_MONO_24KHZ;
    this.outputAudioFormat = options.outputAudioFormat ?? PCM16_MONO_24KHZ;
    assertPcm16Format(this.inputAudioFormat);
    assertPcm16Format(this.outputAudioFormat);
    assertProviderPcmFormat(options.provider, this.inputAudioFormat, "input");
    assertProviderPcmFormat(options.provider, this.outputAudioFormat, "output");
    this.sessionUpdate = withManualPcmSession(
      options.provider,
      sessionUpdateSnapshot,
      this.inputAudioFormat,
      this.outputAudioFormat,
    );
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    if (!Number.isFinite(this.now()) || !Number.isFinite(this.monotonicNow())) {
      throw new Error("Realtime client clocks must return finite numbers");
    }
    this.xaiResumptionEnabled = options.provider === "xai"
      && record(record(this.sessionUpdate.session).resumption).enabled === true;
    this.normalizer = new OpenAICompatibleEventNormalizer({
      provider: options.provider,
      outputAudioFormat: this.outputAudioFormat,
      includeProviderEvents: options.includeProviderEvents,
      xaiResumptionEnabled: this.xaiResumptionEnabled,
      maximumTrackedIdentities: this.maximumTrackedIdentities,
      now: this.now,
    });
  }

  get state(): RealtimeClientState {
    return this.currentState;
  }

  get sessionConfigurationAcknowledgement(): SessionConfigurationAcknowledgement | null {
    return this.lastSessionConfigurationAcknowledgement === null
      ? null
      : observerSnapshot(this.lastSessionConfigurationAcknowledgement);
  }

  connect(): Promise<void> {
    if (this.currentState === "ready") return Promise.resolve();
    if (this.currentState === "connecting" && this.connectPromise) return this.connectPromise;
    if (this.currentState !== "idle") {
      return Promise.reject(new Error(`Realtime client cannot connect from ${this.currentState} state`));
    }

    this.currentState = "connecting";
    this.connectionEpoch += 1;
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

  onWireObservation(listener: RealtimeWireObservationListener): () => void {
    this.wireObservationListeners.add(listener);
    return () => this.wireObservationListeners.delete(listener);
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

  cancelResponse(target: RealtimeResponseCancelTarget): void {
    assertTargetIdentity(target?.responseId, "responseId");
    if (this.cancellationSeals.has(target.responseId)) return;
    if (this.cancellationSeals.size >= this.maximumTrackedIdentities) {
      throw new Error(`Realtime cancellation identity ledger exceeded ${this.maximumTrackedIdentities} entries`);
    }
    this.sendReady({ type: "response.cancel", response_id: target.responseId });
    this.cancellationSeals.add(target.responseId);
  }

  truncateOutputAudio(target: RealtimeOutputAudioTruncation): void {
    assertTargetIdentity(target?.responseId, "responseId");
    assertTargetIdentity(target?.itemId, "itemId");
    if (!this.cancellationSeals.has(target.responseId)) {
      throw new Error(`Cancel response ${target.responseId} before truncating its unheard audio`);
    }
    if (target.contentIndex !== 0) {
      throw new Error("Realtime audio truncation contentIndex must be 0");
    }
    if (!Number.isSafeInteger(target.audioEndMs) || target.audioEndMs < 0) {
      throw new Error("Realtime audio truncation audioEndMs must be a non-negative safe integer");
    }
    this.sendReady({
      type: "conversation.item.truncate",
      item_id: target.itemId,
      content_index: 0,
      audio_end_ms: target.audioEndMs,
    });
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
    if (this.submittingToolResults) throw new Error("Tool result submission cannot be re-entered");
    this.submittingToolResults = true;
    try {
      const pending = this.pendingToolBatch;
      if (!pending) throw new Error("No completed provider tool-call batch is awaiting results");
      const serialized = snapshotToolResultBatch(results);
      if (!serialized.length) throw new Error("submitToolResults requires at least one result");
      const seen = new Set<string>();
      for (const result of serialized) {
        const callIdError = providerCallIdError(result.callId);
        if (callIdError) throw new Error(`Invalid tool result callId: ${callIdError}`);
        if (seen.has(result.callId)) throw new Error(`Duplicate tool result for ${result.callId}`);
        seen.add(result.callId);
      }
      const missing = [...pending].filter((callId) => !seen.has(callId));
      const unknown = [...seen].filter((callId) => !pending.has(callId));
      if (missing.length || unknown.length) {
        throw new Error(
          `Tool result batch mismatch (missing: ${missing.join(", ") || "none"}; `
          + `unknown: ${unknown.join(", ") || "none"})`,
        );
      }
      if (this.pendingToolBatch !== pending || this.currentState !== "ready") {
        throw new Error("Tool result batch authority changed during canonicalization");
      }
      try {
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
        if (createResponse) this.sendReady({ type: "response.create" });
      } catch (error) {
        const message = `Tool result batch delivery became indeterminate: ${errorMessage(error)}`;
        this.failConnection(message, "tool_result_batch_send_failed");
        throw new Error(message);
      }
    } finally {
      this.submittingToolResults = false;
    }
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
    const exactSerialized = wireFrameText(data);
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
        wireObservation: CLIENT_GENERATED_WIRE_ATTRIBUTION,
      });
      return;
    }

    if (
      this.currentState === "connecting"
      && !isPreReadinessControlEvent(String(parsed.event.type), this.provider)
    ) {
      // Provider application events are not trustworthy until the exact
      // session.update acknowledgement has passed the transport and
      // configuration checks below. Reject instead of buffering: buffering
      // output/tool work would make an acknowledgement retroactively bless
      // bytes that arrived under an unknown configuration.
      const wireType = String(parsed.event.type);
      const message = `Provider emitted ${wireType} before session configuration was acknowledged`;
      const wireObservation = this.notifyWireListeners(parsed.event, exactSerialized);
      this.emit({
        type: "error",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType,
        code: "pre_ready_application_event",
        message,
        fatal: true,
        ...optional(
          "wireObservation",
          wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
        ),
      });
      this.failConnection(message, "pre_ready_application_event", false);
      return;
    }

    const wireIdentityError = providerRedundantIdentityError(parsed.event)
      ?? this.admitProviderWireToolCallIdentities(parsed.event);
    if (wireIdentityError) {
      const wireObservation = this.notifyWireListeners(parsed.event, exactSerialized);
      this.emit({
        type: "error",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType: String(parsed.event.type),
        code: "invalid_provider_tool_call_identity",
        message: wireIdentityError,
        fatal: true,
        ...optional(
          "wireObservation",
          wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
        ),
      });
      this.failConnection(wireIdentityError, "invalid_provider_tool_call_identity", false);
      return;
    }

    let updatedModel: string | undefined;
    if (parsed.event.type === "session.created" || parsed.event.type === "session.updated") {
      try {
        const providerSessionId = acknowledgedSessionId(parsed.event);
        if (
          providerSessionId !== undefined
          && this.providerSessionId !== undefined
          && providerSessionId !== this.providerSessionId
        ) {
          throw new Error("Provider changed session identity during one realtime connection");
        }
        const providerModel = acknowledgedSessionModel(parsed.event);
        if (providerModel !== undefined && this.requestedModel !== undefined && providerModel !== this.requestedModel) {
          throw new Error(
            `Provider ${parsed.event.type} model (${providerModel}) differs from requested model (${this.requestedModel})`,
          );
        }
        if (
          providerModel !== undefined
          && this.providerCreatedModel !== undefined
          && providerModel !== this.providerCreatedModel
        ) {
          throw new Error(
            `Provider changed model identity from ${this.providerCreatedModel} to ${providerModel}`,
          );
        }
        if (parsed.event.type === "session.created" && providerModel !== undefined) {
          this.providerCreatedModel = providerModel;
        }
        else updatedModel = providerModel;
        this.providerSessionId ??= providerSessionId;
      } catch (error) {
        const message = errorMessage(error);
        const wireObservation = this.notifyWireListeners(parsed.event, exactSerialized);
        this.emit({
          type: "error",
          provider: this.provider,
          receivedAtMs: this.now(),
          wireType: String(parsed.event.type),
          code: "invalid_provider_session_identity",
          message,
          fatal: true,
          ...optional(
            "wireObservation",
            wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
          ),
        });
        this.failConnection(message, "invalid_provider_session_identity", false);
        return;
      }
    }

    let configurationAcknowledgement: SessionConfigurationAcknowledgement | undefined;
    const wasReadyBeforeAcknowledgement = this.currentState === "ready";
    if (
      parsed.event.type === "session.updated"
      && (this.currentState === "connecting" || this.currentState === "ready")
    ) {
      const acknowledgement = validateManualPcmSessionAcknowledgement(
        this.provider,
        parsed.event,
        this.inputAudioFormat,
        this.outputAudioFormat,
        this.xaiResumptionEnabled,
      );
      configurationAcknowledgement = buildSessionConfigurationAcknowledgement({
        provider: this.provider,
        requestedUpdate: this.sessionUpdate,
        acknowledgedEvent: parsed.event,
        requestedModel: this.requestedModel,
        acknowledgedModel: updatedModel !== undefined
          ? { value: updatedModel, wireType: "session.updated" }
          : this.providerCreatedModel !== undefined
            ? { value: this.providerCreatedModel, wireType: "session.created" }
            : undefined,
      });
      this.lastSessionConfigurationAcknowledgement = observerSnapshot(configurationAcknowledgement);
      const identityMismatches = Object.entries(configurationAcknowledgement.fields)
        .filter(([, proof]) => proof.status === "mismatch")
        .map(([field]) => `${field} differs from the requested value`);
      if (configurationAcknowledgement.session?.status === "mismatch") {
        identityMismatches.push("session differs from the requested value");
      }
      const mismatches = acknowledgement.ok
        ? identityMismatches
        : [...acknowledgement.mismatches, ...identityMismatches];
      mismatches.push(...unexpectedProviderCapabilityWidening(this.sessionUpdate, parsed.event));
      if (mismatches.length) {
        const wireObservation = this.notifyWireListeners(parsed.event, exactSerialized);
        const message = `Provider session acknowledgement mismatch: ${mismatches.join("; ")}`;
        this.emit({
          type: "error",
          provider: this.provider,
          receivedAtMs: this.now(),
          wireType: "session.updated",
          code: "session_ack_mismatch",
          message,
          fatal: true,
          details: { mismatches, configuration: configurationAcknowledgement },
          ...optional(
            "wireObservation",
            wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
          ),
        });
        this.failConnection(message, "session_ack_mismatch", false);
        return;
      }
      if (
        this.requireStrictSessionConfigurationParity
        && !configurationAcknowledgement.paidBenchmarkReady
      ) {
        const wireObservation = this.notifyWireListeners(parsed.event, exactSerialized);
        const message = "Provider session acknowledgement did not prove strict configuration parity";
        this.emit({
          type: "error",
          provider: this.provider,
          receivedAtMs: this.now(),
          wireType: "session.updated",
          code: "session_ack_strict_parity_unverified",
          message,
          fatal: true,
          details: { configuration: configurationAcknowledgement },
          ...optional(
            "wireObservation",
            wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
          ),
        });
        this.failConnection(message, "session_ack_strict_parity_unverified", false);
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
    const wireObservation = this.notifyWireListeners(parsed.event, exactSerialized);

    for (const normalizedEvent of normalized) {
      let event = withWireObservation(normalizedEvent, wireObservation);
      if (event.type === "session.ready" && configurationAcknowledgement) {
        event = { ...event, configuration: configurationAcknowledgement };
      }
      if (
        event.type === "session.ready"
        && wasReadyBeforeAcknowledgement
        && configurationAcknowledgement
      ) {
        // A later session.updated is a revalidation event, never a second
        // readiness transition. This keeps the requested configuration frozen
        // for the socket lifetime while retaining auditable parity evidence.
        this.emit({
          type: "provider.event",
          provider: this.provider,
          receivedAtMs: event.receivedAtMs,
          wireType: event.wireType,
          ...optional("nativeEventId", event.nativeEventId),
          ...optional("wireObservation", event.wireObservation),
          data: {
            name: "session.configuration_reverified",
            configuration: configurationAcknowledgement,
          },
        });
        continue;
      }
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
      const eventResponseId = normalizedEventResponseId(event);
      if (eventResponseId && this.cancellationSeals.has(eventResponseId)) {
        if (event.type === "output.audio" || event.type === "output.transcript") {
          // Provider frames already in flight after a targeted cancel must not
          // reach playback or transcript consumers.
          continue;
        }
        if (event.type === "tool.calls") {
          const message = `Provider made cancelled response ${eventResponseId} executable`;
          this.emit({
            type: "error",
            provider: this.provider,
            receivedAtMs: this.now(),
            wireType: event.wireType,
            code: "cancelled_response_became_executable",
            message,
            fatal: true,
            ...optional("wireObservation", event.wireObservation),
          });
          this.failConnection(message, "cancelled_response_became_executable", false);
          break;
        }
        if (event.type === "response.completed" && event.status !== "cancelled") {
          const message = `Provider ended cancelled response ${eventResponseId} with status ${event.status}`;
          this.emit({
            type: "error",
            provider: this.provider,
            receivedAtMs: this.now(),
            wireType: event.wireType,
            code: "cancelled_response_terminal_conflict",
            message,
            fatal: true,
            ...optional("wireObservation", event.wireObservation),
          });
          this.failConnection(message, "cancelled_response_terminal_conflict", false);
          break;
        }
      }
      if (event.type === "tool.calls") {
        const admissionError = this.admitProviderToolCalls(event.calls);
        if (admissionError) {
          this.emit({
            type: "error",
            provider: this.provider,
            receivedAtMs: this.now(),
            wireType: event.wireType,
            code: "invalid_provider_tool_call_identity",
            message: admissionError,
            fatal: true,
            ...optional("wireObservation", event.wireObservation),
          });
          this.failConnection(admissionError, "invalid_provider_tool_call_identity", false);
          break;
        }
        const localDispatch = this.localToolProxyEnabled
          ? buildLocalToolProxyDispatchEvent(event, this.provider)
          : undefined;
        if (localDispatch && !localDispatch.ok) {
          this.emit({
            type: "error",
            provider: this.provider,
            receivedAtMs: this.now(),
            wireType: event.wireType,
            code: "invalid_local_tool_proxy_call",
            message: localDispatch.message,
            fatal: true,
            ...optional("wireObservation", event.wireObservation),
          });
          this.failConnection(localDispatch.message, "invalid_local_tool_proxy_call", false);
          break;
        }
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
            ...optional("wireObservation", event.wireObservation),
          });
          this.failConnection(message, "overlapping_tool_batch", false);
          break;
        }
        this.pendingToolBatch = new Set(event.calls.map((call) => call.callId));
        if (localDispatch?.ok) {
          // Local proxy mode has one authoritative dispatch surface. Emitting
          // both this event and the raw provider call batch would let two
          // listeners execute the same consequential request.
          this.emit(localDispatch.event);
          continue;
        }
      } else if (event.type === "tool.cancelled") {
        const invalidCallId = event.callIds.find((callId) => providerCallIdError(callId));
        if (invalidCallId !== undefined) {
          const message = `Provider cancelled a malformed tool call id: ${providerCallIdError(invalidCallId)}`;
          this.emit({
            type: "error",
            provider: this.provider,
            receivedAtMs: this.now(),
            wireType: event.wireType,
            code: "invalid_provider_tool_call_identity",
            message,
            fatal: true,
            ...optional("wireObservation", event.wireObservation),
          });
          this.failConnection(message, "invalid_provider_tool_call_identity", false);
          break;
        }
        if (this.pendingToolBatch) {
          for (const callId of event.callIds) this.pendingToolBatch.delete(callId);
          if (this.pendingToolBatch.size === 0) this.pendingToolBatch = null;
        }
      }
      if (event.type === "session.ready" && this.currentState === "connecting") {
        this.currentState = "ready";
        this.clearConnectTimer();
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
      }
      if (
        event.type === "error"
        && (event.fatal || (event.wireType === "error" && this.currentState === "connecting"))
      ) {
        this.emit({ ...event, fatal: true });
        this.failConnection(event.message, event.code ?? "provider_protocol_error", false);
        break;
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
      wireObservation: TRANSPORT_GENERATED_WIRE_ATTRIBUTION,
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
        wireObservation: TRANSPORT_GENERATED_WIRE_ATTRIBUTION,
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

  /**
   * The normalizer is intentionally not the final trust boundary. A provider ID
   * is admitted once per socket lifetime, and only after the complete batch has
   * passed canonical-shape and duplicate checks.
   */
  private admitProviderToolCalls(calls: readonly RealtimeToolCall[]): string | undefined {
    if (calls.length === 0) return "Provider emitted an empty executable tool-call batch";
    if (this.providerToolCallIds.size + calls.length > this.maximumTrackedIdentities) {
      return `Provider tool-call identity ledger exceeded ${this.maximumTrackedIdentities} entries`;
    }
    const batchIds = new Set<string>();
    for (const call of calls) {
      const invalid = providerCallIdError(call.callId);
      if (invalid) return `Malformed provider tool call id: ${invalid}`;
      if (batchIds.has(call.callId)) return `Provider repeated tool call id ${call.callId} inside one batch`;
      if (this.providerToolCallIds.has(call.callId)) {
        return `Provider reused tool call id ${call.callId} after it was already admitted`;
      }
      batchIds.add(call.callId);
    }
    for (const callId of batchIds) this.providerToolCallIds.add(callId);
    return undefined;
  }

  /** Validates call identity on raw lifecycle events before normalization can coalesce them. */
  private admitProviderWireToolCallIdentities(event: Record<string, unknown>): string | undefined {
    const occurrences = providerWireToolCallOccurrences(event);
    const seenInEvent = new Set<string>();
    const staged = new Map<string, ProviderWireToolCallIdentity>();
    const stagedItemOwners = new Map<string, string>();
    for (const occurrence of occurrences) {
      const invalid = providerCallIdError(occurrence.callId);
      if (invalid) return `Malformed provider tool call id: ${invalid}`;
      if (occurrence.responseId !== undefined) {
        const invalidResponseId = providerCallIdError(occurrence.responseId);
        if (invalidResponseId) return `Malformed provider response id: ${invalidResponseId}`;
      }
      if (occurrence.itemId !== undefined) {
        const invalidItemId = providerCallIdError(occurrence.itemId);
        if (invalidItemId) return `Malformed provider item id: ${invalidItemId}`;
      }
      if (
        occurrence.name !== undefined
        && (!occurrence.name || occurrence.name.length > 256 || /[\u0000-\u001f\u007f]/.test(occurrence.name))
      ) {
        return "Malformed provider tool name";
      }
      const callId = occurrence.callId as string;
      if (seenInEvent.has(callId)) {
        return `Provider repeated tool call id ${callId} inside ${String(event.type)}`;
      }
      seenInEvent.add(callId);
      if (occurrence.itemId !== undefined) {
        const priorItemOwner = stagedItemOwners.get(occurrence.itemId)
          ?? this.providerCallByItemId.get(occurrence.itemId);
        if (priorItemOwner !== undefined && priorItemOwner !== callId) {
          return `Provider reused item id ${occurrence.itemId} across tool calls ${priorItemOwner} and ${callId}`;
        }
        stagedItemOwners.set(occurrence.itemId, callId);
      }
      const prior = staged.get(callId) ?? this.providerWireToolCalls.get(callId);
      const next = prior ? cloneProviderWireToolCallIdentity(prior) : {
        responseId: undefined,
        itemId: undefined,
        name: undefined,
        terminalFingerprints: new Map<string, string>(),
      };
      const conflict = identityConflict("response", next.responseId, occurrence.responseId)
        ?? identityConflict("item", next.itemId, occurrence.itemId)
        ?? identityConflict("tool name", next.name, occurrence.name);
      if (conflict) return `Provider reused tool call id ${callId} with a different ${conflict}`;
      if (occurrence.terminalWireType && occurrence.terminalFingerprint) {
        const terminalFingerprint = next.terminalFingerprints.get(occurrence.terminalWireType);
        if (terminalFingerprint !== undefined && terminalFingerprint !== occurrence.terminalFingerprint) {
          return `Provider rewrote terminal ${occurrence.terminalWireType} for tool call ${callId}`;
        }
        next.terminalFingerprints.set(occurrence.terminalWireType, occurrence.terminalFingerprint);
      }
      next.responseId ??= occurrence.responseId;
      next.itemId ??= occurrence.itemId;
      next.name ??= occurrence.name;
      staged.set(callId, next);
    }
    const newIdentities = [...staged].filter(([callId]) => !this.providerWireToolCalls.has(callId)).length;
    if (this.providerWireToolCalls.size + newIdentities > this.maximumTrackedIdentities) {
      return `Provider tool-call identity ledger exceeded ${this.maximumTrackedIdentities} entries`;
    }
    for (const [callId, identity] of staged) this.providerWireToolCalls.set(callId, identity);
    for (const [itemId, callId] of stagedItemOwners) this.providerCallByItemId.set(itemId, callId);
    return undefined;
  }

  private sendRaw(event: Record<string, unknown>): void {
    if (!this.socket) throw new Error("Realtime WebSocket is not connected");
    const serialized = JSON.stringify(event);
    this.socket.send(serialized);
    this.notifyWireObservation("outbound", event, serialized);
  }

  private emit(event: NormalizedRealtimeEvent): void {
    for (const listener of this.eventListeners) {
      safelyNotify(() => listener(observerSnapshot(event)));
    }
  }

  private notifyWireListeners(
    event: Record<string, unknown>,
    exactSerialized?: string,
  ): RealtimeWireObservation | undefined {
    for (const listener of this.wireListeners) {
      safelyNotify(() => listener(observerSnapshot(event)));
    }
    return this.notifyWireObservation("inbound", event, exactSerialized);
  }

  private notifyWireObservation(
    direction: "inbound" | "outbound",
    event: Record<string, unknown>,
    exactSerialized?: string,
  ): RealtimeWireObservation | undefined {
    if (!this.wireObservationListeners.size) return undefined;
    const sequence = this.wireSequence + 1;
    const observation = buildWireObservation({
      provider: this.provider,
      direction,
      connectionEpoch: this.connectionEpoch,
      sequence,
      observedAtMs: this.now(),
      observedAtMonotonicMs: this.monotonicNow(),
      event,
      exactSerialized,
      requestedModel: this.requestedModel,
      inputAudioFormat: this.inputAudioFormat,
      outputAudioFormat: this.outputAudioFormat,
      localToolProxyEnabled: this.localToolProxyEnabled,
      previousObservationSha256: this.wireObservationChainHead,
    });
    this.wireSequence = sequence;
    this.wireObservationChainHead = observation.observationSha256;
    for (const listener of this.wireObservationListeners) {
      safelyNotify(() => listener(observerSnapshot(observation)));
    }
    return observation;
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
      wireObservation: CLIENT_GENERATED_WIRE_ATTRIBUTION,
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

type WireObservationBuildInput = Readonly<{
  provider: OpenAICompatibleProvider;
  direction: "inbound" | "outbound";
  connectionEpoch: number;
  sequence: number;
  observedAtMs: number;
  observedAtMonotonicMs: number;
  event: Record<string, unknown>;
  exactSerialized: string | undefined;
  requestedModel: string | undefined;
  inputAudioFormat: Pcm16Format;
  outputAudioFormat: Pcm16Format;
  localToolProxyEnabled: boolean;
  previousObservationSha256: string | null;
}>;

const SAFE_WIRE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROVIDER_ERROR_CODES = new Set([
  "authentication_error",
  "connection_error",
  "content_filter",
  "invalid_request",
  "invalid_request_error",
  "permission_denied",
  "rate_limit",
  "rate_limit_exceeded",
  "safety_violation",
  "server_error",
  "service_unavailable",
  "session_expired",
  "timeout",
]);
const NORMALIZED_USAGE_COUNTERS = [
  "inputTextTokens",
  "inputAudioTokens",
  "cachedInputTokens",
  "cachedInputTextTokens",
  "cachedInputAudioTokens",
  "outputTextTokens",
  "outputAudioTokens",
  "totalInputTokens",
  "totalOutputTokens",
  "totalTokens",
  "inputAudioMinutes",
  "outputAudioMinutes",
  "billableTextInputEvents",
] as const;

/**
 * Creates a content-addressed evidence frame without retaining provider content.
 * The full-payload hash proves byte identity, while the projection exposes only
 * the small set of numeric and hashed joins needed by the offline verifier.
 */
function buildWireObservation(input: WireObservationBuildInput): RealtimeWireObservation {
  if (!Number.isFinite(input.observedAtMs) || !Number.isFinite(input.observedAtMonotonicMs)) {
    throw new Error("Realtime wire observation clocks must be finite");
  }
  const wireType = safeWireToken(input.event.type, "unknown");
  const serialized = input.exactSerialized ?? JSON.stringify(input.event);
  const projection = deepFreeze(buildRedactedWireProjection(input, wireType));
  const identities = deepFreeze(buildWireIdentityProjection(input.event));
  const projectionSha256 = realtimeWireProjectionSha256(projection);
  const core = {
    schemaVersion: 1 as const,
    provider: input.provider,
    direction: input.direction,
    connectionEpoch: input.connectionEpoch,
    sequence: input.sequence,
    observedAtMs: input.observedAtMs,
    observedAtMonotonicMs: input.observedAtMonotonicMs,
    wireType,
    payloadSha256: sha256Text(serialized),
    payloadBytes: Buffer.byteLength(serialized, "utf8"),
    projectionSha256,
    previousObservationSha256: input.previousObservationSha256,
    identities,
    projection,
  };
  const observationSha256 = realtimeWireObservationSha256(core);
  return deepFreeze({ ...core, observationSha256 });
}

function buildRedactedWireProjection(
  input: WireObservationBuildInput,
  wireType: string,
): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  const session = sessionWireProjection(input, wireType);
  if (session !== undefined) projection.session = session;

  const audio = audioWireProjection(input.event, wireType, input.inputAudioFormat, input.outputAudioFormat);
  if (audio !== undefined) projection.audio = audio;

  const gatewayCalls = gatewayCallWireProjection(input.event);
  if (gatewayCalls.length) projection.gatewayCalls = gatewayCalls;
  const gatewayResults = gatewayResultWireProjection(input.event, input.localToolProxyEnabled);
  if (gatewayResults.length) projection.gatewayResults = gatewayResults;

  const text = textWireProjection(input.event, wireType);
  if (text.length) projection.text = text;

  const usage = usageWireProjection(input.event);
  if (usage !== undefined) projection.usage = usage;

  const providerError = providerErrorWireProjection(input.event, wireType);
  if (providerError !== undefined) projection.error = providerError;

  const terminalStatus = safeTerminalStatus(record(input.event.response).status ?? input.event.status);
  if (terminalStatus !== undefined) projection.terminal = { status: terminalStatus };
  return projection;
}

function sessionWireProjection(
  input: WireObservationBuildInput,
  wireType: string,
): Record<string, unknown> | undefined {
  if (wireType !== "session.update" && wireType !== "session.created" && wireType !== "session.updated") {
    return undefined;
  }
  const rawSession = input.event.session;
  const session = record(rawSession);
  if (!isRecord(rawSession)) return { present: false };
  const jsonSession = wireJsonValue(session);
  const model = input.direction === "outbound"
    ? input.requestedModel ?? stringValue(session.model)
    : stringValue(session.model);
  const fields = sessionIdentityFields(input.provider, session, model);
  const fieldSha256: Partial<Record<SessionConfigurationField, string>> = {};
  for (const field of SESSION_CONFIGURATION_FIELDS) {
    const value = wireJsonValue(fields[field]);
    if (value !== undefined) fieldSha256[field] = configurationHash(field, value);
  }
  const inputAudio = record(fields.input_audio);
  const transcriptionModel = stringValue(record(inputAudio.transcription).model);
  const tools = Array.isArray(fields.tools) ? fields.tools : undefined;
  return {
    present: true,
    configurationSha256: configurationHash("session", jsonSession),
    fieldSha256,
    ...(tools === undefined ? {} : { toolCount: tools.length }),
    ...optional("inputFormat", safePcmWireFormat(record(inputAudio.format))),
    ...optional("outputFormat", safePcmWireFormat(record(record(fields.output_audio).format))),
    ...optional(
      "inputTranscriptionModelSha256",
      hashedOptionalIdentity("transcription-model", transcriptionModel),
    ),
  };
}

function safePcmWireFormat(value: Record<string, unknown>): Pcm16Format | undefined {
  if (value.type !== "audio/pcm" || !Number.isSafeInteger(value.rate) || Number(value.rate) <= 0) return undefined;
  return { encoding: "pcm16", sampleRateHz: Number(value.rate), channels: 1 };
}

function audioWireProjection(
  event: Record<string, unknown>,
  wireType: string,
  inputFormat: Pcm16Format,
  outputFormat: Pcm16Format,
): Record<string, unknown> | undefined {
  if (wireType === "input_audio_buffer.append") {
    return encodedPcmEvidence(event.audio, inputFormat);
  }
  if (wireType === "response.output_audio.delta" || wireType === "response.audio.delta") {
    return encodedPcmEvidence(event.delta, outputFormat);
  }
  return undefined;
}

function encodedPcmEvidence(value: unknown, format: Pcm16Format): Record<string, unknown> {
  if (typeof value !== "string") return { validCanonicalBase64: false, format: { ...format } };
  const encodedBytes = Buffer.byteLength(value, "utf8");
  try {
    const bytes = base64ToPcm16(value);
    return {
      validCanonicalBase64: true,
      byteLength: bytes.byteLength,
      sha256: sha256Bytes(bytes),
      encodedBytes,
      format: { ...format },
    };
  } catch {
    return { validCanonicalBase64: false, encodedBytes, format: { ...format } };
  }
}

type GatewayCallCandidate = Readonly<{
  callId?: string;
  responseId?: string;
  itemId?: string;
  name?: string;
  argumentsText?: string;
}>;

function gatewayCallWireProjection(event: Record<string, unknown>): Record<string, unknown>[] {
  return gatewayCallCandidates(event)
    .filter((call) => call.name === LOCAL_TOOL_PROXY_FUNCTION_NAME)
    .map((call) => {
      const argumentEvidence = jsonTextEvidence(call.argumentsText);
      const parsed = argumentEvidence.parsed;
      const parsedRecord = record(parsed);
      const targetName = stringValue(parsedRecord.tool_name);
      const targetArguments = wireJsonValue(parsedRecord.arguments);
      return {
        gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        ...optional("callIdSha256", hashedOptionalIdentity("call", call.callId)),
        ...optional("responseIdSha256", hashedOptionalIdentity("response", call.responseId)),
        ...optional("itemIdSha256", hashedOptionalIdentity("item", call.itemId)),
        argumentsSha256: argumentEvidence.sha256,
        argumentsBytes: argumentEvidence.byteLength,
        argumentsJsonValid: argumentEvidence.validJson,
        ...optional("targetToolNameSha256", hashedOptionalIdentity("target-tool", targetName)),
        ...(targetArguments === undefined
          ? {}
          : { targetArgumentsSha256: sha256Text(canonicalJson(targetArguments)) }),
      };
    });
}

function gatewayCallCandidates(event: Record<string, unknown>): GatewayCallCandidate[] {
  const candidates: GatewayCallCandidate[] = [];
  candidates.push(gatewayCallCandidate(event, event));
  const item = record(event.item);
  if (Object.keys(item).length) candidates.push(gatewayCallCandidate(item, event));
  const response = record(event.response);
  if (Array.isArray(response.output)) {
    for (const output of response.output) {
      const outputRecord = record(output);
      if (Object.keys(outputRecord).length) candidates.push(gatewayCallCandidate(outputRecord, response));
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.name === undefined && candidate.callId === undefined) return false;
    const key = canonicalJson(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function gatewayCallCandidate(
  source: Record<string, unknown>,
  parent: Record<string, unknown>,
): GatewayCallCandidate {
  return {
    callId: stringValue(source.call_id),
    responseId: stringValue(source.response_id) ?? stringValue(parent.response_id) ?? stringValue(parent.id),
    itemId: stringValue(source.item_id) ?? stringValue(source.id),
    name: stringValue(source.name),
    argumentsText: stringValue(source.arguments),
  };
}

function gatewayResultWireProjection(
  event: Record<string, unknown>,
  localToolProxyEnabled: boolean,
): Record<string, unknown>[] {
  if (!localToolProxyEnabled || event.type !== "conversation.item.create") return [];
  const item = record(event.item);
  if (item.type !== "function_call_output") return [];
  const callId = stringValue(item.call_id);
  const resultEvidence = jsonTextEvidence(stringValue(item.output));
  return [{
    gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
    ...optional("callIdSha256", hashedOptionalIdentity("call", callId)),
    resultSha256: resultEvidence.sha256,
    resultBytes: resultEvidence.byteLength,
    resultJsonValid: resultEvidence.validJson,
  }];
}

function textWireProjection(event: Record<string, unknown>, wireType: string): Record<string, unknown>[] {
  const values: Array<{ kind: "input_text" | "transcript"; value: string }> = [];
  if (wireType === "conversation.item.create") {
    const item = record(event.item);
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        const content = record(part);
        if (content.type === "input_text" && typeof content.text === "string") {
          values.push({ kind: "input_text", value: content.text });
        }
      }
    }
  }
  if (wireType.toLowerCase().includes("transcript")) {
    for (const candidate of [event.delta, event.transcript, event.text]) {
      if (typeof candidate === "string") values.push({ kind: "transcript", value: candidate });
    }
  }
  return values.map(({ kind, value }) => ({
    kind,
    sha256: sha256Text(value),
    byteLength: Buffer.byteLength(value, "utf8"),
  }));
}

function usageWireProjection(event: Record<string, unknown>): Record<string, number> | undefined {
  const response = record(event.response);
  const rawUsage = isRecord(response.usage) ? response.usage : isRecord(event.usage) ? event.usage : undefined;
  if (rawUsage === undefined) return undefined;
  const normalized = normalizeOpenAICompatibleUsage(rawUsage);
  const result: Record<string, number> = {};
  for (const key of NORMALIZED_USAGE_COUNTERS) {
    const value = normalized[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function providerErrorWireProjection(
  event: Record<string, unknown>,
  wireType: string,
): Record<string, unknown> | undefined {
  if (wireType !== "error" && !wireType.endsWith(".error")) return undefined;
  const code = stringValue(record(event.error).code) ?? stringValue(event.code);
  return { code: code !== undefined && SAFE_PROVIDER_ERROR_CODES.has(code) ? code : "provider_error" };
}

function buildWireIdentityProjection(event: Record<string, unknown>): RealtimeWireObservation["identities"] {
  const session = record(event.session);
  const response = record(event.response);
  const item = record(event.item);
  const nestedCallIds = [...new Set(gatewayCallCandidates(event)
    .map((candidate) => candidate.callId)
    .filter((callId): callId is string => callId !== undefined))];
  const uniqueCallId = nestedCallIds.length === 1 ? nestedCallIds[0] : undefined;
  return {
    ...optional("eventIdSha256", hashedOptionalIdentity("event", stringValue(event.event_id))),
    ...optional(
      "sessionIdSha256",
      hashedOptionalIdentity("session", stringValue(event.session_id) ?? stringValue(session.id)),
    ),
    ...optional(
      "responseIdSha256",
      hashedOptionalIdentity("response", stringValue(event.response_id) ?? stringValue(response.id)),
    ),
    ...optional(
      "itemIdSha256",
      hashedOptionalIdentity("item", stringValue(event.item_id) ?? stringValue(item.id)),
    ),
    ...optional(
      "callIdSha256",
      hashedOptionalIdentity(
        "call",
        stringValue(event.call_id) ?? stringValue(item.call_id) ?? uniqueCallId,
      ),
    ),
  };
}

function hashedOptionalIdentity(kind: RealtimeWireIdentityKind, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return wireIdentityHash(kind, value);
  } catch {
    return undefined;
  }
}

function wireIdentityHash(kind: RealtimeWireIdentityKind, value: string): string {
  return realtimeWireIdentitySha256(kind, value);
}

function safeWireToken(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_WIRE_TOKEN.test(value) ? value : fallback;
}

function safeTerminalStatus(value: unknown): string | undefined {
  return value === "completed"
    || value === "cancelled"
    || value === "failed"
    || value === "incomplete"
    || value === "interrupted"
    ? value
    : undefined;
}

function jsonTextEvidence(value: string | undefined): Readonly<{
  sha256: string;
  byteLength: number;
  validJson: boolean;
  parsed?: unknown;
}> {
  const text = value ?? "";
  try {
    const parsed = JSON.parse(text) as unknown;
    const canonical = canonicalJson(parsed);
    return {
      sha256: sha256Text(canonical),
      byteLength: Buffer.byteLength(canonical, "utf8"),
      validJson: true,
      parsed,
    };
  } catch {
    return {
      sha256: sha256Text(text),
      byteLength: Buffer.byteLength(text, "utf8"),
      validJson: false,
    };
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function wireFrameText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (Array.isArray(data) && data.every(ArrayBuffer.isView)) {
    return Buffer.concat(data.map((part) => (
      Buffer.from(part.buffer, part.byteOffset, part.byteLength)
    ))).toString("utf8");
  }
  return undefined;
}

export function createOpenAIRealtimeClient(
  options: HostedOpenAICompatibleClientOptions,
): OpenAICompatibleRealtimeClient {
  requireCredential(options.apiKey, "OpenAI");
  const { apiKey, model, headers, experimentalProviderDirectMcp, ...clientOptions } = options;
  return new OpenAICompatibleRealtimeClient({
    ...clientOptions,
    experimentalProviderDirectMcp,
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
    experimentalProviderDirectMcp,
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
    experimentalProviderDirectMcp,
    provider: "xai",
    url: url.toString(),
    headers: { ...headers, Authorization: `Bearer ${apiKey}` },
    sessionUpdate: enableResumption || conversationId
      ? enableXaiResumption(sessionUpdate)
      : sessionUpdate,
  });
}

function assertProviderDirectMcpGate(
  tools: readonly unknown[],
  grant: OpenAICompatibleRealtimeClientOptions["experimentalProviderDirectMcp"],
): void {
  const directEnabled = experimentalProviderDirectMcpEnabled({
    ...(grant === undefined ? {} : {
      experimental_provider_direct_mcp: {
        enabled: grant.enabled,
        allow_consequential: grant.allowConsequential,
      },
    }),
  });
  if (tools.some((tool) => record(tool).type === "mcp") && !directEnabled) {
    throw new Error("Raw provider-direct MCP requires both explicit experimental grants");
  }
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
      ...(provider === "xai" ? { turn_detection: { type: null } } : {}),
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
    const xaiTurnDetection = session.turn_detection;
    if (
      !isRecord(xaiTurnDetection)
      || (
        Object.keys(xaiTurnDetection).length > 0
        && xaiTurnDetection.type !== null
      )
    ) {
      mismatches.push("xAI session.turn_detection.type is not null");
    }
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

type SessionAcknowledgementInput = Readonly<{
  provider: OpenAICompatibleProvider;
  requestedUpdate: Record<string, unknown>;
  acknowledgedEvent: Record<string, unknown>;
  /** Handshake query model, which is authoritative for xAI and may also pin OpenAI. */
  requestedModel?: string;
  /** Model may be acknowledged at connection creation even if session.updated omits it. */
  acknowledgedModel?: Readonly<{
    value: string;
    wireType: "session.created" | "session.updated";
  }>;
}>;

const SESSION_CONFIGURATION_FIELDS: readonly SessionConfigurationField[] = [
  "model",
  "voice",
  "instructions",
  "tools",
  "tool_choice",
  "input_audio",
  "output_audio",
  "turn_detection",
];

/**
 * Builds evidence primarily from the provider's effective `session.updated`
 * object. Model identity may instead come from `session.created`, and its
 * source is recorded explicitly. It compares only keys the client requested
 * (providers may add documented defaults), but never upgrades an omitted value
 * into proof.
 */
export function buildSessionConfigurationAcknowledgement(
  input: SessionAcknowledgementInput,
): SessionConfigurationAcknowledgement {
  const requestedSession = record(input.requestedUpdate.session);
  const acknowledgedSession = record(input.acknowledgedEvent.session);
  const requested = sessionIdentityFields(
    input.provider,
    requestedSession,
    input.requestedModel,
  );
  const acknowledged = sessionIdentityFields(
    input.provider,
    acknowledgedSession,
    input.acknowledgedModel?.value,
  );
  const fields = Object.fromEntries(SESSION_CONFIGURATION_FIELDS.map((field) => [
    field,
    configurationFieldProof(
      field,
      requested[field],
      acknowledged[field],
      field === "model"
        ? input.acknowledgedModel?.wireType ?? "session.updated"
        : "session.updated",
    ),
  ])) as Record<SessionConfigurationField, SessionConfigurationFieldProof>;
  const session = configurationFieldProof("session", requestedSession, acknowledgedSession, "session.updated");
  const strictParityVerified = session.status === "verified"
    && SESSION_CONFIGURATION_FIELDS.every((field) => (
      fields[field].status === "verified" || fields[field].status === "not_requested"
    ));
  return Object.freeze({
    schemaVersion: 1 as const,
    strictParityVerified,
    paidBenchmarkReady: strictParityVerified,
    session,
    fields: Object.freeze(fields),
  });
}

function sessionIdentityFields(
  provider: OpenAICompatibleProvider,
  session: Record<string, unknown>,
  requestedModel?: string,
): Record<SessionConfigurationField, unknown> {
  const audio = record(session.audio);
  const inputAudio = audio.input;
  const outputAudio = audio.output;
  return {
    model: requestedModel ?? session.model,
    voice: provider === "openai" ? record(outputAudio).voice : session.voice,
    instructions: session.instructions,
    tools: session.tools,
    tool_choice: session.tool_choice,
    input_audio: inputAudio,
    output_audio: outputAudio,
    turn_detection: provider === "openai"
      ? record(inputAudio).turn_detection
      // xAI currently echoes an accepted `{ type: null }` manual-turn request
      // as `{}`. Canonicalize only that exact empty-object wire shape; any
      // populated detector still has to match byte-for-byte below.
      : isRecord(session.turn_detection) && Object.keys(session.turn_detection).length === 0
        ? { type: null }
        : session.turn_detection,
  };
}

function configurationFieldProof(
  field: SessionConfigurationField | "session",
  requestedRaw: unknown,
  acknowledgedRaw: unknown,
  acknowledgedBy: "session.created" | "session.updated",
): SessionConfigurationFieldProof {
  const requested = wireJsonValue(requestedRaw);
  const acknowledged = wireJsonValue(acknowledgedRaw);
  if (requested === undefined) return Object.freeze({ status: "not_requested" as const });
  const requestedSha256 = configurationHash(field, requested);
  if (acknowledged === undefined) {
    return Object.freeze({
      status: "unverifiable" as const,
      requestedSha256,
      reason: "Provider session.updated omitted the requested field",
    });
  }
  const projection = projectAcknowledgedValue(requested, acknowledged, field);
  if (projection.missing.length) {
    return Object.freeze({
      status: "unverifiable" as const,
      requestedSha256,
      acknowledgedSha256: configurationHash(field, projection.value),
      acknowledgedBy,
      reason: `Provider session.updated omitted requested path(s): ${projection.missing.join(", ")}`,
    });
  }
  const acknowledgedSha256 = configurationHash(field, projection.value);
  return Object.freeze({
    status: requestedSha256 === acknowledgedSha256 ? "verified" as const : "mismatch" as const,
    requestedSha256,
    acknowledgedSha256,
    acknowledgedBy,
    ...(requestedSha256 === acknowledgedSha256
      ? {}
      : { reason: "Provider explicitly acknowledged a different value" }),
  });
}

function acknowledgedSessionModel(event: Record<string, unknown>): string | undefined {
  const session = record(event.session);
  if (!("model" in session)) return undefined;
  if (typeof session.model !== "string") {
    throw new Error(`Provider ${String(event.type)} model identity must be a string`);
  }
  assertOpaqueIdentity(session.model, `${String(event.type)} model`, 256);
  return session.model;
}

function acknowledgedSessionId(event: Record<string, unknown>): string | undefined {
  const session = record(event.session);
  const nested = session.id;
  const topLevel = event.session_id;
  for (const [path, value] of [["session.id", nested], ["session_id", topLevel]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`Provider ${String(event.type)} ${path} must be a string`);
    }
    assertOpaqueIdentity(value, `${String(event.type)} ${path}`, 512);
  }
  if (nested !== undefined && topLevel !== undefined && nested !== topLevel) {
    throw new Error(`Provider ${String(event.type)} sent contradictory session identities`);
  }
  return stringValue(nested) ?? stringValue(topLevel);
}

type ProjectedAcknowledgement = { value: unknown; missing: string[] };

function projectAcknowledgedValue(
  requested: unknown,
  acknowledged: unknown,
  path: string,
): ProjectedAcknowledgement {
  if (Array.isArray(requested)) {
    if (!Array.isArray(acknowledged)) return { value: acknowledged, missing: [] };
    // Array membership and order are capability identity. Preserve a different
    // length in the hash rather than silently projecting injected/removed tools.
    if (requested.length !== acknowledged.length) return { value: acknowledged, missing: [] };
    const values: unknown[] = [];
    const missing: string[] = [];
    for (let index = 0; index < requested.length; index += 1) {
      const projected = projectAcknowledgedValue(requested[index], acknowledged[index], `${path}[${index}]`);
      values.push(projected.value);
      missing.push(...projected.missing);
    }
    return { value: values, missing };
  }
  if (isRecord(requested)) {
    if (!isRecord(acknowledged)) return { value: acknowledged, missing: [] };
    const value: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const key of Object.keys(requested).sort()) {
      if (!(key in acknowledged)) {
        missing.push(`${path}.${key}`);
        continue;
      }
      const projected = projectAcknowledgedValue(requested[key], acknowledged[key], `${path}.${key}`);
      value[key] = projected.value;
      missing.push(...projected.missing);
    }
    return { value, missing };
  }
  return { value: acknowledged, missing: [] };
}

const SESSION_ACK_HASH_DOMAIN = "harshas-amazing-call-center/session-configuration/v1";

function configurationHash(field: SessionConfigurationField | "session", value: unknown): string {
  return createHash("sha256")
    .update(SESSION_ACK_HASH_DOMAIN)
    .update("\0")
    .update(field)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function wireJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : JSON.parse(serialized) as unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
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

const MAX_TOOL_RESULT_JSON_DEPTH = 64;
const MAX_TOOL_RESULT_JSON_NODES = 100_000;

function snapshotToolResultBatch(
  results: readonly RealtimeToolResult[],
): Array<Readonly<{ callId: string; output: string }>> {
  if (!Array.isArray(results)) throw new Error("Tool results must be an array");
  const descriptors = Object.getOwnPropertyDescriptors(results) as Record<string, PropertyDescriptor>;
  const length = descriptors["length"]?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROVIDER_TOOL_CALL_IDS) {
    throw new Error(`Tool result batch length must be between 0 and ${MAX_PROVIDER_TOOL_CALL_IDS}`);
  }
  if (Object.getOwnPropertySymbols(results).length) throw new Error("Tool result batch cannot have symbol properties");
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") continue;
    const index = canonicalArrayIndex(key);
    if (index === undefined || index >= length || !("value" in descriptor)) {
      throw new Error("Tool result batch must contain only concrete indexed values");
    }
  }
  const snapshot: Array<Readonly<{ callId: string; output: string }>> = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw new Error(`Tool result batch is sparse at index ${index}`);
    snapshot.push(snapshotToolResult(descriptor.value, index));
  }
  return snapshot;
}

function snapshotToolResult(value: unknown, index: number): Readonly<{ callId: string; output: string }> {
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`Tool result ${index} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length) throw new Error(`Tool result ${index} cannot have symbol properties`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== 2 || keys[0] !== "callId" || keys[1] !== "output") {
    throw new Error(`Tool result ${index} must contain exactly callId and output`);
  }
  const callId = descriptors.callId;
  const output = descriptors.output;
  if (!("value" in callId) || !("value" in output)) {
    throw new Error(`Tool result ${index} cannot use accessor properties`);
  }
  if (typeof callId.value !== "string") throw new Error(`Tool result ${index} callId must be a string`);
  return Object.freeze({
    callId: callId.value,
    output: typeof output.value === "string" ? output.value : canonicalToolOutputJson(output.value),
  });
}

function canonicalToolOutputJson(value: unknown): string {
  const budget = { nodes: 0 };
  const ancestors = new Set<object>();
  return encode(value, 0);

  function encode(candidate: unknown, depth: number): string {
    budget.nodes += 1;
    if (budget.nodes > MAX_TOOL_RESULT_JSON_NODES) {
      throw new Error(`Tool result output exceeded ${MAX_TOOL_RESULT_JSON_NODES} JSON nodes`);
    }
    if (depth > MAX_TOOL_RESULT_JSON_DEPTH) {
      throw new Error(`Tool result output exceeded JSON depth ${MAX_TOOL_RESULT_JSON_DEPTH}`);
    }
    if (candidate === null) return "null";
    if (typeof candidate === "string" || typeof candidate === "boolean") return JSON.stringify(candidate);
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("Tool result output numbers must be finite");
      return JSON.stringify(candidate);
    }
    if (candidate === undefined) return "null";
    if (typeof candidate !== "object") {
      throw new Error(`Tool result output cannot contain ${typeof candidate} values`);
    }
    if (ancestors.has(candidate)) throw new Error("Tool result output cannot contain cycles");
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype || Object.getOwnPropertySymbols(candidate).length) {
          throw new Error("Tool result output arrays must use the canonical Array prototype");
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate) as Record<string, PropertyDescriptor>;
        const length = descriptors["length"]?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TOOL_RESULT_JSON_NODES) {
          throw new Error("Tool result output array length is invalid");
        }
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (key === "length") continue;
          const index = canonicalArrayIndex(key);
          if (index === undefined || index >= length || !("value" in descriptor)) {
            throw new Error("Tool result output arrays cannot use accessors or named properties");
          }
        }
        const items: string[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          items.push(!descriptor || !("value" in descriptor) ? "null" : encode(descriptor.value, depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(candidate).length) {
        throw new Error("Tool result output objects must be plain JSON objects");
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const entries: string[] = [];
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("Tool result output objects cannot use accessors or hidden properties");
        }
        entries.push(`${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`);
      }
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(candidate);
    }
  }
}

function canonicalArrayIndex(value: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === value ? parsed : undefined;
}

function requireCredential(value: string, provider: string): void {
  if (!value.trim()) throw new Error(`${provider} API key is required`);
}

type ProviderWireToolCallIdentity = {
  responseId?: string;
  itemId?: string;
  name?: string;
  terminalFingerprints: Map<string, string>;
};

type ProviderWireToolCallOccurrence = {
  callId: unknown;
  responseId?: string;
  itemId?: string;
  name?: string;
  terminalWireType?: string;
  terminalFingerprint?: string;
};

const PROVIDER_TERMINAL_RESPONSE_WIRE_TYPES = new Set([
  "response.done",
  "response.completed",
  "response.cancelled",
  "response.failed",
  "response.incomplete",
]);

function providerWireToolCallOccurrences(
  event: Record<string, unknown>,
): ProviderWireToolCallOccurrence[] {
  const wireType = stringValue(event.type);
  if (!wireType) return [];
  const response = record(event.response);
  const responseId = stringValue(event.response_id) ?? stringValue(response.id);
  if (
    wireType === "response.function_call_arguments.delta"
    || wireType === "response.function_call_arguments.done"
  ) {
    return [{
      callId: event.call_id,
      responseId,
      itemId: stringValue(event.item_id),
      name: stringValue(event.name),
      ...(wireType.endsWith(".done") ? {
        terminalWireType: wireType,
        terminalFingerprint: providerWireEventFingerprint(event),
      } : {}),
    }];
  }
  if (
    wireType === "response.output_item.added"
    || wireType === "response.output_item.done"
    || wireType === "conversation.item.added"
    || wireType === "conversation.item.created"
    || wireType === "conversation.item.done"
  ) {
    const item = record(event.item);
    if (item.type !== "function_call") return [];
    return [{
      callId: item.call_id,
      responseId,
      itemId: stringValue(item.id) ?? stringValue(event.item_id),
      name: stringValue(item.name),
      ...(wireType === "response.output_item.done" || wireType === "conversation.item.done"
        ? { terminalWireType: wireType, terminalFingerprint: providerWireEventFingerprint(event) }
        : {}),
    }];
  }
  if (PROVIDER_TERMINAL_RESPONSE_WIRE_TYPES.has(wireType)) {
    const output = Array.isArray(response.output) ? response.output : [];
    const terminalFingerprint = providerWireEventFingerprint(event);
    return output.flatMap((candidate): ProviderWireToolCallOccurrence[] => {
      const item = record(candidate);
      if (item.type !== "function_call") return [];
      return [{
        callId: item.call_id,
        responseId,
        itemId: stringValue(item.id),
        name: stringValue(item.name),
        terminalWireType: `${wireType}.output`,
        terminalFingerprint,
      }];
    });
  }
  return [];
}

function cloneProviderWireToolCallIdentity(
  identity: ProviderWireToolCallIdentity,
): ProviderWireToolCallIdentity {
  return {
    responseId: identity.responseId,
    itemId: identity.itemId,
    name: identity.name,
    terminalFingerprints: new Map(identity.terminalFingerprints),
  };
}

const PROVIDER_WIRE_EVENT_HASH_DOMAIN = "harshas-amazing-call-center/provider-wire-event/v1";

function providerWireEventFingerprint(event: Record<string, unknown>): string {
  const withoutNativeIdentity = Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== "event_id"),
  );
  return createHash("sha256")
    .update(PROVIDER_WIRE_EVENT_HASH_DOMAIN)
    .update("\0")
    .update(canonicalJson(withoutNativeIdentity))
    .digest("hex");
}

function identityConflict(
  label: string,
  prior: string | undefined,
  next: string | undefined,
): string | undefined {
  return prior !== undefined && next !== undefined && prior !== next ? label : undefined;
}

function providerRedundantIdentityError(event: Record<string, unknown>): string | undefined {
  const response = record(event.response);
  const item = record(event.item);
  const conflict = identityConflict(
    "response identity",
    stringValue(event.response_id),
    stringValue(response.id),
  ) ?? identityConflict(
    "item identity",
    stringValue(event.item_id),
    stringValue(item.id),
  ) ?? identityConflict(
    "tool call identity",
    stringValue(event.call_id),
    stringValue(item.call_id),
  );
  return conflict ? `Provider sent contradictory redundant ${conflict} fields` : undefined;
}

const MAX_PROVIDER_TOOL_CALL_IDS = 10_000;
const PROVIDER_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;

function providerCallIdError(callId: unknown): string | undefined {
  if (typeof callId !== "string") return "must be a string";
  if (callId.length === 0) return "cannot be empty";
  if (callId.length > 512) return "exceeds 512 characters";
  if (!PROVIDER_CALL_ID.test(callId)) {
    return "must be one canonical ASCII token using letters, digits, dot, underscore, colon, or hyphen";
  }
  return undefined;
}

function assertTargetIdentity(value: unknown, label: "responseId" | "itemId"): asserts value is string {
  const invalid = providerCallIdError(value);
  if (invalid) throw new Error(`Realtime ${label} ${invalid}`);
}

function assertOpaqueIdentity(value: string, label: string, maximumLength: number): void {
  if (!value || value !== value.trim() || value.length > maximumLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Realtime ${label} must be a non-empty canonical string of at most ${maximumLength} characters`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const COMMON_PRE_READINESS_CONTROL_EVENTS = new Set([
  "session.created",
  "session.updated",
  "rate_limits.updated",
  "error",
]);

function isPreReadinessControlEvent(
  wireType: string,
  provider: OpenAICompatibleProvider,
): boolean {
  if (COMMON_PRE_READINESS_CONTROL_EVENTS.has(wireType)) return true;
  // xAI assigns the conversation identity before session.updated. The client
  // already withholds a resumability claim until the requested setting is
  // acknowledged, so this is control-plane metadata rather than app work.
  return provider === "xai" && (wireType === "conversation.created" || wireType === "ping");
}

function unexpectedProviderCapabilityWidening(
  requestedUpdate: Record<string, unknown>,
  acknowledgedEvent: Record<string, unknown>,
): string[] {
  const requestedSession = record(requestedUpdate.session);
  const acknowledgedSession = record(acknowledgedEvent.session);
  const requestedTools = requestedSession.tools;
  const acknowledgedTools = acknowledgedSession.tools;
  if (
    requestedTools === undefined
    && Array.isArray(acknowledgedTools)
    && acknowledgedTools.length > 0
  ) {
    return ["provider enabled tools even though the frozen session requested none"];
  }
  return [];
}

function normalizedEventResponseId(event: NormalizedRealtimeEvent): string | undefined {
  switch (event.type) {
    case "response.started":
    case "response.completed":
    case "output.audio":
    case "output.transcript":
    case "tool.calls":
    case "tool.dispatch":
    case "tool.cancelled":
    case "turn.interrupted":
      return event.responseId;
    case "usage":
      return event.responseId;
    default:
      return undefined;
  }
}

function withWireObservation(
  event: NormalizedRealtimeEvent,
  observation: RealtimeWireObservation | undefined,
): NormalizedRealtimeEvent {
  return observation === undefined
    ? event
    : { ...event, wireObservation: realtimeWireObservationReference(observation) };
}

type LocalDispatchBuildResult =
  | Readonly<{
      ok: true;
      event: Extract<NormalizedRealtimeEvent, { type: "tool.dispatch" }>;
    }>
  | Readonly<{ ok: false; message: string }>;

// Exact `/api/mcp` tools/call name grammar. Reject at the provider boundary so
// malformed model output never becomes authenticated gateway traffic.
const LOCAL_PROXY_TARGET_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;
const LOCAL_PROXY_PROVIDER_CALL_ID_MAX_BYTES = 256;

function buildLocalToolProxyDispatchEvent(
  event: Extract<NormalizedRealtimeEvent, { type: "tool.calls" }>,
  provider: OpenAICompatibleProvider,
): LocalDispatchBuildResult {
  const dispatches: Array<{
    callId: string;
    request: LocalToolProxyDispatch;
    provenance: ProviderToolCallProvenance;
  }> = [];
  for (const call of event.calls) {
    if (Buffer.byteLength(call.callId, "utf8") > LOCAL_PROXY_PROVIDER_CALL_ID_MAX_BYTES) {
      return {
        ok: false,
        message:
          `Provider call ${call.callId.slice(0, 32)}… exceeds the local gateway's `
          + `${LOCAL_PROXY_PROVIDER_CALL_ID_MAX_BYTES}-byte persistent identity limit`,
      };
    }
    if (call.name !== LOCAL_TOOL_PROXY_FUNCTION_NAME) {
      return {
        ok: false,
        message:
          `Provider attempted undeclared native function ${JSON.stringify(call.name)} `
          + `while local gateway mode permits only ${LOCAL_TOOL_PROXY_FUNCTION_NAME}`,
      };
    }
    if (call.responseId !== event.responseId) {
      return {
        ok: false,
        message: `Provider call ${call.callId} response provenance does not match its executable batch`,
      };
    }
    if (call.terminalWireType !== event.wireType) {
      return {
        ok: false,
        message: `Provider call ${call.callId} terminal wire provenance does not match its executable batch`,
      };
    }
    if (call.terminalEventId !== event.nativeEventId) {
      return {
        ok: false,
        message: `Provider call ${call.callId} terminal event provenance does not match its executable batch`,
      };
    }
    if (!isRecord(call.argumentsJson)) {
      return { ok: false, message: `Local gateway call ${call.callId} arguments must be a JSON object` };
    }
    const keys = Object.keys(call.argumentsJson).sort();
    if (keys.length !== 2 || keys[0] !== "arguments" || keys[1] !== "tool_name") {
      return {
        ok: false,
        message:
          `Local gateway call ${call.callId} must contain exactly tool_name and arguments; `
          + "provider provenance is host-owned",
      };
    }
    const targetName = call.argumentsJson.tool_name;
    if (typeof targetName !== "string" || !LOCAL_PROXY_TARGET_NAME.test(targetName)) {
      return { ok: false, message: `Local gateway call ${call.callId} has an invalid target tool name` };
    }
    if (!isRecord(call.argumentsJson.arguments)) {
      return { ok: false, message: `Local gateway call ${call.callId} target arguments must be a JSON object` };
    }
    const targetArgumentsError = localProxyArgumentsError(call.argumentsJson.arguments);
    if (targetArgumentsError) {
      return { ok: false, message: `Local gateway call ${call.callId} ${targetArgumentsError}` };
    }
    const provenance = deepFreeze<ProviderToolCallProvenance>({
      schemaVersion: 1,
      provider,
      nativeCallId: call.callId,
      nativeResponseId: call.responseId,
      ...optional("nativeItemId", call.itemId),
      ...optional("terminalEventId", call.terminalEventId),
      terminalWireType: call.terminalWireType,
    });
    let targetArguments: Readonly<Record<string, unknown>>;
    try {
      targetArguments = deepFreeze(structuredClone(call.argumentsJson.arguments));
    } catch (error) {
      return {
        ok: false,
        message: `Local gateway call ${call.callId} arguments could not be snapshotted: ${errorMessage(error)}`,
      };
    }
    const request = deepFreeze<LocalToolProxyDispatch>({
      method: "tools/call",
      params: {
        name: targetName,
        arguments: targetArguments,
        _meta: {
          [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: call.callId,
          [PROVIDER_PROVENANCE_META_KEY]: provenance,
        },
      },
    });
    dispatches.push(deepFreeze({ callId: call.callId, request, provenance }));
  }
  return {
    ok: true,
    event: deepFreeze({
      type: "tool.dispatch",
      provider,
      receivedAtMs: event.receivedAtMs,
      ...optional("receivedAtMonotonicMs", event.receivedAtMonotonicMs),
      wireType: event.wireType,
      ...optional("nativeEventId", event.nativeEventId),
      ...optional("wireObservation", event.wireObservation),
      responseId: event.responseId,
      gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      dispatches,
    }),
  };
}

const MAX_LOCAL_PROXY_ARGUMENT_DEPTH = 64;
const MAX_LOCAL_PROXY_ARGUMENT_NODES = 100_000;

function localProxyArgumentsError(value: Record<string, unknown>): string | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_LOCAL_PROXY_ARGUMENT_NODES) {
      return `target arguments exceeded ${MAX_LOCAL_PROXY_ARGUMENT_NODES} JSON nodes`;
    }
    if (current.depth > MAX_LOCAL_PROXY_ARGUMENT_DEPTH) {
      return `target arguments exceeded JSON depth ${MAX_LOCAL_PROXY_ARGUMENT_DEPTH}`;
    }
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      return "target arguments contained a non-finite number";
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (!Array.isArray(current.value) && !isRecord(current.value)) {
      return "target arguments contained a non-JSON object";
    }
    for (const child of Object.values(current.value)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
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
