/**
 * Provider-neutral "Audible State Commit" state machine.
 *
 * Realtime providers commonly add an entire generated assistant response to
 * their conversation history before the caller has heard it. If the caller
 * interrupts, the provider can therefore reason from words that were never
 * audible. This module records both timelines and makes that mismatch explicit.
 *
 * The reducer is deliberately pure, serializable, and independent of wall-clock
 * time. Provider adapters may persist the state, sign commit evidence, and emit
 * the same events again after a retry without double-applying them.
 */

export const AUDIBILITY_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_CONSEQUENTIAL_WEIGHT = 1_000 as const;

export type ConsequentialContentKind =
  | "authorization"
  | "commitment"
  | "instruction"
  | "policy"
  | "safety_boundary"
  | "state_change"
  | "tool_result"
  | "other";

/**
 * A time-aligned semantic unit whose apparent delivery can change what the
 * agent or an external system is allowed to do. Raw transcript text is omitted
 * intentionally; callers can retain a digest or privacy-safe label instead.
 */
export type ConsequentialContentSpan = {
  id: string;
  startMs: number;
  endMs: number;
  kind: ConsequentialContentKind;
  /** Relative importance in aggregate metrics. Defaults to 1. */
  weight?: number;
  label?: string;
  /** SHA-256 of the normalized transcript/content used to align this span. */
  contentHash: string;
};

export type AudibilityEvidenceSource =
  | "provider_event"
  | "playback_queue"
  | "playback_clock"
  | "semantic_alignment"
  | "dependency_trace";

/** Reference to an immutable artifact verified by the adapter before reduction. */
export type AudibilityEvidenceReference = {
  source: AudibilityEvidenceSource;
  sha256: string;
  artifactId?: string;
};

export type ProviderHistoryObservation =
  | {
      status: "known";
      retainedThroughMs: number;
      basis: "observed";
    }
  | {
      status: "known";
      retainedThroughMs: number;
      basis: "documented_assumption";
      contractHash: string;
    }
  | {
      status: "unknown";
      reason: string;
    };

type AudibilityEventBase = {
  /** Contiguous sequence assigned by the session's trusted append-only sequencer. */
  sequence: number;
  /** Stable audit identifier. Sequence, rather than this id, is the retry high-water mark. */
  eventId: string;
  responseId: string;
  evidence: AudibilityEvidenceReference;
  /** Optional monotonic session offset for audit artifacts; never used to score. */
  observedAtMs?: number;
};

export type AudibilityEvent =
  | (AudibilityEventBase & {
      type: "generated";
      /** Total contiguous audio generated for the response. */
      throughMs: number;
      final?: boolean;
      /** Explicit because providers differ in when generated output enters history. */
      providerHistory: ProviderHistoryObservation;
    })
  | (AudibilityEventBase & {
      type: "queued";
      /** Total contiguous audio accepted by the playback queue. */
      throughMs: number;
    })
  | (AudibilityEventBase & {
      type: "played_through";
      /** Last contiguous audio boundary confirmed as played to the caller. */
      throughMs: number;
    })
  | (AudibilityEventBase & {
      type: "interrupted";
      /** Atomic final playback boundary captured when output is stopped. */
      playedThroughMs: number;
      reason?: string;
    })
  | (AudibilityEventBase & {
      type: "provider_history_repaired";
      /** Boundary the provider confirms remains in its assistant history. */
      retainedThroughMs: number;
      repairId: string;
    })
  | (AudibilityEventBase & {
      type: "provider_history_invalidated";
      invalidationId: string;
      reason: string;
    })
  | (AudibilityEventBase & {
      type: "consequential_content_marked";
      span: ConsequentialContentSpan;
    })
  | (AudibilityEventBase & {
      type: "consequential_annotation_completed";
      /** Audio boundary covered by the immutable annotation manifest. */
      annotatedThroughMs: number;
      spanCount: number;
    })
  | (AudibilityEventBase & {
      type: "unheard_content_dependency_recorded";
      spanId: string;
      consumerId: string;
      consumerKind: "state_transition" | "claim" | "action";
    })
  | (AudibilityEventBase & {
      type: "dependency_analysis_completed";
      dependencyCount: number;
      horizonId: string;
    });

export type AudibilityMilestone = {
  sequence: number;
  eventId: string;
  evidence: AudibilityEvidenceReference;
  observedAtMs?: number;
};

export type InterruptionRecord = AudibilityMilestone & {
  playedThroughMs: number;
  reason?: string;
  providerHistoryExposureThroughMs: number | null;
  providerHistoryExposureBasis: "observed" | "documented_assumption" | null;
  providerHistoryExposureUncertain: boolean;
  /** Null means the interruption lacked final observed annotation evidence. */
  materialUnheardSpanIds: string[] | null;
};

export type ProviderHistoryRepairRecord = AudibilityMilestone & {
  retainedThroughMs: number;
  repairId: string;
};

export type ProviderHistoryInvalidationRecord = AudibilityMilestone & {
  invalidationId: string;
  reason: string;
};

export type ConsequentialContentRecord = Required<Pick<ConsequentialContentSpan, "weight">>
  & ConsequentialContentSpan
  & { markedAt: AudibilityMilestone };

export type ConsequentialAnnotationRecord = AudibilityMilestone & {
  annotatedThroughMs: number;
  spanCount: number;
};

export type UnheardContentDependencyRecord = AudibilityMilestone & {
  spanId: string;
  consumerId: string;
  consumerKind: "state_transition" | "claim" | "action";
};

export type DependencyAnalysisRecord = AudibilityMilestone & {
  dependencyCount: number;
  horizonId: string;
};

export type AudibleResponseState = {
  responseId: string;
  revision: number;
  generation: AudibilityMilestone & {
    throughMs: number;
    final: boolean;
  };
  queue: (AudibilityMilestone & { throughMs: number }) | null;
  playback: {
    throughMs: number;
    lastProgress: AudibilityMilestone | null;
    interruption: InterruptionRecord | null;
  };
  providerHistory: {
    status: "known" | "unknown";
    throughMs: number | null;
    basis: "observed" | "documented_assumption" | null;
    contractHash: string | null;
    unknownReason: string | null;
    lastObservation: AudibilityMilestone;
    repairCount: number;
    lastRepair: ProviderHistoryRepairRecord | null;
    lastInvalidation: ProviderHistoryInvalidationRecord | null;
  };
  consequentialSpans: Record<string, ConsequentialContentRecord>;
  consequentialAnnotation: ConsequentialAnnotationRecord | null;
  unheardContentDependencies: UnheardContentDependencyRecord[];
  dependencyAnalysis: DependencyAnalysisRecord | null;
};

export type AudibilityState = {
  schemaVersion: typeof AUDIBILITY_STATE_SCHEMA_VERSION;
  revision: number;
  responses: Record<string, AudibleResponseState>;
  responseOrder: string[];
  /** Bounded retry high-water; authoritative payload hashes belong in the append-only event log. */
  lastAppliedEvent: {
    sequence: number;
    eventId: string;
    canonicalPayload: string;
  } | null;
  lastObservedAtMs: number | null;
};

