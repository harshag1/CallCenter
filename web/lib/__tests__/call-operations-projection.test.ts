import { describe, expect, it } from "vitest";
import {
  projectCallOperations,
  type CallOperationsProjectionInput,
} from "../call-operations-projection";
import type { NormalizedRealtimeEvent, RealtimeWireObservation } from "../realtime/client/types";
import type { ConversationState } from "../conversation-kernel";
import type { FlowExecutionState } from "../flow-runtime";
import type { DurableVoiceWorker } from "../voice-workers/store";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const REDACTION_KEY = "tenant-secret-at-least-16-bytes";

type EventInput<T = NormalizedRealtimeEvent> = T extends NormalizedRealtimeEvent
  ? Omit<T, "provider" | "receivedAtMs" | "wireType">
  : never;

function event(
  value: EventInput,
  receivedAtMs: number,
  receivedAtMonotonicMs: number,
): NormalizedRealtimeEvent {
  return {
    provider: "openai",
    receivedAtMs,
    receivedAtMonotonicMs,
    wireType: `test.${value.type}`,
    ...value,
  } as NormalizedRealtimeEvent;
}

function wire(
  direction: "inbound" | "outbound",
  sequence: number,
  observedAtMs: number,
  payloadBytes: number,
): RealtimeWireObservation {
  return {
    schemaVersion: 1,
    provider: "openai",
    direction,
    connectionEpoch: 2,
    sequence,
    observedAtMs,
    observedAtMonotonicMs: observedAtMs,
    wireType: `wire.${direction}`,
    payloadSha256: HASH_A,
    payloadBytes,
    projectionSha256: HASH_B,
    previousObservationSha256: sequence === 1 ? null : HASH_A,
    observationSha256: sequence === 1 ? HASH_B : HASH_C,
    identities: {},
    projection: {},
  };
}

function conversationState(): ConversationState {
  return {
    facts: [],
    goals: [],
    currentGoal: null,
    commitments: [],
    policy: { epoch: 4, invariants: [] },
    flowCheckpoints: [],
    currentFlowCheckpoint: null,
    workers: [{
      workerId: "worker-secret",
      goalId: "goal-1",
      purpose: "private research objective",
      policyEpoch: 3,
      dependencies: [],
      spawnedSequence: 1,
      status: "running",
    }],
    deliveries: [],
    acceptedWorkerFacts: [],
    advisories: [],
    headHash: HASH_A,
    eventCount: 12,
  };
}

function flowState(): NonNullable<CallOperationsProjectionInput["flowState"]> {
  return {
    capabilityEpoch: 5,
    revision: 8,
    actionReceipts: [
      {
        id: "receipt-secret",
        idempotencyKey: "idempotency-secret",
        step: "private-step",
        tool: "charge_private_card",
        capabilityEpoch: 6,
        arguments: { card: "4111111111111111" },
        argumentsHash: HASH_A,
        invocationId: "abcdefghijklmnopqrstuvwx",
        dispatchStartedAt: "2026-07-28T11:59:50.000Z",
        dispatchAttempt: 2,
        status: "indeterminate",
        error: "provider leaked sensitive detail",
        reservedAt: "2026-07-28T11:59:49.000Z",
        settledAt: "2026-07-28T11:59:55.000Z",
      },
      {
        id: "receipt-settled",
        idempotencyKey: "idempotency-settled",
        step: "private-step",
        tool: "lookup_private_record",
        capabilityEpoch: 5,
        arguments: {},
        argumentsHash: HASH_B,
        invocationId: "zyxwvutsrqponmlkjihgfedc",
        dispatchStartedAt: "2026-07-28T11:59:40.000Z",
        dispatchAttempt: 1,
        status: "succeeded",
        result: { secret: "hidden" },
        resultHash: HASH_C,
        reservedAt: "2026-07-28T11:59:39.000Z",
        settledAt: "2026-07-28T11:59:40.900Z",
      },
    ] as FlowExecutionState["actionReceipts"],
  };
}

