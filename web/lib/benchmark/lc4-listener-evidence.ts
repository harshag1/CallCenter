import { canonicalJson, sha256Hex } from "./artifacts";
import {
  conditionBlindListenerObservation,
  createIndependentAsrRequest,
  independentAsrCalibrationSha256,
  independentAsrContractSha256,
  prepareAudibleSemanticUnit,
  runIndependentAsrAdapter,
  type ConditionBlindListenerObservation,
  type IndependentAsrAdapterExecution,
  type IndependentAsrAdapterInput,
  type IndependentAsrContract,
  type PreparedIndependentAsrCalibration,
} from "./audible-evidence";
import type { BenchmarkKernelAttestationSigner } from "./kernel-attestation";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CAPTURE_CHUNK_DOMAIN = "hacc/lc4/listener-output-chunk-receipt/v1\n";
const CAPTURE_DOMAIN = "hacc/lc4/listener-output-capture/v1\n";
const CHUNK_SEQUENCE_DOMAIN = "hacc/lc4/listener-output-chunk-sequence/v1\n";
const PLAYBACK_DOMAIN = "hacc/lc4/listener-playback-receipt/v1\n";
const SEMANTIC_OPPORTUNITY_DOMAIN = "hacc/lc4/listener-semantic-opportunity/v1\n";
const SEMANTIC_REGISTRY_DOMAIN = "hacc/lc4/listener-semantic-registry/v1\n";
const SEMANTIC_REGISTRY_MANIFEST_DOMAIN = "hacc/lc4/listener-semantic-registry-manifest/v1\n";
const SEMANTIC_PLAN_DOMAIN = "hacc/lc4/listener-semantic-plan/v1\n";
const SEMANTIC_REPLAY_DOMAIN = "hacc/lc4/listener-semantic-replay/v1\n";
const RECORD_DOMAIN = "hacc/lc4/listener-evidence-record/v1\n";
const ARTIFACT_DOMAIN = "hacc/lc4/listener-evidence-artifact/v1\n";

export const LC4_LISTENER_EVIDENCE_VERSION = "lc4-listener-evidence-v1" as const;

export type Lc4RealtimeProvider = "openai" | "gemini" | "xai";

export type Lc4OutputCaptureSurface =
  | "server_realtime_pcm"
  | "benchmark_fixture_pcm"
  | "browser_webrtc_remote_track";

export type Lc4CrpBlockerCode =
  | "subject_or_goal_unresolved"
  | "latest_revision_unacknowledged"
  | "required_evidence_missing"
  | "required_worker_unresolved"
  | "confirmation_invalid_or_missing"
  | "ambiguity_unreconciled"
  | "checkpoint_or_obligation_incomplete"
  | "terminal_claim_unsupported";

const CRP_BLOCKERS = new Set<Lc4CrpBlockerCode>([
  "subject_or_goal_unresolved",
  "latest_revision_unacknowledged",
  "required_evidence_missing",
  "required_worker_unresolved",
  "confirmation_invalid_or_missing",
  "ambiguity_unreconciled",
  "checkpoint_or_obligation_incomplete",
  "terminal_claim_unsupported",
]);
const PROVIDERS = new Set<Lc4RealtimeProvider>(["openai", "gemini", "xai"]);
const CAPTURE_SURFACES = new Set<Lc4OutputCaptureSurface>([
  "server_realtime_pcm",
  "benchmark_fixture_pcm",
  "browser_webrtc_remote_track",
]);
const SEMANTIC_OPERATORS = new Set<Lc4ListenerSemanticCriterion["operator"]>([
  "contains_any",
  "contains_all",
  "contains_none",
  "contains_ordered",
]);

export type Lc4CapturedOutputChunkReceipt = Readonly<{
  schema_version: 1;
  run_id: string;
  opportunity_id: string;
  response_id: string;
  provider: Lc4RealtimeProvider;
  surface: Lc4OutputCaptureSurface;
  ordinal: number;
  chunk_id: string;
  sample_rate_hz: number;
  byte_length: number;
  pcm_sha256: string;
  previous_chunk_receipt_sha256: string | null;
  receipt_sha256: string;
}>;

export type Lc4CapturedOutputChunk = Readonly<{
  pcm: Uint8Array;
  receipt: Lc4CapturedOutputChunkReceipt;
}>;

export type Lc4CapturedOutput = Readonly<{
  schema_version: 1;
  run_id: string;
  opportunity_id: string;
  response_id: string;
  provider: Lc4RealtimeProvider;
  surface: Lc4OutputCaptureSurface;
  format: Readonly<{
    encoding: "pcm16";
    endianness: "little";
    sample_rate_hz: number;
    channels: 1;
  }>;
  chunks: readonly Lc4CapturedOutputChunk[];
  generated_byte_length: number;
  generated_pcm_sha256: string;
  generated_chunk_sequence_sha256: string;
  capture_receipt_sha256: string;
}>;

export type Lc4PlaybackReceipt = Readonly<{
  schema_version: 1;
  run_id: string;
  opportunity_id: string;
  response_id: string;
  capture_receipt_sha256: string;
  generated_chunk_sequence_sha256: string;
  evidence_source: "benchmark_listener_sink" | "exact_scheduled_playback_range";
  evidence_sha256: string;
  status: "completed" | "interrupted" | "failed";
  byte_start: 0;
  byte_end: number;
  scheduled_byte_end: number | null;
  interruption_reason_sha256: string | null;
  receipt_sha256: string;
}>;

export type Lc4ListenerSemanticCriterion = Readonly<{
  criterion_id: string;
  operator: "contains_any" | "contains_all" | "contains_none" | "contains_ordered";
  phrases: readonly string[];
  required_for_final_scorer: boolean;
  crp_blocker: Readonly<{
    code: Lc4CrpBlockerCode;
    precedence: number;
  }> | null;
}>;

export type Lc4ListenerSemanticApplicability = Readonly<{
  status: "applicable";
  reason: null;
}> | Readonly<{
  status: "not_applicable";
  reason: "no_registered_audible_semantic_criteria";
}>;

export type Lc4ListenerSemanticPlan = Readonly<{
  schema_version: 1;
  template_id: string;
  protocol_sha256: string;
  schedule_sha256: string;
  registry_sha256: string;
  registry_manifest_sha256: string;
  opportunities: readonly Readonly<{
    opportunity_id: string;
    applicability: Lc4ListenerSemanticApplicability;
    criteria: readonly Lc4ListenerSemanticCriterion[];
    criterion_plan_sha256: string;
  }>[];
  plan_sha256: string;
}>;

export type Lc4FrozenListenerSemanticRegistry = Readonly<{
  schema_version: 1;
  template_id: string;
  protocol_sha256: string;
  schedule_sha256: string;
  opportunities: readonly Readonly<{
    opportunity_id: string;
    applicability: Lc4ListenerSemanticApplicability;
    criteria: readonly Lc4ListenerSemanticCriterion[];
    criterion_plan_sha256: string;
  }>[];
  registry_sha256: string;
}>;

