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
  AuthorizedCapabilityGatewayCallSchema,
  CapabilityGatewayCallSchema,
  CapabilityGatewayResultSchema,
  ProviderCapabilitySnapshotSchema,
  bindCapabilityGatewayCall,
  renderCompactProviderCapabilitySnapshot,
  renderProviderCapabilitySnapshot,
  type AuthorizedCapabilityGatewayCall,
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
  benchmarkKernelAttestationJson,
  benchmarkKernelAttestationReference,
  verifyBenchmarkKernelFinalAttestation,
  type BenchmarkKernelAttestationTrust,
  type BenchmarkKernelEvidenceBinding,
  type BenchmarkKernelFinalAttestation,
} from "./kernel-attestation";
import {
  verifyKernelTranscript,
  type KernelTranscriptReference,
} from "./kernel-transcript";
import {
  buildProviderTransportEvidence,
  type ProviderNormalizedWireLink,
  type ProviderPcmEvidence,
  type ProviderTransportEvidence,
} from "./provider-transport-evidence";
import {
  createProviderReadOnlyReceiptLinkage,
  deriveProviderReceiptInvocationId,
  type ProviderReadOnlyReceiptLinkage,
} from "./provider-receipt-linkage";
import { TRANSPORT_SMOKE_SCENARIO_ID } from "./transport-smoke-scenario";
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
  RealtimeWireObservation,
  ServerRealtimeProvider,
  SessionConfigurationAcknowledgement,
} from "../realtime/client/types";
import type { ProviderHardSessionCaps } from "./provider-pricing-proof";
import { realtimeWireIdentitySha256 } from "../realtime/client/wire-evidence";
import {
  createDeterministicCallerWorldScheduler,
  observeCallerWorld,
  type CallerSchedulerState,
  type CallerTurnSelection,
  type CallerWorldSchedulePlan,
  type ScheduledCallerOpportunity,
} from "./caller-world-scheduler";

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
  /** Host-bound call; grant and epoch were never model-authored. */
  call: AuthorizedCapabilityGatewayCall;
  capabilityEpoch: number;
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
  /**
   * Read-only final-state proof. Implementations must bind their exact internal
   * treatment state to the supplied authoritative world without rotating
   * grants, advancing epochs, or changing either state machine.
   */
  attestFinal(input: Readonly<{
    runId: string;
    condition: CompiledBenchmarkCondition;
    scenario: BenchmarkScenario;
    world: ToolWorldState;
  }>): BenchmarkKernelFinalAttestation | Promise<BenchmarkKernelFinalAttestation>;
  /** Canonical, grant-free replay artifact whose reference is signed by attestFinal. */
  encodedTranscript(): string;
  /** Exact reference to encodedTranscript(), signed into the final attestation. */
  transcriptReference(): KernelTranscriptReference;
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
  inputAudioFormat: Readonly<Pick<Pcm16Audio, "encoding" | "sampleRateHz" | "channels">>;
  audioDeliveryProfile: TrialAudioDeliveryProfile;
  audioDeliveryProfileHash: string;
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

export type TrialJournalCategory =
  | "lifecycle"
  | "event_chain"
  | "normalized_event"
  | "raw_wire"
  | "audio"
  | "usage"
  | "tool"
  | "world"
  | "error"
  | "finalization";

export type TrialJournalRecord = Readonly<{
  schema_version: 1;
  sequence: number;
  observed_at: string;
  category: TrialJournalCategory;
  event_type: string;
  payload: ArtifactJsonValue;
}>;

export type TrialJournalFinalization = Readonly<{
  record: TrialJournalRecord;
  run_id: string;
  status: TrialStatus;
  manifest: RunManifest;
  event_count: number;
  budget_reservation_status: "active" | "settled" | "released" | "missing";
}>;

/**
 * Crash-durable WAL boundary implemented by the CLI. `append` calls are
 * serialized and awaited before the runner performs its next external action.
 */
export interface TrialJournalSink {
  beforeClientCreate(record: TrialJournalRecord): void | Promise<void>;
  onSessionOpened(record: TrialJournalRecord): void | Promise<void>;
  append(record: TrialJournalRecord): void | Promise<void>;
  finalize(result: TrialJournalFinalization): void | Promise<void>;
}

export type CallerAudioTurn = Readonly<{
  turnId: string;
  audio: Pcm16Audio | readonly Pcm16Audio[];
}>;

export type TrialAudioDeliveryProfile = Readonly<{
  schemaVersion: 1;
  chunkMs: number;
  pace: "realtime";
}>;

export const DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE: TrialAudioDeliveryProfile = Object.freeze({
  schemaVersion: 1,
  chunkMs: 20,
  pace: "realtime",
});

export type TrialSleep = (durationMs: number) => void | Promise<void>;

export type PairedAudioTurn = Readonly<{
  ordinal: number;
  turn_id: string;
  sha256: string;
  byte_length: number;
  encoding: "pcm16";
  sample_rate_hz: number;
  channels: 1;
  delivery_hash: string;
  chunk_hashes: readonly string[];
  chunk_byte_lengths: readonly number[];
}>;

/** This object is condition-independent and can be shared by a raw/harness pair. */
export type PairedAudioManifest = Readonly<{
  schema_version: 1;
  pair_id: string;
  scenario_id: string;
  scenario_version: string;
  delivery_profile_hash: string;
  turns: readonly PairedAudioTurn[];
}>;

export type TrialAudioChunkDelivery = Readonly<{
  turn: number;
  turn_id: string;
  chunk_index: number;
  chunk_count: number;
  byte_length: number;
  sha256: string;
  scheduled_offset_ms: number;
  appended_at_monotonic_ms: number;
  session_offset_ms: number;
}>;

export type TrialAudioDeliveryReport = Readonly<{
  schema_version: 1;
  profile: TrialAudioDeliveryProfile;
  profile_hash: string;
  deliveries: readonly TrialAudioChunkDelivery[];
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
  | "journal_error"
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
  providerEvidence: ProviderTransportEvidence;
  providerReceiptLinkage: ProviderReadOnlyReceiptLinkage | null;
  audibility: TrialAudibilityReport;
  audioDelivery: TrialAudioDeliveryReport;
  callerSchedule: TrialCallerScheduleReport | null;
  kernelAttestation: BenchmarkKernelFinalAttestation;
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
  /**
   * Independently pinned verification material. This must come from the
   * execution plan, never from the treatment kernel whose proof it verifies.
   */
  kernelAttestationExpectation: Readonly<{
    evidenceBinding: BenchmarkKernelEvidenceBinding;
    trust: BenchmarkKernelAttestationTrust;
  }>;
  audibilitySink?: TrialAudibilitySink;
  journal?: TrialJournalSink;
  /** Exact loaded secrets; used only for pre-sink scanning and never serialized. */
  journalSecretValues?: readonly string[];
  audioDeliveryProfile?: TrialAudioDeliveryProfile;
  sleep?: TrialSleep;
  callerTurns: readonly CallerAudioTurn[];
  /** Omit for the secondary open-loop stress mode. */
  callerSchedulePlan?: CallerWorldSchedulePlan;
  pairedAudio: PairedAudioManifest;
  /** Frozen hash shared by the baseline/treatment pair and preregistration. */
  pairInvariantsHash: string;
  /** Shared study/registration plan hash; distinct from each cell's execution plan. */
  studyPlanHash: string;
  limits: TrialLimits;
  /** Exact fresh provider pricing-proof caps for paid execution. */
  providerHardCaps?: ProviderHardSessionCaps;
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
  /** One-based source ordinal in the frozen paired audio library. */
  pairedOrdinal: number;
}>;

export type TrialCallerScheduleReport = Readonly<{
  schema_version: 1;
  mode: "closed_loop";
  schedule_sha256: string;
  status: "complete" | "blocked" | "failed";
  stage_id: string | null;
  committed_turn_ids: readonly string[];
  opportunities: readonly ScheduledCallerOpportunity[];
  evidence: readonly BenchmarkEventEnvelope[];
}>;