export type AudibilityErrorCode =
  | "invalid_event"
  | "event_sequence_gap"
  | "event_sequence_conflict"
  | "unknown_response"
  | "generation_already_final"
  | "generation_not_monotonic"
  | "queue_exceeds_generated"
  | "queue_not_monotonic"
  | "playback_exceeds_queue"
  | "playback_not_monotonic"
  | "playback_already_interrupted"
  | "interruption_conflict"
  | "repair_exceeds_generated"
  | "span_exceeds_generated"
  | "span_id_conflict"
  | "annotation_already_completed"
  | "annotation_before_generation_final"
  | "annotation_boundary_mismatch"
  | "annotation_span_count_mismatch"
  | "dependency_without_scorable_interruption"
  | "dependency_without_unheard_content"
  | "dependency_id_conflict"
  | "dependency_analysis_already_completed"
  | "dependency_analysis_count_mismatch";

export type AudibilityApplyResult =
  | {
      ok: true;
      state: AudibilityState;
      applied: boolean;
      duplicate: boolean;
    }
  | {
      ok: false;
      state: AudibilityState;
      code: AudibilityErrorCode;
      error: string;
    };

export type AudibilityBatchResult =
  | Extract<AudibilityApplyResult, { ok: true }>
  | (Extract<AudibilityApplyResult, { ok: false }> & { eventIndex: number });

export type ConsequentialSpanScore = {
  id: string;
  kind: ConsequentialContentKind;
  weight: number;
  audibleFraction: number;
  providerRetainedFraction: number | null;
  unheardExposureFraction: number | null;
  omittedFraction: number | null;
  state: "unheard" | "partially_audible" | "fully_audible";
};

export type ResponseAudibilityScore = {
  responseId: string;
  generationFinal: boolean;
  generatedMs: number;
  queuedMs: number;
  playedMs: number;
  queuedButUnplayedMs: number;
  generatedButUnqueuedMs: number;
  providerHistoryStatus: "known" | "unknown";
  providerHistoryBasis: "observed" | "documented_assumption" | null;
  providerHistoryContractHash: string | null;
  providerHistoryMs: number | null;
  unheardAudioRetainedMs: number | null;
  heardAudioMissingFromHistoryMs: number | null;
  audioStateDivergenceMs: number | null;
  audioStateDivergenceRate: number | null;
  interrupted: boolean;
  providerHistoryRepaired: boolean;
  providerHistoryInvalidated: boolean;
  providerHistoryAligned: boolean | null;
  semanticMetricsAvailable: boolean;
  semanticMetricsEvidence: "observed" | "assumed" | "unavailable";
  consequentialAnnotationComplete: boolean;
  annotationEvidenceSha256: string | null;
  consequentialSpanCount: number;
  fullyAudibleConsequentialSpanCount: number;
  exposedConsequentialSpanCount: number | null;
  fullyUnheardExposedSpanCount: number | null;
  totalConsequenceWeight: number;
  exposedConsequenceWeight: number | null;
  divergentConsequenceWeight: number | null;
  /** Weighted provider-visible-but-not-audible semantic coverage. */
  unheardContentExposureRate: number | null;
  /** Weighted absolute semantic mismatch in either direction. */
  bidirectionalSemanticMismatchRate: number | null;
  /** Protocol ASD: currently unrepaired material provider-visible content. */
  audibleStateDiverged: boolean | null;
  materialUnheardContentAtInterruption: boolean | null;
  unheardContentDependencyCount: number;
  dependencyAnalysisComplete: boolean;
  dependencyAnalysisEvidenceSha256: string | null;
  dependencyAnalysisHorizonId: string | null;
  unheardContentLeaked: boolean | null;
  spans: ConsequentialSpanScore[];
};

export type AudibilityScore = {
  responseCount: number;
  terminalResponseCount: number;
  providerHistoryScorableResponseCount: number;
  observedProviderHistoryResponseCount: number;
  assumedProviderHistoryResponseCount: number;
  semanticScorableResponseCount: number;
  audibleStateDivergenceCheckpointCount: number | null;
  audibleStateDivergenceRate: number | null;
  interruptedResponseCount: number;
  alignedInterruptedResponseCount: number;
  divergedInterruptedResponseCount: number;
  pendingInterruptedResponseCount: number;
  unresolvedInterruptedResponseCount: number;
  generatedMs: number;
  queuedButUnplayedMs: number;
  audioStateDivergenceMs: number | null;
  audioStateDivergenceRate: number | null;
  consequentialSpanCount: number;
  exposedConsequentialSpanCount: number | null;
  fullyUnheardExposedSpanCount: number | null;
  totalConsequenceWeight: number;
  exposedConsequenceWeight: number | null;
  divergentConsequenceWeight: number | null;
  unheardContentExposureRate: number | null;
  bidirectionalSemanticMismatchRate: number | null;
  interruptionExposureScorableCount: number;
  interruptedMaterialExposureCount: number;
  unheardContentLeakageResponseCount: number;
  dependencyAnalysisHorizonIds: string[];
  unheardContentLeakageRate: number | null;
  responses: ResponseAudibilityScore[];
};

export type AudibilityScoreOptions = {
  /** Required to publish UCLR; prevents mixing unequal future-turn coverage. */
  expectedDependencyHorizonId?: string;
};

export type AudibleCommitRequest = {
  responseId: string;
  spanIds: string[];
};

export type AudibleCommitDecision =
  | {
      ok: true;
      evidence: {
        schemaVersion: typeof AUDIBILITY_STATE_SCHEMA_VERSION;
        stateRevision: number;
        responseRevision: number;
        responseId: string;
        spanIds: string[];
        spanEvidence: Array<{
          spanId: string;
          contentHash: string;
          alignmentEvidenceSha256: string;
        }>;
        annotationEvidenceSha256: string;
        playedThroughMs: number;
        providerHistoryThroughMs: number;
        generationEvidenceSha256: string;
        playbackEvidenceSha256: string;
        providerHistoryEvidenceSha256: string;
      };
    }
  | {
      ok: false;
      code:
        | "invalid_commit_request"
        | "unknown_response"
        | "empty_commit"
        | "generation_not_final"
        | "provider_history_unknown"
        | "provider_history_unobserved"
        | "annotation_incomplete"
        | "unknown_span"
        | "span_not_fully_audible"
        | "playback_evidence_missing"
        | "provider_history_diverged";
      error: string;
      spanId?: string;
    };

export function createAudibilityState(): AudibilityState {
  return {
    schemaVersion: AUDIBILITY_STATE_SCHEMA_VERSION,
    revision: 0,
    responses: {},
    responseOrder: [],
    lastAppliedEvent: null,
    lastObservedAtMs: null,
  };
}

function isFiniteSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
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

function invalid(
  state: AudibilityState,
  code: AudibilityErrorCode,
  error: string
): AudibilityApplyResult {
  return { ok: false, state, code, error };
}

const EVIDENCE_SOURCES = new Set<AudibilityEvidenceSource>([
  "provider_event",
  "playback_queue",
  "playback_clock",
  "semantic_alignment",
  "dependency_trace",
]);

