import WebSocket from "ws";
import { createHash } from "node:crypto";
import type { ProviderFunctionTool } from "../../benchmark/capability-gateway";
import {
  geminiServerMessageTypes,
  GEMINI_PROVIDER_TRANSCRIPTION_POLICY,
} from "../gemini-policy";
import { assertPcm16Audio, base64ToPcm16, pcm16ToBase64 } from "./audio";
import {
  RealtimeDynamicControlLimitError,
  type NormalizedRealtimeClient,
  type NormalizedRealtimeEvent,
  type NormalizedRealtimeUsage,
  type Pcm16Audio,
  type RealtimeClientState,
  type RealtimeEventListener,
  type RealtimeResponseTerminalStatus,
  type RealtimeResponsePreparation,
  type RealtimeWireObservation,
  type RealtimeWireObservationAttribution,
  type RealtimeWireObservationListener,
  type SessionConfigurationAcknowledgement,
  type RealtimeToolResult,
  type RealtimeTransportFailureDiagnostic,
  type RealtimeWebSocket,
  type RealtimeWebSocketFactory,
  type RealtimeWireEventListener,
} from "./types";
import { createRealtimeTransportFailureDiagnostic } from "./transport-diagnostics";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationReference,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "./wire-evidence";

export const GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ = 16_000;
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ = 24_000;
export const GEMINI_LIVE_MAX_AUDIO_ONLY_SESSION_MS = 15 * 60_000;
export { GEMINI_PROVIDER_TRANSCRIPTION_POLICY } from "../gemini-policy";
export const GEMINI_CAPABILITY_GATEWAY_NAME = "capability_gateway";
export const GEMINI_LIVE_DEFAULT_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOOL_RESPONSE_BYTES = 1024 * 1024;
export const GEMINI_LIVE_DEFAULT_MAX_DYNAMIC_CONTROL_BYTES = 4 * 1024;
export const GEMINI_LIVE_HARD_MAX_DYNAMIC_CONTROL_BYTES = 64 * 1024;
const MAX_FUNCTION_CALLS_PER_BATCH = 64;
const MAX_TRACKED_FUNCTION_CALL_IDS = 10_000;
const CLIENT_GENERATED_WIRE_ATTRIBUTION = Object.freeze({
  availability: "unavailable" as const,
  reason: "client_generated" as const,
});
const TRANSPORT_GENERATED_WIRE_ATTRIBUTION = Object.freeze({
  availability: "unavailable" as const,
  reason: "transport_generated" as const,
});

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
  /**
   * The provider-neutral function surface compiled for this session. Gemini's
   * setup frame is derived from this value without maintaining a second schema.
   */
  tools: readonly ProviderFunctionTool[];
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
  /** Compact advisory context sent through clientContent, never realtimeInput.text. */
  maxDynamicControlBytes?: number;
  /** Defaults to the hard 10k replay ledger; tests/apps may choose a shorter fail-closed bound. */
  maximumTrackedToolCallIdentities?: number;
  /** Hard wall-clock kill; may be shortened but never exceed Gemini's audio-only limit. */
  maximumSessionDurationMs?: number;
};

