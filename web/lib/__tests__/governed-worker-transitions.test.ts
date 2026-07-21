import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ q: vi.fn(), qOne: vi.fn() }));
vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));

import {
  GovernedWorkerResultNotApplicableError,
  applyGovernedDurableConversationInboxMessage,
  spawnGovernedDurableVoiceWorker,
  type DurableConversationInboxMessage,
} from "../voice-workers/store";
import {
  prepareVoiceWorkerResult,
} from "../voice-workers/schema";
import {
  appendConversationEvent,
  canonicalJson,
  createConversationLog,
  type ConversationLog,
} from "../conversation-kernel";

const ids = {
  conversation: "8916eb0a-5332-4f4c-a330-746c516e83b9",
  organization: "8916eb0a-5332-4f4c-a330-746c516e83ba",
  agent: "8916eb0a-5332-4f4c-a330-746c516e83bb",
  call: "8916eb0a-5332-4f4c-a330-746c516e83bc",
  message: "8916eb0a-5332-4f4c-a330-746c516e83bd",
  delivery: "8916eb0a-5332-4f4c-a330-746c516e83be",
  application: "8916eb0a-5332-4f4c-a330-746c516e83bf",
};

const manifest = {
  v: 1 as const,
  mode: "read_only" as const,
  capabilities: ["membership.lookup"],
  networkOrigins: ["https://example.com/"],
};
const workerInput = {
  v: 1 as const,
  objective: "Find the caller's current renewal date.",
  context: { memberId: "MEM-42" },
  deliverable: "Return one cited renewal fact.",
};
const result = prepareVoiceWorkerResult({
  v: 1,
  facts: [{ key: "renewal_date", value: "2027-01-02", confidence: 0.99, citationIds: ["membership"] }],
  citations: [{ id: "membership", uri: "https://example.com/member/42", retrievedAt: "2026-07-21T17:00:00.000Z" }],
  proposedActions: [],
  summary: "The membership renews on 2027-01-02.",
});

function eventRow(unsignedEventText: string, eventHash: string, organizationId: string, idempotencyKey: string) {
  const event = JSON.parse(unsignedEventText) as {
    conversationId: string; sequence: number; previousHash: string; eventId: string;
    occurredAtMs: number; payload: { type: string };
  };
  return {
    conversation_id: event.conversationId,
    org_id: organizationId,
    sequence: event.sequence,
    event_id: event.eventId,
    idempotency_key: idempotencyKey,
    occurred_at_ms: event.occurredAtMs,
    event_type: event.payload.type,
    payload: event.payload,
    previous_event_sha256: event.previousHash,
    event_sha256: eventHash,
    unsigned_event_text: unsignedEventText,
  };
}

function validPrefix(): ConversationLog {
  let log = createConversationLog(ids.conversation);
  const append = (eventId: string, payload: Parameters<typeof appendConversationEvent>[1]["payload"]) => {
    log = appendConversationEvent(log, { eventId, occurredAtMs: log.events.length + 1, payload });
  };
  for (let epoch = 1; epoch <= 3; epoch += 1) {
    append(`policy-${epoch}`, { type: "policy.advanced", epoch, invariants: [] });
  }
  append("membership-tier", {
    type: "fact.asserted", key: "membership_tier", value: "gold", revision: 1,
    authority: { kind: "system_of_record", issuer: "crm", evidenceId: "member-42", issuedAtMs: 1 },
  });
  append("membership-goal", {
    type: "goal.activated", goalId: "membership_renewal", description: "Help with membership renewal.",
  });
  return log;
}

function logRows(log: ConversationLog) {
  return log.events.map((event) => eventRow(canonicalJson({
    version: event.version,
    conversationId: event.conversationId,
    sequence: event.sequence,
    previousHash: event.previousHash,
    eventId: event.eventId,
    occurredAtMs: event.occurredAtMs,
    payload: event.payload,
  }), event.hash, ids.organization, `fixture:${event.eventId}`));
}

function head(log: ConversationLog) {
  const event = log.events.at(-1)!;
  return { sequence: event.sequence, sha256: event.hash };
}