type QueuedEvent = Readonly<{
  sequence: number;
  event: NormalizedRealtimeEvent;
  /** Caller turn to which a response-scoped event was bound at receipt time. */
  responseTurn: number | null;
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

type ProviderCallIdentity = Readonly<{
  fingerprint: string;
  invocationId: string;
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
  wireObservations: RealtimeWireObservation[];
  normalizedWireLinks: ProviderNormalizedWireLink[];
  outputByTurn: Uint8Array[][];
  outputFormatByTurn: Array<Pick<Pcm16Audio, "encoding" | "sampleRateHz" | "channels"> | null>;
  responseAudio: Map<string, {
    turn: number;
    chunks: Uint8Array[];
    format: Pick<Pcm16Audio, "encoding" | "sampleRateHz" | "channels">;
  }>;
  activeResponseId: string | null;
  responseTurnById: Map<string, number>;
  terminalResponseIds: Set<string>;
  responseWindowOpen: boolean;
  audibilityState: AudibilityState;
  audibilityEvents: AudibilityEvent[];
  audioDeliveries: TrialAudioChunkDelivery[];
  currentTurnIndex: number;
  currentCapabilitySnapshot: ProviderCapabilitySnapshot;
  sessionReady: boolean;
  sessionIdSha256: string | null;
  sessionConfiguration: SessionConfigurationAcknowledgement | null;
  normalizedToolCallCount: number;
  normalizedTerminalCount: number;
  responseGenerations: number;
  kernelProviderCallIds: string[];
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

function requirePrompt(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be blank`);
  if (value.includes("\0")) throw new Error(`${label} cannot contain a NUL byte`);
  if (Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    throw new Error(`${label} cannot exceed 1 MiB of UTF-8 text`);
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function requireSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
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

function normalizeAudioDeliveryProfile(
  input: TrialAudioDeliveryProfile | undefined
): TrialAudioDeliveryProfile {
  const profile = input ?? DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE;
  if (profile.schemaVersion !== 1) throw new Error("unsupported audio delivery profile schema");
  if (!Number.isSafeInteger(profile.chunkMs) || profile.chunkMs < 20 || profile.chunkMs > 100) {
    throw new Error("audio delivery chunkMs must be an integer from 20 through 100");
  }
  if (profile.pace !== "realtime") throw new Error("primary audio delivery must use realtime pacing");
  return Object.freeze({ schemaVersion: 1 as const, chunkMs: profile.chunkMs, pace: "realtime" as const });
}

export function trialAudioDeliveryProfileHash(profileInput: TrialAudioDeliveryProfile): string {
  const profile = normalizeAudioDeliveryProfile(profileInput);
  return sha256Hex(`harshas-amazing-call-center/audio-delivery-profile/v1\n${canonicalArtifactJson(profile)}`);
}

function packetizeAudio(
  material: AudioMaterial,
  profile: TrialAudioDeliveryProfile
): readonly Pcm16Audio[] {
  const samplesPerChunk = material.format.sampleRateHz * profile.chunkMs / 1_000;
  if (!Number.isSafeInteger(samplesPerChunk) || samplesPerChunk <= 0) {
    throw new Error(
      `audio sample rate ${material.format.sampleRateHz} cannot represent ${profile.chunkMs}ms PCM chunks exactly`
    );
  }
  const bytesPerChunk = samplesPerChunk * 2;
  const chunks: Pcm16Audio[] = [];
  for (let offset = 0; offset < material.bytes.byteLength; offset += bytesPerChunk) {
    chunks.push(Object.freeze({
      ...material.format,
      data: material.bytes.slice(offset, Math.min(material.bytes.byteLength, offset + bytesPerChunk)),
    }));
  }
  return Object.freeze(chunks);
}

function deliveryPlan(material: AudioMaterial, profile: TrialAudioDeliveryProfile) {
  const chunks = packetizeAudio(material, profile);
  const plan = chunks.map((chunk, index) => ({
    chunk_index: index + 1,
    byte_length: chunk.data.byteLength,
    sha256: sha256Hex(chunk.data),
    scheduled_offset_ms: index * profile.chunkMs,
  }));
  return Object.freeze({
    chunks,
    plan: Object.freeze(plan),
    hash: sha256Hex(`harshas-amazing-call-center/audio-delivery-plan/v1\n${canonicalArtifactJson({
      profile_hash: trialAudioDeliveryProfileHash(profile),
      format: material.format,
      chunks: plan,
    })}`),
  });
}

export function createPairedAudioManifest(input: Readonly<{
  pairId: string;
  scenario: unknown;
  callerTurns: readonly CallerAudioTurn[];
  audioDeliveryProfile?: TrialAudioDeliveryProfile;
}>): PairedAudioManifest {
  requireNonEmpty(input.pairId, "pairId");
  const scenario = BenchmarkScenarioSchema.parse(input.scenario);
  const profile = normalizeAudioDeliveryProfile(input.audioDeliveryProfile);
  if (input.callerTurns.length !== scenario.caller.turns.length) {
    throw new Error("paired audio must contain exactly one turn for every scenario caller turn");
  }
  const turns = input.callerTurns.map((turn, index) => {
    const expected = scenario.caller.turns[index];
    if (turn.turnId !== expected.id) {
      throw new Error(`paired audio turn ${index + 1} must be ${expected.id}, received ${turn.turnId}`);
    }
    const material = prepareAudio(turn.audio);
    const delivery = deliveryPlan(material, profile);
    return Object.freeze({
      ordinal: index + 1,
      turn_id: turn.turnId,
      sha256: material.hash,
      byte_length: material.bytes.byteLength,
      encoding: "pcm16" as const,
      sample_rate_hz: material.format.sampleRateHz,
      channels: 1 as const,
      delivery_hash: delivery.hash,
      chunk_hashes: Object.freeze(delivery.plan.map((chunk) => chunk.sha256)),
      chunk_byte_lengths: Object.freeze(delivery.plan.map((chunk) => chunk.byte_length)),
    });
  });
  return Object.freeze({
    schema_version: 1 as const,
    pair_id: input.pairId,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    delivery_profile_hash: trialAudioDeliveryProfileHash(profile),
    turns: Object.freeze(turns),
  });
}

function validateAndPrepareTurns(
  scenario: BenchmarkScenario,
  callerTurns: readonly CallerAudioTurn[],
  paired: PairedAudioManifest,
  limits: TrialLimits,
  profile: TrialAudioDeliveryProfile
): readonly PreparedTurn[] {
  requireNonEmpty(paired.pair_id, "pairedAudio.pair_id");
  if (paired.schema_version !== 1) throw new Error("unsupported paired audio manifest schema");
  if (paired.delivery_profile_hash !== trialAudioDeliveryProfileHash(profile)) {
    throw new Error("paired audio manifest uses a different audio delivery profile");
  }
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
    const delivery = deliveryPlan(material, profile);
    totalBytes += material.bytes.byteLength;
    if (
      pairedTurn.sha256 !== material.hash
      || pairedTurn.byte_length !== material.bytes.byteLength
      || pairedTurn.encoding !== material.format.encoding
      || pairedTurn.sample_rate_hz !== material.format.sampleRateHz
      || pairedTurn.channels !== material.format.channels
      || pairedTurn.delivery_hash !== delivery.hash
      || canonicalArtifactJson(pairedTurn.chunk_hashes) !== canonicalArtifactJson(delivery.plan.map((chunk) => chunk.sha256))
      || canonicalArtifactJson(pairedTurn.chunk_byte_lengths) !== canonicalArtifactJson(delivery.plan.map((chunk) => chunk.byte_length))
    ) {
      throw new Error(`caller audio hash or format mismatch for ${turn.turnId}`);
    }
    return Object.freeze({ turnId: turn.turnId, scenarioTurn, material, pairedOrdinal: index + 1 });
  });
  if (totalBytes > limits.maxInputAudioBytes) {
    throw new Error(`caller audio exceeds the ${limits.maxInputAudioBytes}-byte input cap`);
  }
  const firstFormat = prepared[0]?.material.format;
  if (!firstFormat || prepared.some((turn) =>
    turn.material.format.encoding !== firstFormat.encoding
    || turn.material.format.sampleRateHz !== firstFormat.sampleRateHz
    || turn.material.format.channels !== firstFormat.channels
  )) {
    throw new Error("all caller turns in one realtime session must use one native PCM format");
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

const JOURNAL_REDACTION_MARKER = "[REDACTED]";
const SENSITIVE_JOURNAL_KEY = /^(?:authorization|proxy_authorization|api_key|apikey|access_token|refresh_token|id_token|password|secret|client_secret|capability_grant|resume_handle|resumption_handle)$/i;

function normalizedJournalKey(key: string): string {
  return key.replace(/[-\s]/g, "_");
}

function journalSecretVariants(values: readonly string[]): readonly string[] {
  const variants = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length < 4) continue;
    variants.add(value);
    variants.add(encodeURIComponent(value));
    variants.add(Buffer.from(value, "utf8").toString("base64"));
  }
  return Object.freeze([...variants].filter(Boolean).sort((left, right) => right.length - left.length));
}

function redactJournalString(input: string, secretVariants: readonly string[]): string {
  let value = input;
  for (const secret of secretVariants) value = value.split(secret).join(JOURNAL_REDACTION_MARKER);
  value = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${JOURNAL_REDACTION_MARKER}`)
    .replace(/([?&](?:key|api_key|apikey|access_token|token|auth|authorization)=)[^&#\s"']+/gi, `$1${JOURNAL_REDACTION_MARKER}`)
    .replace(/("capability_grant"\s*:\s*")[^"]*(")/gi, `$1${JOURNAL_REDACTION_MARKER}$2`)
    .replace(/("(?:resume_handle|resumption_handle)"\s*:\s*")[^"]*(")/gi, `$1${JOURNAL_REDACTION_MARKER}$2`);
  return value;
}

/** Structured, recursive redaction that runs before any value crosses the sink boundary. */
export function redactTrialJournalValue(
  value: unknown,
  secretValues: readonly string[] = []
): ArtifactJsonValue {
  const variants = journalSecretVariants(secretValues);
  const seen = new WeakSet<object>();
  const visit = (current: unknown, path: readonly string[], depth: number): ArtifactJsonValue => {
    if (depth > 50) return "[Maximum depth exceeded]";
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") return redactJournalString(current, variants);
    if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
    if (typeof current === "bigint") return current.toString();
    if (current === undefined || typeof current === "function" || typeof current === "symbol") return null;
    if (current instanceof Uint8Array) {
      return { byte_length: current.byteLength, sha256: sha256Hex(current) };
    }
    if (current instanceof Error) {
      return {
        name: redactJournalString(current.name, variants),
        message: redactJournalString(current.message, variants),
      };
    }
    if (typeof current !== "object") return redactJournalString(String(current), variants);
    if (seen.has(current)) return "[Circular]";
    seen.add(current);
    try {
      if (Array.isArray(current)) return current.map((entry) => visit(entry, path, depth + 1));
      const output: Record<string, ArtifactJsonValue> = {};
      const record = current as Record<string, unknown>;
      const recordIsResumption = typeof record.type === "string" && /resum/i.test(record.type);
      for (const [key, entry] of Object.entries(current).sort(([left], [right]) => left.localeCompare(right))) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
        const normalized = normalizedJournalKey(key);
        const pathContainsResumption = path.some((segment) => /resum/i.test(segment));
        output[key] = SENSITIVE_JOURNAL_KEY.test(normalized)
          || /^(?:(?:resume|resumption).*handle|new_handle|conversation_id)$/i.test(normalized)
          || (normalized.toLowerCase() === "handle" && (pathContainsResumption || recordIsResumption))
          ? JOURNAL_REDACTION_MARKER
          : visit(entry, [...path, key], depth + 1);
      }
      return output;
    } finally {
      seen.delete(current);
    }
  };
  return visit(value, [], 0);
}

class TrialJournalCoordinator {
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private journalFailure: Error | null = null;

  constructor(
    private readonly sink: TrialJournalSink | undefined,
    private readonly clock: TrialClock,
    private readonly secretValues: readonly string[]
  ) {}

  get failed(): boolean {
    return this.journalFailure !== null;
  }

  createRecord(
    category: TrialJournalCategory,
    eventType: string,
    payload: unknown
  ): TrialJournalRecord {
    this.sequence += 1;
    return Object.freeze({
      schema_version: 1 as const,
      sequence: this.sequence,
      observed_at: this.clock.wallTimeIso(),
      category,
      event_type: eventType,
      payload: redactTrialJournalValue(payload, this.secretValues),
    });
  }

  append(category: TrialJournalCategory, eventType: string, payload: unknown): void {
    if (!this.sink || this.journalFailure) return;
    const record = this.createRecord(category, eventType, payload);
    this.pending = this.pending
      .then(async () => {
        if (this.journalFailure) return;
        await this.sink!.append(record);
      })
      .catch((error) => {
        this.journalFailure ??= new Error(`Trial journal append failed: ${errorMessage(error)}`);
      });
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.journalFailure) {
      throw trialError("journal_error", "journal_append_failed", this.journalFailure.message, "artifact", { fatal: true });
    }
  }

  async beforeClientCreate(payload: unknown): Promise<void> {
    if (!this.sink) return;
    await this.flush();
    const record = this.createRecord("lifecycle", "connection_intent", payload);
    this.pending = this.pending
      .then(() => this.sink!.beforeClientCreate(record))
      .then(() => undefined)
      .catch((error) => {
        this.journalFailure ??= new Error(`Trial journal connection intent failed: ${errorMessage(error)}`);
      });
    await this.pending;
    if (this.journalFailure) {
      throw trialError("journal_error", "journal_connection_intent_failed", this.journalFailure.message, "artifact", { fatal: true });
    }
  }

  async onSessionOpened(payload: unknown): Promise<void> {
    if (!this.sink) return;
    await this.flush();
    const record = this.createRecord("lifecycle", "session_opened", payload);
    this.pending = this.pending
      .then(() => this.sink!.onSessionOpened(record))
      .then(() => undefined)
      .catch((error) => {
        this.journalFailure ??= new Error(`Trial journal session-opened write failed: ${errorMessage(error)}`);
      });
    await this.pending;
    if (this.journalFailure) {
      throw trialError("journal_error", "journal_session_opened_failed", this.journalFailure.message, "artifact", { fatal: true });
    }
  }

  async finalize(input: Omit<TrialJournalFinalization, "record">): Promise<void> {
    if (!this.sink) return;
    await this.flush();
    const record = this.createRecord("finalization", "trial_finalized", {
      run_id: input.run_id,
      status: input.status,
      manifest_hash: input.manifest.manifest_hash,
      event_count: input.event_count,
      budget_reservation_status: input.budget_reservation_status,
    });
    this.pending = this.pending
      .then(() => this.sink!.finalize(Object.freeze({ ...input, record })))
      .then(() => undefined)
      .catch((error) => {
        this.journalFailure ??= new Error(`Trial journal finalization failed: ${errorMessage(error)}`);
      });
    await this.pending;
    if (this.journalFailure) {
      throw trialError("journal_error", "journal_finalization_failed", this.journalFailure.message, "artifact", { fatal: true });
    }
  }
}

function journalCategoryForEventType(eventType: string): TrialJournalCategory {
  if (eventType === "provider.normalized") return "normalized_event";
  if (eventType.startsWith("tool.")) return "tool";
  if (eventType.startsWith("world.")) return "world";
  if (eventType.startsWith("audibility.") || eventType.startsWith("caller.")) return "audio";
  if (eventType.includes("failed") || eventType.includes("error")) return "error";
  if (eventType === "trial.finished") return "finalization";
  if (eventType.startsWith("trial.") || eventType.startsWith("budget.") || eventType.startsWith("session.")) {
    return "lifecycle";
  }
  return "event_chain";
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
  requirePrompt(condition.initialPrompt, "condition.initialPrompt");
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
      || capability.description !== actual[index]?.description
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
  condition: CompiledBenchmarkCondition,
  label: string
): ProviderCapabilitySnapshot {
  const snapshot = ProviderCapabilitySnapshotSchema.parse(snapshotInput);
  if (new Set(snapshot.actions.map((action) => action.capability_grant)).size !== snapshot.actions.length) {
    throw new Error(`${label} capability snapshot must use action-bound unique grants`);
  }
  if (!condition.behavior.progressiveDisclosure) {
    return assertSnapshotMatches(snapshot, condition.visibleCapabilities, label);
  }
  const catalog = new Map(
    [
      ...condition.visibleCapabilities,
      ...condition.disclosures.flatMap((disclosure) => disclosure.visibleCapabilities),
    ].map((capability) => [capability.name, capability])
  );
  for (const action of snapshot.actions) {
    const capability = catalog.get(action.name);
    if (
      !capability
      || capability.description !== action.description
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

function usageCapError(
  provider: ServerRealtimeProvider,
  usage: readonly NormalizedRealtimeUsage[],
  caps: ProviderHardSessionCaps,
): string | null {
  const sum = (key: keyof NormalizedRealtimeUsage): number => usage.reduce((total, event) => {
    const value = event[key];
    return total + (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  if (provider === "xai" && caps.provider === "xai") {
    if (
      Math.ceil(sum("inputAudioMinutes") * 60_000)
      >= caps.max_sent_audio_ms - caps.max_unreported_sent_audio_ms
    ) {
      return "xAI sent-audio pricing cap exceeded";
    }
    if (
      Math.ceil(sum("outputAudioMinutes") * 60_000)
      >= caps.max_received_audio_ms - caps.max_unreported_received_audio_ms
    ) {
      return "xAI received-audio pricing cap exceeded";
    }
    if (
      sum("billableTextInputEvents")
      >= caps.max_billable_text_events - caps.max_unreported_billable_text_events
    ) {
      return "xAI billable-text pricing cap exceeded";
    }
    return null;
  }
  if (provider === "openai" && caps.provider === "openai") {
    if (sum("inputTextTokens") >= caps.max_billed_input_text_tokens - caps.max_unreported_input_text_tokens) return "OpenAI input-text pricing cap exceeded";
    if (sum("inputAudioTokens") >= caps.max_billed_input_audio_tokens - caps.max_unreported_input_audio_tokens) return "OpenAI input-audio pricing cap exceeded";
    if (sum("outputTextTokens") >= caps.max_billed_output_text_tokens - caps.max_unreported_output_text_tokens) return "OpenAI output-text pricing cap exceeded";
    if (sum("outputAudioTokens") >= caps.max_billed_output_audio_tokens - caps.max_unreported_output_audio_tokens) return "OpenAI output-audio pricing cap exceeded";
    return null;
  }
  if (provider === "gemini" && caps.provider === "gemini") {
    if (sum("inputTextTokens") >= caps.max_billed_input_text_tokens - caps.max_unreported_input_text_tokens) return "Gemini input-text pricing cap exceeded";
    if (sum("inputAudioTokens") >= caps.max_billed_input_audio_tokens - caps.max_unreported_input_audio_tokens) return "Gemini input-audio pricing cap exceeded";
    if (sum("outputTextTokens") >= caps.max_billed_output_text_tokens - caps.max_unreported_output_text_tokens) return "Gemini output-text pricing cap exceeded";
    if (sum("outputAudioTokens") >= caps.max_billed_output_audio_tokens - caps.max_unreported_output_audio_tokens) return "Gemini output-audio pricing cap exceeded";
    return null;
  }
  return "provider pricing caps do not match the realtime client";
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

function providerCallFingerprint(call: RealtimeToolCall): string {
  return sha256Hex(`harshas-amazing-call-center/provider-tool-call/v1\n${canonicalArtifactJson(artifactJson({
    name: call.name,
    arguments_text: call.argumentsText,
    arguments_json: call.argumentsJson,
    arguments_error: call.argumentsError ?? null,
  }))}`);
}

function reserveProviderCallIdentity(
  identities: Map<string, ProviderCallIdentity>,
  call: RealtimeToolCall
): Readonly<{ identity: ProviderCallIdentity; conflict: boolean }> {
  const fingerprint = providerCallFingerprint(call);
  const prior = identities.get(call.callId);
  if (prior) return Object.freeze({ identity: prior, conflict: prior.fingerprint !== fingerprint });
  const identity = Object.freeze({
    fingerprint,
    invocationId: deriveProviderReceiptInvocationId(call.callId),
  });
  identities.set(call.callId, identity);
  return Object.freeze({ identity, conflict: false });
}

function responseIdForEvent(event: NormalizedRealtimeEvent): string | undefined {
  switch (event.type) {
    case "response.started":
    case "response.completed":
    case "tool.calls":
    case "tool.dispatch":
    case "output.audio":
    case "output.transcript":
    case "turn.interrupted":
      return event.responseId;
    default:
      return undefined;
  }
}

function requiresResponseIdentity(event: NormalizedRealtimeEvent): boolean {
  return event.type === "response.started"
    || event.type === "response.completed"
    || event.type === "tool.calls"
    || event.type === "tool.dispatch"
    || event.type === "output.audio"
    || event.type === "output.transcript"
    || event.type === "turn.interrupted";
}

function executableToolCalls(
  event: Extract<NormalizedRealtimeEvent, { type: "tool.calls" | "tool.dispatch" }>
): readonly RealtimeToolCall[] {
  if (event.type === "tool.calls") return event.calls;
  return Object.freeze(event.dispatches.map((dispatch) => {
    const argumentsJson = Object.freeze({
      tool_name: dispatch.request.params.name,
      arguments: dispatch.request.params.arguments,
    });
    return Object.freeze({
      callId: dispatch.callId,
      name: event.gateway,
      argumentsText: canonicalArtifactJson(artifactJson(argumentsJson)),
      argumentsJson,
      ...(dispatch.provenance.nativeItemId ? { itemId: dispatch.provenance.nativeItemId } : {}),
      responseId: event.responseId,
      terminalEventId: dispatch.provenance.terminalEventId,
      terminalWireType: dispatch.provenance.terminalWireType,
    });
  }));
}

type ResponseEventBinding = Readonly<{
  accepted: boolean;
  responseTurn: number | null;
  responseId: string | null;
  reason?: "before_caller_turn" | "outside_response_window" | "stale_response_turn" | "event_after_response_terminal";
}>;

/**
 * Bind provider response IDs to exactly one caller turn at receipt time.
 *
 * Realtime callbacks can arrive after awaitLogicalResponse has returned. A
 * bare `currentTurnIndex` lookup would then let delayed audio, tool calls, or a
 * terminal event mutate/end the next caller turn. The persistent ID map and
 * receipt-time turn stamp make that impossible. Adapters normally provide an
 * explicit response ID; the anonymous ID is a fail-safe for legacy adapters
 * and remains scoped to one open caller response window.
 */
function bindResponseEvent(
  runtime: MutableRuntime,
  event: NormalizedRealtimeEvent
): ResponseEventBinding {
  if (!requiresResponseIdentity(event)) {
    return Object.freeze({ accepted: true, responseTurn: null, responseId: null });
  }
  const responseTurn = runtime.currentTurnIndex + 1;
  const explicitId = responseIdForEvent(event);
  if (responseTurn <= 0) {
    return Object.freeze({
      accepted: false,
      responseTurn: null,
      responseId: explicitId ?? null,
      reason: "before_caller_turn",
    });
  }
  if (!runtime.responseWindowOpen) {
    return Object.freeze({
      accepted: false,
      responseTurn,
      responseId: explicitId ?? runtime.activeResponseId,
      reason: "outside_response_window",
    });
  }

  const responseId = explicitId
    ?? runtime.activeResponseId
    ?? `__anonymous_response_turn_${responseTurn}`;
  const priorTurn = runtime.responseTurnById.get(responseId);
  if (priorTurn !== undefined && priorTurn !== responseTurn) {
    return Object.freeze({
      accepted: false,
      responseTurn: priorTurn,
      responseId,
      reason: "stale_response_turn",
    });
  }
  if (runtime.terminalResponseIds.has(responseId)) {
    return Object.freeze({
      accepted: false,
      responseTurn,
      responseId,
      reason: "event_after_response_terminal",
    });
  }
  if (priorTurn === undefined) runtime.responseTurnById.set(responseId, responseTurn);
  if (
    event.type === "response.started"
    || runtime.activeResponseId === null
    || (explicitId !== undefined && priorTurn === undefined)
  ) {
    runtime.activeResponseId = responseId;
  }
  return Object.freeze({ accepted: true, responseTurn, responseId });
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

function compactDisclosure(template: CompiledDisclosure): JsonValue {
  const retainedFields = ["label", "instructions", "context", "required_outputs", "success_criteria"] as const;
  return JsonValueSchema.parse({
    target: template.target,
    information: template.information.map((unit) => {
      const payload = jsonRecord(unit.payload);
      if (!payload) return { id: unit.id, kind: unit.kind, payload: unit.payload };
      const compactPayload: Record<string, JsonValue> = {};
      for (const field of retainedFields) {
        if (Object.hasOwn(payload, field)) compactPayload[field] = payload[field];
      }
      return { id: unit.id, kind: unit.kind, payload: compactPayload };
    }),
  });
}

async function dispatchToolCall(input: Readonly<{
  call: RealtimeToolCall;
  condition: CompiledBenchmarkCondition;
  gatewayKernel: BenchmarkGatewayKernel;
  scenario: BenchmarkScenario;
  runtime: MutableRuntime;
  invocationId: string;
  identityConflict: boolean;
  turn: number;
}>): Promise<Readonly<{
  result: RealtimeToolResult;
  execution: ToolExecution | null;
  action: string | null;
  authoritativeResult: CapabilityGatewayResult | null;
  disclosure: Readonly<{ target: string; prompt: string; renderedSnapshot: string }> | null;
}>> {
  const { call, condition, gatewayKernel, scenario, runtime, invocationId, identityConflict, turn } = input;
  if (!call.callId) {
    throw trialError("protocol_error", "missing_tool_call_id", "Provider tool call omitted callId", "tool", { fatal: true });
  }
  if (identityConflict) {
    const parsed = CapabilityGatewayCallSchema.safeParse(call.argumentsJson);
    return Object.freeze({
      result: {
        callId: call.callId,
        output: gatewayFailure(
          "provider_call_id_conflict",
          "Provider call ID was reused with different tool-call content",
          parsed.success ? parsed.data.tool_name : undefined
        ),
      },
      execution: null,
      action: parsed.success ? parsed.data.tool_name : null,
      authoritativeResult: null,
      disclosure: null,
    });
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
  if (call.argumentsError || !parsedCall.success) {
    return Object.freeze({
      result: {
        callId: call.callId,
        output: gatewayFailure(
          "malformed_gateway_call",
          call.argumentsError ?? "Gateway call must contain exactly tool_name and arguments"
        ),
      },
      execution: null,
      action: null,
      authoritativeResult: null,
      disclosure: null,
    });
  }

  const boundCall = bindCapabilityGatewayCall(parsedCall.data, runtime.currentCapabilitySnapshot);
  if (!boundCall) {
    return Object.freeze({
      result: {
        callId: call.callId,
        output: gatewayFailure(
          "undisclosed_action",
          "Requested tool is absent from the current host capability catalog",
          parsedCall.data.tool_name
        ),
      },
      execution: null,
      action: parsedCall.data.tool_name,
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
      call: AuthorizedCapabilityGatewayCallSchema.parse(boundCall.call),
      capabilityEpoch: boundCall.capabilityEpoch,
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
    runtime.currentCapabilitySnapshot = snapshot;
    const renderedSnapshot = condition.behavior.progressiveDisclosure
      ? renderCompactProviderCapabilitySnapshot(snapshot)
      : renderProviderCapabilitySnapshot(snapshot);
    disclosure = Object.freeze({ target: template.target, prompt: template.prompt, renderedSnapshot });
    providerOutput = {
      gateway_result: visibleOutput,
      progressive_disclosure: condition.behavior.progressiveDisclosure
        ? compactDisclosure(template)
        : template.prompt,
      capability_snapshot: renderedSnapshot,
    };
  } else if (outcome.capabilitySnapshot) {
    const snapshot = assertSnapshotSubset(
      outcome.capabilitySnapshot,
      condition,
      "rotated"
    );
    runtime.currentCapabilitySnapshot = snapshot;
    const renderedSnapshot = condition.behavior.progressiveDisclosure
      ? renderCompactProviderCapabilitySnapshot(snapshot)
      : renderProviderCapabilitySnapshot(snapshot);
    disclosure = Object.freeze({ target: "$grant-rotation", prompt: "", renderedSnapshot });
    providerOutput = {
      gateway_result: visibleOutput,
      capability_snapshot: renderedSnapshot,
    };
  }
  return Object.freeze({
    result: { callId: call.callId, output: providerOutput },
    execution,
    action: parsedCall.data.tool_name,
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

function defaultTrialSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function deliverCallerAudio(input: Readonly<{
  client: NormalizedRealtimeClient;
  turn: PreparedTurn;
  ordinal: number;
  profile: TrialAudioDeliveryProfile;
  sleep: TrialSleep;
  clock: TrialClock;
  sessionStartedMs: number;
  limits: TrialLimits;
  runtime: MutableRuntime;
  journal: TrialJournalCoordinator;
  record(type: string, payload: unknown): void;
}>): Promise<void> {
  const delivery = deliveryPlan(input.turn.material, input.profile);
  if (input.runtime.inputAudioBytes + input.turn.material.bytes.byteLength > input.limits.maxInputAudioBytes) {
    throw trialError(
      "cap_exceeded",
      "input_audio_cap_exceeded",
      `Caller audio would exceed the ${input.limits.maxInputAudioBytes}-byte hard cap`,
      "turn",
      { fatal: true }
    );
  }
  const deliveryStartedMs = input.clock.monotonicNowMs();
  let priorAppendMs = deliveryStartedMs;
  for (const [index, chunk] of delivery.chunks.entries()) {
    const planned = delivery.plan[index];
    input.record("caller.audio_chunk_intent", {
      turn: input.ordinal,
      turn_id: input.turn.turnId,
      chunk_index: index + 1,
      chunk_count: delivery.chunks.length,
      byte_length: planned.byte_length,
      sha256: planned.sha256,
      scheduled_offset_ms: planned.scheduled_offset_ms,
      delivery_hash: delivery.hash,
    });
    await input.journal.flush();
    if (sessionRemainingMs(input.clock, input.sessionStartedMs, input.limits.maxSessionMs) <= 0) {
      throw trialError("session_timeout", "session_timeout", "Trial exceeded the monotonic session cap", "session", { fatal: true });
    }
    try {
      input.client.appendInputAudio(chunk);
    } catch (error) {
      throw trialError("protocol_error", "audio_chunk_append_failed", errorMessage(error), "turn", { fatal: true });
    }
    const appendedAtMs = input.clock.monotonicNowMs();
    if (!Number.isFinite(appendedAtMs) || appendedAtMs < priorAppendMs) {
      throw trialError(
        "protocol_error",
        "non_monotonic_audio_clock",
        "Monotonic clock moved backwards during caller audio delivery",
        "turn",
        { fatal: true }
      );
    }
    priorAppendMs = appendedAtMs;
    input.runtime.inputAudioBytes += chunk.data.byteLength;
    input.runtime.inputAudioMs += chunk.data.byteLength / 2 / chunk.sampleRateHz * 1_000;
    const delivered: TrialAudioChunkDelivery = Object.freeze({
      turn: input.ordinal,
      turn_id: input.turn.turnId,
      chunk_index: index + 1,
      chunk_count: delivery.chunks.length,
      byte_length: chunk.data.byteLength,
      sha256: sha256Hex(chunk.data),
      scheduled_offset_ms: planned.scheduled_offset_ms,
      appended_at_monotonic_ms: appendedAtMs,
      session_offset_ms: Math.max(0, appendedAtMs - input.sessionStartedMs),
    });
    input.runtime.audioDeliveries.push(delivered);
    input.record("caller.audio_chunk_delivered", delivered);
    await input.journal.flush();
    if (index < delivery.chunks.length - 1) {
      const nextScheduledAtMs = deliveryStartedMs + (index + 1) * input.profile.chunkMs;
      const delayMs = Math.max(0, nextScheduledAtMs - input.clock.monotonicNowMs());
      try {
        await input.sleep(delayMs);
      } catch (error) {
        throw trialError("protocol_error", "audio_pacing_failed", errorMessage(error), "turn", { fatal: true });
      }
    }
  }
  input.record("caller.turn_commit_intent", {
    turn: input.ordinal,
    turn_id: input.turn.turnId,
    delivery_hash: delivery.hash,
    chunk_count: delivery.chunks.length,
  });
  await input.journal.flush();
  try {
    input.client.commitInputAudio();
    // Open the response window only after caller audio is durably committed,
    // but before createResponse because test and provider adapters may emit
    // normalized response events synchronously from that call.
    input.runtime.responseWindowOpen = true;
    input.runtime.activeResponseId = null;
    input.client.createResponse();
  } catch (error) {
    input.runtime.responseWindowOpen = false;
    input.runtime.activeResponseId = null;
    throw trialError("protocol_error", "audio_turn_commit_failed", errorMessage(error), "turn", { fatal: true });
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
  providerCallIdentities: Map<string, ProviderCallIdentity>;
  journal: TrialJournalCoordinator;
}>): Promise<void> {
  let responseStartedMs = input.clock.monotonicNowMs();
  let lastSubmissionBarrier = -1;
  while (true) {
    if (input.runtime.terminalError) {
      const terminal = input.runtime.terminalError;
      throw new TrialRuntimeError(
        terminal.code === "output_audio_cap_exceeded"
          ? "cap_exceeded"
          : terminal.code === "session_hard_deadline_exceeded"
            ? "session_timeout"
            : "protocol_error",
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
    await input.journal.flush();
    if (
      queued.responseTurn !== null
      && queued.responseTurn !== input.runtime.currentTurnIndex + 1
    ) {
      input.record("provider.response_event_ignored", {
        event_type: event.type,
        response_id: responseIdForEvent(event) ?? null,
        bound_turn: queued.responseTurn,
        active_turn: input.runtime.currentTurnIndex + 1,
        reason: "queued_for_prior_turn",
      });
      continue;
    }
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
    if (event.type === "tool.calls" || event.type === "tool.dispatch") {
      const calls = executableToolCalls(event);
      if (calls.length === 0) {
        throw trialError("protocol_error", "empty_tool_batch", "Provider emitted an empty tool call batch", "tool", { fatal: true });
      }
      if (input.runtime.toolCalls + calls.length > input.limits.maxToolCalls) {
        throw trialError(
          "cap_exceeded",
          "tool_call_cap_exceeded",
          `Tool batch would exceed the ${input.limits.maxToolCalls}-call hard cap`,
          "tool",
          { fatal: true }
        );
      }
      const ids = calls.map((call) => call.callId);
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        throw trialError("protocol_error", "invalid_tool_batch_ids", "Tool batch contains missing or duplicate call IDs", "tool", { fatal: true });
      }
      input.runtime.toolCalls += calls.length;
      input.record("tool.batch_received", {
        turn: input.runtime.currentTurnIndex + 1,
        response_id: event.responseId ?? null,
        call_count: calls.length,
        call_ids: ids,
      });
      const results: RealtimeToolResult[] = [];
      for (const call of calls) {
        await input.journal.flush();
        // Reserve every syntactically present provider ID before validating the
        // tool name or arguments. A malformed first use therefore cannot evade
        // identity binding and later reuse the same ID for executable content.
        const reservedIdentity = reserveProviderCallIdentity(input.providerCallIdentities, call);
        const invocationId = reservedIdentity.identity.invocationId;
        const dispatched = await dispatchToolCall({
          call,
          condition: input.condition,
          gatewayKernel: input.gatewayKernel,
          scenario: input.scenario,
          runtime: input.runtime,
          invocationId,
          identityConflict: reservedIdentity.conflict,
          turn: input.runtime.currentTurnIndex + 1,
        });
        if (dispatched.execution) input.runtime.kernelProviderCallIds.push(call.callId);
        results.push(dispatched.result);
        input.record("tool.call_result", {
          turn: input.runtime.currentTurnIndex + 1,
          provider_call_id: call.callId,
          invocation_id: invocationId,
          provider_call_identity_conflict: reservedIdentity.conflict,
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
        input.journal.append("world", "world.after_tool_call", {
          turn: input.runtime.currentTurnIndex + 1,
          provider_call_id: call.callId,
          invocation_id: invocationId,
          world: input.runtime.world,
        });
      }
      // Anything already normalized belongs to the response that requested
      // tools. Events emitted synchronously by submitToolResults are a genuine
      // continuation and therefore fall beyond this barrier.
      const submissionBarrier = input.runtime.eventSequence;
      await input.journal.flush();
      try {
        input.client.submitToolResults(results, true);
      } catch (error) {
        throw trialError("protocol_error", "tool_result_submission_failed", errorMessage(error), "tool", { fatal: true });
      }
      // A submitted tool batch starts a new provider response round. Local
      // kernel execution, durable journaling, and ToolWorld receipt work are
      // still bounded by the independent session deadline, but must not consume
      // the provider's response-wait allowance for the continuation.
      responseStartedMs = input.clock.monotonicNowMs();
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
      await input.journal.flush();
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
    pair: PairedAudioManifest;
    audioDelivery: TrialAudioDeliveryReport;
    condition: CompiledBenchmarkCondition;
    scenario: BenchmarkScenario;
    world: ToolWorldState;
    kernelAttestation: BenchmarkKernelFinalAttestation;
    kernelTranscript: string;
    kernelAttestationExpectation: RunTrialInput["kernelAttestationExpectation"];
    callerSchedule: TrialCallerScheduleReport | null;
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
    "provider-wire-observations.jsonl",
    "provider-transport-evidence.json",
    "usage.json",
    "world-final.json",
    "kernel-transcript.jsonl",
    "kernel-attestation.json",
    "trial-result.json",
    "budget-ledger.json",
    "audibility.json",
    "audio/delivery.json",
    "audio/pair-manifest.json",
  ];
  if (expected.callerSchedule) required.push("caller-schedule.json");
  for (const path of required) {
    if (!fileByPath.has(path)) throw new Error(`required trial artifact ${path} is missing`);
  }
  if (
    expected.scenario.id === TRANSPORT_SMOKE_SCENARIO_ID
    && !fileByPath.has("provider-read-only-receipt-linkage.json")
  ) {
    throw new Error("transport smoke is missing its signed-kernel read-only receipt linkage");
  }
  const kernelVerification = verifyBenchmarkKernelFinalAttestation(expected.kernelAttestation, {
    runId: expected.runId,
    condition: expected.condition,
    scenario: expected.scenario,
    world: expected.world,
    transcriptReference: expected.kernelAttestation.transcript_reference,
    evidenceBinding: expected.kernelAttestationExpectation.evidenceBinding,
    trust: expected.kernelAttestationExpectation.trust,
  });
  if (!kernelVerification.valid) {
    throw new Error(`kernel final attestation is invalid: ${kernelVerification.errors.join("; ")}`);
  }
  const transcriptVerification = verifyKernelTranscript({
    transcript: expected.kernelTranscript,
    finalAttestation: expected.kernelAttestation,
    attestationExpectation: {
      runId: expected.runId,
      condition: expected.condition,
      scenario: expected.scenario,
      world: expected.world,
      transcriptReference: expected.kernelAttestation.transcript_reference,
      evidenceBinding: expected.kernelAttestationExpectation.evidenceBinding,
      trust: expected.kernelAttestationExpectation.trust,
    },
  });
  if (!transcriptVerification.valid || transcriptVerification.authenticity !== "signed_attestation_verified") {
    throw new Error(`kernel transcript replay is invalid: ${transcriptVerification.errors.join("; ")}`);
  }
  const kernelFile = fileByPath.get("kernel-attestation.json");
  if (!kernelFile || typeof kernelFile.content !== "string" || kernelFile.content !== benchmarkKernelAttestationJson(expected.kernelAttestation)) {
    throw new Error("kernel-attestation.json does not contain the verified final kernel proof");
  }
  const transcriptFile = fileByPath.get("kernel-transcript.jsonl");
  if (!transcriptFile || typeof transcriptFile.content !== "string" || transcriptFile.content !== expected.kernelTranscript) {
    throw new Error("kernel-transcript.jsonl does not contain the signed replay artifact");
  }
  for (const [index, turn] of expected.planned.entries()) {
    if (!fileByPath.has(pcmPath("input", index + 1, turn.turnId))) {
      throw new Error(`input audio artifact for ${turn.turnId} is missing`);
    }
    if (index < expected.turnsSent && !fileByPath.has(pcmPath("output", index + 1, turn.turnId))) {
      throw new Error(`output audio artifact for sent turn ${turn.turnId} is missing`);
    }
    const delivered = expected.audioDelivery.deliveries.filter((entry) => entry.turn === index + 1);
    const pairedTurn = expected.pair.turns[turn.pairedOrdinal - 1];
    if (!pairedTurn) throw new Error(`paired audio source ${turn.pairedOrdinal} is missing for ${turn.turnId}`);
    if (index < expected.turnsSent && delivered.length !== pairedTurn.chunk_hashes.length) {
      throw new Error(`successful turn ${turn.turnId} does not have a complete paced delivery trace`);
    }
    if (delivered.length > pairedTurn.chunk_hashes.length) {
      throw new Error(`turn ${turn.turnId} has more delivered chunks than its frozen plan`);
    }
    for (const [chunkIndex, delivery] of delivered.entries()) {
      if (
        delivery.chunk_index !== chunkIndex + 1
        || delivery.chunk_count !== pairedTurn.chunk_hashes.length
        || delivery.sha256 !== pairedTurn.chunk_hashes[chunkIndex]
        || delivery.byte_length !== pairedTurn.chunk_byte_lengths[chunkIndex]
      ) {
        throw new Error(`turn ${turn.turnId} delivery chunk ${chunkIndex + 1} diverges from the paired plan`);
      }
    }
  }
  if (expected.audioDelivery.profile_hash !== expected.pair.delivery_profile_hash) {
    throw new Error("audio delivery artifact profile does not match paired audio manifest");
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
  condition: CompiledBenchmarkCondition;
  status: TrialStatus;
  errors: readonly TrialError[];
  counters: TrialCounters;
  planned: readonly PreparedTurn[];
  outputByTurn: readonly Uint8Array[][];
  outputFormatByTurn: ReadonlyArray<Pick<Pcm16Audio, "encoding" | "sampleRateHz" | "channels"> | null>;
  usageRecords: readonly UsageRecord[];
  wireRecords: readonly RawWireRecord[];
  wireObservations: readonly RealtimeWireObservation[];
  providerEvidence: ProviderTransportEvidence;
  providerReceiptLinkage: ProviderReadOnlyReceiptLinkage | null;
  world: ToolWorldState;
  kernelAttestation: BenchmarkKernelFinalAttestation;
  kernelTranscript: string;
  kernelAttestationExpectation: RunTrialInput["kernelAttestationExpectation"];
  callerSchedule: TrialCallerScheduleReport | null;
  pairInvariantsHash: string;
  studyPlanHash: string;
  ledger: BudgetLedger;
  audibility: TrialAudibilityReport;
  audioDelivery: TrialAudioDeliveryReport;
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
  const wireObservationJsonl = input.wireObservations.length === 0
    ? ""
    : `${input.wireObservations.map((observation) => canonicalArtifactJson(artifactJson(observation))).join("\n")}\n`;
  files.push(makeArtifactFile(
    "provider-wire-observations.jsonl",
    wireObservationJsonl,
    "application/x-ndjson"
  ));
  files.push(makeArtifactFile(
    "provider-transport-evidence.json",
    `${canonicalArtifactJson(artifactJson(input.providerEvidence))}\n`,
    "application/json"
  ));
  if (input.providerReceiptLinkage) {
    files.push(makeArtifactFile(
      "provider-read-only-receipt-linkage.json",
      `${canonicalArtifactJson(artifactJson(input.providerReceiptLinkage))}\n`,
      "application/json",
    ));
  }
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
    "kernel-transcript.jsonl",
    input.kernelTranscript,
    "application/x-ndjson"
  ));
  files.push(makeArtifactFile(
    "kernel-attestation.json",
    benchmarkKernelAttestationJson(input.kernelAttestation),
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
    "audio/delivery.json",
    `${canonicalArtifactJson(input.audioDelivery)}\n`,
    "application/json"
  ));
  if (input.callerSchedule) {
    files.push(makeArtifactFile(
      "caller-schedule.json",
      `${canonicalArtifactJson(artifactJson(input.callerSchedule))}\n`,
      "application/json",
    ));
  }
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
      condition: input.condition.id,
      pair_invariants_hash: input.pairInvariantsHash,
      freeze_lock_hash: input.kernelAttestationExpectation.evidenceBinding.freezeLockSha256,
      plan_hash: input.studyPlanHash,
      execution_plan_sha256: input.kernelAttestationExpectation.evidenceBinding.planSha256,
      kernel_build_sha256: input.kernelAttestationExpectation.evidenceBinding.kernelBuildSha256,
      lease_subject_id: input.kernelAttestationExpectation.evidenceBinding.leaseSubjectId,
      condition_hash: input.condition.conditionHash,
      source_hash: input.condition.sourceHash,
      scenario_hash: input.condition.scenarioHash,
      flow_hash: input.condition.flowHash,
      kernel_attestation: benchmarkKernelAttestationReference(input.kernelAttestation),
      kernel_transcript: input.kernelAttestation.transcript_reference,
      status: input.status,
      provider_transport_evidence: {
        path: "provider-transport-evidence.json",
        gate1_eligible: input.providerEvidence.gate1_transport_smoke.eligible,
        wire_chain_head_sha256: input.providerEvidence.wire.chain_head_sha256,
        read_only_receipt_linkage_sha256: input.providerReceiptLinkage?.linkage_sha256 ?? null,
      },
      audibility_applicability: input.audibility.applicability,
      audio_delivery_profile_hash: input.audioDelivery.profile_hash,
      caller_mode: input.callerSchedule ? "closed_loop" : "open_loop",
      caller_schedule_sha256: input.callerSchedule?.schedule_sha256 ?? null,
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
      scenario_id: input.scenario.id,
      scenario_version: input.scenario.version,
      provider: input.provider,
      model: input.model,
      condition: input.condition.id,
      status: input.status,
      pair_invariants_hash: input.pairInvariantsHash,
      freeze_lock_hash: input.kernelAttestationExpectation.evidenceBinding.freezeLockSha256,
      plan_hash: input.studyPlanHash,
      execution_plan_sha256: input.kernelAttestationExpectation.evidenceBinding.planSha256,
      kernel_build_sha256: input.kernelAttestationExpectation.evidenceBinding.kernelBuildSha256,
      lease_subject_id: input.kernelAttestationExpectation.evidenceBinding.leaseSubjectId,
      condition_hash: input.condition.conditionHash,
      source_hash: input.condition.sourceHash,
      scenario_hash: input.condition.scenarioHash,
      flow_hash: input.condition.flowHash,
      kernel_attestation_hash: input.kernelAttestation.attestation_hash,
      kernel_attestation: benchmarkKernelAttestationReference(input.kernelAttestation),
      kernel_transcript: input.kernelAttestation.transcript_reference,
      kernel_world_state_sha256: input.kernelAttestation.world_head.state_sha256,
      kernel_flow_execution_state_sha256: input.kernelAttestation.flow_proof.execution_state_sha256,
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
    pair: input.pair,
    audioDelivery: input.audioDelivery,
    condition: input.condition,
    scenario: input.scenario,
    world: input.world,
    kernelAttestation: input.kernelAttestation,
    kernelTranscript: input.kernelTranscript,
    kernelAttestationExpectation: input.kernelAttestationExpectation,
    callerSchedule: input.callerSchedule,
  });
  return artifacts;
}

/**
 * Run one provider/condition trial. A callerSchedulePlan activates the primary
 * condition-blind closed-loop mode; omitting it preserves the secondary static
 * open-loop stress mode for backwards-compatible transport experiments.
 */
export async function runBenchmarkTrial(input: RunTrialInput): Promise<TrialResult> {
  requireNonEmpty(input.runId, "runId");
  requireNonEmpty(input.model, "model");
  requireSha256(input.pairInvariantsHash, "pairInvariantsHash");
  requireSha256(input.studyPlanHash, "studyPlanHash");
  validateLimits(input.limits);
  if (input.providerHardCaps) {
    if (
      input.providerHardCaps.provider !== input.provider
      || input.providerHardCaps.max_session_ms !== input.limits.maxSessionMs
      || input.providerHardCaps.max_input_audio_bytes !== input.limits.maxInputAudioBytes
      || input.providerHardCaps.max_output_audio_bytes !== input.limits.maxOutputAudioBytes
      || input.providerHardCaps.max_tool_calls !== input.limits.maxToolCalls
      || input.providerHardCaps.provider_transcription.input !== "disabled"
      || input.providerHardCaps.provider_transcription.output !== "disabled"
    ) {
      throw new Error("provider pricing-proof caps differ from the exact trial limits");
    }
  }
  validateCompiledCondition(input.condition);
  const scenario = BenchmarkScenarioSchema.parse(input.scenario);
  const audioDeliveryProfile = normalizeAudioDeliveryProfile(input.audioDeliveryProfile);
  const audioDeliveryProfileHash = trialAudioDeliveryProfileHash(audioDeliveryProfile);
  const planned = validateAndPrepareTurns(
    scenario,
    input.callerTurns,
    input.pairedAudio,
    input.limits,
    audioDeliveryProfile
  );
  const callerScheduler = input.callerSchedulePlan
    ? createDeterministicCallerWorldScheduler(input.callerSchedulePlan)
    : null;
  const plannedTurnCount = callerScheduler
    ? (input.callerSchedulePlan!.stages?.length ?? scenario.caller.turns.length)
    : planned.length;
  if (plannedTurnCount > input.limits.maxTurns || plannedTurnCount > scenario.max_turns) {
    throw new Error("closed-loop caller stage count exceeds the scenario or trial turn cap");
  }
  if (callerScheduler) {
    if (callerScheduler.initialState.run_id !== input.runId) {
      throw new Error("closed-loop caller plan run_id must equal the trial runId");
    }
    if (
      callerScheduler.scenario.id !== scenario.id
      || callerScheduler.scenario.version !== scenario.version
      || canonicalArtifactJson(callerScheduler.scenario) !== canonicalArtifactJson(scenario)
    ) {
      throw new Error("closed-loop caller plan uses a different canonical scenario");
    }
    for (const reference of Object.values(input.callerSchedulePlan!.audio.turns)) {
      const prepared = planned.find((turn) => turn.turnId === reference.turn_id);
      if (!prepared) throw new Error(`closed-loop audio reference ${reference.turn_id} is absent from paired audio`);
      if (
        prepared.material.hash !== reference.pcm_sha256
        || prepared.material.bytes.byteLength !== reference.byte_length
        || prepared.material.format.sampleRateHz !== reference.sample_rate_hz
      ) {
        throw new Error(`closed-loop audio reference ${reference.turn_id} differs from paired PCM`);
      }
    }
  }
  const sleep = input.sleep ?? defaultTrialSleep;
  const clock = input.clock ?? defaultClock();
  const journal = new TrialJournalCoordinator(
    input.journal,
    clock,
    input.journalSecretValues ?? []
  );
  const sessionStartedMs = clock.monotonicNowMs();
  if (!Number.isFinite(sessionStartedMs)) throw new Error("clock.monotonicNowMs() must be finite");
  const createdAt = clock.wallTimeIso();
  let callerSchedulerState: CallerSchedulerState | null = callerScheduler?.initialState ?? null;
  let callerScheduleStatus: TrialCallerScheduleReport["status"] | null = callerScheduler ? "failed" : null;
  let callerBlockedStageId: string | null = null;
  const callerScheduledOpportunities: ScheduledCallerOpportunity[] = [];
  const deliveredTurns: PreparedTurn[] = [];
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
    inputAudioFormat: planned[0].material.format,
    audioDeliveryProfile,
    audioDeliveryProfileHash,
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
      pair_invariants_hash: input.pairInvariantsHash,
      freeze_lock_hash: input.kernelAttestationExpectation.evidenceBinding.freezeLockSha256,
      plan_hash: input.studyPlanHash,
      execution_plan_sha256: input.kernelAttestationExpectation.evidenceBinding.planSha256,
      kernel_build_sha256: input.kernelAttestationExpectation.evidenceBinding.kernelBuildSha256,
      lease_subject_id: input.kernelAttestationExpectation.evidenceBinding.leaseSubjectId,
      condition_hash: input.condition.conditionHash,
      initial_prompt_hash: input.condition.initialPromptHash,
      initial_capability_snapshot_hash: sha256Hex(renderedInitialSnapshot),
      turns_planned: plannedTurnCount,
      input_audio_hashes: planned.map((turn) => turn.material.hash),
      caller_mode: callerScheduler ? "closed_loop" : "open_loop",
      caller_schedule_sha256: callerScheduler?.initialState.schedule_sha256 ?? null,
      audio_delivery_profile: audioDeliveryProfile,
      audio_delivery_profile_hash: audioDeliveryProfileHash,
      retry_policy: "none",
    }),
  });
  const chain: BenchmarkEventEnvelope[] = [];
  const record = (eventType: string, payload: unknown) => {
    const safePayload = redactTrialJournalValue(payload, input.journalSecretValues ?? []);
    const envelope = appendEventEnvelope(chain[chain.length - 1], {
      observed_at: clock.wallTimeIso(),
      event_type: eventType,
      payload: safePayload,
    });
    chain.push(envelope);
    journal.append(journalCategoryForEventType(eventType), eventType, {
      event_sequence: envelope.sequence,
      event_hash: envelope.event_hash,
      payload: safePayload,
    });
  };
  const started = startEventChain(initialEvent);
  chain.push(started);
  journal.append("lifecycle", "trial.started", {
    event_sequence: started.sequence,
    event_hash: started.event_hash,
    payload: started.payload,
  });

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
  await journal.beforeClientCreate({
    run_id: input.runId,
    reservation_id: input.budget.reservationId,
    reservation_status: "active",
    session_configuration: sessionConfiguration,
    initial_capability_snapshot: initialSnapshot,
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
    wireObservations: [],
    normalizedWireLinks: [],
    outputByTurn: planned.map(() => []),
    outputFormatByTurn: planned.map(() => null),
    responseAudio: new Map(),
    activeResponseId: null,
    responseTurnById: new Map(),
    terminalResponseIds: new Set(),
    responseWindowOpen: false,
    audibilityState: createAudibilityState(),
    audibilityEvents: [],
    audioDeliveries: [],
    currentTurnIndex: -1,
    currentCapabilitySnapshot: initialSnapshot,
    sessionReady: false,
    sessionIdSha256: null,
    sessionConfiguration: null,
    normalizedToolCallCount: 0,
    normalizedTerminalCount: 0,
    responseGenerations: 0,
    kernelProviderCallIds: [],
    connected: false,
    eventSequence: 0,
    terminalError: null,
  };
  const inbox = new EventInbox();
  const providerCallIdentities = new Map<string, ProviderCallIdentity>();

  const unsubscribeEvent = client.onEvent((event) => {
    runtime.normalizedEvents += 1;
    runtime.eventSequence += 1;
    runtime.normalizedWireLinks.push(Object.freeze({
      normalized_sequence: runtime.eventSequence,
      normalized_type: event.type,
      wire_type: event.wireType,
      attribution: event.wireObservation ?? Object.freeze({
        availability: "unavailable" as const,
        reason: "legacy_adapter" as const,
      }),
    }));
    record("provider.normalized", normalizedEventPayload(event));
    const responseBinding = bindResponseEvent(runtime, event);
    if (!responseBinding.accepted) {
      record("provider.response_event_ignored", {
        event_type: event.type,
        response_id: responseBinding.responseId,
        bound_turn: responseBinding.responseTurn,
        active_turn: runtime.currentTurnIndex + 1,
        reason: responseBinding.reason,
      });
      if (event.type === "output.audio" && responseBinding.reason === "before_caller_turn") {
        runtime.terminalError = {
          code: "unscoped_output_audio",
          message: "Provider emitted output audio before any caller turn",
          phase: "turn",
          fatal: true,
        };
      }
      return;
    }
    if (event.type === "session.ready") {
      runtime.sessionReady = true;
      runtime.sessionIdSha256 = event.sessionId
        ? realtimeWireIdentitySha256("session", event.sessionId)
        : null;
      runtime.sessionConfiguration = event.configuration ?? client.sessionConfigurationAcknowledgement ?? null;
    }
    if (event.type === "tool.calls" || event.type === "tool.dispatch") {
      runtime.normalizedToolCallCount += executableToolCalls(event).filter(
        (call) => call.name === CAPABILITY_GATEWAY_NAME,
      ).length;
    }
    if (event.type === "response.started") {
      runtime.responseGenerations += 1;
      if (
        input.providerHardCaps
        && runtime.responseGenerations > input.providerHardCaps.max_response_generations
      ) {
        runtime.terminalError = {
          code: "provider_response_generation_cap_exceeded",
          message: "Provider exceeded the verified response-generation pricing cap",
          phase: "turn",
          fatal: true,
        };
        safeClose(client, "provider response-generation cap exceeded");
      }
    }
    if (event.type === "response.completed") runtime.normalizedTerminalCount += 1;
    if (event.type === "error") {
      addErrorOnce(runtime, {
        code: "provider_error",
        message: event.message,
        phase: runtime.connected ? "turn" : "connect",
        ...(event.code ? { provider_code: event.code } : {}),
        fatal: event.fatal,
      });
      journal.append("error", "provider.error", event);
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
      journal.append("usage", "provider.usage", event);
      if (input.providerHardCaps) {
        const capError = usageCapError(input.provider, runtime.usage, input.providerHardCaps);
        if (capError) {
          runtime.terminalError = {
            code: "provider_pricing_cap_exceeded",
            message: capError,
            phase: "turn",
            fatal: true,
          };
          safeClose(client, "provider pricing cap exceeded");
        }
      }
    }
    if (event.type === "output.audio") {
      journal.append("audio", "provider.output_audio", {
        turn: responseBinding.responseTurn ?? runtime.currentTurnIndex + 1,
        response_id: responseBinding.responseId,
        byte_length: event.audio.byteLength,
        sha256: sha256Hex(event.audio),
        format: event.format,
      });
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
          const responseId = responseBinding.responseId
            ?? `__anonymous_response_turn_${runtime.currentTurnIndex + 1}`;
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
    inbox.push(Object.freeze({
      sequence: runtime.eventSequence,
      event,
      responseTurn: responseBinding.responseTurn,
    }));
    if (event.type === "response.completed" && responseBinding.responseId) {
      runtime.terminalResponseIds.add(responseBinding.responseId);
      if (runtime.activeResponseId === responseBinding.responseId) runtime.activeResponseId = null;
    }
  });
  const unsubscribeWire = client.onWireEvent((event) => {
    runtime.rawWireEvents += 1;
    const safe = redactTrialJournalValue(event, input.journalSecretValues ?? []);
    const recordValue = Object.freeze({
      sequence: runtime.rawWireEvents,
      observed_at: clock.wallTimeIso(),
      event: safe,
    });
    runtime.wireRecords.push(recordValue);
    journal.append("raw_wire", "provider.raw_wire", {
      sequence: recordValue.sequence,
      observed_at: recordValue.observed_at,
      event,
    });
    record("provider.wire_observed", {
      sequence: recordValue.sequence,
      sha256: sha256Hex(canonicalArtifactJson(safe)),
      wire_type: isPlainRecord(event) && typeof event.type === "string" ? event.type : null,
    });
  });
  const unsubscribeWireObservation = client.onWireObservation?.((observation) => {
    runtime.wireObservations.push(observation);
    journal.append("raw_wire", "provider.wire_observation", observation);
    record("provider.wire_observation", {
      sequence: observation.sequence,
      direction: observation.direction,
      wire_type: observation.wireType,
      observation_sha256: observation.observationSha256,
      previous_observation_sha256: observation.previousObservationSha256,
      projection_sha256: observation.projectionSha256,
      payload_sha256: observation.payloadSha256,
    });
  }) ?? (() => undefined);

  let providerLifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    // This deadline deliberately uses the host wall clock, not the injectable
    // benchmark clock or an awaited race. It is a last-resort billing kill
    // switch: even a hung journal/fsync hook cannot prevent socket closure.
    const providerBillingDeadlineMs = input.providerHardCaps
      ? input.providerHardCaps.max_session_ms - input.providerHardCaps.forced_close_lead_ms
      : input.limits.maxSessionMs;
    providerLifetimeTimer = setTimeout(() => {
      runtime.terminalError ??= {
        code: "session_hard_deadline_exceeded",
        message: `Provider client exceeded the ${input.limits.maxSessionMs}ms hard wall-clock lifetime`,
        phase: "session",
        fatal: true,
      };
      safeClose(client, "benchmark hard session deadline exceeded");
    }, providerBillingDeadlineMs);
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
    await journal.flush();
    if (!runtime.sessionReady || client.state !== "ready") {
      throw trialError("protocol_error", "missing_session_ack", "connect() resolved without a normalized session.ready acknowledgement", "connect", { fatal: true });
    }
    record("session.acknowledged", {
      provider: client.provider,
      state: client.state,
      session_id_sha256: runtime.sessionIdSha256,
      configuration: runtime.sessionConfiguration,
      condition: input.condition.id,
      initial_prompt_hash: input.condition.initialPromptHash,
      rendered_capability_snapshot_hash: sha256Hex(renderedInitialSnapshot),
    });
    await journal.onSessionOpened({
      run_id: input.runId,
      provider: client.provider,
      model: input.model,
      condition: input.condition.id,
      session_state: client.state,
    });

    const executePreparedTurn = async (turn: PreparedTurn, index: number): Promise<void> => {
      if (sessionRemainingMs(clock, sessionStartedMs, input.limits.maxSessionMs) <= 0) {
        throw trialError("session_timeout", "session_timeout", "Trial exceeded the monotonic session cap", "session", { fatal: true });
      }
      deliveredTurns.push(turn);
      runtime.currentTurnIndex = index;
      record("caller.turn_delivery_intent", {
        ordinal: index + 1,
        turn_id: turn.turnId,
        byte_length: turn.material.bytes.byteLength,
        sha256: turn.material.hash,
        format: turn.material.format,
      });
      await journal.flush();
      await deliverCallerAudio({
        client,
        turn,
        ordinal: index + 1,
        profile: audioDeliveryProfile,
        sleep,
        clock,
        sessionStartedMs,
        limits: input.limits,
        runtime,
        journal,
        record,
      });
      runtime.turnsSent += 1;
      record("caller.turn_sent", {
        ordinal: index + 1,
        turn_id: turn.turnId,
        phase: turn.scenarioTurn.phase,
        tags: turn.scenarioTurn.tags,
        byte_length: turn.material.bytes.byteLength,
        sha256: turn.material.hash,
        format: turn.material.format,
      });
      try {
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
          providerCallIdentities,
          journal,
        });
      } finally {
        runtime.responseWindowOpen = false;
        runtime.activeResponseId = null;
      }
      record("caller.turn_completed", {
        ordinal: index + 1,
        turn_id: turn.turnId,
        output_audio_bytes: runtime.outputByTurn[index].reduce((sum, chunk) => sum + chunk.byteLength, 0),
      });
    };

    if (!callerScheduler) {
      for (const [index, turn] of planned.entries()) await executePreparedTurn(turn, index);
    } else {
      while (true) {
        if (!callerSchedulerState) throw new Error("closed-loop caller state is missing");
        const observation = observeCallerWorld(
          runtime.world,
          input.callerSchedulePlan!.observable_world_fact_keys,
        );
        const selected = callerScheduler.selectNext({
          state: callerSchedulerState,
          observation,
          observed_at: clock.wallTimeIso(),
        });
        callerSchedulerState = selected.state;
        if (selected.status === "complete") {
          callerScheduleStatus = "complete";
          record("caller.schedule_completed", {
            schedule_sha256: callerSchedulerState.schedule_sha256,
            committed_turn_ids: callerSchedulerState.committed_turn_ids,
          });
          break;
        }
        if (selected.status === "blocked") {
          callerScheduleStatus = "blocked";
          callerBlockedStageId = selected.stage_id;
          record("caller.schedule_blocked", {
            schedule_sha256: callerSchedulerState.schedule_sha256,
            stage_id: selected.stage_id,
            unmet: selected.unmet,
          });
          throw trialError(
            "protocol_error",
            "caller_policy_blocked",
            `Closed-loop caller could not select a unique utterance at stage ${selected.stage_id}`,
            "turn",
            { fatal: true },
          );
        }
        callerScheduledOpportunities.push(...selected.opportunities);
        const source = planned.find((turn) => turn.turnId === selected.selection.audio.turn_id);
        const scenarioTurn = scenario.caller.turns.find((turn) => turn.id === selected.selection.turn_id);
        if (!source || !scenarioTurn) {
          throw trialError(
            "protocol_error",
            "caller_selection_not_in_frozen_library",
            `Closed-loop selection ${selected.selection.turn_id} is not in the frozen scenario/audio library`,
            "turn",
            { fatal: true },
          );
        }
        if (source.material.hash !== selected.selection.audio.pcm_sha256) {
          throw trialError(
            "protocol_error",
            "caller_selection_audio_mismatch",
            `Closed-loop selection ${selected.selection.turn_id} does not match frozen PCM`,
            "turn",
            { fatal: true },
          );
        }
        const selectedTurn: PreparedTurn = Object.freeze({
          turnId: selected.selection.turn_id,
          scenarioTurn,
          material: source.material,
          pairedOrdinal: source.pairedOrdinal,
        });
        record("caller.schedule_selected", {
          schedule_sha256: callerSchedulerState.schedule_sha256,
          stage_id: selected.selection.stage_id,
          selection_id: selected.selection.selection_id,
          turn_id: selected.selection.turn_id,
          source_audio_turn_id: selected.selection.audio.turn_id,
          audio_sha256: selected.selection.audio.pcm_sha256,
          observation_sha256: selected.selection.observation_sha256,
          opportunities: selected.opportunities,
        });
        await executePreparedTurn(selectedTurn, deliveredTurns.length);
        const committed = callerScheduler.commitTurn({
          state: callerSchedulerState,
          selection_id: selected.selection.selection_id,
          observation: observeCallerWorld(
            runtime.world,
            input.callerSchedulePlan!.observable_world_fact_keys,
          ),
          observed_at: clock.wallTimeIso(),
        });
        callerSchedulerState = committed.state;
        callerScheduledOpportunities.push(...committed.opportunities);
        record("caller.schedule_committed", {
          schedule_sha256: callerSchedulerState.schedule_sha256,
          stage_id: selected.selection.stage_id,
          selection_id: selected.selection.selection_id,
          turn_id: selected.selection.turn_id,
          caller_world_events: committed.world_events,
          opportunities: committed.opportunities,
        });
      }
    }
  } catch (error) {
    const failure = asTrialRuntimeError(error, runtime.connected ? "turn" : "connect");
    runtime.status = failure.status;
    addErrorOnce(runtime, failure.trialError);
    record("trial.runtime_failed", { status: runtime.status, error: failure.trialError });
  } finally {
    if (providerLifetimeTimer !== null) clearTimeout(providerLifetimeTimer);
    safeClose(client, runtime.status === "completed" ? "benchmark trial completed" : "benchmark trial failed");
    unsubscribeEvent();
    unsubscribeWire();
    unsubscribeWireObservation();
  }

  let audibility: TrialAudibilityReport;
  try {
    audibility = await finalizeAudibility({
      runId: input.runId,
      sink: journal.failed ? undefined : input.audibilitySink,
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

  if (!journal.failed) {
    try {
      await journal.flush();
    } catch (error) {
      const failure = asTrialRuntimeError(error, "artifact");
      runtime.status = failure.status;
      addErrorOnce(runtime, failure.trialError);
      record("journal.failed", { error: failure.trialError });
    }
  }

  if (runtime.status === "completed" && runtime.errors.length > 0) {
    runtime.status = "provider_error";
    record("trial.provider_errors_preserved", {
      error_count: runtime.errors.length,
      fatal_error_count: runtime.errors.filter((error) => error.fatal).length,
    });
  }

  const inputAudioBytes = runtime.inputAudioBytes;
  if (!journal.failed) {
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
  } else {
    runtime.status = "journal_error";
    record("budget.reservation_retained", {
      reservation_id: input.budget.reservationId,
      reservation_status: "active",
      reason: "journal_failure",
    });
  }

  const elapsedMs = Math.max(0, clock.monotonicNowMs() - sessionStartedMs);
  const counters: TrialCounters = Object.freeze({
    turnsPlanned: plannedTurnCount,
    turnsSent: runtime.turnsSent,
    inputAudioBytes,
    outputAudioBytes: runtime.outputAudioBytes,
    toolCalls: runtime.toolCalls,
    normalizedEvents: runtime.normalizedEvents,
    rawWireEvents: runtime.rawWireEvents,
    retries: 0,
    elapsedMs,
  });
  const publicErrors: readonly TrialError[] = Object.freeze(runtime.errors.map((error) => Object.freeze({
    ...error,
    message: String(redactTrialJournalValue(error.message, input.journalSecretValues ?? [])),
    ...(error.provider_code
      ? { provider_code: String(redactTrialJournalValue(error.provider_code, input.journalSecretValues ?? [])) }
      : {}),
  })));
  const audioDelivery: TrialAudioDeliveryReport = Object.freeze({
    schema_version: 1 as const,
    profile: audioDeliveryProfile,
    profile_hash: audioDeliveryProfileHash,
    deliveries: Object.freeze([...runtime.audioDeliveries]),
  });
  const callerSchedule: TrialCallerScheduleReport | null = callerScheduler && callerSchedulerState
    ? Object.freeze({
        schema_version: 1 as const,
        mode: "closed_loop" as const,
        schedule_sha256: callerSchedulerState.schedule_sha256,
        status: callerScheduleStatus ?? "failed",
        stage_id: callerBlockedStageId,
        committed_turn_ids: callerSchedulerState.committed_turn_ids,
        opportunities: Object.freeze(callerScheduledOpportunities),
        evidence: callerSchedulerState.evidence,
      })
    : null;
  // The treatment kernel is the only component that can prove its private
  // final FlowExecutionState. Require that proof for every terminal outcome,
  // including provider/timeout failures, before emitting a complete run.
  const attestationWorld = ToolWorldStateSchema.parse(structuredClone(runtime.world));
  const kernelAttestation = await input.gatewayKernel.attestFinal(Object.freeze({
    runId: input.runId,
    condition: input.condition,
    scenario,
    world: attestationWorld,
  }));
  const kernelTranscript = input.gatewayKernel.encodedTranscript();
  const transcriptReference = input.gatewayKernel.transcriptReference();
  const kernelVerification = verifyBenchmarkKernelFinalAttestation(kernelAttestation, {
    runId: input.runId,
    condition: input.condition,
    scenario,
    world: attestationWorld,
    transcriptReference,
    evidenceBinding: input.kernelAttestationExpectation.evidenceBinding,
    trust: input.kernelAttestationExpectation.trust,
  });
  if (!kernelVerification.valid) {
    throw trialError(
      "protocol_error",
      "invalid_kernel_final_attestation",
      `Kernel final-state proof failed closed: ${kernelVerification.errors.join("; ")}`,
      "artifact",
      { fatal: true }
    );
  }
  const transcriptVerification = verifyKernelTranscript({
    transcript: kernelTranscript,
    finalAttestation: kernelAttestation,
    attestationExpectation: {
      runId: input.runId,
      condition: input.condition,
      scenario,
      world: attestationWorld,
      transcriptReference,
      evidenceBinding: input.kernelAttestationExpectation.evidenceBinding,
      trust: input.kernelAttestationExpectation.trust,
    },
  });
  if (!transcriptVerification.valid || transcriptVerification.authenticity !== "signed_attestation_verified") {
    throw trialError(
      "protocol_error",
      "invalid_kernel_transcript",
      `Kernel transcript replay failed closed: ${transcriptVerification.errors.join("; ")}`,
      "artifact",
      { fatal: true }
    );
  }
  let providerReceiptLinkage: ProviderReadOnlyReceiptLinkage | null = null;
  if (scenario.id === TRANSPORT_SMOKE_SCENARIO_ID) {
    if (runtime.kernelProviderCallIds.length !== 1) {
      throw trialError(
        "protocol_error",
        "transport_smoke_gateway_count",
        `Transport smoke requires exactly one kernel-admitted provider call, observed ${runtime.kernelProviderCallIds.length}`,
        "artifact",
        { fatal: true },
      );
    }
    providerReceiptLinkage = createProviderReadOnlyReceiptLinkage({
      providerCallId: runtime.kernelProviderCallIds[0]!,
      transcript: kernelTranscript,
      finalAttestation: kernelAttestation,
      attestationExpectation: {
        runId: input.runId,
        condition: input.condition,
        scenario,
        world: attestationWorld,
        transcriptReference,
        evidenceBinding: input.kernelAttestationExpectation.evidenceBinding,
        trust: input.kernelAttestationExpectation.trust,
      },
    });
  }
  record("kernel.final_state_attested", {
    attestation_hash: kernelAttestation.attestation_hash,
    world_state_sha256: kernelAttestation.world_head.state_sha256,
    capability_epoch: kernelAttestation.capability_head.epoch,
    capability_target: kernelAttestation.capability_head.target,
    capability_catalog_mode: kernelAttestation.capability_head.catalog_mode,
    provider_grant_scope: kernelAttestation.capability_head.provider_grant_scope,
    internal_flow_scope: kernelAttestation.capability_head.internal_flow_scope,
    capability_catalog_sha256: kernelAttestation.capability_head.catalog_sha256,
    capability_action_count: kernelAttestation.capability_head.action_count,
    flow_execution_state_sha256: kernelAttestation.flow_proof.execution_state_sha256,
    checkpoint_ledger_sha256: kernelAttestation.flow_proof.checkpoint_ledger_sha256,
    action_receipt_ledger_sha256: kernelAttestation.flow_proof.action_receipt_ledger_sha256,
    transcript_sha256: transcriptReference.transcript_sha256,
    transcript_head_sha256: transcriptReference.transcript_head_sha256,
    transcript_entry_count: transcriptReference.transcript_entry_count,
    provider_read_only_receipt_linkage_sha256: providerReceiptLinkage?.linkage_sha256 ?? null,
  });
  await journal.flush();

  // `trial.finished` is the unique semantic end marker consumed by the report
  // auditor, so every proof and settlement event must precede it. If this final
  // durable append fails, fail closed instead of emitting an apparently
  // complete artifact with a non-terminal or unjournaled finish marker.
  record("trial.finished", {
    status: runtime.status,
    counters,
    error_count: runtime.errors.length,
    budget_reservation_status: budgetLedger.reservations.find(
      (reservation) => reservation.reservation_id === input.budget.reservationId
    )?.status ?? "missing",
  });
  await journal.flush();

  const providerInputAudio: ProviderPcmEvidence[] = deliveredTurns
    .slice(0, runtime.turnsSent)
    .map((turn, index) => Object.freeze({
      ordinal: index + 1,
      byte_length: turn.material.bytes.byteLength,
      sha256: turn.material.hash,
      sample_rate_hz: turn.material.format.sampleRateHz,
      channels: 1 as const,
      encoding: "pcm16" as const,
    }));
  const providerOutputAudio: ProviderPcmEvidence[] = runtime.outputByTurn
    .slice(0, runtime.turnsSent)
    .flatMap((chunks, index) => {
      const bytes = concatBytes(chunks);
      const format = runtime.outputFormatByTurn[index];
      if (bytes.byteLength === 0 || !format) return [];
      return [Object.freeze({
        ordinal: index + 1,
        byte_length: bytes.byteLength,
        sha256: sha256Hex(bytes),
        sample_rate_hz: format.sampleRateHz,
        channels: 1 as const,
        encoding: "pcm16" as const,
      })];
    });
  const providerEvidence = buildProviderTransportEvidence({
    provider: input.provider,
    model: input.model,
    sessionReady: runtime.sessionReady,
    ...(runtime.sessionIdSha256 ? { sessionIdSha256: runtime.sessionIdSha256 } : {}),
    sessionConfiguration: runtime.sessionConfiguration,
    wireObservations: runtime.wireObservations,
    normalizedLinks: runtime.normalizedWireLinks,
    inputAudio: providerInputAudio,
    outputAudio: providerOutputAudio,
    normalizedToolCallCount: runtime.normalizedToolCallCount,
    kernelInvocationCount: runtime.toolCalls,
    usage: runtime.usage,
    normalizedTerminalCount: runtime.normalizedTerminalCount,
    limits: input.limits,
    elapsedMs: counters.elapsedMs,
  });
  const artifacts = buildArtifacts({
    runId: input.runId,
    pair: input.pairedAudio,
    scenario,
    provider: input.provider,
    model: input.model,
    condition: input.condition,
    status: runtime.status,
    errors: publicErrors,
    counters,
    planned: deliveredTurns,
    outputByTurn: runtime.outputByTurn,
    outputFormatByTurn: runtime.outputFormatByTurn,
    usageRecords: runtime.usageRecords,
    wireRecords: runtime.wireRecords,
    wireObservations: runtime.wireObservations,
    providerEvidence,
    providerReceiptLinkage,
    world: runtime.world,
    kernelAttestation,
    kernelTranscript,
    kernelAttestationExpectation: input.kernelAttestationExpectation,
    callerSchedule,
    pairInvariantsHash: input.pairInvariantsHash,
    studyPlanHash: input.studyPlanHash,
    ledger: budgetLedger,
    audibility,
    audioDelivery,
    events: chain,
    createdAt,
  });
  const result: TrialResult = Object.freeze({
    schemaVersion: 1 as const,
    runId: input.runId,
    pairId: input.pairedAudio.pair_id,
    provider: input.provider,
    model: input.model,
    condition: input.condition.id,
    status: runtime.status,
    errors: publicErrors,
    counters,
    inputAudioHashes: Object.freeze(deliveredTurns.map((turn) => turn.material.hash)),
    outputAudioHashes: Object.freeze(runtime.outputByTurn.slice(0, runtime.turnsSent).map((chunks) => sha256Hex(concatBytes(chunks)))),
    usage: Object.freeze([...runtime.usage]),
    providerEvidence,
    providerReceiptLinkage,
    audibility,
    audioDelivery,
    callerSchedule,
    kernelAttestation,
    world: ToolWorldStateSchema.parse(runtime.world),
    budgetLedger,
    artifacts,
  });
  if (journal.failed) await journal.flush();
  const reservationStatus = budgetLedger.reservations.find(
    (reservation) => reservation.reservation_id === input.budget.reservationId
  )?.status ?? "missing";
  await journal.finalize({
    run_id: input.runId,
    status: runtime.status,
    manifest: artifacts.manifest,
    event_count: artifacts.events.length,
    budget_reservation_status: reservationStatus,
  });
  return result;
}
