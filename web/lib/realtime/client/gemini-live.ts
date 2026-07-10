import WebSocket from "ws";
import { createHash } from "node:crypto";
import { assertPcm16Audio, base64ToPcm16, pcm16ToBase64 } from "./audio";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  Pcm16Audio,
  RealtimeClientState,
  RealtimeEventListener,
  RealtimeToolResult,
  RealtimeWebSocket,
  RealtimeWebSocketFactory,
  RealtimeWireEventListener,
} from "./types";

export const GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ = 16_000;
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ = 24_000;
export const GEMINI_CAPABILITY_GATEWAY_NAME = "capability_gateway";
export const GEMINI_LIVE_DEFAULT_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOOL_RESPONSE_BYTES = 1024 * 1024;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GeminiGatewayInvocation = {
  callId: string;
  name: typeof GEMINI_CAPABILITY_GATEWAY_NAME;
  arguments: Record<string, JsonValue>;
  signal: AbortSignal;
};

export type GeminiGatewayExecutor = (invocation: GeminiGatewayInvocation) => Promise<unknown>;


export type GeminiLiveEvent = NormalizedRealtimeEvent;

export type GeminiLiveClientOptions = {
  apiKey?: string;
  /** An authenticated endpoint override. Useful with ephemeral tokens and test doubles. */
  url?: string;
  model: string;
  voice: string;
  instructions: string;
  resumeHandle?: string;
  executeCapabilityGateway?: GeminiGatewayExecutor;
  onEvent?: (event: GeminiLiveEvent) => void;
  onRawMessage?: (message: Readonly<Record<string, unknown>>, receivedAtMs: number) => void;
  webSocketFactory?: RealtimeWebSocketFactory;
  now?: () => number;
  monotonicNow?: () => number;
  connectTimeoutMs?: number;
  maxIncomingMessageBytes?: number;
  maxToolResponseBytes?: number;
};

type FunctionCall = {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  fingerprint?: string;
  identityConflict?: string;
};

type FunctionResponse = {
  id: string;
  name: string;
  response: Record<string, JsonValue>;
};

type PendingToolCall = {
  controller: AbortController;
  cancelled: boolean;
  response: Promise<FunctionResponse | null>;
};

type ResumptionState = {
  handle?: string;
  resumable: boolean;
  lastConsumedClientMessageIndex?: string;
};

type ConnectionBinding = {
  socket: RealtimeWebSocket;
  epoch: number;
};

type WireArrival = {
  wallMs: number;
  monotonicMs: number;
};

class TranscriptAssembler {
  text = "";
  final = false;

  ingest(fragment: string): { text: string; delta: string; revised: boolean } {
    if (!fragment) return { text: this.text, delta: "", revised: false };

    if (fragment === this.text || this.text.startsWith(fragment)) {
      return { text: this.text, delta: "", revised: fragment !== this.text };
    }
    if (fragment.startsWith(this.text)) {
      const delta = fragment.slice(this.text.length);
      this.text = fragment;
      return { text: this.text, delta, revised: false };
    }

    const comparableLength = Math.min(this.text.length, fragment.length);
    let sharedPrefix = 0;
    while (sharedPrefix < comparableLength && this.text[sharedPrefix] === fragment[sharedPrefix]) sharedPrefix += 1;
    if (sharedPrefix >= 4 && sharedPrefix / comparableLength >= 0.6) {
      this.text = fragment;
      return { text: this.text, delta: "", revised: true };
    }

    this.text += fragment;
    return { text: this.text, delta: fragment, revised: false };
  }

  reset() {
    this.text = "";
    this.final = false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Freeze a parsed JSON tree iteratively so observers cannot rewrite protocol state. */
function deepFreezeJson<T extends Record<string, unknown>>(root: T): Readonly<T> {
  const pending: object[] = [root];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(value);
  }
  return root;
}

function freezeNormalizedEvent<T extends object>(root: T): Readonly<T> {
  const pending: object[] = [root];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    // Typed-array elements cannot be frozen in JavaScript. Each observer gets
    // an independent structured clone, so those mutable bytes are never shared.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(value);
  }
  return root;
}

function safeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error.slice(0, 2_000));
  return new Error("Unknown Gemini Live error");
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function modalityTokens(details: unknown, modality: string): number | undefined {
  if (!Array.isArray(details)) return undefined;
  let found = false;
  let total = 0;
  for (const detail of details) {
    if (!isRecord(detail) || String(detail.modality ?? "").toUpperCase() !== modality) continue;
    const count = finiteToken(detail.tokenCount);
    if (count === undefined) continue;
    found = true;
    total += count;
  }
  return found ? total : undefined;
}

export function normalizeGeminiUsage(raw: Record<string, unknown>): NormalizedRealtimeUsage {
  const cachedAudioTokens = modalityTokens(raw.cacheTokensDetails, "AUDIO");
  const cachedTextTokens = modalityTokens(raw.cacheTokensDetails, "TEXT");
  const cachedTotal = finiteToken(raw.cachedContentTokenCount);
  return {
    totalInputTokens: finiteToken(raw.promptTokenCount),
    cachedInputAudioTokens: cachedAudioTokens,
    cachedInputTextTokens: cachedTextTokens,
    cachedInputTokens: cachedAudioTokens === undefined && cachedTextTokens === undefined ? cachedTotal : undefined,
    totalOutputTokens: finiteToken(raw.responseTokenCount),
    totalTokens: finiteToken(raw.totalTokenCount),
    inputAudioTokens: modalityTokens(raw.promptTokensDetails, "AUDIO"),
    inputTextTokens: modalityTokens(raw.promptTokensDetails, "TEXT"),
    outputAudioTokens: modalityTokens(raw.responseTokensDetails, "AUDIO"),
    outputTextTokens: modalityTokens(raw.responseTokensDetails, "TEXT"),
    raw,
  };
}

function jsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): JsonValue {
  if (depth > 40) return "[Maximum JSON depth exceeded]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (value instanceof Error) return { name: value.name, message: value.message.slice(0, 2_000) };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((entry) => jsonValue(entry, seen, depth + 1));
    seen.delete(value);
    return result;
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    result[key] = jsonValue(entry, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  const normalized = jsonValue(value);
  return isRecord(normalized) ? normalized as Record<string, JsonValue> : { value: normalized };
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function functionCallFingerprint(call: FunctionCall): string {
  return canonicalJson({
    name: typeof call.name === "string" ? call.name : "",
    arguments: jsonValue(call.args),
  });
}

function textBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function durationToMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) return undefined;
  const milliseconds = Number(match[1]) * 1_000;
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function handleDigest(handle: string): string {
  return `sha256:${createHash("sha256").update(handle).digest("hex")}`;
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (isRecord(data) && typeof data.text === "function") {
    const text = await (data.text as () => Promise<unknown>)();
    if (typeof text === "string") return text;
  }
  throw new Error("Gemini returned an unsupported WebSocket message type");
}

function encodedMessageBytes(data: unknown): number | undefined {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (isRecord(data) && typeof data.size === "number" && Number.isFinite(data.size)) return data.size;
  return undefined;
}

export function buildGeminiLiveUrl(apiKey: string, endpoint = GEMINI_LIVE_DEFAULT_ENDPOINT): string {
  if (!apiKey.trim()) throw new Error("GEMINI_API_KEY is required");
  const url = new URL(endpoint);
  url.searchParams.set("key", apiKey);
  return url.toString();
}

function capabilityGatewayDeclaration() {
  return {
    name: GEMINI_CAPABILITY_GATEWAY_NAME,
    description:
      "Invoke one operation through the runtime capability gateway. The runtime independently authorizes every operation and records its result.",
    behavior: "BLOCKING",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          description: "The exact operation currently offered by the runtime.",
        },
        arguments: {
          type: "object",
          description: "Arguments for that operation, using its currently offered schema.",
          additionalProperties: true,
        },
        grant: {
          type: "string",
          description: "The current runtime capability grant when the offered operation requires one.",
        },
        idempotency_key: {
          type: "string",
          description: "The offered idempotency key for a consequential operation, if present.",
        },
      },
      required: ["operation", "arguments"],
    },
  };
}

export function buildGeminiLiveSetup(options: Pick<
  GeminiLiveClientOptions,
  "model" | "voice" | "instructions" | "resumeHandle"
>): Record<string, unknown> {
  const model = options.model.startsWith("models/") ? options.model : `models/${options.model}`;
  return {
    setup: {
      model,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } },
        },
      },
      systemInstruction: { parts: [{ text: options.instructions }] },
      tools: [{ functionDeclarations: [capabilityGatewayDeclaration()] }],
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: {
        ...(options.resumeHandle ? { handle: options.resumeHandle } : {}),
      },
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

function defaultWebSocketFactory(url: string, options: { headers: Record<string, string> }): RealtimeWebSocket {
  return new WebSocket(url, { headers: options.headers }) as unknown as RealtimeWebSocket;
}

/**
 * Raw Gemini BidiGenerateContent client with a provider-neutral event surface.
 *
 * It deliberately exposes one fixed gateway declaration for the entire session.
 * Flow context and capability grants change behind that gateway, avoiding Gemini's
 * setup-time-only tool limitation without exposing every leaf action to the model.
 */
type NormalizedEventPayload<T = NormalizedRealtimeEvent> = T extends NormalizedRealtimeEvent
  ? Omit<T, "provider" | "receivedAtMs" | "wireType">
  : never;

export class GeminiLiveClient implements NormalizedRealtimeClient {
  readonly provider = "gemini" as const;
  private readonly options: GeminiLiveClientOptions;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly webSocketFactory: RealtimeWebSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly maxIncomingMessageBytes: number;
  private readonly maxToolResponseBytes: number;
  private readonly eventListeners = new Set<RealtimeEventListener>();
  private readonly wireEventListeners = new Set<RealtimeWireEventListener>();
  private socket: RealtimeWebSocket | null = null;
  private connectionEpoch = 0;
  private activeWireArrival: WireArrival | null = null;
  private clientState: RealtimeClientState = "idle";
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageChain: Promise<void> = Promise.resolve();
  private inputOpen = false;
  private inputTurn = 0;
  private responseCounter = 0;
  private currentResponseId: string | null = null;
  private responseFinished = false;
  private currentResponseInterrupted = false;
  private inputTranscript = new TranscriptAssembler();
  private outputTranscript = new TranscriptAssembler();
  private inputProviderTranscriptFinished = true;
  private outputProviderTranscriptFinished = true;
  private inputTranscriptAttributionAmbiguous = false;
  private outputTranscriptAttributionAmbiguous = false;
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private outstandingToolCalls = new Map<string, FunctionCall>();
  private completedToolResponses = new Map<string, FunctionResponse>();
  private cancelledToolCallIds = new Set<string>();
  private toolCallFingerprints = new Map<string, string>();
  private conflictedToolCallIds = new Set<string>();
  private resumption: ResumptionState;

  constructor(options: GeminiLiveClientOptions) {
    if (!options.model.trim()) throw new Error("Gemini Live model is required");
    if (!options.voice.trim()) throw new Error("Gemini Live voice is required");
    if (options.url && !options.url.startsWith("wss://") && !options.url.startsWith("ws://")) {
      throw new Error("Gemini Live URL must use ws:// or wss://");
    }
    this.options = options;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxIncomingMessageBytes = options.maxIncomingMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.maxToolResponseBytes = options.maxToolResponseBytes ?? DEFAULT_MAX_TOOL_RESPONSE_BYTES;
    if (!Number.isFinite(this.connectTimeoutMs) || this.connectTimeoutMs <= 0) {
      throw new Error("Gemini connectTimeoutMs must be positive");
    }
    if (!Number.isInteger(this.maxIncomingMessageBytes) || this.maxIncomingMessageBytes <= 0) {
      throw new Error("Gemini maxIncomingMessageBytes must be a positive integer");
    }
    if (!Number.isInteger(this.maxToolResponseBytes) || this.maxToolResponseBytes <= 0) {
      throw new Error("Gemini maxToolResponseBytes must be a positive integer");
    }
    this.resumption = { handle: options.resumeHandle, resumable: Boolean(options.resumeHandle) };
    if (options.onEvent) this.eventListeners.add(options.onEvent);
  }

