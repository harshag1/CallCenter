import { describe, expect, it } from "vitest";
import {
  ContextProjectionOverflowError,
  appendConversationEvents,
  createConversationLog,
  foldConversation,
} from "../conversation-kernel";
import { compileRealtimeContextPacket } from "../realtime-context-packet";

const H = (char: string) => char.repeat(64);

function stateWithNeedle(noiseFacts = 0) {
  const events = [
    {
      eventId: "policy-1", occurredAtMs: 1,
      payload: { type: "policy.advanced" as const, epoch: 1,
        invariants: [{ invariantId: "never-charge-without-confirmation", text: "Never charge without confirmation" }] },
    },
    {
      eventId: "goal-1", occurredAtMs: 2,
      payload: { type: "goal.activated" as const, goalId: "returns", description: "Complete the corrected return" },
    },
    {
      eventId: "fact-needle", occurredAtMs: 3,
      payload: { type: "fact.asserted" as const, key: "return.destination", value: "OAK", revision: 1 as const,
        authority: { kind: "human_verified" as const, issuer: "caller", evidenceId: "turn-3", issuedAtMs: 3 } },
    },
    {
      eventId: "fact-correction", occurredAtMs: 4,
      payload: { type: "fact.corrected" as const, key: "return.destination", value: "SFO",
        expectedRevision: 1, revision: 2,
        authority: { kind: "human_verified" as const, issuer: "caller", evidenceId: "turn-4", issuedAtMs: 4 } },
    },
    ...Array.from({ length: noiseFacts }, (_, index) => ({
      eventId: `noise-${index}`, occurredAtMs: 10 + index,
      payload: { type: "fact.asserted" as const, key: `noise.${index}`, value: `value-${index}`, revision: 1 as const,
        authority: { kind: "system_of_record" as const, issuer: "fixture", evidenceId: `noise-evidence-${index}`,
          issuedAtMs: 10 + index } },
    })),
  ];
  return foldConversation(appendConversationEvents(createConversationLog("conversation-1"), events));
}

describe("realtime context packet", () => {
  it("retains corrected authority while trimming old heard dialogue first", () => {
    const turns = Array.from({ length: 40 }, (_, index) => ({
      turnId: `turn-${index}`,
      speaker: index % 2 ? "agent" as const : "caller" as const,
      text: `unrelated audible discussion ${index} ${"x".repeat(100)}`,
      heardAtMs: index,
    }));
    const packet = compileRealtimeContextPacket({
      state: stateWithNeedle(),
      capabilityCatalogDigest: H("a"),
      capabilityEpoch: 3,
      capabilities: [{ name: "complete_return", description: "Complete the active return after confirmation" }],
      recentAudibleTurns: turns,
      byteBudget: 2_048,
    });
    expect(packet.byteLength).toBeLessThanOrEqual(2_048);
    expect(packet.value.durable.authoritativeFacts).toContainEqual({
      key: "return.destination", value: "SFO", revision: 2,
    });
    expect(packet.serialized).not.toContain('"OAK"');
    expect(packet.value.omittedRecentTurnCount).toBeGreaterThan(0);
    expect(packet.value.recentAudibleTurns.at(-1)?.turnId).toBe("turn-39");
  });

  it("binds the packet to the exact conversation and capability heads", () => {
    const state = stateWithNeedle();
    const packet = compileRealtimeContextPacket({
      state, capabilityCatalogDigest: H("b"), capabilityEpoch: 9,
      capabilities: [{ name: "get_flow_state", description: "Recover state" }],
      recentAudibleTurns: [], byteBudget: 2_048,
    });
    expect(packet.value.authority).toEqual({
      conversationHeadSha256: state.headHash,
      conversationRevision: state.eventCount,
      policyEpoch: 1,
      capabilityEpoch: 9,
      capabilityCatalogDigest: H("b"),
    });
  });

  it("fails closed when mandatory control state cannot fit", () => {
    expect(() => compileRealtimeContextPacket({
      state: stateWithNeedle(20), capabilityCatalogDigest: H("c"), capabilityEpoch: 1,
      capabilities: [{ name: "get_flow_state", description: "Recover state" }],
      recentAudibleTurns: [], byteBudget: 1_024,
    })).toThrow(ContextProjectionOverflowError);
  });

  it("rejects duplicate capabilities and non-audible ordering", () => {
    const base = { state: stateWithNeedle(), capabilityCatalogDigest: H("d"), capabilityEpoch: 1, byteBudget: 2_048 };
    expect(() => compileRealtimeContextPacket({
      ...base,
      capabilities: [{ name: "lookup", description: "one" }, { name: "lookup", description: "two" }],
      recentAudibleTurns: [],
    })).toThrow(/unique identities/);
    expect(() => compileRealtimeContextPacket({
      ...base, capabilities: [],
      recentAudibleTurns: [
        { turnId: "later", speaker: "caller", text: "later", heardAtMs: 2 },
        { turnId: "earlier", speaker: "agent", text: "earlier", heardAtMs: 1 },
      ],
    })).toThrow(/oldest to newest/);
  });
});