function durableWorker(): DurableVoiceWorker {
  return {
    id: "worker-secret",
    conversationId: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000002",
    parentWorkerId: null,
    sourceCallId: "00000000-0000-4000-8000-000000000003",
    idempotencyKey: "worker-idempotency-secret",
    workerKind: "private_research",
    authority: {
      v: 1,
      conversationId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
      agentId: "00000000-0000-4000-8000-000000000004",
      agentVersion: 1,
      source: "voice_call",
      sourceCallId: "00000000-0000-4000-8000-000000000003",
      conversationHeadSha256: HASH_A,
      conversationRevision: 10,
      goalId: "goal-1",
      policyEpoch: 3,
      factDependencies: [],
      capabilityManifestSha256: HASH_B,
    },
    authoritySha256: HASH_A,
    input: { v: 1, objective: "private objective", context: {}, deliverable: "private deliverable" },
    inputSha256: HASH_B,
    capabilityManifest: { v: 1, mode: "read_only", capabilities: ["web.read"], networkOrigins: [] },
    capabilityManifestSha256: HASH_B,
    status: "running",
    ownerToken: "private-owner-token",
    leaseExpiresAt: "2026-07-28T11:59:59.000Z",
    dispatchStartedAt: "2026-07-28T11:59:00.000Z",
    cancellationEpoch: 1,
    claimedCancellationEpoch: 0,
    checkpoint: { private: "checkpoint" },
    checkpointSha256: HASH_C,
    result: null,
    resultSha256: null,
    error: { private: "worker error" },
    createdAt: "2026-07-28T11:58:00.000Z",
    settledAt: null,
  };
}

function contextPacket() {
  const value = {
    schemaVersion: 1 as const,
    trustBoundary: {
      envelope: "host_authored" as const,
      authorityAndDurableControlState: "host_authoritative" as const,
      workerInputAndResultContent: "untrusted_advisory" as const,
      modelAdvisories: "untrusted_advisory" as const,
      recentAudibleTurnText: "untrusted_advisory" as const,
    },
    authority: {
      conversationHeadSha256: HASH_A,
      conversationRevision: 11,
      policyEpoch: 3,
      capabilityEpoch: 4,
      capabilityCatalogDigest: HASH_C,
    },
    durable: {
      schemaVersion: 1 as const,
      policyEpoch: 3,
      invariants: [],
      authoritativeFacts: [],
      currentGoal: null,
      currentFlowCheckpoint: null,
      openCommitments: [],
      currentGoalWorkers: [],
      omittedTerminalWorkerCount: 0,
      acceptedWorkerFacts: [],
      recentAdvisoryEpisodes: [],
    },
    capabilities: [],
    recentAudibleTurns: [],
    omittedRecentTurnCount: 7,
  };
  const serialized = JSON.stringify(value);
  return { value, serialized, byteLength: Buffer.byteLength(serialized, "utf8") };
}

