import { describe, expect, it } from "vitest";
import {
  applyAudibilityLedgerEvent,
  applyAudibilityLedgerEvents,
  createAudibilityLedger,
  projectAudibleConversationEvidence,
  type AudibilityEvidenceSource,
  type AudibilityLedger,
  type AudibilityLedgerEvent,
} from "../ledger";

type EventInput = AudibilityLedgerEvent extends infer Event
  ? Event extends AudibilityLedgerEvent
    ? Omit<Event, "sequence" | "sessionId" | "evidence">
    : never
  : never;

const SESSION_ID = "session-1";

function hash(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function event(
  sequence: number,
  source: AudibilityEvidenceSource,
  input: EventInput,
  sessionId = SESSION_ID
): AudibilityLedgerEvent {
  return {
    ...input,
    sequence,
    sessionId,
    evidence: { source, sha256: hash(sequence) },
  } as AudibilityLedgerEvent;
}

function reduce(
  events: readonly AudibilityLedgerEvent[],
  initial = createAudibilityLedger(SESSION_ID)
): AudibilityLedger {
  const result = applyAudibilityLedgerEvents(initial, events);
  if (!result.ok) throw new Error(`${result.code} at ${result.eventIndex}: ${result.error}`);
  return result.state;
}

function baseResponseEvents(): AudibilityLedgerEvent[] {
  return [
    event(1, "provider_output", {
      type: "response_registered",
      eventId: "register",
      responseId: "response-1",
      encoding: "pcm16",
      sampleRateHz: 24_000,
      channels: 1,
    }),
    event(2, "provider_output", {
      type: "pcm_chunk_generated",
      eventId: "chunk-1-event",
      responseId: "response-1",
      chunkId: "chunk-1",
      ordinal: 0,
      sampleCount: 400,
      pcmSha256: hash(101),
    }),
    event(3, "provider_output", {
      type: "pcm_chunk_generated",
      eventId: "chunk-2-event",
      responseId: "response-1",
      chunkId: "chunk-2",
      ordinal: 1,
      sampleCount: 600,
      pcmSha256: hash(102),
    }),
    event(4, "semantic_alignment", {
      type: "terminal_claim_registered",
      eventId: "claim-event",
      responseId: "response-1",
      claimId: "claim-booked",
      kind: "external_effect",
      range: { startSample: 700, endSample: 900 },
      contentSha256: hash(103),
    }),
    event(5, "provider_output", {
      type: "generation_closed",
      eventId: "close-generation",
      responseId: "response-1",
    }),
  ];
}

describe("audibility v2 ledger", () => {
  it("treats generated and released audio without a playback acknowledgement as unverifiable", () => {
    const state = reduce([
      ...baseResponseEvents(),
      event(6, "release_controller", {
        type: "release_requested",
        eventId: "release-safe-prefix-event",
        responseId: "response-1",
        decisionId: "release-safe-prefix",
        range: { startSample: 0, endSample: 600 },
        claimGrantIds: [],
      }),
    ]);

    expect(state.responses["response-1"].releaseDecisions[0]).toMatchObject({
      outcome: "released",
      reason: "authorized",
    });
    expect(projectAudibleConversationEvidence(state).responses[0]).toEqual({
      responseId: "response-1",
      evidenceStatus: "unverifiable",
      audibleRanges: [],
      pcmEvidence: [],
      terminalClaims: [{
        claimId: "claim-booked",
        status: "unverifiable",
        acknowledgedRanges: [],
        missingRanges: [{ startSample: 700, endSample: 900 }],
        grantId: null,
        authorityReceiptSha256: null,
      }],
      unverifiableReasons: [
        "no_playback_acknowledgement_or_terminal_clear",
        "released_audio_has_no_playback_evidence",
      ],
    });
  });

  it("blocks a terminal claim before its receipt-bound grant and releases it after the grant", () => {
    const beforeReceipt = reduce([
      ...baseResponseEvents(),
      event(6, "release_controller", {
        type: "release_requested",
        eventId: "premature-release-event",
        responseId: "response-1",
        decisionId: "premature-release",
        range: { startSample: 0, endSample: 1_000 },
        claimGrantIds: [],
      }),
    ]);
    expect(beforeReceipt.responses["response-1"].releaseDecisions).toEqual([
      expect.objectContaining({ outcome: "blocked", reason: "missing_claim_grant" }),
    ]);

    const afterReceipt = reduce([
      event(7, "effect_receipt", {
        type: "claim_grant_issued",
        eventId: "grant-event",
        responseId: "response-1",
        claimId: "claim-booked",
        grantId: "grant-booked",
        authorityRevision: 42,
        authorityReceiptSha256: hash(7),
      }),
      event(8, "release_controller", {
        type: "release_requested",
        eventId: "authorized-release-event",
        responseId: "response-1",
        decisionId: "authorized-release",
        range: { startSample: 0, endSample: 1_000 },
        claimGrantIds: ["grant-booked"],
      }),
    ], beforeReceipt);
    expect(afterReceipt.responses["response-1"].releaseDecisions[1]).toMatchObject({
      outcome: "released",
      reason: "authorized",
      claimGrantIds: ["grant-booked"],
    });
  });

  it("projects only acknowledged sample ranges and preserves exact chunk bindings", () => {
    const state = reduce([
      ...baseResponseEvents(),
      event(6, "effect_receipt", {
        type: "claim_grant_issued",
        eventId: "grant-event",
        responseId: "response-1",
        claimId: "claim-booked",
        grantId: "grant-booked",
        authorityRevision: 42,
        authorityReceiptSha256: hash(6),
      }),
      event(7, "release_controller", {
        type: "release_requested",
        eventId: "release-event",
        responseId: "response-1",
        decisionId: "release-1",
        range: { startSample: 0, endSample: 1_000 },
        claimGrantIds: ["grant-booked"],
      }),
      event(8, "playback_device", {
        type: "playback_acknowledged",
        eventId: "ack-event",
        responseId: "response-1",
        acknowledgementId: "ack-1",
        ranges: [{ startSample: 200, endSample: 800 }],
        releaseDecisionIds: ["release-1"],
      }),
    ]);

    expect(projectAudibleConversationEvidence(state).responses[0]).toMatchObject({
      evidenceStatus: "verified_audible",
      audibleRanges: [{ startSample: 200, endSample: 800 }],
      pcmEvidence: [
        {
          chunkId: "chunk-1",
          chunkPcmSha256: hash(101),
          range: { startSample: 200, endSample: 400 },
          acknowledgementIds: ["ack-1"],
          status: "acknowledged_played",
        },
        {
          chunkId: "chunk-2",
          chunkPcmSha256: hash(102),
          range: { startSample: 400, endSample: 800 },
          acknowledgementIds: ["ack-1"],
          status: "acknowledged_played",
        },
      ],
      terminalClaims: [expect.objectContaining({
        claimId: "claim-booked",
        status: "partially_audible",
        acknowledgedRanges: [{ startSample: 700, endSample: 800 }],
        missingRanges: [{ startSample: 800, endSample: 900 }],
        grantId: "grant-booked",
        authorityReceiptSha256: hash(6),
      })],
    });
  });

  it("makes clear and barge-in terminal without inventing playback evidence", () => {
    const cleared = reduce([
      ...baseResponseEvents(),
      event(6, "release_controller", {
        type: "release_requested",
        eventId: "release-event",
        responseId: "response-1",
        decisionId: "release-safe",
        range: { startSample: 0, endSample: 600 },
        claimGrantIds: [],
      }),
      event(7, "transport_control", {
        type: "playback_cleared",
        eventId: "clear-event",
        responseId: "response-1",
        clearId: "clear-1",
        reason: "barge_in",
      }),
      event(8, "transport_control", {
        type: "barge_in_recorded",
        eventId: "barge-event",
        responseId: "response-1",
        bargeInId: "barge-1",
        clearId: "clear-1",
      }),
      event(9, "provider_history", {
        type: "provider_history_truncated",
        eventId: "truncate-event",
        responseId: "response-1",
        truncationId: "truncate-1",
        retainedThroughSample: 0,
      }),
    ]);

    expect(cleared.responses["response-1"]).toMatchObject({
      playbackSealed: true,
      queueEpoch: 1,
      acknowledgedPlayedRanges: [],
      clears: [{ clearedRanges: [{ startSample: 0, endSample: 600 }] }],
      bargeIns: [{ audibleThroughRanges: [] }],
      truncations: [{ retainedThroughSample: 0 }],
    });
    expect(projectAudibleConversationEvidence(cleared).responses[0]).toMatchObject({
      evidenceStatus: "verified_not_audible",
      audibleRanges: [],
      pcmEvidence: [],
      terminalClaims: [{ status: "not_audible" }],
    });

    const lateAck = applyAudibilityLedgerEvent(cleared, event(10, "playback_device", {
      type: "playback_acknowledged",
      eventId: "late-ack-event",
      responseId: "response-1",
      acknowledgementId: "late-ack",
      ranges: [{ startSample: 0, endSample: 100 }],
      releaseDecisionIds: ["release-safe"],
    }));
    expect(lateAck).toMatchObject({ ok: false, code: "stale_release_epoch" });
  });

  it("rejects fabricated playback and preserves exact retry/conflict semantics", () => {
    const initial = createAudibilityLedger(SESSION_ID);
    const registration = baseResponseEvents()[0];
    const first = applyAudibilityLedgerEvent(initial, registration);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(applyAudibilityLedgerEvent(first.state, registration)).toMatchObject({
      ok: true,
      applied: false,
      duplicate: true,
    });
    expect(applyAudibilityLedgerEvent(first.state, {
      ...registration,
      responseId: "different-response",
    })).toMatchObject({ ok: false, code: "event_sequence_conflict" });

    const generated = reduce(baseResponseEvents().slice(1), first.state);
    const forgedAck = applyAudibilityLedgerEvent(generated, event(6, "playback_device", {
      type: "playback_acknowledged",
      eventId: "forged-ack-event",
      responseId: "response-1",
      acknowledgementId: "forged-ack",
      ranges: [{ startSample: 0, endSample: 100 }],
      releaseDecisionIds: ["missing-release"],
    }));
    expect(forgedAck).toMatchObject({ ok: false, code: "playback_not_released" });
    expect(forgedAck.state).toBe(generated);
  });

  it("holds across 500 seeded interruption schedules and receipt-gated terminal claims", () => {
    let randomState = 0x5eed1234;
    const random = (): number => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState;
    };

    for (let schedule = 0; schedule < 500; schedule += 1) {
      const sessionId = `schedule-${schedule}`;
      const responseId = `response-${schedule}`;
      let sequence = 0;
      const next = (source: AudibilityEvidenceSource, input: EventInput): AudibilityLedgerEvent => {
        sequence += 1;
        return event(sequence, source, input, sessionId);
      };
      const playedThrough = random() % 1_001;
      const events: AudibilityLedgerEvent[] = [
        next("provider_output", {
          type: "response_registered",
          eventId: `register-${schedule}`,
          responseId,
          encoding: "pcm16",
          sampleRateHz: 24_000,
          channels: 1,
        }),
        next("provider_output", {
          type: "pcm_chunk_generated",
          eventId: `chunk-event-${schedule}`,
          responseId,
          chunkId: `chunk-${schedule}`,
          ordinal: 0,
          sampleCount: 1_000,
          pcmSha256: hash(10_000 + schedule),
        }),
        next("semantic_alignment", {
          type: "terminal_claim_registered",
          eventId: `claim-event-${schedule}`,
          responseId,
          claimId: `claim-${schedule}`,
          kind: "external_effect",
          range: { startSample: 700, endSample: 900 },
          contentSha256: hash(20_000 + schedule),
        }),
        next("provider_output", {
          type: "generation_closed",
          eventId: `close-event-${schedule}`,
          responseId,
        }),
        next("release_controller", {
          type: "release_requested",
          eventId: `premature-event-${schedule}`,
          responseId,
          decisionId: `premature-${schedule}`,
          range: { startSample: 0, endSample: 1_000 },
          claimGrantIds: [],
        }),
        next("effect_receipt", {
          type: "claim_grant_issued",
          eventId: `grant-event-${schedule}`,
          responseId,
          claimId: `claim-${schedule}`,
          grantId: `grant-${schedule}`,
          authorityRevision: schedule + 1,
          authorityReceiptSha256: hash(sequence + 1),
        }),
        next("release_controller", {
          type: "release_requested",
          eventId: `release-event-${schedule}`,
          responseId,
          decisionId: `release-${schedule}`,
          range: { startSample: 0, endSample: 1_000 },
          claimGrantIds: [`grant-${schedule}`],
        }),
      ];
      if (playedThrough > 0) {
        events.push(next("playback_device", {
          type: "playback_acknowledged",
          eventId: `ack-event-${schedule}`,
          responseId,
          acknowledgementId: `ack-${schedule}`,
          ranges: [{ startSample: 0, endSample: playedThrough }],
          releaseDecisionIds: [`release-${schedule}`],
        }));
      }
      events.push(
        next("transport_control", {
          type: "playback_cleared",
          eventId: `clear-event-${schedule}`,
          responseId,
          clearId: `clear-${schedule}`,
          reason: "barge_in",
        }),
        next("transport_control", {
          type: "barge_in_recorded",
          eventId: `barge-event-${schedule}`,
          responseId,
          bargeInId: `barge-${schedule}`,
          clearId: `clear-${schedule}`,
        }),
        next("provider_history", {
          type: "provider_history_truncated",
          eventId: `truncate-event-${schedule}`,
          responseId,
          truncationId: `truncate-${schedule}`,
          retainedThroughSample: playedThrough,
        })
      );

      const ledger = reduce(events, createAudibilityLedger(sessionId));
      const response = ledger.responses[responseId];
      expect(response.releaseDecisions.map(({ outcome }) => outcome)).toEqual(["blocked", "released"]);
      expect(response.releaseDecisions[0].reason).toBe("missing_claim_grant");
      expect(response.acknowledgedPlayedRanges).toEqual(
        playedThrough === 0 ? [] : [{ startSample: 0, endSample: playedThrough }]
      );
      const projected = projectAudibleConversationEvidence(ledger).responses[0];
      expect(projected.audibleRanges).toEqual(
        playedThrough === 0 ? [] : [{ startSample: 0, endSample: playedThrough }]
      );
      expect(projected.pcmEvidence.every(({ status }) => status === "acknowledged_played")).toBe(true);
      const expectedClaimStatus = playedThrough >= 900
        ? "fully_audible"
        : playedThrough > 700
          ? "partially_audible"
          : "not_audible";
      expect(projected.terminalClaims[0]).toMatchObject({
        status: expectedClaimStatus,
        grantId: `grant-${schedule}`,
        authorityReceiptSha256: hash(6),
      });
    }
  });
});