const CONTENT_KINDS = new Set<ConsequentialContentKind>([
  "authorization",
  "commitment",
  "instruction",
  "policy",
  "safety_boundary",
  "state_change",
  "tool_result",
  "other",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function parseEvidence(value: unknown): value is AudibilityEvidenceReference {
  if (!isRecord(value)) return false;
  return (
    typeof value.source === "string"
    && EVIDENCE_SOURCES.has(value.source as AudibilityEvidenceSource)
    && typeof value.sha256 === "string"
    && SHA256_PATTERN.test(value.sha256)
    && (value.artifactId === undefined || isNonEmptyId(value.artifactId))
  );
}

function parseEvent(
  state: AudibilityState,
  input: unknown
): { ok: true; event: AudibilityEvent } | { ok: false; result: AudibilityApplyResult } {
  if (!isRecord(input)) {
    return { ok: false, result: invalid(state, "invalid_event", "audibility event must be an object") };
  }
  if (
    !isFiniteSafeInteger(input.sequence, 1)
    || !isNonEmptyId(input.eventId)
    || !isNonEmptyId(input.responseId)
    || !parseEvidence(input.evidence)
  ) {
    return {
      ok: false,
      result: invalid(
        state,
        "invalid_event",
        "event requires a positive sequence, valid ids, and a SHA-256 evidence reference"
      ),
    };
  }
  if (input.observedAtMs !== undefined && !isFiniteSafeInteger(input.observedAtMs)) {
    return { ok: false, result: invalid(state, "invalid_event", "observedAtMs must be a non-negative safe integer") };
  }
  if (input.type === "generated") {
    if (
      !isFiniteSafeInteger(input.throughMs, 1)
      || (input.final !== undefined && typeof input.final !== "boolean")
      || !isRecord(input.providerHistory)
      || (input.evidence as AudibilityEvidenceReference).source !== "provider_event"
    ) {
      return { ok: false, result: invalid(state, "invalid_event", "generated event is malformed") };
    }
    const history = input.providerHistory;
    if (history.status === "known") {
      if (
        !isFiniteSafeInteger(history.retainedThroughMs)
        || history.retainedThroughMs > input.throughMs
        || (history.basis !== "observed" && history.basis !== "documented_assumption")
      ) {
        return { ok: false, result: invalid(state, "invalid_event", "known provider history is malformed") };
      }
      if (
        history.basis === "documented_assumption"
        && (typeof history.contractHash !== "string" || !SHA256_PATTERN.test(history.contractHash))
      ) {
        return {
          ok: false,
          result: invalid(state, "invalid_event", "documented provider-history assumption requires a contract hash"),
        };
      }
    } else if (history.status === "unknown") {
      if (!isNonEmptyId(history.reason)) {
        return { ok: false, result: invalid(state, "invalid_event", "unknown provider history requires a reason") };
      }
    } else {
      return { ok: false, result: invalid(state, "invalid_event", "provider history status must be known or unknown") };
    }
  } else if (input.type === "queued") {
    if (!isFiniteSafeInteger(input.throughMs) || (input.evidence as AudibilityEvidenceReference).source !== "playback_queue") {
      return { ok: false, result: invalid(state, "invalid_event", "queued event requires playback_queue evidence") };
    }
  } else if (input.type === "played_through") {
    if (!isFiniteSafeInteger(input.throughMs) || (input.evidence as AudibilityEvidenceReference).source !== "playback_clock") {
      return { ok: false, result: invalid(state, "invalid_event", "played event requires playback_clock evidence") };
    }
  } else if (input.type === "interrupted") {
    if (
      !isFiniteSafeInteger(input.playedThroughMs)
      || (input.reason !== undefined && typeof input.reason !== "string")
      || (input.evidence as AudibilityEvidenceReference).source !== "playback_clock"
    ) {
      return { ok: false, result: invalid(state, "invalid_event", "interruption requires playback_clock evidence") };
    }
  } else if (input.type === "provider_history_repaired") {
    if (
      !isFiniteSafeInteger(input.retainedThroughMs)
      || !isNonEmptyId(input.repairId)
      || (input.evidence as AudibilityEvidenceReference).source !== "provider_event"
    ) {
      return { ok: false, result: invalid(state, "invalid_event", "history repair requires provider acknowledgment evidence") };
    }
  } else if (input.type === "provider_history_invalidated") {
    if (
      !isNonEmptyId(input.invalidationId)
      || !isNonEmptyId(input.reason)
      || (input.evidence as AudibilityEvidenceReference).source !== "provider_event"
    ) {
      return { ok: false, result: invalid(state, "invalid_event", "history invalidation requires provider evidence and reason") };
    }
  } else if (input.type === "consequential_content_marked") {
    if (!isRecord(input.span) || (input.evidence as AudibilityEvidenceReference).source !== "semantic_alignment") {
      return { ok: false, result: invalid(state, "invalid_event", "consequential span requires semantic_alignment evidence") };
    }
    const span = input.span;
    if (
      !isNonEmptyId(span.id)
      || !isFiniteSafeInteger(span.startMs)
      || !isFiniteSafeInteger(span.endMs, 1)
      || span.endMs <= span.startMs
      || typeof span.kind !== "string"
      || !CONTENT_KINDS.has(span.kind as ConsequentialContentKind)
      || (
        span.weight !== undefined
        && (
          !Number.isFinite(span.weight)
          || (span.weight as number) <= 0
          || (span.weight as number) > MAX_CONSEQUENTIAL_WEIGHT
        )
      )
      || (span.label !== undefined && typeof span.label !== "string")
      || typeof span.contentHash !== "string"
      || !SHA256_PATTERN.test(span.contentHash)
    ) {
      return { ok: false, result: invalid(state, "invalid_event", "consequential span is malformed") };
    }
  } else if (input.type === "consequential_annotation_completed") {
    if (
      !isFiniteSafeInteger(input.annotatedThroughMs, 1)
      || !isFiniteSafeInteger(input.spanCount)
      || (input.evidence as AudibilityEvidenceReference).source !== "semantic_alignment"
    ) {
      return {
        ok: false,
        result: invalid(state, "invalid_event", "annotation completion requires a covered boundary, span count, and evidence"),
      };
    }
  } else if (input.type === "unheard_content_dependency_recorded") {
    if (
      !isNonEmptyId(input.spanId)
      || !isNonEmptyId(input.consumerId)
      || !["state_transition", "claim", "action"].includes(input.consumerKind as string)
      || (input.evidence as AudibilityEvidenceReference).source !== "dependency_trace"
    ) {
      return {
        ok: false,
        result: invalid(state, "invalid_event", "unheard-content dependency requires a valid consumer and trace evidence"),
      };
    }
  } else if (input.type === "dependency_analysis_completed") {
    if (
      !isFiniteSafeInteger(input.dependencyCount)
      || !isNonEmptyId(input.horizonId)
      || (input.evidence as AudibilityEvidenceReference).source !== "dependency_trace"
    ) {
      return {
        ok: false,
        result: invalid(state, "invalid_event", "dependency analysis requires count, horizon, and trace evidence"),
      };
    }
  } else {
    return { ok: false, result: invalid(state, "invalid_event", "unknown audibility event type") };
  }

  return { ok: true, event: input as unknown as AudibilityEvent };
}

function milestone(event: AudibilityEvent): AudibilityMilestone {
  return event.observedAtMs === undefined
    ? { sequence: event.sequence, eventId: event.eventId, evidence: event.evidence }
    : {
        sequence: event.sequence,
        eventId: event.eventId,
        evidence: event.evidence,
        observedAtMs: event.observedAtMs,
      };
}

function responseFor(state: AudibilityState, responseId: string): AudibleResponseState | null {
  return hasOwn(state.responses, responseId) ? state.responses[responseId] : null;
}

function applyResponse(
  state: AudibilityState,
  event: AudibilityEvent,
  response: AudibleResponseState,
  isNewResponse = false
): AudibilityApplyResult {
  const nextRevision = state.revision + 1;
  const canonicalEvent = safeCanonicalize(event);
  if (canonicalEvent === null) {
    return invalid(state, "invalid_event", "audibility event must be canonically serializable");
  }
  return {
    ok: true,
    applied: true,
    duplicate: false,
    state: {
      ...state,
      revision: nextRevision,
      responses: {
        ...state.responses,
        [response.responseId]: { ...response, revision: nextRevision },
      },
      responseOrder: isNewResponse ? [...state.responseOrder, response.responseId] : state.responseOrder,
      lastAppliedEvent: {
        sequence: event.sequence,
        eventId: event.eventId,
        canonicalPayload: canonicalEvent,
      },
      lastObservedAtMs: event.observedAtMs ?? state.lastObservedAtMs,
    },
  };
}

/**
 * Apply one normalized audibility event without mutating the input state.
 * Sequence is a bounded-memory retry high-water. The upstream append-only log
 * must authenticate historical payloads; this reducer verifies the latest one.
 */
export function applyAudibilityEvent(state: AudibilityState, input: unknown): AudibilityApplyResult {
  const parsed = parseEvent(state, input);
  if (!parsed.ok) return parsed.result;
  const event = parsed.event;
  const canonicalEvent = safeCanonicalize(event);
  if (canonicalEvent === null) {
    return invalid(state, "invalid_event", "audibility event must be canonically serializable");
  }
  if (event.sequence <= state.revision) {
    if (
      event.sequence === state.lastAppliedEvent?.sequence
      && (
        event.eventId !== state.lastAppliedEvent.eventId
        || canonicalEvent !== state.lastAppliedEvent.canonicalPayload
      )
    ) {
      return invalid(
        state,
        "event_sequence_conflict",
        `sequence ${event.sequence} conflicts with the latest applied event`
      );
    }
    return { ok: true, state, applied: false, duplicate: true };
  }
  if (event.sequence !== state.revision + 1) {
    return invalid(
      state,
      "event_sequence_gap",
      `expected event sequence ${state.revision + 1}, received ${event.sequence}`
    );
  }
  if (
    event.observedAtMs !== undefined
    && state.lastObservedAtMs !== null
    && event.observedAtMs < state.lastObservedAtMs
  ) {
    return invalid(state, "invalid_event", "observedAtMs cannot move backwards");
  }

  const current = responseFor(state, event.responseId);

  if (event.type === "generated") {
    if (!isFiniteSafeInteger(event.throughMs, 1)) {
      return invalid(state, "invalid_event", "generated throughMs must be a positive safe integer");
    }
    if (!current) {
      const created: AudibleResponseState = {
        responseId: event.responseId,
        revision: state.revision,
        generation: { ...milestone(event), throughMs: event.throughMs, final: event.final === true },
        queue: null,
        playback: { throughMs: 0, lastProgress: null, interruption: null },
        providerHistory: event.providerHistory.status === "known"
          ? {
              status: "known",
              throughMs: event.providerHistory.retainedThroughMs,
              basis: event.providerHistory.basis,
              contractHash: event.providerHistory.basis === "documented_assumption"
                ? event.providerHistory.contractHash
                : null,
              unknownReason: null,
              lastObservation: milestone(event),
              repairCount: 0,
              lastRepair: null,
              lastInvalidation: null,
            }
          : {
              status: "unknown",
              throughMs: null,
              basis: null,
              contractHash: null,
              unknownReason: event.providerHistory.reason,
              lastObservation: milestone(event),
              repairCount: 0,
              lastRepair: null,
              lastInvalidation: null,
            },
        consequentialSpans: {},
        consequentialAnnotation: null,
        unheardContentDependencies: [],
        dependencyAnalysis: null,
      };
      return applyResponse(state, event, created, true);
    }
    if (event.throughMs < current.generation.throughMs) {
      return invalid(state, "generation_not_monotonic", "generated audio cannot move backwards");
    }
    if (current.generation.final) {
      return invalid(
        state,
        "generation_already_final",
        "all generated events are rejected after finalization; use provider_history_repaired for history changes"
      );
    }
    const generationGrew = event.throughMs > current.generation.throughMs;
    const priorInterruption = current.playback.interruption;
    let exposureThroughMs = priorInterruption?.providerHistoryExposureThroughMs ?? null;
    let exposureBasis = priorInterruption?.providerHistoryExposureBasis ?? null;
    let exposureUncertain = priorInterruption?.providerHistoryExposureUncertain ?? false;
    if (priorInterruption) {
      if (event.providerHistory.status === "unknown") {
        exposureThroughMs = null;
        exposureBasis = null;
        exposureUncertain = true;
      } else if (
        exposureThroughMs === null
        || event.providerHistory.retainedThroughMs > exposureThroughMs
      ) {
        exposureThroughMs = event.providerHistory.retainedThroughMs;
        exposureBasis = event.providerHistory.basis;
      } else if (event.providerHistory.retainedThroughMs === exposureThroughMs) {
        exposureBasis =
          exposureBasis === "observed" || event.providerHistory.basis === "observed"
            ? "observed"
            : "documented_assumption";
      }
    }
    const updatedPlayback = priorInterruption
      ? {
          ...current.playback,
          interruption: {
            ...priorInterruption,
            providerHistoryExposureThroughMs: exposureThroughMs,
            providerHistoryExposureBasis: exposureBasis,
            providerHistoryExposureUncertain: exposureUncertain,
            materialUnheardSpanIds: null,
          },
        }
      : current.playback;
    return applyResponse(state, event, {
      ...current,
      generation: {
        ...milestone(event),
        throughMs: event.throughMs,
        final: current.generation.final || event.final === true,
      },
      providerHistory: event.providerHistory.status === "known"
        ? {
            ...current.providerHistory,
            status: "known",
            throughMs: event.providerHistory.retainedThroughMs,
            basis: event.providerHistory.basis,
            contractHash: event.providerHistory.basis === "documented_assumption"
              ? event.providerHistory.contractHash
              : null,
            unknownReason: null,
            lastObservation: milestone(event),
          }
        : {
            ...current.providerHistory,
            status: "unknown",
            throughMs: null,
            basis: null,
            contractHash: null,
            unknownReason: event.providerHistory.reason,
            lastObservation: milestone(event),
          },
      consequentialAnnotation: generationGrew ? null : current.consequentialAnnotation,
      playback: updatedPlayback,
    });
  }

  if (!current) {
    return invalid(state, "unknown_response", `response "${event.responseId}" must be generated before ${event.type}`);
  }

  if (event.type === "queued") {
    if (!isFiniteSafeInteger(event.throughMs)) {
      return invalid(state, "invalid_event", "queued throughMs must be a non-negative safe integer");
    }
    if (event.throughMs > current.generation.throughMs) {
      return invalid(state, "queue_exceeds_generated", "queued audio cannot exceed generated audio");
    }
    if (event.throughMs < (current.queue?.throughMs ?? 0)) {
      return invalid(state, "queue_not_monotonic", "queued audio cannot move backwards");
    }
    return applyResponse(state, event, {
      ...current,
      queue: { ...milestone(event), throughMs: event.throughMs },
    });
  }

  if (event.type === "played_through") {
    if (!isFiniteSafeInteger(event.throughMs)) {
      return invalid(state, "invalid_event", "played throughMs must be a non-negative safe integer");
    }
    if (event.throughMs > (current.queue?.throughMs ?? 0)) {
      return invalid(state, "playback_exceeds_queue", "played audio cannot exceed queued audio");
    }
    if (event.throughMs < current.playback.throughMs) {
      return invalid(state, "playback_not_monotonic", "played audio cannot move backwards");
    }
    if (current.playback.interruption && event.throughMs > current.playback.throughMs) {
      return invalid(state, "playback_already_interrupted", "played audio cannot advance after interruption");
    }
    return applyResponse(state, event, {
      ...current,
      playback: {
        ...current.playback,
        throughMs: event.throughMs,
        lastProgress: milestone(event),
      },
    });
  }

  if (event.type === "interrupted") {
    if (!isFiniteSafeInteger(event.playedThroughMs)) {
      return invalid(state, "invalid_event", "interrupted playedThroughMs must be a non-negative safe integer");
    }
    if (event.playedThroughMs > (current.queue?.throughMs ?? 0)) {
      return invalid(state, "playback_exceeds_queue", "interruption playback cannot exceed queued audio");
    }
    if (event.playedThroughMs < current.playback.throughMs) {
      return invalid(state, "playback_not_monotonic", "interruption playback cannot move backwards");
    }
    if (current.playback.interruption) {
      return invalid(state, "interruption_conflict", `response "${event.responseId}" was already interrupted`);
    }
    const providerThroughMs = current.providerHistory.throughMs;
    const materialUnheardSpanIds =
      current.generation.final
      && current.consequentialAnnotation !== null
      && current.providerHistory.basis === "observed"
      && providerThroughMs !== null
        ? Object.values(current.consequentialSpans)
            .filter((span) => (
              prefixCoverage(span.startMs, span.endMs, providerThroughMs)
              > prefixCoverage(span.startMs, span.endMs, event.playedThroughMs)
            ))
            .map((span) => span.id)
            .sort()
        : null;
    const interruption: InterruptionRecord = {
      ...milestone(event),
      playedThroughMs: event.playedThroughMs,
      providerHistoryExposureThroughMs: providerThroughMs,
      providerHistoryExposureBasis: current.providerHistory.basis,
      providerHistoryExposureUncertain: current.providerHistory.status === "unknown",
      materialUnheardSpanIds,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
    return applyResponse(state, event, {
      ...current,
      playback: {
        throughMs: event.playedThroughMs,
        lastProgress: milestone(event),
        interruption,
      },
    });
  }

  if (event.type === "provider_history_repaired") {
    if (!isFiniteSafeInteger(event.retainedThroughMs)) {
      return invalid(state, "invalid_event", "retainedThroughMs must be a non-negative safe integer");
    }
    if (event.retainedThroughMs > current.generation.throughMs) {
      return invalid(state, "repair_exceeds_generated", "provider history cannot retain beyond generated audio");
    }
    const lastRepair: ProviderHistoryRepairRecord = {
      ...milestone(event),
      retainedThroughMs: event.retainedThroughMs,
      repairId: event.repairId,
    };
    return applyResponse(state, event, {
      ...current,
      providerHistory: {
        status: "known",
        throughMs: event.retainedThroughMs,
        basis: "observed",
        contractHash: null,
        unknownReason: null,
        lastObservation: milestone(event),
        repairCount: current.providerHistory.repairCount + 1,
        lastRepair,
        lastInvalidation: current.providerHistory.lastInvalidation,
      },
    });
  }

  if (event.type === "provider_history_invalidated") {
    const lastInvalidation: ProviderHistoryInvalidationRecord = {
      ...milestone(event),
      invalidationId: event.invalidationId,
      reason: event.reason,
    };
    return applyResponse(state, event, {
      ...current,
      providerHistory: {
        ...current.providerHistory,
        status: "unknown",
        throughMs: null,
        basis: null,
        contractHash: null,
        unknownReason: event.reason,
        lastObservation: milestone(event),
        lastInvalidation,
      },
    });
  }

  if (event.type === "consequential_content_marked") {
    const { span } = event;
    if (current.consequentialAnnotation) {
      return invalid(
        state,
        "annotation_already_completed",
        "consequential spans cannot change after the annotation manifest is completed"
      );
    }
    if (
      !isNonEmptyId(span.id)
      || !isFiniteSafeInteger(span.startMs)
      || !isFiniteSafeInteger(span.endMs, 1)
      || span.endMs <= span.startMs
      || (
        span.weight !== undefined
        && (!Number.isFinite(span.weight) || span.weight <= 0 || span.weight > MAX_CONSEQUENTIAL_WEIGHT)
      )
    ) {
      return invalid(
        state,
        "invalid_event",
        `consequential span requires a valid id, positive duration, and weight in (0, ${MAX_CONSEQUENTIAL_WEIGHT}]`
      );
    }
    if (span.endMs > current.generation.throughMs) {
      return invalid(state, "span_exceeds_generated", "consequential content cannot extend beyond generated audio");
    }
    if (hasOwn(current.consequentialSpans, span.id)) {
      return invalid(state, "span_id_conflict", `span id "${span.id}" already exists on response "${event.responseId}"`);
    }
    return applyResponse(state, event, {
      ...current,
      consequentialSpans: {
        ...current.consequentialSpans,
        [span.id]: { ...span, weight: span.weight ?? 1, markedAt: milestone(event) },
      },
    });
  }

  if (event.type === "consequential_annotation_completed") {
    if (current.consequentialAnnotation) {
      return invalid(state, "annotation_already_completed", "consequential annotation is already complete");
    }
    if (!current.generation.final) {
      return invalid(
        state,
        "annotation_before_generation_final",
        "consequential annotation cannot complete before generation is final"
      );
    }
    if (event.annotatedThroughMs !== current.generation.throughMs) {
      return invalid(
        state,
        "annotation_boundary_mismatch",
        "annotation boundary must equal the current generated audio boundary"
      );
    }
    const actualSpanCount = Object.keys(current.consequentialSpans).length;
    if (event.spanCount !== actualSpanCount) {
      return invalid(
        state,
        "annotation_span_count_mismatch",
        `annotation declared ${event.spanCount} spans but ${actualSpanCount} are registered`
      );
    }
    const annotation: ConsequentialAnnotationRecord = {
      ...milestone(event),
      annotatedThroughMs: event.annotatedThroughMs,
      spanCount: event.spanCount,
    };
    const interruption = current.playback.interruption;
    const materialUnheardSpanIds =
      interruption
      && !interruption.providerHistoryExposureUncertain
      && interruption.providerHistoryExposureBasis === "observed"
      && interruption.providerHistoryExposureThroughMs !== null
        ? Object.values(current.consequentialSpans)
            .filter((span) => (
              prefixCoverage(span.startMs, span.endMs, interruption.providerHistoryExposureThroughMs as number)
              > prefixCoverage(span.startMs, span.endMs, interruption.playedThroughMs)
            ))
            .map((span) => span.id)
            .sort()
        : null;
    return applyResponse(state, event, {
      ...current,
      consequentialAnnotation: annotation,
      playback: interruption
        ? {
            ...current.playback,
            interruption: { ...interruption, materialUnheardSpanIds },
          }
        : current.playback,
    });
  }

  if (event.type === "unheard_content_dependency_recorded") {
    if (current.dependencyAnalysis) {
      return invalid(
        state,
        "dependency_analysis_already_completed",
        "dependency records cannot change after analysis completion"
      );
    }
    const materialSpanIds = current.playback.interruption?.materialUnheardSpanIds ?? null;
    if (materialSpanIds === null) {
      return invalid(
        state,
        "dependency_without_scorable_interruption",
        "dependency requires an interrupted response with final observed annotation evidence"
      );
    }
    if (!materialSpanIds.includes(event.spanId)) {
      return invalid(
        state,
        "dependency_without_unheard_content",
        `span "${event.spanId}" was not material unheard content at interruption`
      );
    }
    if (
      current.unheardContentDependencies.some(
        (dependency) => dependency.consumerId === event.consumerId && dependency.spanId === event.spanId
      )
    ) {
      return invalid(
        state,
        "dependency_id_conflict",
        `consumer "${event.consumerId}" already depends on span "${event.spanId}"`
      );
    }
    return applyResponse(state, event, {
      ...current,
      unheardContentDependencies: [
        ...current.unheardContentDependencies,
        {
          ...milestone(event),
          spanId: event.spanId,
          consumerId: event.consumerId,
          consumerKind: event.consumerKind,
        },
      ],
    });
  }

  if (event.type === "dependency_analysis_completed") {
    if (current.dependencyAnalysis) {
      return invalid(state, "dependency_analysis_already_completed", "dependency analysis is already complete");
    }
    const materialSpanIds = current.playback.interruption?.materialUnheardSpanIds ?? null;
    if (materialSpanIds === null || materialSpanIds.length === 0) {
      return invalid(
        state,
        "dependency_without_scorable_interruption",
        "dependency analysis can complete only after a scorable material-unheard interruption"
      );
    }
    if (event.dependencyCount !== current.unheardContentDependencies.length) {
      return invalid(
        state,
        "dependency_analysis_count_mismatch",
        `analysis declared ${event.dependencyCount} dependencies but ${current.unheardContentDependencies.length} are registered`
      );
    }
    return applyResponse(state, event, {
      ...current,
      dependencyAnalysis: {
        ...milestone(event),
        dependencyCount: event.dependencyCount,
        horizonId: event.horizonId,
      },
    });
  }

  return invalid(state, "invalid_event", "unknown audibility event type");
}

/** Apply a sequence atomically from the caller's perspective, stopping at the first invalid event. */
export function applyAudibilityEvents(
  initialState: AudibilityState,
  events: readonly unknown[]
): AudibilityBatchResult {
  let state = initialState;
  let applied = false;
  let duplicate = false;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const result = applyAudibilityEvent(state, events[eventIndex]);
    if (!result.ok) return { ...result, state: initialState, eventIndex };
    state = result.state;
    applied ||= result.applied;
    duplicate ||= result.duplicate;
  }
  return { ok: true, state, applied, duplicate };
}

function prefixCoverage(startMs: number, endMs: number, throughMs: number): number {
  return Math.max(0, Math.min(endMs, throughMs) - startMs) / (endMs - startMs);
}

export function scoreConsequentialSpan(
  response: AudibleResponseState,
  span: AudibleResponseState["consequentialSpans"][string]
): ConsequentialSpanScore {
  const audibleFraction = prefixCoverage(span.startMs, span.endMs, response.playback.throughMs);
  const providerRetainedFraction = response.providerHistory.throughMs === null
    ? null
    : prefixCoverage(span.startMs, span.endMs, response.providerHistory.throughMs);
  return {
    id: span.id,
    kind: span.kind,
    weight: span.weight,
    audibleFraction,
    providerRetainedFraction,
    unheardExposureFraction: providerRetainedFraction === null
      ? null
      : Math.max(0, providerRetainedFraction - audibleFraction),
    omittedFraction: providerRetainedFraction === null
      ? null
      : Math.max(0, audibleFraction - providerRetainedFraction),
    state:
      audibleFraction === 0
        ? "unheard"
        : audibleFraction === 1
          ? "fully_audible"
          : "partially_audible",
  };
}

/**
 * Score one response from exact audio and provider-history boundaries.
 * Semantic rates are `null` until provider retention is known and an annotation
 * manifest covers the response. A completed manifest with zero spans scores 0,
 * distinguishing "reviewed, none" from "not annotated."
 */
export function scoreResponseAudibility(response: AudibleResponseState): ResponseAudibilityScore {
  const generatedMs = response.generation.throughMs;
  const queuedMs = response.queue?.throughMs ?? 0;
  const playedMs = response.playback.throughMs;
  const providerHistoryMs = response.providerHistory.throughMs;
  const unheardAudioRetainedMs = providerHistoryMs === null ? null : Math.max(0, providerHistoryMs - playedMs);
  const heardAudioMissingFromHistoryMs = providerHistoryMs === null ? null : Math.max(0, playedMs - providerHistoryMs);
  const audioStateDivergenceMs =
    unheardAudioRetainedMs === null || heardAudioMissingFromHistoryMs === null
      ? null
      : unheardAudioRetainedMs + heardAudioMissingFromHistoryMs;
  const spans = Object.values(response.consequentialSpans)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id))
    .map((span) => scoreConsequentialSpan(response, span));
  const totalConsequenceWeight = spans.reduce((total, span) => total + span.weight, 0);
  const semanticMetricsAvailable = providerHistoryMs !== null && response.consequentialAnnotation !== null;
  const exposedConsequenceWeight = semanticMetricsAvailable
    ? spans.reduce((total, span) => total + span.weight * (span.unheardExposureFraction ?? 0), 0)
    : null;
  const divergentConsequenceWeight = semanticMetricsAvailable
    ? spans.reduce(
        (total, span) => total + span.weight * Math.abs((span.providerRetainedFraction ?? 0) - span.audibleFraction),
        0
      )
    : null;
  const protocolSemanticScorable =
    response.generation.final
    && response.providerHistory.basis === "observed"
    && response.consequentialAnnotation !== null;
  const audibleStateDiverged = protocolSemanticScorable && exposedConsequenceWeight !== null
    ? exposedConsequenceWeight > 0
    : null;
  const materialSpanIds = response.playback.interruption?.materialUnheardSpanIds ?? null;
  const materialUnheardContentAtInterruption = response.playback.interruption === null
    ? null
    : materialSpanIds === null
      ? null
      : materialSpanIds.length > 0;
  const unheardContentDependencyCount = response.unheardContentDependencies.length;
  const unheardContentLeaked = materialUnheardContentAtInterruption === true
    && response.dependencyAnalysis !== null
      ? unheardContentDependencyCount > 0
      : null;

  return {
    responseId: response.responseId,
    generationFinal: response.generation.final,
    generatedMs,
    queuedMs,
    playedMs,
    queuedButUnplayedMs: Math.max(0, queuedMs - playedMs),
    generatedButUnqueuedMs: Math.max(0, generatedMs - queuedMs),
    providerHistoryStatus: response.providerHistory.status,
    providerHistoryBasis: response.providerHistory.basis,
    providerHistoryContractHash: response.providerHistory.contractHash,
    providerHistoryMs,
    unheardAudioRetainedMs,
    heardAudioMissingFromHistoryMs,
    audioStateDivergenceMs,
    audioStateDivergenceRate: audioStateDivergenceMs === null ? null : audioStateDivergenceMs / generatedMs,
    interrupted: response.playback.interruption !== null,
    providerHistoryRepaired: response.providerHistory.lastRepair !== null,
    providerHistoryInvalidated: response.providerHistory.lastInvalidation !== null,
    providerHistoryAligned: providerHistoryMs === null ? null : providerHistoryMs === playedMs,
    semanticMetricsAvailable,
    semanticMetricsEvidence: !semanticMetricsAvailable
      ? "unavailable"
      : response.providerHistory.basis === "observed"
        ? "observed"
        : "assumed",
    consequentialAnnotationComplete: response.consequentialAnnotation !== null,
    annotationEvidenceSha256: response.consequentialAnnotation?.evidence.sha256 ?? null,
    consequentialSpanCount: spans.length,
    fullyAudibleConsequentialSpanCount: spans.filter((span) => span.state === "fully_audible").length,
    exposedConsequentialSpanCount: semanticMetricsAvailable
      ? spans.filter((span) => (span.unheardExposureFraction ?? 0) > 0).length
      : null,
    fullyUnheardExposedSpanCount: semanticMetricsAvailable
      ? spans.filter(
          (span) => span.audibleFraction === 0 && (span.providerRetainedFraction ?? 0) > 0
        ).length
      : null,
    totalConsequenceWeight,
    exposedConsequenceWeight,
    divergentConsequenceWeight,
    unheardContentExposureRate: exposedConsequenceWeight === null
      ? null
      : totalConsequenceWeight === 0
        ? 0
        : exposedConsequenceWeight / totalConsequenceWeight,
    bidirectionalSemanticMismatchRate: divergentConsequenceWeight === null
      ? null
      : totalConsequenceWeight === 0
        ? 0
        : divergentConsequenceWeight / totalConsequenceWeight,
    audibleStateDiverged,
    materialUnheardContentAtInterruption,
    unheardContentDependencyCount,
    dependencyAnalysisComplete: response.dependencyAnalysis !== null,
    dependencyAnalysisEvidenceSha256: response.dependencyAnalysis?.evidence.sha256 ?? null,
    dependencyAnalysisHorizonId: response.dependencyAnalysis?.horizonId ?? null,
    unheardContentLeaked,
    spans,
  };
}