export type Lc4FrozenListenerSemanticRegistryManifest = Readonly<{
  schema_version: 1;
  protocol_sha256: string;
  entries: readonly Readonly<{
    template_id: string;
    schedule_sha256: string;
    registry_sha256: string;
  }>[];
  manifest_sha256: string;
}>;

export type Lc4ListenerSemanticReplay = Readonly<{
  schema_version: 1;
  opportunity_id: string;
  listener_evidence_sha256: string | null;
  applicability: Lc4ListenerSemanticApplicability;
  listener_status: "verified" | "unverifiable" | "not_applicable";
  criteria: readonly Readonly<{
    criterion_id: string;
    pass: boolean | null;
  }>[];
  earliest_unmet_crp_blocker: Lc4CrpBlockerCode | null;
  final_required_criteria_pass: boolean | null;
  replay_sha256: string;
}>;

export type Lc4ListenerDisposition =
  | "heard_verified"
  | "partial_heard_verified"
  | "heard_unverifiable"
  | "partial_heard_unverifiable"
  | "no_output"
  | "capture_surface_unsupported"
  | "capture_evidence_invalid"
  | "playback_evidence_missing"
  | "playback_evidence_invalid"
  | "playback_failed"
  | "asr_execution_failed"
  | "not_reached_after_critical_failure"
  | "not_reached_after_transport_failure";

export type Lc4ListenerEvidenceRecord = Readonly<{
  schema_version: 1;
  opportunity_id: string;
  criterion_plan_sha256: string;
  turn: number;
  response_id: string | null;
  disposition: Lc4ListenerDisposition;
  capture_receipt_sha256: string | null;
  playback_receipt_sha256: string | null;
  played_pcm_sha256: string | null;
  played_byte_end: number | null;
  generated_byte_length: number | null;
  listener_observation: ConditionBlindListenerObservation | null;
  semantic_replay: Lc4ListenerSemanticReplay;
  failure_reasons: readonly string[];
  record_sha256: string;
}>;

export type Lc4ListenerEvidenceArtifact = Readonly<{
  schema_version: 1;
  evidence_version: typeof LC4_LISTENER_EVIDENCE_VERSION;
  run_id: string;
  template_id: string;
  protocol_sha256: string;
  schedule_sha256: string;
  semantic_plan_sha256: string;
  semantic_registry_sha256: string;
  semantic_registry_manifest_sha256: string;
  asr_contract_sha256: string;
  calibration_sha256: string;
  records: readonly Lc4ListenerEvidenceRecord[];
  coverage: Readonly<{
    expected_opportunities: number;
    reached_opportunities: number;
    output_captured: number;
    playback_verified: number;
    listener_semantics_verified: number;
    semantic_applicable_opportunities: number;
    semantic_not_applicable_opportunities: number;
    partial_playback_opportunities: number;
    unverifiable_opportunities: number;
  }>;
  final_scorer: Readonly<{
    semantic_applicability: "applicable" | "not_applicable";
    all_required_listener_evidence_verified: boolean | null;
    all_required_semantic_criteria_pass: boolean | null;
    failed_opportunity_ids: readonly string[];
    unverifiable_opportunity_ids: readonly string[];
  }>;
  artifact_sha256: string;
}>;

export type Lc4ListenerPipelineOpportunity = Readonly<{
  opportunityId: string;
  turn: number;
  state: "reached" | "not_reached_after_critical_failure" | "not_reached_after_transport_failure";
  audioArtifactPath: string;
  blindObservationNonceSha256: string;
  adapterBlindNonceSha256: string;
  capture?: Lc4CapturedOutput;
  playback?: Lc4PlaybackReceipt;
}>;

/** Hash-only wrapper context used to normalize adapter output into the frozen result schema. */
export type Lc4IndependentAsrOutputBinding = Readonly<{
  source_request_sha256: string;
  source_played_audio_sha256: string;
  source_chunk_sequence_sha256: string;
  played_sample_count: number;
  language: string;
}>;

