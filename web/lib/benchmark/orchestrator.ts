import { performance } from "node:perf_hooks";
import {
  appendEventEnvelope,
  canonicalJson as canonicalArtifactJson,
  createArtifactDescriptor,
  createRunManifest,
  encodeEventJsonl,
  immutableJson,
  sha256Hex,
  startEventChain,
  verifyArtifactContent,
  verifyEventChain,
  verifyRunManifest,
  type ArtifactDescriptor,
  type BenchmarkEventEnvelope,
  type JsonValue as ArtifactJsonValue,
  type RunManifest,
} from "./artifacts";
import {
  budgetSnapshot,
  reserveBudget,
  settleBudgetReservation,
  type BudgetLedger,
  type UsdInput,
} from "./budget";
import {
  BenchmarkScenarioSchema,
  JsonValueSchema,
  type BenchmarkScenario,
  type JsonValue,
} from "./scenario-schema";
import {
  ToolWorldStateSchema,
  createToolWorld,
  executeTool,
  type ToolExecution,
  type ToolWorldState,
} from "./tool-world";
import {
  CAPABILITY_GATEWAY_NAME,
  CAPABILITY_GATEWAY_VERSION,
  CapabilityGatewayCallSchema,
  CapabilityGatewayResultSchema,
  ProviderCapabilitySnapshotSchema,
  renderProviderCapabilitySnapshot,
  type CapabilityGatewayCall,
  type CapabilityGatewayResult,
  type ProviderCapabilitySnapshot,
  type ProviderFunctionTool,
} from "./capability-gateway";
import type {
  BenchmarkConditionId,
  CompiledBenchmarkCondition,
  CompiledDisclosure,
} from "./condition-compiler";
import {
  applyAudibilityEvent,
  createAudibilityState,
  scoreAudibility,
  type AudibilityEvent,
  type AudibilityScore,
  type AudibilityState,
  type ProviderHistoryObservation,
} from "../realtime/audibility";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  Pcm16Audio,
  RealtimeToolCall,
  RealtimeToolResult,
  ServerRealtimeProvider,
} from "../realtime/client/types";

export type GatewayLeafExecutionRequest = Readonly<{
  action: string;
  arguments: Readonly<Record<string, JsonValue>>;
  idempotencyKey?: string;
}>;

export type GatewayLeafExecutor = (
  request: GatewayLeafExecutionRequest
) => ToolExecution;

export type BenchmarkGatewayInvocation = Readonly<{
  providerCallId: string;
  call: CapabilityGatewayCall;
  condition: CompiledBenchmarkCondition;
  turn: number;
  world: ToolWorldState;
  executeLeaf: GatewayLeafExecutor;
}>;

export type GatewayStageDisclosure = Readonly<{
  target: CompiledDisclosure["target"];
  snapshot: ProviderCapabilitySnapshot;
}>;

export type BenchmarkGatewayOutcome = Readonly<{
  /** Internal authoritative settlement; persisted in artifacts, never assumed spoken. */
  result: CapabilityGatewayResult;
  /** Exact model-visible output. Defaults to result; may preserve an after-commit timeout. */
  providerVisibleOutput?: JsonValue;
  /** Fresh revision/epoch grants, including state-only arms without new prose. */
  capabilitySnapshot?: ProviderCapabilitySnapshot;
  /** Returned after a successful flow transition; carried in the tool result. */
  disclosure?: GatewayStageDisclosure;
}>;

/**
 * Treatment logic lives here, not in provider adapters or the orchestrator.
 * Raw arms issue static full-catalog grants and call executeLeaf directly;
 * harness arms may enforce revisions, transitions, memory, and exactly-once.
 */
export interface BenchmarkGatewayKernel {
  initialize(input: Readonly<{
    runId: string;
    condition: CompiledBenchmarkCondition;
    scenario: BenchmarkScenario;
    world: ToolWorldState;
  }>): ProviderCapabilitySnapshot | Promise<ProviderCapabilitySnapshot>;
  invoke(input: BenchmarkGatewayInvocation): BenchmarkGatewayOutcome | Promise<BenchmarkGatewayOutcome>;
}

export type TrialSessionConfiguration = Readonly<{
  provider: ServerRealtimeProvider;
  model: string;
  conditionId: BenchmarkConditionId;
  instructions: string;
  initialPrompt: string;
  renderedCapabilitySnapshot: string;
  providerTools: readonly ProviderFunctionTool[];
  conditionHash: string;
}>;

export type TrialClientFactory = (
  configuration: TrialSessionConfiguration
) => NormalizedRealtimeClient | Promise<NormalizedRealtimeClient>;

export type TrialPlaybackObservation = Readonly<{
  queuedThroughMs: number;
  playedThroughMs?: number;
  interruption?: Readonly<{ playedThroughMs: number; reason?: string }>;
  providerHistory?: ProviderHistoryObservation;
  queueEvidenceSha256?: string;
  playbackEvidenceSha256?: string;
}>;

export interface TrialAudibilitySink {
  observePlayback(input: Readonly<{
    runId: string;
    turn: number;
    responseId: string;
    audio: Uint8Array;
    format: Readonly<Pick<Pcm16Audio, "encoding" | "sampleRateHz" | "channels">>;
    audioSha256: string;
    generatedThroughMs: number;
  }>): TrialPlaybackObservation | Promise<TrialPlaybackObservation>;
}

export type TrialAudibilityReport = Readonly<{
  schema_version: 1;
  applicability: "playback_observed" | "generation_only" | "not_applicable_no_output_audio";
  sink_configured: boolean;
  events: readonly AudibilityEvent[];
  state: AudibilityState;
  score: AudibilityScore;
}>;

export type CallerAudioTurn = Readonly<{
  turnId: string;
  audio: Pcm16Audio | readonly Pcm16Audio[];
}>;

export type PairedAudioTurn = Readonly<{
  ordinal: number;
  turn_id: string;
  sha256: string;
  byte_length: number;
  encoding: "pcm16";
  sample_rate_hz: number;
  channels: 1;
}>;

/** This object is condition-independent and can be shared by a raw/harness pair. */
export type PairedAudioManifest = Readonly<{
  schema_version: 1;
  pair_id: string;
  scenario_id: string;
  scenario_version: string;
  turns: readonly PairedAudioTurn[];
}>;

export type TrialLimits = Readonly<{
  maxTurns: number;
  maxSessionMs: number;
  maxInputAudioBytes: number;
  maxOutputAudioBytes: number;
  maxToolCalls: number;
  sessionReadyTimeoutMs: number;
  responseTimeoutMs: number;
}>;

export type TrialClock = Readonly<{
  monotonicNowMs(): number;
  wallTimeIso(): string;
}>;

export type TrialCostInput = Readonly<{
  runId: string;
  provider: ServerRealtimeProvider;
  model: string;
  status: TrialStatus;
  usage: readonly NormalizedRealtimeUsage[];
  inputAudioBytes: number;
  outputAudioBytes: number;
  inputAudioMs: number;
  outputAudioMs: number;
  turnsSent: number;
  toolCalls: number;
}>;

export type TrialCostEstimate = Readonly<{
  estimatedUsd: UsdInput;
  providerReportedUsd?: UsdInput;
  reconciledUsd?: UsdInput;
}>;

export type TrialBudget = Readonly<{
  ledger: BudgetLedger;
  reservationId: string;
  maximumUsd: UsdInput;
  /** Required: a network session never starts until the reservation is durable. */
  persistLedger(ledger: BudgetLedger): void | Promise<void>;
  estimateCost(input: TrialCostInput): TrialCostEstimate | Promise<TrialCostEstimate>;
}>;

export type TrialStatus =
  | "completed"
  | "provider_error"
  | "protocol_error"
  | "response_timeout"
  | "session_timeout"
  | "cap_exceeded"
  | "tool_error"
  | "budget_error";

export type TrialError = Readonly<{
  code: string;
  message: string;
  phase: "connect" | "session" | "turn" | "tool" | "budget" | "artifact";
  provider_code?: string;
  fatal?: boolean;
}>;

export type TrialCounters = Readonly<{
  turnsPlanned: number;
  turnsSent: number;
  inputAudioBytes: number;
  outputAudioBytes: number;
  toolCalls: number;
  normalizedEvents: number;
  rawWireEvents: number;
  retries: 0;
  elapsedMs: number;
}>;