type FunctionCall = {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  responseId: string;
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

type ActiveToolBatch = {
  key: string;
  responseId: string;
  callIds: Set<string>;
};

type GeminiGenerationTrigger = Readonly<{
  localResponseId: string;
  connectionEpoch: number;
  inputTurn: number;
  trigger: "audio_activity_end" | "client_content" | "tool_response";
  clientMessageOrdinal: number;
  triggerObservationSha256?: string;
  phase: "awaiting_provider" | "awaiting_tool_result" | "awaiting_post_tool" | "terminal";
}>;

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

export type GeminiSetupReadinessEvidence = Readonly<{
  connectionEpoch: number;
  acknowledgement: "setupComplete";
  /** Gemini reports setup completion but does not echo any requested field. */
  fieldEchoAvailable: false;
  clientSentSetupFrameSha256: string;
  /** Hash of the provider-neutral tools supplied to the adapter. */
  clientSentProviderToolsSha256: string;
  /** Hash of the exact Gemini `setup.tools` payload put on the wire. */
  clientSentFunctionDeclarationsSha256: string;
  clientSentToolNames: readonly string[];
  clientSentModel: string;
  clientSentVoice: string;
  providerTranscriptionPolicy: typeof GEMINI_PROVIDER_TRANSCRIPTION_POLICY;
  /** Every requested field is unverifiable because setupComplete has no fields. */
  configuration: SessionConfigurationAcknowledgement;
}>;

type PendingSetupConfiguration = Omit<
  GeminiSetupReadinessEvidence,
  "acknowledgement" | "fieldEchoAvailable"
>;

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
  const totalInputTokens = finiteToken(raw.promptTokenCount);
  const totalOutputTokens = finiteToken(raw.responseTokenCount);
  const totalTokens = finiteToken(raw.totalTokenCount);
  const inputAudioTokens = modalityTokens(raw.promptTokensDetails, "AUDIO");
  const inputTextTokens = modalityTokens(raw.promptTokensDetails, "TEXT");
  const outputAudioTokens = modalityTokens(raw.responseTokensDetails, "AUDIO");
  const outputTextTokens = modalityTokens(raw.responseTokensDetails, "TEXT");
  const uncategorizedCachedTokens = cachedAudioTokens === undefined && cachedTextTokens === undefined
    ? cachedTotal
    : undefined;
  return {
    ...(totalInputTokens === undefined ? {} : { totalInputTokens }),
    ...(cachedAudioTokens === undefined ? {} : { cachedInputAudioTokens: cachedAudioTokens }),
    ...(cachedTextTokens === undefined ? {} : { cachedInputTextTokens: cachedTextTokens }),
    ...(uncategorizedCachedTokens === undefined ? {} : { cachedInputTokens: uncategorizedCachedTokens }),
    ...(totalOutputTokens === undefined ? {} : { totalOutputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(inputAudioTokens === undefined ? {} : { inputAudioTokens }),
    ...(inputTextTokens === undefined ? {} : { inputTextTokens }),
    ...(outputAudioTokens === undefined ? {} : { outputAudioTokens }),
    ...(outputTextTokens === undefined ? {} : { outputTextTokens }),
    meteringSource: "provider_reported",
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

/**
 * Gemini requires FunctionResponse.response to be an object. Object-valued
 * normalized tool results are sent directly so the model sees the same JSON
 * contract as OpenAI/xAI; only non-object generic results need a `value` box.
 */
function functionResponseRecord(value: unknown): Record<string, JsonValue> {
  return jsonRecord(value);
}

type SnapshottedToolResult = Readonly<{
  callId: string;
  response: Record<string, JsonValue>;
}>;

function snapshotToolResultBatch(results: readonly RealtimeToolResult[]): SnapshottedToolResult[] {
  if (!Array.isArray(results)) throw new Error("Gemini tool results must be an array");
  const descriptors = Object.getOwnPropertyDescriptors(results) as Record<string, PropertyDescriptor>;
  const length = descriptors["length"]?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FUNCTION_CALLS_PER_BATCH) {
    throw new Error(`Gemini tool result batch must contain 1 to ${MAX_FUNCTION_CALLS_PER_BATCH} results`);
  }
  if (Object.getOwnPropertySymbols(results).length > 0) {
    throw new Error("Gemini tool result batch cannot have symbol properties");
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") continue;
    if (!/^(0|[1-9]\d*)$/.test(key)
      || Number(key) >= length
      || !("value" in descriptor)) {
      throw new Error("Gemini tool result batch must use concrete array elements only");
    }
  }

  const snapshots: SnapshottedToolResult[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !isRecord(descriptor.value)) {
      throw new Error(`Gemini tool result ${index} must be a concrete object`);
    }
    const value = descriptor.value;
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`Gemini tool result ${index} must be a plain object without symbols`);
    }
    const fields = Object.getOwnPropertyDescriptors(value);
    const callId = fields.callId;
    const output = fields.output;
    if (!callId || !("value" in callId) || typeof callId.value !== "string") {
      throw new Error(`Gemini tool result ${index} callId must be a concrete string`);
    }
    if (!output || !("value" in output)) {
      throw new Error(`Gemini tool result ${index} output must be a concrete value`);
    }
    snapshots.push(Object.freeze({
      callId: callId.value,
      // Normalize once. No caller-owned object is read again after authority
      // checks, serialization, or the provider send.
      response: functionResponseRecord(output.value),
    }));
  }
  return snapshots;
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

const MAX_PROVIDER_TOOLS = 64;
const MAX_PROVIDER_TOOLS_BYTES = 1024 * 1024;
const MAX_FUNCTION_CALL_ID_LENGTH = 256;
const PROVIDER_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const GEMINI_FUNCTION_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertStrictJson(value: unknown, path: string, ancestors = new WeakSet<object>(), depth = 0): void {
  if (depth > 64) throw new Error(`${path} exceeds the maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} contains a non-JSON object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStrictJson(entry, `${path}[${index}]`, ancestors, depth + 1));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`${path} contains an unsafe object key`);
      }
      assertStrictJson(entry, `${path}.${key}`, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
}

function validatedProviderTools(tools: readonly ProviderFunctionTool[]): readonly ProviderFunctionTool[] {
  if (!Array.isArray(tools)) throw new Error("Gemini Live tools must be an array");
  if (tools.length > MAX_PROVIDER_TOOLS) {
    throw new Error(`Gemini Live client tool safety limit is ${MAX_PROVIDER_TOOLS}`);
  }
  const names = new Set<string>();
  const cloned = tools.map((tool, index) => {
    if (!isRecord(tool) || tool.type !== "function") {
      throw new Error(`Gemini Live tool ${index} must be a provider function tool`);
    }
    if (typeof tool.name !== "string" || !PROVIDER_TOOL_NAME.test(tool.name)) {
      throw new Error(`Gemini Live tool ${index} has an invalid function name`);
    }
    if (names.has(tool.name)) throw new Error(`Gemini Live tool name ${tool.name} is duplicated`);
    names.add(tool.name);
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      throw new Error(`Gemini Live tool ${tool.name} must have a description`);
    }
    if (!isRecord(tool.parameters)) {
      throw new Error(`Gemini Live tool ${tool.name} parameters must be a JSON Schema object`);
    }
    if (tool.parameters.type !== "object") {
      throw new Error(`Gemini Live tool ${tool.name} parameters must describe an object`);
    }
    assertStrictJson(tool, `Gemini Live tool ${tool.name}`);

    let serialized: string;
    try {
      serialized = JSON.stringify(tool);
    } catch {
      throw new Error(`Gemini Live tool ${tool.name} must be JSON serializable`);
    }
    if (!serialized) throw new Error(`Gemini Live tool ${tool.name} must be JSON serializable`);
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed) || parsed.type !== "function" || !isRecord(parsed.parameters)) {
      throw new Error(`Gemini Live tool ${tool.name} contains non-JSON values`);
    }
    return parsed as ProviderFunctionTool;
  });
  const encoded = JSON.stringify(cloned);
  if (textBytes(encoded) > MAX_PROVIDER_TOOLS_BYTES) {
    throw new Error(`Gemini Live tool safety bound exceeded ${MAX_PROVIDER_TOOLS_BYTES} bytes`);
  }
  return Object.freeze(cloned.map((tool) => deepFreezeJson(tool as unknown as Record<string, unknown>) as unknown as ProviderFunctionTool));
}

/** Translate the common function representation without rewriting its schema. */
export function buildGeminiFunctionDeclarations(
  tools: readonly ProviderFunctionTool[],
): readonly Readonly<Record<string, unknown>>[] {
  const validated = validatedProviderTools(tools);
  return Object.freeze(validated.map((tool) => deepFreezeJson({
    name: tool.name,
    description: tool.description,
    behavior: "BLOCKING",
    parametersJsonSchema: structuredClone(tool.parameters),
  })));
}

export function buildGeminiLiveSetup(options: Pick<
  GeminiLiveClientOptions,
  "model" | "voice" | "instructions" | "resumeHandle" | "tools"
>): Record<string, unknown> {
  const model = options.model.startsWith("models/") ? options.model : `models/${options.model}`;
  const functionDeclarations = buildGeminiFunctionDeclarations(options.tools);
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
      tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : [],
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      ...(options.resumeHandle
        ? { sessionResumption: { handle: options.resumeHandle } }
        : {}),
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

const GEMINI_SETUP_UNVERIFIABLE_REASON =
  "Gemini BidiGenerateContentSetupComplete has no fields and does not echo the requested configuration";

function requestedButUnverifiable(value: unknown) {
  return Object.freeze({
    status: "unverifiable" as const,
    requestedSha256: sha256(canonicalJson(jsonValue(value))),
    reason: GEMINI_SETUP_UNVERIFIABLE_REASON,
  });
}

function geminiSetupConfigurationEvidence(
  setup: Readonly<Record<string, unknown>>,
): SessionConfigurationAcknowledgement {
  const generation = isRecord(setup.generationConfig) ? setup.generationConfig : {};
  const speech = isRecord(generation.speechConfig) ? generation.speechConfig : {};
  const realtimeInput = isRecord(setup.realtimeInputConfig) ? setup.realtimeInputConfig : {};
  return Object.freeze({
    schemaVersion: 1 as const,
    strictParityVerified: false,
    paidBenchmarkReady: false,
    session: requestedButUnverifiable(setup),
    fields: Object.freeze({
      model: requestedButUnverifiable(setup.model),
      voice: requestedButUnverifiable(speech.voiceConfig),
      instructions: requestedButUnverifiable(setup.systemInstruction),
      tools: requestedButUnverifiable(setup.tools),
      tool_choice: Object.freeze({
        status: "not_requested" as const,
        reason: "Gemini Live setup did not request a function-calling mode override",
      }),
      input_audio: requestedButUnverifiable({
        encoding: "pcm16",
        sampleRateHz: GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
        channels: 1,
        realtimeInputConfig: realtimeInput,
      }),
      output_audio: requestedButUnverifiable({
        encoding: "pcm16",
        sampleRateHz: GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ,
        channels: 1,
        responseModalities: generation.responseModalities,
      }),
      turn_detection: requestedButUnverifiable(realtimeInput),
    }),
  });
}

type GeminiWireObservationBuildInput = Readonly<{
  direction: "inbound" | "outbound";
  connectionEpoch: number;
  sequence: number;
  observedAtMs: number;
  observedAtMonotonicMs: number;
  event: Readonly<Record<string, unknown>>;
  exactSerialized: string;
  previousObservationSha256: string | null;
}>;

const GEMINI_CONFIGURATION_HASH_DOMAIN = "harshas-amazing-call-center/gemini-configuration/v1";
const GEMINI_USAGE_COUNTERS = [
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
] as const;

function buildGeminiWireObservation(input: GeminiWireObservationBuildInput): RealtimeWireObservation {
  const wireType = geminiWireType(input.event);
  const projection = deepFreezeJson(geminiRedactedWireProjection(input.event, wireType));
  const identities = deepFreezeJson(geminiWireIdentityProjection(input.event));
  const projectionSha256 = realtimeWireProjectionSha256(projection);
  const core = {
    schemaVersion: 1 as const,
    provider: "gemini" as const,
    direction: input.direction,
    connectionEpoch: input.connectionEpoch,
    sequence: input.sequence,
    observedAtMs: input.observedAtMs,
    observedAtMonotonicMs: input.observedAtMonotonicMs,
    wireType,
    payloadSha256: sha256(input.exactSerialized),
    payloadBytes: textBytes(input.exactSerialized),
    projectionSha256,
    previousObservationSha256: input.previousObservationSha256,
    identities,
    projection,
  };
  return deepFreezeJson({
    ...core,
    observationSha256: realtimeWireObservationSha256(core),
  });
}

function geminiWireType(event: Readonly<Record<string, unknown>>): string {
  if (own(event, "setup")) return "setup";
  if (own(event, "clientContent")) return "clientContent";
  if (isRecord(event.realtimeInput)) {
    if (own(event.realtimeInput, "activityStart")) return "realtimeInput.activityStart";
    if (own(event.realtimeInput, "audio")) return "realtimeInput.audio";
    if (own(event.realtimeInput, "text")) return "realtimeInput.text";
    if (own(event.realtimeInput, "activityEnd")) return "realtimeInput.activityEnd";
    return "realtimeInput";
  }
  if (own(event, "toolResponse")) return "toolResponse";
  const messageTypes = geminiServerMessageTypes(event);
  if (messageTypes.length === 1) return messageTypes[0]!;
  if (messageTypes.length > 1) return "mixedServerMessage";
  if (own(event, "usageMetadata")) return "usageMetadata";
  return "unknown";
}

function geminiRedactedWireProjection(
  event: Readonly<Record<string, unknown>>,
  wireType: string,
): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  const session = geminiSessionWireProjection(event, wireType);
  if (session) projection.session = session;
  const audio = geminiAudioWireProjection(event);
  if (audio) projection.audio = audio;
  const gatewayCalls = geminiGatewayCallWireProjection(event);
  if (gatewayCalls.length) projection.gatewayCalls = gatewayCalls;
  const gatewayResults = geminiGatewayResultWireProjection(event);
  if (gatewayResults.length) projection.gatewayResults = gatewayResults;
  const clientContent = isRecord(event.clientContent) ? event.clientContent : {};
  if (clientContent.turnComplete === false && Array.isArray(clientContent.turns)) {
    const texts = clientContent.turns.flatMap((turn) => (
      isRecord(turn) && Array.isArray(turn.parts)
        ? turn.parts.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : [])
        : []
    ));
    if (texts.length === 1) {
      projection.dynamicControl = {
        sha256: sha256(texts[0]!),
        byteLength: textBytes(texts[0]!),
        authority: "advisory_only_gateway_and_speech_gate_enforced",
      };
    }
  }
  const text = geminiTextWireProjection(event);
  if (text.length) projection.text = text;
  const usage = geminiUsageWireProjection(event);
  if (usage) projection.usage = usage;
  if (wireType === "error") projection.error = { code: "provider_error" };
  const terminal = geminiTerminalWireProjection(event);
  if (terminal) projection.terminal = terminal;
  return projection;
}

function geminiSessionWireProjection(
  event: Readonly<Record<string, unknown>>,
  wireType: string,
): Record<string, unknown> | undefined {
  if (wireType === "setupComplete") {
    return {
      acknowledgement: "readiness_only",
      fieldEchoAvailable: false,
      strictParityVerified: false,
      paidBenchmarkReady: false,
    };
  }
  if (wireType !== "setup" || !isRecord(event.setup)) return undefined;
  const setup = event.setup;
  const generation = isRecord(setup.generationConfig) ? setup.generationConfig : {};
  const speech = isRecord(generation.speechConfig) ? generation.speechConfig : {};
  const realtimeInput = isRecord(setup.realtimeInputConfig) ? setup.realtimeInputConfig : {};
  const automaticActivity = isRecord(realtimeInput.automaticActivityDetection)
    ? realtimeInput.automaticActivityDetection
    : {};
  const tools = Array.isArray(setup.tools) ? setup.tools : [];
  const fieldSha256 = {
    model: geminiConfigurationHash("model", setup.model),
    voice: geminiConfigurationHash("voice", speech.voiceConfig),
    instructions: geminiConfigurationHash("instructions", setup.systemInstruction),
    tools: geminiConfigurationHash("tools", tools),
    input_audio: geminiConfigurationHash("input_audio", {
      encoding: "pcm16",
      sampleRateHz: GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
      channels: 1,
      realtimeInputConfig: realtimeInput,
    }),
    output_audio: geminiConfigurationHash("output_audio", {
      encoding: "pcm16",
      sampleRateHz: GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ,
      channels: 1,
      responseModalities: generation.responseModalities,
    }),
    turn_detection: geminiConfigurationHash("turn_detection", realtimeInput),
  };
  return {
    present: true,
    configurationSha256: geminiConfigurationHash("session", setup),
    fieldSha256,
    toolCount: tools.length,
    inputFormat: { encoding: "pcm16", sampleRateHz: GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ, channels: 1 },
    outputFormat: { encoding: "pcm16", sampleRateHz: GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ, channels: 1 },
    manualActivityDetection: automaticActivity.disabled === true,
    providerTranscriptionPolicy: GEMINI_PROVIDER_TRANSCRIPTION_POLICY,
  };
}

function geminiConfigurationHash(field: string, value: unknown): string {
  return sha256(`${GEMINI_CONFIGURATION_HASH_DOMAIN}\0${field}\0${canonicalJson(jsonValue(value))}`);
}

function geminiAudioWireProjection(
  event: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (isRecord(event.realtimeInput)) {
    if (own(event.realtimeInput, "activityStart")) return { direction: "input", activity: "start" };
    if (own(event.realtimeInput, "activityEnd")) return { direction: "input", activity: "end" };
    if (isRecord(event.realtimeInput.audio)) {
      return {
        direction: "input",
        chunks: [geminiEncodedPcmEvidence(
          event.realtimeInput.audio.data,
          event.realtimeInput.audio.mimeType,
          GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
        )],
      };
    }
  }
  const content = isRecord(event.serverContent) ? event.serverContent : {};
  const turn = isRecord(content.modelTurn) ? content.modelTurn : {};
  const parts = Array.isArray(turn.parts) ? turn.parts : [];
  const chunks = parts.flatMap((part) => {
    const record = isRecord(part) ? part : {};
    if (!isRecord(record.inlineData)) return [];
    return [geminiEncodedPcmEvidence(
      record.inlineData.data,
      record.inlineData.mimeType,
      GEMINI_LIVE_OUTPUT_SAMPLE_RATE_HZ,
    )];
  });
  return chunks.length ? { direction: "output", chunks } : undefined;
}

function geminiEncodedPcmEvidence(
  encoded: unknown,
  mimeType: unknown,
  sampleRateHz: number,
): Record<string, unknown> {
  const format = { encoding: "pcm16", sampleRateHz, channels: 1 };
  if (typeof encoded !== "string") return { validCanonicalBase64: false, format };
  const encodedBytes = textBytes(encoded);
  try {
    const bytes = base64ToPcm16(encoded);
    return {
      validCanonicalBase64: true,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      encodedBytes,
      mimeTypeRecognized: new RegExp(`^audio/pcm;\\s*rate=${sampleRateHz}$`, "i").test(String(mimeType ?? "")),
      format,
    };
  } catch {
    return { validCanonicalBase64: false, encodedBytes, format };
  }
}

function geminiGatewayCallWireProjection(
  event: Readonly<Record<string, unknown>>,
): Record<string, unknown>[] {
  const toolCall = isRecord(event.toolCall) ? event.toolCall : {};
  const calls = Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : [];
  return calls.flatMap((candidate) => {
    const call = isRecord(candidate) ? candidate : {};
    if (call.name !== GEMINI_CAPABILITY_GATEWAY_NAME) return [];
    const argumentsEvidence = geminiJsonWireEvidence(call.args);
    const args = isRecord(call.args) ? call.args : {};
    const targetName = typeof args.tool_name === "string" ? args.tool_name : undefined;
    const targetArguments = own(args, "arguments") ? geminiJsonWireEvidence(args.arguments) : undefined;
    return [{
      gateway: GEMINI_CAPABILITY_GATEWAY_NAME,
      ...(typeof call.id === "string" ? { callIdSha256: realtimeWireIdentitySha256("call", call.id) } : {}),
      argumentsSha256: argumentsEvidence.sha256,
      argumentsBytes: argumentsEvidence.byteLength,
      argumentsJsonValid: true,
      ...(targetName ? { targetToolNameSha256: realtimeWireIdentitySha256("target-tool", targetName) } : {}),
      ...(targetArguments ? { targetArgumentsSha256: targetArguments.sha256 } : {}),
    }];
  });
}

function geminiGatewayResultWireProjection(
  event: Readonly<Record<string, unknown>>,
): Record<string, unknown>[] {
  const toolResponse = isRecord(event.toolResponse) ? event.toolResponse : {};
  const responses = Array.isArray(toolResponse.functionResponses) ? toolResponse.functionResponses : [];
  return responses.flatMap((candidate) => {
    const response = isRecord(candidate) ? candidate : {};
    if (response.name !== GEMINI_CAPABILITY_GATEWAY_NAME) return [];
    const resultEvidence = geminiJsonWireEvidence(response.response);
    return [{
      gateway: GEMINI_CAPABILITY_GATEWAY_NAME,
      ...(typeof response.id === "string"
        ? { callIdSha256: realtimeWireIdentitySha256("call", response.id) }
        : {}),
      resultSha256: resultEvidence.sha256,
      resultBytes: resultEvidence.byteLength,
      resultJsonValid: true,
    }];
  });
}

function geminiJsonWireEvidence(value: unknown): Readonly<{ sha256: string; byteLength: number }> {
  const serialized = canonicalJson(jsonValue(value));
  return Object.freeze({ sha256: sha256(serialized), byteLength: textBytes(serialized) });
}

function geminiTextWireProjection(
  event: Readonly<Record<string, unknown>>,
): Record<string, unknown>[] {
  const content = isRecord(event.serverContent) ? event.serverContent : {};
  const values: Array<{ kind: string; value: string }> = [];
  const clientContent = isRecord(event.clientContent) ? event.clientContent : {};
  if (Array.isArray(clientContent.turns)) {
    for (const turn of clientContent.turns) {
      if (!isRecord(turn) || !Array.isArray(turn.parts)) continue;
      for (const part of turn.parts) {
        if (isRecord(part) && typeof part.text === "string") {
          values.push({
            kind: clientContent.turnComplete === true ? "client_text_turn" : "client_context",
            value: part.text,
          });
        }
      }
    }
  }
  for (const [key, kind] of [
    ["inputTranscription", "input_transcript"],
    ["interimInputTranscription", "input_transcript"],
    ["outputTranscription", "output_transcript"],
  ] as const) {
    const transcription = isRecord(content[key]) ? content[key] : {};
    if (typeof transcription.text === "string") values.push({ kind, value: transcription.text });
  }
  const turn = isRecord(content.modelTurn) ? content.modelTurn : {};
  if (Array.isArray(turn.parts)) {
    for (const part of turn.parts) {
      if (isRecord(part) && typeof part.text === "string") values.push({ kind: "model_text", value: part.text });
    }
  }
  return values.map(({ kind, value }) => ({
    kind,
    sha256: sha256(value),
    byteLength: textBytes(value),
  }));
}

function geminiUsageWireProjection(
  event: Readonly<Record<string, unknown>>,
): Record<string, number> | undefined {
  if (!isRecord(event.usageMetadata)) return undefined;
  const normalized = normalizeGeminiUsage(event.usageMetadata);
  const usage: Record<string, number> = {};
  for (const key of GEMINI_USAGE_COUNTERS) {
    const value = normalized[key];
    if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function geminiTerminalWireProjection(
  event: Readonly<Record<string, unknown>>,
): Record<string, string> | undefined {
  const content = isRecord(event.serverContent) ? event.serverContent : {};
  if (content.turnComplete !== true) return undefined;
  const reason = typeof content.turnCompleteReason === "string" ? content.turnCompleteReason : "";
  const failed = reason === "RESPONSE_REJECTED"
    || reason === "MALFORMED_FUNCTION_CALL"
    || reason.includes("PROHIBITED");
  return { status: content.interrupted === true ? "interrupted" : failed ? "failed" : "completed" };
}

function geminiWireIdentityProjection(
  event: Readonly<Record<string, unknown>>,
): RealtimeWireObservation["identities"] {
  const ids: string[] = [];
  const calls = isRecord(event.toolCall) && Array.isArray(event.toolCall.functionCalls)
    ? event.toolCall.functionCalls
    : [];
  const responses = isRecord(event.toolResponse) && Array.isArray(event.toolResponse.functionResponses)
    ? event.toolResponse.functionResponses
    : [];
  const cancellations = isRecord(event.toolCallCancellation) && Array.isArray(event.toolCallCancellation.ids)
    ? event.toolCallCancellation.ids
    : [];
  for (const candidate of [...calls, ...responses]) {
    if (isRecord(candidate) && typeof candidate.id === "string") ids.push(candidate.id);
  }
  for (const id of cancellations) if (typeof id === "string") ids.push(id);
  const unique = [...new Set(ids)];
  return unique.length === 1 ? { callIdSha256: realtimeWireIdentitySha256("call", unique[0]!) } : {};
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
  private readonly maxDynamicControlBytes: number;
  private readonly maximumTrackedToolCallIdentities: number;
  private readonly maximumSessionDurationMs: number;
  private readonly providerTools: readonly ProviderFunctionTool[];
  private readonly providerToolsSha256: string;
  private readonly declaredToolNames: ReadonlySet<string>;
  private readonly resumptionEnabled: boolean;
  private readonly eventListeners = new Set<RealtimeEventListener>();
  private readonly wireEventListeners = new Set<RealtimeWireEventListener>();
  private readonly wireObservationListeners = new Set<RealtimeWireObservationListener>();
  private socket: RealtimeWebSocket | null = null;
  private connectionEpoch = 0;
  private wireSequence = 0;
  private wireObservationChainHead: string | null = null;
  private lastWireObservationMonotonicMs = Number.NEGATIVE_INFINITY;
  private activeWireArrival: WireArrival | null = null;
  private activeWireObservationAttribution: RealtimeWireObservationAttribution | undefined;
  private clientState: RealtimeClientState = "idle";
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private messageChain: Promise<void> = Promise.resolve();
  private inputOpen = false;
  private inputTurn = 0;
  private responseCounter = 0;
  private currentResponseId: string | null = null;
  private responseStarted = false;
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
  private toolCallResponseIds = new Map<string, string>();
  private cancelledToolCallIds = new Set<string>();
  private toolCallFingerprints = new Map<string, string>();
  private toolCallBatchKeys = new Map<string, string>();
  private toolCallBatches = new Map<string, readonly string[]>();
  private activeToolBatch: ActiveToolBatch | null = null;
  private toolBatchCounter = 0;
  private conflictedToolCallIds = new Set<string>();
  private resumption: ResumptionState;
  private pendingSetupConfiguration: PendingSetupConfiguration | null = null;
  private setupReadiness: GeminiSetupReadinessEvidence | null = null;
  private submittingToolResults = false;
  private responsePrepared = false;
  private clientMessageOrdinal = 0;
  private generationTrigger: GeminiGenerationTrigger | null = null;

  constructor(options: GeminiLiveClientOptions) {
    if (!options.model.trim()) throw new Error("Gemini Live model is required");
    if (!options.voice.trim()) throw new Error("Gemini Live voice is required");
    if (options.resumeHandle !== undefined && (
      !options.resumeHandle
      || options.resumeHandle.length > 4_096
      || /[\u0000-\u001f\u007f]/.test(options.resumeHandle)
    )) {
      throw new Error("Gemini resumeHandle must be a bounded opaque string without controls");
    }
    this.providerTools = validatedProviderTools(options.tools);
    this.providerToolsSha256 = sha256(canonicalJson(jsonValue(this.providerTools)));
    this.declaredToolNames = new Set(this.providerTools.map((tool) => tool.name));
    this.resumptionEnabled = options.resumeHandle !== undefined;
    if (options.executeCapabilityGateway && (
      this.providerTools.length !== 1
      || this.providerTools[0]?.name !== GEMINI_CAPABILITY_GATEWAY_NAME
    )) {
      throw new Error("Gemini internal capability gateway execution requires exactly the declared capability_gateway tool");
    }
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
    this.maxDynamicControlBytes = options.maxDynamicControlBytes ?? GEMINI_LIVE_DEFAULT_MAX_DYNAMIC_CONTROL_BYTES;
    this.maximumTrackedToolCallIdentities = options.maximumTrackedToolCallIdentities
      ?? MAX_TRACKED_FUNCTION_CALL_IDS;
    this.maximumSessionDurationMs = options.maximumSessionDurationMs ?? GEMINI_LIVE_MAX_AUDIO_ONLY_SESSION_MS;
    if (!Number.isFinite(this.connectTimeoutMs) || this.connectTimeoutMs <= 0) {
      throw new Error("Gemini connectTimeoutMs must be positive");
    }
    if (!Number.isInteger(this.maxIncomingMessageBytes) || this.maxIncomingMessageBytes <= 0) {
      throw new Error("Gemini maxIncomingMessageBytes must be a positive integer");
    }
    if (!Number.isInteger(this.maxToolResponseBytes) || this.maxToolResponseBytes <= 0) {
      throw new Error("Gemini maxToolResponseBytes must be a positive integer");
    }
    if (!Number.isInteger(this.maxDynamicControlBytes)
      || this.maxDynamicControlBytes <= 0
      || this.maxDynamicControlBytes > GEMINI_LIVE_HARD_MAX_DYNAMIC_CONTROL_BYTES) {
      throw new Error(
        `Gemini maxDynamicControlBytes must be from 1 to ${GEMINI_LIVE_HARD_MAX_DYNAMIC_CONTROL_BYTES}`,
      );
    }
    if (!Number.isInteger(this.maximumTrackedToolCallIdentities)
      || this.maximumTrackedToolCallIdentities < 1
      || this.maximumTrackedToolCallIdentities > MAX_TRACKED_FUNCTION_CALL_IDS) {
      throw new Error(
        `Gemini maximumTrackedToolCallIdentities must be from 1 to ${MAX_TRACKED_FUNCTION_CALL_IDS}`,
      );
    }
    if (!Number.isInteger(this.maximumSessionDurationMs)
      || this.maximumSessionDurationMs <= 0
      || this.maximumSessionDurationMs > GEMINI_LIVE_MAX_AUDIO_ONLY_SESSION_MS) {
      throw new Error(`Gemini maximumSessionDurationMs must be from 1 to ${GEMINI_LIVE_MAX_AUDIO_ONLY_SESSION_MS}`);
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

  get setupReadinessEvidence(): GeminiSetupReadinessEvidence | null {
    if (!this.setupReadiness) return null;
    return Object.freeze({
      ...this.setupReadiness,
      clientSentToolNames: Object.freeze([...this.setupReadiness.clientSentToolNames]),
    });
  }

  get sessionConfigurationAcknowledgement(): SessionConfigurationAcknowledgement | null {
    return this.setupReadiness?.configuration ?? null;
  }

  onEvent(listener: RealtimeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onWireEvent(listener: RealtimeWireEventListener): () => void {
    this.wireEventListeners.add(listener);
    return () => this.wireEventListeners.delete(listener);
  }

  onWireObservation(listener: RealtimeWireObservationListener): () => void {
    this.wireObservationListeners.add(listener);
    return () => this.wireObservationListeners.delete(listener);
  }

  connect(): Promise<void> {
    if (this.clientState === "ready") return Promise.resolve();
    if (this.clientState === "connecting" && this.connectPromise) return this.connectPromise;
    if (this.clientState === "closing") {
      return Promise.reject(new Error("Gemini Live cannot reconnect while the prior socket is closing"));
    }

    const url = this.options.url ?? buildGeminiLiveUrl(this.options.apiKey ?? "");
    this.clientState = "connecting";
    this.pendingSetupConfiguration = null;
    this.setupReadiness = null;
    this.wireSequence = 0;
    this.wireObservationChainHead = null;
    this.lastWireObservationMonotonicMs = Number.NEGATIVE_INFINITY;
    this.clearSessionTimer();
    this.messageChain = Promise.resolve();
    this.abortPendingToolCalls("Gemini Live started a new connection");
    this.outstandingToolCalls.clear();
    // setupComplete does not prove whether a requested resumption handle was
    // accepted. Treat provider call IDs as connection-scoped and rely on the
    // durable gateway's idempotency ledger for safe cross-connection replay.
    this.completedToolResponses.clear();
    this.toolCallResponseIds.clear();
    this.cancelledToolCallIds.clear();
    this.toolCallFingerprints.clear();
    this.toolCallBatchKeys.clear();
    this.toolCallBatches.clear();
    this.activeToolBatch = null;
    this.toolBatchCounter = 0;
    this.conflictedToolCallIds.clear();
    this.clientMessageOrdinal = 0;
    this.generationTrigger = null;
    this.currentResponseId = null;
    this.responseStarted = false;
    this.responseFinished = false;
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
      this.emitError(normalized, true, undefined, "socket_factory_failed", TRANSPORT_GENERATED_WIRE_ATTRIBUTION);
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
          } else if (this.clientState === "ready") {
            // A frame that cannot be recorded and normalized leaves a hole in
            // the evidence sequence. Continuing would make later audio/tool
            // effects unverifiable, so protocol corruption is terminal.
            this.failActiveConnection(binding, safeError(error), "invalid_provider_message");
          }
        });
    });
    socket.on("error", (rawError) => {
      if (!this.isCurrentConnection(binding)) return;
      const error = new Error("Gemini Live WebSocket failed");
      this.failActiveConnection(
        binding,
        error,
        "transport_error",
        createRealtimeTransportFailureDiagnostic({
          origin: "websocket_error",
          rawCode: isRecord(rawError) ? rawError.code : undefined,
          message: error.message,
          ...this.transportFailureLifecycle(),
        }),
      );
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
      this.emitError(error, true, undefined, "setup_timeout", TRANSPORT_GENERATED_WIRE_ATTRIBUTION);
      binding.socket.close(1000, "setup timeout");
    }, this.connectTimeoutMs);
    return this.connectPromise;
  }

  startActivity(): void {
    this.requireReady();
    if (this.inputOpen) throw new Error("Gemini input activity is already open");
    if (this.generationTrigger && this.generationTrigger.phase !== "terminal") {
      throw new Error("Gemini cannot start a new caller turn before the prior turn is terminal");
    }
    this.inputTranscriptAttributionAmbiguous = this.inputTurn > 0 && !this.inputProviderTranscriptFinished;
    this.inputProviderTranscriptFinished = false;
    this.inputOpen = true;
    this.inputTurn += 1;
    this.inputTranscript.reset();
    this.sendReady({ realtimeInput: { activityStart: {} } });
  }

  appendInputAudio(input: Pcm16Audio): void {
    this.requireReady();
    if (this.responsePrepared) throw new Error("Cannot append audio after preparing the next Gemini response");
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

  prepareResponse(preparation: RealtimeResponsePreparation): void {
    this.requireReady();
    if (!this.inputOpen) throw new Error("Gemini response preparation requires an open input activity");
    if (this.responsePrepared) throw new Error("Gemini response is already prepared");
    if (!preparation.additionalInstructions.trim()) {
      throw new Error("Gemini response preparation instructions cannot be empty");
    }
    if (preparation.contextAuthority !== "advisory_only_gateway_and_speech_gate_enforced") {
      throw new Error("Gemini response preparation authority boundary mismatch");
    }
    if (!/^[a-f0-9]{64}$/.test(preparation.contextSha256)
        || sha256(preparation.additionalInstructions) !== preparation.contextSha256) {
      throw new Error("Gemini response preparation hash mismatch");
    }
    const controlBytes = textBytes(preparation.additionalInstructions);
    if (controlBytes > this.maxDynamicControlBytes) {
      throw new RealtimeDynamicControlLimitError({
        provider: "gemini",
        actualBytes: controlBytes,
        maximumBytes: this.maxDynamicControlBytes,
      });
    }
    // Live setup is immutable. Dynamic advisory context travels through the
    // provider's ordered clientContent channel with turnComplete:false; caller
    // audio remains exclusively realtimeInput PCM and activityEnd is the only
    // generation trigger for this turn.
    this.sendReady({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: preparation.additionalInstructions }] }],
        turnComplete: false,
      },
    });
    this.responsePrepared = true;
  }

  endActivity(): void {
    this.requireReady();
    if (!this.inputOpen) throw new Error("Gemini input activity is not open");
    this.inputOpen = false;
    const sent = this.sendReady({ realtimeInput: { activityEnd: {} } });
    this.armGenerationTrigger("audio_activity_end", sent);
    this.responsePrepared = false;
  }

  commitInputAudio(): void {
    this.endActivity();
  }

  createResponse(overrides?: Record<string, unknown>): void {
    this.requireReady();
    if (overrides && Object.keys(overrides).length > 0) {
      throw new Error("Gemini per-response overrides cannot be delivered after activityEnd");
    }
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

  sendTextTurn(text: string): void {
    this.requireReady();
    if (this.inputOpen || this.responsePrepared) {
      throw new Error("Gemini text turn requires no open audio activity or prepared response");
    }
    if (!text.trim() || Buffer.byteLength(text, "utf8") > 16 * 1024) {
      throw new Error("Gemini text turn must be non-empty and at most 16384 UTF-8 bytes");
    }
    this.inputTranscriptAttributionAmbiguous = this.inputTurn > 0 && !this.inputProviderTranscriptFinished;
    this.inputProviderTranscriptFinished = false;
    this.inputTurn += 1;
    this.inputTranscript.reset();
    // Official Live API text-turn shape. Unlike realtimeInput.text inside an
    // activityStart/activityEnd pair, turnComplete reliably triggers model
    // generation without sending any caller-audio bytes.
    const sent = this.sendReady({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    });
    this.armGenerationTrigger("client_content", sent);
  }

  submitToolResults(results: readonly RealtimeToolResult[], createResponse = false): void {
    if (this.submittingToolResults) throw new Error("Gemini tool result submission cannot be re-entered");
    this.submittingToolResults = true;
    try {
      this.requireReady();
      if (this.options.executeCapabilityGateway) {
        throw new Error("Gemini client uses internal tool execution; external results are disabled");
      }
      const activeBatch = this.activeToolBatch;
      if (!activeBatch || activeBatch.callIds.size === 0) {
        throw new Error("No complete Gemini tool-call batch is awaiting results");
      }
      const snapshots = snapshotToolResultBatch(results);
      const seen = new Set<string>();
      for (const result of snapshots) {
        if (!result.callId) throw new Error("Gemini tool result callId cannot be empty");
        if (seen.has(result.callId)) throw new Error(`Duplicate Gemini tool result for ${result.callId}`);
        seen.add(result.callId);
      }
      const missing = [...activeBatch.callIds].filter((callId) => !seen.has(callId));
      const unknown = [...seen].filter((callId) => !activeBatch.callIds.has(callId));
      if (missing.length > 0 || unknown.length > 0) {
        throw new Error(
          `Gemini tool result batch mismatch (missing: ${missing.join(", ") || "none"}; `
          + `unknown: ${unknown.join(", ") || "none"})`,
        );
      }
      const responses = snapshots.map((result) => {
        const call = this.outstandingToolCalls.get(result.callId);
        if (!call) throw new Error(`No outstanding Gemini tool call ${result.callId}`);
        const name = typeof call.name === "string" && call.name ? call.name : GEMINI_CAPABILITY_GATEWAY_NAME;
        const response: FunctionResponse = { id: result.callId, name, response: result.response };
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
      if (this.activeToolBatch?.key !== activeBatch.key || this.clientState !== "ready") {
        throw new Error("Gemini tool result batch authority changed during canonicalization");
      }
      const socket = this.socket!;
      const binding = { socket, epoch: this.connectionEpoch } satisfies ConnectionBinding;
      let sent: Readonly<{ clientMessageOrdinal: number; observation?: RealtimeWireObservation }>;
      try {
        sent = this.sendReady(message);
      } catch {
        const failure = new Error("Gemini tool result batch send had an indeterminate outcome");
        this.failActiveConnection(binding, failure, "tool_response_send_failed");
        throw failure;
      }
      for (const response of responses) {
        this.outstandingToolCalls.delete(response.id);
        this.completedToolResponses.set(response.id, response);
      }
      if (this.activeToolBatch?.key === activeBatch.key) this.activeToolBatch = null;
      this.armGenerationTrigger("tool_response", sent);
      this.emit({
        type: "tool.results.submitted",
        responseId: activeBatch.responseId,
        responseIdSource: "client_local",
        callIds: responses.map((response) => response.id),
        continuationRequested: true,
      }, "toolResponse", sent.observation
        ? realtimeWireObservationReference(sent.observation)
        : CLIENT_GENERATED_WIRE_ATTRIBUTION);
      if (createResponse) this.createResponse();
    } finally {
      this.submittingToolResults = false;
    }
  }

  close(code = 1000, reason = "client close"): void {
    if (!this.socket || this.clientState === "closed") return;
    const wasConnecting = this.clientState === "connecting";
    const binding = { socket: this.socket, epoch: this.connectionEpoch } satisfies ConnectionBinding;
    this.clientState = "closing";
    this.inputOpen = false;
    this.responsePrepared = false;
    this.clearConnectTimer();
    this.clearSessionTimer();
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
      const setup = buildGeminiLiveSetup({
        model: this.options.model,
        voice: this.options.voice,
        instructions: this.options.instructions,
        tools: this.providerTools,
        resumeHandle: this.resumption.handle,
      });
      const setupFrame = JSON.stringify(setup);
      const setupRecord = isRecord(setup.setup) ? setup.setup : {};
      this.pendingSetupConfiguration = Object.freeze({
        connectionEpoch: binding.epoch,
        clientSentSetupFrameSha256: sha256(setupFrame),
        clientSentProviderToolsSha256: this.providerToolsSha256,
        clientSentFunctionDeclarationsSha256: sha256(canonicalJson(jsonValue(setupRecord.tools))),
        clientSentToolNames: Object.freeze(this.providerTools.map((tool) => tool.name)),
        clientSentModel: typeof setupRecord.model === "string" ? setupRecord.model : this.options.model,
        clientSentVoice: this.options.voice,
        providerTranscriptionPolicy: GEMINI_PROVIDER_TRANSCRIPTION_POLICY,
        configuration: geminiSetupConfigurationEvidence(setupRecord),
      });
      binding.socket.send(setupFrame);
      this.notifyWireObservation("outbound", setup, setupFrame);
      this.sessionTimer = setTimeout(() => this.enforceSessionLimit(binding), this.maximumSessionDurationMs);
      const nodeTimer = this.sessionTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
      nodeTimer.unref?.();
    } catch {
      this.pendingSetupConfiguration = null;
      const normalized = new Error("Gemini Live setup could not be sent");
      this.failConnect(normalized);
      this.emitError(normalized, true, undefined, "setup_send_failed", TRANSPORT_GENERATED_WIRE_ATTRIBUTION);
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
    const wireObservation = this.notifyWireObservation("inbound", frozen, text, arrival);
    this.activeWireArrival = arrival;
    this.activeWireObservationAttribution = wireObservation === undefined
      ? undefined
      : realtimeWireObservationReference(wireObservation);
    try {
      if (this.clientState === "connecting") {
        const setupKeys = Object.keys(frozen);
        const validSetup = own(frozen, "setupComplete")
          && isRecord(frozen.setupComplete)
          && Object.keys(frozen.setupComplete).length === 0
          && setupKeys.every((key) => key === "setupComplete" || key === "usageMetadata")
          && (!own(frozen, "usageMetadata") || isRecord(frozen.usageMetadata));
        if (validSetup) {
          const becameReady = this.handleSetupComplete(binding);
          if (isRecord(frozen.usageMetadata) && becameReady) {
            this.handleUsage(frozen.usageMetadata);
          }
        } else {
          this.failActiveConnection(
            binding,
            new Error("Gemini Live received an invalid or non-exclusive setup acknowledgement"),
            "invalid_setup_ack",
          );
          this.notifyWireObservers(frozen, arrival);
          return;
        }
        // setupComplete is an empty readiness signal. usageMetadata is the only
        // legal sibling metadata; no requested configuration fields are echoed.
        this.notifyWireObservers(frozen, arrival);
        return;
      }

      if (this.clientState !== "ready") {
        this.notifyWireObservers(frozen, arrival);
        return;
      }

      const messageTypes = geminiServerMessageTypes(frozen);
      if (messageTypes.length > 1) {
        this.failActiveConnection(
          binding,
          new Error(`Gemini Live mixed mutually exclusive server messages: ${messageTypes.join(", ")}`),
          "mixed_server_message_union",
        );
        this.notifyWireObservers(frozen, arrival);
        return;
      }
      if (own(frozen, "setupComplete")) {
        this.failActiveConnection(
          binding,
          new Error("Gemini Live repeated setupComplete after readiness"),
          "repeated_setup_ack",
        );
        this.notifyWireObservers(frozen, arrival);
        return;
      }
      if (own(frozen, "usageMetadata") && !isRecord(frozen.usageMetadata)) {
        this.failActiveConnection(
          binding,
          new Error("Gemini Live usageMetadata was not an object"),
          "invalid_usage_metadata",
        );
        this.notifyWireObservers(frozen, arrival);
        return;
      }

      const usage = isRecord(frozen.usageMetadata) ? frozen.usageMetadata : undefined;
      if (isRecord(frozen.sessionResumptionUpdate)) this.handleResumption(frozen.sessionResumptionUpdate);
      if (isRecord(frozen.goAway)) this.handleGoAway(frozen.goAway);
      if (isRecord(frozen.serverContent)) this.handleServerContent(binding, frozen.serverContent);
      if (this.clientState !== "ready") {
        this.notifyWireObservers(frozen, arrival);
        return;
      }
      if (isRecord(frozen.toolCall)) this.handleToolCalls(binding, frozen.toolCall);
      if (isRecord(frozen.toolCallCancellation)) {
        this.handleToolCancellation(binding, frozen.toolCallCancellation);
      }
      if (isRecord(frozen.error)) {
        const message = typeof frozen.error.message === "string" ? frozen.error.message : "Gemini Live protocol error";
        this.emitError(new Error(message.slice(0, 2_000)), false, frozen.error);
      }
      if (usage) this.handleUsage(usage);

      this.notifyWireObservers(frozen, arrival);
    } finally {
      if (this.activeWireArrival === arrival) this.activeWireArrival = null;
      this.activeWireObservationAttribution = undefined;
    }
  }

  private notifyWireObservers(
    frozen: Readonly<Record<string, unknown>>,
    arrival: WireArrival,
  ) {
    // All normalized effects have already been derived. Clear frame attribution
    // before invoking external raw observers so a re-entrant client action
    // cannot counterfeit provenance from the provider frame.
    if (this.activeWireArrival === arrival) this.activeWireArrival = null;
    this.activeWireObservationAttribution = undefined;
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
      this.options.onRawMessage?.(observerEvent, arrival.wallMs);
    } catch {
      // Artifact consumers cannot be allowed to corrupt protocol processing.
    }
  }

  private notifyWireObservation(
    direction: "inbound" | "outbound",
    event: Readonly<Record<string, unknown>>,
    exactSerialized: string,
    arrival?: WireArrival,
  ): RealtimeWireObservation | undefined {
    if (!this.wireObservationListeners.size) return undefined;
    const observedAtMs = arrival?.wallMs ?? this.now();
    const rawMonotonicMs = arrival?.monotonicMs ?? this.monotonicNow();
    if (!Number.isFinite(observedAtMs) || !Number.isFinite(rawMonotonicMs)) {
      throw new Error("Gemini wire observation clocks must be finite");
    }
    // Provider callbacks can arrive while a prior asynchronous frame is still
    // being normalized. Preserve processing order without emitting a decreasing
    // clock, which would make the evidence chain internally contradictory.
    const observedAtMonotonicMs = Math.max(rawMonotonicMs, this.lastWireObservationMonotonicMs);
    const sequence = this.wireSequence + 1;
    const observation = buildGeminiWireObservation({
      direction,
      connectionEpoch: this.connectionEpoch,
      sequence,
      observedAtMs,
      observedAtMonotonicMs,
      event,
      exactSerialized,
      previousObservationSha256: this.wireObservationChainHead,
    });
    this.wireSequence = sequence;
    this.wireObservationChainHead = observation.observationSha256;
    this.lastWireObservationMonotonicMs = observedAtMonotonicMs;
    for (const listener of this.wireObservationListeners) {
      try { listener(observation); } catch { /* evidence observers are isolated */ }
    }
    return observation;
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

  private handleSetupComplete(binding: ConnectionBinding): boolean {
    if (!this.isCurrentConnection(binding) || this.clientState !== "connecting") return false;
    const pending = this.pendingSetupConfiguration;
    if (!pending || pending.connectionEpoch !== binding.epoch) {
      this.failActiveConnection(
        binding,
        new Error("Gemini Live setup acknowledgement had no matching setup frame"),
        "setup_ack_binding_missing",
      );
      return false;
    }
    const acknowledged = Object.freeze({
      ...pending,
      acknowledgement: "setupComplete" as const,
      fieldEchoAvailable: false as const,
    });
    this.setupReadiness = acknowledged;
    this.pendingSetupConfiguration = null;
    this.clientState = "ready";
    this.clearConnectTimer();
    this.emit({
      type: "provider.event",
      data: {
        name: "session.setup_completed",
        acknowledgement: acknowledged.acknowledgement,
        acknowledgement_scope: "readiness_only",
        field_echo_available: acknowledged.fieldEchoAvailable,
        configuration_verification_scope: "none",
        client_sent_setup_frame_sha256: acknowledged.clientSentSetupFrameSha256,
        client_sent_provider_tools_sha256: acknowledged.clientSentProviderToolsSha256,
        client_sent_function_declarations_sha256: acknowledged.clientSentFunctionDeclarationsSha256,
        client_sent_tool_names: [...acknowledged.clientSentToolNames],
        client_sent_model: acknowledged.clientSentModel,
        client_sent_voice: acknowledged.clientSentVoice,
        provider_transcription_policy: acknowledged.providerTranscriptionPolicy,
        connection_epoch: acknowledged.connectionEpoch,
        configuration_strict_parity_verified: acknowledged.configuration.strictParityVerified,
      },
    }, "setupComplete");
    this.emit({ type: "session.ready", configuration: acknowledged.configuration }, "setupComplete");
    this.resolveConnect?.();
    this.resolveConnect = null;
    this.rejectConnect = null;
    return true;
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
      const responseId = this.currentResponseId ?? this.ensureResponseStarted();
      this.currentResponseInterrupted = true;
      this.emit({
        type: "turn.interrupted",
        responseId,
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
      if (this.activeToolBatch?.callIds.size || this.generationTrigger?.phase === "awaiting_tool_result") {
        this.failActiveConnection(
          binding,
          new Error("Gemini ended a turn before the blocking tool-call batch received its results"),
          "turn_completed_before_tool_results",
        );
        return;
      }
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
        responseId: responseId!,
        source: "audio",
      }, "serverContent.outputTranscription");
    }
  }

  private finalizeTranscript(kind: "input" | "output") {
    const assembler = kind === "input" ? this.inputTranscript : this.outputTranscript;
    if (!assembler.text || assembler.final) return;
    assembler.final = true;
    const responseId = kind === "output" ? this.currentResponseId ?? this.ensureResponseStarted() : undefined;
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
        itemId: `${responseId!}-transcript`,
        responseId: responseId!,
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
    if (toolCall.functionCalls.length > MAX_FUNCTION_CALLS_PER_BATCH) {
      this.failActiveConnection(
        binding,
        new Error(`Gemini returned more than ${MAX_FUNCTION_CALLS_PER_BATCH} function calls in one batch`),
        "tool_call_batch_too_large",
      );
      return;
    }

    const seen = new Set<string>();
    const calls: FunctionCall[] = [];
    for (const raw of toolCall.functionCalls) {
      if (!isRecord(raw)
        || typeof raw.id !== "string"
        || !GEMINI_FUNCTION_CALL_ID.test(raw.id)
        || textBytes(raw.id) > MAX_FUNCTION_CALL_ID_LENGTH
        || typeof raw.name !== "string"
        || !PROVIDER_TOOL_NAME.test(raw.name)
        || textBytes(raw.name) > 128) {
        this.failActiveConnection(
          binding,
          new Error(
            `Gemini returned a function call without a canonical, bounded id and name `
            + `(id max ${MAX_FUNCTION_CALL_ID_LENGTH} bytes)`,
          ),
          "invalid_tool_call_identity",
        );
        return;
      }
      if (!this.declaredToolNames.has(raw.name)) {
        this.failActiveConnection(
          binding,
          new Error("Gemini returned an undeclared function name"),
          "undeclared_tool_call",
        );
        return;
      }
      if (!isRecord(raw.args)) {
        this.failActiveConnection(
          binding,
          new Error("Gemini returned function arguments that were not an object"),
          "invalid_tool_call_arguments",
        );
        return;
      }
      try {
        assertStrictJson(raw.args, `Gemini function arguments for ${raw.id}`);
      } catch {
        this.failActiveConnection(
          binding,
          new Error("Gemini returned unsafe or non-JSON function arguments"),
          "invalid_tool_call_arguments",
        );
        return;
      }
      if (seen.has(raw.id)) {
        this.failActiveConnection(
          binding,
          new Error(`Gemini repeated function call id ${raw.id} inside one batch`),
          "duplicate_tool_call_id",
        );
        return;
      }
      seen.add(raw.id);
      const call: FunctionCall = { id: raw.id, name: raw.name, args: raw.args, responseId: "" };
      call.fingerprint = functionCallFingerprint(call);
      calls.push(call);
    }

    const fresh: FunctionCall[] = [];
    const replayed: FunctionCall[] = [];
    for (const call of calls) {
      const id = call.id as string;
      const previous = this.toolCallFingerprints.get(id);
      if (previous === undefined) {
        fresh.push(call);
      } else if (previous === call.fingerprint) {
        replayed.push(call);
      } else {
        this.conflictedToolCallIds.add(id);
        const pending = this.pendingToolCalls.get(id);
        if (pending) {
          pending.cancelled = true;
          pending.controller.abort(new Error("Gemini reused a function call id with conflicting contents"));
        }
        this.outstandingToolCalls.delete(id);
        this.failActiveConnection(
          binding,
          new Error(`Gemini function call id ${id} was reused with different contents`),
          "duplicate_tool_call_conflict",
        );
        return;
      }
    }

    if (fresh.length > 0 && replayed.length > 0) {
      this.failActiveConnection(
        binding,
        new Error("Gemini mixed replayed and new function call identities in one batch"),
        "mixed_tool_call_replay",
      );
      return;
    }

    if (replayed.length > 0) {
      this.handleExactToolBatchReplay(binding, replayed);
      return;
    }

    if (this.activeToolBatch?.callIds.size) {
      this.failActiveConnection(
        binding,
        new Error("Gemini emitted an overlapping function-call batch before the prior batch was resolved"),
        "overlapping_tool_batch",
      );
      return;
    }
    if (this.toolCallFingerprints.size + fresh.length > this.maximumTrackedToolCallIdentities) {
      this.failActiveConnection(
        binding,
        new Error(
          `Gemini function-call identity ledger exceeded ${this.maximumTrackedToolCallIdentities} entries`,
        ),
        "tool_call_identity_capacity_exceeded",
      );
      return;
    }

    const responseId = this.ensureResponseStarted();
    const trigger = this.generationTrigger!;
    if (trigger.phase !== "awaiting_provider" && trigger.phase !== "awaiting_post_tool") {
      this.failActiveConnection(
        binding,
        new Error(`Gemini tool call arrived during invalid lifecycle phase ${trigger.phase}`),
        "tool_call_lifecycle_phase_mismatch",
      );
      return;
    }
    const batchKey = `${binding.epoch}:${++this.toolBatchCounter}`;
    const callIds = fresh.map((call) => call.id as string);
    this.toolCallBatches.set(batchKey, Object.freeze([...callIds]));
    this.activeToolBatch = { key: batchKey, responseId, callIds: new Set(callIds) };
    this.generationTrigger = Object.freeze({ ...trigger, phase: "awaiting_tool_result" });
    for (const call of fresh) {
      const id = call.id as string;
      call.responseId = responseId;
      this.toolCallFingerprints.set(id, call.fingerprint!);
      this.toolCallBatchKeys.set(id, batchKey);
      this.outstandingToolCalls.set(id, call);
      this.toolCallResponseIds.set(id, responseId);
    }

    const normalized = fresh.map((call) => {
      const id = typeof call.id === "string" ? call.id : "";
      const name = typeof call.name === "string" ? call.name : "";
      let argumentsJson: Record<string, JsonValue> | null = null;
      let argumentsError: string | undefined;
      if (isRecord(call.args)) argumentsJson = jsonRecord(call.args);
      else argumentsError = "Function arguments were not an object";
      return {
        callId: id,
        name,
        argumentsText: JSON.stringify(argumentsJson ?? null),
        argumentsJson,
        responseId,
        responseIdSource: "client_local" as const,
        causalBinding: Object.freeze({
          connectionEpoch: trigger.connectionEpoch,
          inputTurn: trigger.inputTurn,
          trigger: trigger.trigger,
          clientMessageOrdinal: trigger.clientMessageOrdinal,
          ...(trigger.triggerObservationSha256
            ? { triggerObservationSha256: trigger.triggerObservationSha256 }
            : {}),
          providerCallId: id,
          localResponseId: responseId,
        }),
        terminalWireType: "toolCall",
        ...(argumentsError ? { argumentsError } : {}),
      };
    });
    this.emit({ type: "tool.calls", responseId, calls: normalized }, "toolCall");

    if (this.options.executeCapabilityGateway) {
      void this.executeToolBatch(binding, batchKey, fresh).catch((error) => {
        if (this.isCurrentConnection(binding)) this.emitError(safeError(error), false);
      });
    }
  }

  private handleExactToolBatchReplay(binding: ConnectionBinding, calls: FunctionCall[]) {
    const batchKeys = new Set(calls.map((call) => this.toolCallBatchKeys.get(call.id as string)));
    if (batchKeys.size !== 1 || batchKeys.has(undefined)) {
      this.failActiveConnection(
        binding,
        new Error("Gemini replayed function calls that were not admitted as one exact batch"),
        "invalid_tool_batch_replay",
      );
      return;
    }
    const batchKey = [...batchKeys][0]!;
    const originalIds = this.toolCallBatches.get(batchKey);
    const replayIds = new Set(calls.map((call) => call.id as string));
    if (!originalIds
      || originalIds.length !== replayIds.size
      || originalIds.some((id) => !replayIds.has(id))) {
      this.failActiveConnection(
        binding,
        new Error("Gemini replayed only part of a previously admitted function-call batch"),
        "partial_tool_batch_replay",
      );
      return;
    }

    // An in-flight exact retry is already represented by the first event and
    // must never become a second executable tool.calls event.
    if (this.activeToolBatch?.key === batchKey) return;
    if (originalIds.some((id) => this.cancelledToolCallIds.has(id))) return;
    const responses = originalIds.map((id) => this.completedToolResponses.get(id));
    if (responses.some((response) => response === undefined)) return;
    const message = { toolResponse: { functionResponses: responses as FunctionResponse[] } };
    if (textBytes(JSON.stringify(message)) > this.maxToolResponseBytes) {
      this.failActiveConnection(
        binding,
        new Error("Gemini replay tool response batch was too large"),
        "tool_response_batch_too_large",
      );
      return;
    }
    try {
      this.sendReadyFor(binding, message);
    } catch {
      this.failActiveConnection(
        binding,
        new Error("Gemini replay tool response send had an indeterminate outcome"),
        "tool_response_replay_send_failed",
      );
    }
  }

  private async executeToolBatch(binding: ConnectionBinding, batchKey: string, calls: FunctionCall[]) {
    const responses = await Promise.all(calls.map((call) => this.executeToolCall(call)));
    if (!this.isCurrentConnection(binding) || this.clientState !== "ready") return;
    const activeBatch = this.activeToolBatch;
    if (!activeBatch || activeBatch.key !== batchKey) return;
    const active = responses.filter((response): response is FunctionResponse => (
      response !== null && activeBatch.callIds.has(response.id)
    ));
    if (active.length !== activeBatch.callIds.size) {
      this.failActiveConnection(
        binding,
        new Error("Gemini internal executor did not terminalize the complete active tool-call batch"),
        "incomplete_tool_response_batch",
      );
      return;
    }
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
    let sent: Readonly<{ clientMessageOrdinal: number; observation?: RealtimeWireObservation }>;
    try {
      const delivered = this.sendReadyFor(binding, message);
      if (!delivered) return;
      sent = delivered;
    } catch {
      this.failActiveConnection(
        binding,
        new Error("Gemini internal tool response batch send had an indeterminate outcome"),
        "tool_response_send_failed",
      );
      return;
    }
    for (const response of unique) {
      this.outstandingToolCalls.delete(response.id);
      this.completedToolResponses.set(response.id, response);
    }
    if (this.activeToolBatch?.key === batchKey) this.activeToolBatch = null;
    this.armGenerationTrigger("tool_response", sent);
    this.emit({
      type: "tool.results.submitted",
      responseId: activeBatch.responseId,
      responseIdSource: "client_local",
      callIds: unique.map((response) => response.id),
      continuationRequested: true,
    }, "toolResponse", sent.observation
      ? realtimeWireObservationReference(sent.observation)
      : CLIENT_GENERATED_WIRE_ATTRIBUTION);
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
      if (!this.declaredToolNames.has(name)) {
        response = this.errorFunctionResponse(
          id,
          name || GEMINI_CAPABILITY_GATEWAY_NAME,
          `Tool ${name || "<unnamed>"} is not declared in this session`
        );
      } else if (!isRecord(call.args)) {
        response = this.errorFunctionResponse(id, name, "Function arguments must be an object");
      } else {
        try {
          if (!this.options.executeCapabilityGateway) {
            return this.errorFunctionResponse(id, name, "No internal function executor is configured");
          }
          const output = await this.options.executeCapabilityGateway({
            callId: id,
            name: GEMINI_CAPABILITY_GATEWAY_NAME,
            arguments: jsonRecord(call.args),
            signal: controller.signal,
          });
          if (pending.cancelled || controller.signal.aborted) return null;
          response = { id, name, response: functionResponseRecord(output) };
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

  private handleToolCancellation(binding: ConnectionBinding, cancellation: Record<string, unknown>) {
    if (!Array.isArray(cancellation.ids)
      || cancellation.ids.length === 0
      || cancellation.ids.length > MAX_FUNCTION_CALLS_PER_BATCH) {
      this.failActiveConnection(
        binding,
        new Error(`Gemini tool cancellation must contain 1 to ${MAX_FUNCTION_CALLS_PER_BATCH} known ids`),
        "invalid_tool_cancellation",
      );
      return;
    }
    const candidates = cancellation.ids;
    const candidateIds = candidates.filter((candidate): candidate is string => typeof candidate === "string");
    if (candidateIds.length !== candidates.length
      || candidateIds.some((id) => !GEMINI_FUNCTION_CALL_ID.test(id) || textBytes(id) > MAX_FUNCTION_CALL_ID_LENGTH)
      || new Set(candidateIds).size !== candidateIds.length
      || candidateIds.some((id) => !this.toolCallFingerprints.has(id))) {
      this.failActiveConnection(
        binding,
        new Error("Gemini cancelled a malformed, duplicate, or unknown function call identity"),
        "invalid_tool_cancellation",
      );
      return;
    }
    const callIdsByResponse = new Map<string, string[]>();
    const unscopedCallIds: string[] = [];
    const completedIds: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidateIds) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const responseId = this.toolCallResponseIds.get(candidate);
      if (responseId) {
        const callIds = callIdsByResponse.get(responseId) ?? [];
        callIds.push(candidate);
        callIdsByResponse.set(responseId, callIds);
      } else {
        unscopedCallIds.push(candidate);
      }
      this.cancelledToolCallIds.add(candidate);
      const pending = this.pendingToolCalls.get(candidate);
      const alreadyCompleted = this.completedToolResponses.has(candidate);
      if (alreadyCompleted) completedIds.push(candidate);
      if (pending) {
        pending.cancelled = true;
        pending.controller.abort(new Error("Gemini cancelled this function call"));
      }
      this.outstandingToolCalls.delete(candidate);
      if (this.activeToolBatch?.callIds.has(candidate)) {
        this.activeToolBatch.callIds.delete(candidate);
      }
    }
    if (this.activeToolBatch?.callIds.size === 0) this.activeToolBatch = null;
    for (const [responseId, callIds] of callIdsByResponse) {
      this.emit({ type: "tool.cancelled", responseId, callIds }, "toolCallCancellation");
    }
    if (unscopedCallIds.length > 0) {
      this.emitError(
        new Error("Gemini cancelled unknown function call ids without response provenance"),
        false,
        undefined,
        "unscoped_tool_cancellation",
      );
    }
    if (completedIds.length > 0) {
      this.emit({
        type: "provider.event",
        data: { name: "tool_cancellation_after_completion", callIds: completedIds },
      }, "toolCallCancellation");
    }
  }

  private handleResumption(update: Record<string, unknown>) {
    const resumable = update.resumable === true;
    const newHandle = typeof update.newHandle === "string" && update.newHandle ? update.newHandle : undefined;
    const lastConsumed = typeof update.lastConsumedClientMessageIndex === "string"
      ? update.lastConsumedClientMessageIndex
      : undefined;
    if (!this.resumptionEnabled) {
      // Session resumption changes failure/replay semantics and therefore stays
      // opt-in. A provider-offered handle cannot silently enable it after setup.
      this.resumption = { resumable: false };
      this.emit({
        type: "provider.event",
        data: { name: "session_resumption_ignored", reason: "not_explicitly_enabled" },
      }, "sessionResumptionUpdate");
      return;
    }
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
    const trigger = this.generationTrigger;
    if (!trigger || trigger.phase === "terminal" || trigger.connectionEpoch !== this.connectionEpoch) {
      throw new Error("Gemini provider response had no matching local generation trigger");
    }
    if (this.currentResponseId && !this.responseFinished && this.responseStarted) return this.currentResponseId;
    const hadPreviousResponse = this.currentResponseId !== null;
    this.outputTranscriptAttributionAmbiguous = hadPreviousResponse && !this.outputProviderTranscriptFinished;
    this.outputProviderTranscriptFinished = false;
    this.responseCounter += 1;
    this.currentResponseId = trigger.localResponseId;
    this.responseStarted = true;
    this.responseFinished = false;
    this.currentResponseInterrupted = false;
    this.outputTranscript.reset();
    this.emit({
      type: "response.started",
      responseId: this.currentResponseId,
      responseIdSource: "client_local",
    }, "serverContent");
    return this.currentResponseId;
  }

  private completeResponse(
    status: RealtimeResponseTerminalStatus,
    reason?: string,
    wireType = "serverContent.turnComplete",
    syntheticAttribution: RealtimeWireObservationAttribution = CLIENT_GENERATED_WIRE_ATTRIBUTION,
  ) {
    if (!this.currentResponseId || this.responseFinished) return;
    this.responseFinished = true;
    if (this.generationTrigger) {
      this.generationTrigger = Object.freeze({ ...this.generationTrigger, phase: "terminal" });
    }
    this.emit({
      type: "response.completed",
      responseId: this.currentResponseId,
      responseIdSource: "client_local",
      status,
      ...(reason && reason !== "turn_complete" ? { reason } : {}),
    }, wireType, syntheticAttribution);
  }

  private sendReady(message: Record<string, unknown>): Readonly<{
    clientMessageOrdinal: number;
    observation?: RealtimeWireObservation;
  }> {
    this.requireReady();
    const encoded = JSON.stringify(message);
    this.socket!.send(encoded);
    const observation = this.notifyWireObservation("outbound", message, encoded);
    return Object.freeze({
      clientMessageOrdinal: ++this.clientMessageOrdinal,
      ...(observation ? { observation } : {}),
    });
  }

  private armGenerationTrigger(
    trigger: GeminiGenerationTrigger["trigger"],
    sent: Readonly<{ clientMessageOrdinal: number; observation?: RealtimeWireObservation }>,
  ): void {
    const active = this.generationTrigger;
    if (trigger === "tool_response") {
      if (!active || active.phase !== "awaiting_tool_result") {
        throw new Error("Gemini tool response has no causally pending provider tool call");
      }
      // Gemini Live has no provider response IDs and does not emit a second
      // response-start frame after a function response. Model that documented
      // wire absence locally: the outbound toolResponse closes the call phase
      // and arms a distinct continuation phase. The next provider content,
      // terminal, and usage events are therefore bound to this new client-local
      // identity instead of being incorrectly attributed to the tool-call phase.
      const localResponseId = `gemini-local-response-${this.connectionEpoch}-${this.inputTurn}-continuation-${this.responseCounter + 1}`;
      this.currentResponseId = localResponseId;
      this.responseStarted = false;
      this.responseFinished = false;
      this.currentResponseInterrupted = false;
      this.generationTrigger = Object.freeze({
        ...active,
        localResponseId,
        trigger,
        clientMessageOrdinal: sent.clientMessageOrdinal,
        ...(sent.observation ? { triggerObservationSha256: sent.observation.observationSha256 } : {}),
        phase: "awaiting_post_tool",
      });
      return;
    }
    if (active && active.phase !== "terminal") {
      throw new Error("Gemini generation trigger overlaps a non-terminal turn");
    }
    const localResponseId = `gemini-local-response-${this.connectionEpoch}-${this.inputTurn}`;
    this.currentResponseId = localResponseId;
    this.responseStarted = false;
    this.responseFinished = false;
    this.currentResponseInterrupted = false;
    this.generationTrigger = Object.freeze({
      localResponseId,
      connectionEpoch: this.connectionEpoch,
      inputTurn: this.inputTurn,
      trigger,
      clientMessageOrdinal: sent.clientMessageOrdinal,
      ...(sent.observation ? { triggerObservationSha256: sent.observation.observationSha256 } : {}),
      phase: "awaiting_provider",
    });
  }

  private sendReadyFor(
    binding: ConnectionBinding,
    message: Record<string, unknown>,
  ): false | Readonly<{ clientMessageOrdinal: number; observation?: RealtimeWireObservation }> {
    if (!this.isCurrentConnection(binding) || this.clientState !== "ready" || binding.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const encoded = JSON.stringify(message);
    binding.socket.send(encoded);
    const observation = this.notifyWireObservation("outbound", message, encoded);
    return Object.freeze({
      clientMessageOrdinal: ++this.clientMessageOrdinal,
      ...(observation ? { observation } : {}),
    });
  }

  private requireReady() {
    if (this.clientState !== "ready" || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live setup is not complete");
    }
  }

  private handleClose(binding: ConnectionBinding, code?: number, reason?: string) {
    if (!this.isCurrentConnection(binding)) return;
    const transportDiagnostic = createRealtimeTransportFailureDiagnostic({
      origin: "websocket_close",
      closeCode: code,
      reason,
      ...this.transportFailureLifecycle(),
    });
    const wasConnecting = this.clientState === "connecting";
    const wasFailed = this.clientState === "failed";
    if (!wasFailed) this.clientState = "closed";
    this.socket = null;
    this.inputOpen = false;
    this.responsePrepared = false;
    this.clearConnectTimer();
    this.clearSessionTimer();
    this.abortPendingToolCalls("Gemini Live connection closed");
    this.outstandingToolCalls.clear();
    if (wasConnecting) this.rejectPendingConnect(new Error("Gemini Live closed before setup completed"));
    if (this.currentResponseId && !this.responseFinished) {
      this.completeResponse(
        "failed",
        "connection_closed",
        "socket.close",
        TRANSPORT_GENERATED_WIRE_ATTRIBUTION,
      );
    }
    this.emit({
      type: "connection.closed",
      ...(typeof code === "number" ? { code } : {}),
      ...(typeof reason === "string" ? { reason: this.sanitizeDiagnostic(reason) } : {}),
      ...(typeof code === "number" ? { clean: code === 1000 } : {}),
      transportDiagnostic,
    }, "close", TRANSPORT_GENERATED_WIRE_ATTRIBUTION);
  }

  private failConnect(error: Error) {
    if (this.clientState === "connecting") this.clientState = "failed";
    this.clearConnectTimer();
    this.clearSessionTimer();
    this.abortPendingToolCalls("Gemini Live connection failed");
    this.outstandingToolCalls.clear();
    this.rejectPendingConnect(error);
  }

  private failActiveConnection(
    binding: ConnectionBinding,
    error: Error,
    code: string,
    transportDiagnostic: RealtimeTransportFailureDiagnostic = createRealtimeTransportFailureDiagnostic({
      origin: "client_transport",
      rawCode: code,
      message: error.message,
      ...this.transportFailureLifecycle(),
    }),
  ) {
    if (!this.isCurrentConnection(binding)) return;
    this.clientState = "failed";
    this.clearConnectTimer();
    this.clearSessionTimer();
    this.abortPendingToolCalls("Gemini Live connection failed");
    this.outstandingToolCalls.clear();
    this.rejectPendingConnect(error);
    if (this.currentResponseId && !this.responseFinished) {
      this.completeResponse("failed", code, "client.transport", TRANSPORT_GENERATED_WIRE_ATTRIBUTION);
    }
    this.emitError(
      error,
      true,
      undefined,
      code,
      TRANSPORT_GENERATED_WIRE_ATTRIBUTION,
      transportDiagnostic,
    );
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
    this.activeToolBatch = null;
  }

  private isCurrentConnection(binding: ConnectionBinding): boolean {
    return this.socket === binding.socket && this.connectionEpoch === binding.epoch;
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearSessionTimer() {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
  }

  private transportFailureLifecycle() {
    const responseGenerationRequested = this.generationTrigger !== null;
    return Object.freeze({
      responseGenerationRequested,
      responseGenerationStarted: responseGenerationRequested && this.responseStarted,
      responseTerminalObserved: responseGenerationRequested && this.responseFinished,
    });
  }

  private enforceSessionLimit(binding: ConnectionBinding) {
    if (!this.isCurrentConnection(binding)
      || this.clientState === "closed"
      || this.clientState === "closing"
      || this.clientState === "failed") return;
    const wasConnecting = this.clientState === "connecting";
    const error = new Error("Gemini Live reached the 15-minute audio-only session limit");
    this.clientState = "closing";
    this.inputOpen = false;
    this.responsePrepared = false;
    this.clearConnectTimer();
    this.clearSessionTimer();
    this.abortPendingToolCalls("Gemini Live session duration limit reached");
    this.outstandingToolCalls.clear();
    if (wasConnecting) this.rejectPendingConnect(error);
    if (this.currentResponseId && !this.responseFinished) {
      this.completeResponse("failed", "session_duration_limit", "client.session_limit");
    }
    this.emitError(error, true, undefined, "session_duration_limit");
    try {
      binding.socket.close(1000, "session duration limit");
    } catch {
      if (this.isCurrentConnection(binding)) {
        this.clientState = "closed";
        this.socket = null;
      }
    }
  }

  private emit(
    event: NormalizedEventPayload,
    wireType: string,
    syntheticAttribution: RealtimeWireObservationAttribution = CLIENT_GENERATED_WIRE_ATTRIBUTION,
  ) {
    const arrival = this.activeWireArrival;
    const normalized = {
      provider: "gemini",
      receivedAtMs: arrival?.wallMs ?? this.now(),
      receivedAtMonotonicMs: arrival?.monotonicMs ?? this.monotonicNow(),
      wireType,
      ...(this.activeWireObservationAttribution
        ? { wireObservation: this.activeWireObservationAttribution }
        : arrival
          ? {}
          : { wireObservation: syntheticAttribution }),
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

  private emitError(
    error: Error,
    fatal: boolean,
    raw?: unknown,
    code?: string,
    syntheticAttribution: RealtimeWireObservationAttribution = CLIENT_GENERATED_WIRE_ATTRIBUTION,
    transportDiagnostic?: RealtimeTransportFailureDiagnostic,
  ) {
    this.emit({
      type: "error",
      message: this.sanitizeDiagnostic(error.message),
      fatal,
      ...(code ? { code } : {}),
      ...(isRecord(raw) ? { details: this.sanitizeDetails(raw) } : {}),
      ...(transportDiagnostic ? { transportDiagnostic } : {}),
    }, "error", syntheticAttribution);
  }
}
