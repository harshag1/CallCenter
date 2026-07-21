import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_VOICE_WORKER_RESULT_BYTES,
  VoiceWorkerCapabilityManifestSchema,
  VoiceWorkerResultSchema,
  canonicalVoiceWorkerJson,
  deriveVoiceWorkerId,
  hashVoiceWorkerValue,
  prepareVoiceWorkerCheckpoint,
  prepareVoiceWorkerResult,
  prepareVoiceWorkerSpawn,
} from "../voice-workers/schema";
import {
  workerResultConversationPayload,
  workerSpawnedConversationPayload,
} from "../voice-workers/conversation-adapter";
import {
  appendConversationEvent,
  createConversationLog,
  foldConversation,
  type ConversationEventDraft,
  type ConversationLog,
} from "../conversation-kernel";

const conversationId = "8916eb0a-5332-4f4c-a330-746c516e83b9";
const organizationId = "8916eb0a-5332-4f4c-a330-746c516e83ba";
const agentId = "8916eb0a-5332-4f4c-a330-746c516e83bb";
const callId = "8916eb0a-5332-4f4c-a330-746c516e83bc";

const manifest = {
  v: 1 as const,
  mode: "read_only" as const,
  capabilities: ["knowledge.search", "membership.lookup"],
  networkOrigins: ["https://example.com/"],
};

function authority(capabilityManifestSha256 = hashVoiceWorkerValue(manifest)) {
  return {
    v: 1 as const,
    conversationId,
    organizationId,
    agentId,
    agentVersion: 7,
    source: "voice_call" as const,
    sourceCallId: callId,
    conversationHeadSha256: "a".repeat(64),
    conversationRevision: 7,
    goalId: "membership_renewal",
    policyEpoch: 3,
    factDependencies: [{ key: "membership_tier", revision: 1 }],
    capabilityManifestSha256,
  };
}

const workerInput = {
  v: 1 as const,
  objective: "Find the caller's current membership renewal terms.",
  context: { memberId: "MEM-42" },
  deliverable: "Return cited facts and any renewal action as a proposal.",
};

const result = {
  v: 1 as const,
  facts: [{ key: "renewal_date", value: "2027-01-02", confidence: 0.99, citationIds: ["membership"] }],
  citations: [{ id: "membership", uri: "https://example.com/members/MEM-42", retrievedAt: "2026-07-21T17:00:00.000Z" }],
  proposedActions: [{
    kind: "membership.renew",
    rationale: "The caller asked to renew after reviewing the terms.",
    arguments: { memberId: "MEM-42" },
    requiresConfirmation: true as const,
  }],
  summary: "Membership renews on 2027-01-02; renewal remains a proposed action.",
};