/**
 * Aggregate benchmark-ready scores in stable response order. Headline rates
 * are `null` if any response lacks the evidence needed for that rate; the
 * scorable-response counters expose coverage rather than silently dropping it.
 */
export function scoreAudibility(
  state: AudibilityState,
  options: AudibilityScoreOptions = {}
): AudibilityScore {
  const responses = state.responseOrder.map((responseId) => scoreResponseAudibility(state.responses[responseId]));
  const generatedMs = responses.reduce((total, response) => total + response.generatedMs, 0);
  const terminalResponseCount = responses.filter((response) => response.generationFinal).length;
  const providerHistoryScorableResponseCount = responses.filter(
    (response) => (
      response.generationFinal
      && response.providerHistoryBasis === "observed"
      && response.audioStateDivergenceMs !== null
    )
  ).length;
  const semanticScorableResponseCount = responses.filter(
    (response) => response.semanticMetricsEvidence === "observed"
  ).length;
  const observedProviderHistoryResponseCount = responses.filter(
    (response) => response.providerHistoryBasis === "observed"
  ).length;
  const assumedProviderHistoryResponseCount = responses.filter(
    (response) => response.providerHistoryBasis === "documented_assumption"
  ).length;
  const allAudioScorable = responses.length > 0 && providerHistoryScorableResponseCount === responses.length;
  const allSemanticScorable = responses.length > 0 && semanticScorableResponseCount === responses.length;
  const audioStateDivergenceMs = allAudioScorable
    ? responses.reduce((total, response) => total + (response.audioStateDivergenceMs ?? 0), 0)
    : null;
  const totalConsequenceWeight = responses.reduce(
    (total, response) => total + response.totalConsequenceWeight,
    0
  );
  const exposedConsequenceWeight = allSemanticScorable
    ? responses.reduce((total, response) => total + (response.exposedConsequenceWeight ?? 0), 0)
    : null;
  const divergentConsequenceWeight = allSemanticScorable
    ? responses.reduce((total, response) => total + (response.divergentConsequenceWeight ?? 0), 0)
    : null;
  const interrupted = responses.filter((response) => response.interrupted);
  const resolvedInterrupted = interrupted.filter(
    (response) => response.generationFinal && response.providerHistoryBasis === "observed"
  );
  const alignedInterruptedResponseCount = interrupted.filter(
    (response) => (
      response.generationFinal
      && response.providerHistoryBasis === "observed"
      && response.providerHistoryAligned
    )
  ).length;
  const divergedInterruptedResponseCount = resolvedInterrupted.filter(
    (response) => response.providerHistoryAligned === false
  ).length;
  const pendingInterruptedResponseCount = interrupted.length - resolvedInterrupted.length;
  const audibleStateDivergenceCheckpointCount = allSemanticScorable
    ? responses.filter((response) => response.audibleStateDiverged).length
    : null;
  const interruptionExposureScorableCount = interrupted.filter(
    (response) => response.materialUnheardContentAtInterruption !== null
  ).length;
  const interruptedMaterialExposureCount = interrupted.filter(
    (response) => response.materialUnheardContentAtInterruption === true
  ).length;
  const exposedResponses = interrupted.filter(
    (response) => response.materialUnheardContentAtInterruption === true
  );
  const dependencyAnalysisComplete = exposedResponses.every(
    (response) => response.dependencyAnalysisComplete
  );
  const unheardContentLeakageResponseCount = exposedResponses.filter(
    (response) => response.unheardContentLeaked === true
  ).length;
  const dependencyAnalysisHorizonIds = [...new Set(
    exposedResponses
      .map((response) => response.dependencyAnalysisHorizonId)
      .filter((horizonId): horizonId is string => horizonId !== null)
  )].sort();
  const expectedHorizonMatches =
    options.expectedDependencyHorizonId !== undefined
    && exposedResponses.every(
      (response) => response.dependencyAnalysisHorizonId === options.expectedDependencyHorizonId
    );
  const uclrScorable =
    interruptionExposureScorableCount === interrupted.length
    && dependencyAnalysisComplete
    && expectedHorizonMatches;

  return {
    responseCount: responses.length,
    terminalResponseCount,
    providerHistoryScorableResponseCount,
    observedProviderHistoryResponseCount,
    assumedProviderHistoryResponseCount,
    semanticScorableResponseCount,
    audibleStateDivergenceCheckpointCount,
    audibleStateDivergenceRate:
      audibleStateDivergenceCheckpointCount === null || responses.length === 0
        ? null
        : audibleStateDivergenceCheckpointCount / responses.length,
    interruptedResponseCount: interrupted.length,
    alignedInterruptedResponseCount,
    divergedInterruptedResponseCount,
    pendingInterruptedResponseCount,
    unresolvedInterruptedResponseCount: interrupted.length - alignedInterruptedResponseCount,
    generatedMs,
    queuedButUnplayedMs: responses.reduce((total, response) => total + response.queuedButUnplayedMs, 0),
    audioStateDivergenceMs,
    audioStateDivergenceRate: audioStateDivergenceMs === null || generatedMs === 0
      ? null
      : audioStateDivergenceMs / generatedMs,
    consequentialSpanCount: responses.reduce(
      (total, response) => total + response.consequentialSpanCount,
      0
    ),
    exposedConsequentialSpanCount: allSemanticScorable
      ? responses.reduce((total, response) => total + (response.exposedConsequentialSpanCount ?? 0), 0)
      : null,
    fullyUnheardExposedSpanCount: allSemanticScorable
      ? responses.reduce((total, response) => total + (response.fullyUnheardExposedSpanCount ?? 0), 0)
      : null,
    totalConsequenceWeight,
    exposedConsequenceWeight,
    divergentConsequenceWeight,
    unheardContentExposureRate: exposedConsequenceWeight === null
      ? null
      : totalConsequenceWeight === 0
        ? 0
        : exposedConsequenceWeight / totalConsequenceWeight,
    bidirectionalSemanticMismatchRate: divergentConsequenceWeight === null
      ? null
      : totalConsequenceWeight === 0
        ? 0
        : divergentConsequenceWeight / totalConsequenceWeight,
    interruptionExposureScorableCount,
    interruptedMaterialExposureCount,
    unheardContentLeakageResponseCount,
    dependencyAnalysisHorizonIds,
    unheardContentLeakageRate: !uclrScorable || interruptedMaterialExposureCount === 0
      ? null
      : unheardContentLeakageResponseCount / interruptedMaterialExposureCount,
    responses,
  };
}

