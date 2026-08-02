/**
 * Provider-neutral audibility and terminal-claim authority.
 *
 * Generated audio is not evidence that a caller heard anything. This reducer
 * keeps generation, release, and playback as separate facts. Only ranges
 * acknowledged by a playback authority are projected into conversation
 * evidence. Terminal claims additionally require an effect-receipt-bound grant
 * before any overlapping audio may be released.
 *
 * All sample ranges are half-open: [startSample, endSample).
 */

export const AUDIBILITY_LEDGER_SCHEMA_VERSION = 2 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_SAMPLE_RATE_HZ = 192_000;
const MAX_CHANNELS = 2;
const MAX_CHUNKS_PER_RESPONSE = 16_384;
const MAX_RANGES_PER_EVENT = 1_024;

export type SampleRange = Readonly<{
  startSample: number;
  endSample: number;
}>;

export type AudibilityEvidenceSource =
  | "provider_output"
  | "semantic_alignment"
  | "effect_receipt"
  | "release_controller"
  | "playback_device"
  | "transport_control"
  | "provider_history";

export type AudibilityEvidenceReference = Readonly<{
  source: AudibilityEvidenceSource;
  sha256: string;
  artifactId?: string;
}>;

type EventBase = Readonly<{
  sequence: number;
  eventId: string;
  sessionId: string;
  responseId: string;
  evidence: AudibilityEvidenceReference;
}>;

const VERIFIED_CLAIM_GRANT = Symbol("hacc.verified-claim-grant-authority");
const verifiedClaimGrantAuthorities = new WeakSet<object>();

export type ClaimGrantAuthorityInput = Readonly<{
  responseId: string;
  claimId: string;
  claimContentSha256: string;
  authorityRevision: number;
  authorityReceiptSha256: string;
  reopenedReceiptSha256: string;
  turnContractSha256: string;
  semanticBindingSha256: string;
}>;

export type HostClaimGrantVerification = Readonly<{
  ok: true;
  verifierId: string;
  hostVerificationSha256: string;
}> | Readonly<{
  ok: false;
  reason: string;
}>;

/** Host-owned verifier; implementations must reopen the receipt and verify its
 * effect semantic against the exact turn contract rather than trust request
 * fields. Keeping verification injected makes this module provider-neutral. */
export interface ClaimGrantHostVerifier {
  verifyReopenedReceiptAndTurnContract(input: ClaimGrantAuthorityInput): HostClaimGrantVerification;
}

export type VerifiedClaimGrantAuthority = Readonly<ClaimGrantAuthorityInput & {
  verifierId: string;
  hostVerificationSha256: string;
  [VERIFIED_CLAIM_GRANT]: true;
}>;

export function reopenVerifiedClaimGrantAuthority(
  input: ClaimGrantAuthorityInput,
  hostVerifier: ClaimGrantHostVerifier
): VerifiedClaimGrantAuthority {
  if (!isId(input.responseId)
    || !isId(input.claimId)
    || !isSha256(input.claimContentSha256)
    || !isSafeInteger(input.authorityRevision, 1)
    || !isSha256(input.authorityReceiptSha256)
    || !isSha256(input.reopenedReceiptSha256)
    || !isSha256(input.turnContractSha256)
    || !isSha256(input.semanticBindingSha256)) {
    throw new Error("claim grant authority input is malformed");
  }
  const verification = hostVerifier.verifyReopenedReceiptAndTurnContract(input);
  if (!verification.ok) throw new Error(`host claim-grant verification failed: ${verification.reason}`);
  if (!isId(verification.verifierId) || !isSha256(verification.hostVerificationSha256)) {
    throw new Error("host claim-grant verification receipt is malformed");
  }
  const prepared = {
    ...input,
    verifierId: verification.verifierId,
    hostVerificationSha256: verification.hostVerificationSha256,
    [VERIFIED_CLAIM_GRANT]: true as const,
  };
  verifiedClaimGrantAuthorities.add(prepared);
  return prepared;
}

export type TerminalClaimSemanticInput = Readonly<{
  responseId: string;
  spanId: string;
  text: string;
  contentSha256: string;
  turnContractSha256: string;
}>;

export type TerminalClaimSemanticClassification = Readonly<{
  decision: "terminal_claim" | "not_terminal_claim" | "unknown";
  kind: TerminalClaim["kind"] | null;
  classifierId: string;
  evidenceSha256: string;
}>;

/** Synchronous by design: release admission never performs a model/network call. */
export interface TerminalClaimSemanticClassifier {
  classify(input: TerminalClaimSemanticInput): TerminalClaimSemanticClassification;
}

export type TerminalClaimSemanticDecision = Readonly<{
  classification: TerminalClaimSemanticClassification;
  requiresClaimGrant: boolean;
}>;