describe("projectCallOperations", () => {
  it("joins operational truth while excluding transcript, argument, result, and error content", () => {
    const realtimeEvents: NormalizedRealtimeEvent[] = [
      event({
        type: "session.ready",
        sessionId: "provider-session-secret",
        wireObservation: {
          availability: "observed",
          connectionEpoch: 2,
          sequence: 1,
          observationSha256: HASH_A,
          payloadSha256: HASH_B,
          projectionSha256: HASH_C,
        },
      }, NOW - 2_000, 1_000),
      event({ type: "response.started", responseId: "response-secret" }, NOW - 1_800, 1_100),
      event({
        type: "input.transcript",
        phase: "final",
        text: "my social security number is private",
      }, NOW - 1_700, 1_200),
      event({
        type: "output.audio",
        responseId: "response-secret",
        audio: new Uint8Array([1, 2, 3]),
        format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      }, NOW - 1_550, 1_350),
      event({
        type: "response.completed",
        responseId: "response-secret",
        status: "completed",
      }, NOW - 1_000, 1_900),
      event({
        type: "usage",
        responseId: "response-secret",
        usage: {
          inputAudioTokens: 20,
          outputAudioTokens: 10,
          totalTokens: 30,
          raw: { private_provider_payload: "must not leak" },
        },
      }, NOW - 900, 2_000),
      event({
        type: "connection.closed",
        code: 1006,
        reason: "private close reason",
        clean: false,
        transportDiagnostic: {
          schemaVersion: 1,
          origin: "websocket_close",
          category: "network",
          messageSha256: HASH_A,
          responseGenerationRequested: true,
          responseGenerationStarted: true,
          responseTerminalObserved: true,
        },
        wireObservation: {
          availability: "observed",
          connectionEpoch: 2,
          sequence: 2,
          observationSha256: HASH_B,
          payloadSha256: HASH_C,
          projectionSha256: HASH_A,
        },
      }, NOW - 500, 2_400),
    ];
    const projection = projectCallOperations({
      callId: "call-secret",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      realtimeEvents,
      wireObservations: [
        wire("outbound", 1, NOW - 2_100, 400),
        wire("inbound", 2, NOW - 2_000, 700),
      ],
      conversationState: conversationState(),
      flowState: flowState(),
      policyDecisions: [{
        stage: "pre_dispatch",
        observedAtMs: NOW - 10_000,
        decision: {
          decision: "deny",
          reason: "fresh_confirmation_required",
          action: "charge_private_card",
          effect: "write",
          policy_digest: HASH_A,
          state_head_sha256: HASH_A,
          state_revision: 1,
          capability_epoch: 5,
          arguments_sha256: HASH_B,
          proposal_digest: HASH_C,
          challenge_digest: null,
          evidence_sha256: [],
          decision_digest: HASH_A,
        },
      }],
      durableWorkers: [durableWorker()],
      contextPackets: [{ observedAtMs: NOW - 1_000, packet: contextPacket() }],
      costObservations: [
        { scopeId: "provider-response-secret", source: "estimated", microUsd: 500, observedAtMs: NOW - 500 },
        { scopeId: "provider-response-secret", source: "provider_reported", microUsd: 450, observedAtMs: NOW - 400 },
      ],
    });

    expect(projection).toMatchObject({
      providers: ["openai"],
      connections: {
        count: 1,
        closed: 1,
        uncleanClosed: 1,
        epochs: [{
          provider: "openai",
          epoch: 2,
          inboundFrames: 1,
          outboundFrames: 1,
          inboundBytes: 700,
          outboundBytes: 400,
          failureCategory: "network",
        }],
      },
      authority: {
        conversationRevision: 12,
        policyEpoch: 4,
        capabilityEpoch: 5,
        observedPolicyEpochs: [3, 4],
        observedCapabilityEpochs: [4, 5, 6],
        drift: [
          "packet_capability_vs_flow",
          "packet_policy_vs_kernel",
          "receipt_capability_ahead",
          "worker_policy_stale",
        ],
      },
      policy: {
        observations: 1,
        denials: 1,
        byDecision: { deny: 1 },
        recentDenials: [{ reasonCode: "fresh_confirmation_required" }],
      },
      actions: {
        total: 2,
        byStatus: { indeterminate: 1, succeeded: 1 },
        indeterminate: [{ ageMs: 10_000, dispatchAttempt: 2 }],
      },
      workers: {
        total: 1,
        byStatus: { running: 1 },
        items: [{
          status: "running",
          kernelStatus: "running",
          staleAuthority: true,
          leaseState: "expired",
          checkpointPresent: true,
          errorPresent: true,
        }],
      },
      context: {
        packetCount: 1,
        omittedRecentTurns: 7,
        maximumOmittedRecentTurns: 7,
      },
      latencyMs: {
        firstOutput: { count: 1, p50: 250 },
        responseCompletion: { count: 1, p50: 800 },
        actionSettlement: { count: 2, p50: 900, max: 5_000 },
      },
      usage: {
        eventCount: 1,
        inputAudioTokens: 20,
        outputAudioTokens: 10,
        totalTokens: 30,
      },
      cost: {
        scopeCount: 1,
        coverage: "mixed",
        estimatedMicroUsd: 500,
        providerReportedMicroUsd: 450,
        reconciledMicroUsd: null,
        settledMicroUsd: null,
      },
    });
    expect(projection.attention).toEqual([
      "authority_drift",
      "connection_failure",
      "context_turns_omitted",
      "cost_not_reconciled",
      "indeterminate_action",
      "policy_denial",
      "unclean_connection_close",
    ]);

    const serialized = JSON.stringify(projection);
    for (const secret of [
      "call-secret",
      "provider-session-secret",
      "response-secret",
      "social security",
      "charge_private_card",
      "4111111111111111",
      "provider leaked sensitive detail",
      "private_provider_payload",
      "private research objective",
      "private-owner-token",
      "private close reason",
      "provider-response-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("is deterministic per redaction key and deduplicates wire evidence", () => {
    const observation = wire("inbound", 1, NOW, 123);
    const base = {
      callId: "call-1",
      generatedAtMs: NOW,
      wireObservations: [observation, observation],
    };
    const first = projectCallOperations({ ...base, redactionKey: REDACTION_KEY });
    const replay = projectCallOperations({ ...base, redactionKey: REDACTION_KEY });
    const isolated = projectCallOperations({ ...base, redactionKey: "another-tenant-secret-key" });

    expect(replay).toEqual(first);
    expect(first.connections.epochs[0]).toMatchObject({ inboundFrames: 1, inboundBytes: 123 });
    expect(isolated.callKey).not.toBe(first.callKey);
  });

  it("hashes unknown lowercase policy reasons instead of mistaking them for safe codes", () => {
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      policyDecisions: [{
        stage: "pre_dispatch",
        observedAtMs: NOW,
        decision: {
          decision: "deny",
          reason: "customer_secret_phrase",
          action: "private_action",
          effect: "write",
          policy_digest: HASH_A,
          state_head_sha256: HASH_A,
          state_revision: 1,
          capability_epoch: 1,
          arguments_sha256: HASH_B,
          proposal_digest: HASH_C,
          challenge_digest: null,
          evidence_sha256: [],
          decision_digest: HASH_A,
        },
      }],
    });

    expect(projection.policy.recentDenials[0].reasonCode).toBeNull();
    expect(projection.policy.recentDenials[0].reasonSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(projection)).not.toContain("customer_secret_phrase");
    expect(JSON.stringify(projection)).not.toContain("private_action");
  });

  it("settles cost only when every scope has an explicit reconciliation observation", () => {
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      costObservations: [
        { scopeId: "turn-1", source: "reconciled", microUsd: 100, observedAtMs: NOW - 3 },
        { scopeId: "turn-1", source: "reconciled", microUsd: 90, observedAtMs: NOW - 2 },
        { scopeId: "turn-2", source: "reconciled", microUsd: 200, observedAtMs: NOW - 1 },
      ],
    });

    expect(projection.cost).toEqual({
      scopeCount: 2,
      coverage: "reconciled",
      estimatedMicroUsd: null,
      providerReportedMicroUsd: null,
      reconciledMicroUsd: 290,
      settledMicroUsd: 290,
    });
    expect(projection.attention).not.toContain("cost_not_reconciled");
  });

  it("keeps the newest cumulative usage meter and projects kernel-only workers", () => {
    const state = conversationState();
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      conversationState: {
        ...state,
        workers: [{
          workerId: "kernel-only-worker",
          goalId: "goal-1",
          purpose: "content must remain private",
          policyEpoch: 4,
          dependencies: [],
          spawnedSequence: 2,
          status: "completed",
        }],
      },
      realtimeEvents: [
        event({
          type: "usage",
          scope: "session",
          usage: { totalTokens: 100, inputAudioMinutes: 1, raw: {} },
        }, NOW - 2, 100),
        event({
          type: "usage",
          scope: "session",
          usage: { totalTokens: 140, inputAudioMinutes: 1.5, raw: {} },
        }, NOW - 1, 101),
      ],
    });

    expect(projection.usage).toMatchObject({
      eventCount: 1,
      totalTokens: 140,
      inputAudioMinutes: 1.5,
    });
    expect(projection.workers).toMatchObject({
      total: 1,
      byStatus: { completed: 1 },
      items: [{
        status: "completed",
        kernelStatus: "completed",
        deliveryState: "delivered",
        policyEpoch: 4,
      }],
    });
    expect(JSON.stringify(projection)).not.toContain("content must remain private");
  });

  it("projects active-source freshness, complete summaries, and keyed recovery without raw identities", () => {
    const projection = projectCallOperations({
      callId: "private-call",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      callStatus: "active",
      sourceStaleAfterMs: 60_000,
      sourceObservations: [
        { source: "flow", observedAtMs: NOW - 1_000 },
        { source: "conversation", observedAtMs: NOW - 120_000 },
        { source: "workers", observedAtMs: null },
        { source: "policy", observedAtMs: NOW - 2_000 },
      ],
      durableWorkers: [durableWorker()],
      durableWorkerIds: ["worker-secret", "durable-worker-2", "durable-worker-3"],
      durableWorkerSummary: {
        total: 3,
        byStatus: { running: 1, succeeded: 2 },
        byDeliveryState: { not_settled: 1, awaiting_delivery: 2 },
      },
      policyDecisions: [],
      policySummary: { observations: 4, denials: 1, byDecision: { allow: 3, deny: 1 } },
      recoveryObservations: [{
        kind: "worker_reclaimed",
        subjectId: "private-worker-id",
        observedAtMs: NOW - 500,
      }],
      recoverySummary: {
        observations: 3,
        byKind: { action_reconciled: 2, worker_reclaimed: 1 },
        lastObservedAtMs: NOW - 500,
      },
    });

    expect(projection.freshness).toMatchObject({
      active: true,
      staleAfterMs: 60_000,
      maximumAgeMs: 120_000,
      staleSources: ["conversation"],
    });
    expect(projection.freshness.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "flow", ageMs: 1_000, state: "current" }),
      expect.objectContaining({ source: "conversation", ageMs: 120_000, state: "stale" }),
      expect.objectContaining({ source: "workers", ageMs: 500, state: "current" }),
    ]));
    expect(projection.workers).toMatchObject({
      total: 3,
      byStatus: { running: 1, succeeded: 2 },
    });
    expect(projection.policy).toMatchObject({
      observations: 4,
      denials: 1,
      byDecision: { allow: 3, deny: 1 },
    });
    expect(projection.recovery).toMatchObject({
      observations: 3,
      byKind: { action_reconciled: 2, worker_reclaimed: 1 },
      lastObservedAtMs: NOW - 500,
      recent: [{ kind: "worker_reclaimed", observedAtMs: NOW - 500 }],
    });
    expect(projection.recovery.recent[0].subjectKey).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.attention).toEqual(expect.arrayContaining([
      "policy_denial",
      "stale_operations_source",
    ]));
    expect(JSON.stringify(projection)).not.toContain("private-worker-id");
    expect(JSON.stringify(projection)).not.toContain("private-call");
  });

  it("forms an exact durable/kernel union when overlap falls outside the 256-item detail window", () => {
    const durableDetails = Array.from({ length: 256 }, (_, index) => ({
      ...durableWorker(),
      id: `durable-detail-${index + 1}`,
    }));
    const durableWorkerIds = [
      "durable-hidden-overlap",
      ...durableDetails.map(({ id }) => id),
    ];
    const state = conversationState();
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      conversationState: {
        ...state,
        workers: [
          {
            workerId: "durable-hidden-overlap",
            goalId: "goal-1",
            purpose: "hidden overlap",
            policyEpoch: 4,
            dependencies: [],
            spawnedSequence: 2,
            status: "running",
          },
          {
            workerId: "kernel-only-worker",
            goalId: "goal-1",
            purpose: "kernel only",
            policyEpoch: 4,
            dependencies: [],
            spawnedSequence: 3,
            status: "completed",
          },
        ],
      },
      durableWorkers: durableDetails,
      durableWorkerIds,
      durableWorkerSummary: {
        total: 257,
        byStatus: { running: 257 },
        byDeliveryState: { not_settled: 257 },
      },
    });

    expect(projection.workers).toMatchObject({
      total: 258,
      byStatus: { completed: 1, running: 257 },
    });
    expect(projection.workers.items).toHaveLength(256);
    expect(JSON.stringify(projection)).not.toContain("durable-hidden-overlap");
    expect(JSON.stringify(projection)).not.toContain("kernel-only-worker");
  });

  it("keeps action and worker attention exact when the relevant item is outside the detail windows", () => {
    const durableDetails = Array.from({ length: 256 }, (_, index) => ({
      ...durableWorker(),
      id: `durable-current-${index + 1}`,
    }));
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      flowState: {
        capabilityEpoch: 5,
        revision: 9,
        actionReceipts: [],
      },
      actionSummary: {
        total: 300,
        byStatus: { succeeded: 299, indeterminate: 1 },
        maxCapabilityEpoch: 6,
      },
      durableWorkers: durableDetails,
      durableWorkerIds: [
        ...durableDetails.map(({ id }) => id),
        "durable-older-undelivered",
      ],
      durableWorkerSummary: {
        total: 257,
        byStatus: { running: 256, succeeded: 1 },
        byDeliveryState: { not_settled: 256, awaiting_delivery: 1 },
      },
    });

    expect(projection.actions).toMatchObject({
      total: 300,
      byStatus: { succeeded: 299, indeterminate: 1 },
      indeterminate: [],
    });
    expect(projection.workers).toMatchObject({
      total: 257,
      byDeliveryState: { not_settled: 256, awaiting_delivery: 1 },
    });
    expect(projection.attention).toEqual(expect.arrayContaining([
      "indeterminate_action",
      "authority_drift",
      "worker_delivery_pending",
    ]));
  });

  it("fails closed without an exact durable identity index behind a bounded detail window", () => {
    expect(() => projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      conversationState: conversationState(),
      durableWorkers: [durableWorker()],
      durableWorkerSummary: {
        total: 2,
        byStatus: { running: 2 },
        byDeliveryState: { not_settled: 2 },
      },
    })).toThrow(/complete durable worker identity index/);

    expect(() => projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      durableWorkers: [durableWorker()],
      durableWorkerIds: ["another-worker"],
      durableWorkerSummary: { total: 1, byStatus: { running: 1 } },
    })).toThrow(/omits a projected worker item/);

    expect(() => projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      durableWorkerIds: Array.from({ length: 10_001 }, (_, index) => `worker-${index}`),
      durableWorkerSummary: {
        total: 10_001,
        byStatus: { running: 10_001 },
        byDeliveryState: { not_settled: 10_001 },
      },
    })).toThrow(/exceeds 10000/);
  });

  it("advances source freshness from later recovery evidence instead of regressing to an older snapshot clock", () => {
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      callStatus: "active",
      sourceStaleAfterMs: 60_000,
      sourceObservations: [
        { source: "flow", observedAtMs: NOW - 120_000 },
        { source: "workers", observedAtMs: NOW - 180_000 },
      ],
      recoveryObservations: [
        {
          kind: "action_reconciled",
          subjectId: "receipt-1",
          observedAtMs: NOW - 1_000,
        },
        {
          kind: "worker_checkpointed",
          subjectId: "worker-1",
          observedAtMs: NOW - 2_000,
        },
        {
          kind: "worker_reclaimed",
          subjectId: "worker-1",
          observedAtMs: NOW - 500,
        },
      ],
    });

    expect(projection.freshness.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "flow", observedAtMs: NOW - 1_000, ageMs: 1_000, state: "current" }),
      expect.objectContaining({ source: "workers", observedAtMs: NOW - 500, ageMs: 500, state: "current" }),
    ]));
    expect(projection.freshness.staleSources).not.toContain("flow");
    expect(projection.freshness.staleSources).not.toContain("workers");
  });

  it("treats terminal source observations as settled and rejects contradictory summaries", () => {
    const settled = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      callStatus: "completed",
      sourceObservations: [{ source: "flow", observedAtMs: NOW - 900_000 }],
    });
    expect(settled.freshness.sources.find(({ source }) => source === "flow")?.state).toBe("settled");
    expect(settled.attention).not.toContain("stale_operations_source");

    expect(() => projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      durableWorkers: [durableWorker()],
      durableWorkerSummary: { total: 1, byStatus: { succeeded: 1 } },
    })).toThrow(/summary contradicts/);
  });

  it("keeps dialing calls freshness-sensitive", () => {
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      callStatus: "dialing",
      sourceStaleAfterMs: 60_000,
      sourceObservations: [{ source: "flow", observedAtMs: NOW - 900_000 }],
    });

    expect(projection.freshness).toMatchObject({
      callStatus: "dialing",
      active: true,
      staleSources: ["flow"],
    });
    expect(projection.freshness.sources.find(({ source }) => source === "flow")?.state).toBe("stale");
    expect(projection.attention).toContain("stale_operations_source");
  });

  it("maps arbitrary call lifecycle content to a closed public status", () => {
    const privateStatus = "customer-email-and-provider-debug-detail";
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      callStatus: privateStatus,
      sourceObservations: [{ source: "flow", observedAtMs: NOW - 900_000 }],
    });

    expect(projection.freshness).toMatchObject({
      callStatus: "redacted_unknown",
      active: false,
      staleSources: ["flow"],
    });
    expect(projection.freshness.sources.find(({ source }) => source === "flow")?.state).toBe("stale");
    expect(projection.attention).toContain("stale_operations_source");
    expect(JSON.stringify(projection)).not.toContain(privateStatus);
  });

  it("redacts arbitrary worker detail and aggregate status labels", () => {
    const privateDetailStatus = "caller_secret_phrase";
    const privateAggregateStatus = "customer_email_in_status";
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      durableWorkers: [{
        ...durableWorker(),
        status: privateDetailStatus,
      }],
      durableWorkerIds: [
        "worker-secret",
        "omitted-worker-1",
        "omitted-worker-2",
      ],
      durableWorkerSummary: {
        total: 3,
        byStatus: {
          [privateDetailStatus]: 1,
          [privateAggregateStatus]: 2,
        },
        byDeliveryState: { not_settled: 3 },
      },
    });

    expect(projection.workers).toMatchObject({
      total: 3,
      byStatus: { redacted_unknown: 3 },
      items: [expect.objectContaining({ status: "redacted_unknown" })],
    });
    const encoded = JSON.stringify(projection);
    expect(encoded).not.toContain(privateDetailStatus);
    expect(encoded).not.toContain(privateAggregateStatus);
  });

  it("surfaces unavailable epochs without granting fresh worker authority", () => {
    const state = flowState();
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      flowState: {
        ...state,
        capabilityEpoch: null,
      },
      durableWorkers: [{
        ...durableWorker(),
        authority: {
          ...durableWorker().authority,
          policyEpoch: null,
        },
      }],
    });

    expect(projection.authority).toMatchObject({
      capabilityEpoch: null,
      drift: expect.arrayContaining(["flow_capability_unavailable"]),
    });
    expect(projection.workers.items[0]).toMatchObject({
      policyEpoch: null,
      staleAuthority: true,
    });
    expect(projection.attention).toContain("authority_drift");
  });

  it("keeps the materialized SQL head authoritative while flagging an older realtime packet", () => {
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      conversationAuthority: {
        kind: "materialized_head",
        revision: 12,
        headSha256: HASH_B,
        snapshotCapturedAtMs: NOW,
        eventRowsRead: 0,
      },
      contextPackets: [{ observedAtMs: NOW - 1, packet: contextPacket() }],
    });

    expect(projection.authority).toMatchObject({
      conversationRevision: 12,
      conversationHeadSha256: HASH_B,
      drift: expect.arrayContaining(["packet_conversation_vs_materialized"]),
    });
    expect(projection.attention).toContain("authority_drift");
  });

  it("rejects malformed authority epochs and oversized tool identities", () => {
    const state = flowState();
    expect(() => projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      flowState: {
        ...state,
        capabilityEpoch: -1,
      },
    })).toThrow(/authority epoch/);

    expect(() => projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      flowState: {
        ...state,
        actionReceipts: state.actionReceipts.map((receipt, index) => ({
          ...receipt,
          tool: index === 0 ? "x".repeat(257) : receipt.tool,
        })),
      },
    })).toThrow(/tool identity/);
  });

  it("redacts arbitrary policy and recovery aggregate labels", () => {
    const privatePolicyLabel = "caller_secret_policy";
    const privateRecoveryLabel = "caller_secret_recovery";
    const projection = projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      policySummary: {
        observations: 2,
        denials: 1,
        byDecision: {
          allow: 1,
          [privatePolicyLabel]: 1,
        },
      },
      recoverySummary: {
        observations: 1,
        byKind: { [privateRecoveryLabel]: 1 },
        lastObservedAtMs: NOW - 1_000,
      },
    });

    expect(projection.policy.byDecision).toEqual({
      allow: 1,
      redacted_unknown: 1,
    });
    expect(projection.recovery.byKind).toEqual({ redacted_unknown: 1 });
    const encoded = JSON.stringify(projection);
    expect(encoded).not.toContain(privatePolicyLabel);
    expect(encoded).not.toContain(privateRecoveryLabel);
  });

  it("fails closed for weak redaction keys and invalid packet byte evidence", () => {
    expect(() => projectCallOperations({
      callId: "call-1",
      redactionKey: "weak",
      generatedAtMs: NOW,
    })).toThrow("at least 16 bytes");

    const packet = contextPacket();
    expect(() => projectCallOperations({
      callId: "call-1",
      redactionKey: REDACTION_KEY,
      generatedAtMs: NOW,
      contextPackets: [{ observedAtMs: NOW, packet: { ...packet, byteLength: packet.byteLength + 1 } }],
    })).toThrow("byte evidence");
  });
});