export type TrialArtifactFile = Readonly<{
  path: string;
  mediaType: string;
  content: string | Uint8Array;
  descriptor: ArtifactDescriptor;
}>;

export type TrialArtifacts = Readonly<{
  files: readonly TrialArtifactFile[];
  events: readonly BenchmarkEventEnvelope[];
  manifest: RunManifest;
  manifestJson: string;
}>;

export type TrialResult = Readonly<{
  schemaVersion: 1;
  runId: string;
  pairId: string;
  provider: ServerRealtimeProvider;
  model: string;
  condition: BenchmarkConditionId;
  status: TrialStatus;
  errors: readonly TrialError[];
  counters: TrialCounters;
  inputAudioHashes: readonly string[];
  outputAudioHashes: readonly string[];
  usage: readonly NormalizedRealtimeUsage[];
  audibility: TrialAudibilityReport;
  world: ToolWorldState;
  budgetLedger: BudgetLedger;
  artifacts: TrialArtifacts;
}>;

export type RunTrialInput = Readonly<{
  runId: string;
  provider: ServerRealtimeProvider;
  model: string;
  scenario: unknown;
  createClient: TrialClientFactory;
  condition: CompiledBenchmarkCondition;
  gatewayKernel: BenchmarkGatewayKernel;
  audibilitySink?: TrialAudibilitySink;
  callerTurns: readonly CallerAudioTurn[];
  pairedAudio: PairedAudioManifest;
  limits: TrialLimits;
  budget: TrialBudget;
  clock?: TrialClock;
}>;

type AudioMaterial = Readonly<{
  chunks: readonly Pcm16Audio[];
  bytes: Uint8Array;
  durationMs: number;
  hash: string;
  format: Readonly<Pick<Pcm16Audio, "encoding" | "sampleRateHz" | "channels">>;
}>;

type PreparedTurn = Readonly<{
  turnId: string;
  scenarioTurn: BenchmarkScenario["caller"]["turns"][number];
  material: AudioMaterial;
}>;

type QueuedEvent = Readonly<{
  sequence: number;
  event: NormalizedRealtimeEvent;
}>;

type RawWireRecord = Readonly<{
  sequence: number;
  observed_at: string;
  event: ArtifactJsonValue;
}>;

type UsageRecord = Readonly<{
  sequence: number;
  received_at_ms: number;
  response_id?: string;
  item_id?: string;
  scope?: string;
  usage: ArtifactJsonValue;
}>;

type MutableRuntime = {
  status: TrialStatus;
  errors: TrialError[];
  world: ToolWorldState;
  turnsSent: number;
  outputAudioBytes: number;
  toolCalls: number;
  normalizedEvents: number;
  rawWireEvents: number;
  inputAudioBytes: number;
  inputAudioMs: number;
  outputAudioMs: number;
  usage: NormalizedRealtimeUsage[];
  usageRecords: UsageRecord[];
  wireRecords: RawWireRecord[];
  outputByTurn: Uint8Array[][];
  outputFormatByTurn: Array<Pick<Pcm16Audio, "encoding" | "sampleRateHz" | "channels"> | null>;
  responseAudio: Map<string, {
    turn: number;
    chunks: Uint8Array[];
    format: Pick<Pcm16Audio, "encoding" | "sampleRateHz" | "channels">;
  }>;
  activeResponseId: string | null;
  audibilityState: AudibilityState;
  audibilityEvents: AudibilityEvent[];
  currentTurnIndex: number;
  sessionReady: boolean;
  connected: boolean;
  eventSequence: number;
  terminalError: TrialError | null;
};

class WaitExpiredError extends Error {
  constructor() {
    super("event wait expired");
    this.name = "WaitExpiredError";
  }
}

class TrialRuntimeError extends Error {
  readonly status: TrialStatus;
  readonly trialError: TrialError;

  constructor(status: TrialStatus, trialError: TrialError) {
    super(trialError.message);
    this.name = "TrialRuntimeError";
    this.status = status;
    this.trialError = trialError;
  }
}

class EventInbox {
  private readonly queued: QueuedEvent[] = [];
  private waiter: ((entry: QueuedEvent) => void) | null = null;

  push(entry: QueuedEvent): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(entry);
      return;
    }
    this.queued.push(entry);
  }

  async next(timeoutMs: number): Promise<QueuedEvent> {
    const existing = this.queued.shift();
    if (existing) return existing;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WaitExpiredError();
    return new Promise<QueuedEvent>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiter = null;
        reject(new WaitExpiredError());
      }, timeoutMs);
      this.waiter = (entry) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(entry);
      };
    });
  }
}

function defaultClock(): TrialClock {
  return Object.freeze({
    monotonicNowMs: () => performance.now(),
    wallTimeIso: () => new Date().toISOString(),
  });
}

