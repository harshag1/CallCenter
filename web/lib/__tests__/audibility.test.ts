import { describe, expect, it } from "vitest";
import {
  applyAudibilityEvent,
  applyAudibilityEvents,
  createAudibilityState,
  evaluateAudibleCommit,
  scoreAudibility,
  scoreResponseAudibility,
  type AudibilityEvent,
  type AudibilityEvidenceSource,
  type AudibilityState,
  type ProviderHistoryObservation,
} from "../realtime/audibility";

type EventInput = AudibilityEvent extends infer Event
  ? Event extends AudibilityEvent
    ? Omit<Event, "sequence" | "evidence">
    : never
  : never;

const CONTENT_HASH = "f".repeat(64);

function event(
  sequence: number,
  source: AudibilityEvidenceSource,
  input: EventInput
): AudibilityEvent {
  return {
    ...input,
    sequence,
    evidence: {
      source,
      sha256: sequence.toString(16).padStart(64, "0"),
    },
  } as AudibilityEvent;
}

function knownHistory(retainedThroughMs: number): ProviderHistoryObservation {
  return { status: "known", retainedThroughMs, basis: "observed" };
}

function reduce(events: AudibilityEvent[], initial = createAudibilityState()): AudibilityState {
  const result = applyAudibilityEvents(initial, events);
  if (!result.ok) throw new Error(`${result.code} at event ${result.eventIndex}: ${result.error}`);
  return result.state;
}