/**
 * Produce revision-bound evidence only when every requested consequence was
 * completely audible. By default the entire provider/user response boundary
 * must also match, preventing an unheard tail from contaminating the next turn.
 * Consumers must atomically compare-and-set `responseRevision` and consume the
 * evidence under their own idempotency key; this pure module does not execute
 * side effects or turn evidence into a bearer credential.
 */
export function evaluateAudibleCommit(
  state: AudibilityState,
  input: unknown
): AudibleCommitDecision {
  if (
    !isRecord(input)
    || !isNonEmptyId(input.responseId)
    || !Array.isArray(input.spanIds)
    || !input.spanIds.every(isNonEmptyId)
  ) {
    return {
      ok: false,
      code: "invalid_commit_request",
      error: "audible commit requires a valid responseId and an array of span ids",
    };
  }
  const request = input as AudibleCommitRequest;
  const response = responseFor(state, request.responseId);
  if (!response) {
    return { ok: false, code: "unknown_response", error: `unknown response "${request.responseId}"` };
  }
  if (!response.generation.final) {
    return {
      ok: false,
      code: "generation_not_final",
      error: "a response must finish generating before its audible state can be committed",
    };
  }
  if (response.providerHistory.throughMs === null) {
    return {
      ok: false,
      code: "provider_history_unknown",
      error: "provider history must be observed before audible state can be committed",
    };
  }
  if (response.providerHistory.basis !== "observed") {
    return {
      ok: false,
      code: "provider_history_unobserved",
      error: "documented provider behavior is scorable but cannot authorize an audible commit",
    };
  }
  if (!response.consequentialAnnotation) {
    return {
      ok: false,
      code: "annotation_incomplete",
      error: "consequential-content annotation must be completed before audible state can be committed",
    };
  }
  const spanIds = [...new Set(request.spanIds)];
  if (spanIds.length === 0) {
    return { ok: false, code: "empty_commit", error: "an audible commit requires at least one consequential span" };
  }
  for (const spanId of spanIds) {
    const span = hasOwn(response.consequentialSpans, spanId)
      ? response.consequentialSpans[spanId]
      : null;
    if (!span) {
      return { ok: false, code: "unknown_span", error: `unknown consequential span "${spanId}"`, spanId };
    }
    if (response.playback.throughMs < span.endMs) {
      return {
        ok: false,
        code: "span_not_fully_audible",
        error: `consequential span "${spanId}" was not fully audible`,
        spanId,
      };
    }
  }
  if (response.providerHistory.throughMs !== response.playback.throughMs) {
    return {
      ok: false,
      code: "provider_history_diverged",
      error: "provider history must be repaired to the caller's audible boundary before commit",
    };
  }
  const playbackMilestone = response.playback.interruption ?? response.playback.lastProgress;
  if (!playbackMilestone) {
    return {
      ok: false,
      code: "playback_evidence_missing",
      error: "audible state requires a playback-clock evidence reference",
    };
  }
  const spanEvidence = spanIds.map((spanId) => {
    const span = response.consequentialSpans[spanId];
    return {
      spanId,
      contentHash: span.contentHash,
      alignmentEvidenceSha256: span.markedAt.evidence.sha256,
    };
  });
  return {
    ok: true,
    evidence: {
      schemaVersion: AUDIBILITY_STATE_SCHEMA_VERSION,
      stateRevision: state.revision,
      responseRevision: response.revision,
      responseId: response.responseId,
      spanIds,
      spanEvidence,
      annotationEvidenceSha256: response.consequentialAnnotation.evidence.sha256,
      playedThroughMs: response.playback.throughMs,
      providerHistoryThroughMs: response.providerHistory.throughMs,
      generationEvidenceSha256: response.generation.evidence.sha256,
      playbackEvidenceSha256: playbackMilestone.evidence.sha256,
      providerHistoryEvidenceSha256: response.providerHistory.lastObservation.evidence.sha256,
    },
  };
}
