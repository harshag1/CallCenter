import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  spawn: vi.fn(),
  createRuntime: vi.fn(),
}));
vi.mock("../flow-state-store", () => ({
  reserveGovernedFlowActionAtomic: mocks.reserve,
}));
vi.mock("../voice-workers/store", () => ({
  spawnGovernedDurableVoiceWorker: mocks.spawn,
}));
vi.mock("../conversation-runtime-postgres", () => ({
  createPostgresConversationRuntime: mocks.createRuntime,
}));

import {
  appendConversationEvents,
  createConversationLog,
  foldConversation,
} from "../conversation-kernel";
import { createFlowCheckpointEvent } from "../flow-conversation-adapter";
import { createFlowExecutionState } from "../flow-runtime";
import { createGovernedCallActionAuthority } from "../conversation-call-coordinator-postgres";
import type { AgentFlow } from "../flow";

const runtimeDigest = "a".repeat(64);

function state() {
  const flowState = {
    ...createFlowExecutionState("2027-01-15T08:00:00.000Z"),
    status: "active" as const,
    nodeId: "membership",
    currentStep: "membership.lookup",
    capabilityEpoch: 2,
    revision: 3,
  };
  const log = appendConversationEvents(createConversationLog("conversation-1"), [
    {
      eventId: "goal",
      occurredAtMs: 1,
      payload: {
        type: "goal.activated",
        goalId: "membership",
        description: "Resolve membership",
      },
    },
    createFlowCheckpointEvent({
      eventId: "checkpoint",
      occurredAtMs: 2,
      goalId: "membership",
      runtimeDigest,
      state: flowState,
    }),
  ]);
  return foldConversation(log);
}

describe("PostgreSQL ConversationCallCoordinator composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reserve.mockResolvedValue({
      policy: {
        decision: "allow",
        reason: "fixture",
        action: "membership.lookup",
        effect: "read",
        proposalDigest: "b".repeat(64),
        challengeDigest: null,
        decisionDigest: "c".repeat(64),
        stateRevision: 3,
        capabilityEpoch: 2,
      },
    });
  });

  it("replays stable receipt identity while keeping dispatch-owner leases secret", async () => {
    const conversation = state();
    const port = createGovernedCallActionAuthority();
    const base = {
      scope: { conversationId: "conversation-1", organizationId: "organization-1" },
      turnId: "turn-1",
      operationId: "lookup",
      idempotencyKey: `cc:${"d".repeat(64)}`,
      deterministicUuid: "8ea895b4-52ac-5fd2-b86d-a9c2760fd879",
      conversation: {
        head: { sequence: conversation.eventCount, sha256: conversation.headHash },
        state: conversation,
      },
      request: {
        callId: "call-1",
        flow: {} as AgentFlow,
        arguments: {
          runtimeDigest,
          tool: "membership.lookup",
          arguments: { memberId: "MEM-42" },
          capabilityEpoch: 2,
          policy: {},
          facts: [],
          receipts: [],
        },
      },
    } as const;

    await port.reserve(base);
    await port.reserve(base);

    const first = mocks.reserve.mock.calls[0][2];
    const replay = mocks.reserve.mock.calls[1][2];
    expect(first).toMatchObject({
      receiptId: base.deterministicUuid,
      invocationId: base.idempotencyKey,
    });
    expect(first.ownerToken).toMatch(/^[a-f0-9-]{36}$/);
    expect(replay.ownerToken).toMatch(/^[a-f0-9-]{36}$/);
    expect(replay.ownerToken).not.toBe(first.ownerToken);
  });

  it("rejects action authority that drifts from the durable Flow checkpoint", async () => {
    const conversation = state();
    const port = createGovernedCallActionAuthority();
    await expect(port.reserve({
      scope: { conversationId: "conversation-1", organizationId: "organization-1" },
      turnId: "turn-1",
      operationId: "lookup",
      idempotencyKey: `cc:${"d".repeat(64)}`,
      deterministicUuid: "8ea895b4-52ac-5fd2-b86d-a9c2760fd879",
      conversation: {
        head: { sequence: conversation.eventCount, sha256: conversation.headHash },
        state: conversation,
      },
      request: {
        callId: "call-1",
        flow: {} as AgentFlow,
        arguments: {
          runtimeDigest: "e".repeat(64),
          tool: "membership.lookup",
          arguments: { memberId: "MEM-42" },
          capabilityEpoch: 2,
          policy: {},
          facts: [],
          receipts: [],
        },
      },
    })).rejects.toThrow(/runtime digest/);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