function workerRow(params: unknown[]) {
  return {
    id: params[6],
    conversation_id: params[0],
    org_id: params[1],
    parent_worker_id: params[16],
    source_call_id: params[15],
    idempotency_key: params[7],
    worker_kind: params[8],
    spawn_authority: JSON.parse(String(params[9])),
    spawn_authority_sha256: params[10],
    worker_input: JSON.parse(String(params[11])),
    worker_input_sha256: params[12],
    capability_manifest: JSON.parse(String(params[13])),
    capability_manifest_sha256: params[14],
    status: "pending",
    owner_token: null,
    lease_expires_at: null,
    dispatch_started_at: null,
    cancellation_epoch: 0,
    claimed_cancellation_epoch: null,
    checkpoint: null,
    checkpoint_sha256: null,
    result: null,
    result_sha256: null,
    error: null,
    created_at: "2026-07-21T17:00:00.000Z",
    settled_at: null,
  };
}

describe("governed worker transition store", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives post-append worker authority and submits one atomic spawn transition", async () => {
    let prefix = validPrefix();
    mocks.qOne.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes("read_voice_conversation_head")) return Promise.resolve({
        head_sequence: prefix.events.length, head_sha256: prefix.events.at(-1)!.hash,
      });
      if (!prefix.events.some(({ hash }) => hash === params[5])) {
        const unsigned = JSON.parse(String(params[4])) as {
          eventId: string; occurredAtMs: number; payload: Parameters<typeof appendConversationEvent>[1]["payload"];
        };
        prefix = appendConversationEvent(prefix, {
          eventId: unsigned.eventId, occurredAtMs: unsigned.occurredAtMs, payload: unsigned.payload,
        });
      }
      return Promise.resolve({
        conversation_event: eventRow(String(params[4]), String(params[5]), String(params[1]), String(params[3])),
        worker_job: workerRow(params),
      });
    });
    mocks.q.mockImplementation(() => Promise.resolve(logRows(prefix)));
    const expectedHead = head(prefix);
    const request: Parameters<typeof spawnGovernedDurableVoiceWorker>[0] = {
      expectedHead,
      conversationEvent: { idempotencyKey: "spawn:event:v1", eventId: "worker-spawn-1", occurredAtMs: 1_800_000_000_000 },
      workerIdempotencyKey: "renewal-worker:v1",
      workerKind: "membership.lookup",
      authority: {
        v: 1,
        conversationId: ids.conversation,
        organizationId: ids.organization,
        agentId: ids.agent,
        agentVersion: 1,
        source: "voice_call",
        sourceCallId: ids.call,
        goalId: "membership_renewal",
        policyEpoch: 3,
        factDependencies: [{ key: "membership_tier", revision: 1 }],
      },
      workerInput,
      capabilityManifest: manifest,
      sourceCallId: ids.call,
    };
    const transition = await spawnGovernedDurableVoiceWorker(request);
    const replay = await spawnGovernedDurableVoiceWorker(request);

    expect(transition.event.payload).toMatchObject({
      type: "worker.spawned",
      workerId: transition.worker.id,
      goalId: "membership_renewal",
      purpose: workerInput.objective,
      policyEpoch: 3,
      dependencies: [{ key: "membership_tier", revision: 1 }],
    });
    expect(transition.worker.authority).toMatchObject({
      conversationHeadSha256: transition.event.hash,
      conversationRevision: expectedHead.sequence + 1,
    });
    expect(replay).toEqual(transition);
    const [sql] = mocks.qOne.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("spawn_governed_voice_worker");
    expect(mocks.qOne.mock.calls.filter(([query]) => String(query).includes("spawn_governed_voice_worker"))).toHaveLength(2);
  });

  it("submits an evidence-derived result event and exact application in one transition", async () => {
    let durableLog = validPrefix();
    mocks.qOne.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes("read_voice_conversation_head")) return Promise.resolve({
        head_sequence: durableLog.events.length, head_sha256: durableLog.events.at(-1)!.hash,
      });
      if (sql.includes("spawn_governed_voice_worker")) {
        const unsigned = JSON.parse(String(params[4])) as { eventId: string; occurredAtMs: number; payload: Parameters<typeof appendConversationEvent>[1]["payload"] };
        durableLog = appendConversationEvent(durableLog, {
          eventId: unsigned.eventId, occurredAtMs: unsigned.occurredAtMs, payload: unsigned.payload,
        });
        return Promise.resolve({
          conversation_event: eventRow(String(params[4]), String(params[5]), String(params[1]), String(params[3])),
          worker_job: workerRow(params),
        });
      }
      if (!durableLog.events.some(({ hash }) => hash === params[8])) {
        const unsigned = JSON.parse(String(params[7])) as {
          eventId: string; occurredAtMs: number; payload: Parameters<typeof appendConversationEvent>[1]["payload"];
        };
        durableLog = appendConversationEvent(durableLog, {
          eventId: unsigned.eventId, occurredAtMs: unsigned.occurredAtMs, payload: unsigned.payload,
        });
      }
      return Promise.resolve({
        conversation_event: eventRow(String(params[7]), String(params[8]), String(params[2]), String(params[6])),
        inbox_message: {
          id: ids.message, conversation_id: ids.conversation, worker_id: settledWorkerId,
          source_event_sha256: "b".repeat(64), payload: result.result,
          payload_sha256: result.resultSha256, delivery_token: null, delivery_lease_expires_at: null,
          delivery_count: 1, application_id: ids.application, applied_context_version: "1",
          applied_at: "2026-07-21T17:01:00.000Z", acknowledged_at: "2026-07-21T17:01:00.000Z",
        },
      });
    });
    mocks.q.mockImplementation(() => Promise.resolve(logRows(durableLog)));
    let settledWorkerId = "";
    const spawn = await spawnGovernedDurableVoiceWorker({
      expectedHead: head(durableLog),
      conversationEvent: { idempotencyKey: "spawn:event:v1", eventId: "worker-spawn-1", occurredAtMs: 1_800_000_000_000 },
      workerIdempotencyKey: "renewal-worker:v1",
      workerKind: "membership.lookup",
      authority: {
        v: 1, conversationId: ids.conversation, organizationId: ids.organization,
        agentId: ids.agent, agentVersion: 1, source: "voice_call", sourceCallId: ids.call,
        goalId: "membership_renewal", policyEpoch: 3,
        factDependencies: [{ key: "membership_tier", revision: 1 }],
      },
      workerInput, capabilityManifest: manifest, sourceCallId: ids.call,
    });
    settledWorkerId = spawn.worker.id;
    const settledWorker = { ...spawn.worker, status: "succeeded" as const, result: result.result, resultSha256: result.resultSha256 };
    const message: DurableConversationInboxMessage = {
      id: ids.message,
      conversationId: ids.conversation,
      workerId: spawn.worker.id,
      sourceEventSha256: "b".repeat(64),
      result: result.result,
      resultSha256: result.resultSha256,
      deliveryToken: ids.delivery,
      deliveryLeaseExpiresAt: "2026-07-21T18:00:00.000Z",
      deliveryCount: 1,
      applicationId: null,
      appliedContextVersion: null,
      appliedAt: null,
      acknowledgedAt: null,
    };
    const resultExpectedHead = head(durableLog);
    const applicationRequest: Parameters<typeof applyGovernedDurableConversationInboxMessage>[0] = {
      expectedHead: resultExpectedHead,
      conversationEvent: { idempotencyKey: "result:event:v1", eventId: "worker-result-1", occurredAtMs: 1_800_000_000_001 },
      organizationId: ids.organization,
      deliveryToken: ids.delivery,
      applicationId: ids.application,
      worker: settledWorker,
      message,
    };
    const applied = await applyGovernedDurableConversationInboxMessage(applicationRequest);
    const replay = await applyGovernedDurableConversationInboxMessage(applicationRequest);

    expect(applied.event.payload).toEqual({
      type: "worker.result_delivered",
      deliveryId: ids.message,
      workerId: spawn.worker.id,
      goalId: "membership_renewal",
      policyEpoch: 3,
      dependencyFactRevisions: [{ key: "membership_tier", revision: 1 }],
      facts: [{ key: "renewal_date", value: "2027-01-02", evidenceId: "membership" }],
      advisories: [{ episodeId: `worker-${spawn.worker.id}`, text: result.result.summary }],
    });
    expect(applied.message).toMatchObject({ applicationId: ids.application, acknowledgedAt: expect.any(String) });
    expect(applied.decision.status).toBe("accepted");
    expect(replay).toEqual(applied);
    expect(mocks.qOne.mock.calls.some(([sql]) => String(sql).includes("apply_governed_voice_worker_result"))).toBe(true);
  });

  it("rejects a storage response whose event bytes differ from the request", async () => {
    const prefix = validPrefix();
    mocks.qOne.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes("read_voice_conversation_head")) return Promise.resolve({
        head_sequence: prefix.events.length, head_sha256: prefix.events.at(-1)!.hash,
      });
      return Promise.resolve({
        conversation_event: {
          ...eventRow(String(params[4]), String(params[5]), String(params[1]), String(params[3])),
          idempotency_key: "another-operation",
        },
        worker_job: workerRow(params),
      });
    });
    mocks.q.mockResolvedValue(logRows(prefix));
    await expect(spawnGovernedDurableVoiceWorker({
      expectedHead: head(prefix),
      conversationEvent: { idempotencyKey: "spawn:event:v1", eventId: "worker-spawn-1", occurredAtMs: 1_800_000_000_000 },
      workerIdempotencyKey: "renewal-worker:v1",
      workerKind: "membership.lookup",
      authority: {
        v: 1, conversationId: ids.conversation, organizationId: ids.organization,
        agentId: ids.agent, agentVersion: 1, source: "voice_call", sourceCallId: ids.call,
        goalId: "membership_renewal", policyEpoch: 3, factDependencies: [],
      },
      workerInput, capabilityManifest: manifest, sourceCallId: ids.call,
    })).rejects.toThrow(/different conversation event/);
  });

  it.each([
    ["goal", { goalId: "another_goal" }, /current goal/],
    ["policy", { policyEpoch: 2 }, /current policy epoch/],
    ["dependency", { factDependencies: [{ key: "membership_tier", revision: 2 }] }, /not current/],
  ])("rejects stale spawn %s authority during semantic fold before the transition function", async (_case, mutation, error) => {
    const prefix = validPrefix();
    mocks.qOne.mockImplementation((sql: string) => {
      if (sql.includes("read_voice_conversation_head")) return Promise.resolve({
        head_sequence: prefix.events.length, head_sha256: prefix.events.at(-1)!.hash,
      });
      throw new Error("spawn SQL must not run for stale semantic authority");
    });
    mocks.q.mockResolvedValue(logRows(prefix));
    const authority: Parameters<typeof spawnGovernedDurableVoiceWorker>[0]["authority"] = {
      v: 1, conversationId: ids.conversation, organizationId: ids.organization,
      agentId: ids.agent, agentVersion: 1, source: "voice_call", sourceCallId: ids.call,
      goalId: "membership_renewal", policyEpoch: 3,
      factDependencies: [{ key: "membership_tier", revision: 1 }],
      ...mutation,
    };
    await expect(spawnGovernedDurableVoiceWorker({
      expectedHead: head(prefix),
      conversationEvent: { idempotencyKey: "spawn:stale", eventId: "worker-spawn-stale", occurredAtMs: 1_800_000_000_000 },
      workerIdempotencyKey: "renewal-worker:stale",
      workerKind: "membership.lookup",
      authority,
      workerInput, capabilityManifest: manifest, sourceCallId: ids.call,
    })).rejects.toThrow(error);
    expect(mocks.qOne.mock.calls.filter(([sql]) => String(sql).includes("spawn_governed_voice_worker"))).toHaveLength(0);
  });

  it("leaves a stale result unconsumed so it can be safely redelivered", async () => {
    let durableLog = validPrefix();
    mocks.qOne.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes("read_voice_conversation_head")) return Promise.resolve({
        head_sequence: durableLog.events.length, head_sha256: durableLog.events.at(-1)!.hash,
      });
      if (sql.includes("spawn_governed_voice_worker")) {
        const unsigned = JSON.parse(String(params[4])) as { eventId: string; occurredAtMs: number; payload: Parameters<typeof appendConversationEvent>[1]["payload"] };
        durableLog = appendConversationEvent(durableLog, {
          eventId: unsigned.eventId, occurredAtMs: unsigned.occurredAtMs, payload: unsigned.payload,
        });
        return Promise.resolve({
          conversation_event: eventRow(String(params[4]), String(params[5]), String(params[1]), String(params[3])),
          worker_job: workerRow(params),
        });
      }
      throw new Error("result application SQL must not run for a deferred delivery");
    });
    mocks.q.mockImplementation(() => Promise.resolve(logRows(durableLog)));
    const spawn = await spawnGovernedDurableVoiceWorker({
      expectedHead: head(durableLog),
      conversationEvent: { idempotencyKey: "spawn:deferred", eventId: "worker-spawn-deferred", occurredAtMs: 1_800_000_000_000 },
      workerIdempotencyKey: "renewal-worker:deferred",
      workerKind: "membership.lookup",
      authority: {
        v: 1, conversationId: ids.conversation, organizationId: ids.organization,
        agentId: ids.agent, agentVersion: 1, source: "voice_call", sourceCallId: ids.call,
        goalId: "membership_renewal", policyEpoch: 3,
        factDependencies: [{ key: "membership_tier", revision: 1 }],
      },
      workerInput, capabilityManifest: manifest, sourceCallId: ids.call,
    });
    durableLog = appendConversationEvent(durableLog, {
      eventId: "membership-tier-corrected", occurredAtMs: 1_800_000_000_001,
      payload: {
        type: "fact.corrected", key: "membership_tier", value: "platinum",
        expectedRevision: 1, revision: 2,
        authority: { kind: "system_of_record", issuer: "crm", evidenceId: "member-42-v2", issuedAtMs: 2 },
      },
    });
    const settledWorker = { ...spawn.worker, status: "succeeded" as const, result: result.result, resultSha256: result.resultSha256 };
    const message: DurableConversationInboxMessage = {
      id: ids.message, conversationId: ids.conversation, workerId: spawn.worker.id,
      sourceEventSha256: "b".repeat(64), result: result.result, resultSha256: result.resultSha256,
      deliveryToken: ids.delivery, deliveryLeaseExpiresAt: "2026-07-21T18:00:00.000Z",
      deliveryCount: 1, applicationId: null, appliedContextVersion: null,
      appliedAt: null, acknowledgedAt: null,
    };
    const attempt = applyGovernedDurableConversationInboxMessage({
      expectedHead: head(durableLog),
      conversationEvent: { idempotencyKey: "result:deferred", eventId: "worker-result-deferred", occurredAtMs: 1_800_000_000_002 },
      organizationId: ids.organization, deliveryToken: ids.delivery, applicationId: ids.application,
      worker: settledWorker, message,
    });
    await expect(attempt).rejects.toBeInstanceOf(GovernedWorkerResultNotApplicableError);
    await expect(attempt).rejects.toMatchObject({ decision: { status: "deferred", reason: expect.stringMatching(/fact changed/) } });
    expect(mocks.qOne.mock.calls.filter(([sql]) => String(sql).includes("apply_governed_voice_worker_result"))).toHaveLength(0);
  });
});

