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
import { createRealtimeTransportFailureDiagnostic } from "./transport-diagnostics";
import type { RealtimeWireIdentityKind } from "./wire-evidence";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
  experimentalProviderDirectMcpEnabled,
  isSafeLocalToolProxyFunction,
} from "./types";
import type {
  LocalToolProxyDispatch,
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  Pcm16Audio,
  Pcm16Format,
  RealtimeClientState,
  RealtimeConversationHistoryHydratedItemAcknowledgement,
  RealtimeConversationHistoryHydratedItemKind,
  RealtimeConversationHistoryHydrationAcknowledgement,
  RealtimeConversationHistoryJsonValue,
  RealtimeConversationHistoryToolCall,
  RealtimeConversationHistoryTurn,
  RealtimeEventListener,
  RealtimeOutputAudioTruncation,
  RealtimeInputAudioCommitAcknowledgement,
  RealtimeResponseCancelTarget,
  RealtimeResponsePreparation,
  RealtimeServerVadTurnAcknowledgement,
  RealtimeServerVadTurnPreparation,
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

export const XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR =
  "A server-VAD turn must be acknowledged before audio and cannot receive audio after speech stopped" as const;

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
  /**
   * Manual-mode VAD events are always surfaced as diagnostics. Strict
   * qualification may additionally fail the connection on the first event.
   */
  unexpectedManualTurnDetectionPolicy?: "diagnose" | "fail";
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
const MAX_PENDING_INPUT_COMMITS = 128;
const MAX_CONVERSATION_HISTORY_TURNS = 512;
const MAX_CONVERSATION_HISTORY_PROVIDER_ITEMS = 1_024;
const MAX_CONVERSATION_HISTORY_FIELD_BYTES = 64 * 1_024;
const MAX_CONVERSATION_HISTORY_TOTAL_BYTES = 512 * 1_024;
const MAX_CONVERSATION_HISTORY_JSON_DEPTH = 64;
const MAX_CONVERSATION_HISTORY_JSON_NODES = 100_000;
const CONVERSATION_HISTORY_HASH_DOMAIN =
  "harshas-amazing-call-center/realtime-conversation-history/provider-visible/v2\n";
const CONVERSATION_HISTORY_SOURCE_BINDING_DOMAIN =
  "harshas-amazing-call-center/realtime-conversation-history/source-binding/v2\n";
// OpenAI documents client-supplied item IDs and uses the `item_` namespace in
// its examples. Retain a HACC discriminator after that protocol-compatible
// prefix; a fresh qualification must still prove the provider accepts it.
const CONVERSATION_HISTORY_ITEM_ID_PREFIX = "item_hacc_hist_";
const CONVERSATION_HISTORY_ALLOWED_INBOUND_WIRE_TYPES = new Set([
  "conversation.item.added",
  "conversation.item.created",
  "conversation.item.done",
  "conversation.created",
  "error",
  "ping",
  "rate_limits.updated",
  "session.created",
  "session.updated",
]);

type ConversationHistoryWireItem = Readonly<{
  historyTurnOrdinal: number;
  providerItemOrdinal: number;
  kind: RealtimeConversationHistoryHydratedItemKind;
  sourceSha256: string;
  itemId: string;
  syntheticCallId?: string;
  event: Readonly<Record<string, unknown>>;
  expectedItem: Readonly<Record<string, unknown>>;
}>;

type PendingConversationHistoryItem = {
  expected: ConversationHistoryWireItem;
  outboundObservation?: RealtimeWireObservation;
  resolve: (value: RealtimeConversationHistoryHydratedItemAcknowledgement) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingInputCommit = {
  connectionEpoch: number;
  commitOrdinal: number;
  acknowledgement: RealtimeInputAudioCommitAcknowledgement | null;
  waiters: Set<{
    resolve: (value: RealtimeInputAudioCommitAcknowledgement) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
};

type PendingServerVadTurn = {
  connectionEpoch: number;
  turnOrdinal: number;
  requestedUpdate: Record<string, unknown>;
  preparation: RealtimeServerVadTurnPreparation;
  outboundObservation?: RealtimeWireObservation;
  resolve: (value: RealtimeServerVadTurnAcknowledgement) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  phase: "awaiting_session_ack" | "ready_for_audio" | "speech_started" | "speech_stopped" | "auto_committed" | "response_started" | "terminal";
  initialResponseId?: string;
  activeResponseId?: string;
  speechStartObservationSha256?: string;
  speechStopObservationSha256?: string;
  autoCommitObservationSha256?: string;
};

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
  private readonly xaiConversationReplayRequested: boolean;
  private readonly maximumTrackedIdentities: number;
  private readonly requireStrictSessionConfigurationParity: boolean;
  private readonly unexpectedManualTurnDetectionPolicy: "diagnose" | "fail";
  private readonly turnDetectionMode: "manual" | "server_vad";
  private readonly requestedModel?: string;
  private readonly localToolProxyEnabled: boolean;
  private readonly declaredFunctionToolNames: ReadonlySet<string>;
  private readonly baseInstructions: string;
  private pendingResponsePreparation: RealtimeResponsePreparation | null = null;
  private pendingToolContinuationPreparation: RealtimeResponsePreparation | null = null;
  private inputPhase: "empty" | "buffered" | "committed" = "empty";
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
  private pendingToolBatchResponseId: string | null = null;
  private pendingToolContinuationResponseId: string | null = null;
  private awaitingServerVadContinuationOriginId: string | null = null;
  private awaitingServerVadContinuationObservationSha256: string | null = null;
  private inputCommitOrdinal = 0;
  private readonly pendingInputCommits: PendingInputCommit[] = [];
  private pendingServerVadTurn: PendingServerVadTurn | null = null;
  private serverVadTurnOrdinal = 0;
  private discardedInputCommitAcknowledgements = 0;
  private submittingToolResults = false;
  private connectionEpoch = 0;
  private wireSequence = 0;
  private wireObservationChainHead: string | null = null;
  private lastSessionConfigurationAcknowledgement: SessionConfigurationAcknowledgement | null = null;
  private responseGenerationRequested = false;
  private responseGenerationStarted = false;
  private responseTerminalObserved = false;
  private initialSessionUpdateSent = false;
  private conversationActivityStarted = false;
  private conversationHistoryHydrationStarted = false;
  private conversationHistoryHydrationInProgress = false;
  private conversationHistoryAuthorizedWireEvent: Record<string, unknown> | null = null;
  private pendingConversationHistoryItem: PendingConversationHistoryItem | null = null;
  private readonly acknowledgedConversationHistoryItems =
    new Map<string, ConversationHistoryWireItem>();
  private readonly hydratedConversationHistoryCallIds = new Set<string>();

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
    const rawInstructions = record(sessionUpdateSnapshot.session).instructions;
    if (rawInstructions !== undefined && typeof rawInstructions !== "string") {
      throw new Error("Realtime session instructions must be a string");
    }
    this.baseInstructions = rawInstructions ?? "";
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
    this.xaiConversationReplayRequested = options.provider === "xai"
      && parsedUrl.searchParams.has("conversation_id");
    this.connectionUrl = parsedUrl.toString();
    this.connectionHeaders = { ...options.headers };
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.maximumWireEventBytes = options.maximumWireEventBytes;
    this.maximumTrackedIdentities = options.maximumTrackedIdentities ?? MAX_PROVIDER_TOOL_CALL_IDS;
    this.requireStrictSessionConfigurationParity = options.requireStrictSessionConfigurationParity === true;
    this.unexpectedManualTurnDetectionPolicy = options.unexpectedManualTurnDetectionPolicy
      ?? (this.requireStrictSessionConfigurationParity ? "fail" : "diagnose");
    this.turnDetectionMode = requestedTurnDetectionMode(this.provider, sessionUpdateSnapshot);
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
    this.declaredFunctionToolNames = new Set(configuredTools.flatMap((tool) => {
      const value = record(tool);
      if (value.type !== "function") return [];
      const name = stringValue(value.name) ?? stringValue(record(value.function).name);
      return name === undefined ? [] : [name];
    }));
    if (namedLocalProxyTools.length > 1) {
      throw new Error("Realtime session cannot declare the local capability gateway more than once");
    }
    if (namedLocalProxyTools.length === 1 && !isSafeLocalToolProxyFunction(namedLocalProxyTools[0])) {
      throw new Error("Realtime session must declare the exact local capability gateway contract or an exact closed semantic gateway contract");
    }
    this.localToolProxyEnabled = namedLocalProxyTools.length === 1;
    if (
      this.localToolProxyEnabled
      && configuredTools.some((tool) => record(tool).type === "function" && !isSafeLocalToolProxyFunction(tool))
    ) {
      throw new Error("Local capability gateway mode cannot expose additional provider-native functions");
    }
    this.inputAudioFormat = options.inputAudioFormat ?? PCM16_MONO_24KHZ;
    this.outputAudioFormat = options.outputAudioFormat ?? PCM16_MONO_24KHZ;
    assertPcm16Format(this.inputAudioFormat);
    assertPcm16Format(this.outputAudioFormat);
    assertProviderPcmFormat(options.provider, this.inputAudioFormat, "input");
    assertProviderPcmFormat(options.provider, this.outputAudioFormat, "output");
    this.sessionUpdate = this.turnDetectionMode === "server_vad"
      ? withXaiServerVadPcmSession(sessionUpdateSnapshot, this.inputAudioFormat, this.outputAudioFormat)
      : withManualPcmSession(options.provider, sessionUpdateSnapshot, this.inputAudioFormat, this.outputAudioFormat);
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

  get serverVadTransportParitySha256(): string | null {
    return this.turnDetectionMode === "server_vad"
      ? xaiServerVadTransportParitySha256(this.sessionUpdate, this.requestedModel)
      : null;
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
    if (this.turnDetectionMode === "server_vad"
      && (!this.pendingServerVadTurn
        || (this.pendingServerVadTurn.phase !== "ready_for_audio"
          && this.pendingServerVadTurn.phase !== "speech_started"))) {
      throw new Error(XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR);
    }
    this.assertNoPendingToolBatch();
    if (this.pendingResponsePreparation) {
      throw new Error("Cannot append audio after preparing the next realtime response");
    }
    if (this.inputPhase === "committed") {
      throw new Error("Cannot append audio until the committed realtime response is created or cleared");
    }
    const encoded = pcm16ToBase64(audio, this.inputAudioFormat);
    this.sendReady({
      type: "input_audio_buffer.append",
      audio: encoded,
    });
    this.inputPhase = "buffered";
    if (this.provider === "xai") this.meteredInputAudioBytes += audio.data.byteLength;
  }

  prepareResponse(preparation: RealtimeResponsePreparation): void {
    this.assertConversationHistoryNotHydrating();
    if (this.turnDetectionMode === "server_vad") {
      throw new Error("Use prepareServerVadTurn before audio in provider-native server-VAD mode");
    }
    this.assertNoPendingToolBatch();
    if (this.currentState !== "ready") throw new Error("Realtime client is not ready");
    if (this.inputPhase !== "buffered") {
      throw new Error("Realtime response preparation requires buffered uncommitted audio");
    }
    if (this.pendingResponsePreparation) throw new Error("Realtime response is already prepared");
    if (!preparation.additionalInstructions.trim()) {
      throw new Error("Realtime response preparation instructions cannot be empty");
    }
    if (preparation.contextAuthority !== "advisory_only_gateway_and_speech_gate_enforced") {
      throw new Error("Realtime response preparation authority boundary mismatch");
    }
    if (!/^[a-f0-9]{64}$/.test(preparation.contextSha256)
        || createHash("sha256").update(preparation.additionalInstructions).digest("hex") !== preparation.contextSha256) {
      throw new Error("Realtime response preparation hash mismatch");
    }
    this.pendingResponsePreparation = Object.freeze({ ...preparation });
  }

  prepareToolContinuation(preparation: RealtimeResponsePreparation): void {
    this.assertConversationHistoryNotHydrating();
    if (this.currentState !== "ready") throw new Error("Realtime client is not ready");
    if (!this.pendingToolBatch || !this.pendingToolBatchResponseId) {
      throw new Error("Realtime tool continuation requires one pending provider tool-call batch");
    }
    if (this.pendingResponsePreparation || this.pendingToolContinuationPreparation) {
      throw new Error("Realtime tool continuation response is already prepared");
    }
    if (!preparation.additionalInstructions.trim()) {
      throw new Error("Realtime tool continuation instructions cannot be empty");
    }
    if (preparation.contextAuthority !== "advisory_only_gateway_and_speech_gate_enforced") {
      throw new Error("Realtime tool continuation authority boundary mismatch");
    }
    if (!/^[a-f0-9]{64}$/.test(preparation.contextSha256)
        || createHash("sha256").update(preparation.additionalInstructions).digest("hex") !== preparation.contextSha256) {
      throw new Error("Realtime tool continuation hash mismatch");
    }
    this.pendingToolContinuationPreparation = Object.freeze({ ...preparation });
  }

  prepareServerVadTurn(
    preparation: RealtimeServerVadTurnPreparation,
    timeoutMs = this.connectTimeoutMs,
  ): Promise<RealtimeServerVadTurnAcknowledgement> {
    try {
      this.assertConversationHistoryNotHydrating();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (this.provider !== "xai" || this.turnDetectionMode !== "server_vad") {
      return Promise.reject(new Error("Provider-native server-VAD turn preparation is available only for xAI server_vad sessions"));
    }
    this.assertNoPendingToolBatch();
    if (this.currentState !== "ready") return Promise.reject(new Error("Realtime client is not ready"));
    if (this.inputPhase !== "empty" || this.pendingResponsePreparation || this.pendingServerVadTurn) {
      return Promise.reject(new Error("A prior realtime turn is still active"));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("Server-VAD session acknowledgement timeout must be positive"));
    }
    if (!preparation.additionalInstructions.trim()
      || preparation.contextAuthority !== "advisory_only_gateway_and_speech_gate_enforced"
      || !/^[a-f0-9]{64}$/.test(preparation.contextSha256)
      || sha256Text(preparation.additionalInstructions) !== preparation.contextSha256
      || !/^[a-f0-9]{64}$/.test(preparation.toolFrontierSha256)
      || !/^[a-f0-9]{64}$/.test(preparation.transportParitySha256)) {
      return Promise.reject(new Error("Server-VAD turn preparation integrity failed"));
    }
    let tools: unknown;
    try {
      tools = structuredClone(preparation.tools);
    } catch {
      return Promise.reject(new Error("Server-VAD tool frontier must be structured-cloneable"));
    }
    if (!Array.isArray(tools)
      || tools.length > 1
      || tools.some((tool) => !isSafeLocalToolProxyFunction(tool))) {
      return Promise.reject(new Error("Server-VAD turn requires zero or one exact closed local capability gateway"));
    }
    const expectedFrontierSha256 = realtimeToolFrontierSha256(tools);
    if (preparation.toolFrontierSha256 !== expectedFrontierSha256) {
      return Promise.reject(new Error("Server-VAD tool frontier hash mismatch"));
    }
    const baseSession = record(this.sessionUpdate.session);
    const frozenTools = Array.isArray(baseSession.tools) ? baseSession.tools : [];
    if (canonicalJson(tools) !== canonicalJson(frozenTools)) {
      return Promise.reject(new Error("Server-VAD tool frontier must equal the frozen matched-pair gateway schema"));
    }
    const expectedTransportParitySha256 = xaiServerVadTransportParitySha256(
      this.sessionUpdate,
      this.requestedModel,
    );
    if (preparation.transportParitySha256 !== expectedTransportParitySha256) {
      return Promise.reject(new Error("Server-VAD transport parity hash mismatch"));
    }
    const requestedUpdate = {
      type: "session.update",
      session: {
        ...baseSession,
        instructions: [this.baseInstructions, preparation.additionalInstructions].filter(Boolean).join("\n"),
        tools,
        tool_choice: "auto",
      },
    };
    // Start a fresh diagnostic lifecycle. In provider-native VAD mode the
    // provider, rather than an outbound response.create, initiates generation;
    // responseGenerationRequested is promoted when response.started arrives.
    this.responseGenerationRequested = false;
    this.responseGenerationStarted = false;
    this.responseTerminalObserved = false;
    const turnOrdinal = ++this.serverVadTurnOrdinal;
    return new Promise<RealtimeServerVadTurnAcknowledgement>((resolve, reject) => {
      const pending: PendingServerVadTurn = {
        connectionEpoch: this.connectionEpoch,
        turnOrdinal,
        requestedUpdate,
        preparation: Object.freeze({ ...preparation, tools: Object.freeze(tools) }),
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingServerVadTurn !== pending) return;
          this.pendingServerVadTurn = null;
          reject(new Error(`Server-VAD session acknowledgement timed out after ${timeoutMs} ms`));
        }, timeoutMs),
        phase: "awaiting_session_ack",
      };
      this.pendingServerVadTurn = pending;
      try {
        pending.outboundObservation = this.sendReady(requestedUpdate, {
          sha256: preparation.contextSha256,
          byteLength: Buffer.byteLength(preparation.additionalInstructions, "utf8"),
          authority: preparation.contextAuthority,
          toolFrontierSha256: preparation.toolFrontierSha256,
          transportParitySha256: preparation.transportParitySha256,
          delivery: "session.update_before_audio",
        });
      } catch (error) {
        clearTimeout(pending.timer);
        this.pendingServerVadTurn = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  commitInputAudio(): void {
    if (this.turnDetectionMode === "server_vad") {
      throw new Error("input_audio_buffer.commit is forbidden in provider-native server-VAD mode");
    }
    this.assertNoPendingToolBatch();
    if (this.inputPhase !== "buffered") throw new Error("Realtime input audio is not buffered for commit");
    const pendingCommit: PendingInputCommit = {
      connectionEpoch: this.connectionEpoch,
      commitOrdinal: ++this.inputCommitOrdinal,
      acknowledgement: null,
      waiters: new Set(),
    };
    while (this.pendingInputCommits.length >= MAX_PENDING_INPUT_COMMITS) {
      const oldest = this.pendingInputCommits[0]!;
      if (oldest.waiters.size > 0) {
        throw new Error(`Input audio commit acknowledgement queue exceeded ${MAX_PENDING_INPUT_COMMITS} entries`);
      }
      this.pendingInputCommits.shift();
      if (!oldest.acknowledgement) this.discardedInputCommitAcknowledgements += 1;
    }
    this.pendingInputCommits.push(pendingCommit);
    try {
      this.sendReady({ type: "input_audio_buffer.commit" });
      this.inputPhase = "committed";
    } catch (error) {
      this.pendingInputCommits.pop();
      throw error;
    }
  }

  waitForInputAudioCommit(timeoutMs = this.connectTimeoutMs): Promise<RealtimeInputAudioCommitAcknowledgement> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("Input audio commit acknowledgement timeout must be positive"));
    }
    const pending = this.pendingInputCommits.at(-1);
    if (!pending || pending.connectionEpoch !== this.connectionEpoch) {
      return Promise.reject(new Error("No input audio commit is awaiting acknowledgement"));
    }
    if (pending.acknowledgement) {
      this.pendingInputCommits.splice(this.pendingInputCommits.indexOf(pending), 1);
      return Promise.resolve(observerSnapshot(pending.acknowledgement));
    }
    return new Promise<RealtimeInputAudioCommitAcknowledgement>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          pending.waiters.delete(waiter);
          reject(new Error(
            `Input audio commit acknowledgement timed out after ${timeoutMs} ms `
            + `(provider=${this.provider}; commit=${pending.commitOrdinal})`,
          ));
        }, timeoutMs),
      };
      pending.waiters.add(waiter);
    });
  }

  clearInputAudio(): void {
    this.sendReady({ type: "input_audio_buffer.clear" });
    this.pendingResponsePreparation = null;
    this.inputPhase = "empty";
  }

  createResponse(overrides: Record<string, unknown> = {}): void {
    this.assertNoPendingToolBatch();
    if (this.turnDetectionMode === "server_vad" && !this.pendingToolContinuationResponseId) {
      throw new Error("Initial response.create is forbidden in provider-native server-VAD mode");
    }
    const preparation = this.pendingResponsePreparation ?? this.pendingToolContinuationPreparation;
    if (preparation && Object.prototype.hasOwnProperty.call(overrides, "instructions")) {
      throw new Error("Prepared response instructions cannot be overridden");
    }
    if (this.pendingResponsePreparation && this.pendingToolContinuationPreparation) {
      throw new Error("Realtime response has conflicting audio-turn and tool-continuation control");
    }
    if (this.inputPhase === "buffered") throw new Error("Commit realtime input audio before creating its response");
    const response = preparation
      ? {
          ...overrides,
          instructions: [this.baseInstructions, preparation.additionalInstructions].filter(Boolean).join("\n"),
        }
      : overrides;
    const continuationOrigin = this.pendingToolContinuationResponseId;
    const responseCreateObservation = this.sendReady({
      type: "response.create",
      ...(Object.keys(response).length ? { response } : {}),
    }, preparation ? {
      sha256: preparation.contextSha256,
      byteLength: Buffer.byteLength(preparation.additionalInstructions, "utf8"),
      authority: preparation.contextAuthority,
    } : undefined);
    this.responseGenerationRequested = true;
    this.responseGenerationStarted = false;
    this.responseTerminalObserved = false;
    if (this.pendingToolContinuationResponseId) {
      this.emit({
        type: "tool.continuation.requested",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType: "response.create",
        originResponseId: this.pendingToolContinuationResponseId,
        responseIdSource: "provider",
        wireObservation: CLIENT_GENERATED_WIRE_ATTRIBUTION,
      });
      this.pendingToolContinuationResponseId = null;
      if (this.turnDetectionMode === "server_vad") {
        this.awaitingServerVadContinuationOriginId = continuationOrigin;
        this.awaitingServerVadContinuationObservationSha256 = responseCreateObservation?.observationSha256 ?? null;
      }
    }
    if (preparation) {
      this.pendingResponsePreparation = null;
      this.pendingToolContinuationPreparation = null;
    }
    if (this.inputPhase === "committed") this.inputPhase = "empty";
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
    if (this.turnDetectionMode === "server_vad") {
      throw new Error("sendTurn cannot bypass the asynchronous server-VAD preparation barrier");
    }
    this.assertNoPendingToolBatch();
    if (this.inputPhase !== "empty" || this.pendingResponsePreparation) {
      throw new Error("A prior realtime input turn is still active");
    }
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
    this.inputPhase = "buffered";
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

  async hydrateConversationHistory(
    turns: readonly RealtimeConversationHistoryTurn[],
    timeoutMs = this.connectTimeoutMs,
  ): Promise<RealtimeConversationHistoryHydrationAcknowledgement> {
    if (this.currentState !== "ready") {
      throw new Error(`Conversation history hydration requires a ready realtime session (state: ${this.currentState})`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Conversation history item acknowledgement timeout must be positive");
    }
    if (this.conversationHistoryHydrationStarted || this.conversationHistoryHydrationInProgress) {
      throw new Error("Conversation history can be hydrated exactly once per realtime connection");
    }
    if (this.xaiConversationReplayRequested) {
      throw new Error(
        "Manual conversation history hydration cannot be combined with xAI conversation resumption",
      );
    }
    if (
      this.conversationActivityStarted
      || this.inputPhase !== "empty"
      || this.pendingResponsePreparation !== null
      || this.pendingToolContinuationPreparation !== null
      || this.pendingToolBatch !== null
      || this.pendingToolContinuationResponseId !== null
      || this.pendingServerVadTurn !== null
      || this.responseGenerationRequested
      || this.responseGenerationStarted
    ) {
      throw new Error("Conversation history must be hydrated before the first live realtime turn");
    }

    const hydration = snapshotConversationHistory(turns);
    for (const item of hydration.wireItems) {
      if (item.kind !== "synthetic_tool_call") continue;
      const toolName = stringValue(record(item.expectedItem).name);
      if (toolName === undefined || !this.declaredFunctionToolNames.has(toolName)) {
        throw new Error(
          `Conversation history tool ${String(toolName)} is not declared in the realtime session`,
        );
      }
    }
    const syntheticToolCalls = hydration.wireItems.filter(
      (item) => item.kind === "synthetic_tool_call",
    ).length;
    if (
      this.providerWireToolCalls.size + syntheticToolCalls
      > this.maximumTrackedIdentities
    ) {
      throw new Error(
        `Conversation history tool identities exceed the realtime identity ledger limit `
        + `of ${this.maximumTrackedIdentities}`,
      );
    }
    this.conversationHistoryHydrationStarted = true;
    this.conversationHistoryHydrationInProgress = true;
    const acknowledgedItems: RealtimeConversationHistoryHydratedItemAcknowledgement[] = [];
    try {
      for (const expected of hydration.wireItems) {
        const acknowledgement = await new Promise<RealtimeConversationHistoryHydratedItemAcknowledgement>(
          (resolve, reject) => {
            const pending: PendingConversationHistoryItem = {
              expected,
              resolve,
              reject,
              timer: setTimeout(() => {
                if (this.pendingConversationHistoryItem !== pending) return;
                this.pendingConversationHistoryItem = null;
                reject(new Error(
                  `Conversation history item ${expected.providerItemOrdinal} acknowledgement `
                  + `timed out after ${timeoutMs} ms`,
                ));
              }, timeoutMs),
            };
            this.pendingConversationHistoryItem = pending;
            try {
              this.conversationHistoryAuthorizedWireEvent = expected.event;
              pending.outboundObservation = this.sendReady(expected.event);
              if (!pending.outboundObservation) {
                throw new Error("Conversation history outbound wire evidence was not captured");
              }
              if (this.provider === "xai" && expected.kind !== "synthetic_tool_output") {
                this.meteredBillableTextInputEvents += 1;
              }
            } catch (error) {
              clearTimeout(pending.timer);
              if (this.pendingConversationHistoryItem === pending) {
                this.pendingConversationHistoryItem = null;
              }
              reject(error instanceof Error ? error : new Error(String(error)));
            } finally {
              this.conversationHistoryAuthorizedWireEvent = null;
            }
          },
        );
        acknowledgedItems.push(acknowledgement);
      }
      if (acknowledgedItems.length !== hydration.wireItems.length) {
        throw new Error("Conversation history acknowledgement count changed during hydration");
      }
      return observerSnapshot({
        schemaVersion: 1 as const,
        provider: this.provider,
        connectionEpoch: this.connectionEpoch,
        status: acknowledgedItems.some((item) => item.providerContentOmission !== undefined)
          ? "identity_acknowledged_content_unverifiable" as const
          : "acknowledged" as const,
        turnCount: hydration.turnCount,
        providerItemCount: hydration.wireItems.length,
        historySha256: hydration.historySha256,
        sourceBindingSha256: hydration.sourceBindingSha256,
        items: acknowledgedItems,
      });
    } catch (error) {
      const message = `Conversation history hydration became indeterminate: ${errorMessage(error)}`;
      this.failConnection(message, "conversation_history_hydration_failed");
      throw new Error(message);
    } finally {
      this.conversationHistoryAuthorizedWireEvent = null;
      this.conversationHistoryHydrationInProgress = false;
      this.rejectPendingConversationHistoryItem("Conversation history hydration ended before item acknowledgement");
    }
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
      const responseId = this.pendingToolBatchResponseId;
      if (!responseId) throw new Error("Provider tool-call batch is missing its response identity");
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
      if (createResponse && this.pendingToolContinuationPreparation) {
        throw new Error("Prepared tool continuation requires explicit createResponse delivery");
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
        this.pendingToolBatchResponseId = null;
        if (createResponse) {
          this.sendReady({ type: "response.create" });
        } else {
          this.pendingToolContinuationResponseId = responseId;
        }
        this.emit({
          type: "tool.results.submitted",
          provider: this.provider,
          receivedAtMs: this.now(),
          wireType: "client.tool_results.submitted",
          responseId,
          responseIdSource: "provider",
          callIds: serialized.map((result) => result.callId),
          continuationRequested: createResponse,
          wireObservation: CLIENT_GENERATED_WIRE_ATTRIBUTION,
        });
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
    this.pendingResponsePreparation = null;
    this.pendingToolContinuationPreparation = null;
    this.inputPhase = "empty";
    this.pendingXaiResumption = null;
    this.pendingToolBatch = null;
    this.pendingToolBatchResponseId = null;
    this.pendingToolContinuationResponseId = null;
    this.awaitingServerVadContinuationOriginId = null;
    this.awaitingServerVadContinuationObservationSha256 = null;
    this.rejectPendingServerVadTurn("Realtime socket closed before the server-VAD turn completed");
    this.rejectPendingConversationHistoryItem(
      "Realtime socket closed before conversation history item acknowledgement",
    );
    this.rejectInputCommitWaiters("Realtime client closed before input audio commit acknowledgement");
    this.pendingInputCommits.length = 0;
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
    // Both documented OpenAI-compatible transports accept session.update as
    // the first client event.  Do not wait for a provider-created snapshot:
    // xAI deployments may acknowledge the update without emitting one, and
    // withholding configuration leaves the socket in provider defaults.
    this.sendInitialSessionUpdate();
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
      this.conversationHistoryHydrationInProgress
      && !CONVERSATION_HISTORY_ALLOWED_INBOUND_WIRE_TYPES.has(String(parsed.event.type))
    ) {
      const wireType = String(parsed.event.type);
      const message = `Provider emitted ${wireType} while conversation history hydration was awaiting item acknowledgement`;
      const wireObservation = this.notifyWireListeners(parsed.event, exactSerialized);
      this.emit({
        type: "error",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType,
        code: "conversation_history_hydration_interleaved",
        message,
        fatal: true,
        ...optional(
          "wireObservation",
          wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
        ),
      });
      this.failConnection(message, "conversation_history_hydration_interleaved", false);
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
      const requestedUpdate = this.pendingServerVadTurn?.phase === "awaiting_session_ack"
        ? this.pendingServerVadTurn.requestedUpdate
        : this.sessionUpdate;
      const acknowledgement = validatePcmSessionAcknowledgement(
        this.provider,
        parsed.event,
        this.inputAudioFormat,
        this.outputAudioFormat,
        this.xaiResumptionEnabled,
        requestedTurnDetectionMode(this.provider, requestedUpdate),
      );
      configurationAcknowledgement = buildSessionConfigurationAcknowledgement({
        provider: this.provider,
        requestedUpdate,
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
      mismatches.push(...unexpectedProviderCapabilityWidening(requestedUpdate, parsed.event));
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
    const wireObservation = this.notifyWireListeners(
      parsed.event,
      exactSerialized,
      configurationAcknowledgement,
    );

    if (parsed.event.type === "error" && this.conversationHistoryHydrationInProgress) {
      const providerError = record(parsed.event.error);
      const diagnostic = createRealtimeTransportFailureDiagnostic({
        origin: "provider_wire",
        rawCode: stringValue(providerError.code) ?? stringValue(providerError.type),
        message: stringValue(providerError.message) ?? "Provider rejected conversation history hydration",
        responseGenerationRequested: false,
        responseGenerationStarted: false,
        responseTerminalObserved: false,
      });
      const message = `Provider rejected conversation history item ${
        this.pendingConversationHistoryItem?.expected.providerItemOrdinal ?? "unknown"
      }`;
      this.emit({
        type: "error",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType: "error",
        code: "conversation_history_provider_rejected",
        message,
        fatal: true,
        details: {
          category: diagnostic.category,
          ...optional("safeRawCode", diagnostic.safeRawCode),
          ...optional("messageSha256", diagnostic.messageSha256),
        },
        transportDiagnostic: diagnostic,
        ...optional(
          "wireObservation",
          wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
        ),
      });
      this.failConnection(
        message,
        "conversation_history_provider_rejected",
        false,
        diagnostic,
      );
      return;
    }

    if (
      parsed.event.type === "conversation.item.added"
      || parsed.event.type === "conversation.item.created"
      || parsed.event.type === "conversation.item.done"
    ) {
      const acknowledgementError = parsed.event.type === "conversation.item.done"
        ? this.validateConversationHistoryItemDone(parsed.event)
        : this.acknowledgeConversationHistoryItem(parsed.event, wireObservation);
      if (acknowledgementError) {
        this.emit({
          type: "error",
          provider: this.provider,
          receivedAtMs: this.now(),
          wireType: String(parsed.event.type),
          code: "conversation_history_acknowledgement_invalid",
          message: acknowledgementError,
          fatal: true,
          ...optional(
            "wireObservation",
            wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
          ),
        });
        this.failConnection(
          acknowledgementError,
          "conversation_history_acknowledgement_invalid",
          false,
        );
        return;
      }
    }

    if (parsed.event.type === "session.updated"
      && this.pendingServerVadTurn?.phase === "awaiting_session_ack"
      && configurationAcknowledgement) {
      const pending = this.pendingServerVadTurn;
      clearTimeout(pending.timer);
      pending.phase = "ready_for_audio";
      const acknowledgement = Object.freeze({
        provider: "xai" as const,
        connectionEpoch: pending.connectionEpoch,
        turnOrdinal: pending.turnOrdinal,
        status: "acknowledged" as const,
        contextSha256: pending.preparation.contextSha256,
        toolFrontierSha256: pending.preparation.toolFrontierSha256,
        transportParitySha256: pending.preparation.transportParitySha256,
        configuration: observerSnapshot(configurationAcknowledgement),
        ...optional(
          "outboundObservation",
          pending.outboundObservation === undefined
            ? undefined
            : realtimeWireObservationReference(pending.outboundObservation),
        ),
        ...optional(
          "inboundObservation",
          wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
        ),
      });
      pending.resolve(acknowledgement);
    }

    for (const normalizedEvent of normalized) {
      let event = withWireObservation(normalizedEvent, wireObservation);
      if (event.type === "response.started") {
        if (this.turnDetectionMode === "server_vad") this.responseGenerationRequested = true;
        this.responseGenerationStarted = true;
      }
      if (event.type === "response.completed") this.responseTerminalObserved = true;
      if (event.type === "error") {
        event = {
          ...event,
          transportDiagnostic: createRealtimeTransportFailureDiagnostic({
            origin: "provider_wire",
            rawCode: event.code,
            message: event.message,
            responseGenerationRequested: this.responseGenerationRequested,
            responseGenerationStarted: this.responseGenerationStarted,
            responseTerminalObserved: this.responseTerminalObserved,
          }),
        };
      }
      if (event.type === "tool.calls") {
        event = {
          ...event,
          calls: event.calls.map((call) => ({ ...call, responseIdSource: "provider" as const })),
        };
      }
      if (event.type === "session.ready" && configurationAcknowledgement) {
        event = { ...event, configuration: configurationAcknowledgement };
      }
      if (event.type === "input.audio_commit_acknowledgement") {
        if (this.turnDetectionMode === "server_vad") {
          const turn = this.pendingServerVadTurn;
          if (!turn || turn.phase !== "speech_stopped" || !wireObservation) {
            const message = "xAI server-VAD auto-commit was not bound to one stopped-speech turn";
            this.emit({
              type: "error", provider: this.provider, receivedAtMs: this.now(),
              wireType: event.wireType, code: "server_vad_auto_commit_unbound", message, fatal: true,
              ...optional("wireObservation", event.wireObservation),
            });
            this.failConnection(message, "server_vad_auto_commit_unbound", false);
            return;
          }
          turn.phase = "auto_committed";
          turn.autoCommitObservationSha256 = wireObservation.observationSha256;
          this.inputPhase = "empty";
          this.emit({
            type: "input.audio_committed",
            provider: "xai",
            receivedAtMs: event.receivedAtMs,
            wireType: event.wireType,
            connectionEpoch: turn.connectionEpoch,
            commitOrdinal: turn.turnOrdinal,
            ...optional("wireObservation", event.wireObservation),
          });
        } else {
          this.acknowledgeInputAudioCommit(wireObservation);
        }
        continue;
      }
      if (event.type === "input.speech_activity") {
        if (this.turnDetectionMode === "server_vad") {
          const turn = this.pendingServerVadTurn;
          const observed = event.wireObservation?.availability === "observed"
            ? event.wireObservation.observationSha256
            : undefined;
          const valid = turn !== null && observed !== undefined && (
            event.phase === "started"
              ? turn.phase === "ready_for_audio"
              : turn.phase === "speech_started"
          );
          if (!valid || !turn) {
            const message = `xAI server-VAD ${event.phase} event violated the frozen turn lifecycle`;
            this.emit({
              type: "error", provider: this.provider, receivedAtMs: event.receivedAtMs,
              wireType: event.wireType, code: "server_vad_event_order_invalid", message, fatal: true,
              ...optional("wireObservation", event.wireObservation),
            });
            this.failConnection(message, "server_vad_event_order_invalid", false);
            return;
          }
          if (event.phase === "started") {
            turn.phase = "speech_started";
            turn.speechStartObservationSha256 = observed;
          } else {
            turn.phase = "speech_stopped";
            turn.speechStopObservationSha256 = observed;
          }
        } else {
        const fatal = this.unexpectedManualTurnDetectionPolicy === "fail";
        const message = `Provider emitted ${event.wireType} while manual turn detection was requested`;
        this.emit({
          type: "error",
          provider: this.provider,
          receivedAtMs: event.receivedAtMs,
          wireType: event.wireType,
          code: "unexpected_manual_turn_detection_event",
          message,
          fatal,
          details: {
            classification: "manual_mode_provider_vad_activity",
            phase: event.phase,
            policy: this.unexpectedManualTurnDetectionPolicy,
          },
          ...optional("wireObservation", event.wireObservation),
        });
        if (fatal) {
          this.failConnection(message, "unexpected_manual_turn_detection_event", false);
          return;
        }
        continue;
        }
      }

      if (this.turnDetectionMode === "server_vad" && event.type === "response.started") {
        const turn = this.pendingServerVadTurn;
        if (!turn || !turn.speechStopObservationSha256) {
          const message = "xAI response started without an active server-VAD caller turn";
          this.failConnection(message, "server_vad_auto_response_unbound");
          return;
        }
        if (turn.initialResponseId === undefined) {
          if (turn.phase !== "auto_committed") {
            const message = "xAI initial response started before the server-VAD auto-commit";
            this.failConnection(message, "server_vad_response_before_auto_commit");
            return;
          }
          turn.phase = "response_started";
          turn.initialResponseId = event.responseId;
          turn.activeResponseId = event.responseId;
          event = {
            ...event,
            causalBinding: {
              trigger: "server_vad_speech_stopped",
              turnOrdinal: turn.turnOrdinal,
              triggerObservationSha256: turn.speechStopObservationSha256,
            },
          };
        } else {
          const origin = this.awaitingServerVadContinuationOriginId;
          if (!origin || origin === event.responseId) {
            const message = "xAI emitted a duplicate or unrequested response for one server-VAD turn";
            this.failConnection(message, "server_vad_duplicate_response");
            return;
          }
          const continuationObservation = this.awaitingServerVadContinuationObservationSha256;
          if (!continuationObservation) {
            const message = "xAI tool continuation response lacks its outbound trigger binding";
            this.failConnection(message, "server_vad_continuation_unbound");
            return;
          }
          event = {
            ...event,
            causalBinding: {
              trigger: "tool_continuation",
              turnOrdinal: turn.turnOrdinal,
              triggerObservationSha256: continuationObservation,
              originResponseId: origin,
            },
          };
          turn.activeResponseId = event.responseId;
          this.awaitingServerVadContinuationOriginId = null;
          this.awaitingServerVadContinuationObservationSha256 = null;
        }
      }
      if (this.turnDetectionMode === "server_vad"
        && (event.type === "turn.interrupted"
          || (event.type === "provider.event" && event.wireType === "input_audio_buffer.timeout_triggered"))) {
        const message = event.type === "turn.interrupted"
          ? "Interruptions are prohibited in the frozen xAI server-VAD benchmark transport"
          : "xAI server-VAD idle timeout created an unplanned caller turn";
        this.failConnection(message, event.type === "turn.interrupted" ? "server_vad_interruption" : "server_vad_idle_timeout");
        return;
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
        this.pendingToolBatchResponseId = event.responseId;
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
          if (this.pendingToolBatch.size === 0) {
            this.pendingToolBatch = null;
            this.pendingToolBatchResponseId = null;
          }
        }
      }
      if (this.turnDetectionMode === "server_vad" && event.type === "response.completed") {
        const turn = this.pendingServerVadTurn;
        if (!turn || turn.activeResponseId !== event.responseId) {
          const message = "xAI response terminal was not bound to the active server-VAD response";
          this.failConnection(message, "server_vad_terminal_unbound");
          return;
        }
        if (event.status !== "completed") {
          const message = `xAI server-VAD response ended with ${event.status}`;
          this.failConnection(message, "server_vad_terminal_failed");
          return;
        }
        if (!this.pendingToolBatch?.size) {
          turn.phase = "terminal";
          this.pendingServerVadTurn = null;
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
    const message = errorMessage(error) || "Realtime WebSocket failed";
    this.failConnection(message, "transport_error", true, createRealtimeTransportFailureDiagnostic({
      origin: "websocket_error",
      rawCode: errorCode(error),
      message,
      responseGenerationRequested: this.responseGenerationRequested,
      responseGenerationStarted: this.responseGenerationStarted,
      responseTerminalObserved: this.responseTerminalObserved,
    }));
  }

  private onSocketClose(code?: number, reason?: unknown): void {
    const wasConnecting = this.currentState === "connecting";
    const wasFailed = this.currentState === "failed";
    this.pendingXaiResumption = null;
    this.pendingToolBatch = null;
    this.pendingToolBatchResponseId = null;
    this.pendingToolContinuationResponseId = null;
    this.awaitingServerVadContinuationOriginId = null;
    this.awaitingServerVadContinuationObservationSha256 = null;
    this.rejectPendingServerVadTurn("Realtime socket closed before the server-VAD turn completed");
    this.rejectPendingConversationHistoryItem(
      "Realtime socket closed before conversation history item acknowledgement",
    );
    this.rejectInputCommitWaiters("Realtime socket closed before input audio commit acknowledgement");
    this.pendingInputCommits.length = 0;
    this.pendingResponsePreparation = null;
    this.pendingToolContinuationPreparation = null;
    this.inputPhase = "empty";
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
      transportDiagnostic: createRealtimeTransportFailureDiagnostic({
        origin: "websocket_close",
        closeCode: code,
        reason,
        responseGenerationRequested: this.responseGenerationRequested,
        responseGenerationStarted: this.responseGenerationStarted,
        responseTerminalObserved: this.responseTerminalObserved,
      }),
      wireObservation: TRANSPORT_GENERATED_WIRE_ATTRIBUTION,
    });
  }

  private failConnection(
    message: string,
    code: string,
    emit = true,
    transportDiagnostic = createRealtimeTransportFailureDiagnostic({
      origin: "client_transport",
      rawCode: code,
      message,
      responseGenerationRequested: this.responseGenerationRequested,
      responseGenerationStarted: this.responseGenerationStarted,
      responseTerminalObserved: this.responseTerminalObserved,
    }),
  ): void {
    if (this.currentState === "failed" || this.currentState === "closed") return;
    this.currentState = "failed";
    this.pendingResponsePreparation = null;
    this.pendingToolContinuationPreparation = null;
    this.inputPhase = "empty";
    this.pendingXaiResumption = null;
    this.pendingToolBatch = null;
    this.pendingToolBatchResponseId = null;
    this.pendingToolContinuationResponseId = null;
    this.awaitingServerVadContinuationOriginId = null;
    this.awaitingServerVadContinuationObservationSha256 = null;
    this.rejectPendingServerVadTurn(message);
    this.rejectPendingConversationHistoryItem(message);
    this.rejectInputCommitWaiters(message);
    this.pendingInputCommits.length = 0;
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
        transportDiagnostic,
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

  private rejectPendingServerVadTurn(reason: string): void {
    const pending = this.pendingServerVadTurn;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingServerVadTurn = null;
    pending.reject(new Error(reason));
  }

  private rejectPendingConversationHistoryItem(reason: string): void {
    const pending = this.pendingConversationHistoryItem;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingConversationHistoryItem = null;
    pending.reject(new Error(reason));
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private acknowledgeInputAudioCommit(wireObservation?: RealtimeWireObservation): void {
    if (this.discardedInputCommitAcknowledgements > 0) {
      this.discardedInputCommitAcknowledgements -= 1;
      this.emit({
        type: "error",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType: "input_audio_buffer.committed",
        code: "input_audio_commit_acknowledgement_unverifiable",
        message: "Provider commit acknowledgement arrived after its bounded FIFO correlation record was discarded",
        fatal: false,
        details: { classification: "bounded_fifo_correlation_lost" },
        ...optional(
          "wireObservation",
          wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
        ),
      });
      return;
    }
    const pending = this.pendingInputCommits.find((candidate) => (
      candidate.connectionEpoch === this.connectionEpoch && candidate.acknowledgement === null
    ));
    if (!pending || pending.connectionEpoch !== this.connectionEpoch || pending.acknowledgement) {
      const message = "Provider acknowledged an input audio commit without one matching pending commit";
      this.emit({
        type: "error",
        provider: this.provider,
        receivedAtMs: this.now(),
        wireType: "input_audio_buffer.committed",
        code: "unexpected_input_audio_commit_acknowledgement",
        message,
        fatal: false,
        details: { classification: "unmatched_commit_acknowledgement" },
        ...optional(
          "wireObservation",
          wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
        ),
      });
      return;
    }
    const acknowledgement = Object.freeze({
      provider: this.provider,
      connectionEpoch: this.connectionEpoch,
      commitOrdinal: pending.commitOrdinal,
      status: "acknowledged" as const,
      ...optional(
        "wireObservation",
        wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
      ),
    });
    pending.acknowledgement = acknowledgement;
    const hadWaiters = pending.waiters.size > 0;
    for (const waiter of pending.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(observerSnapshot(acknowledgement));
    }
    pending.waiters.clear();
    if (hadWaiters) {
      const index = this.pendingInputCommits.indexOf(pending);
      if (index >= 0) this.pendingInputCommits.splice(index, 1);
    }
    this.emit({
      type: "input.audio_committed",
      provider: this.provider,
      receivedAtMs: this.now(),
      wireType: "input_audio_buffer.committed",
      connectionEpoch: this.connectionEpoch,
      commitOrdinal: pending.commitOrdinal,
      ...optional(
        "wireObservation",
        wireObservation === undefined ? undefined : realtimeWireObservationReference(wireObservation),
      ),
    });
  }

  private acknowledgeConversationHistoryItem(
    event: Record<string, unknown>,
    wireObservation?: RealtimeWireObservation,
  ): string | undefined {
    const itemId = stringValue(record(event.item).id);
    const pending = this.pendingConversationHistoryItem;
    if (!pending) {
      if (itemId !== undefined && this.acknowledgedConversationHistoryItems.has(itemId)) {
        return `Provider duplicated acknowledged conversation history item ${itemId}`;
      }
      if (this.conversationHistoryHydrationInProgress) {
        return "Provider emitted an uncorrelated conversation item acknowledgement during history hydration";
      }
      return undefined;
    }
    if (!wireObservation) {
      return "Conversation history inbound wire evidence was not captured";
    }
    const validation = conversationHistoryItemAcknowledgementValidation(
      this.provider,
      event,
      pending.expected,
    );
    if (validation.error) return validation.error;
    if (this.acknowledgedConversationHistoryItems.has(pending.expected.itemId)) {
      return `Provider duplicated acknowledged conversation history item ${pending.expected.itemId}`;
    }
    if (!pending.outboundObservation) {
      return "Conversation history acknowledgement lacks its outbound wire evidence";
    }
    clearTimeout(pending.timer);
    this.pendingConversationHistoryItem = null;
    this.acknowledgedConversationHistoryItems.set(
      pending.expected.itemId,
      pending.expected,
    );
    if (pending.expected.syntheticCallId !== undefined) {
      this.hydratedConversationHistoryCallIds.add(pending.expected.syntheticCallId);
    }
    pending.resolve(observerSnapshot({
      historyTurnOrdinal: pending.expected.historyTurnOrdinal,
      providerItemOrdinal: pending.expected.providerItemOrdinal,
      kind: pending.expected.kind,
      sourceSha256: pending.expected.sourceSha256,
      ...(pending.expected.syntheticCallId === undefined
        ? {}
        : {
            syntheticCallIdSha256: realtimeWireIdentitySha256(
              "call",
              pending.expected.syntheticCallId,
            ),
          }),
      ...(validation.providerContentOmission === undefined
        ? {}
        : { providerContentOmission: Object.freeze(validation.providerContentOmission) }),
      outboundObservation: realtimeWireObservationReference(pending.outboundObservation),
      inboundObservation: realtimeWireObservationReference(wireObservation),
    }));
    return undefined;
  }

  private validateConversationHistoryItemDone(
    event: Record<string, unknown>,
  ): string | undefined {
    const itemId = stringValue(record(event.item).id);
    const expected = itemId === undefined
      ? undefined
      : this.acknowledgedConversationHistoryItems.get(itemId);
    if (!expected) {
      return this.conversationHistoryHydrationInProgress
        ? "Provider completed an uncorrelated conversation item during history hydration"
        : undefined;
    }
    return conversationHistoryItemAcknowledgementValidation(
      this.provider,
      event,
      expected,
    ).error;
  }

  private rejectInputCommitWaiters(reason: string): void {
    for (const pending of this.pendingInputCommits) {
      if (pending.acknowledgement) continue;
      for (const waiter of pending.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      pending.waiters.clear();
    }
  }

  private sendReady(
    event: Record<string, unknown>,
    dynamicControl?: WireDynamicControlEvidence,
  ): RealtimeWireObservation | undefined {
    if (this.currentState !== "ready") {
      throw new Error(`Realtime session is not ready (state: ${this.currentState})`);
    }
    const hydrationSendAuthorized = event === this.conversationHistoryAuthorizedWireEvent;
    if (this.conversationHistoryHydrationInProgress && !hydrationSendAuthorized) {
      throw new Error("A live realtime operation cannot interleave conversation history hydration");
    }
    if (!hydrationSendAuthorized && event.type !== "session.update") {
      this.conversationActivityStarted = true;
    }
    return this.sendRaw(event, dynamicControl);
  }

  private assertNoPendingToolBatch(): void {
    if (this.pendingToolBatch?.size) {
      throw new Error(
        `Resolve the complete tool-call batch before continuing: ${[...this.pendingToolBatch].join(", ")}`,
      );
    }
  }

  private assertConversationHistoryNotHydrating(): void {
    if (this.conversationHistoryHydrationInProgress) {
      throw new Error("A live realtime operation cannot interleave conversation history hydration");
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
      if (this.hydratedConversationHistoryCallIds.has(call.callId)) {
        return `Provider reused hydrated conversation history tool call id ${call.callId} for executable work`;
      }
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

  private sendInitialSessionUpdate(): boolean {
    if (this.initialSessionUpdateSent) return true;
    if (this.currentState !== "connecting") return false;
    try {
      this.sendRaw(this.sessionUpdate);
      this.initialSessionUpdateSent = true;
      return true;
    } catch (error) {
      this.failConnection(errorMessage(error), "session_update_send_failed");
      return false;
    }
  }

  private sendRaw(
    event: Record<string, unknown>,
    dynamicControl?: WireDynamicControlEvidence,
  ): RealtimeWireObservation | undefined {
    if (!this.socket) throw new Error("Realtime WebSocket is not connected");
    const serialized = JSON.stringify(event);
    this.socket.send(serialized);
    return this.notifyWireObservation("outbound", event, serialized, dynamicControl);
  }

  private emit(event: NormalizedRealtimeEvent): void {
    for (const listener of this.eventListeners) {
      safelyNotify(() => listener(observerSnapshot(event)));
    }
  }

  private notifyWireListeners(
    event: Record<string, unknown>,
    exactSerialized?: string,
    configurationEvidence?: SessionConfigurationAcknowledgement,
  ): RealtimeWireObservation | undefined {
    for (const listener of this.wireListeners) {
      safelyNotify(() => listener(observerSnapshot(event)));
    }
    return this.notifyWireObservation("inbound", event, exactSerialized, undefined, configurationEvidence);
  }

  private notifyWireObservation(
    direction: "inbound" | "outbound",
    event: Record<string, unknown>,
    exactSerialized?: string,
    dynamicControl?: WireDynamicControlEvidence,
    configurationEvidence?: SessionConfigurationAcknowledgement,
  ): RealtimeWireObservation | undefined {
    if (!this.wireObservationListeners.size && !this.conversationHistoryHydrationInProgress) {
      return undefined;
    }
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
      ...(dynamicControl ? { dynamicControl } : {}),
      ...(configurationEvidence ? { configurationEvidence } : {}),
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

type ConversationHistorySnapshot = Readonly<{
  turnCount: number;
  historySha256: string;
  sourceBindingSha256: string;
  wireItems: readonly ConversationHistoryWireItem[];
}>;

type NormalizedConversationHistoryTurn =
  | Readonly<{
      role: "user" | "assistant";
      text: string;
      sourceSha256: string;
    }>
  | Readonly<{
      role: "tool_batch";
      calls: readonly RealtimeConversationHistoryToolCall[];
    }>;

const MAX_CONVERSATION_HISTORY_TOOL_CALLS_PER_BATCH = 128;
const MAX_CONVERSATION_HISTORY_TOOL_BATCH_BYTES = 256 * 1_024;

function snapshotConversationHistory(
  input: readonly RealtimeConversationHistoryTurn[],
): ConversationHistorySnapshot {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Conversation history hydration requires at least one turn");
  }
  if (input.length > MAX_CONVERSATION_HISTORY_TURNS) {
    throw new Error(
      `Conversation history exceeds ${MAX_CONVERSATION_HISTORY_TURNS} turns`,
    );
  }
  let detached: unknown;
  try {
    detached = structuredClone(input);
  } catch {
    throw new Error("Conversation history must be structured-cloneable");
  }
  if (!Array.isArray(detached) || detached.length !== input.length) {
    throw new Error("Conversation history changed during canonicalization");
  }

  const normalized: NormalizedConversationHistoryTurn[] = [];
  let providerItemCount = 0;
  const providerVisible: Array<
    | Readonly<{ role: "user" | "assistant"; text: string }>
    | Readonly<{
        role: "tool_batch";
        calls: readonly Readonly<{
          toolName: string;
          toolArguments: Readonly<Record<string, RealtimeConversationHistoryJsonValue>>;
          output: string;
        }>[];
      }>
  > = [];
  for (const [index, candidate] of detached.entries()) {
    if (!isRecord(candidate)) {
      throw new Error(`Conversation history turn ${index + 1} must be an object`);
    }
    if (candidate.role === "user" || candidate.role === "assistant") {
      const role: "user" | "assistant" = candidate.role;
      const sourceSha256 = assertConversationHistorySourceSha256(
        candidate.sourceSha256,
        index + 1,
      );
      if (typeof candidate.text !== "string" || !candidate.text.trim()) {
        throw new Error(`Conversation history turn ${index + 1} text is empty`);
      }
      assertConversationHistoryFieldBytes(candidate.text, index + 1, "text");
      const turn = deepFreeze({
        role,
        text: candidate.text,
        sourceSha256,
      });
      providerItemCount += 1;
      if (providerItemCount > MAX_CONVERSATION_HISTORY_PROVIDER_ITEMS) {
        throw new Error(
          `Conversation history exceeds ${MAX_CONVERSATION_HISTORY_PROVIDER_ITEMS} provider items`,
        );
      }
      normalized.push(turn);
      providerVisible.push(deepFreeze({ role: turn.role, text: turn.text }));
      continue;
    }
    if (candidate.role !== "tool" && candidate.role !== "tool_batch") {
      throw new Error(`Conversation history turn ${index + 1} role is invalid`);
    }
    const rawCalls = candidate.role === "tool"
      ? [candidate]
      : candidate.calls;
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
      throw new Error(`Conversation history turn ${index + 1} tool batch must be non-empty`);
    }
    if (rawCalls.length > MAX_CONVERSATION_HISTORY_TOOL_CALLS_PER_BATCH) {
      throw new Error(
        `Conversation history turn ${index + 1} tool batch exceeds `
        + `${MAX_CONVERSATION_HISTORY_TOOL_CALLS_PER_BATCH} calls`,
      );
    }
    providerItemCount += rawCalls.length * 2;
    if (providerItemCount > MAX_CONVERSATION_HISTORY_PROVIDER_ITEMS) {
      throw new Error(
        `Conversation history exceeds ${MAX_CONVERSATION_HISTORY_PROVIDER_ITEMS} provider items`,
      );
    }
    const calls = rawCalls.map((rawCall, callIndex) => (
      snapshotConversationHistoryToolCall(rawCall, index + 1, callIndex + 1)
    ));
    const visibleCalls = calls.map((call) => deepFreeze({
      toolName: call.toolName,
      toolArguments: call.toolArguments,
      output: call.output,
    }));
    const batchBytes = Buffer.byteLength(canonicalJson(visibleCalls), "utf8");
    if (batchBytes > MAX_CONVERSATION_HISTORY_TOOL_BATCH_BYTES) {
      throw new Error(
        `Conversation history turn ${index + 1} tool batch is ${batchBytes} UTF-8 bytes; `
        + `limit is ${MAX_CONVERSATION_HISTORY_TOOL_BATCH_BYTES}`,
      );
    }
    const turn = deepFreeze({
      role: "tool_batch" as const,
      calls,
    });
    normalized.push(turn);
    providerVisible.push(deepFreeze({
      role: "tool_batch" as const,
      calls: visibleCalls,
    }));
  }

  const providerVisibleJson = canonicalJson(providerVisible);
  const providerVisibleBytes = Buffer.byteLength(providerVisibleJson, "utf8");
  if (providerVisibleBytes > MAX_CONVERSATION_HISTORY_TOTAL_BYTES) {
    throw new Error(
      `Conversation history provider-visible content is ${providerVisibleBytes} UTF-8 bytes; `
      + `limit is ${MAX_CONVERSATION_HISTORY_TOTAL_BYTES}`,
    );
  }
  const historySha256 = sha256Text(
    `${CONVERSATION_HISTORY_HASH_DOMAIN}${providerVisibleJson}`,
  );
  const sourceBindingSha256 = sha256Text(
    `${CONVERSATION_HISTORY_SOURCE_BINDING_DOMAIN}${canonicalJson({
      historySha256,
      sources: normalized.map((turn, index) => {
        if (turn.role === "user" || turn.role === "assistant") {
          return {
            ordinal: index + 1,
            sourceSha256: turn.sourceSha256,
          };
        }
        const batch = turn as Extract<
          NormalizedConversationHistoryTurn,
          { role: "tool_batch" }
        >;
        return {
          ordinal: index + 1,
          role: "tool_batch",
          calls: batch.calls.map((call, callIndex) => ({
            callOrdinal: callIndex + 1,
            sourceSha256: call.sourceSha256,
          })),
        };
      }),
    })}`,
  );

  const wireItems: ConversationHistoryWireItem[] = [];
  const nextItemId = (kind: RealtimeConversationHistoryHydratedItemKind): string => {
    const providerItemOrdinal = wireItems.length + 1;
    const suffix = sha256Text(
      `${historySha256}\0${providerItemOrdinal}\0${kind}`,
    ).slice(0, 24);
    return `${CONVERSATION_HISTORY_ITEM_ID_PREFIX}${String(providerItemOrdinal).padStart(4, "0")}_${suffix}`;
  };
  const pushWireItem = (inputItem: Omit<ConversationHistoryWireItem, "providerItemOrdinal" | "event">) => {
    const providerItemOrdinal = wireItems.length + 1;
    const expectedItem = deepFreeze(inputItem.expectedItem);
    wireItems.push(deepFreeze({
      ...inputItem,
      providerItemOrdinal,
      expectedItem,
      event: {
        type: "conversation.item.create",
        item: expectedItem,
      },
    }));
  };

  for (const [index, turn] of normalized.entries()) {
    const historyTurnOrdinal = index + 1;
    if (turn.role === "user" || turn.role === "assistant") {
      const kind = turn.role === "user" ? "user_message" : "assistant_message";
      const itemId = nextItemId(kind);
      pushWireItem({
        historyTurnOrdinal,
        kind,
        sourceSha256: turn.sourceSha256,
        itemId,
        expectedItem: {
          id: itemId,
          type: "message",
          role: turn.role,
          content: [{
            type: turn.role === "user" ? "input_text" : "output_text",
            text: turn.text,
          }],
        },
      });
      continue;
    }
    const toolBatch = turn as Extract<NormalizedConversationHistoryTurn, { role: "tool_batch" }>;
    const syntheticCalls = toolBatch.calls.map((call, callIndex) => ({
      call,
      syntheticCallId:
        `hacc_hist_call_${String(historyTurnOrdinal).padStart(4, "0")}_${
          String(callIndex + 1).padStart(3, "0")
        }_${sha256Text(
          `${historySha256}\0${historyTurnOrdinal}\0${callIndex + 1}\0tool`,
        ).slice(0, 24)}`,
    }));
    for (const { call, syntheticCallId } of syntheticCalls) {
      const callItemId = nextItemId("synthetic_tool_call");
      pushWireItem({
        historyTurnOrdinal,
        kind: "synthetic_tool_call",
        sourceSha256: call.sourceSha256,
        itemId: callItemId,
        syntheticCallId,
        expectedItem: {
          id: callItemId,
          type: "function_call",
          call_id: syntheticCallId,
          name: call.toolName,
          arguments: canonicalJson(call.toolArguments),
        },
      });
    }
    for (const { call, syntheticCallId } of syntheticCalls) {
      const outputItemId = nextItemId("synthetic_tool_output");
      pushWireItem({
        historyTurnOrdinal,
        kind: "synthetic_tool_output",
        sourceSha256: call.sourceSha256,
        itemId: outputItemId,
        syntheticCallId,
        expectedItem: {
          id: outputItemId,
          type: "function_call_output",
          call_id: syntheticCallId,
          output: call.output,
        },
      });
    }
  }
  if (wireItems.length !== providerItemCount) {
    throw new Error("Conversation history provider item count changed during canonicalization");
  }
  return deepFreeze({
    turnCount: normalized.length,
    historySha256,
    sourceBindingSha256,
    wireItems,
  });
}

function snapshotConversationHistoryToolCall(
  candidate: unknown,
  turnOrdinal: number,
  callOrdinal: number,
): RealtimeConversationHistoryToolCall {
  const label = `Conversation history turn ${turnOrdinal} tool call ${callOrdinal}`;
  if (!isRecord(candidate)) throw new Error(`${label} must be an object`);
  if (
    typeof candidate.toolName !== "string"
    || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(candidate.toolName)
  ) {
    throw new Error(`${label} toolName is invalid`);
  }
  if (!isRecord(candidate.toolArguments)) {
    throw new Error(`${label} toolArguments must be a JSON object`);
  }
  const jsonError = conversationHistoryJsonError(candidate.toolArguments);
  if (jsonError) throw new Error(`${label} toolArguments ${jsonError}`);
  const toolArguments = candidate.toolArguments as Readonly<
    Record<string, RealtimeConversationHistoryJsonValue>
  >;
  assertConversationHistoryFieldBytes(
    canonicalJson(toolArguments),
    turnOrdinal,
    `tool call ${callOrdinal} toolArguments`,
  );
  if (typeof candidate.output !== "string") {
    throw new Error(`${label} output must be a string`);
  }
  assertConversationHistoryFieldBytes(
    candidate.output,
    turnOrdinal,
    `tool call ${callOrdinal} output`,
  );
  return deepFreeze({
    toolName: candidate.toolName,
    toolArguments,
    output: candidate.output,
    sourceSha256: assertConversationHistorySourceSha256(
      candidate.sourceSha256,
      turnOrdinal,
      callOrdinal,
    ),
  });
}

function assertConversationHistorySourceSha256(
  value: unknown,
  turnOrdinal: number,
  callOrdinal?: number,
): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(
      `Conversation history turn ${turnOrdinal}${
        callOrdinal === undefined ? "" : ` tool call ${callOrdinal}`
      } sourceSha256 is invalid`,
    );
  }
  return value;
}

function assertConversationHistoryFieldBytes(
  value: string,
  turnOrdinal: number,
  field: string,
): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_CONVERSATION_HISTORY_FIELD_BYTES) {
    throw new Error(
      `Conversation history turn ${turnOrdinal} ${field} is ${bytes} UTF-8 bytes; `
      + `limit is ${MAX_CONVERSATION_HISTORY_FIELD_BYTES}`,
    );
  }
}

function conversationHistoryJsonError(value: unknown): string | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_CONVERSATION_HISTORY_JSON_NODES) {
      return `exceeds ${MAX_CONVERSATION_HISTORY_JSON_NODES} JSON nodes`;
    }
    if (current.depth > MAX_CONVERSATION_HISTORY_JSON_DEPTH) {
      return `exceeds JSON depth ${MAX_CONVERSATION_HISTORY_JSON_DEPTH}`;
    }
    if (
      current.value === null
      || typeof current.value === "string"
      || typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return "contains a non-finite number";
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) return "contains a non-JSON value";
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return "contains a non-JSON object";
    }
    for (const child of Object.values(current.value)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

type ConversationHistoryItemAcknowledgementValidation = Readonly<{
  error?: string;
  providerContentOmission?: Readonly<{
    field: "arguments";
    observedShape: "empty_string";
  }>;
}>;

function conversationHistoryItemAcknowledgementValidation(
  provider: OpenAICompatibleProvider,
  event: Record<string, unknown>,
  expected: ConversationHistoryWireItem,
): ConversationHistoryItemAcknowledgementValidation {
  const item = record(event.item);
  if (item.id !== expected.itemId) {
    return {
      error: `Provider acknowledged conversation history item out of order; expected ${expected.itemId}`,
    };
  }
  const expectedItem = expected.expectedItem;
  if (expected.kind === "user_message" || expected.kind === "assistant_message") {
    if (
      item.type !== "message"
      || item.role !== expectedItem.role
      || !Array.isArray(item.content)
      || item.content.length !== 1
    ) {
      return { error: `Provider altered conversation history message ${expected.itemId}` };
    }
    const actualContent = record(item.content[0]);
    const expectedContent = record((expectedItem.content as readonly unknown[])[0]);
    if (
      actualContent.type !== expectedContent.type
      || actualContent.text !== expectedContent.text
    ) {
      return { error: `Provider altered conversation history message content ${expected.itemId}` };
    }
    return {};
  }
  if (expected.kind === "synthetic_tool_call") {
    if (
      item.type !== "function_call"
      || item.call_id !== expectedItem.call_id
      || item.name !== expectedItem.name
    ) {
      return { error: `Provider altered synthetic conversation history tool call ${expected.itemId}` };
    }
    if (item.arguments === expectedItem.arguments) return {};
    if (
      provider === "xai"
      && event.type === "conversation.item.added"
      && typeof expectedItem.arguments === "string"
      && expectedItem.arguments.length > 0
      && item.arguments === ""
    ) {
      return {
        providerContentOmission: {
          field: "arguments",
          observedShape: "empty_string",
        },
      };
    }
    return { error: `Provider altered synthetic conversation history tool call ${expected.itemId}` };
  }
  if (
    item.type !== "function_call_output"
    || item.call_id !== expectedItem.call_id
    || item.output !== expectedItem.output
  ) {
    return { error: `Provider altered synthetic conversation history tool output ${expected.itemId}` };
  }
  return {};
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
  dynamicControl?: WireDynamicControlEvidence;
  configurationEvidence?: SessionConfigurationAcknowledgement;
}>;

type WireDynamicControlEvidence = Readonly<{
  sha256: string;
  byteLength: number;
  authority: RealtimeResponsePreparation["contextAuthority"];
  toolFrontierSha256?: string;
  transportParitySha256?: string;
  delivery?: "session.update_before_audio";
}>;

const SAFE_WIRE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROVIDER_ERROR_CODES = new Set([
  "authentication_error",
  "connection_error",
  "content_filter",
  "insufficient_quota",
  "invalid_request",
  "invalid_request_error",
  "input_audio_buffer_commit_empty",
  "input_audio_buffer_commit_audio_too_short",
  "input_audio_buffer_too_small",
  "permission_denied",
  "rate_limit",
  "rate_limit_exceeded",
  "response_generation_failed",
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
  if (session !== undefined) projection.session = {
    ...session,
    ...(input.configurationEvidence === undefined
      ? {}
      : { configurationEvidence: input.configurationEvidence }),
  };

  const audio = audioWireProjection(input.event, wireType, input.inputAudioFormat, input.outputAudioFormat);
  if (audio !== undefined) projection.audio = audio;

  const gatewayCalls = gatewayCallWireProjection(input.event);
  if (gatewayCalls.length) projection.gatewayCalls = gatewayCalls;
  const gatewayResults = gatewayResultWireProjection(input.event, input.localToolProxyEnabled);
  if (gatewayResults.length) projection.gatewayResults = gatewayResults;

  const text = textWireProjection(input.event, wireType);
  if (text.length) projection.text = text;

  const conversationHistoryItem = conversationHistoryItemWireProjection(input.event, wireType);
  if (conversationHistoryItem !== undefined) {
    projection.conversationHistoryItem = conversationHistoryItem;
  }

  const usage = usageWireProjection(input.event);
  if (usage !== undefined) projection.usage = usage;

  const providerError = providerErrorWireProjection(input.event, wireType);
  if (providerError !== undefined) projection.error = providerError;

  if (input.direction === "outbound"
    && (wireType === "response.create" || wireType === "session.update")
    && input.dynamicControl) {
    projection.dynamicControl = input.dynamicControl;
  }

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
    .filter((call) => (
      call.name === LOCAL_TOOL_PROXY_FUNCTION_NAME
      && !call.itemId?.startsWith(CONVERSATION_HISTORY_ITEM_ID_PREFIX)
    ))
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
  const itemId = stringValue(item.id);
  if (itemId?.startsWith(CONVERSATION_HISTORY_ITEM_ID_PREFIX)) return [];
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
  const values: Array<{ kind: "input_text" | "output_text" | "transcript"; value: string }> = [];
  if (
    wireType === "conversation.item.create"
    || wireType === "conversation.item.added"
    || wireType === "conversation.item.created"
    || wireType === "conversation.item.done"
  ) {
    const item = record(event.item);
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        const content = record(part);
        if (content.type === "input_text" && typeof content.text === "string") {
          values.push({ kind: "input_text", value: content.text });
        } else if (content.type === "output_text" && typeof content.text === "string") {
          values.push({ kind: "output_text", value: content.text });
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

function conversationHistoryItemWireProjection(
  event: Record<string, unknown>,
  wireType: string,
): Record<string, unknown> | undefined {
  if (
    wireType !== "conversation.item.create"
    && wireType !== "conversation.item.added"
    && wireType !== "conversation.item.created"
    && wireType !== "conversation.item.done"
  ) {
    return undefined;
  }
  const item = record(event.item);
  const itemId = stringValue(item.id);
  if (!itemId?.startsWith(CONVERSATION_HISTORY_ITEM_ID_PREFIX)) return undefined;
  if (item.type === "message" && Array.isArray(item.content) && item.content.length === 1) {
    const content = record(item.content[0]);
    const text = stringValue(content.text);
    if (
      (item.role !== "user" && item.role !== "assistant")
      || (content.type !== "input_text" && content.type !== "output_text")
      || text === undefined
    ) {
      return { kind: "invalid_history_message" };
    }
    return {
      kind: item.role === "user" ? "user_message" : "assistant_message",
      role: item.role,
      contentType: content.type,
      contentSha256: sha256Text(text),
      contentBytes: Buffer.byteLength(text, "utf8"),
    };
  }
  if (item.type === "function_call") {
    const argumentsText = stringValue(item.arguments);
    const name = stringValue(item.name);
    const evidence = jsonTextEvidence(argumentsText);
    return {
      kind: "synthetic_tool_call",
      nameSha256: sha256Text(name ?? ""),
      nameBytes: Buffer.byteLength(name ?? "", "utf8"),
      namePresent: name !== undefined,
      argumentsSha256: evidence.sha256,
      argumentsBytes: evidence.byteLength,
      argumentsPresent: argumentsText !== undefined,
      argumentsJsonValid: evidence.validJson,
    };
  }
  if (item.type === "function_call_output") {
    const output = stringValue(item.output);
    return {
      kind: "synthetic_tool_output",
      outputSha256: sha256Text(output ?? ""),
      outputBytes: Buffer.byteLength(output ?? "", "utf8"),
      outputPresent: output !== undefined,
    };
  }
  return { kind: "invalid_history_item" };
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
  const message = stringValue(record(event.error).message) ?? stringValue(event.message);
  const diagnostic = createRealtimeTransportFailureDiagnostic({
    origin: "provider_wire",
    rawCode: code,
    message,
    responseGenerationRequested: false,
    responseGenerationStarted: false,
    responseTerminalObserved: false,
  });
  return {
    code: code !== undefined && SAFE_PROVIDER_ERROR_CODES.has(code) ? code : "provider_error",
    category: diagnostic.category,
    ...optional("rawCodeSha256", diagnostic.rawCodeSha256),
    ...optional("messageSha256", diagnostic.messageSha256),
  };
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

function requestedTurnDetectionMode(
  provider: OpenAICompatibleProvider,
  update: Record<string, unknown>,
): "manual" | "server_vad" {
  const session = record(update.session);
  // OpenAI-compatible inputs are compiled into the provider's documented
  // manual-PCM shape below. Only xAI's session-level server_vad opt-in changes
  // the transport state machine; stale/nested input fields never do.
  if (provider === "openai") return "manual";
  const requested = session.turn_detection;
  if (requested === undefined || requested === null) return "manual";
  if (isRecord(requested) && requested.type === null) return "manual";
  if (provider === "xai" && isRecord(requested) && requested.type === "server_vad") return "server_vad";
  throw new Error(`${provider} realtime session must explicitly request manual turns${provider === "xai" ? " or documented server_vad" : ""}`);
}

/** Clones and pins the documented xAI provider-native server-VAD PCM mode. */
export function withXaiServerVadPcmSession(
  update: Record<string, unknown>,
  input: Pcm16Format = PCM16_MONO_24KHZ,
  output: Pcm16Format = PCM16_MONO_24KHZ,
): Record<string, unknown> {
  assertPcm16Format(input);
  assertPcm16Format(output);
  assertProviderPcmFormat("xai", input, "input");
  assertProviderPcmFormat("xai", output, "output");
  const sourceSession = record(update.session);
  const sourceDetection = record(sourceSession.turn_detection);
  if (sourceDetection.type !== "server_vad") {
    throw new Error("xAI provider-native turn handling requires turn_detection.type server_vad");
  }
  const sourceAudio = record(sourceSession.audio);
  const sourceInput = record(sourceAudio.input);
  const sourceOutput = record(sourceAudio.output);
  const sourceInputWithoutTurnDetection = { ...sourceInput };
  delete sourceInputWithoutTurnDetection.turn_detection;
  return {
    ...update,
    type: "session.update",
    session: {
      ...sourceSession,
      turn_detection: { ...sourceDetection, type: "server_vad" },
      audio: {
        ...sourceAudio,
        input: { ...sourceInputWithoutTurnDetection, format: { type: "audio/pcm", rate: input.sampleRateHz } },
        output: { ...sourceOutput, format: { type: "audio/pcm", rate: output.sampleRateHz } },
      },
    },
  };
}

export function xaiServerVadTransportParitySha256(
  update: Record<string, unknown>,
  requestedModel?: string,
): string {
  const session = record(update.session);
  const audio = record(session.audio);
  const projection = {
    provider: "xai",
    model: requestedModel ?? null,
    voice: session.voice ?? null,
    turn_detection: session.turn_detection ?? null,
    input_audio: record(audio.input),
    output_audio: record(audio.output),
    tool_choice: session.tool_choice ?? null,
    tools: Array.isArray(session.tools) ? session.tools : [],
    resumption: session.resumption ?? null,
  };
  return sha256Text(
    `harshas-amazing-call-center/xai-server-vad-transport-parity/v1\n${canonicalJson(projection)}`,
  );
}

export function realtimeToolFrontierSha256(tools: readonly unknown[]): string {
  return sha256Text(
    `harshas-amazing-call-center/realtime-tool-frontier/v1\n${canonicalJson(tools)}`,
  );
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
  return validatePcmSessionAcknowledgement(provider, event, input, output, expectXaiResumption, "manual");
}

export function validatePcmSessionAcknowledgement(
  provider: OpenAICompatibleProvider,
  event: Record<string, unknown>,
  input: Pcm16Format = PCM16_MONO_24KHZ,
  output: Pcm16Format = PCM16_MONO_24KHZ,
  expectXaiResumption = false,
  turnDetectionMode: "manual" | "server_vad" = "manual",
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
  } else if (turnDetectionMode === "manual") {
    const xaiTurnDetection = session.turn_detection;
    if (!isRecord(xaiTurnDetection) || (
      Object.keys(xaiTurnDetection).length > 0
      && xaiTurnDetection.type !== null
    )) {
      mismatches.push("xAI session.turn_detection.type is not null");
    } else if (Object.keys(xaiTurnDetection).length === 0) {
      // Non-contradictory transport acknowledgement only. The independent
      // configuration proof keeps the missing `type:null` echo unverifiable.
    }
    if (acknowledgedInput.turn_detection !== undefined && acknowledgedInput.turn_detection !== null) {
      mismatches.push("xAI returned an active audio.input turn detector");
    }
    if (expectXaiResumption && record(session.resumption).enabled !== true) {
      mismatches.push("xAI resumption.enabled was not acknowledged");
    }
  } else {
    const xaiTurnDetection = session.turn_detection;
    if (!isRecord(xaiTurnDetection) || (
      Object.keys(xaiTurnDetection).length > 0
      && xaiTurnDetection.type !== "server_vad"
    )) {
      mismatches.push("xAI session.turn_detection.type is not server_vad");
    }
    if (acknowledgedInput.turn_detection !== undefined && acknowledgedInput.turn_detection !== null) {
      mismatches.push("xAI returned an unexpected audio.input turn detector");
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
  const rawAcknowledgedSession = record(input.acknowledgedEvent.session);
  const toolAliasNormalization = input.provider === "xai"
    ? normalizeXaiFunctionToolAliases(requestedSession.tools, rawAcknowledgedSession.tools)
    : null;
  const acknowledgedSession = toolAliasNormalization?.accepted === true
    ? { ...rawAcknowledgedSession, tools: toolAliasNormalization.canonicalAcknowledged }
    : rawAcknowledgedSession;
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
      field === "tools" && toolAliasNormalization?.accepted === true
        ? toolAliasNormalization.evidence
        : undefined,
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
      : session.turn_detection,
  };
}

function configurationFieldProof(
  field: SessionConfigurationField | "session",
  requestedRaw: unknown,
  acknowledgedRaw: unknown,
  acknowledgedBy: "session.created" | "session.updated",
  aliasNormalization?: NonNullable<SessionConfigurationFieldProof["aliasNormalization"]>,
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
      omission: Object.freeze({
        kind: "field_omitted" as const,
        paths: Object.freeze([field]),
        acknowledgedShape: "missing" as const,
      }),
    });
  }
  // Tool declarations and tool-choice policy are executable capability
  // identity. Provider-added object keys, schema branches, or array members
  // must never be hidden by the safe requested-key projection used for
  // descriptive/non-capability session fields.
  const projection = field === "tools"
    ? projectToolCapabilityAcknowledgement(requested, acknowledged, field)
    : field === "tool_choice"
      ? projectExactCapabilityAcknowledgement(requested, acknowledged, field)
      : projectAcknowledgedValue(requested, acknowledged, field);
  const acknowledgedSha256 = configurationHash(field, projection.value);
  if (projection.mismatched.length) {
    return Object.freeze({
      status: "mismatch" as const,
      requestedSha256,
      acknowledgedSha256,
      acknowledgedBy,
      reason: `Provider explicitly acknowledged different requested path(s): ${projection.mismatched.join(", ")}`,
      contradiction: Object.freeze({
        kind: "requested_paths_mismatched" as const,
        paths: Object.freeze([...projection.mismatched]),
      }),
      ...(projection.missing.length === 0
        ? {}
        : {
            omission: Object.freeze({
              kind: "requested_paths_omitted" as const,
              paths: Object.freeze([...projection.missing]),
              acknowledgedShape: isRecord(acknowledged) && Object.keys(acknowledged).length === 0
                ? "empty_object" as const
                : "partial_value" as const,
            }),
          }),
      ...(aliasNormalization === undefined ? {} : { aliasNormalization }),
    });
  }
  if (projection.missing.length) {
    return Object.freeze({
      status: "unverifiable" as const,
      requestedSha256,
      acknowledgedSha256,
      acknowledgedBy,
      reason: `Provider session.updated omitted requested path(s): ${projection.missing.join(", ")}`,
      omission: Object.freeze({
        kind: "requested_paths_omitted" as const,
        paths: Object.freeze([...projection.missing]),
        acknowledgedShape: isRecord(acknowledged) && Object.keys(acknowledged).length === 0
          ? "empty_object" as const
          : "partial_value" as const,
      }),
      ...(aliasNormalization === undefined ? {} : { aliasNormalization }),
    });
  }
  return Object.freeze({
    status: requestedSha256 === acknowledgedSha256 ? "verified" as const : "mismatch" as const,
    requestedSha256,
    acknowledgedSha256,
    acknowledgedBy,
    ...(requestedSha256 === acknowledgedSha256
      ? {}
      : { reason: "Provider explicitly acknowledged a different value" }),
    ...(aliasNormalization === undefined ? {} : { aliasNormalization }),
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

type ProjectedAcknowledgement = { value: unknown; missing: string[]; mismatched: string[] };

export const XAI_FUNCTION_TOOL_ALIAS_POLICY_SHA256 = sha256Text(
  `harshas-amazing-call-center/xai-function-tool-wire-alias/v1\n${canonicalJson({
    provider: "xai",
    flatKeys: ["description", "name", "parameters"],
    nestedWrapper: "function",
    exactCardinalityAndOrder: true,
    bothFormsRequireExactAgreement: true,
    unknownKeysFatal: true,
    schemaWideningFatal: true,
    claimBoundary: "wire_alias_equivalence_only_paid_exact_call_still_required",
  })}`,
);

type XaiToolAliasNormalization = Readonly<
  | { accepted: false }
  | {
      accepted: true;
      canonicalAcknowledged: readonly unknown[];
      evidence: NonNullable<SessionConfigurationFieldProof["aliasNormalization"]>;
    }
>;

const XAI_CALLABLE_KEYS = Object.freeze(["description", "name", "parameters"] as const);
const XAI_CALLABLE_KEY_SET = new Set<string>(XAI_CALLABLE_KEYS);

/**
 * xAI currently acknowledges a guide-compatible flat function declaration as
 * `{type:"function", function:{...}}`. This is a bijective wire alias only:
 * it never changes tool count/order or drops unknown capability-bearing keys.
 */
function normalizeXaiFunctionToolAliases(
  requestedRaw: unknown,
  acknowledgedRaw: unknown,
): XaiToolAliasNormalization | null {
  if (!Array.isArray(requestedRaw) || !Array.isArray(acknowledgedRaw)) return null;
  if (requestedRaw.length !== acknowledgedRaw.length) return { accepted: false };
  const canonicalAcknowledged: unknown[] = [];
  const sourcePaths: string[] = [];
  const keyInventory: Array<Readonly<{ path: string; keys: readonly string[] }>> = [];
  let usedAlias = false;
  for (let index = 0; index < requestedRaw.length; index += 1) {
    const requested = canonicalXaiFunctionTool(requestedRaw[index], `tools[${index}]`);
    const acknowledged = canonicalXaiFunctionTool(acknowledgedRaw[index], `tools[${index}]`);
    if (requested === null || acknowledged === null) return { accepted: false };
    canonicalAcknowledged.push(acknowledged.canonical);
    if (acknowledged.nested) {
      usedAlias = true;
      sourcePaths.push(...acknowledged.sourcePaths);
      keyInventory.push(...acknowledged.keyInventory);
    }
  }
  if (!usedAlias) return null;
  // Canonical cardinality/order is inherited from the arrays above. Missing
  // bounded metadata is deliberately left for the existing projection/Gate B.
  const canonicalSha256 = sha256Text(
    `harshas-amazing-call-center/xai-function-tool-canonical/v1\n${canonicalJson(canonicalAcknowledged)}`,
  );
  return Object.freeze({
    accepted: true as const,
    canonicalAcknowledged: Object.freeze(canonicalAcknowledged),
    evidence: Object.freeze({
      kind: "xai_function_tool_wire_alias_v1" as const,
      policySha256: XAI_FUNCTION_TOOL_ALIAS_POLICY_SHA256,
      sourcePaths: Object.freeze([...new Set(sourcePaths)].sort()),
      keyInventory: Object.freeze(keyInventory
        .map((entry) => Object.freeze({ path: entry.path, keys: Object.freeze([...entry.keys]) }))
        .sort((left, right) => left.path.localeCompare(right.path))),
      canonicalSha256,
      claimBoundary: "wire_alias_equivalence_only_paid_exact_call_still_required" as const,
    }),
  });
}

type CanonicalXaiFunctionTool = Readonly<{
  canonical: Readonly<Record<string, unknown>>;
  nested: boolean;
  sourcePaths: readonly string[];
  keyInventory: readonly Readonly<{ path: string; keys: readonly string[] }>[];
}>;

function canonicalXaiFunctionTool(raw: unknown, path: string): CanonicalXaiFunctionTool | null {
  if (!isRecord(raw) || raw.type !== "function") return null;
  const outerKeys = Object.keys(raw).sort();
  const hasNested = Object.prototype.hasOwnProperty.call(raw, "function");
  const flatKeys = XAI_CALLABLE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(raw, key));
  const allowedOuter = new Set(["type", ...(hasNested ? ["function"] : []), ...flatKeys]);
  if (outerKeys.some((key) => !allowedOuter.has(key))) return null;
  const flat = Object.fromEntries(flatKeys.map((key) => [key, raw[key]]));
  let callable = flat;
  const sourcePaths = [path];
  const keyInventory: Array<Readonly<{ path: string; keys: readonly string[] }>> = [
    Object.freeze({ path, keys: Object.freeze(outerKeys) }),
  ];
  if (hasNested) {
    if (!isRecord(raw.function)) return null;
    const nestedRecord = raw.function;
    const nestedKeys = Object.keys(nestedRecord).sort();
    if (nestedKeys.some((key) => !XAI_CALLABLE_KEY_SET.has(key))) return null;
    const nested = Object.fromEntries(nestedKeys.map((key) => [key, nestedRecord[key]]));
    if (flatKeys.length > 0 && canonicalJson(flat) !== canonicalJson(nested)) return null;
    callable = nested;
    sourcePaths.push(`${path}.function`);
    keyInventory.push(Object.freeze({ path: `${path}.function`, keys: Object.freeze(nestedKeys) }));
  }
  return Object.freeze({
    canonical: Object.freeze({ type: "function", ...callable }),
    nested: hasNested,
    sourcePaths: Object.freeze(sourcePaths),
    keyInventory: Object.freeze(keyInventory),
  });
}

function projectExactCapabilityAcknowledgement(
  requested: unknown,
  acknowledged: unknown,
  path: string,
): ProjectedAcknowledgement {
  return canonicalJson(requested) === canonicalJson(acknowledged)
    ? { value: acknowledged, missing: [], mismatched: [] }
    : { value: acknowledged, missing: [], mismatched: [path] };
}

function projectToolCapabilityAcknowledgement(
  requested: unknown,
  acknowledged: unknown,
  path: string,
): ProjectedAcknowledgement {
  if (Array.isArray(requested)) {
    if (!Array.isArray(acknowledged)) return { value: acknowledged, missing: [], mismatched: [path] };
    if (requested.length !== acknowledged.length) return { value: acknowledged, missing: [], mismatched: [path] };
    const values: unknown[] = [];
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (let index = 0; index < requested.length; index += 1) {
      const projected = projectToolCapabilityAcknowledgement(requested[index], acknowledged[index], `${path}[${index}]`);
      values.push(projected.value);
      missing.push(...projected.missing);
      mismatched.push(...projected.mismatched);
    }
    return { value: values, missing, mismatched };
  }
  if (isRecord(requested)) {
    if (!isRecord(acknowledged)) return { value: acknowledged, missing: [], mismatched: [path] };
    const value: Record<string, unknown> = {};
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const key of Object.keys(requested).sort()) {
      if (!(key in acknowledged)) {
        missing.push(`${path}.${key}`);
        continue;
      }
      const projected = projectToolCapabilityAcknowledgement(requested[key], acknowledged[key], `${path}.${key}`);
      value[key] = projected.value;
      missing.push(...projected.missing);
      mismatched.push(...projected.mismatched);
    }
    for (const key of Object.keys(acknowledged).sort()) {
      if (key in requested) continue;
      value[key] = acknowledged[key];
      mismatched.push(`${path}.${key}`);
    }
    return { value, missing, mismatched };
  }
  return {
    value: acknowledged,
    missing: [],
    mismatched: canonicalJson(requested) === canonicalJson(acknowledged) ? [] : [path],
  };
}

function projectAcknowledgedValue(
  requested: unknown,
  acknowledged: unknown,
  path: string,
): ProjectedAcknowledgement {
  if (Array.isArray(requested)) {
    if (!Array.isArray(acknowledged)) return { value: acknowledged, missing: [], mismatched: [path] };
    // Array membership and order are capability identity. Preserve a different
    // length in the hash rather than silently projecting injected/removed tools.
    if (requested.length !== acknowledged.length) return { value: acknowledged, missing: [], mismatched: [path] };
    const values: unknown[] = [];
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (let index = 0; index < requested.length; index += 1) {
      const projected = projectAcknowledgedValue(requested[index], acknowledged[index], `${path}[${index}]`);
      values.push(projected.value);
      missing.push(...projected.missing);
      mismatched.push(...projected.mismatched);
    }
    return { value: values, missing, mismatched };
  }
  if (isRecord(requested)) {
    if (!isRecord(acknowledged)) return { value: acknowledged, missing: [], mismatched: [path] };
    const value: Record<string, unknown> = {};
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const key of Object.keys(requested).sort()) {
      if (!(key in acknowledged)) {
        missing.push(`${path}.${key}`);
        continue;
      }
      const projected = projectAcknowledgedValue(requested[key], acknowledged[key], `${path}.${key}`);
      value[key] = projected.value;
      missing.push(...projected.missing);
      mismatched.push(...projected.mismatched);
    }
    return { value, missing, mismatched };
  }
  return {
    value: acknowledged,
    missing: [],
    mismatched: canonicalJson(requested) === canonicalJson(acknowledged) ? [] : [path],
  };
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

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
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