describe("Audible State Commit runtime", () => {
  it("produces revision-bound evidence only after consequential content is audible and aligned", () => {
    const state = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-1",
        responseId: "response-1",
        throughMs: 1_000,
        final: true,
        providerHistory: knownHistory(1_000),
      }),
      event(2, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-1",
        responseId: "response-1",
        span: {
          id: "confirmation",
          startMs: 200,
          endMs: 400,
          kind: "authorization",
          weight: 2,
          contentHash: CONTENT_HASH,
        },
      }),
      event(3, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-2",
        responseId: "response-1",
        span: {
          id: "receipt",
          startMs: 700,
          endMs: 900,
          kind: "tool_result",
          contentHash: CONTENT_HASH,
        },
      }),
      event(4, "semantic_alignment", {
        type: "consequential_annotation_completed",
        eventId: "annotation-1",
        responseId: "response-1",
        annotatedThroughMs: 1_000,
        spanCount: 2,
      }),
      event(5, "playback_queue", {
        type: "queued",
        eventId: "q-1",
        responseId: "response-1",
        throughMs: 1_000,
      }),
      event(6, "playback_clock", {
        type: "played_through",
        eventId: "p-1",
        responseId: "response-1",
        throughMs: 1_000,
      }),
    ]);

    expect(scoreAudibility(state)).toMatchObject({
      responseCount: 1,
      providerHistoryScorableResponseCount: 1,
      observedProviderHistoryResponseCount: 1,
      assumedProviderHistoryResponseCount: 0,
      semanticScorableResponseCount: 1,
      generatedMs: 1_000,
      queuedButUnplayedMs: 0,
      audioStateDivergenceMs: 0,
      consequentialSpanCount: 2,
      unheardContentExposureRate: 0,
      bidirectionalSemanticMismatchRate: 0,
      audibleStateDivergenceRate: 0,
      unheardContentLeakageRate: null,
    });
    expect(evaluateAudibleCommit(state, {
      responseId: "response-1",
      spanIds: ["confirmation", "receipt", "confirmation"],
    })).toEqual({
      ok: true,
      evidence: {
        schemaVersion: 1,
        stateRevision: 6,
        responseRevision: 6,
        responseId: "response-1",
        spanIds: ["confirmation", "receipt"],
        spanEvidence: [
          {
            spanId: "confirmation",
            contentHash: CONTENT_HASH,
            alignmentEvidenceSha256: "2".padStart(64, "0"),
          },
          {
            spanId: "receipt",
            contentHash: CONTENT_HASH,
            alignmentEvidenceSha256: "3".padStart(64, "0"),
          },
        ],
        annotationEvidenceSha256: "4".padStart(64, "0"),
        playedThroughMs: 1_000,
        providerHistoryThroughMs: 1_000,
        generationEvidenceSha256: "1".padStart(64, "0"),
        playbackEvidenceSha256: "6".padStart(64, "0"),
        providerHistoryEvidenceSha256: "1".padStart(64, "0"),
      },
    });
  });

  it("quantifies unheard consequential content after barge-in and clears it only after acknowledged repair", () => {
    const interrupted = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-2",
        responseId: "response-2",
        throughMs: 1_200,
        final: true,
        providerHistory: knownHistory(1_200),
      }),
      event(2, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-3",
        responseId: "response-2",
        span: {
          id: "heard",
          startMs: 100,
          endMs: 300,
          kind: "instruction",
          weight: 1,
          contentHash: CONTENT_HASH,
        },
      }),
      event(3, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-4",
        responseId: "response-2",
        span: {
          id: "partial",
          startMs: 450,
          endMs: 650,
          kind: "state_change",
          weight: 2,
          contentHash: CONTENT_HASH,
        },
      }),
      event(4, "semantic_alignment", {
        type: "consequential_annotation_completed",
        eventId: "annotation-2",
        responseId: "response-2",
        annotatedThroughMs: 1_200,
        spanCount: 2,
      }),
      event(5, "playback_queue", {
        type: "queued",
        eventId: "q-2",
        responseId: "response-2",
        throughMs: 1_200,
      }),
      event(6, "playback_clock", {
        type: "interrupted",
        eventId: "i-2",
        responseId: "response-2",
        playedThroughMs: 500,
        reason: "caller_barge_in",
      }),
    ]);

    const beforeRepair = scoreResponseAudibility(interrupted.responses["response-2"]);
    expect(beforeRepair).toMatchObject({
      queuedButUnplayedMs: 700,
      unheardAudioRetainedMs: 700,
      audioStateDivergenceMs: 700,
      exposedConsequentialSpanCount: 1,
      fullyUnheardExposedSpanCount: 0,
      exposedConsequenceWeight: 1.5,
      unheardContentExposureRate: 0.5,
      bidirectionalSemanticMismatchRate: 0.5,
      audibleStateDiverged: true,
      materialUnheardContentAtInterruption: true,
      providerHistoryAligned: false,
    });
    expect(beforeRepair.spans.find((span) => span.id === "partial")).toMatchObject({
      audibleFraction: 0.25,
      providerRetainedFraction: 1,
      unheardExposureFraction: 0.75,
      state: "partially_audible",
    });
    expect(evaluateAudibleCommit(interrupted, {
      responseId: "response-2",
      spanIds: ["partial"],
    })).toMatchObject({ ok: false, code: "span_not_fully_audible" });
    expect(evaluateAudibleCommit(interrupted, {
      responseId: "response-2",
      spanIds: ["heard"],
    })).toMatchObject({ ok: false, code: "provider_history_diverged" });
    const forgedRepair = applyAudibilityEvent(interrupted, event(7, "provider_event", {
      type: "generated",
      eventId: "forged-repair",
      responseId: "response-2",
      throughMs: 1_200,
      final: true,
      providerHistory: knownHistory(500),
    }));
    expect(forgedRepair).toMatchObject({ ok: false, code: "generation_already_final" });
    expect(forgedRepair.state).toBe(interrupted);

    expect(scoreAudibility(interrupted)).toMatchObject({
      audibleStateDivergenceCheckpointCount: 1,
      audibleStateDivergenceRate: 1,
      interruptionExposureScorableCount: 1,
      interruptedMaterialExposureCount: 1,
      unheardContentLeakageResponseCount: 0,
      unheardContentLeakageRate: null,
    });
    const leaked = reduce([
      event(7, "dependency_trace", {
        type: "unheard_content_dependency_recorded",
        eventId: "dependency-2",
        responseId: "response-2",
        spanId: "partial",
        consumerId: "later-claim-1",
        consumerKind: "claim",
      }),
      event(8, "dependency_trace", {
        type: "dependency_analysis_completed",
        eventId: "dependency-analysis-2",
        responseId: "response-2",
        dependencyCount: 1,
        horizonId: "conversation-end",
      }),
    ], interrupted);
    expect(scoreAudibility(leaked, { expectedDependencyHorizonId: "conversation-end" })).toMatchObject({
      unheardContentLeakageResponseCount: 1,
      dependencyAnalysisHorizonIds: ["conversation-end"],
      unheardContentLeakageRate: 1,
    });

    const repaired = reduce([
      event(9, "provider_event", {
        type: "provider_history_repaired",
        eventId: "repair-2",
        responseId: "response-2",
        retainedThroughMs: 500,
        repairId: "provider-truncate-17",
      }),
    ], leaked);
    expect(scoreResponseAudibility(repaired.responses["response-2"])).toMatchObject({
      audioStateDivergenceMs: 0,
      exposedConsequenceWeight: 0,
      unheardContentExposureRate: 0,
      bidirectionalSemanticMismatchRate: 0,
      audibleStateDiverged: false,
      unheardContentLeaked: true,
      providerHistoryRepaired: true,
      providerHistoryAligned: true,
    });
    expect(evaluateAudibleCommit(repaired, {
      responseId: "response-2",
      spanIds: ["heard"],
    })).toMatchObject({ ok: true });
    expect(scoreAudibility(repaired, { expectedDependencyHorizonId: "conversation-end" })).toMatchObject({
      interruptedResponseCount: 1,
      alignedInterruptedResponseCount: 1,
      unresolvedInterruptedResponseCount: 0,
      audibleStateDivergenceCheckpointCount: 0,
      audibleStateDivergenceRate: 0,
      unheardContentLeakageRate: 1,
    });

    const invalidated = reduce([
      event(10, "provider_event", {
        type: "provider_history_invalidated",
        eventId: "history-lost-on-reconnect",
        responseId: "response-2",
        invalidationId: "reconnect-1",
        reason: "provider resumption was not acknowledged",
      }),
    ], repaired);
    expect(scoreResponseAudibility(invalidated.responses["response-2"])).toMatchObject({
      providerHistoryStatus: "unknown",
      providerHistoryInvalidated: true,
      audibleStateDiverged: null,
    });
    expect(evaluateAudibleCommit(invalidated, {
      responseId: "response-2",
      spanIds: ["heard"],
    })).toMatchObject({ ok: false, code: "provider_history_unknown" });

    const reacknowledged = reduce([
      event(11, "provider_event", {
        type: "provider_history_repaired",
        eventId: "history-reacknowledged",
        responseId: "response-2",
        retainedThroughMs: 500,
        repairId: "resumption-ack-2",
      }),
    ], invalidated);
    expect(evaluateAudibleCommit(reacknowledged, {
      responseId: "response-2",
      spanIds: ["heard"],
    })).toMatchObject({ ok: true });
  });

  it("represents unknown provider retention without manufacturing a perfect score", () => {
    const unknown = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-unknown",
        responseId: "response-unknown",
        throughMs: 500,
        final: true,
        providerHistory: { status: "unknown", reason: "provider exposes no history acknowledgment" },
      }),
      event(2, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-unknown",
        responseId: "response-unknown",
        span: {
          id: "unknown-retention",
          startMs: 100,
          endMs: 300,
          kind: "commitment",
          contentHash: CONTENT_HASH,
        },
      }),
      event(3, "semantic_alignment", {
        type: "consequential_annotation_completed",
        eventId: "annotation-unknown",
        responseId: "response-unknown",
        annotatedThroughMs: 500,
        spanCount: 1,
      }),
      event(4, "playback_queue", {
        type: "queued",
        eventId: "q-unknown",
        responseId: "response-unknown",
        throughMs: 500,
      }),
      event(5, "playback_clock", {
        type: "played_through",
        eventId: "p-unknown",
        responseId: "response-unknown",
        throughMs: 500,
      }),
    ]);

    expect(scoreResponseAudibility(unknown.responses["response-unknown"])).toMatchObject({
      providerHistoryStatus: "unknown",
      providerHistoryMs: null,
      audioStateDivergenceMs: null,
      unheardContentExposureRate: null,
      bidirectionalSemanticMismatchRate: null,
      audibleStateDiverged: null,
      semanticMetricsAvailable: false,
    });
    expect(scoreAudibility(unknown)).toMatchObject({
      providerHistoryScorableResponseCount: 0,
      semanticScorableResponseCount: 0,
      audioStateDivergenceRate: null,
      unheardContentLeakageRate: null,
    });
    expect(evaluateAudibleCommit(unknown, {
      responseId: "response-unknown",
      spanIds: ["unknown-retention"],
    })).toMatchObject({ ok: false, code: "provider_history_unknown" });

    const unannotated = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-unannotated",
        responseId: "response-unannotated",
        throughMs: 200,
        final: true,
        providerHistory: knownHistory(200),
      }),
    ]);
    expect(scoreResponseAudibility(unannotated.responses["response-unannotated"])).toMatchObject({
      providerHistoryStatus: "known",
      audioStateDivergenceRate: 1,
      semanticMetricsAvailable: false,
      unheardContentExposureRate: null,
      bidirectionalSemanticMismatchRate: null,
    });
    const annotatedWithNone = reduce([
      event(2, "semantic_alignment", {
        type: "consequential_annotation_completed",
        eventId: "annotation-none",
        responseId: "response-unannotated",
        annotatedThroughMs: 200,
        spanCount: 0,
      }),
    ], unannotated);
    expect(scoreResponseAudibility(annotatedWithNone.responses["response-unannotated"])).toMatchObject({
      semanticMetricsAvailable: true,
      consequentialSpanCount: 0,
      unheardContentExposureRate: 0,
      bidirectionalSemanticMismatchRate: 0,
    });
    expect(applyAudibilityEvent(annotatedWithNone, event(3, "semantic_alignment", {
      type: "consequential_content_marked",
      eventId: "late-span",
      responseId: "response-unannotated",
      span: {
        id: "not-in-manifest",
        startMs: 10,
        endMs: 50,
        kind: "other",
        contentHash: CONTENT_HASH,
      },
    }))).toMatchObject({ ok: false, code: "annotation_already_completed" });

    const assumed = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-assumed",
        responseId: "response-assumed",
        throughMs: 400,
        final: true,
        providerHistory: {
          status: "known",
          retainedThroughMs: 400,
          basis: "documented_assumption",
          contractHash: "c".repeat(64),
        },
      }),
      event(2, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-assumed",
        responseId: "response-assumed",
        span: {
          id: "assumed-span",
          startMs: 100,
          endMs: 200,
          kind: "commitment",
          contentHash: CONTENT_HASH,
        },
      }),
      event(3, "semantic_alignment", {
        type: "consequential_annotation_completed",
        eventId: "annotation-assumed",
        responseId: "response-assumed",
        annotatedThroughMs: 400,
        spanCount: 1,
      }),
      event(4, "playback_queue", {
        type: "queued",
        eventId: "q-assumed",
        responseId: "response-assumed",
        throughMs: 400,
      }),
      event(5, "playback_clock", {
        type: "played_through",
        eventId: "p-assumed",
        responseId: "response-assumed",
        throughMs: 400,
      }),
    ]);
    expect(scoreResponseAudibility(assumed.responses["response-assumed"])).toMatchObject({
      semanticMetricsAvailable: true,
      semanticMetricsEvidence: "assumed",
      unheardContentExposureRate: 0,
    });
    expect(scoreAudibility(assumed)).toMatchObject({
      providerHistoryScorableResponseCount: 0,
      assumedProviderHistoryResponseCount: 1,
      semanticScorableResponseCount: 0,
      unheardContentLeakageRate: null,
      audioStateDivergenceRate: null,
    });
    expect(evaluateAudibleCommit(assumed, {
      responseId: "response-assumed",
      spanIds: ["assumed-span"],
    })).toMatchObject({ ok: false, code: "provider_history_unobserved" });
  });

  it("scores provider omission separately and requires a fresh observation after resumed generation", () => {
    const repairedTooFar = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-3",
        responseId: "response-3",
        throughMs: 600,
        final: true,
        providerHistory: knownHistory(600),
      }),
      event(2, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-5",
        responseId: "response-3",
        span: {
          id: "crossing",
          startMs: 350,
          endMs: 550,
          kind: "policy",
          weight: 2,
          contentHash: CONTENT_HASH,
        },
      }),
      event(3, "semantic_alignment", {
        type: "consequential_annotation_completed",
        eventId: "annotation-3",
        responseId: "response-3",
        annotatedThroughMs: 600,
        spanCount: 1,
      }),
      event(4, "playback_queue", {
        type: "queued",
        eventId: "q-3",
        responseId: "response-3",
        throughMs: 600,
      }),
      event(5, "playback_clock", {
        type: "interrupted",
        eventId: "i-3",
        responseId: "response-3",
        playedThroughMs: 500,
      }),
      event(6, "provider_event", {
        type: "provider_history_repaired",
        eventId: "repair-3",
        responseId: "response-3",
        retainedThroughMs: 400,
        repairId: "provider-truncate-18",
      }),
    ]);
    expect(scoreResponseAudibility(repairedTooFar.responses["response-3"])).toMatchObject({
      unheardAudioRetainedMs: 0,
      heardAudioMissingFromHistoryMs: 100,
      audioStateDivergenceMs: 100,
      exposedConsequenceWeight: 0,
      divergentConsequenceWeight: 1,
      unheardContentExposureRate: 0,
      bidirectionalSemanticMismatchRate: 0.5,
      audibleStateDiverged: false,
    });

    const resumedUnknown = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-late-start",
        responseId: "response-late",
        throughMs: 600,
        providerHistory: knownHistory(600),
      }),
      event(2, "playback_queue", {
        type: "queued",
        eventId: "q-late",
        responseId: "response-late",
        throughMs: 600,
      }),
      event(3, "playback_clock", {
        type: "interrupted",
        eventId: "i-late",
        responseId: "response-late",
        playedThroughMs: 500,
      }),
      event(4, "provider_event", {
        type: "provider_history_repaired",
        eventId: "repair-late",
        responseId: "response-late",
        retainedThroughMs: 500,
        repairId: "provider-truncate-19",
      }),
      event(5, "provider_event", {
        type: "generated",
        eventId: "g-late-finish",
        responseId: "response-late",
        throughMs: 800,
        final: true,
        providerHistory: { status: "unknown", reason: "late deltas arrived after repair" },
      }),
    ]);
    expect(scoreResponseAudibility(resumedUnknown.responses["response-late"])).toMatchObject({
      generatedButUnqueuedMs: 200,
      providerHistoryMs: null,
      audioStateDivergenceMs: null,
      providerHistoryAligned: null,
      consequentialAnnotationComplete: false,
    });
  });

  it("is bounded-memory retry-idempotent and rejects malformed or impossible timelines", () => {
    const generated = event(1, "provider_event", {
      type: "generated",
      eventId: "stable-event",
      responseId: "response-4",
      throughMs: 400,
      providerHistory: knownHistory(400),
    });
    const first = applyAudibilityEvent(createAudibilityState(), generated);
    if (!first.ok) throw new Error(first.error);

    const duplicate = applyAudibilityEvent(first.state, generated);
    expect(duplicate).toMatchObject({ ok: true, applied: false, duplicate: true });
    expect(duplicate.state).toBe(first.state);

    const conflictingSequence = applyAudibilityEvent(first.state, {
      ...generated,
      throughMs: 500,
      providerHistory: knownHistory(500),
    });
    expect(conflictingSequence).toMatchObject({ ok: false, code: "event_sequence_conflict" });
    expect(conflictingSequence.state).toBe(first.state);

    const impossibleQueue = applyAudibilityEvent(first.state, event(2, "playback_queue", {
      type: "queued",
      eventId: "bad-queue",
      responseId: "response-4",
      throughMs: 401,
    }));
    expect(impossibleQueue).toMatchObject({ ok: false, code: "queue_exceeds_generated" });
    expect(impossibleQueue.state).toBe(first.state);

    expect(applyAudibilityEvent(first.state, event(2, "dependency_trace", {
      type: "dependency_analysis_completed",
      eventId: "premature-analysis",
      responseId: "response-4",
      dependencyCount: 0,
      horizonId: "conversation-end",
    }))).toMatchObject({ ok: false, code: "dependency_without_scorable_interruption" });

    expect(applyAudibilityEvent(first.state, event(2, "semantic_alignment", {
      type: "consequential_content_marked",
      eventId: "overflow-weight",
      responseId: "response-4",
      span: {
        id: "overflow-weight",
        startMs: 0,
        endMs: 100,
        kind: "other",
        weight: Number.MAX_VALUE,
        contentHash: CONTENT_HASH,
      },
    }))).toMatchObject({ ok: false, code: "invalid_event" });

    expect(applyAudibilityEvent(first.state, null)).toMatchObject({ ok: false, code: "invalid_event" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(applyAudibilityEvent(first.state, {
      ...event(2, "playback_queue", {
        type: "queued",
        eventId: "cyclic-event",
        responseId: "response-4",
        throughMs: 400,
      }),
      extra: cyclic,
    })).toMatchObject({ ok: false, code: "invalid_event" });
    expect(evaluateAudibleCommit(first.state, null)).toMatchObject({
      ok: false,
      code: "invalid_commit_request",
    });
    expect(applyAudibilityEvent(first.state, {
      ...event(2, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "bad-span",
        responseId: "response-4",
        span: {
          id: "placeholder",
          startMs: 0,
          endMs: 1,
          kind: "other",
          contentHash: CONTENT_HASH,
        },
      }),
      span: null,
    })).toMatchObject({ ok: false, code: "invalid_event" });

    const stoppedBatch = applyAudibilityEvents(first.state, [
      event(2, "playback_queue", {
        type: "queued",
        eventId: "q-4",
        responseId: "response-4",
        throughMs: 400,
      }),
      event(3, "playback_clock", {
        type: "played_through",
        eventId: "bad-play",
        responseId: "response-4",
        throughMs: 401,
      }),
    ]);
    expect(stoppedBatch).toMatchObject({ ok: false, code: "playback_exceeds_queue", eventIndex: 1 });
    expect(stoppedBatch.state).toBe(first.state);
    expect(first.state).toMatchObject({
      revision: 1,
      lastAppliedEvent: { sequence: 1, eventId: "stable-event" },
    });
    expect("appliedEvents" in first.state).toBe(false);
  });

  it("scores async post-interruption annotations without laundering assumed exposure", () => {
    const asyncAnnotated = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-async",
        responseId: "response-async",
        throughMs: 1_000,
        final: true,
        providerHistory: knownHistory(1_000),
      }),
      event(2, "playback_queue", {
        type: "queued",
        eventId: "q-async",
        responseId: "response-async",
        throughMs: 1_000,
      }),
      event(3, "playback_clock", {
        type: "interrupted",
        eventId: "i-async",
        responseId: "response-async",
        playedThroughMs: 500,
      }),
      event(4, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-async",
        responseId: "response-async",
        span: {
          id: "unheard-async",
          startMs: 700,
          endMs: 900,
          kind: "commitment",
          contentHash: CONTENT_HASH,
        },
      }),
      event(5, "semantic_alignment", {
        type: "consequential_annotation_completed",
        eventId: "annotation-async",
        responseId: "response-async",
        annotatedThroughMs: 1_000,
        spanCount: 1,
      }),
      event(6, "dependency_trace", {
        type: "unheard_content_dependency_recorded",
        eventId: "dependency-async",
        responseId: "response-async",
        spanId: "unheard-async",
        consumerId: "later-action",
        consumerKind: "action",
      }),
      event(7, "dependency_trace", {
        type: "dependency_analysis_completed",
        eventId: "analysis-async",
        responseId: "response-async",
        dependencyCount: 1,
        horizonId: "checkpoint-10",
      }),
    ]);
    expect(scoreResponseAudibility(asyncAnnotated.responses["response-async"])).toMatchObject({
      materialUnheardContentAtInterruption: true,
      unheardContentDependencyCount: 1,
      dependencyAnalysisHorizonId: "checkpoint-10",
      unheardContentLeaked: true,
    });
    expect(scoreAudibility(asyncAnnotated, { expectedDependencyHorizonId: "checkpoint-10" })).toMatchObject({
      unheardContentLeakageRate: 1,
    });

    const assumptionHighWater = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-assumption-high",
        responseId: "response-assumption-high",
        throughMs: 1_000,
        providerHistory: {
          status: "known",
          retainedThroughMs: 1_000,
          basis: "documented_assumption",
          contractHash: "d".repeat(64),
        },
      }),
      event(2, "playback_queue", {
        type: "queued",
        eventId: "q-assumption-high",
        responseId: "response-assumption-high",
        throughMs: 1_000,
      }),
      event(3, "playback_clock", {
        type: "interrupted",
        eventId: "i-assumption-high",
        responseId: "response-assumption-high",
        playedThroughMs: 500,
      }),
      event(4, "provider_event", {
        type: "generated",
        eventId: "g-observed-lower",
        responseId: "response-assumption-high",
        throughMs: 1_000,
        final: true,
        providerHistory: knownHistory(500),
      }),
      event(5, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-assumption-high",
        responseId: "response-assumption-high",
        span: {
          id: "assumed-only-span",
          startMs: 700,
          endMs: 900,
          kind: "commitment",
          contentHash: CONTENT_HASH,
        },
      }),
      event(6, "semantic_alignment", {
        type: "consequential_annotation_completed",
        eventId: "annotation-assumption-high",
        responseId: "response-assumption-high",
        annotatedThroughMs: 1_000,
        spanCount: 1,
      }),
    ]);
    expect(scoreResponseAudibility(assumptionHighWater.responses["response-assumption-high"])).toMatchObject({
      materialUnheardContentAtInterruption: null,
    });
    expect(applyAudibilityEvent(assumptionHighWater, event(7, "dependency_trace", {
      type: "unheard_content_dependency_recorded",
      eventId: "laundered-dependency",
      responseId: "response-assumption-high",
      spanId: "assumed-only-span",
      consumerId: "should-not-count",
      consumerKind: "claim",
    }))).toMatchObject({ ok: false, code: "dependency_without_scorable_interruption" });

    const uncertaintyIsSticky = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-certain-start",
        responseId: "response-uncertain",
        throughMs: 500,
        providerHistory: knownHistory(500),
      }),
      event(2, "playback_queue", {
        type: "queued",
        eventId: "q-uncertain",
        responseId: "response-uncertain",
        throughMs: 500,
      }),
      event(3, "playback_clock", {
        type: "interrupted",
        eventId: "i-uncertain",
        responseId: "response-uncertain",
        playedThroughMs: 400,
      }),
      event(4, "provider_event", {
        type: "generated",
        eventId: "g-unknown-middle",
        responseId: "response-uncertain",
        throughMs: 700,
        providerHistory: { status: "unknown", reason: "provider emitted no history acknowledgment" },
      }),
      event(5, "provider_event", {
        type: "generated",
        eventId: "g-observed-end",
        responseId: "response-uncertain",
        throughMs: 700,
        final: true,
        providerHistory: knownHistory(500),
      }),
      event(6, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-uncertain",
        responseId: "response-uncertain",
        span: {
          id: "unknown-interval-span",
          startMs: 600,
          endMs: 650,
          kind: "other",
          contentHash: CONTENT_HASH,
        },
      }),
      event(7, "semantic_alignment", {
        type: "consequential_annotation_completed",
        eventId: "annotation-uncertain",
        responseId: "response-uncertain",
        annotatedThroughMs: 700,
        spanCount: 1,
      }),
    ]);
    expect(scoreResponseAudibility(uncertaintyIsSticky.responses["response-uncertain"])).toMatchObject({
      materialUnheardContentAtInterruption: null,
    });
  });

  it("will not issue commit evidence while a response can still grow an unheard tail", () => {
    const streaming = reduce([
      event(1, "provider_event", {
        type: "generated",
        eventId: "g-stream",
        responseId: "response-stream",
        throughMs: 400,
        providerHistory: knownHistory(400),
      }),
      event(2, "semantic_alignment", {
        type: "consequential_content_marked",
        eventId: "span-stream",
        responseId: "response-stream",
        span: {
          id: "spoken-confirmation",
          startMs: 100,
          endMs: 300,
          kind: "authorization",
          contentHash: CONTENT_HASH,
        },
      }),
      event(3, "playback_queue", {
        type: "queued",
        eventId: "q-stream",
        responseId: "response-stream",
        throughMs: 400,
      }),
      event(4, "playback_clock", {
        type: "played_through",
        eventId: "p-stream",
        responseId: "response-stream",
        throughMs: 400,
      }),
    ]);

    expect(applyAudibilityEvent(streaming, event(5, "semantic_alignment", {
      type: "consequential_annotation_completed",
      eventId: "annotation-stream",
      responseId: "response-stream",
      annotatedThroughMs: 400,
      spanCount: 1,
    }))).toMatchObject({ ok: false, code: "annotation_before_generation_final" });

    expect(evaluateAudibleCommit(streaming, {
      responseId: "response-stream",
      spanIds: ["spoken-confirmation"],
    })).toMatchObject({ ok: false, code: "generation_not_final" });
  });
});