describe("durable read-only voice worker schemas", () => {
  it("canonicalizes JSON recursively and hashes key-order-equivalent values identically", () => {
    const left = { z: [{ b: 2, a: 1 }], a: true };
    const right = { a: true, z: [{ a: 1, b: 2 }] };
    expect(canonicalVoiceWorkerJson(left)).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
    expect(hashVoiceWorkerValue(left)).toBe(hashVoiceWorkerValue(right));
    expect(() => canonicalVoiceWorkerJson({ unsafe: undefined })).toThrow(/undefined/);
    expect(() => canonicalVoiceWorkerJson({ unsafe: Number.NaN })).toThrow(/finite/);
  });

  it("derives stable, scoped UUID identities for idempotent retries", () => {
    const first = deriveVoiceWorkerId(conversationId, "renewal-lookup:v1");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveVoiceWorkerId(conversationId, "renewal-lookup:v1")).toBe(first);
    expect(deriveVoiceWorkerId(conversationId, "renewal-lookup:v2")).not.toBe(first);
  });

  it("admits only an explicit read-only capability manifest and matching immutable authority", () => {
    const prepared = prepareVoiceWorkerSpawn({ authority: authority(), workerInput, capabilityManifest: manifest });
    expect(prepared.capabilityManifest.mode).toBe("read_only");
    expect(prepared.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => VoiceWorkerCapabilityManifestSchema.parse({ ...manifest, mode: "read_write" })).toThrow();
    expect(() => prepareVoiceWorkerSpawn({
      authority: authority("f".repeat(64)),
      workerInput,
      capabilityManifest: manifest,
    })).toThrow(/does not match/);
  });

  it("binds goal, policy, and dependency revisions in host-authored spawn authority", () => {
    const prepared = prepareVoiceWorkerSpawn({ authority: authority(), workerInput, capabilityManifest: manifest });
    expect(prepared.authority).toMatchObject({
      conversationHeadSha256: "a".repeat(64), conversationRevision: 7,
      goalId: "membership_renewal", policyEpoch: 3,
      factDependencies: [{ key: "membership_tier", revision: 1 }],
    });
    expect(() => prepareVoiceWorkerSpawn({
      authority: { ...authority(), factDependencies: [
        { key: "membership_tier", revision: 1 }, { key: "membership_tier", revision: 1 },
      ] },
      workerInput,
      capabilityManifest: manifest,
    })).toThrow(/unique/);
  });

  it("rejects ambiguous spawn sources and non-origin network URLs", () => {
    expect(() => prepareVoiceWorkerSpawn({
      authority: { ...authority(), sourceWorkerId: agentId },
      workerInput,
      capabilityManifest: manifest,
    })).toThrow(/corresponding source identity/);
    expect(() => VoiceWorkerCapabilityManifestSchema.parse({
      ...manifest,
      networkOrigins: ["https://example.com/private?q=secret"],
    })).toThrow(/cannot contain/);
    expect(() => VoiceWorkerCapabilityManifestSchema.parse({
      ...manifest,
      networkOrigins: ["http://example.com/"],
    })).toThrow(/HTTPS/);
  });

  it("requires cited facts to reference real citations and proposals to require confirmation", () => {
    expect(prepareVoiceWorkerResult(result)).toMatchObject({ resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => VoiceWorkerResultSchema.parse({
      ...result,
      facts: [{ ...result.facts[0], citationIds: ["missing"] }],
    })).toThrow(/unknown citation/);
    expect(() => VoiceWorkerResultSchema.parse({
      ...result,
      proposedActions: [{ ...result.proposedActions[0], requiresConfirmation: false }],
    })).toThrow();
  });

  it("bounds structured result and checkpoint persistence", () => {
    expect(() => prepareVoiceWorkerResult({
      ...result,
      facts: [{ key: "oversized", value: "x".repeat(MAX_VOICE_WORKER_RESULT_BYTES), confidence: 1, citationIds: [] }],
    })).toThrow(/exceeds/);
    expect(prepareVoiceWorkerCheckpoint({
      v: 1,
      phase: "researching",
      progress: 0.5,
      resumableState: { cursor: "page-2" },
      updatedAt: "2026-07-21T17:00:00.000Z",
    })).toMatchObject({ checkpointBytes: expect.any(Number) });
  });
});

describe("durable worker to conversation-log adapter", () => {
  const append = (log: ConversationLog, eventId: string, payload: ConversationEventDraft["payload"]) =>
    appendConversationEvent(log, { eventId, occurredAtMs: log.events.length + 1, payload });

  it("admits current cited facts but never promotes a proposed action", () => {
    const preparedResult = prepareVoiceWorkerResult(result);
    const worker = {
      id: "8916eb0a-5332-4f4c-a330-746c516e83bd",
      conversationId,
      authority: authority(),
      input: workerInput,
      resultSha256: preparedResult.resultSha256,
    };
    let log = createConversationLog(conversationId);
    log = append(log, "policy-1", { type: "policy.advanced", epoch: 1, invariants: [] });
    log = append(log, "policy-2", { type: "policy.advanced", epoch: 2, invariants: [] });
    log = append(log, "policy-3", { type: "policy.advanced", epoch: 3, invariants: [] });
    log = append(log, "fact-1", {
      type: "fact.asserted", key: "membership_tier", value: "gold", revision: 1,
      authority: { kind: "system_of_record", issuer: "crm", evidenceId: "membership-row", issuedAtMs: 1 },
    });
    log = append(log, "goal-1", {
      type: "goal.activated", goalId: "membership_renewal", description: "Renew the membership.",
    });
    log = append(log, "worker-1", workerSpawnedConversationPayload(worker));
    const delivery = workerResultConversationPayload(worker, {
      id: "8916eb0a-5332-4f4c-a330-746c516e83be",
      conversationId, workerId: worker.id, result: preparedResult.result,
      resultSha256: preparedResult.resultSha256,
    });
    expect(delivery).not.toHaveProperty("proposedActions");
    log = append(log, "delivery-1", delivery);
    expect(foldConversation(log)).toMatchObject({
      deliveries: [{ status: "accepted" }],
      acceptedWorkerFacts: [{ key: "renewal_date", value: "2027-01-02" }],
    });
  });

  it("lets the kernel defer a correctly signed result after a dependency correction", () => {
    const preparedResult = prepareVoiceWorkerResult(result);
    const worker = {
      id: "8916eb0a-5332-4f4c-a330-746c516e83bd", conversationId,
      authority: authority(), input: workerInput, resultSha256: preparedResult.resultSha256,
    };
    let log = createConversationLog(conversationId);
    for (let epoch = 1; epoch <= 3; epoch += 1) {
      log = append(log, `policy-${epoch}`, { type: "policy.advanced", epoch, invariants: [] });
    }
    log = append(log, "fact-1", {
      type: "fact.asserted", key: "membership_tier", value: "gold", revision: 1,
      authority: { kind: "system_of_record", issuer: "crm", evidenceId: "membership-row-1", issuedAtMs: 1 },
    });
    log = append(log, "goal-1", { type: "goal.activated", goalId: "membership_renewal", description: "Renew." });
    log = append(log, "worker-1", workerSpawnedConversationPayload(worker));
    log = append(log, "fact-2", {
      type: "fact.corrected", key: "membership_tier", value: "platinum", expectedRevision: 1, revision: 2,
      authority: { kind: "system_of_record", issuer: "crm", evidenceId: "membership-row-2", issuedAtMs: 2 },
    });
    log = append(log, "delivery-1", workerResultConversationPayload(worker, {
      id: "8916eb0a-5332-4f4c-a330-746c516e83be", conversationId, workerId: worker.id,
      result: preparedResult.result, resultSha256: preparedResult.resultSha256,
    }));
    expect(foldConversation(log).deliveries.at(-1)).toMatchObject({
      status: "deferred", reason: "an authoritative dependency fact changed while worker was running",
    });
  });
});

