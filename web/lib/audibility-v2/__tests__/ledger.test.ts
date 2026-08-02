import { describe, expect, it } from "vitest";
import {
  applyAudibilityLedgerEvent,
  applyAudibilityLedgerEvents,
  classifyTerminalClaimSemantics,
  createAudibilityLedger,
  projectAudibleConversationEvidence,
  reopenVerifiedClaimGrantAuthority,
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

function verifiedAuthority(
  responseId: string,
  claimId: string,
  authorityReceiptSha256: string,
  claimContentSha256 = hash(103)
) {
  return reopenVerifiedClaimGrantAuthority({
    responseId,
    claimId,
    claimContentSha256,
    authorityRevision: 42,
    authorityReceiptSha256,
    reopenedReceiptSha256: hash(90),
    turnContractSha256: hash(91),
    semanticBindingSha256: hash(92),
  }, {
    verifyReopenedReceiptAndTurnContract: () => ({
      ok: true,
      verifierId: "test-host-verifier",
      hostVerificationSha256: hash(93),
    }),
  });
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
      verifiedNotPlayedRanges: [],
      unknownRanges: [{ startSample: 0, endSample: 600 }],
      pcmEvidence: [],
      terminalClaims: [{
        claimId: "claim-booked",
        status: "unverifiable",
        acknowledgedRanges: [],
        verifiedNotPlayedRanges: [],
        unknownRanges: [{ startSample: 700, endSample: 900 }],
        grantId: null,
        authorityReceiptSha256: null,
      }],
      unverifiableReasons: [
        "no_positive_playback_or_delivery_clear_evidence",
        "released_audio_has_unknown_delivery_ranges",
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
        grantId: "grant-booked",
        authority: verifiedAuthority("response-1", "claim-booked", hash(7)),
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
        grantId: "grant-booked",
        authority: verifiedAuthority("response-1", "claim-booked", hash(6)),
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
      evidenceStatus: "unverifiable",
      audibleRanges: [{ startSample: 200, endSample: 800 }],
      unknownRanges: [
        { startSample: 0, endSample: 200 },
        { startSample: 800, endSample: 1_000 },
      ],
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
        status: "unverifiable",
        acknowledgedRanges: [{ startSample: 700, endSample: 800 }],
        verifiedNotPlayedRanges: [],
        unknownRanges: [{ startSample: 800, endSample: 900 }],
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
      evidenceStatus: "unverifiable",
      audibleRanges: [],
      verifiedNotPlayedRanges: [],
      unknownRanges: [{ startSample: 0, endSample: 600 }],
      pcmEvidence: [],
      terminalClaims: [{ status: "unverifiable" }],
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

    const positivelyCleared = reduce([event(10, "playback_device", {
      type: "delivery_clear_confirmed",
      eventId: "delivery-clear-event",
      responseId: "response-1",
      confirmationId: "delivery-clear-1",
      clearId: "clear-1",
      confirmedNotPlayedRanges: [{ startSample: 0, endSample: 600 }],
    })], cleared);
    expect(projectAudibleConversationEvidence(positivelyCleared).responses[0]).toMatchObject({
      evidenceStatus: "verified_not_audible",
      audibleRanges: [],
      verifiedNotPlayedRanges: [{ startSample: 0, endSample: 600 }],
      unknownRanges: [],
    });
  });

  it("requires an opaque host-reopened receipt authority and fails closed on unknown semantics", () => {
    const state = reduce(baseResponseEvents());
    const literalGrant = applyAudibilityLedgerEvent(state, event(6, "effect_receipt", {
      type: "claim_grant_issued",
      eventId: "literal-grant-event",
      responseId: "response-1",
      grantId: "literal-grant",
      authority: {
        responseId: "response-1",
        claimId: "claim-booked",
        claimContentSha256: hash(103),
        authorityRevision: 42,
        authorityReceiptSha256: hash(6),
        reopenedReceiptSha256: hash(90),
        turnContractSha256: hash(91),
        semanticBindingSha256: hash(92),
        verifierId: "forged",
        hostVerificationSha256: hash(93),
      },
    } as unknown as EventInput));
    expect(literalGrant).toMatchObject({ ok: false, code: "invalid_event" });

    const paraphrase = classifyTerminalClaimSemantics({
      responseId: "response-1",
      spanId: "paraphrase",
      text: "Your reservation is locked in for Tuesday.",
      contentSha256: hash(110),
      turnContractSha256: hash(91),
    }, {
      classify: () => ({
        decision: "terminal_claim",
        kind: "external_effect",
        classifierId: "offline-semantic-fixture",
        evidenceSha256: hash(111),
      }),
    });
    expect(paraphrase).toMatchObject({ requiresClaimGrant: true });

    const unknown = classifyTerminalClaimSemantics({
      responseId: "response-1",
      spanId: "ambiguous-paraphrase",
      text: "Looks like that should be all set.",
      contentSha256: hash(112),
      turnContractSha256: hash(91),
    }, {
      classify: () => ({
        decision: "unknown",
        kind: null,
        classifierId: "offline-semantic-fixture",
        evidenceSha256: hash(113),
      }),
    });
    expect(unknown).toMatchObject({
      requiresClaimGrant: true,
      classification: { decision: "unknown" },
    });
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
          grantId: `grant-${schedule}`,
          authority: verifiedAuthority(
            responseId,
            `claim-${schedule}`,
            hash(sequence + 1),
            hash(20_000 + schedule)
          ),
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
      let ledger = reduce(events, createAudibilityLedger(sessionId));
      const applyGood = (source: AudibilityEvidenceSource, input: EventInput): void => {
        const result = applyAudibilityLedgerEvent(ledger, event(ledger.revision + 1, source, input, sessionId));
        if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
        ledger = result.state;
      };
      const mode = schedule % 5;
      if (playedThrough > 0 && mode !== 2) {
        const acknowledgedRanges = mode === 1 && playedThrough >= 6
          ? [
              { startSample: 0, endSample: Math.floor(playedThrough / 3) },
              { startSample: Math.floor((playedThrough * 2) / 3), endSample: playedThrough },
            ]
          : [{ startSample: 0, endSample: playedThrough }];
        applyGood("playback_device", {
          type: "playback_acknowledged",
          eventId: `ack-event-${schedule}`,
          responseId,
          acknowledgementId: `ack-${schedule}`,
          ranges: acknowledgedRanges,
          releaseDecisionIds: [`release-${schedule}`],
        });
      }
      const clearReason = mode === 2 || mode === 3 ? "disconnect" as const : "barge_in" as const;
      applyGood("transport_control", {
        type: "playback_cleared",
        eventId: `clear-event-${schedule}`,
        responseId,
        clearId: `clear-${schedule}`,
        reason: clearReason,
      });

      if (mode === 2) {
        const late = applyAudibilityLedgerEvent(ledger, event(ledger.revision + 1, "playback_device", {
          type: "playback_acknowledged",
          eventId: `delayed-ack-event-${schedule}`,
          responseId,
          acknowledgementId: `delayed-ack-${schedule}`,
          ranges: [{ startSample: 0, endSample: Math.max(1, playedThrough) }],
          releaseDecisionIds: [`release-${schedule}`],
        }, sessionId));
        expect(late).toMatchObject({ ok: false, code: "stale_release_epoch" });
      }

      const clear = ledger.responses[responseId].clears.at(-1);
      if (mode === 4 && clear && clear.clearedRanges.length > 0) {
        applyGood("playback_device", {
          type: "delivery_clear_confirmed",
          eventId: `delivery-clear-event-${schedule}`,
          responseId,
          confirmationId: `delivery-clear-${schedule}`,
          clearId: `clear-${schedule}`,
          confirmedNotPlayedRanges: clear.clearedRanges,
        });
      }
      if (clearReason === "barge_in") {
        applyGood("transport_control", {
          type: "barge_in_recorded",
          eventId: `barge-event-${schedule}`,
          responseId,
          bargeInId: `barge-${schedule}`,
          clearId: `clear-${schedule}`,
        });
      }
      applyGood("provider_history", {
        type: "provider_history_truncated",
        eventId: `truncate-event-${schedule}`,
        responseId,
        truncationId: `truncate-${schedule}`,
        retainedThroughSample: playedThrough,
      });

      const response = ledger.responses[responseId];
      expect(response.releaseDecisions.map(({ outcome }) => outcome)).toEqual(["blocked", "released"]);
      expect(response.releaseDecisions[0].reason).toBe("missing_claim_grant");
      const projected = projectAudibleConversationEvidence(ledger).responses[0];
      expect(projected.pcmEvidence.every(({ status }) => status === "acknowledged_played")).toBe(true);
      const measuredSamples = [
        ...projected.audibleRanges,
        ...projected.verifiedNotPlayedRanges,
        ...projected.unknownRanges,
      ].reduce((total, range) => total + range.endSample - range.startSample, 0);
      expect(measuredSamples).toBe(1_000);
      expect(projected.evidenceStatus).toBe(
        projected.unknownRanges.length > 0
          ? "unverifiable"
          : projected.audibleRanges.length > 0
            ? "verified_audible"
            : "verified_not_audible"
      );
      const claim = projected.terminalClaims[0];
      const acknowledgedClaimSamples = claim.acknowledgedRanges
        .reduce((total, range) => total + range.endSample - range.startSample, 0);
      const notPlayedClaimSamples = claim.verifiedNotPlayedRanges
        .reduce((total, range) => total + range.endSample - range.startSample, 0);
      const expectedClaimStatus = acknowledgedClaimSamples === 200
        ? "fully_audible"
        : notPlayedClaimSamples === 200
          ? "verified_not_audible"
          : "unverifiable";
      expect(projected.terminalClaims[0]).toMatchObject({
        status: expectedClaimStatus,
        grantId: `grant-${schedule}`,
        authorityReceiptSha256: hash(6),
      });
    }
  });
});