export function classifyTerminalClaimSemantics(
  input: TerminalClaimSemanticInput,
  classifier: TerminalClaimSemanticClassifier
): TerminalClaimSemanticDecision {
  if (!isId(input.responseId)
    || !isId(input.spanId)
    || typeof input.text !== "string"
    || input.text.length === 0
    || input.text.length > 16_384
    || !isSha256(input.contentSha256)
    || !isSha256(input.turnContractSha256)) {
    throw new Error("terminal-claim semantic input is malformed");
  }
  const classification = classifier.classify(input);
  if (!isId(classification.classifierId)
    || !isSha256(classification.evidenceSha256)
    || !["terminal_claim", "not_terminal_claim", "unknown"].includes(classification.decision)
    || (classification.decision === "terminal_claim"
      ? !["external_effect", "authorization", "handoff", "policy_outcome"].includes(classification.kind ?? "")
      : classification.kind !== null)) {
    throw new Error("terminal-claim classifier returned malformed evidence");
  }
  return {
    classification,
    // Unknown semantics fail closed. An adapter may register this as the most
    // conservative terminal-claim kind until an offline classifier resolves it.
    requiresClaimGrant: classification.decision !== "not_terminal_claim",
  };
}

export type AudibilityLedgerEvent =
  | (EventBase & Readonly<{
      type: "response_registered";
      encoding: "pcm16";
      sampleRateHz: number;
      channels: 1 | 2;
    }>)
  | (EventBase & Readonly<{
      type: "pcm_chunk_generated";
      chunkId: string;
      ordinal: number;
      sampleCount: number;
      pcmSha256: string;
    }>)
  | (EventBase & Readonly<{
      type: "generation_closed";
    }>)
  | (EventBase & Readonly<{
      type: "terminal_claim_registered";
      claimId: string;
      kind: "external_effect" | "authorization" | "handoff" | "policy_outcome";
      range: SampleRange;
      contentSha256: string;
    }>)
  | (EventBase & Readonly<{
      type: "claim_grant_issued";
      grantId: string;
      authority: VerifiedClaimGrantAuthority;
    }>)
  | (EventBase & Readonly<{
      type: "release_requested";
      decisionId: string;
      range: SampleRange;
      claimGrantIds: readonly string[];
    }>)
  | (EventBase & Readonly<{
      type: "playback_acknowledged";
      acknowledgementId: string;
      ranges: readonly SampleRange[];
      releaseDecisionIds: readonly string[];
    }>)
  | (EventBase & Readonly<{
      type: "playback_cleared";
      clearId: string;
      reason: "barge_in" | "disconnect" | "cancelled" | "superseded" | "other";
    }>)
  | (EventBase & Readonly<{
      type: "delivery_clear_confirmed";
      confirmationId: string;
      clearId: string;
      confirmedNotPlayedRanges: readonly SampleRange[];
    }>)
  | (EventBase & Readonly<{
      type: "barge_in_recorded";
      bargeInId: string;
      clearId: string;
    }>)
  | (EventBase & Readonly<{
      type: "provider_history_truncated";
      truncationId: string;
      retainedThroughSample: number;
    }>);

export type GeneratedPcmChunk = Readonly<{
  chunkId: string;
  ordinal: number;
  range: SampleRange;
  sampleCount: number;
  pcmSha256: string;
  evidence: AudibilityEvidenceReference;
}>;

export type TerminalClaim = Readonly<{
  claimId: string;
  kind: "external_effect" | "authorization" | "handoff" | "policy_outcome";
  range: SampleRange;
  contentSha256: string;
  evidence: AudibilityEvidenceReference;
}>;

export type ClaimGrant = Readonly<{
  grantId: string;
  claimId: string;
  authorityRevision: number;
  authorityReceiptSha256: string;
  reopenedReceiptSha256: string;
  turnContractSha256: string;
  semanticBindingSha256: string;
  verifierId: string;
  hostVerificationSha256: string;
  evidence: AudibilityEvidenceReference;
}>;

export type ReleaseDecision = Readonly<{
  decisionId: string;
  range: SampleRange;
  queueEpoch: number;
  outcome: "released" | "blocked";
  reason: "authorized" | "missing_claim_grant" | "response_sealed";
  claimGrantIds: readonly string[];
  evidence: AudibilityEvidenceReference;
}>;

export type PlaybackAcknowledgement = Readonly<{
  acknowledgementId: string;
  ranges: readonly SampleRange[];
  releaseDecisionIds: readonly string[];
  queueEpoch: number;
  evidence: AudibilityEvidenceReference;
}>;

export type PlaybackClear = Readonly<{
  clearId: string;
  reason: "barge_in" | "disconnect" | "cancelled" | "superseded" | "other";
  clearedRanges: readonly SampleRange[];
  closedQueueEpoch: number;
  evidence: AudibilityEvidenceReference;
}>;

export type DeliveryClearConfirmation = Readonly<{
  confirmationId: string;
  clearId: string;
  confirmedNotPlayedRanges: readonly SampleRange[];
  evidence: AudibilityEvidenceReference;
}>;

export type BargeInRecord = Readonly<{
  bargeInId: string;
  clearId: string;
  audibleThroughRanges: readonly SampleRange[];
  evidence: AudibilityEvidenceReference;
}>;