  get isReady(): boolean {
    return this.clientState === "ready";
  }

  get state(): RealtimeClientState {
    return this.clientState;
  }

  get resumeState(): Readonly<ResumptionState> {
    return { ...this.resumption };
  }

  onEvent(listener: RealtimeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onWireEvent(listener: RealtimeWireEventListener): () => void {
    this.wireEventListeners.add(listener);
    return () => this.wireEventListeners.delete(listener);
  }

  connect(): Promise<void> {
    if (this.clientState === "ready") return Promise.resolve();
    if (this.clientState === "connecting" && this.connectPromise) return this.connectPromise;
    if (this.clientState === "closing") {
      return Promise.reject(new Error("Gemini Live cannot reconnect while the prior socket is closing"));
    }

    const url = this.options.url ?? buildGeminiLiveUrl(this.options.apiKey ?? "");
    this.clientState = "connecting";
    this.messageChain = Promise.resolve();
    this.abortPendingToolCalls("Gemini Live started a new connection");
    this.outstandingToolCalls.clear();
    const epoch = ++this.connectionEpoch;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });

    let socket: RealtimeWebSocket;
    try {
      socket = this.webSocketFactory(url, { headers: {} });
    } catch {
      const normalized = new Error("Gemini Live WebSocket factory failed");
      this.failConnect(normalized);
      this.emitError(normalized, true, undefined, "socket_factory_failed");
      return this.connectPromise;
    }
    this.socket = socket;
    const binding = { socket, epoch } satisfies ConnectionBinding;
    socket.on("open", () => this.handleOpen(binding));
    socket.on("message", (data) => {
      if (!this.isCurrentConnection(binding)) return;
      const arrival = { wallMs: this.now(), monotonicMs: this.monotonicNow() };
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(binding, data, arrival))
        .catch((error) => {
          if (!this.isCurrentConnection(binding)) return;
          if (this.clientState === "connecting") {
            this.failActiveConnection(
              binding,
              new Error("Gemini Live received an invalid message before setup completed"),
              "pre_setup_parse_error",
            );
          } else {
            this.emitError(safeError(error), false);
          }
        });
    });
    socket.on("error", () => {
      if (!this.isCurrentConnection(binding)) return;
      const error = new Error("Gemini Live WebSocket failed");
      this.failActiveConnection(binding, error, "transport_error");
    });
    socket.on("close", (code, reason) => {
      if (!this.isCurrentConnection(binding)) return;
      const normalizedReason = typeof reason === "string"
        ? reason
        : ArrayBuffer.isView(reason)
          ? new TextDecoder().decode(new Uint8Array(reason.buffer, reason.byteOffset, reason.byteLength))
          : undefined;
      this.handleClose(binding, code, normalizedReason);
    });

    this.connectTimer = setTimeout(() => {
      if (!this.isCurrentConnection(binding) || this.clientState !== "connecting") return;
      const error = new Error("Gemini Live setup timed out");
      this.failConnect(error);
      this.emitError(error, true, undefined, "setup_timeout");
      binding.socket.close(1000, "setup timeout");
    }, this.connectTimeoutMs);
    return this.connectPromise;
  }

  startActivity(): void {
    this.requireReady();
    if (this.inputOpen) throw new Error("Gemini input activity is already open");
    this.inputTranscriptAttributionAmbiguous = this.inputTurn > 0 && !this.inputProviderTranscriptFinished;
    this.inputProviderTranscriptFinished = false;
    this.inputOpen = true;
    this.inputTurn += 1;
    this.inputTranscript.reset();
    this.sendReady({ realtimeInput: { activityStart: {} } });
  }

  appendInputAudio(input: Pcm16Audio): void {
    this.requireReady();
    assertPcm16Audio(input, {
      encoding: "pcm16",
      sampleRateHz: GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
      channels: 1,
    });
    if (!this.inputOpen) this.startActivity();
    this.sendReady({
      realtimeInput: {
        audio: {
          data: pcm16ToBase64(input),
          mimeType: `audio/pcm;rate=${GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ}`,
        },
      },
    });
  }

  endActivity(): void {
    this.requireReady();
    if (!this.inputOpen) throw new Error("Gemini input activity is not open");
    this.inputOpen = false;
    this.sendReady({ realtimeInput: { activityEnd: {} } });
  }

  commitInputAudio(): void {
    this.endActivity();
  }

  createResponse(overrides?: Record<string, unknown>): void {
    this.requireReady();
    // Gemini starts generation from activityEnd/toolResponse. It has no response.create frame.
    this.emit({
      type: "provider.event",
      data: { name: "response_creation_is_implicit", ...(overrides ? { overrides: jsonRecord(overrides) } : {}) },
    }, "client.response.create");
  }

  sendTurn(audio: Pcm16Audio | readonly Pcm16Audio[]): void {
    const chunks = Array.isArray(audio) ? audio : [audio];
    if (chunks.length === 0) throw new Error("Gemini turn must contain at least one audio chunk");
    this.startActivity();
    for (const chunk of chunks) this.appendInputAudio(chunk);
    this.commitInputAudio();
  }

  submitToolResults(results: readonly RealtimeToolResult[], createResponse = false): void {
    this.requireReady();
    if (this.options.executeCapabilityGateway) {
      throw new Error("Gemini client uses internal tool execution; external results are disabled");
    }
    if (results.length === 0) throw new Error("At least one Gemini tool result is required");
    const seen = new Set<string>();
    const responses = results.map((result) => {
      if (!result.callId) throw new Error("Gemini tool result callId cannot be empty");
      if (seen.has(result.callId)) throw new Error(`Duplicate Gemini tool result for ${result.callId}`);
      seen.add(result.callId);
      const call = this.outstandingToolCalls.get(result.callId);
      if (!call) throw new Error(`No outstanding Gemini tool call ${result.callId}`);
      const name = typeof call.name === "string" && call.name ? call.name : GEMINI_CAPABILITY_GATEWAY_NAME;
      const response: FunctionResponse = { id: result.callId, name, response: { output: jsonValue(result.output) } };
      const encoded = JSON.stringify(response);
      if (textBytes(encoded) > this.maxToolResponseBytes) {
        return this.errorFunctionResponse(result.callId, name, "Capability gateway result was too large");
      }
      return response;
    });
    const message = { toolResponse: { functionResponses: responses } };
    if (textBytes(JSON.stringify(message)) > this.maxToolResponseBytes) {
      throw new Error("Gemini tool response batch was too large");
    }
    for (const response of responses) {
      this.outstandingToolCalls.delete(response.id);
      this.completedToolResponses.set(response.id, response);
    }
    this.sendReady(message);
    if (createResponse) this.createResponse();
  }

  close(code = 1000, reason = "client close"): void {
    if (!this.socket || this.clientState === "closed") return;
    const wasConnecting = this.clientState === "connecting";
    const binding = { socket: this.socket, epoch: this.connectionEpoch } satisfies ConnectionBinding;
    this.clientState = "closing";
    this.inputOpen = false;
    this.clearConnectTimer();
    if (wasConnecting) {
      this.rejectPendingConnect(new Error("Gemini Live closed before setup completed"));
    }
    this.abortPendingToolCalls("Gemini Live connection closed");
    this.outstandingToolCalls.clear();
    try {
      binding.socket.close(code, reason.slice(0, 123));
    } catch {
      if (this.isCurrentConnection(binding)) {
        this.clientState = "closed";
        this.socket = null;
      }
    }
  }

  private handleOpen(binding: ConnectionBinding) {
    if (!this.isCurrentConnection(binding) || this.clientState !== "connecting") return;
    try {
      // The raw Live API requires setup to be the first and only pre-ack frame.
      binding.socket.send(JSON.stringify(buildGeminiLiveSetup({
        model: this.options.model,
        voice: this.options.voice,
        instructions: this.options.instructions,
        resumeHandle: this.resumption.handle,
      })));
    } catch {
      const normalized = new Error("Gemini Live setup could not be sent");
      this.failConnect(normalized);
      this.emitError(normalized, true, undefined, "setup_send_failed");
      binding.socket.close(1000, "setup failed");
    }
  }

  private async handleMessage(binding: ConnectionBinding, data: unknown, arrival: WireArrival) {
    if (!this.isCurrentConnection(binding)) return;
    const encodedBytes = encodedMessageBytes(data);
    if (encodedBytes !== undefined && encodedBytes > this.maxIncomingMessageBytes) {
      throw new Error(`Gemini message exceeded ${this.maxIncomingMessageBytes} bytes`);
    }
    const text = await messageText(data);
    if (!this.isCurrentConnection(binding)) return;
    if (textBytes(text) > this.maxIncomingMessageBytes) {
      throw new Error(`Gemini message exceeded ${this.maxIncomingMessageBytes} bytes`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Gemini returned malformed JSON");
    }
    if (!isRecord(parsed)) throw new Error("Gemini returned a non-object message");
    const frozen = deepFreezeJson(parsed);
    this.activeWireArrival = arrival;
    try {
      if (this.clientState === "connecting") {
        const validSetup = own(frozen, "setupComplete")
          && isRecord(frozen.setupComplete)
          && Object.keys(frozen).length === 1;
        if (validSetup) {
          this.handleSetupComplete(binding, frozen.setupComplete);
        } else {
          this.failActiveConnection(
            binding,
            new Error("Gemini Live received an invalid or non-exclusive setup acknowledgement"),
            "invalid_setup_ack",
          );
          this.notifyWireObservers(frozen, arrival.wallMs);
          return;
        }
        // SetupComplete must be the sole protocol action in the acknowledgement frame.
        this.notifyWireObservers(frozen, arrival.wallMs);
        return;
      }

      if (this.clientState !== "ready") {
        this.notifyWireObservers(frozen, arrival.wallMs);
        return;
      }

      const usage = isRecord(frozen.usageMetadata) ? frozen.usageMetadata : undefined;
      if (isRecord(frozen.sessionResumptionUpdate)) this.handleResumption(frozen.sessionResumptionUpdate);
      if (isRecord(frozen.goAway)) this.handleGoAway(frozen.goAway);
      if (isRecord(frozen.serverContent)) this.handleServerContent(binding, frozen.serverContent);
      if (this.clientState !== "ready") {
        this.notifyWireObservers(frozen, arrival.wallMs);
        return;
      }
      if (isRecord(frozen.toolCall)) this.handleToolCalls(binding, frozen.toolCall);
      if (isRecord(frozen.toolCallCancellation)) this.handleToolCancellation(frozen.toolCallCancellation);
      if (isRecord(frozen.error)) {
        const message = typeof frozen.error.message === "string" ? frozen.error.message : "Gemini Live protocol error";
        this.emitError(new Error(message.slice(0, 2_000)), false, frozen.error);
      }
      if (usage) this.handleUsage(usage);

      this.notifyWireObservers(frozen, arrival.wallMs);
    } finally {
      if (this.activeWireArrival === arrival) this.activeWireArrival = null;
    }
  }

  private notifyWireObservers(frozen: Readonly<Record<string, unknown>>, receivedAtMs: number) {
    const rawResumeHandle = isRecord(frozen.sessionResumptionUpdate)
      && typeof frozen.sessionResumptionUpdate.newHandle === "string"
      ? frozen.sessionResumptionUpdate.newHandle
      : undefined;
    const publishable = this.sanitizeDetails(frozen as Record<string, unknown>);
    if (rawResumeHandle && isRecord(publishable.sessionResumptionUpdate)) {
      publishable.sessionResumptionUpdate.newHandle = handleDigest(rawResumeHandle);
      publishable.sessionResumptionUpdate.handleRedacted = true;
    }
    const observerEvent = deepFreezeJson(publishable);
    // Expose the immutable wire tree only after protocol state was derived.
    for (const listener of this.wireEventListeners) {
      try { listener(observerEvent); } catch { /* isolate artifact observers */ }
    }
    try {
      this.options.onRawMessage?.(observerEvent, receivedAtMs);
    } catch {
      // Artifact consumers cannot be allowed to corrupt protocol processing.
    }
  }

  private handleUsage(raw: Record<string, unknown>) {
    const responseId = this.currentResponseId ?? undefined;
    this.emit({
      type: "usage",
      usage: normalizeGeminiUsage(raw),
      ...(responseId ? { responseId, scope: "response" as const } : { scope: "session" as const }),
      ...(this.inputTurn > 0 ? { turnId: `gemini-turn-${this.inputTurn}` } : {}),
    }, "usageMetadata");
  }

  private handleSetupComplete(binding: ConnectionBinding, value: unknown) {
    if (!this.isCurrentConnection(binding) || this.clientState !== "connecting") return;
    this.clientState = "ready";
    this.clearConnectTimer();
    const sessionId = isRecord(value) && typeof value.sessionId === "string" ? value.sessionId : undefined;
    this.emit({ type: "session.ready", ...(sessionId ? { sessionId } : {}) }, "setupComplete");
    this.resolveConnect?.();
    this.resolveConnect = null;
    this.rejectConnect = null;
  }

  private handleServerContent(binding: ConnectionBinding, content: Record<string, unknown>) {
    const modelTurn = isRecord(content.modelTurn) ? content.modelTurn : undefined;
    const parts = modelTurn && Array.isArray(modelTurn.parts) ? modelTurn.parts : [];

    const hasTerminalSignal = content.generationComplete === true
      || content.turnComplete === true
      || content.interrupted === true;
    if (parts.length > 0 || hasTerminalSignal || (isRecord(content.outputTranscription) && !this.currentResponseId)) {
      this.ensureResponseStarted();
    }

    if (isRecord(content.inputTranscription)) {
      this.handleTranscript("input", content.inputTranscription);
    }
    if (isRecord(content.interimInputTranscription)) {
      this.handleTranscript("input", content.interimInputTranscription);
    }
    if (isRecord(content.outputTranscription)) {
      this.handleTranscript("output", content.outputTranscription);
    }

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!isRecord(part)) {
        this.emitError(new Error(`Gemini content part ${index} was not an object`), false, part);
        continue;
      }
      const responseId = this.ensureResponseStarted();
      this.emit({
        type: "provider.event",
        data: { name: "content.part", responseId, partIndex: index, part },
      }, "serverContent.modelTurn.part");
      if (isRecord(part.inlineData)) {
        if (!this.handleInlineData(binding, part.inlineData, responseId)) return;
      }
    }

    if (content.interrupted === true) {
      const responseId = this.currentResponseId ?? undefined;
      this.currentResponseInterrupted = true;
      this.emit({
        type: "turn.interrupted",
        ...(responseId ? { responseId } : {}),
        reason: "provider_interruption",
      }, "serverContent.interrupted");
      this.finalizeTranscript("output");
    }

    if (content.generationComplete === true) {
      this.emit({
        type: "provider.event",
        data: { name: "generation_complete", responseId: this.currentResponseId },
      }, "serverContent.generationComplete");
    }

    if (content.turnComplete === true) {
      this.finalizeTranscript("input");
      this.finalizeTranscript("output");
      const reason = typeof content.turnCompleteReason === "string" ? content.turnCompleteReason : undefined;
      const rejected = reason === "RESPONSE_REJECTED" || reason === "MALFORMED_FUNCTION_CALL"
        || Boolean(reason?.includes("PROHIBITED"));
      if (rejected) {
        this.emitError(
          new Error(`Gemini response ended with ${reason}`),
          false,
          undefined,
          reason === "MALFORMED_FUNCTION_CALL" ? "malformed_function_call" : "response_rejected",
        );
      }
      this.completeResponse(
        this.currentResponseInterrupted || content.interrupted === true
          ? "interrupted"
          : rejected
            ? "failed"
            : "completed",
        reason ?? "turn_complete",
        "serverContent.turnComplete",
      );
    }

    if (content.waitingForInput === true) {
      this.emit({ type: "provider.event", data: { name: "waiting_for_input" } }, "serverContent.waitingForInput");
    }
  }

  private handleTranscript(kind: "input" | "output", transcription: Record<string, unknown>) {
    if (typeof transcription.text !== "string") return;
    const attributionAmbiguous = kind === "input"
      ? this.inputTranscriptAttributionAmbiguous
      : this.outputTranscriptAttributionAmbiguous;
    if (attributionAmbiguous) {
      this.emit({
        type: "provider.event",
        data: {
          name: "transcription.unattributed",
          direction: kind,
          text: transcription.text,
          finished: transcription.finished === true,
          candidateInputTurn: this.inputTurn,
          candidateResponseId: this.currentResponseId,
          reason: "Gemini transcription has no turn or response identifier",
        },
      }, kind === "input" ? "serverContent.inputTranscription" : "serverContent.outputTranscription");
      return;
    }
    const assembler = kind === "input" ? this.inputTranscript : this.outputTranscript;
    const priorText = assembler.text;
    const wasFinal = assembler.final;
    const assembled = assembler.ingest(transcription.text);
    const finished = transcription.finished === true;
    if (!assembled.delta && !assembled.revised && !finished) return;
    if (finished) assembler.final = true;
    if (finished && kind === "input") this.inputProviderTranscriptFinished = true;
    if (finished && kind === "output") this.outputProviderTranscriptFinished = true;
    const responseId = kind === "output" ? this.currentResponseId ?? this.ensureResponseStarted() : undefined;
    const common = {
      text: assembled.text,
      ...(assembled.delta ? { delta: assembled.delta } : {}),
      phase: finished ? "final" as const : "delta" as const,
      itemId: kind === "input" ? `gemini-input-${this.inputTurn}` : `${responseId}-transcript`,
      ...(assembled.revised || (wasFinal && assembled.text !== priorText) ? { revised: true } : {}),
    };
    if (kind === "input") {
      this.emit({ type: "input.transcript", ...common }, "serverContent.inputTranscription");
    } else {
      this.emit({
        type: "output.transcript",
        ...common,
        ...(responseId ? { responseId } : {}),
        source: "audio",
      }, "serverContent.outputTranscription");
    }
  }

  private finalizeTranscript(kind: "input" | "output") {
    const assembler = kind === "input" ? this.inputTranscript : this.outputTranscript;
    if (!assembler.text || assembler.final) return;
    assembler.final = true;
    const responseId = kind === "output" ? this.currentResponseId ?? undefined : undefined;
    if (kind === "input") {
      this.emit({
        type: "input.transcript",
        text: assembler.text,
        phase: "final",
        itemId: `gemini-input-${this.inputTurn}`,
      }, "serverContent.turnComplete");
    } else {
      this.emit({
        type: "output.transcript",
        text: assembler.text,
        phase: "final",
        itemId: `${responseId ?? "gemini-output"}-transcript`,
        ...(responseId ? { responseId } : {}),
        source: "audio",
      }, "serverContent.turnComplete");
    }
  }

  private handleInlineData(binding: ConnectionBinding, data: Record<string, unknown>, responseId: string): boolean {
    const mimeType = typeof data.mimeType === "string" ? data.mimeType : "";
    if (!/^audio\/pcm;\s*rate=24000$/i.test(mimeType) || typeof data.data !== "string") {
      this.failActiveConnection(
        binding,
        new Error("Gemini returned output that was not mono PCM16 at 24 kHz"),
        "invalid_output_audio_format",
      );
      return false;
    }
    try {
      const audio = base64ToPcm16(String(data.data));
      this.emit({
        type: "output.audio",
        audio,
        format: { encoding: "pcm16", sampleRateHz: GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ, channels: 1 },
        responseId,
      }, "serverContent.modelTurn.inlineData");
      return true;
    } catch (error) {
      this.failActiveConnection(binding, safeError(error), "invalid_output_audio_payload");
      return false;
    }
  }

  private handleToolCalls(binding: ConnectionBinding, toolCall: Record<string, unknown>) {
    if (!this.isCurrentConnection(binding) || this.clientState !== "ready") return;
    if (!Array.isArray(toolCall.functionCalls) || toolCall.functionCalls.length === 0) return;
    const responseId = this.ensureResponseStarted();
    if (toolCall.functionCalls.some((raw) => !isRecord(raw)
      || typeof raw.id !== "string" || !raw.id
      || typeof raw.name !== "string" || !raw.name)) {
      this.failActiveConnection(
        binding,
        new Error("Gemini returned a function call without a matchable id and name"),
        "invalid_tool_call_identity",
      );
      return;
    }
    const calls = toolCall.functionCalls.filter(isRecord).map((raw): FunctionCall => {
      const call: FunctionCall = { id: raw.id, name: raw.name, args: raw.args };
      const id = typeof call.id === "string" ? call.id : "";
      if (!id) return call;
      call.fingerprint = functionCallFingerprint(call);
      const previous = this.toolCallFingerprints.get(id);
      if (this.conflictedToolCallIds.has(id) || (previous !== undefined && previous !== call.fingerprint)) {
        call.identityConflict = `Function call ${id} was reused with a different name or arguments`;
        this.conflictedToolCallIds.add(id);
        const pending = this.pendingToolCalls.get(id);
        if (pending) {
          pending.cancelled = true;
          pending.controller.abort(new Error("Gemini reused a function call id with conflicting contents"));
        }
        this.outstandingToolCalls.delete(id);
        this.emitError(new Error(call.identityConflict), false, undefined, "duplicate_tool_call_conflict");
      } else {
        this.toolCallFingerprints.set(id, call.fingerprint);
      }
      return call;
    });
    const normalized = calls.map((call) => {
      const id = typeof call.id === "string" ? call.id : "";
      const name = typeof call.name === "string" ? call.name : "";
      let argumentsJson: Record<string, JsonValue> | null = null;
      let argumentsError: string | undefined;
      if (isRecord(call.args)) argumentsJson = jsonRecord(call.args);
      else argumentsError = "Function arguments were not an object";
      if (call.identityConflict) argumentsError = call.identityConflict;
      if (id && !call.identityConflict) this.outstandingToolCalls.set(id, call);
      return {
        callId: id,
        name,
        argumentsText: JSON.stringify(argumentsJson ?? null),
        argumentsJson,
        ...(argumentsError ? { argumentsError } : {}),
      };
    });
    this.emit({ type: "tool.calls", responseId, calls: normalized }, "toolCall");

    const autoCalls = this.options.executeCapabilityGateway
      ? calls
      : calls.filter(
          (call) => call.identityConflict || call.name !== GEMINI_CAPABILITY_GATEWAY_NAME || !isRecord(call.args),
        );
    if (autoCalls.length > 0) {
      void this.executeToolBatch(binding, autoCalls).catch((error) => {
        if (this.isCurrentConnection(binding)) this.emitError(safeError(error), false);
      });
    }
  }

  private async executeToolBatch(binding: ConnectionBinding, calls: FunctionCall[]) {
    const responses = await Promise.all(calls.map((call) => this.executeToolCall(call)));
    const active = responses.filter(
      (response): response is FunctionResponse => response !== null && !this.cancelledToolCallIds.has(response.id),
    );
    if (active.length === 0 || !this.isCurrentConnection(binding) || this.clientState !== "ready") return;
    const unique = [...new Map(active.map((response) => [response.id, response])).values()];
    const message = { toolResponse: { functionResponses: unique } };
    if (textBytes(JSON.stringify(message)) > this.maxToolResponseBytes) {
      this.failActiveConnection(
        binding,
        new Error("Gemini tool response batch was too large"),
        "tool_response_batch_too_large",
      );
      return;
    }
    if (!this.sendReadyFor(binding, message)) return;
    for (const response of unique) this.outstandingToolCalls.delete(response.id);
  }

  private executeToolCall(call: FunctionCall): Promise<FunctionResponse | null> {
    const id = typeof call.id === "string" ? call.id : "";
    const name = typeof call.name === "string" ? call.name : "";
    if (!id) {
      this.emitError(new Error("Gemini function call did not include an id"), false, call);
      return Promise.resolve(null);
    }
    if (call.identityConflict || this.conflictedToolCallIds.has(id)) {
      return Promise.resolve(this.errorFunctionResponse(
        id,
        name || GEMINI_CAPABILITY_GATEWAY_NAME,
        call.identityConflict ?? `Function call ${id} has conflicting contents`,
      ));
    }
    if (this.cancelledToolCallIds.has(id)) return Promise.resolve(null);
    const completed = this.completedToolResponses.get(id);
    if (completed) return Promise.resolve(completed);
    const existing = this.pendingToolCalls.get(id);
    if (existing) return existing.response;

    const controller = new AbortController();
    const pending: PendingToolCall = {
      controller,
      cancelled: false,
      response: Promise.resolve(null),
    };
    pending.response = Promise.resolve().then(async () => {
      let response: FunctionResponse;
      if (name !== GEMINI_CAPABILITY_GATEWAY_NAME) {
        response = this.errorFunctionResponse(
          id,
          name || GEMINI_CAPABILITY_GATEWAY_NAME,
          `Only ${GEMINI_CAPABILITY_GATEWAY_NAME} is available in this session`
        );
      } else if (!isRecord(call.args)) {
        response = this.errorFunctionResponse(id, name, "Capability gateway arguments must be an object");
      } else {
        try {
          if (!this.options.executeCapabilityGateway) {
            return this.errorFunctionResponse(id, name, "No capability gateway executor is configured");
          }
          const output = await this.options.executeCapabilityGateway({
            callId: id,
            name: GEMINI_CAPABILITY_GATEWAY_NAME,
            arguments: jsonRecord(call.args),
            signal: controller.signal,
          });
          if (pending.cancelled || controller.signal.aborted) return null;
          response = { id, name, response: { output: jsonValue(output) } };
        } catch (error) {
          if (pending.cancelled || controller.signal.aborted) return null;
          response = this.errorFunctionResponse(id, name, this.sanitizeDiagnostic(safeError(error).message));
        }
      }

      const encoded = JSON.stringify(response);
      if (textBytes(encoded) > this.maxToolResponseBytes) {
        response = this.errorFunctionResponse(id, name || GEMINI_CAPABILITY_GATEWAY_NAME, "Capability gateway result was too large");
      }
      if (!pending.cancelled) this.completedToolResponses.set(id, response);
      return pending.cancelled ? null : response;
    }).finally(() => {
      if (this.pendingToolCalls.get(id) === pending) this.pendingToolCalls.delete(id);
    });
    this.pendingToolCalls.set(id, pending);
    return pending.response;
  }

  private errorFunctionResponse(id: string, name: string, message: string): FunctionResponse {
    return {
      id,
      name,
      response: { error: { message: message.slice(0, 2_000) } },
    };
  }

  private handleToolCancellation(cancellation: Record<string, unknown>) {
    if (!Array.isArray(cancellation.ids)) return;
    const callIds: string[] = [];
    const completedIds: string[] = [];
    for (const candidate of cancellation.ids) {
      if (typeof candidate !== "string") continue;
      callIds.push(candidate);
      this.cancelledToolCallIds.add(candidate);
      const pending = this.pendingToolCalls.get(candidate);
      const alreadyCompleted = this.completedToolResponses.has(candidate);
      if (alreadyCompleted) completedIds.push(candidate);
      if (pending) {
        pending.cancelled = true;
        pending.controller.abort(new Error("Gemini cancelled this function call"));
      }
      this.outstandingToolCalls.delete(candidate);
    }
    if (callIds.length > 0) {
      this.emit({ type: "tool.cancelled", callIds }, "toolCallCancellation");
      if (completedIds.length > 0) {
        this.emit({
          type: "provider.event",
          data: { name: "tool_cancellation_after_completion", callIds: completedIds },
        }, "toolCallCancellation");
      }
    }
  }

  private handleResumption(update: Record<string, unknown>) {
    const resumable = update.resumable === true;
    const newHandle = typeof update.newHandle === "string" && update.newHandle ? update.newHandle : undefined;
    const lastConsumed = typeof update.lastConsumedClientMessageIndex === "string"
      ? update.lastConsumedClientMessageIndex
      : undefined;
    if (resumable && newHandle) this.resumption.handle = newHandle;
    if (!resumable) this.resumption.handle = undefined;
    this.resumption.resumable = resumable;
    this.resumption.lastConsumedClientMessageIndex = lastConsumed;
    const handle = resumable ? newHandle ?? this.resumption.handle : undefined;
    if (handle) {
      this.emit({ type: "session.resumption", handle: handleDigest(handle), resumable }, "sessionResumptionUpdate");
    } else {
      this.emit({
        type: "provider.event",
        data: { name: "session_resumption_unavailable", resumable },
      }, "sessionResumptionUpdate");
    }
    if (lastConsumed) {
      this.emit({
        type: "provider.event",
        data: { name: "last_consumed_client_message", index: lastConsumed },
      }, "sessionResumptionUpdate.lastConsumedClientMessageIndex");
    }
  }

  private handleGoAway(goAway: Record<string, unknown>) {
    const disconnectInMs = durationToMs(goAway.timeLeft);
    this.emit({
      type: "connection.go_away",
      ...(disconnectInMs !== undefined ? { disconnectInMs } : {}),
      ...(typeof goAway.timeLeft === "string" ? { reason: `server disconnects in ${goAway.timeLeft}` } : {}),
    }, "goAway");
    if (this.resumption.handle) {
      this.emit({
        type: "provider.event",
        data: { name: "go_away_resume_handle", handleHash: handleDigest(this.resumption.handle) },
      }, "goAway");
    }
  }

  private ensureResponseStarted(): string {
    if (this.currentResponseId && !this.responseFinished) return this.currentResponseId;
    const hadPreviousResponse = this.currentResponseId !== null;
    this.outputTranscriptAttributionAmbiguous = hadPreviousResponse && !this.outputProviderTranscriptFinished;
    this.outputProviderTranscriptFinished = false;
    this.responseCounter += 1;
    this.currentResponseId = `gemini-response-${this.responseCounter}`;
    this.responseFinished = false;
    this.currentResponseInterrupted = false;
    this.outputTranscript.reset();
    this.emit({ type: "response.started", responseId: this.currentResponseId }, "serverContent");
    return this.currentResponseId;
  }

  private completeResponse(
    status: "completed" | "interrupted" | "failed",
    reason?: string,
    wireType = "serverContent.turnComplete",
  ) {
    if (!this.currentResponseId || this.responseFinished) return;
    this.responseFinished = true;
    this.emit({
      type: "response.completed",
      responseId: this.currentResponseId,
      status: reason && reason !== "turn_complete" ? `${status}:${reason}` : status,
    }, wireType);
  }

  private sendReady(message: Record<string, unknown>) {
    this.requireReady();
    const encoded = JSON.stringify(message);
    this.socket!.send(encoded);
  }

  private sendReadyFor(binding: ConnectionBinding, message: Record<string, unknown>): boolean {
    if (!this.isCurrentConnection(binding) || this.clientState !== "ready" || binding.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    binding.socket.send(JSON.stringify(message));
    return true;
  }

  private requireReady() {
    if (this.clientState !== "ready" || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live setup is not complete");
    }
  }

  private handleClose(binding: ConnectionBinding, code?: number, reason?: string) {
    if (!this.isCurrentConnection(binding)) return;
    const wasConnecting = this.clientState === "connecting";
    const wasFailed = this.clientState === "failed";
    if (!wasFailed) this.clientState = "closed";
    this.socket = null;
    this.inputOpen = false;
    this.clearConnectTimer();
    this.abortPendingToolCalls("Gemini Live connection closed");
    this.outstandingToolCalls.clear();
    if (wasConnecting) this.rejectPendingConnect(new Error("Gemini Live closed before setup completed"));
    if (this.currentResponseId && !this.responseFinished) {
      this.completeResponse("failed", "connection_closed", "socket.close");
    }
    this.emit({
      type: "connection.closed",
      ...(typeof code === "number" ? { code } : {}),
      ...(typeof reason === "string" ? { reason: this.sanitizeDiagnostic(reason) } : {}),
      ...(typeof code === "number" ? { clean: code === 1000 } : {}),
    }, "close");
  }

  private failConnect(error: Error) {
    if (this.clientState === "connecting") this.clientState = "failed";
    this.clearConnectTimer();
    this.abortPendingToolCalls("Gemini Live connection failed");
    this.outstandingToolCalls.clear();
    this.rejectPendingConnect(error);
  }

  private failActiveConnection(binding: ConnectionBinding, error: Error, code: string) {
    if (!this.isCurrentConnection(binding)) return;
    this.clientState = "failed";
    this.clearConnectTimer();
    this.abortPendingToolCalls("Gemini Live connection failed");
    this.outstandingToolCalls.clear();
    this.rejectPendingConnect(error);
    if (this.currentResponseId && !this.responseFinished) this.completeResponse("failed", code, "client.transport");
    this.emitError(error, true, undefined, code);
    try {
      if (binding.socket.terminate) binding.socket.terminate();
      else binding.socket.close(1002, "protocol violation");
    } catch {
      // Failed is already terminal even if the transport cannot be closed.
    }
  }

  private rejectPendingConnect(error: Error) {
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
  }

  private abortPendingToolCalls(reason: string) {
    for (const call of this.pendingToolCalls.values()) {
      call.cancelled = true;
      call.controller.abort(new Error(reason));
    }
    this.pendingToolCalls.clear();
  }

  private isCurrentConnection(binding: ConnectionBinding): boolean {
    return this.socket === binding.socket && this.connectionEpoch === binding.epoch;
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private emit(event: NormalizedEventPayload, wireType: string) {
    const arrival = this.activeWireArrival;
    const normalized = {
      provider: "gemini",
      receivedAtMs: arrival?.wallMs ?? this.now(),
      receivedAtMonotonicMs: arrival?.monotonicMs ?? this.monotonicNow(),
      wireType,
      ...event,
    } as GeminiLiveEvent;
    for (const listener of this.eventListeners) {
      try {
        const isolated = freezeNormalizedEvent(structuredClone(normalized)) as GeminiLiveEvent;
        listener(isolated);
      } catch { /* isolate benchmark observers */ }
    }
  }

  private sanitizeDiagnostic(value: string): string {
    let sanitized = value;
    const secrets = [this.options.apiKey, this.options.url, this.options.apiKey ? encodeURIComponent(this.options.apiKey) : undefined]
      .filter((secret): secret is string => Boolean(secret));
    for (const secret of secrets) sanitized = sanitized.split(secret).join("[REDACTED]");
    return sanitized
      .replace(/([?&](?:key|api_key|access_token|token)=)[^&\s]+/gi, "$1[REDACTED]")
      .slice(0, 2_000);
  }

  private sanitizeDetails(raw: Record<string, unknown>): Record<string, unknown> {
    const visit = (value: JsonValue): JsonValue => {
      if (typeof value === "string") return this.sanitizeDiagnostic(value);
      if (Array.isArray(value)) return value.map(visit);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
      }
      return value;
    };
    return visit(jsonRecord(raw)) as Record<string, unknown>;
  }

  private emitError(error: Error, fatal: boolean, raw?: unknown, code?: string) {
    this.emit({
      type: "error",
      message: this.sanitizeDiagnostic(error.message),
      fatal,
      ...(code ? { code } : {}),
      ...(isRecord(raw) ? { details: this.sanitizeDetails(raw) } : {}),
    }, "error");
  }
}