describe("032 durable voice worker migration contract", () => {
  const sql = readFileSync(resolve(process.cwd(), "migrations/032_durable_voice_workers.sql"), "utf8");

  it("persists conversation identity beyond calls and binds unique idempotency", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.voice_conversations/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.voice_conversation_calls/);
    expect(sql).toMatch(/UNIQUE \(conversation_id, idempotency_key\)/);
    expect(sql).toMatch(/voice_worker_idempotency_conflict/);
  });

  it("stores immutable spawn authority, input, and read-only capability digests", () => {
    expect(sql).toContain("spawn_authority_sha256");
    expect(sql).toContain("worker_input_sha256");
    expect(sql).toContain("capability_manifest_sha256");
    expect(sql).toMatch(/capability_manifest->>'mode' = 'read_only'/);
    expect(sql).toMatch(/voice worker spawn authority and input are immutable/);
    expect(sql).toMatch(/authority,authority_sha256,[\s\S]*input_text::jsonb,input_sha256/);
    for (const field of ["conversationHeadSha256", "conversationRevision", "goalId", "policyEpoch", "factDependencies"]) {
      expect(sql).toContain(`'${field}'`);
    }
    expect(sql).toMatch(/count\(DISTINCT dependency->>'key'\)/);
  });

  it("uses atomic leases, pre-dispatch reclaim, and post-dispatch quarantine", () => {
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toMatch(/dispatch_started_at IS NOT NULL[\s\S]*status='indeterminate'/);
    expect(sql).toMatch(/lease_reclaimed_before_dispatch/);
    expect(sql).toMatch(/claimed_cancellation_epoch=cancellation_epoch/);
    expect(sql).toContain("voice_worker_dispatch_not_authorized");
  });

  it("models every required status and monotonic cancellation epochs", () => {
    for (const status of ["pending", "running", "cancel_requested", "succeeded", "failed", "cancelled", "indeterminate"]) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toMatch(/cancellation_epoch=cancellation_epoch\+1/);
  });

  it("uses bounded, hash-chained, append-only worker events", () => {
    expect(sql).toMatch(/octet_length\(payload::text\) <= 32768/);
    expect(sql).toContain("previous_event_sha256");
    expect(sql).toContain("hacc/voice-worker-event/v1");
    expect(sql).toMatch(/voice worker events are append-only/);
  });

  it("provides at-least-once delivery and exactly-once application", () => {
    expect(sql).toMatch(/delivery_count=delivery_count\+1/);
    expect(sql).toMatch(/delivery_lease_expires_at IS NULL OR delivery_lease_expires_at<=clock_timestamp\(\)/);
    expect(sql).toMatch(/context_version=context_version\+1/);
    expect(sql).toContain("voice_inbox_application_conflict");
    expect(sql).toMatch(/IF message\.application_id IS NOT NULL THEN/);
  });

  it("denies direct runtime table access and grants only transition functions", () => {
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toMatch(/REVOKE ALL ON public\.%I FROM %I/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.claim_voice_worker_job\(uuid,integer\) TO hacc_worker/);
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname='hacc_worker'\)/);
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE).*voice_worker_jobs TO hacc_worker/);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.request_voice_worker_cancellation\(uuid,uuid\) TO hacc_worker/);
  });
});