export type ProviderHistoryTruncation = Readonly<{
  truncationId: string;
  retainedThroughSample: number;
  evidence: AudibilityEvidenceReference;
}>;

export type AudibilityResponseLedger = Readonly<{
  responseId: string;
  encoding: "pcm16";
  sampleRateHz: number;
  channels: 1 | 2;
  generatedSampleCount: number;
  generationClosed: boolean;
  chunks: readonly GeneratedPcmChunk[];
  claims: Readonly<Record<string, TerminalClaim>>;
  grants: Readonly<Record<string, ClaimGrant>>;
  releaseDecisions: readonly ReleaseDecision[];
  playbackAcknowledgements: readonly PlaybackAcknowledgement[];
  acknowledgedPlayedRanges: readonly SampleRange[];
  clears: readonly PlaybackClear[];
  deliveryClearConfirmations: readonly DeliveryClearConfirmation[];
  bargeIns: readonly BargeInRecord[];
  truncations: readonly ProviderHistoryTruncation[];
  queueEpoch: number;
  playbackSealed: boolean;
}>;

export type AudibilityLedger = Readonly<{
  schemaVersion: typeof AUDIBILITY_LEDGER_SCHEMA_VERSION;
  sessionId: string;
  revision: number;
  responses: Readonly<Record<string, AudibilityResponseLedger>>;
  responseOrder: readonly string[];
  appliedEventPayloads: Readonly<Record<number, string>>;
}>;

export type AudibilityLedgerErrorCode =
  | "invalid_event"
  | "wrong_session"
  | "event_sequence_gap"
  | "event_sequence_conflict"
  | "response_conflict"
  | "unknown_response"
  | "generation_closed"
  | "chunk_conflict"
  | "claim_conflict"
  | "claim_outside_generated_audio"
  | "unknown_claim"
  | "grant_conflict"
  | "decision_conflict"
  | "range_outside_generated_audio"
  | "acknowledgement_conflict"
  | "playback_not_released"
  | "stale_release_epoch"
  | "clear_conflict"
  | "delivery_clear_conflict"
  | "barge_in_conflict"
  | "truncation_conflict";

export type AudibilityLedgerApplyResult =
  | Readonly<{ ok: true; state: AudibilityLedger; applied: boolean; duplicate: boolean }>
  | Readonly<{ ok: false; state: AudibilityLedger; code: AudibilityLedgerErrorCode; error: string }>;

export type AudibilityBatchResult = Extract<AudibilityLedgerApplyResult, { ok: true }>
  | (Extract<AudibilityLedgerApplyResult, { ok: false }> & Readonly<{ eventIndex: number }>);

export type AudiblePcmEvidenceRange = Readonly<{
  responseId: string;
  chunkId: string;
  chunkPcmSha256: string;
  range: SampleRange;
  acknowledgementIds: readonly string[];
  status: "acknowledged_played";
}>;

export type ClaimAudibilityStatus =
  | "fully_audible"
  | "verified_not_audible"
  | "unverifiable";

export type TerminalClaimAudibility = Readonly<{
  claimId: string;
  status: ClaimAudibilityStatus;
  acknowledgedRanges: readonly SampleRange[];
  verifiedNotPlayedRanges: readonly SampleRange[];
  unknownRanges: readonly SampleRange[];
  grantId: string | null;
  authorityReceiptSha256: string | null;
}>;