function hash(domain: string, body: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(body)}`);
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function sha(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeEven(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value % 2 !== 0) {
    throw new Error(`${label} must be a non-negative even safe integer`);
  }
  return value;
}

function concatenate(chunks: readonly Lc4CapturedOutputChunk[]): Uint8Array {
  const byteLength = chunks.reduce((sum, chunk) => sum + chunk.pcm.byteLength, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk.pcm, offset);
    offset += chunk.pcm.byteLength;
  }
  return output;
}

function chunkReceiptBody(receipt: Lc4CapturedOutputChunkReceipt) {
  const body: Record<string, unknown> = { ...receipt };
  delete body.receipt_sha256;
  return body;
}

function captureBody(capture: Lc4CapturedOutput) {
  return {
    schema_version: capture.schema_version,
    run_id: capture.run_id,
    opportunity_id: capture.opportunity_id,
    response_id: capture.response_id,
    provider: capture.provider,
    surface: capture.surface,
    format: capture.format,
    chunks: capture.chunks.map((chunk) => chunk.receipt),
    generated_byte_length: capture.generated_byte_length,
    generated_pcm_sha256: capture.generated_pcm_sha256,
    generated_chunk_sequence_sha256: capture.generated_chunk_sequence_sha256,
  };
}

export function createLc4CapturedOutput(input: Readonly<{
  runId: string;
  opportunityId: string;
  responseId: string;
  provider: Lc4RealtimeProvider;
  surface: Lc4OutputCaptureSurface;
  sampleRateHz: number;
  chunks: readonly Readonly<{ chunkId: string; pcm: Uint8Array }>[];
}>): Lc4CapturedOutput {
  const runId = safeId(input.runId, "LC4 capture run ID");
  const opportunityId = safeId(input.opportunityId, "LC4 capture opportunity ID");
  const responseId = safeId(input.responseId, "LC4 capture response ID");
  if (!PROVIDERS.has(input.provider)) throw new Error("LC4 capture provider is invalid");
  if (!CAPTURE_SURFACES.has(input.surface)) throw new Error("LC4 capture surface is invalid");
  positiveInteger(input.sampleRateHz, "LC4 capture sample rate");
  if (!Array.isArray(input.chunks) || input.chunks.length < 1 || input.chunks.length > 4_096) {
    throw new Error("LC4 capture requires 1..4096 PCM chunks");
  }
  let previous: string | null = null;
  const chunks = input.chunks.map((chunk, ordinal) => {
    safeId(chunk.chunkId, "LC4 capture chunk ID");
    if (!(chunk.pcm instanceof Uint8Array) || chunk.pcm.byteLength < 2 || chunk.pcm.byteLength % 2 !== 0) {
      throw new Error("LC4 capture chunks must contain non-empty PCM16 bytes");
    }
    const pcm = Uint8Array.from(chunk.pcm);
    const body = Object.freeze({
      schema_version: 1 as const,
      run_id: runId,
      opportunity_id: opportunityId,
      response_id: responseId,
      provider: input.provider,
      surface: input.surface,
      ordinal,
      chunk_id: chunk.chunkId,
      sample_rate_hz: input.sampleRateHz,
      byte_length: pcm.byteLength,
      pcm_sha256: sha256Hex(pcm),
      previous_chunk_receipt_sha256: previous,
    });
    const receipt = Object.freeze({ ...body, receipt_sha256: hash(CAPTURE_CHUNK_DOMAIN, body) });
    previous = receipt.receipt_sha256;
    return Object.freeze({ pcm, receipt });
  });
  const generated = concatenate(chunks);
  const format = Object.freeze({
    encoding: "pcm16" as const,
    endianness: "little" as const,
    sample_rate_hz: input.sampleRateHz,
    channels: 1 as const,
  });
  const generatedChunkSequenceSha256 = hash(CHUNK_SEQUENCE_DOMAIN, {
    format,
    chunks: chunks.map((chunk) => chunk.receipt),
  });
  const withoutReceipt = Object.freeze({
    schema_version: 1 as const,
    run_id: runId,
    opportunity_id: opportunityId,
    response_id: responseId,
    provider: input.provider,
    surface: input.surface,
    format,
    chunks: Object.freeze(chunks),
    generated_byte_length: generated.byteLength,
    generated_pcm_sha256: sha256Hex(generated),
    generated_chunk_sequence_sha256: generatedChunkSequenceSha256,
  });
  return Object.freeze({
    ...withoutReceipt,
    capture_receipt_sha256: hash(CAPTURE_DOMAIN, captureBody({
      ...withoutReceipt,
      capture_receipt_sha256: "",
    })),
  });
}

function verifyCapture(capture: Lc4CapturedOutput): readonly string[] {
  const errors: string[] = [];
  try {
    if (capture.schema_version !== 1) errors.push("capture schema mismatch");
    safeId(capture.run_id, "capture run ID");
    safeId(capture.opportunity_id, "capture opportunity ID");
    safeId(capture.response_id, "capture response ID");
    if (!PROVIDERS.has(capture.provider)) errors.push("capture provider is invalid");
    if (!CAPTURE_SURFACES.has(capture.surface)) errors.push("capture surface is invalid");
    if (capture.format.encoding !== "pcm16"
      || capture.format.endianness !== "little"
      || capture.format.channels !== 1
      || !Number.isSafeInteger(capture.format.sample_rate_hz)
      || capture.format.sample_rate_hz < 1) errors.push("capture PCM format is invalid");
    if (!Array.isArray(capture.chunks) || capture.chunks.length < 1) errors.push("capture chunks missing");
    let previous: string | null = null;
    for (const [ordinal, chunk] of capture.chunks.entries()) {
      const receipt = chunk.receipt;
      if (!(chunk.pcm instanceof Uint8Array)
        || receipt.ordinal !== ordinal
        || receipt.run_id !== capture.run_id
        || receipt.opportunity_id !== capture.opportunity_id
        || receipt.response_id !== capture.response_id
        || receipt.provider !== capture.provider
        || receipt.surface !== capture.surface
        || receipt.sample_rate_hz !== capture.format.sample_rate_hz
        || receipt.byte_length !== chunk.pcm.byteLength
        || receipt.pcm_sha256 !== sha256Hex(chunk.pcm)
        || receipt.previous_chunk_receipt_sha256 !== previous
        || receipt.receipt_sha256 !== hash(CAPTURE_CHUNK_DOMAIN, chunkReceiptBody(receipt))) {
        errors.push(`capture chunk ${ordinal} receipt mismatch`);
      }
      previous = receipt.receipt_sha256;
    }
    const generated = concatenate(capture.chunks);
    if (capture.generated_byte_length !== generated.byteLength
      || capture.generated_pcm_sha256 !== sha256Hex(generated)
      || capture.generated_chunk_sequence_sha256 !== hash(CHUNK_SEQUENCE_DOMAIN, {
        format: capture.format,
        chunks: capture.chunks.map((chunk) => chunk.receipt),
      })
      || capture.capture_receipt_sha256 !== hash(CAPTURE_DOMAIN, captureBody(capture))) {
      errors.push("capture aggregate receipt mismatch");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return Object.freeze(errors);
}

/**
 * Fail-closed integrity check for a complete provider-output capture. This is
 * exported so a server-side evaluator handoff can independently reject chunk
 * substitution, reordering, truncation, and aggregate-receipt tampering before
 * any bytes reach ASR.
 */
export function assertLc4CapturedOutputIntegrity(capture: Lc4CapturedOutput): void {
  const errors = verifyCapture(capture);
  if (errors.length > 0) throw new Error(`invalid LC4 capture: ${errors.join("; ")}`);
}

function playbackBody(receipt: Lc4PlaybackReceipt) {
  const body: Record<string, unknown> = { ...receipt };
  delete body.receipt_sha256;
  return body;
}

export function createLc4PlaybackReceipt(input: Readonly<{
  capture: Lc4CapturedOutput;
  evidenceSource: Lc4PlaybackReceipt["evidence_source"];
  evidenceSha256: string;
  status: Lc4PlaybackReceipt["status"];
  playedByteEnd: number;
  scheduledByteEnd?: number;
  interruptionReason?: string;
}>): Lc4PlaybackReceipt {
  const captureErrors = verifyCapture(input.capture);
  if (captureErrors.length > 0) throw new Error(`cannot bind invalid LC4 capture: ${captureErrors.join("; ")}`);
  sha(input.evidenceSha256, "LC4 playback evidence hash");
  const playedByteEnd = nonNegativeEven(input.playedByteEnd, "LC4 played byte end");
  if (playedByteEnd > input.capture.generated_byte_length) throw new Error("LC4 playback exceeds generated PCM");
  if (input.status === "completed" && playedByteEnd !== input.capture.generated_byte_length) {
    throw new Error("completed LC4 playback must cover all generated PCM");
  }
  if (input.status === "interrupted" && playedByteEnd >= input.capture.generated_byte_length) {
    throw new Error("interrupted LC4 playback must stop before generated PCM ends");
  }
  if (input.status === "failed" && playedByteEnd !== 0) throw new Error("failed LC4 playback cannot claim heard bytes");
  const scheduledByteEnd = input.evidenceSource === "exact_scheduled_playback_range"
    ? nonNegativeEven(input.scheduledByteEnd ?? -1, "LC4 scheduled byte end")
    : null;
  if (scheduledByteEnd !== null && scheduledByteEnd !== playedByteEnd) {
    throw new Error("LC4 scheduled playback range differs from the played range");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    run_id: input.capture.run_id,
    opportunity_id: input.capture.opportunity_id,
    response_id: input.capture.response_id,
    capture_receipt_sha256: input.capture.capture_receipt_sha256,
    generated_chunk_sequence_sha256: input.capture.generated_chunk_sequence_sha256,
    evidence_source: input.evidenceSource,
    evidence_sha256: input.evidenceSha256,
    status: input.status,
    byte_start: 0 as const,
    byte_end: playedByteEnd,
    scheduled_byte_end: scheduledByteEnd,
    interruption_reason_sha256: input.interruptionReason === undefined
      ? null
      : sha256Hex(input.interruptionReason),
  });
  return Object.freeze({ ...body, receipt_sha256: hash(PLAYBACK_DOMAIN, body) });
}

function verifyPlayback(capture: Lc4CapturedOutput, receipt: Lc4PlaybackReceipt): readonly string[] {
  const errors: string[] = [];
  if (receipt.schema_version !== 1
    || receipt.run_id !== capture.run_id
    || receipt.opportunity_id !== capture.opportunity_id
    || receipt.response_id !== capture.response_id
    || receipt.capture_receipt_sha256 !== capture.capture_receipt_sha256
    || receipt.generated_chunk_sequence_sha256 !== capture.generated_chunk_sequence_sha256
    || !SHA256.test(receipt.evidence_sha256)
    || receipt.byte_start !== 0
    || !Number.isSafeInteger(receipt.byte_end)
    || receipt.byte_end < 0
    || receipt.byte_end % 2 !== 0
    || receipt.byte_end > capture.generated_byte_length
    || receipt.receipt_sha256 !== hash(PLAYBACK_DOMAIN, playbackBody(receipt))) {
    errors.push("playback receipt binding mismatch");
  }
  if (receipt.evidence_source !== "benchmark_listener_sink"
    && receipt.evidence_source !== "exact_scheduled_playback_range") errors.push("playback evidence source is invalid");
  if (receipt.status !== "completed" && receipt.status !== "interrupted" && receipt.status !== "failed") {
    errors.push("playback status is invalid");
  }
  if (receipt.interruption_reason_sha256 !== null && !SHA256.test(receipt.interruption_reason_sha256)) {
    errors.push("playback interruption reason hash is invalid");
  }
  if (receipt.evidence_source === "exact_scheduled_playback_range"
    && receipt.scheduled_byte_end !== receipt.byte_end) errors.push("scheduled playback range mismatch");
  if (receipt.evidence_source === "benchmark_listener_sink" && receipt.scheduled_byte_end !== null) {
    errors.push("listener sink playback cannot claim a scheduled range");
  }
  if (receipt.status === "completed" && receipt.byte_end !== capture.generated_byte_length) {
    errors.push("completed playback is partial");
  }
  if (receipt.status === "interrupted" && receipt.byte_end >= capture.generated_byte_length) {
    errors.push("interrupted playback is not partial");
  }
  if (receipt.status === "failed" && receipt.byte_end !== 0) errors.push("failed playback claims heard PCM");
  return Object.freeze(errors);
}

function semanticPlanBody(plan: Lc4ListenerSemanticPlan) {
  const body: Record<string, unknown> = { ...plan };
  delete body.plan_sha256;
  return body;
}

function semanticRegistryBody(registry: Lc4FrozenListenerSemanticRegistry) {
  const body: Record<string, unknown> = { ...registry };
  delete body.registry_sha256;
  return body;
}

function semanticOpportunityHash(input: Readonly<{
  templateId: string;
  opportunityId: string;
  applicability: Lc4ListenerSemanticApplicability;
  criteria: readonly Lc4ListenerSemanticCriterion[];
}>): string {
  return hash(SEMANTIC_OPPORTUNITY_DOMAIN, {
    template_id: input.templateId,
    opportunity_id: input.opportunityId,
    applicability: input.applicability,
    criteria: input.criteria,
  });
}

function normalizeSemanticOpportunities(input: Readonly<{
  templateId: string;
  opportunities: readonly Readonly<{
    opportunity_id: string;
    criteria: readonly Lc4ListenerSemanticCriterion[];
  }>[];
}>): Lc4FrozenListenerSemanticRegistry["opportunities"] {
  if (input.opportunities.length < 1 || input.opportunities.length > 100_000) {
    throw new Error("LC4 semantic registry requires opportunities");
  }
  const opportunityIds = new Set<string>();
  return Object.freeze(input.opportunities.map((opportunity) => {
    safeId(opportunity.opportunity_id, "LC4 semantic opportunity ID");
    if (opportunityIds.has(opportunity.opportunity_id)) throw new Error("LC4 semantic registry repeats an opportunity");
    opportunityIds.add(opportunity.opportunity_id);
    const criterionIds = new Set<string>();
    const blockerPrecedence = new Set<number>();
    if (opportunity.criteria.length > 128) throw new Error("LC4 semantic opportunity exceeds 128 criteria");
    const criteria = Object.freeze(opportunity.criteria.map((criterion: Lc4ListenerSemanticCriterion) => {
      safeId(criterion.criterion_id, "LC4 semantic criterion ID");
      if (criterionIds.has(criterion.criterion_id)) throw new Error("LC4 semantic registry repeats a criterion");
      criterionIds.add(criterion.criterion_id);
      if (!SEMANTIC_OPERATORS.has(criterion.operator)) throw new Error("LC4 semantic criterion operator is invalid");
      if (!Array.isArray(criterion.phrases) || criterion.phrases.length < 1
        || criterion.phrases.length > 128
        || criterion.phrases.some((phrase: string) => phrase.length > 1_024)
        || criterion.phrases.some((phrase: string) => normalize(phrase).length === 0)) {
        throw new Error("LC4 semantic criteria require non-empty phrases");
      }
      if (criterion.crp_blocker) {
        if (!CRP_BLOCKERS.has(criterion.crp_blocker.code)) throw new Error("LC4 semantic criterion has an invalid CRP blocker");
        positiveInteger(criterion.crp_blocker.precedence, "LC4 CRP blocker precedence");
        if (blockerPrecedence.has(criterion.crp_blocker.precedence)) throw new Error("LC4 semantic registry repeats CRP precedence");
        blockerPrecedence.add(criterion.crp_blocker.precedence);
      }
      return Object.freeze({ ...criterion, phrases: Object.freeze([...criterion.phrases]) });
    }));
    const applicability: Lc4ListenerSemanticApplicability = criteria.length === 0
      ? Object.freeze({ status: "not_applicable" as const, reason: "no_registered_audible_semantic_criteria" as const })
      : Object.freeze({ status: "applicable" as const, reason: null });
    return Object.freeze({
      opportunity_id: opportunity.opportunity_id,
      applicability,
      criteria,
      criterion_plan_sha256: semanticOpportunityHash({
        templateId: input.templateId,
        opportunityId: opportunity.opportunity_id,
        applicability,
        criteria,
      }),
    });
  }));
}

/** Called only by the deterministic generator before the template is sealed. */
export function createLc4FrozenListenerSemanticRegistry(input: Readonly<{
  templateId: string;
  protocolSha256: string;
  scheduleSha256: string;
  opportunities: readonly Readonly<{
    opportunity_id: string;
    criteria: readonly Lc4ListenerSemanticCriterion[];
  }>[];
}>): Lc4FrozenListenerSemanticRegistry {
  const templateId = safeId(input.templateId, "LC4 semantic template ID");
  sha(input.protocolSha256, "LC4 semantic protocol hash");
  sha(input.scheduleSha256, "LC4 semantic schedule hash");
  const opportunities = normalizeSemanticOpportunities({ templateId, opportunities: input.opportunities });
  const body = Object.freeze({
    schema_version: 1 as const,
    template_id: templateId,
    protocol_sha256: input.protocolSha256,
    schedule_sha256: input.scheduleSha256,
    opportunities,
  });
  return Object.freeze({ ...body, registry_sha256: hash(SEMANTIC_REGISTRY_DOMAIN, body) });
}

function semanticRegistryManifestBody(manifest: Lc4FrozenListenerSemanticRegistryManifest) {
  const body: Record<string, unknown> = { ...manifest };
  delete body.manifest_sha256;
  return body;
}

function assertFrozenSemanticRegistryExact(registry: Lc4FrozenListenerSemanticRegistry): void {
  if (registry.schema_version !== 1) throw new Error("LC4 frozen semantic registry schema mismatch");
  const templateId = safeId(registry.template_id, "LC4 frozen semantic registry template ID");
  sha(registry.protocol_sha256, "LC4 frozen semantic registry protocol hash");
  sha(registry.schedule_sha256, "LC4 frozen semantic registry schedule hash");
  const normalized = normalizeSemanticOpportunities({
    templateId,
    opportunities: registry.opportunities,
  });
  if (canonicalJson(normalized) !== canonicalJson(registry.opportunities)) {
    throw new Error("LC4 frozen semantic registry contains dynamic or invalid criteria");
  }
  if (registry.registry_sha256 !== hash(SEMANTIC_REGISTRY_DOMAIN, semanticRegistryBody(registry))) {
    throw new Error("LC4 frozen semantic registry hash mismatch");
  }
}

function assertFrozenSemanticRegistryManifestExact(manifest: Lc4FrozenListenerSemanticRegistryManifest): void {
  if (manifest.schema_version !== 1 || manifest.entries.length < 1 || manifest.entries.length > 10_000) {
    throw new Error("LC4 frozen semantic registry manifest schema or bounds mismatch");
  }
  sha(manifest.protocol_sha256, "LC4 frozen semantic registry manifest protocol hash");
  const templateIds = new Set<string>();
  for (const entry of manifest.entries) {
    safeId(entry.template_id, "LC4 frozen semantic registry manifest template ID");
    sha(entry.schedule_sha256, "LC4 frozen semantic registry manifest schedule hash");
    sha(entry.registry_sha256, "LC4 frozen semantic registry manifest registry hash");
    if (templateIds.has(entry.template_id)) throw new Error("LC4 frozen semantic registry manifest repeats a template");
    templateIds.add(entry.template_id);
  }
  const sorted = [...manifest.entries].sort((left, right) => left.template_id.localeCompare(right.template_id));
  if (canonicalJson(sorted) !== canonicalJson(manifest.entries)) {
    throw new Error("LC4 frozen semantic registry manifest entries are not canonical");
  }
  if (manifest.manifest_sha256 !== hash(SEMANTIC_REGISTRY_MANIFEST_DOMAIN, semanticRegistryManifestBody(manifest))) {
    throw new Error("LC4 frozen semantic registry manifest hash mismatch");
  }
}

/** Root committed by the held-out sealer before any provider session opens. */
export function createLc4FrozenListenerSemanticRegistryManifest(
  registries: readonly Lc4FrozenListenerSemanticRegistry[],
): Lc4FrozenListenerSemanticRegistryManifest {
  if (!Array.isArray(registries) || registries.length < 1 || registries.length > 10_000) {
    throw new Error("LC4 semantic registry manifest requires bounded template registries");
  }
  const protocolSha256 = sha(registries[0]!.protocol_sha256, "LC4 semantic registry manifest protocol hash");
  const entries = [...registries]
    .map((registry) => {
      assertFrozenSemanticRegistryExact(registry);
      if (registry.protocol_sha256 !== protocolSha256) {
        throw new Error("LC4 semantic registry manifest contains an invalid registry");
      }
      return Object.freeze({
        template_id: safeId(registry.template_id, "LC4 semantic registry template ID"),
        schedule_sha256: sha(registry.schedule_sha256, "LC4 semantic registry schedule hash"),
        registry_sha256: registry.registry_sha256,
      });
    })
    .sort((left, right) => left.template_id.localeCompare(right.template_id));
  if (new Set(entries.map((entry) => entry.template_id)).size !== entries.length) {
    throw new Error("LC4 semantic registry manifest repeats a template");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_sha256: protocolSha256,
    entries: Object.freeze(entries),
  });
  return Object.freeze({ ...body, manifest_sha256: hash(SEMANTIC_REGISTRY_MANIFEST_DOMAIN, body) });
}

/** Derive the only admissible online plan from a sealed generator registry. */
export function createLc4ListenerSemanticPlan(
  registry: Lc4FrozenListenerSemanticRegistry,
  manifest: Lc4FrozenListenerSemanticRegistryManifest,
): Lc4ListenerSemanticPlan {
  assertFrozenSemanticRegistryExact(registry);
  assertFrozenSemanticRegistryManifestExact(manifest);
  const manifestEntry = manifest.entries.find((entry) => entry.template_id === registry.template_id);
  if (!manifestEntry
    || manifest.protocol_sha256 !== registry.protocol_sha256
    || manifestEntry.schedule_sha256 !== registry.schedule_sha256
    || manifestEntry.registry_sha256 !== registry.registry_sha256) {
    throw new Error("LC4 semantic criteria are not present in the sealed registry manifest");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    template_id: registry.template_id,
    protocol_sha256: registry.protocol_sha256,
    schedule_sha256: registry.schedule_sha256,
    registry_sha256: registry.registry_sha256,
    registry_manifest_sha256: manifest.manifest_sha256,
    opportunities: registry.opportunities,
  });
  return Object.freeze({ ...body, plan_sha256: hash(SEMANTIC_PLAN_DOMAIN, body) });
}

function normalize(text: string): readonly string[] {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsSequence(haystack: readonly string[], needle: readonly string[], start = 0): number {
  for (let index = start; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) return index;
  }
  return -1;
}

function criterionPass(criterion: Lc4ListenerSemanticCriterion, transcript: string): boolean {
  const tokens = normalize(transcript);
  const phrases = criterion.phrases.map(normalize);
  const matches = phrases.map((phrase) => containsSequence(tokens, phrase) >= 0);
  if (criterion.operator === "contains_any") return matches.some(Boolean);
  if (criterion.operator === "contains_all") return matches.every(Boolean);
  if (criterion.operator === "contains_none") return matches.every((match) => !match);
  let cursor = 0;
  for (const phrase of phrases) {
    const index = containsSequence(tokens, phrase, cursor);
    if (index < 0) return false;
    cursor = index + phrase.length;
  }
  return true;
}

export function replayLc4ListenerSemantics(input: Readonly<{
  plan: Lc4ListenerSemanticPlan;
  opportunityId: string;
  observation: ConditionBlindListenerObservation | null;
}>): Lc4ListenerSemanticReplay {
  if (input.plan.plan_sha256 !== hash(SEMANTIC_PLAN_DOMAIN, semanticPlanBody(input.plan))) {
    throw new Error("LC4 semantic plan hash mismatch");
  }
  const opportunity = input.plan.opportunities.find((candidate) => candidate.opportunity_id === input.opportunityId);
  if (!opportunity) throw new Error(`LC4 semantic plan omits ${input.opportunityId}`);
  if (opportunity.criterion_plan_sha256 !== semanticOpportunityHash({
    templateId: input.plan.template_id,
    opportunityId: opportunity.opportunity_id,
    applicability: opportunity.applicability,
    criteria: opportunity.criteria,
  })) throw new Error(`LC4 semantic criteria for ${input.opportunityId} differ from the frozen registry`);
  const verified = input.observation?.status === "verified";
  const applicable = opportunity.applicability.status === "applicable";
  const criteria = opportunity.criteria.map((criterion) => Object.freeze({
    criterion_id: criterion.criterion_id,
    pass: applicable && verified ? criterionPass(criterion, input.observation!.transcript) : null,
  }));
  const byId = new Map(criteria.map((criterion) => [criterion.criterion_id, criterion.pass]));
  const earliestUnmet = opportunity.criteria
    .filter((criterion) => criterion.crp_blocker && byId.get(criterion.criterion_id) === false)
    .sort((left, right) => (left.crp_blocker?.precedence ?? 0) - (right.crp_blocker?.precedence ?? 0))[0]
    ?.crp_blocker?.code ?? null;
  const required = opportunity.criteria.filter((criterion) => criterion.required_for_final_scorer);
  const finalPass = !applicable || !verified ? null : required.every((criterion) => byId.get(criterion.criterion_id) === true);
  const body = Object.freeze({
    schema_version: 1 as const,
    opportunity_id: input.opportunityId,
    listener_evidence_sha256: input.observation?.evidence_sha256 ?? null,
    applicability: opportunity.applicability,
    listener_status: !applicable ? "not_applicable" as const : verified ? "verified" as const : "unverifiable" as const,
    criteria: Object.freeze(criteria),
    earliest_unmet_crp_blocker: earliestUnmet,
    final_required_criteria_pass: finalPass,
  });
  return Object.freeze({ ...body, replay_sha256: hash(SEMANTIC_REPLAY_DOMAIN, body) });
}

function makeRecord(input: Omit<Lc4ListenerEvidenceRecord, "schema_version" | "record_sha256">): Lc4ListenerEvidenceRecord {
  const body = Object.freeze({ schema_version: 1 as const, ...input });
  return Object.freeze({ ...body, record_sha256: hash(RECORD_DOMAIN, body) });
}

function criterionPlanSha256(plan: Lc4ListenerSemanticPlan, opportunityId: string): string {
  const opportunity = plan.opportunities.find((candidate) => candidate.opportunity_id === opportunityId);
  if (!opportunity) throw new Error(`LC4 frozen semantic registry omits ${opportunityId}`);
  return opportunity.criterion_plan_sha256;
}

function failureRecord(input: Readonly<{
  opportunity: Lc4ListenerPipelineOpportunity;
  plan: Lc4ListenerSemanticPlan;
  disposition: Lc4ListenerDisposition;
  responseId?: string | null;
  captureReceiptSha256?: string | null;
  playbackReceiptSha256?: string | null;
  generatedByteLength?: number | null;
  failureReasons: readonly string[];
}>): Lc4ListenerEvidenceRecord {
  return makeRecord({
    opportunity_id: input.opportunity.opportunityId,
    criterion_plan_sha256: criterionPlanSha256(input.plan, input.opportunity.opportunityId),
    turn: input.opportunity.turn,
    response_id: input.responseId ?? null,
    disposition: input.disposition,
    capture_receipt_sha256: input.captureReceiptSha256 ?? null,
    playback_receipt_sha256: input.playbackReceiptSha256 ?? null,
    played_pcm_sha256: null,
    played_byte_end: null,
    generated_byte_length: input.generatedByteLength ?? null,
    listener_observation: null,
    semantic_replay: replayLc4ListenerSemantics({
      plan: input.plan,
      opportunityId: input.opportunity.opportunityId,
      observation: null,
    }),
    failure_reasons: Object.freeze([...new Set(input.failureReasons)].sort()),
  });
}

function aggregateListenerEvidence(records: readonly Lc4ListenerEvidenceRecord[]) {
  const verifiedDispositions = new Set<Lc4ListenerDisposition>(["heard_verified", "partial_heard_verified"]);
  const partialDispositions = new Set<Lc4ListenerDisposition>(["partial_heard_verified", "partial_heard_unverifiable"]);
  const notReachedDispositions = new Set<Lc4ListenerDisposition>([
    "not_reached_after_critical_failure",
    "not_reached_after_transport_failure",
  ]);
  const failedOpportunityIds = records
    .filter((record) => record.semantic_replay.final_required_criteria_pass === false)
    .map((record) => record.opportunity_id);
  const applicableRecords = records.filter((record) => record.semantic_replay.applicability.status === "applicable");
  const unverifiableOpportunityIds = applicableRecords
    .filter((record) => !verifiedDispositions.has(record.disposition))
    .map((record) => record.opportunity_id);
  const finalPassValues = applicableRecords.map((record) => record.semantic_replay.final_required_criteria_pass);
  return Object.freeze({
    coverage: Object.freeze({
      expected_opportunities: records.length,
      reached_opportunities: records.filter((record) => !notReachedDispositions.has(record.disposition)).length,
      output_captured: records.filter((record) => record.capture_receipt_sha256 !== null).length,
      playback_verified: records.filter((record) => record.played_byte_end !== null).length,
      listener_semantics_verified: applicableRecords.filter((record) => verifiedDispositions.has(record.disposition)).length,
      semantic_applicable_opportunities: applicableRecords.length,
      semantic_not_applicable_opportunities: records.length - applicableRecords.length,
      partial_playback_opportunities: records.filter((record) => partialDispositions.has(record.disposition)).length,
      unverifiable_opportunities: unverifiableOpportunityIds.length,
    }),
    final_scorer: Object.freeze({
      semantic_applicability: applicableRecords.length === 0 ? "not_applicable" as const : "applicable" as const,
      all_required_listener_evidence_verified: applicableRecords.length === 0
        ? null
        : unverifiableOpportunityIds.length === 0,
      all_required_semantic_criteria_pass: applicableRecords.length === 0 || finalPassValues.includes(null)
        ? null
        : finalPassValues.every((value) => value === true),
      failed_opportunity_ids: Object.freeze(failedOpportunityIds),
      unverifiable_opportunity_ids: Object.freeze(unverifiableOpportunityIds),
    }),
  });
}

export async function createLc4ListenerEvidenceArtifact(input: Readonly<{
  runId: string;
  protocolSha256: string;
  scheduleSha256: string;
  semanticPlan: Lc4ListenerSemanticPlan;
  asrContract: IndependentAsrContract;
  asrCalibration: PreparedIndependentAsrCalibration;
  asrRunnerSigner: BenchmarkKernelAttestationSigner;
  opportunities: readonly Lc4ListenerPipelineOpportunity[];
  verifyOutputCaptureEvidence(capture: Lc4CapturedOutput): boolean | Promise<boolean>;
  verifyPlaybackEvidence(receipt: Lc4PlaybackReceipt): boolean | Promise<boolean>;
  executeAsr(
    adapterInput: IndependentAsrAdapterInput,
    outputBinding: Lc4IndependentAsrOutputBinding,
  ): Promise<IndependentAsrAdapterExecution> | IndependentAsrAdapterExecution;
}>): Promise<Lc4ListenerEvidenceArtifact> {
  const runId = safeId(input.runId, "LC4 listener run ID");
  sha(input.protocolSha256, "LC4 listener protocol hash");
  sha(input.scheduleSha256, "LC4 listener schedule hash");
  if (input.semanticPlan.protocol_sha256 !== input.protocolSha256
    || input.semanticPlan.schedule_sha256 !== input.scheduleSha256
    || input.semanticPlan.plan_sha256 !== hash(SEMANTIC_PLAN_DOMAIN, semanticPlanBody(input.semanticPlan))) {
    throw new Error("LC4 listener semantic plan binding mismatch");
  }
  if (!Array.isArray(input.opportunities) || input.opportunities.length < 1) {
    throw new Error("LC4 listener evidence requires opportunities");
  }
  const opportunityIds = input.opportunities.map((opportunity) => safeId(opportunity.opportunityId, "LC4 opportunity ID"));
  if (new Set(opportunityIds).size !== opportunityIds.length) throw new Error("LC4 listener evidence repeats an opportunity");
  if (canonicalJson(opportunityIds) !== canonicalJson(input.semanticPlan.opportunities.map((entry) => entry.opportunity_id))) {
    throw new Error("LC4 listener opportunities differ from the semantic plan order");
  }
  const records: Lc4ListenerEvidenceRecord[] = [];
  for (const opportunity of input.opportunities) {
    positiveInteger(opportunity.turn, "LC4 listener turn");
    sha(opportunity.blindObservationNonceSha256, "LC4 blind observation nonce hash");
    sha(opportunity.adapterBlindNonceSha256, "LC4 ASR adapter blind nonce hash");
    if (opportunity.state !== "reached") {
      if (opportunity.capture || opportunity.playback) throw new Error("unreached LC4 opportunity cannot contain listener evidence");
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: opportunity.state,
        failureReasons: [opportunity.state],
      }));
      continue;
    }
    const capture = opportunity.capture;
    if (!capture) {
      records.push(failureRecord({ opportunity, plan: input.semanticPlan, disposition: "no_output", failureReasons: ["output_pcm_missing"] }));
      continue;
    }
    if (capture.run_id !== runId || capture.opportunity_id !== opportunity.opportunityId) {
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: "capture_evidence_invalid",
        responseId: capture.response_id,
        captureReceiptSha256: capture.capture_receipt_sha256,
        generatedByteLength: capture.generated_byte_length,
        failureReasons: ["capture_identity_mismatch"],
      }));
      continue;
    }
    if (capture.surface === "browser_webrtc_remote_track") {
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: "capture_surface_unsupported",
        responseId: capture.response_id,
        captureReceiptSha256: capture.capture_receipt_sha256,
        generatedByteLength: capture.generated_byte_length,
        failureReasons: ["browser_webrtc_listener_capture_not_implemented"],
      }));
      continue;
    }
    const captureErrors = verifyCapture(capture);
    if (captureErrors.length > 0) {
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: "capture_evidence_invalid",
        responseId: capture.response_id,
        captureReceiptSha256: capture.capture_receipt_sha256,
        generatedByteLength: capture.generated_byte_length,
        failureReasons: captureErrors,
      }));
      continue;
    }
    let captureAuthorityVerified = false;
    try {
      captureAuthorityVerified = await input.verifyOutputCaptureEvidence(capture);
    } catch {
      captureAuthorityVerified = false;
    }
    if (!captureAuthorityVerified) {
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: "capture_evidence_invalid",
        responseId: capture.response_id,
        captureReceiptSha256: capture.capture_receipt_sha256,
        generatedByteLength: capture.generated_byte_length,
        failureReasons: ["output_capture_authority_rejected"],
      }));
      continue;
    }
    if (!opportunity.playback) {
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: "playback_evidence_missing",
        responseId: capture.response_id,
        captureReceiptSha256: capture.capture_receipt_sha256,
        generatedByteLength: capture.generated_byte_length,
        failureReasons: ["listener_playback_receipt_missing"],
      }));
      continue;
    }
    const playbackErrors = verifyPlayback(capture, opportunity.playback);
    if (playbackErrors.length > 0) {
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: "playback_evidence_invalid",
        responseId: capture.response_id,
        captureReceiptSha256: capture.capture_receipt_sha256,
        playbackReceiptSha256: opportunity.playback.receipt_sha256,
        generatedByteLength: capture.generated_byte_length,
        failureReasons: playbackErrors,
      }));
      continue;
    }
    let playbackAuthorityVerified = false;
    try {
      playbackAuthorityVerified = await input.verifyPlaybackEvidence(opportunity.playback);
    } catch {
      playbackAuthorityVerified = false;
    }
    if (!playbackAuthorityVerified) {
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: "playback_evidence_invalid",
        responseId: capture.response_id,
        captureReceiptSha256: capture.capture_receipt_sha256,
        playbackReceiptSha256: opportunity.playback.receipt_sha256,
        generatedByteLength: capture.generated_byte_length,
        failureReasons: ["listener_playback_authority_rejected"],
      }));
      continue;
    }
    if (opportunity.playback.status === "failed") {
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: "playback_failed",
        responseId: capture.response_id,
        captureReceiptSha256: capture.capture_receipt_sha256,
        playbackReceiptSha256: opportunity.playback.receipt_sha256,
        generatedByteLength: capture.generated_byte_length,
        failureReasons: ["listener_playback_failed"],
      }));
      continue;
    }
    const asrChunks = capture.chunks.map((chunk: Lc4CapturedOutputChunk) => Object.freeze({
      chunkId: chunk.receipt.chunk_id,
      encoding: "pcm16" as const,
      sampleRateHz: capture.format.sample_rate_hz,
      channels: 1 as const,
      data: Uint8Array.from(chunk.pcm),
    }));
    try {
      const request = createIndependentAsrRequest({
        runId,
        unitId: `listener-${opportunity.opportunityId}`,
        invocationId: `listener-asr-${opportunity.turn}`,
        adapterBlindNonceSha256: opportunity.adapterBlindNonceSha256,
        contract: input.asrContract,
        chunks: asrChunks,
        playedThroughByte: opportunity.playback.byte_end,
      });
      const invocation = await runIndependentAsrAdapter({
        request,
        contract: input.asrContract,
        runnerSigner: input.asrRunnerSigner,
        execute: (adapterInput) => input.executeAsr(adapterInput, Object.freeze({
          source_request_sha256: request.request_sha256,
          source_played_audio_sha256: request.source_played_audio_sha256,
          source_chunk_sequence_sha256: request.source_chunk_sequence_sha256,
          played_sample_count: request.played_sample_count,
          language: input.asrContract.decoding.language,
        })),
      });
      const unit = prepareAudibleSemanticUnit({
        runId,
        unitId: request.unit_id,
        responseId: capture.response_id,
        blindObservationId: opportunity.blindObservationNonceSha256,
        turn: opportunity.turn,
        audioArtifactPath: opportunity.audioArtifactPath,
        asrInvocation: invocation,
        contract: input.asrContract,
        calibration: input.asrCalibration,
      });
      const observation = conditionBlindListenerObservation(unit);
      const partial = opportunity.playback.status === "interrupted"
        || opportunity.playback.byte_end < capture.generated_byte_length;
      const verified = observation.status === "verified";
      records.push(makeRecord({
        opportunity_id: opportunity.opportunityId,
        criterion_plan_sha256: criterionPlanSha256(input.semanticPlan, opportunity.opportunityId),
        turn: opportunity.turn,
        response_id: capture.response_id,
        disposition: partial
          ? verified ? "partial_heard_verified" : "partial_heard_unverifiable"
          : verified ? "heard_verified" : "heard_unverifiable",
        capture_receipt_sha256: capture.capture_receipt_sha256,
        playback_receipt_sha256: opportunity.playback.receipt_sha256,
        played_pcm_sha256: request.source_played_audio_sha256,
        played_byte_end: opportunity.playback.byte_end,
        generated_byte_length: capture.generated_byte_length,
        listener_observation: observation,
        semantic_replay: replayLc4ListenerSemantics({
          plan: input.semanticPlan,
          opportunityId: opportunity.opportunityId,
          observation,
        }),
        failure_reasons: observation.status === "verified" ? Object.freeze([]) : observation.reasons,
      }));
    } catch (error) {
      records.push(failureRecord({
        opportunity,
        plan: input.semanticPlan,
        disposition: "asr_execution_failed",
        responseId: capture.response_id,
        captureReceiptSha256: capture.capture_receipt_sha256,
        playbackReceiptSha256: opportunity.playback.receipt_sha256,
        generatedByteLength: capture.generated_byte_length,
        failureReasons: [`asr_pipeline_error:${error instanceof Error ? error.name : "NonErrorThrow"}`],
      }));
    }
  }
  const frozenRecords = Object.freeze(records);
  const aggregate = aggregateListenerEvidence(frozenRecords);
  const body = Object.freeze({
    schema_version: 1 as const,
    evidence_version: LC4_LISTENER_EVIDENCE_VERSION,
    run_id: runId,
    template_id: input.semanticPlan.template_id,
    protocol_sha256: input.protocolSha256,
    schedule_sha256: input.scheduleSha256,
    semantic_plan_sha256: input.semanticPlan.plan_sha256,
    semantic_registry_sha256: input.semanticPlan.registry_sha256,
    semantic_registry_manifest_sha256: input.semanticPlan.registry_manifest_sha256,
    asr_contract_sha256: independentAsrContractSha256(input.asrContract),
    calibration_sha256: independentAsrCalibrationSha256(input.asrCalibration.summary),
    records: frozenRecords,
    coverage: aggregate.coverage,
    final_scorer: aggregate.final_scorer,
  });
  return Object.freeze({ ...body, artifact_sha256: hash(ARTIFACT_DOMAIN, body) });
}

export function verifyLc4ListenerEvidenceArtifact(input: Readonly<{
  artifact: Lc4ListenerEvidenceArtifact;
  semanticPlan: Lc4ListenerSemanticPlan;
  asrContract: IndependentAsrContract;
  calibrationSha256: string;
}>): Readonly<{ valid: boolean; errors: readonly string[] }> {
  const errors: string[] = [];
  const artifact = input.artifact;
  if (artifact.schema_version !== 1 || artifact.evidence_version !== LC4_LISTENER_EVIDENCE_VERSION) {
    errors.push("LC4 listener artifact schema/version mismatch");
  }
  if (artifact.semantic_plan_sha256 !== input.semanticPlan.plan_sha256
    || artifact.template_id !== input.semanticPlan.template_id
    || artifact.semantic_registry_sha256 !== input.semanticPlan.registry_sha256
    || artifact.semantic_registry_manifest_sha256 !== input.semanticPlan.registry_manifest_sha256
    || artifact.protocol_sha256 !== input.semanticPlan.protocol_sha256
    || artifact.schedule_sha256 !== input.semanticPlan.schedule_sha256) {
    errors.push("LC4 listener artifact semantic-plan binding mismatch");
  }
  if (artifact.asr_contract_sha256 !== independentAsrContractSha256(input.asrContract)) {
    errors.push("LC4 listener artifact ASR contract mismatch");
  }
  if (artifact.calibration_sha256 !== input.calibrationSha256) errors.push("LC4 listener artifact calibration mismatch");
  const opportunityIds = artifact.records.map((record) => record.opportunity_id);
  if (new Set(opportunityIds).size !== opportunityIds.length
    || canonicalJson(opportunityIds) !== canonicalJson(input.semanticPlan.opportunities.map((entry) => entry.opportunity_id))) {
    errors.push("LC4 listener artifact opportunity inventory mismatch");
  }
  for (const record of artifact.records) {
    const frozenOpportunity = input.semanticPlan.opportunities.find((entry) => entry.opportunity_id === record.opportunity_id);
    if (!frozenOpportunity || record.criterion_plan_sha256 !== frozenOpportunity.criterion_plan_sha256) {
      errors.push(`LC4 listener record ${record.opportunity_id} criterion-plan binding mismatch`);
    }
    const recordBody: Record<string, unknown> = { ...record };
    delete recordBody.record_sha256;
    if (record.record_sha256 !== hash(RECORD_DOMAIN, recordBody)) errors.push(`LC4 listener record ${record.opportunity_id} hash mismatch`);
    try {
      const replay = replayLc4ListenerSemantics({
        plan: input.semanticPlan,
        opportunityId: record.opportunity_id,
        observation: record.listener_observation,
      });
      if (canonicalJson(replay) !== canonicalJson(record.semantic_replay)) {
        errors.push(`LC4 listener record ${record.opportunity_id} semantic replay mismatch`);
      }
    } catch (error) {
      errors.push(`LC4 listener record ${record.opportunity_id} replay failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const aggregate = aggregateListenerEvidence(artifact.records);
  if (canonicalJson(artifact.coverage) !== canonicalJson(aggregate.coverage)
    || canonicalJson(artifact.final_scorer) !== canonicalJson(aggregate.final_scorer)) {
    errors.push("LC4 listener artifact aggregate replay mismatch");
  }
  const body: Record<string, unknown> = { ...artifact };
  delete body.artifact_sha256;
  if (artifact.artifact_sha256 !== hash(ARTIFACT_DOMAIN, body)) errors.push("LC4 listener artifact hash mismatch");
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function lc4ListenerEvidenceForCrp(
  artifact: Lc4ListenerEvidenceArtifact,
  opportunityId: string,
): Readonly<{
  status: "verified" | "unverifiable";
  observation: ConditionBlindListenerObservation | null;
  earliestUnmetBlocker: Lc4CrpBlockerCode | null;
  evidenceSha256: string;
}> {
  const record = artifact.records.find((candidate) => candidate.opportunity_id === opportunityId);
  if (!record) throw new Error(`LC4 listener evidence omits ${opportunityId}`);
  const verified = record.listener_observation?.status === "verified";
  return Object.freeze({
    status: verified ? "verified" : "unverifiable",
    observation: verified ? record.listener_observation : null,
    earliestUnmetBlocker: verified ? record.semantic_replay.earliest_unmet_crp_blocker : null,
    evidenceSha256: record.record_sha256,
  });
}
