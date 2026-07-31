import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ q: vi.fn() }));

vi.mock("../db", () => ({ q: mocks.q }));
vi.mock("../conversation-call-coordinator-postgres", () => ({
  createPostgresConversationCallCoordinator: () => ({}),
}));
vi.mock("../conversation-runtime-postgres", () => ({
  createPostgresConversationRuntime: () => ({}),
}));
vi.mock("../live-conversation-route", () => ({
  defineLiveConversationRoute: () => ({ prepare: vi.fn() }),
}));
vi.mock("../voice-workers/store", () => ({
  GovernedWorkerResultNotApplicableError: class extends Error {},
  applyGovernedDurableConversationInboxMessage: vi.fn(),
  applyGovernedDurableConversationTerminalMessage: vi.fn(),
  claimDurableConversationInbox: vi.fn(),
  ensureDurableVoiceConversation: vi.fn(),
  loadDurableVoiceWorker: vi.fn(),
}));

import { recentAudibleTurnsForCall } from "../live-conversation-route-postgres";

describe("Postgres reconnect audible history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves both caller and already-journaled agent turns in chronological order", async () => {
    mocks.q.mockImplementation(async (sql: string) => {
      expect(sql).toContain("type IN ('user_said','agent_said')");
      expect(sql).toMatch(/ORDER BY id DESC[\s\S]*LIMIT 128[\s\S]*ORDER BY event\.id ASC/);
      return [
        {
          id: 41,
          type: "user_said",
          text: "I need help with my membership.",
          ts: "2026-07-28T19:00:00.000Z",
        },
        {
          id: 42,
          type: "agent_said",
          text: "I can help with that.",
          ts: "2026-07-28T19:00:01.000Z",
        },
      ];
    });

    await expect(recentAudibleTurnsForCall(
      "8916eb0a-5332-4f4c-a330-746c516e83b9",
    )).resolves.toEqual([
      {
        turnId: "call-event-41",
        speaker: "caller",
        text: "I need help with my membership.",
        deliveryEvidence: "caller_input_transcript",
        heardAtMs: Date.parse("2026-07-28T19:00:00.000Z"),
      },
      {
        turnId: "call-event-42",
        speaker: "agent",
        text: "I can help with that.",
        deliveryEvidence: "provider_transcript_unverified_playback",
        heardAtMs: Date.parse("2026-07-28T19:00:01.000Z"),
      },
    ]);
  });

  it("never upgrades a possibly interrupted agent transcript to caller-heard evidence", async () => {
    mocks.q.mockResolvedValue([{
      id: 77,
      type: "agent_said",
      text: "This suffix may have been cut off by barge-in.",
      ts: "2026-07-28T19:01:00.000Z",
    }]);

    const turns = await recentAudibleTurnsForCall(
      "8916eb0a-5332-4f4c-a330-746c516e83b9",
    );
    expect(turns).toEqual([expect.objectContaining({
      speaker: "agent",
      deliveryEvidence: "provider_transcript_unverified_playback",
    })]);
    expect(turns).not.toEqual([expect.objectContaining({
      deliveryEvidence: "playback_acknowledged",
    })]);
  });
});