export type AudibleConversationEvidence = Readonly<{
  schemaVersion: typeof AUDIBILITY_LEDGER_SCHEMA_VERSION;
  sessionId: string;
  ledgerRevision: number;
  responses: readonly Readonly<{
    responseId: string;
    evidenceStatus: "verified_audible" | "verified_not_audible" | "unverifiable";
    audibleRanges: readonly SampleRange[];
    verifiedNotPlayedRanges: readonly SampleRange[];
    unknownRanges: readonly SampleRange[];
    pcmEvidence: readonly AudiblePcmEvidenceRange[];
    terminalClaims: readonly TerminalClaimAudibility[];
    unverifiableReasons: readonly string[];
  }>[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isRange(value: unknown): value is SampleRange {
  return isRecord(value)
    && isSafeInteger(value.startSample)
    && isSafeInteger(value.endSample, 1)
    && value.startSample < value.endSample;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function safeCanonicalize(value: unknown): string | null {
  try {
    return canonicalize(value);
  } catch {
    return null;
  }
}

function parseEvidence(value: unknown): value is AudibilityEvidenceReference {
  if (!isRecord(value)) return false;
  const sources = new Set<AudibilityEvidenceSource>([
    "provider_output",
    "semantic_alignment",
    "effect_receipt",
    "release_controller",
    "playback_device",
    "transport_control",
    "provider_history",
  ]);
  return typeof value.source === "string"
    && sources.has(value.source as AudibilityEvidenceSource)
    && isSha256(value.sha256)
    && (value.artifactId === undefined || isId(value.artifactId));
}

function eventSource(type: AudibilityLedgerEvent["type"]): AudibilityEvidenceSource {
  switch (type) {
    case "response_registered":
    case "pcm_chunk_generated":
    case "generation_closed":
      return "provider_output";
    case "terminal_claim_registered":
      return "semantic_alignment";
    case "claim_grant_issued":
      return "effect_receipt";
    case "release_requested":
      return "release_controller";
    case "playback_acknowledged":
    case "delivery_clear_confirmed":
      return "playback_device";
    case "playback_cleared":
    case "barge_in_recorded":
      return "transport_control";
    case "provider_history_truncated":
      return "provider_history";
  }
}

function validateEvent(input: unknown): input is AudibilityLedgerEvent {
  if (!isRecord(input)
    || !isSafeInteger(input.sequence, 1)
    || !isId(input.eventId)
    || !isId(input.sessionId)
    || !isId(input.responseId)
    || !parseEvidence(input.evidence)
    || typeof input.type !== "string") return false;

  const type = input.type as AudibilityLedgerEvent["type"];
  const knownTypes: readonly AudibilityLedgerEvent["type"][] = [
    "response_registered",
    "pcm_chunk_generated",
    "generation_closed",
    "terminal_claim_registered",
    "claim_grant_issued",
    "release_requested",
    "playback_acknowledged",
    "playback_cleared",
    "delivery_clear_confirmed",
    "barge_in_recorded",
    "provider_history_truncated",
  ];
  if (!knownTypes.includes(type) || input.evidence.source !== eventSource(type)) return false;

  switch (type) {
    case "response_registered":
      return input.encoding === "pcm16"
        && isSafeInteger(input.sampleRateHz, 1)
        && input.sampleRateHz <= MAX_SAMPLE_RATE_HZ
        && isSafeInteger(input.channels, 1)
        && input.channels <= MAX_CHANNELS;
    case "pcm_chunk_generated":
      return isId(input.chunkId)
        && isSafeInteger(input.ordinal)
        && isSafeInteger(input.sampleCount, 1)
        && isSha256(input.pcmSha256);
    case "generation_closed":
      return true;
    case "terminal_claim_registered":
      return isId(input.claimId)
        && ["external_effect", "authorization", "handoff", "policy_outcome"].includes(input.kind as string)
        && isRange(input.range)
        && isSha256(input.contentSha256);
    case "claim_grant_issued":
      return isId(input.grantId)
        && isRecord(input.authority)
        && verifiedClaimGrantAuthorities.has(input.authority)
        && input.authority.authorityReceiptSha256 === input.evidence.sha256;
    case "release_requested":
      return isId(input.decisionId)
        && isRange(input.range)
        && Array.isArray(input.claimGrantIds)
        && input.claimGrantIds.length <= MAX_RANGES_PER_EVENT
        && input.claimGrantIds.every(isId)
        && new Set(input.claimGrantIds).size === input.claimGrantIds.length;
    case "playback_acknowledged":
      return isId(input.acknowledgementId)
        && Array.isArray(input.ranges)
        && input.ranges.length > 0
        && input.ranges.length <= MAX_RANGES_PER_EVENT
        && input.ranges.every(isRange)
        && Array.isArray(input.releaseDecisionIds)
        && input.releaseDecisionIds.length > 0
        && input.releaseDecisionIds.length <= MAX_RANGES_PER_EVENT
        && input.releaseDecisionIds.every(isId)
        && new Set(input.releaseDecisionIds).size === input.releaseDecisionIds.length;
    case "playback_cleared":
      return isId(input.clearId)
        && ["barge_in", "disconnect", "cancelled", "superseded", "other"].includes(input.reason as string);
    case "delivery_clear_confirmed":
      return isId(input.confirmationId)
        && isId(input.clearId)
        && Array.isArray(input.confirmedNotPlayedRanges)
        && input.confirmedNotPlayedRanges.length > 0
        && input.confirmedNotPlayedRanges.length <= MAX_RANGES_PER_EVENT
        && input.confirmedNotPlayedRanges.every(isRange);
    case "barge_in_recorded":
      return isId(input.bargeInId) && isId(input.clearId);
    case "provider_history_truncated":
      return isId(input.truncationId) && isSafeInteger(input.retainedThroughSample);
  }
}

export function normalizeSampleRanges(ranges: readonly SampleRange[]): readonly SampleRange[] {
  const sorted = ranges
    .filter(isRange)
    .map((range) => ({ startSample: range.startSample, endSample: range.endSample }))
    .sort((left, right) => left.startSample - right.startSample || left.endSample - right.endSample);
  const normalized: SampleRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (!previous || range.startSample > previous.endSample) {
      normalized.push(range);
    } else if (range.endSample > previous.endSample) {
      normalized[normalized.length - 1] = {
        startSample: previous.startSample,
        endSample: range.endSample,
      };
    }
  }
  return normalized;
}

function intersectRange(left: SampleRange, right: SampleRange): SampleRange | null {
  const startSample = Math.max(left.startSample, right.startSample);
  const endSample = Math.min(left.endSample, right.endSample);
  return startSample < endSample ? { startSample, endSample } : null;
}

function intersectRanges(left: readonly SampleRange[], right: readonly SampleRange[]): readonly SampleRange[] {
  const intersections: SampleRange[] = [];
  for (const leftRange of left) {
    for (const rightRange of right) {
      const intersection = intersectRange(leftRange, rightRange);
      if (intersection) intersections.push(intersection);
    }
  }
  return normalizeSampleRanges(intersections);
}

function subtractRanges(source: readonly SampleRange[], removed: readonly SampleRange[]): readonly SampleRange[] {
  let remaining = normalizeSampleRanges(source);
  for (const cut of normalizeSampleRanges(removed)) {
    const next: SampleRange[] = [];
    for (const range of remaining) {
      if (cut.endSample <= range.startSample || cut.startSample >= range.endSample) {
        next.push(range);
        continue;
      }
      if (cut.startSample > range.startSample) {
        next.push({ startSample: range.startSample, endSample: cut.startSample });
      }
      if (cut.endSample < range.endSample) {
        next.push({ startSample: cut.endSample, endSample: range.endSample });
      }
    }
    remaining = next;
  }
  return remaining;
}

function coversRange(covering: readonly SampleRange[], target: SampleRange): boolean {
  return subtractRanges([target], covering).length === 0;
}

function rangesOverlap(left: SampleRange, right: SampleRange): boolean {
  return left.startSample < right.endSample && right.startSample < left.endSample;
}

function failure(
  state: AudibilityLedger,
  code: AudibilityLedgerErrorCode,
  error: string
): AudibilityLedgerApplyResult {
  return { ok: false, state, code, error };
}

export function createAudibilityLedger(sessionId: string): AudibilityLedger {
  if (!isId(sessionId)) throw new Error("audibility ledger requires a valid session id");
  return {
    schemaVersion: AUDIBILITY_LEDGER_SCHEMA_VERSION,
    sessionId,
    revision: 0,
    responses: {},
    responseOrder: [],
    appliedEventPayloads: {},
  };
}

function applyResponse(
  state: AudibilityLedger,
  event: AudibilityLedgerEvent,
  response: AudibilityResponseLedger,
  isNew = false
): AudibilityLedgerApplyResult {
  const canonicalPayload = safeCanonicalize(event);
  if (canonicalPayload === null) {
    return failure(state, "invalid_event", "audibility event must be canonically serializable");
  }
  return {
    ok: true,
    applied: true,
    duplicate: false,
    state: {
      ...state,
      revision: event.sequence,
      responses: { ...state.responses, [response.responseId]: response },
      responseOrder: isNew ? [...state.responseOrder, response.responseId] : state.responseOrder,
      appliedEventPayloads: {
        ...state.appliedEventPayloads,
        [event.sequence]: canonicalPayload,
      },
    },
  };
}

function findById<T>(items: readonly T[], key: keyof T, id: string): T | undefined {
  return items.find((item) => item[key] === id);
}

export function applyAudibilityLedgerEvent(
  state: AudibilityLedger,
  input: unknown
): AudibilityLedgerApplyResult {
  if (!validateEvent(input)) return failure(state, "invalid_event", "audibility event is malformed or has the wrong evidence source");
  const event = input;
  if (event.sessionId !== state.sessionId) return failure(state, "wrong_session", "event session does not match ledger session");
  const canonicalPayload = safeCanonicalize(event);
  if (canonicalPayload === null) return failure(state, "invalid_event", "audibility event must be canonically serializable");
  if (event.sequence <= state.revision) {
    return state.appliedEventPayloads[event.sequence] === canonicalPayload
      ? { ok: true, state, applied: false, duplicate: true }
      : failure(state, "event_sequence_conflict", `sequence ${event.sequence} has a different payload`);
  }
  if (event.sequence !== state.revision + 1) {
    return failure(state, "event_sequence_gap", `expected sequence ${state.revision + 1}, received ${event.sequence}`);
  }

  const current = state.responses[event.responseId];
  if (event.type === "response_registered") {
    if (current) return failure(state, "response_conflict", `response ${event.responseId} is already registered`);
    return applyResponse(state, event, {
      responseId: event.responseId,
      encoding: event.encoding,
      sampleRateHz: event.sampleRateHz,
      channels: event.channels,
      generatedSampleCount: 0,
      generationClosed: false,
      chunks: [],
      claims: {},
      grants: {},
      releaseDecisions: [],
      playbackAcknowledgements: [],
      acknowledgedPlayedRanges: [],
      clears: [],
      deliveryClearConfirmations: [],
      bargeIns: [],
      truncations: [],
      queueEpoch: 0,
      playbackSealed: false,
    }, true);
  }
  if (!current) return failure(state, "unknown_response", `response ${event.responseId} is not registered`);

  if (event.type === "pcm_chunk_generated") {
    if (current.generationClosed) return failure(state, "generation_closed", "cannot append PCM after generation closes");
    if (current.chunks.length >= MAX_CHUNKS_PER_RESPONSE) return failure(state, "invalid_event", "response exceeds the chunk limit");
    if (event.ordinal !== current.chunks.length) return failure(state, "chunk_conflict", "PCM chunk ordinal must be contiguous");
    if (current.chunks.some(({ chunkId }) => chunkId === event.chunkId)) return failure(state, "chunk_conflict", "PCM chunk id is already registered");
    const range = {
      startSample: current.generatedSampleCount,
      endSample: current.generatedSampleCount + event.sampleCount,
    };
    if (!Number.isSafeInteger(range.endSample)) return failure(state, "invalid_event", "generated sample count exceeds safe integer range");
    return applyResponse(state, event, {
      ...current,
      generatedSampleCount: range.endSample,
      chunks: [...current.chunks, {
        chunkId: event.chunkId,
        ordinal: event.ordinal,
        range,
        sampleCount: event.sampleCount,
        pcmSha256: event.pcmSha256,
        evidence: event.evidence,
      }],
    });
  }

  if (event.type === "generation_closed") {
    if (current.generationClosed) return failure(state, "generation_closed", "generation is already closed");
    return applyResponse(state, event, { ...current, generationClosed: true });
  }

  if (event.type === "terminal_claim_registered") {
    if (current.claims[event.claimId]) return failure(state, "claim_conflict", `claim ${event.claimId} is already registered`);
    if (event.range.endSample > current.generatedSampleCount) {
      return failure(state, "claim_outside_generated_audio", "terminal claim must be contained in generated PCM");
    }
    if (current.releaseDecisions.some((decision) => (
      decision.outcome === "released" && rangesOverlap(decision.range, event.range)
    ))) {
      return failure(state, "claim_conflict", "terminal claim must be registered before overlapping audio is released");
    }
    return applyResponse(state, event, {
      ...current,
      claims: {
        ...current.claims,
        [event.claimId]: {
          claimId: event.claimId,
          kind: event.kind,
          range: event.range,
          contentSha256: event.contentSha256,
          evidence: event.evidence,
        },
      },
    });
  }

  if (event.type === "claim_grant_issued") {
    const authority = event.authority;
    if (authority.responseId !== event.responseId) {
      return failure(state, "grant_conflict", "claim grant authority is bound to a different response");
    }
    const claim = current.claims[authority.claimId];
    if (!claim) return failure(state, "unknown_claim", `claim ${authority.claimId} is not registered`);
    if (claim.contentSha256 !== authority.claimContentSha256) {
      return failure(state, "grant_conflict", "claim grant authority is bound to different claim semantics");
    }
    if (current.grants[event.grantId]) return failure(state, "grant_conflict", `grant ${event.grantId} is already registered`);
    return applyResponse(state, event, {
      ...current,
      grants: {
        ...current.grants,
        [event.grantId]: {
          grantId: event.grantId,
          claimId: authority.claimId,
          authorityRevision: authority.authorityRevision,
          authorityReceiptSha256: authority.authorityReceiptSha256,
          reopenedReceiptSha256: authority.reopenedReceiptSha256,
          turnContractSha256: authority.turnContractSha256,
          semanticBindingSha256: authority.semanticBindingSha256,
          verifierId: authority.verifierId,
          hostVerificationSha256: authority.hostVerificationSha256,
          evidence: event.evidence,
        },
      },
    });
  }

  if (event.type === "release_requested") {
    if (findById(current.releaseDecisions, "decisionId", event.decisionId)) {
      return failure(state, "decision_conflict", `release decision ${event.decisionId} already exists`);
    }
    if (event.range.endSample > current.generatedSampleCount) {
      return failure(state, "range_outside_generated_audio", "release range exceeds generated PCM");
    }
    const intersectingClaims = Object.values(current.claims)
      .filter((claim) => rangesOverlap(claim.range, event.range));
    const grants = event.claimGrantIds.map((grantId) => current.grants[grantId]).filter(Boolean);
    if (grants.length !== event.claimGrantIds.length) {
      return failure(state, "invalid_event", "release request references an unknown claim grant");
    }
    if (grants.some((grant) => !intersectingClaims.some((claim) => claim.claimId === grant.claimId))) {
      return failure(state, "invalid_event", "release request includes a grant unrelated to the released range");
    }
    const everyClaimGranted = intersectingClaims.every((claim) => (
      grants.some((grant) => grant.claimId === claim.claimId)
    ));
    const outcome = !everyClaimGranted || current.playbackSealed ? "blocked" : "released";
    const reason = current.playbackSealed
      ? "response_sealed"
      : everyClaimGranted
        ? "authorized"
        : "missing_claim_grant";
    const decision: ReleaseDecision = {
      decisionId: event.decisionId,
      range: event.range,
      queueEpoch: current.queueEpoch,
      outcome,
      reason,
      claimGrantIds: [...event.claimGrantIds],
      evidence: event.evidence,
    };
    return applyResponse(state, event, {
      ...current,
      releaseDecisions: [...current.releaseDecisions, decision],
    });
  }

  if (event.type === "playback_acknowledged") {
    if (findById(current.playbackAcknowledgements, "acknowledgementId", event.acknowledgementId)) {
      return failure(state, "acknowledgement_conflict", `playback acknowledgement ${event.acknowledgementId} already exists`);
    }
    const decisions = event.releaseDecisionIds
      .map((decisionId) => findById(current.releaseDecisions, "decisionId", decisionId));
    if (decisions.some((decision) => !decision || decision.outcome !== "released")) {
      return failure(state, "playback_not_released", "playback acknowledgement must reference released decisions");
    }
    if (decisions.some((decision) => decision?.queueEpoch !== current.queueEpoch)) {
      return failure(state, "stale_release_epoch", "playback acknowledgement references a cleared queue epoch");
    }
    const releasedRanges = decisions.map((decision) => (decision as ReleaseDecision).range);
    if (event.ranges.some((range) => !coversRange(releasedRanges, range))) {
      return failure(state, "playback_not_released", "acknowledged playback exceeds referenced released ranges");
    }
    const acknowledgement: PlaybackAcknowledgement = {
      acknowledgementId: event.acknowledgementId,
      ranges: normalizeSampleRanges(event.ranges),
      releaseDecisionIds: [...event.releaseDecisionIds],
      queueEpoch: current.queueEpoch,
      evidence: event.evidence,
    };
    return applyResponse(state, event, {
      ...current,
      playbackAcknowledgements: [...current.playbackAcknowledgements, acknowledgement],
      acknowledgedPlayedRanges: normalizeSampleRanges([
        ...current.acknowledgedPlayedRanges,
        ...acknowledgement.ranges,
      ]),
    });
  }

  if (event.type === "playback_cleared") {
    if (findById(current.clears, "clearId", event.clearId)) {
      return failure(state, "clear_conflict", `playback clear ${event.clearId} already exists`);
    }
    const releasedThisEpoch = current.releaseDecisions
      .filter((decision) => decision.outcome === "released" && decision.queueEpoch === current.queueEpoch)
      .map((decision) => decision.range);
    const acknowledgedThisEpoch = current.playbackAcknowledgements
      .filter((acknowledgement) => acknowledgement.queueEpoch === current.queueEpoch)
      .flatMap((acknowledgement) => acknowledgement.ranges);
    const clear: PlaybackClear = {
      clearId: event.clearId,
      reason: event.reason,
      clearedRanges: subtractRanges(releasedThisEpoch, acknowledgedThisEpoch),
      closedQueueEpoch: current.queueEpoch,
      evidence: event.evidence,
    };
    return applyResponse(state, event, {
      ...current,
      clears: [...current.clears, clear],
      queueEpoch: current.queueEpoch + 1,
      playbackSealed: current.playbackSealed || event.reason !== "other",
    });
  }

  if (event.type === "delivery_clear_confirmed") {
    if (findById(current.deliveryClearConfirmations, "confirmationId", event.confirmationId)) {
      return failure(state, "delivery_clear_conflict", `delivery clear confirmation ${event.confirmationId} already exists`);
    }
    const clear = findById(current.clears, "clearId", event.clearId);
    if (!clear) return failure(state, "delivery_clear_conflict", "delivery clear confirmation references an unknown clear");
    if (event.confirmedNotPlayedRanges.some((range) => !coversRange(clear.clearedRanges, range))) {
      return failure(state, "delivery_clear_conflict", "confirmed not-played range exceeds the queue clear range");
    }
    return applyResponse(state, event, {
      ...current,
      deliveryClearConfirmations: [...current.deliveryClearConfirmations, {
        confirmationId: event.confirmationId,
        clearId: event.clearId,
        confirmedNotPlayedRanges: normalizeSampleRanges(event.confirmedNotPlayedRanges),
        evidence: event.evidence,
      }],
    });
  }

  if (event.type === "barge_in_recorded") {
    if (findById(current.bargeIns, "bargeInId", event.bargeInId)) {
      return failure(state, "barge_in_conflict", `barge-in ${event.bargeInId} already exists`);
    }
    const clear = findById(current.clears, "clearId", event.clearId);
    if (!clear || clear.reason !== "barge_in") {
      return failure(state, "barge_in_conflict", "barge-in must reference a barge-in playback clear");
    }
    return applyResponse(state, event, {
      ...current,
      playbackSealed: true,
      bargeIns: [...current.bargeIns, {
        bargeInId: event.bargeInId,
        clearId: event.clearId,
        audibleThroughRanges: current.acknowledgedPlayedRanges,
        evidence: event.evidence,
      }],
    });
  }

  if (findById(current.truncations, "truncationId", event.truncationId)) {
    return failure(state, "truncation_conflict", `truncation ${event.truncationId} already exists`);
  }
  if (event.retainedThroughSample > current.generatedSampleCount) {
    return failure(state, "range_outside_generated_audio", "provider history cannot retain beyond generated PCM");
  }
  return applyResponse(state, event, {
    ...current,
    truncations: [...current.truncations, {
      truncationId: event.truncationId,
      retainedThroughSample: event.retainedThroughSample,
      evidence: event.evidence,
    }],
  });
}

export function applyAudibilityLedgerEvents(
  initial: AudibilityLedger,
  events: readonly unknown[]
): AudibilityBatchResult {
  let state = initial;
  let anyApplied = false;
  let allDuplicates = events.length > 0;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const result = applyAudibilityLedgerEvent(state, events[eventIndex]);
    if (!result.ok) return { ...result, eventIndex };
    state = result.state;
    anyApplied ||= result.applied;
    allDuplicates &&= result.duplicate;
  }
  return { ok: true, state, applied: anyApplied, duplicate: allDuplicates };
}

function acknowledgementIdsForRange(
  response: AudibilityResponseLedger,
  range: SampleRange
): readonly string[] {
  return response.playbackAcknowledgements
    .filter((acknowledgement) => acknowledgement.ranges.some((ackRange) => rangesOverlap(ackRange, range)))
    .map(({ acknowledgementId }) => acknowledgementId)
    .sort();
}

export function projectAudibleConversationEvidence(
  ledger: AudibilityLedger
): AudibleConversationEvidence {
  return {
    schemaVersion: AUDIBILITY_LEDGER_SCHEMA_VERSION,
    sessionId: ledger.sessionId,
    ledgerRevision: ledger.revision,
    responses: ledger.responseOrder.map((responseId) => {
      const response = ledger.responses[responseId];
      const audibleRanges = normalizeSampleRanges(response.acknowledgedPlayedRanges);
      const releasedRanges = normalizeSampleRanges(response.releaseDecisions
        .filter((decision) => decision.outcome === "released")
        .map((decision) => decision.range));
      const verifiedNotPlayedRanges = subtractRanges(
        normalizeSampleRanges(response.deliveryClearConfirmations
          .flatMap((confirmation) => confirmation.confirmedNotPlayedRanges)),
        audibleRanges
      );
      const unknownRanges = subtractRanges(releasedRanges, [
        ...audibleRanges,
        ...verifiedNotPlayedRanges,
      ]);
      const terminalClaims = Object.values(response.claims)
        .sort((left, right) => left.range.startSample - right.range.startSample || left.claimId.localeCompare(right.claimId))
        .map((claim): TerminalClaimAudibility => {
          const acknowledgedRanges = intersectRanges(audibleRanges, [claim.range]);
          const claimVerifiedNotPlayedRanges = intersectRanges(verifiedNotPlayedRanges, [claim.range]);
          const claimUnknownRanges = subtractRanges([claim.range], [
            ...acknowledgedRanges,
            ...claimVerifiedNotPlayedRanges,
          ]);
          const grant = Object.values(response.grants).find((candidate) => candidate.claimId === claim.claimId) ?? null;
          let status: ClaimAudibilityStatus;
          if (coversRange(acknowledgedRanges, claim.range)) status = "fully_audible";
          else if (coversRange(claimVerifiedNotPlayedRanges, claim.range)) status = "verified_not_audible";
          else status = "unverifiable";
          return {
            claimId: claim.claimId,
            status,
            acknowledgedRanges,
            verifiedNotPlayedRanges: claimVerifiedNotPlayedRanges,
            unknownRanges: claimUnknownRanges,
            grantId: grant?.grantId ?? null,
            authorityReceiptSha256: grant?.authorityReceiptSha256 ?? null,
          };
        });
      const pcmEvidence = response.chunks.flatMap((chunk): AudiblePcmEvidenceRange[] => (
        intersectRanges([chunk.range], audibleRanges).map((range) => ({
          responseId,
          chunkId: chunk.chunkId,
          chunkPcmSha256: chunk.pcmSha256,
          range,
          acknowledgementIds: acknowledgementIdsForRange(response, range),
          status: "acknowledged_played",
        }))
      ));
      const unverifiableReasons: string[] = [];
      if (audibleRanges.length === 0 && verifiedNotPlayedRanges.length === 0) {
        unverifiableReasons.push("no_positive_playback_or_delivery_clear_evidence");
      }
      if (unknownRanges.length > 0) {
        unverifiableReasons.push("released_audio_has_unknown_delivery_ranges");
      }
      if (audibleRanges.length > 0 && unknownRanges.length > 0) {
        unverifiableReasons.push("partial_playback_acknowledgement");
      }
      const evidenceStatus = unknownRanges.length === 0 && audibleRanges.length > 0
        ? "verified_audible" as const
        : unknownRanges.length === 0 && audibleRanges.length === 0 && verifiedNotPlayedRanges.length > 0
          ? "verified_not_audible" as const
          : "unverifiable" as const;
      return {
        responseId,
        evidenceStatus,
        audibleRanges,
        verifiedNotPlayedRanges,
        unknownRanges,
        pcmEvidence,
        terminalClaims,
        unverifiableReasons,
      };
    }),
  };
}