function requireNonEmpty(value: string, label: string): void {
  if (!value.trim() || value.length > 256) {
    throw new Error(`${label} must be a non-empty string of at most 256 characters`);
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function validateLimits(limits: TrialLimits): void {
  requirePositiveInteger(limits.maxTurns, "limits.maxTurns");
  requirePositiveInteger(limits.maxSessionMs, "limits.maxSessionMs");
  requirePositiveInteger(limits.maxInputAudioBytes, "limits.maxInputAudioBytes");
  requirePositiveInteger(limits.maxOutputAudioBytes, "limits.maxOutputAudioBytes");
  requirePositiveInteger(limits.maxToolCalls, "limits.maxToolCalls");
  requirePositiveInteger(limits.sessionReadyTimeoutMs, "limits.sessionReadyTimeoutMs");
  requirePositiveInteger(limits.responseTimeoutMs, "limits.responseTimeoutMs");
  if (limits.sessionReadyTimeoutMs > limits.maxSessionMs) {
    throw new Error("limits.sessionReadyTimeoutMs cannot exceed limits.maxSessionMs");
  }
}

function copyBytes(chunks: readonly Pcm16Audio[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return combined;
}

function prepareAudio(audio: Pcm16Audio | readonly Pcm16Audio[]): AudioMaterial {
  const chunks = (Array.isArray(audio) ? audio : [audio]) as readonly Pcm16Audio[];
  if (chunks.length === 0) throw new Error("caller audio turn cannot be empty");
  const first = chunks[0];
  if (first.encoding !== "pcm16" || first.channels !== 1 || !Number.isSafeInteger(first.sampleRateHz) || first.sampleRateHz <= 0) {
    throw new Error("caller audio must be mono PCM16 with a positive integer sample rate");
  }
  let samples = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (
      chunk.encoding !== first.encoding
      || chunk.channels !== first.channels
      || chunk.sampleRateHz !== first.sampleRateHz
    ) {
      throw new Error(`caller audio chunk ${index} changes format within a turn`);
    }
    if (!(chunk.data instanceof Uint8Array) || chunk.data.byteLength === 0 || chunk.data.byteLength % 2 !== 0) {
      throw new Error(`caller audio chunk ${index} must contain complete, non-empty PCM16 samples`);
    }
    samples += chunk.data.byteLength / 2;
  }
  const bytes = copyBytes(chunks);
  return Object.freeze({
    chunks: Object.freeze(chunks.map((chunk) => Object.freeze({ ...chunk, data: new Uint8Array(chunk.data) }))),
    bytes,
    durationMs: samples / first.sampleRateHz * 1_000,
    hash: sha256Hex(bytes),
    format: Object.freeze({ encoding: first.encoding, sampleRateHz: first.sampleRateHz, channels: first.channels }),
  });
}

export function createPairedAudioManifest(input: Readonly<{
  pairId: string;
  scenario: unknown;
  callerTurns: readonly CallerAudioTurn[];
}>): PairedAudioManifest {
  requireNonEmpty(input.pairId, "pairId");
  const scenario = BenchmarkScenarioSchema.parse(input.scenario);
  if (input.callerTurns.length !== scenario.caller.turns.length) {
    throw new Error("paired audio must contain exactly one turn for every scenario caller turn");
  }
  const turns = input.callerTurns.map((turn, index) => {
    const expected = scenario.caller.turns[index];
    if (turn.turnId !== expected.id) {
      throw new Error(`paired audio turn ${index + 1} must be ${expected.id}, received ${turn.turnId}`);
    }
    const material = prepareAudio(turn.audio);
    return Object.freeze({
      ordinal: index + 1,
      turn_id: turn.turnId,
      sha256: material.hash,
      byte_length: material.bytes.byteLength,
      encoding: "pcm16" as const,
      sample_rate_hz: material.format.sampleRateHz,
      channels: 1 as const,
    });
  });
  return Object.freeze({
    schema_version: 1 as const,
    pair_id: input.pairId,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    turns: Object.freeze(turns),
  });
}

function validateAndPrepareTurns(
  scenario: BenchmarkScenario,
  callerTurns: readonly CallerAudioTurn[],
  paired: PairedAudioManifest,
  limits: TrialLimits
): readonly PreparedTurn[] {
  requireNonEmpty(paired.pair_id, "pairedAudio.pair_id");
  if (paired.schema_version !== 1) throw new Error("unsupported paired audio manifest schema");
  if (paired.scenario_id !== scenario.id || paired.scenario_version !== scenario.version) {
    throw new Error("paired audio manifest belongs to a different scenario revision");
  }
  if (callerTurns.length !== scenario.caller.turns.length || paired.turns.length !== callerTurns.length) {
    throw new Error("caller audio and paired manifest must cover every scenario turn exactly once");
  }
  if (callerTurns.length > scenario.max_turns || callerTurns.length > limits.maxTurns) {
    throw new Error("caller sequence exceeds the scenario or trial turn cap");
  }

  let totalBytes = 0;
  const prepared = callerTurns.map((turn, index) => {
    const scenarioTurn = scenario.caller.turns[index];
    const pairedTurn = paired.turns[index];
    if (turn.turnId !== scenarioTurn.id || pairedTurn.turn_id !== scenarioTurn.id || pairedTurn.ordinal !== index + 1) {
      throw new Error(`caller turn order diverges at ordinal ${index + 1}`);
    }
    const material = prepareAudio(turn.audio);
    totalBytes += material.bytes.byteLength;
    if (
      pairedTurn.sha256 !== material.hash
      || pairedTurn.byte_length !== material.bytes.byteLength
      || pairedTurn.encoding !== material.format.encoding
      || pairedTurn.sample_rate_hz !== material.format.sampleRateHz
      || pairedTurn.channels !== material.format.channels
    ) {
      throw new Error(`caller audio hash or format mismatch for ${turn.turnId}`);
    }
    return Object.freeze({ turnId: turn.turnId, scenarioTurn, material });
  });
  if (totalBytes > limits.maxInputAudioBytes) {
    throw new Error(`caller audio exceeds the ${limits.maxInputAudioBytes}-byte input cap`);
  }
  return Object.freeze(prepared);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Lossless for JSON inputs; defensive for errors or typed arrays from injected fakes. */
function artifactJson(value: unknown, seen = new WeakSet<object>(), depth = 0): ArtifactJsonValue {
  if (depth > 50) return "[Maximum depth exceeded]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (value instanceof Uint8Array) {
    return { byte_length: value.byteLength, sha256: sha256Hex(value) };
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => artifactJson(item, seen, depth + 1));
    const output: Record<string, ArtifactJsonValue> = {};
    for (const [key, entry] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      output[key] = artifactJson(entry, seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function jsonRecord(value: unknown): Record<string, JsonValue> | null {
  if (!isPlainRecord(value)) return null;
  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success || parsed.data === null || Array.isArray(parsed.data) || typeof parsed.data !== "object") return null;
  return parsed.data as Record<string, JsonValue>;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
}

function asTrialRuntimeError(error: unknown, phase: TrialError["phase"]): TrialRuntimeError {
  if (error instanceof TrialRuntimeError) return error;
  return new TrialRuntimeError("protocol_error", {
    code: "orchestrator_error",
    message: errorMessage(error),
    phase,
    fatal: true,
  });
}

function validateCompiledCondition(condition: CompiledBenchmarkCondition): void {
  if (!condition || typeof condition !== "object") throw new Error("compiled benchmark condition is required");
  if (condition.behavior.toolExposure !== "gateway") {
    throw new Error(`condition ${condition.id} does not use the preregistered gateway surface`);
  }
  if (
    condition.providerTools.length !== 1
    || condition.providerTools[0]?.name !== CAPABILITY_GATEWAY_NAME
  ) {
    throw new Error(`condition ${condition.id} must expose exactly [${CAPABILITY_GATEWAY_NAME}]`);
  }
  requireNonEmpty(condition.initialPrompt, "condition.initialPrompt");
  requireNonEmpty(condition.conditionHash, "condition.conditionHash");
}

function assertSnapshotMatches(
  snapshotInput: unknown,
  capabilities: CompiledBenchmarkCondition["visibleCapabilities"] | CompiledDisclosure["visibleCapabilities"],
  label: string
): ProviderCapabilitySnapshot {
  const snapshot = ProviderCapabilitySnapshotSchema.parse(snapshotInput);
  const expected = [...capabilities].sort((left, right) => left.name.localeCompare(right.name));
  const actual = [...snapshot.actions].sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(actual.map((action) => action.capability_grant)).size !== actual.length) {
    throw new Error(`${label} capability snapshot must use action-bound unique grants`);
  }
  if (
    expected.length !== actual.length
    || expected.some((capability, index) =>
      capability.name !== actual[index]?.name
      || capability.semanticHash !== actual[index]?.semantic_hash
      || canonicalArtifactJson(capability.inputSchema) !== canonicalArtifactJson(actual[index]?.input_schema)
    )
  ) {
    throw new Error(`${label} capability snapshot does not match the compiled logical catalog`);
  }
  return snapshot;
}

function assertSnapshotSubset(
  snapshotInput: unknown,
  capabilities: CompiledBenchmarkCondition["visibleCapabilities"],
  label: string
): ProviderCapabilitySnapshot {
  const snapshot = ProviderCapabilitySnapshotSchema.parse(snapshotInput);
  if (new Set(snapshot.actions.map((action) => action.capability_grant)).size !== snapshot.actions.length) {
    throw new Error(`${label} capability snapshot must use action-bound unique grants`);
  }
  const catalog = new Map(capabilities.map((capability) => [capability.name, capability]));
  for (const action of snapshot.actions) {
    const capability = catalog.get(action.name);
    if (
      !capability
      || capability.semanticHash !== action.semantic_hash
      || canonicalArtifactJson(capability.inputSchema) !== canonicalArtifactJson(action.input_schema)
    ) {
      throw new Error(`${label} capability snapshot action ${action.name} is outside the compiled catalog`);
    }
  }
  return snapshot;
}

function trialError(
  status: TrialStatus,
  code: string,
  message: string,
  phase: TrialError["phase"],
  extras: Partial<Pick<TrialError, "provider_code" | "fatal">> = {}
): TrialRuntimeError {
  return new TrialRuntimeError(status, { code, message, phase, ...extras });
}

function sessionRemainingMs(clock: TrialClock, startedMs: number, maxSessionMs: number): number {
  return maxSessionMs - Math.max(0, clock.monotonicNowMs() - startedMs);
}

async function racePromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw new WaitExpiredError();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new WaitExpiredError());
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function addErrorOnce(runtime: MutableRuntime, error: TrialError): void {
  if (runtime.errors.some((candidate) =>
    candidate.code === error.code
    && candidate.message === error.message
    && candidate.phase === error.phase
    && candidate.provider_code === error.provider_code
  )) return;
  runtime.errors.push(Object.freeze({ ...error }));
}

function normalizedEventPayload(event: NormalizedRealtimeEvent): ArtifactJsonValue {
  if (event.type === "output.audio") {
    return artifactJson({
      ...event,
      audio: { byte_length: event.audio.byteLength, sha256: sha256Hex(event.audio) },
    });
  }
  return artifactJson(event);
}

function outputDurationMs(event: Extract<NormalizedRealtimeEvent, { type: "output.audio" }>): number {
  return event.audio.byteLength / 2 / event.format.sampleRateHz * 1_000;
}

function invocationIdFor(index: number): string {
  return `model_call_${String(index).padStart(6, "0")}`;
}

function gatewayFailure(code: string, message: string, action?: string): CapabilityGatewayResult {
  return CapabilityGatewayResultSchema.parse({
    ok: false,
    gateway_version: CAPABILITY_GATEWAY_VERSION,
    ...(action && /^[a-z][a-z0-9_.-]{1,95}$/.test(action) ? { action } : {}),
    code,
    message,
    retriable: false,
  });
}

async function dispatchToolCall(input: Readonly<{
  call: RealtimeToolCall;
  condition: CompiledBenchmarkCondition;
  gatewayKernel: BenchmarkGatewayKernel;
  scenario: BenchmarkScenario;
  runtime: MutableRuntime;
  invocationId: string;
  turn: number;
}>): Promise<Readonly<{
  result: RealtimeToolResult;
  execution: ToolExecution | null;
  action: string | null;
  authoritativeResult: CapabilityGatewayResult | null;
  disclosure: Readonly<{ target: string; prompt: string; renderedSnapshot: string }> | null;
}>> {
  const { call, condition, gatewayKernel, scenario, runtime, invocationId, turn } = input;
  if (!call.callId) {
    throw trialError("protocol_error", "missing_tool_call_id", "Provider tool call omitted callId", "tool", { fatal: true });
  }
  if (call.name !== CAPABILITY_GATEWAY_NAME) {
    return Object.freeze({
      result: {
        callId: call.callId,
        output: gatewayFailure(
          "unauthorized_native_tool",
          `Every benchmark arm exposes only ${CAPABILITY_GATEWAY_NAME}`
        ),
      },
      execution: null,
      action: null,
      authoritativeResult: null,
      disclosure: null,
    });
  }
  const parsedCall = CapabilityGatewayCallSchema.safeParse(call.argumentsJson);
  if (!parsedCall.success) {
    return Object.freeze({
      result: {
        callId: call.callId,
        output: gatewayFailure(
          "malformed_gateway_call",
          call.argumentsError ?? "Gateway call must contain action, arguments, and capability_grant"
        ),
      },
      execution: null,
      action: null,
      authoritativeResult: null,
      disclosure: null,
    });
  }

  let execution: ToolExecution | null = null;
  const executeLeaf: GatewayLeafExecutor = (request) => {
    if (execution) throw new Error("gateway kernel attempted more than one leaf execution for one model call");
    const argumentsRecord = jsonRecord(request.arguments);
    if (!argumentsRecord) throw new Error("gateway kernel supplied non-JSON leaf arguments");
    execution = executeTool(scenario, runtime.world, {
      invocation_id: invocationId,
      tool: request.action,
      arguments: argumentsRecord,
      turn,
      ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
    });
    runtime.world = execution.state;
    return execution;
  };

  let outcome: BenchmarkGatewayOutcome;
  try {
    outcome = await gatewayKernel.invoke(Object.freeze({
      providerCallId: call.callId,
      call: parsedCall.data,
      condition,
      turn,
      world: ToolWorldStateSchema.parse(structuredClone(runtime.world)),
      executeLeaf,
    }));
  } catch (error) {
    throw trialError("tool_error", "gateway_kernel_failed", errorMessage(error), "tool", { fatal: true });
  }
  const result = CapabilityGatewayResultSchema.parse(outcome?.result);
  const visibleOutput = outcome.providerVisibleOutput === undefined
    ? result
    : JsonValueSchema.parse(outcome.providerVisibleOutput);
  let disclosure: Readonly<{ target: string; prompt: string; renderedSnapshot: string }> | null = null;
  let providerOutput: unknown = visibleOutput;
  if (outcome.disclosure) {
    const template = condition.disclosures.find((candidate) => candidate.target === outcome.disclosure!.target);
    if (!template) {
      throw trialError(
        "tool_error",
        "unknown_gateway_disclosure",
        `Gateway kernel requested uncompiled disclosure ${outcome.disclosure.target}`,
        "tool",
        { fatal: true }
      );
    }
    const selectedSnapshot = outcome.capabilitySnapshot ?? outcome.disclosure.snapshot;
    if (
      outcome.capabilitySnapshot
      && canonicalArtifactJson(outcome.capabilitySnapshot) !== canonicalArtifactJson(outcome.disclosure.snapshot)
    ) {
      throw trialError(
        "tool_error",
        "conflicting_gateway_snapshots",
        "Gateway outcome returned different disclosure and capability snapshots",
        "tool",
        { fatal: true }
      );
    }
    const snapshot = assertSnapshotMatches(
      selectedSnapshot,
      template.visibleCapabilities,
      `disclosure ${template.target}`
    );
    const renderedSnapshot = renderProviderCapabilitySnapshot(snapshot);
    disclosure = Object.freeze({ target: template.target, prompt: template.prompt, renderedSnapshot });
    providerOutput = {
      gateway_result: visibleOutput,
      progressive_disclosure: template.prompt,
      capability_snapshot: renderedSnapshot,
    };
  } else if (outcome.capabilitySnapshot) {
    const snapshot = assertSnapshotSubset(
      outcome.capabilitySnapshot,
      condition.visibleCapabilities,
      "rotated"
    );
    const renderedSnapshot = renderProviderCapabilitySnapshot(snapshot);
    disclosure = Object.freeze({ target: "$grant-rotation", prompt: "", renderedSnapshot });
    providerOutput = {
      gateway_result: visibleOutput,
      capability_snapshot: renderedSnapshot,
    };
  }
  return Object.freeze({
    result: { callId: call.callId, output: providerOutput },
    execution,
    action: parsedCall.data.action,
    authoritativeResult: result,
    disclosure,
  });
}

function safeClose(client: NormalizedRealtimeClient, reason: string): void {
  try {
    client.close(1000, reason.slice(0, 120));
  } catch {
    // Closing is best-effort only; the original provider/runtime error is retained.
  }
}

function applyAudibility(runtime: MutableRuntime, event: AudibilityEvent): void {
  const applied = applyAudibilityEvent(runtime.audibilityState, event);
  if (!applied.ok) {
    throw trialError(
      "protocol_error",
      "audibility_evidence_invalid",
      `${applied.code}: ${applied.error}`,
      "artifact",
      { fatal: true }
    );
  }
  runtime.audibilityState = applied.state;
  if (applied.applied) runtime.audibilityEvents.push(event);
}

async function finalizeAudibility(input: Readonly<{
  runId: string;
  sink?: TrialAudibilitySink;
  runtime: MutableRuntime;
  record(type: string, payload: unknown): void;
}>): Promise<TrialAudibilityReport> {
  for (const [responseId, response] of input.runtime.responseAudio) {
    const audio = concatBytes(response.chunks);
    if (audio.byteLength === 0) continue;
    const generatedThroughMs = Math.max(
      1,
      Math.ceil(audio.byteLength / 2 / response.format.sampleRateHz * 1_000)
    );
    const audioSha256 = sha256Hex(audio);
    let observation: TrialPlaybackObservation | undefined;
    let sinkFailure: unknown;
    if (input.sink) {
      try {
        observation = await input.sink.observePlayback(Object.freeze({
          runId: input.runId,
          turn: response.turn,
          responseId,
          audio: new Uint8Array(audio),
          format: Object.freeze({ ...response.format }),
          audioSha256,
          generatedThroughMs,
        }));
      } catch (error) {
        sinkFailure = error;
      }
    }
    const nextSequence = () => input.runtime.audibilityEvents.length + 1;
    const providerHistory = observation?.providerHistory ?? {
      status: "unknown" as const,
      reason: "provider history retention was not observed for this benchmark response",
    };
    applyAudibility(input.runtime, {
      type: "generated",
      sequence: nextSequence(),
      eventId: `generated-${nextSequence()}`,
      responseId,
      throughMs: generatedThroughMs,
      final: true,
      providerHistory,
      evidence: { source: "provider_event", sha256: audioSha256 },
    });
    if (sinkFailure) {
      throw trialError(
        "protocol_error",
        "audibility_sink_failed",
        errorMessage(sinkFailure),
        "artifact",
        { fatal: true }
      );
    }
    if (observation) {
      const queueEvidence = observation.queueEvidenceSha256
        ?? sha256Hex(canonicalArtifactJson({ responseId, queuedThroughMs: observation.queuedThroughMs, audioSha256 }));
      applyAudibility(input.runtime, {
        type: "queued",
        sequence: nextSequence(),
        eventId: `queued-${nextSequence()}`,
        responseId,
        throughMs: observation.queuedThroughMs,
        evidence: { source: "playback_queue", sha256: queueEvidence },
      });
      const playbackBoundary = observation.interruption?.playedThroughMs ?? observation.playedThroughMs;
      if (playbackBoundary === undefined) {
        throw trialError(
          "protocol_error",
          "audibility_playback_boundary_missing",
          "Audibility sink did not report playedThroughMs or an interruption cursor",
          "artifact",
          { fatal: true }
        );
      }
      const playbackEvidence = observation.playbackEvidenceSha256
        ?? sha256Hex(canonicalArtifactJson({
          responseId,
          playedThroughMs: playbackBoundary,
          interrupted: Boolean(observation.interruption),
          audioSha256,
        }));
      if (observation.interruption) {
        applyAudibility(input.runtime, {
          type: "interrupted",
          sequence: nextSequence(),
          eventId: `interrupted-${nextSequence()}`,
          responseId,
          playedThroughMs: observation.interruption.playedThroughMs,
          ...(observation.interruption.reason ? { reason: observation.interruption.reason } : {}),
          evidence: { source: "playback_clock", sha256: playbackEvidence },
        });
      } else {
        applyAudibility(input.runtime, {
          type: "played_through",
          sequence: nextSequence(),
          eventId: `played-${nextSequence()}`,
          responseId,
          throughMs: playbackBoundary,
          evidence: { source: "playback_clock", sha256: playbackEvidence },
        });
      }
    }
    input.record("audibility.response_recorded", {
      response_id: responseId,
      turn: response.turn,
      generated_audio_bytes: audio.byteLength,
      generated_audio_sha256: audioSha256,
      generated_through_ms: generatedThroughMs,
      playback_observed: Boolean(observation),
      queued_through_ms: observation?.queuedThroughMs ?? null,
      played_through_ms: observation?.interruption?.playedThroughMs ?? observation?.playedThroughMs ?? null,
      interrupted: Boolean(observation?.interruption),
    });
  }
  const hasOutput = input.runtime.responseAudio.size > 0;
  return Object.freeze({
    schema_version: 1 as const,
    applicability: hasOutput
      ? input.sink ? "playback_observed" as const : "generation_only" as const
      : "not_applicable_no_output_audio" as const,
    sink_configured: Boolean(input.sink),
    events: Object.freeze([...input.runtime.audibilityEvents]),
    state: input.runtime.audibilityState,
    score: scoreAudibility(input.runtime.audibilityState),
  });
}

async function awaitLogicalResponse(input: Readonly<{
  inbox: EventInbox;
  client: NormalizedRealtimeClient;
  condition: CompiledBenchmarkCondition;
  gatewayKernel: BenchmarkGatewayKernel;
  scenario: BenchmarkScenario;
  runtime: MutableRuntime;
  limits: TrialLimits;
  clock: TrialClock;
  sessionStartedMs: number;
  record(type: string, payload: unknown): void;
  callInvocationIds: Map<string, string>;
}>): Promise<void> {
  const responseStartedMs = input.clock.monotonicNowMs();
  let lastSubmissionBarrier = -1;
  while (true) {
    if (input.runtime.terminalError) {
      const terminal = input.runtime.terminalError;
      throw new TrialRuntimeError(
        terminal.code === "output_audio_cap_exceeded" ? "cap_exceeded" : "protocol_error",
        terminal
      );
    }
    const sessionRemaining = sessionRemainingMs(input.clock, input.sessionStartedMs, input.limits.maxSessionMs);
    if (sessionRemaining <= 0) {
      throw trialError("session_timeout", "session_timeout", "Trial exceeded the monotonic session cap", "session", { fatal: true });
    }
    const responseRemaining = input.limits.responseTimeoutMs
      - Math.max(0, input.clock.monotonicNowMs() - responseStartedMs);
    if (responseRemaining <= 0) {
      throw trialError("response_timeout", "response_timeout", "Provider did not complete the response before the hard timeout", "turn", { fatal: true });
    }

    let queued: QueuedEvent;
    try {
      queued = await input.inbox.next(Math.min(sessionRemaining, responseRemaining));
    } catch (error) {
      if (!(error instanceof WaitExpiredError)) throw error;
      const nowSessionRemaining = sessionRemainingMs(input.clock, input.sessionStartedMs, input.limits.maxSessionMs);
      if (nowSessionRemaining <= 0 || sessionRemaining <= responseRemaining) {
        throw trialError("session_timeout", "session_timeout", "Trial exceeded the monotonic session cap", "session", { fatal: true });
      }
      throw trialError("response_timeout", "response_timeout", "Provider did not complete the response before the hard timeout", "turn", { fatal: true });
    }
    const event = queued.event;
    if (event.type === "error") {
      const providerError: TrialError = {
        code: "provider_error",
        message: event.message,
        phase: "turn",
        ...(event.code ? { provider_code: event.code } : {}),
        fatal: event.fatal,
      };
      addErrorOnce(input.runtime, providerError);
      if (event.fatal) throw new TrialRuntimeError("provider_error", providerError);
      continue;
    }
    if (event.type === "connection.closed") {
      throw trialError(
        "provider_error",
        "connection_closed",
        `Provider connection closed before response completion${event.reason ? `: ${event.reason}` : ""}`,
        "turn",
        { fatal: true }
      );
    }
    if (event.type === "turn.interrupted") {
      throw trialError(
        "provider_error",
        "turn_interrupted",
        `Provider interrupted the benchmark turn${event.reason ? `: ${event.reason}` : ""}`,
        "turn",
        { fatal: true }
      );
    }
    if (event.type === "tool.calls") {
      if (event.calls.length === 0) {
        throw trialError("protocol_error", "empty_tool_batch", "Provider emitted an empty tool call batch", "tool", { fatal: true });
      }
      if (input.runtime.toolCalls + event.calls.length > input.limits.maxToolCalls) {
        throw trialError(
          "cap_exceeded",
          "tool_call_cap_exceeded",
          `Tool batch would exceed the ${input.limits.maxToolCalls}-call hard cap`,
          "tool",
          { fatal: true }
        );
      }
      const ids = event.calls.map((call) => call.callId);
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        throw trialError("protocol_error", "invalid_tool_batch_ids", "Tool batch contains missing or duplicate call IDs", "tool", { fatal: true });
      }
      input.runtime.toolCalls += event.calls.length;
      input.record("tool.batch_received", {
        turn: input.runtime.currentTurnIndex + 1,
        response_id: event.responseId ?? null,
        call_count: event.calls.length,
        call_ids: ids,
      });
      const results: RealtimeToolResult[] = [];
      for (const call of event.calls) {
        let invocationId = input.callInvocationIds.get(call.callId);
        if (!invocationId) {
          invocationId = invocationIdFor(input.callInvocationIds.size + 1);
          input.callInvocationIds.set(call.callId, invocationId);
        }
        const dispatched = await dispatchToolCall({
          call,
          condition: input.condition,
          gatewayKernel: input.gatewayKernel,
          scenario: input.scenario,
          runtime: input.runtime,
          invocationId,
          turn: input.runtime.currentTurnIndex + 1,
        });
        results.push(dispatched.result);
        input.record("tool.call_result", {
          turn: input.runtime.currentTurnIndex + 1,
          provider_call_id: call.callId,
          invocation_id: invocationId,
          requested_tool: call.name,
          action: dispatched.action,
          execution_disposition: dispatched.execution?.disposition ?? "not_executed",
          receipt_id: dispatched.execution?.receipt.receipt_id ?? null,
          committed: dispatched.execution?.receipt.committed ?? false,
          authoritative_gateway_result: dispatched.authoritativeResult,
          provider_visible_output: artifactJson(dispatched.result.output),
          disclosure_target: dispatched.disclosure?.target ?? null,
          disclosure_prompt_hash: dispatched.disclosure ? sha256Hex(dispatched.disclosure.prompt) : null,
          capability_snapshot_hash: dispatched.disclosure ? sha256Hex(dispatched.disclosure.renderedSnapshot) : null,
        });
      }
      // Anything already normalized belongs to the response that requested
      // tools. Events emitted synchronously by submitToolResults are a genuine
      // continuation and therefore fall beyond this barrier.
      const submissionBarrier = input.runtime.eventSequence;
      try {
        input.client.submitToolResults(results, true);
      } catch (error) {
        throw trialError("protocol_error", "tool_result_submission_failed", errorMessage(error), "tool", { fatal: true });
      }
      // Provider normalizers may enqueue response.completed from the function-call
      // response before submitToolResults returns. Only a later completion can end
      // this logical caller turn.
      lastSubmissionBarrier = submissionBarrier;
      input.record("tool.batch_submitted", {
        turn: input.runtime.currentTurnIndex + 1,
        call_ids: ids,
        result_count: results.length,
      });
      continue;
    }
    if (event.type === "response.completed") {
      if (event.status && !event.status.startsWith("completed")) {
        throw trialError(
          "provider_error",
          "response_not_completed",
          `Provider response ended with status ${event.status}`,
          "turn",
          { fatal: true }
        );
      }
      if (queued.sequence <= lastSubmissionBarrier) continue;
      return;
    }
  }
}

function makeArtifactFile(path: string, content: string | Uint8Array, mediaType: string): TrialArtifactFile {
  const stableContent = typeof content === "string" ? content : new Uint8Array(content);
  return Object.freeze({
    path,
    mediaType,
    content: stableContent,
    descriptor: createArtifactDescriptor(path, stableContent, mediaType),
  });
}

function pcmPath(direction: "input" | "output", ordinal: number, turnId: string): string {
  const safeTurn = turnId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `audio/${direction}/${String(ordinal).padStart(3, "0")}-${safeTurn}.pcm`;
}

function assertCompleteTrialArtifacts(
  artifacts: TrialArtifacts,
  expected: Readonly<{
    runId: string;
    planned: readonly PreparedTurn[];
    turnsSent: number;
  }>
): void {
  const eventVerification = verifyEventChain(artifacts.events);
  if (!eventVerification.valid || eventVerification.run_id !== expected.runId || eventVerification.event_count === 0) {
    throw new Error(`trial event chain is incomplete: ${eventVerification.errors.join("; ")}`);
  }
  const manifestVerification = verifyRunManifest(artifacts.manifest);
  if (!manifestVerification.valid || artifacts.manifest.run_id !== expected.runId) {
    throw new Error(`trial manifest is invalid: ${manifestVerification.errors.join("; ")}`);
  }
  const fileByPath = new Map(artifacts.files.map((file) => [file.path, file]));
  if (fileByPath.size !== artifacts.files.length) throw new Error("trial artifacts contain duplicate file paths");
  const descriptorPaths = new Set(artifacts.manifest.artifacts.map((descriptor) => descriptor.path));
  if (descriptorPaths.size !== artifacts.manifest.artifacts.length || descriptorPaths.size !== fileByPath.size) {
    throw new Error("trial manifest and in-memory artifact file sets differ");
  }
  for (const descriptor of artifacts.manifest.artifacts) {
    const file = fileByPath.get(descriptor.path);
    if (!file) throw new Error(`missing artifact content for ${descriptor.path}`);
    if (!verifyArtifactContent(descriptor, file.content).valid) {
      throw new Error(`artifact content does not match descriptor for ${descriptor.path}`);
    }
  }
  const required = [
    "events.jsonl",
    "provider-wire.jsonl",
    "usage.json",
    "world-final.json",
    "trial-result.json",
    "budget-ledger.json",
    "audibility.json",
    "audio/pair-manifest.json",
  ];
  for (const path of required) {
    if (!fileByPath.has(path)) throw new Error(`required trial artifact ${path} is missing`);
  }
  for (const [index, turn] of expected.planned.entries()) {
    if (!fileByPath.has(pcmPath("input", index + 1, turn.turnId))) {
      throw new Error(`input audio artifact for ${turn.turnId} is missing`);
    }
    if (index < expected.turnsSent && !fileByPath.has(pcmPath("output", index + 1, turn.turnId))) {
      throw new Error(`output audio artifact for sent turn ${turn.turnId} is missing`);
    }
  }
  if (
    artifacts.manifest.event_log?.event_count !== eventVerification.event_count
    || artifacts.manifest.event_log?.chain_head !== eventVerification.chain_head
  ) {
    throw new Error("manifest event_log reference does not match the verified event chain");
  }
}

function buildArtifacts(input: Readonly<{
  runId: string;
  pair: PairedAudioManifest;
  scenario: BenchmarkScenario;
  provider: ServerRealtimeProvider;
  model: string;
  condition: BenchmarkConditionId;
  status: TrialStatus;
  errors: readonly TrialError[];
  counters: TrialCounters;
  planned: readonly PreparedTurn[];
  outputByTurn: readonly Uint8Array[][];
  outputFormatByTurn: ReadonlyArray<Pick<Pcm16Audio, "encoding" | "sampleRateHz" | "channels"> | null>;
  usageRecords: readonly UsageRecord[];
  wireRecords: readonly RawWireRecord[];
  world: ToolWorldState;
  ledger: BudgetLedger;
  audibility: TrialAudibilityReport;
  events: readonly BenchmarkEventEnvelope[];
  createdAt: string;
}>): TrialArtifacts {
  const files: TrialArtifactFile[] = [];
  const eventJsonl = encodeEventJsonl(input.events);
  files.push(makeArtifactFile("events.jsonl", eventJsonl, "application/x-ndjson"));
  const wireJsonl = input.wireRecords.length === 0
    ? ""
    : `${input.wireRecords.map((record) => canonicalArtifactJson(record)).join("\n")}\n`;
  files.push(makeArtifactFile("provider-wire.jsonl", wireJsonl, "application/x-ndjson"));
  files.push(makeArtifactFile(
    "usage.json",
    `${canonicalArtifactJson({ schema_version: 1, events: input.usageRecords })}\n`,
    "application/json"
  ));
  files.push(makeArtifactFile(
    "world-final.json",
    `${canonicalArtifactJson(input.world)}\n`,
    "application/json"
  ));
  files.push(makeArtifactFile(
    "budget-ledger.json",
    `${canonicalArtifactJson(input.ledger)}\n`,
    "application/json"
  ));
  files.push(makeArtifactFile(
    "audio/pair-manifest.json",
    `${canonicalArtifactJson(input.pair)}\n`,
    "application/json"
  ));
  files.push(makeArtifactFile(
    "audibility.json",
    `${canonicalArtifactJson(input.audibility)}\n`,
    "application/json"
  ));
  files.push(makeArtifactFile(
    "trial-result.json",
    `${canonicalArtifactJson({
      schema_version: 1,
      run_id: input.runId,
      pair_id: input.pair.pair_id,
      scenario_id: input.scenario.id,
      scenario_version: input.scenario.version,
      provider: input.provider,
      model: input.model,
      condition: input.condition,
      status: input.status,
      audibility_applicability: input.audibility.applicability,
      errors: input.errors,
      counters: input.counters,
      budget: budgetSnapshot(input.ledger),
    })}\n`,
    "application/json"
  ));
  for (const [index, turn] of input.planned.entries()) {
    files.push(makeArtifactFile(
      pcmPath("input", index + 1, turn.turnId),
      turn.material.bytes,
      `audio/L16;rate=${turn.material.format.sampleRateHz};channels=1`
    ));
    if (index < input.counters.turnsSent) {
      const output = concatBytes(input.outputByTurn[index] ?? []);
      const outputFormat = input.outputFormatByTurn[index];
      files.push(makeArtifactFile(
        pcmPath("output", index + 1, turn.turnId),
        output,
        outputFormat ? `audio/L16;rate=${outputFormat.sampleRateHz};channels=1` : "audio/L16"
      ));
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const eventVerification = verifyEventChain(input.events);
  const manifest = createRunManifest({
    run_id: input.runId,
    created_at: input.createdAt,
    artifacts: files.map((file) => file.descriptor),
    event_log: {
      path: "events.jsonl",
      event_count: eventVerification.event_count,
      chain_head: eventVerification.chain_head,
    },
    metadata: {
      benchmark: "voice-long-horizon",
      pair_id: input.pair.pair_id,
      provider: input.provider,
      model: input.model,
      condition: input.condition,
      status: input.status,
    },
  });
  const artifacts = Object.freeze({
    files: Object.freeze(files),
    events: Object.freeze([...input.events]),
    manifest,
    manifestJson: `${canonicalArtifactJson(manifest)}\n`,
  });
  assertCompleteTrialArtifacts(artifacts, {
    runId: input.runId,
    planned: input.planned,
    turnsSent: input.counters.turnsSent,
  });
  return artifacts;
}

/**
 * Run one provider/condition trial. The caller sequence is deliberately open
 * loop: every pre-recorded turn is sent in scenario order, independent of model
 * prose. This is the first reproducible benchmark mode; adaptive caller policy
 * can be layered on later without changing the evidence format.
 */
export async function runBenchmarkTrial(input: RunTrialInput): Promise<TrialResult> {
  requireNonEmpty(input.runId, "runId");
  requireNonEmpty(input.model, "model");
  validateLimits(input.limits);
  validateCompiledCondition(input.condition);
  const scenario = BenchmarkScenarioSchema.parse(input.scenario);
  const planned = validateAndPrepareTurns(scenario, input.callerTurns, input.pairedAudio, input.limits);
  const clock = input.clock ?? defaultClock();
  const sessionStartedMs = clock.monotonicNowMs();
  if (!Number.isFinite(sessionStartedMs)) throw new Error("clock.monotonicNowMs() must be finite");
  const createdAt = clock.wallTimeIso();
  const initialWorld = createToolWorld(scenario);
  const initialSnapshot = assertSnapshotMatches(
    await input.gatewayKernel.initialize(Object.freeze({
      runId: input.runId,
      condition: input.condition,
      scenario,
      world: ToolWorldStateSchema.parse(structuredClone(initialWorld)),
    })),
    input.condition.visibleCapabilities,
    "initial"
  );
  const renderedInitialSnapshot = renderProviderCapabilitySnapshot(initialSnapshot);
  const sessionConfiguration: TrialSessionConfiguration = Object.freeze({
    provider: input.provider,
    model: input.model,
    conditionId: input.condition.id,
    instructions: `${input.condition.initialPrompt}\n${renderedInitialSnapshot}`,
    initialPrompt: input.condition.initialPrompt,
    renderedCapabilitySnapshot: renderedInitialSnapshot,
    providerTools: input.condition.providerTools,
    conditionHash: input.condition.conditionHash,
  });
  const initialEvent = Object.freeze({
    run_id: input.runId,
    observed_at: createdAt,
    event_type: "trial.started",
    payload: immutableJson({
      scenario_id: scenario.id,
      scenario_version: scenario.version,
      pair_id: input.pairedAudio.pair_id,
      provider: input.provider,
      model: input.model,
      condition: input.condition.id,
      condition_hash: input.condition.conditionHash,
      initial_prompt_hash: input.condition.initialPromptHash,
      initial_capability_snapshot_hash: sha256Hex(renderedInitialSnapshot),
      turns_planned: planned.length,
      input_audio_hashes: planned.map((turn) => turn.material.hash),
      retry_policy: "none",
    }),
  });
  const chain: BenchmarkEventEnvelope[] = [];
  const record = (eventType: string, payload: unknown) => {
    const safePayload = artifactJson(payload);
    const envelope = appendEventEnvelope(chain[chain.length - 1], {
      observed_at: clock.wallTimeIso(),
      event_type: eventType,
      payload: safePayload,
    });
    chain.push(envelope);
  };
  chain.push(startEventChain(initialEvent));

  let budgetLedger: BudgetLedger;
  const reserved = reserveBudget(input.budget.ledger, {
    reservation_id: input.budget.reservationId,
    provider: input.provider,
    model: input.model,
    run_id: input.runId,
    created_at: createdAt,
    maximum_usd: input.budget.maximumUsd,
  });
  await input.budget.persistLedger(reserved.ledger);
  budgetLedger = reserved.ledger;
  record("budget.reserved", {
    reservation_id: reserved.reservation.reservation_id,
    maximum_micro_usd: reserved.reservation.maximum_micro_usd,
    scheduling_exposure_micro_usd: budgetSnapshot(budgetLedger).scheduling_exposure_micro_usd,
  });
  // The spend reservation is durable before provider client construction. A
  // factory must only construct/configure; runBenchmarkTrial owns connect().
  const client = await input.createClient(sessionConfiguration);
  if (client.provider !== input.provider) {
    throw new Error(`client factory returned ${client.provider} for requested provider ${input.provider}`);
  }

  const runtime: MutableRuntime = {
    status: "completed",
    errors: [],
    world: initialWorld,
    turnsSent: 0,
    outputAudioBytes: 0,
    toolCalls: 0,
    normalizedEvents: 0,
    rawWireEvents: 0,
    inputAudioMs: 0,
    inputAudioBytes: 0,
    outputAudioMs: 0,
    usage: [],
    usageRecords: [],
    wireRecords: [],
    outputByTurn: planned.map(() => []),
    outputFormatByTurn: planned.map(() => null),
    responseAudio: new Map(),
    activeResponseId: null,
    audibilityState: createAudibilityState(),
    audibilityEvents: [],
    currentTurnIndex: -1,
    sessionReady: false,
    connected: false,
    eventSequence: 0,
    terminalError: null,
  };
  const inbox = new EventInbox();
  const callInvocationIds = new Map<string, string>();

  const unsubscribeEvent = client.onEvent((event) => {
    runtime.normalizedEvents += 1;
    runtime.eventSequence += 1;
    record("provider.normalized", normalizedEventPayload(event));
    if (event.type === "session.ready") runtime.sessionReady = true;
    if (event.type === "response.started") {
      runtime.activeResponseId = event.responseId ?? `turn-${runtime.currentTurnIndex + 1}-response`;
    }
    if (event.type === "error") {
      addErrorOnce(runtime, {
        code: "provider_error",
        message: event.message,
        phase: runtime.connected ? "turn" : "connect",
        ...(event.code ? { provider_code: event.code } : {}),
        fatal: event.fatal,
      });
    }
    if (event.type === "usage") {
      runtime.usage.push(event.usage);
      runtime.usageRecords.push(Object.freeze({
        sequence: runtime.usageRecords.length + 1,
        received_at_ms: event.receivedAtMs,
        ...(event.responseId ? { response_id: event.responseId } : {}),
        ...(event.itemId ? { item_id: event.itemId } : {}),
        ...(event.scope ? { scope: event.scope } : {}),
        usage: artifactJson(event.usage),
      }));
    }
    if (event.type === "output.audio") {
      const projected = runtime.outputAudioBytes + event.audio.byteLength;
      if (runtime.currentTurnIndex < 0) {
        runtime.terminalError = {
          code: "unscoped_output_audio",
          message: "Provider emitted output audio before any caller turn",
          phase: "turn",
          fatal: true,
        };
      } else if (projected > input.limits.maxOutputAudioBytes) {
        runtime.terminalError = {
          code: "output_audio_cap_exceeded",
          message: `Provider output exceeded the ${input.limits.maxOutputAudioBytes}-byte hard cap`,
          phase: "turn",
          fatal: true,
        };
        safeClose(client, "output audio cap exceeded");
      } else {
        const priorFormat = runtime.outputFormatByTurn[runtime.currentTurnIndex];
        if (
          priorFormat
          && (
            priorFormat.encoding !== event.format.encoding
            || priorFormat.sampleRateHz !== event.format.sampleRateHz
            || priorFormat.channels !== event.format.channels
          )
        ) {
          runtime.terminalError = {
            code: "output_audio_format_changed",
            message: "Provider changed PCM output format within a caller turn",
            phase: "turn",
            fatal: true,
          };
        } else {
          runtime.outputFormatByTurn[runtime.currentTurnIndex] = { ...event.format };
          runtime.outputByTurn[runtime.currentTurnIndex].push(new Uint8Array(event.audio));
          const responseId = event.responseId
            ?? runtime.activeResponseId
            ?? `turn-${runtime.currentTurnIndex + 1}-response`;
          const responseAudio = runtime.responseAudio.get(responseId) ?? {
            turn: runtime.currentTurnIndex + 1,
            chunks: [],
            format: { ...event.format },
          };
          if (
            responseAudio.format.encoding !== event.format.encoding
            || responseAudio.format.sampleRateHz !== event.format.sampleRateHz
            || responseAudio.format.channels !== event.format.channels
          ) {
            runtime.terminalError = {
              code: "response_audio_format_changed",
              message: `Provider changed PCM format within response ${responseId}`,
              phase: "turn",
              fatal: true,
            };
          } else {
            responseAudio.chunks.push(new Uint8Array(event.audio));
            runtime.responseAudio.set(responseId, responseAudio);
          }
          runtime.outputAudioBytes = projected;
          runtime.outputAudioMs += outputDurationMs(event);
        }
      }
    }
    inbox.push(Object.freeze({ sequence: runtime.eventSequence, event }));
  });
  const unsubscribeWire = client.onWireEvent((event) => {
    runtime.rawWireEvents += 1;
    const safe = artifactJson(event);
    const recordValue = Object.freeze({
      sequence: runtime.rawWireEvents,
      observed_at: clock.wallTimeIso(),
      event: safe,
    });
    runtime.wireRecords.push(recordValue);
    record("provider.wire_observed", {
      sequence: recordValue.sequence,
      sha256: sha256Hex(canonicalArtifactJson(safe)),
      wire_type: isPlainRecord(event) && typeof event.type === "string" ? event.type : null,
    });
  });

  try {
    const readyTimeout = Math.min(
      input.limits.sessionReadyTimeoutMs,
      sessionRemainingMs(clock, sessionStartedMs, input.limits.maxSessionMs)
    );
    try {
      await racePromise(client.connect(), readyTimeout);
    } catch (error) {
      if (error instanceof WaitExpiredError) {
        throw trialError("session_timeout", "session_ack_timeout", "Provider did not acknowledge the session before the hard timeout", "connect", { fatal: true });
      }
      throw trialError("provider_error", "connect_failed", errorMessage(error), "connect", { fatal: true });
    }
    runtime.connected = true;
    if (!runtime.sessionReady || client.state !== "ready") {
      throw trialError("protocol_error", "missing_session_ack", "connect() resolved without a normalized session.ready acknowledgement", "connect", { fatal: true });
    }
    record("session.acknowledged", {
      provider: client.provider,
      state: client.state,
      condition: input.condition.id,
      initial_prompt_hash: input.condition.initialPromptHash,
      rendered_capability_snapshot_hash: sha256Hex(renderedInitialSnapshot),
    });

    for (const [index, turn] of planned.entries()) {
      if (sessionRemainingMs(clock, sessionStartedMs, input.limits.maxSessionMs) <= 0) {
        throw trialError("session_timeout", "session_timeout", "Trial exceeded the monotonic session cap", "session", { fatal: true });
      }
      runtime.currentTurnIndex = index;
      try {
        client.sendTurn(turn.material.chunks.length === 1 ? turn.material.chunks[0] : turn.material.chunks);
      } catch (error) {
        throw trialError("protocol_error", "audio_turn_send_failed", errorMessage(error), "turn", { fatal: true });
      }
      runtime.turnsSent += 1;
      runtime.inputAudioBytes += turn.material.bytes.byteLength;
      runtime.inputAudioMs += turn.material.durationMs;
      record("caller.turn_sent", {
        ordinal: index + 1,
        turn_id: turn.turnId,
        phase: turn.scenarioTurn.phase,
        tags: turn.scenarioTurn.tags,
        byte_length: turn.material.bytes.byteLength,
        sha256: turn.material.hash,
        format: turn.material.format,
      });
      await awaitLogicalResponse({
        inbox,
        client,
        condition: input.condition,
        gatewayKernel: input.gatewayKernel,
        scenario,
        runtime,
        limits: input.limits,
        clock,
        sessionStartedMs,
        record,
        callInvocationIds,
      });
      record("caller.turn_completed", {
        ordinal: index + 1,
        turn_id: turn.turnId,
        output_audio_bytes: runtime.outputByTurn[index].reduce((sum, chunk) => sum + chunk.byteLength, 0),
      });
    }
  } catch (error) {
    const failure = asTrialRuntimeError(error, runtime.connected ? "turn" : "connect");
    runtime.status = failure.status;
    addErrorOnce(runtime, failure.trialError);
    record("trial.runtime_failed", { status: runtime.status, error: failure.trialError });
  } finally {
    safeClose(client, runtime.status === "completed" ? "benchmark trial completed" : "benchmark trial failed");
    unsubscribeEvent();
    unsubscribeWire();
  }

  let audibility: TrialAudibilityReport;
  try {
    audibility = await finalizeAudibility({
      runId: input.runId,
      sink: input.audibilitySink,
      runtime,
      record,
    });
  } catch (error) {
    const failure = asTrialRuntimeError(error, "artifact");
    runtime.status = failure.status;
    addErrorOnce(runtime, failure.trialError);
    record("audibility.failed", { error: failure.trialError });
    audibility = Object.freeze({
      schema_version: 1 as const,
      applicability: runtime.responseAudio.size > 0 ? "generation_only" as const : "not_applicable_no_output_audio" as const,
      sink_configured: Boolean(input.audibilitySink),
      events: Object.freeze([...runtime.audibilityEvents]),
      state: runtime.audibilityState,
      score: scoreAudibility(runtime.audibilityState),
    });
  }

  if (runtime.status === "completed" && runtime.errors.length > 0) {
    runtime.status = "provider_error";
    record("trial.provider_errors_preserved", {
      error_count: runtime.errors.length,
      fatal_error_count: runtime.errors.filter((error) => error.fatal).length,
    });
  }

  const inputAudioBytes = runtime.inputAudioBytes;
  try {
    const estimate = await input.budget.estimateCost(Object.freeze({
      runId: input.runId,
      provider: input.provider,
      model: input.model,
      status: runtime.status,
      usage: Object.freeze([...runtime.usage]),
      inputAudioBytes,
      outputAudioBytes: runtime.outputAudioBytes,
      inputAudioMs: runtime.inputAudioMs,
      outputAudioMs: runtime.outputAudioMs,
      turnsSent: runtime.turnsSent,
      toolCalls: runtime.toolCalls,
    }));
    const settled = settleBudgetReservation(budgetLedger, input.budget.reservationId, {
      estimated_usd: estimate.estimatedUsd,
      ...(estimate.providerReportedUsd === undefined ? {} : { provider_reported_usd: estimate.providerReportedUsd }),
      ...(estimate.reconciledUsd === undefined ? {} : { reconciled_usd: estimate.reconciledUsd }),
    });
    await input.budget.persistLedger(settled);
    budgetLedger = settled;
    record("budget.settled", {
      reservation_id: input.budget.reservationId,
      costs: settled.reservations.find((reservation) => reservation.reservation_id === input.budget.reservationId)?.costs ?? null,
    });
  } catch (error) {
    runtime.status = "budget_error";
    const failure: TrialError = {
      code: "budget_settlement_failed",
      message: errorMessage(error),
      phase: "budget",
      fatal: true,
    };
    addErrorOnce(runtime, failure);
    record("budget.settlement_failed", { error: failure, reservation_status: "active" });
  }

  const elapsedMs = Math.max(0, clock.monotonicNowMs() - sessionStartedMs);
  const counters: TrialCounters = Object.freeze({
    turnsPlanned: planned.length,
    turnsSent: runtime.turnsSent,
    inputAudioBytes,
    outputAudioBytes: runtime.outputAudioBytes,
    toolCalls: runtime.toolCalls,
    normalizedEvents: runtime.normalizedEvents,
    rawWireEvents: runtime.rawWireEvents,
    retries: 0,
    elapsedMs,
  });
  record("trial.finished", {
    status: runtime.status,
    counters,
    error_count: runtime.errors.length,
    budget_reservation_status: budgetLedger.reservations.find(
      (reservation) => reservation.reservation_id === input.budget.reservationId
    )?.status ?? "missing",
  });

  const artifacts = buildArtifacts({
    runId: input.runId,
    pair: input.pairedAudio,
    scenario,
    provider: input.provider,
    model: input.model,
    condition: input.condition.id,
    status: runtime.status,
    errors: runtime.errors,
    counters,
    planned,
    outputByTurn: runtime.outputByTurn,
    outputFormatByTurn: runtime.outputFormatByTurn,
    usageRecords: runtime.usageRecords,
    wireRecords: runtime.wireRecords,
    world: runtime.world,
    ledger: budgetLedger,
    audibility,
    events: chain,
    createdAt,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    runId: input.runId,
    pairId: input.pairedAudio.pair_id,
    provider: input.provider,
    model: input.model,
    condition: input.condition.id,
    status: runtime.status,
    errors: Object.freeze([...runtime.errors]),
    counters,
    inputAudioHashes: Object.freeze(planned.map((turn) => turn.material.hash)),
    outputAudioHashes: Object.freeze(runtime.outputByTurn.slice(0, runtime.turnsSent).map((chunks) => sha256Hex(concatBytes(chunks)))),
    usage: Object.freeze([...runtime.usage]),
    audibility,
    world: ToolWorldStateSchema.parse(runtime.world),
    budgetLedger,
    artifacts,
  });
}