describe("034 governed worker migration contract", () => {
  const sql = readFileSync(resolve(process.cwd(), "migrations/034_governed_voice_worker_transitions.sql"), "utf8");

  it("atomically appends before spawning and binds authority to the resulting head", () => {
    expect(sql).toMatch(/append_voice_conversation_events[\s\S]*spawn_voice_worker_job/);
    expect(sql).toMatch(/conversationHeadSha256[\s\S]*event_sha256/);
    expect(sql).toMatch(/conversationRevision[\s\S]*unsigned_event->>'sequence'/);
    expect(sql).toContain("governed_worker_spawn_event_authority_mismatch");
  });

  it("derives the only admissible result event from durable worker evidence", () => {
    expect(sql).toMatch(/message\.payload_sha256 <> worker\.result_sha256/);
    expect(sql).toMatch(/payload IS DISTINCT FROM expected_payload/);
    expect(sql).toMatch(/append_voice_conversation_events[\s\S]*apply_voice_conversation_inbox/);
    expect(sql).toContain("governed_worker_result_application_mismatch");
  });

  it("removes backend bypass grants and exposes only governed transitions", () => {
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.spawn_voice_worker_job[\s\S]*FROM hacc_backend/);
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.apply_voice_conversation_inbox[\s\S]*FROM hacc_backend/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.spawn_governed_voice_worker[\s\S]*TO hacc_backend/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.apply_governed_voice_worker_result[\s\S]*TO hacc_backend/);
  });

  it("does not grant a realtime, public, or worker role the transition surface", () => {
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.(?:spawn_governed_voice_worker|apply_governed_voice_worker_result)[\s\S]*TO (?:PUBLIC|authenticated|anon|hacc_worker)/);
  });
});
