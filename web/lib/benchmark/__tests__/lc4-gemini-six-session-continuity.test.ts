import { describe, expect, it } from "vitest";
import {
  GEMINI_CAPABILITY_GATEWAY_NAME,
  projectGeminiInitialHistoryClientContent,
} from "../../realtime/client/gemini-live";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  createLc4DevRotationContext,
  projectLc4RotationPacketForReplay,
  type Lc4NativeConversationTurnInput,
} from "../lc4-production-provider-adapter";
import {
  LC4_DEV_PROVIDER_SESSION_SCHEDULE,
  type Lc4DevLiveEpisodePlan,
} from "../lc4-development-live-runner";
import { createLc4ProviderExecutionProfile } from "../lc4-production-runner-foundation";

const RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4-gemini-six-session-simulation-receipt/v1\n";

describe("LC4 Gemini HACC six-session continuity simulation", () => {
  it("replays one exact prefix before audio on all five 10-opportunity rotations", () => {
    const profile = createLc4ProviderExecutionProfile("gemini");
    const episode: Lc4DevLiveEpisodePlan = Object.freeze({
      episode_id: "lc4-dev-gemini-hacc-six-session-simulation",
      pair_id: "lc4-dev-gemini-six-session-simulation",
      pair_position: 2,
      provider: "gemini",
      arm: "hacc",
      model: profile.model,
      voice: profile.voice,
      maximum_micro_usd: 1_000_000,
      opportunity_binding_set_sha256: sha256Hex("gemini-six-session-opportunities"),
    });
    const turns: Lc4NativeConversationTurnInput[] = [];
    const events: string[] = [];
    const rotationBoundaries: number[] = [];
    const hydrationHashes: string[] = [];
    const receipts: string[] = [];
    const packetReceiptLinks: Array<Readonly<{
      segment: number;
      previousReceipt: string;
    }>> = [];

    for (const segment of LC4_DEV_PROVIDER_SESSION_SCHEDULE) {
      events.push(`s${segment.ordinal}:connect`);
      let openingPacketSha256: string | null = null;

      if (segment.ordinal > 1) {
        const boundary = segment.opportunity_start - 1;
        const previousReceipt = receipts.at(-1);
        if (!previousReceipt) throw new Error("missing prior simulated rotation receipt");
        const context = createLc4DevRotationContext({
          episode,
          segment_ordinal: segment.ordinal as 2 | 3 | 4 | 5 | 6,
          previous_rotation_receipt_sha256: previousReceipt,
          flow_state_sha256: sha256Hex(`flow-state-at-${boundary}`),
          response_plan_chain_head_sha256: sha256Hex(`response-plan-at-${boundary}`),
          conversation_turns: turns,
        });
        if (context.kind !== "hacc_structured_state") {
          throw new Error("Gemini HACC simulation compiled a Native rotation");
        }
        openingPacketSha256 = context.packet.packet_sha256;
        rotationBoundaries.push(context.packet.available_through_opportunity);
        packetReceiptLinks.push({
          segment: segment.ordinal,
          previousReceipt: context.packet.previous_session_rotation_receipt_sha256,
        });

        const replay = projectLc4RotationPacketForReplay(context.packet);
        const expectedTurnCount = boundary * 2;
        expect(replay).toMatchObject({
          packet_sha256: context.packet.packet_sha256,
          conversation_replay_sha256: context.packet.conversation_replay_sha256,
          turn_count: expectedTurnCount,
          provider_item_count: expectedTurnCount,
        });
        expect(replay.provider_history).toHaveLength(expectedTurnCount);
        expect(new Set(replay.provider_history.flatMap((turn) => (
          "text" in turn
            ? [turn.sourceSha256]
            : turn.role === "tool"
              ? [turn.sourceSha256]
              : turn.calls.map((call) => call.sourceSha256)
        ))))
          .toHaveLength(expectedTurnCount);

        const gemini = projectGeminiInitialHistoryClientContent(
          replay.provider_history,
          new Set([GEMINI_CAPABILITY_GATEWAY_NAME]),
        );
        expect(gemini).toEqual({
          providerContentTurnCount: expectedTurnCount,
          textPartCount: expectedTurnCount,
          functionCallCount: 0,
          functionResponseCount: 0,
          geminiContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(
          projectGeminiInitialHistoryClientContent(
            replay.provider_history,
            new Set([GEMINI_CAPABILITY_GATEWAY_NAME]),
          ).geminiContentSha256,
        ).toBe(gemini.geminiContentSha256);
        const alteredFirstTurn = replay.provider_history.map((turn, index) => (
          index === 0 && "text" in turn
            ? Object.freeze({ ...turn, text: `${turn.text} altered` })
            : turn
        ));
        expect(
          projectGeminiInitialHistoryClientContent(
            alteredFirstTurn,
            new Set([GEMINI_CAPABILITY_GATEWAY_NAME]),
          ).geminiContentSha256,
        ).not.toBe(gemini.geminiContentSha256);
        hydrationHashes.push(gemini.geminiContentSha256);
        events.push(`s${segment.ordinal}:hydrate:${gemini.geminiContentSha256}`);
      }

      for (
        let opportunity = segment.opportunity_start;
        opportunity <= segment.opportunity_end;
        opportunity += 1
      ) {
        events.push(`s${segment.ordinal}:audio:${opportunity}`);
        const callerSequence = turns.length + 1;
        turns.push(Object.freeze({
          turn_id: `conversation.${String(callerSequence).padStart(3, "0")}.caller`,
          sequence: callerSequence,
          speaker: "caller",
          source: "caller_tts_source_bound_to_pcm",
          text: `Caller utterance ${opportunity}.`,
          available_after_opportunity: opportunity,
          provenance_receipt_sha256: sha256Hex(`caller-pcm:${opportunity}`),
          provider_conversation_source: true,
          oracle_derived: false,
          future_derived: false,
          semantic_evaluator_derived: false,
        }));
        const assistantSequence = turns.length + 1;
        turns.push(Object.freeze({
          turn_id: `conversation.${String(assistantSequence).padStart(3, "0")}.assistant`,
          sequence: assistantSequence,
          speaker: "assistant",
          source: "listener_exact_captured_pcm_asr",
          text: `Gemini assistant utterance ${opportunity}.`,
          available_after_opportunity: opportunity,
          provenance_receipt_sha256: sha256Hex(`assistant-pcm:${opportunity}`),
          provider_conversation_source: true,
          oracle_derived: false,
          future_derived: false,
          semantic_evaluator_derived: false,
        }));
      }

      const previousReceipt = receipts.at(-1) ?? null;
      const receipt = sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson({
        segment_ordinal: segment.ordinal,
        opportunity_start: segment.opportunity_start,
        opportunity_end: segment.opportunity_end,
        previous_rotation_receipt_sha256: previousReceipt,
        opening_packet_sha256: openingPacketSha256,
        conversation_turn_count: turns.length,
      })}`);
      receipts.push(receipt);
      events.push(`s${segment.ordinal}:close:${receipt}`);
    }

    expect(rotationBoundaries).toEqual([10, 20, 30, 40, 50]);
    expect(packetReceiptLinks).toEqual([2, 3, 4, 5, 6].map((segment) => ({
      segment,
      previousReceipt: receipts[segment - 2],
    })));
    expect(receipts).toHaveLength(6);
    expect(new Set(receipts)).toHaveLength(6);
    expect(hydrationHashes).toHaveLength(5);
    expect(new Set(hydrationHashes)).toHaveLength(5);
    expect(turns).toHaveLength(120);
    expect(new Set(turns.map((turn) => turn.turn_id))).toHaveLength(120);
    expect(new Set(turns.map((turn) => turn.provenance_receipt_sha256)))
      .toHaveLength(120);
    expect(events.filter((event) => event.includes(":audio:"))).toHaveLength(60);
    expect(events.filter((event) => event.includes(":hydrate:"))).toHaveLength(5);

    for (const segment of LC4_DEV_PROVIDER_SESSION_SCHEDULE) {
      const sessionEvents = events.filter((event) =>
        event.startsWith(`s${segment.ordinal}:`),
      );
      const audioIndexes = sessionEvents
        .map((event, index) => event.includes(":audio:") ? index : -1)
        .filter((index) => index >= 0);
      expect(audioIndexes).toHaveLength(10);
      expect(sessionEvents[0]).toBe(`s${segment.ordinal}:connect`);
      expect(sessionEvents.at(-1)).toBe(
        `s${segment.ordinal}:close:${receipts[segment.ordinal - 1]}`,
      );
      if (segment.ordinal === 1) {
        expect(sessionEvents.some((event) => event.includes(":hydrate:"))).toBe(false);
        expect(audioIndexes[0]).toBe(1);
      } else {
        const hydrationIndexes = sessionEvents
          .map((event, index) => event.includes(":hydrate:") ? index : -1)
          .filter((index) => index >= 0);
        expect(hydrationIndexes).toEqual([1]);
        expect(audioIndexes[0]).toBe(2);
      }
    }
  });
});
