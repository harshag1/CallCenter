import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  qOne: vi.fn(),
  withLockedFlowState: vi.fn(),
}));

vi.mock("../db", () => ({ qOne: mocks.qOne }));
vi.mock("../flow-state-store", () => ({
  withLockedFlowState: mocks.withLockedFlowState,
}));

import { CONVERSATION_KERNEL_VERSION, canonicalJson } from "../conversation-kernel";
import {
  createFlowExecutionState,
  hashFlowValue,
  type FlowActionReceipt,
} from "../flow-runtime";
import {
  buildGovernedLaunchTaskWorkerInput,
  deriveGovernedLaunchTaskActionContextKey,
  deriveGovernedLaunchTaskIdentity,
  governedLaunchTaskRunActionResult,
  loadGovernedLaunchTaskSpawnReceipt,
  reconcileIndeterminateGovernedLaunchTask,
  verifyGovernedLaunchTaskSpawnReceipt,
  type GovernedLaunchTaskSpawnReceiptRow,
} from "../governed-launch-task-recovery";
import { hashVoiceWorkerValue } from "../voice-workers/schema";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CALL_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const RUNTIME_DIGEST = "d".repeat(64);
const LEDGER_IDEMPOTENCY_KEY = "flow-ledger-launch-task";
const COMMAND = "Look up the caller's current membership options.";
const PREVIOUS_HASH = "0".repeat(64);
const EVENT_SEQUENCE = 7;
const RESERVED_AT = "2026-07-28T16:00:00.000Z";
const DISPATCH_STARTED_AT = "2026-07-28T16:00:01.000Z";
const EVENT_OCCURRED_AT_MS = Date.parse(RESERVED_AT);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture() {
  const flowActionIdempotencyKey = deriveGovernedLaunchTaskActionContextKey({
    organizationId: ORG_ID,
    callId: CALL_ID,
    ledgerIdempotencyKey: LEDGER_IDEMPOTENCY_KEY,
  });
  const identity = deriveGovernedLaunchTaskIdentity({
    conversationId: CALL_ID,
    organizationId: ORG_ID,
    flowActionIdempotencyKey,
  });
  const capabilityManifest = {
    v: 1 as const,
    mode: "read_only" as const,
    capabilities: ["search_knowledge"],
    networkOrigins: [],
  };
  const workerInput = buildGovernedLaunchTaskWorkerInput({
    command: COMMAND,
    receiptId: RECEIPT_ID,
    runtimeDigest: RUNTIME_DIGEST,
    identity,
  });
  const eventPayload = {
    type: "worker.spawned" as const,
    workerId: identity.workerId,
    goalId: "membership.lookup",
    purpose: COMMAND,
    policyEpoch: 5,
    dependencies: [{ key: "member.id", revision: 2 }],
  };
  const unsignedEvent = {
    version: CONVERSATION_KERNEL_VERSION,
    conversationId: CALL_ID,
    sequence: EVENT_SEQUENCE,
    previousHash: PREVIOUS_HASH,
    eventId: identity.conversationEventId,
    occurredAtMs: EVENT_OCCURRED_AT_MS,
    payload: eventPayload,
  };
  const eventUnsignedText = canonicalJson(unsignedEvent);
  const eventSha256 = sha256(eventUnsignedText);
  const spawnAuthority = {
    v: 1 as const,
    conversationId: CALL_ID,
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    agentVersion: 3,
    source: "voice_call" as const,
    sourceCallId: CALL_ID,
    conversationHeadSha256: eventSha256,
    conversationRevision: EVENT_SEQUENCE,
    goalId: eventPayload.goalId,
    policyEpoch: eventPayload.policyEpoch,
    factDependencies: eventPayload.dependencies,
    capabilityManifestSha256: hashVoiceWorkerValue(capabilityManifest),
  };
  const row: GovernedLaunchTaskSpawnReceiptRow = {
    id: identity.workerId,
    conversation_id: CALL_ID,
    org_id: ORG_ID,
    parent_worker_id: null,
    source_call_id: CALL_ID,
    idempotency_key: identity.workerIdempotencyKey,
    worker_kind: "call.research",
    spawn_authority: spawnAuthority,
    spawn_authority_sha256: hashVoiceWorkerValue(spawnAuthority),
    worker_input: workerInput,
    worker_input_sha256: hashVoiceWorkerValue(workerInput),
    capability_manifest: capabilityManifest,
    capability_manifest_sha256: hashVoiceWorkerValue(capabilityManifest),
    spawn_created_at: new Date("2026-07-28T16:00:00.000Z"),
    conversation_agent_id: AGENT_ID,
    conversation_agent_version: 3,
    event_id: identity.conversationEventId,
    event_idempotency_key: identity.workerIdempotencyKey,
    event_sequence: String(EVENT_SEQUENCE),
    event_occurred_at_ms: String(EVENT_OCCURRED_AT_MS),
    event_type: "worker.spawned",
    event_payload: eventPayload,
    event_previous_sha256: PREVIOUS_HASH,
    event_sha256: eventSha256,
    event_unsigned_text: eventUnsignedText,
  };
  return { flowActionIdempotencyKey, identity, row };
}

function indeterminateReceipt(): FlowActionReceipt {
  const actionArguments = { command: COMMAND };
  return {
    id: RECEIPT_ID,
    idempotencyKey: LEDGER_IDEMPOTENCY_KEY,
    step: "membership/lookup",
    tool: "launch_task",
    capabilityEpoch: 2,
    arguments: actionArguments,
    argumentsBytes: Buffer.byteLength(canonicalJson(actionArguments), "utf8"),
    argumentsHash: hashFlowValue(actionArguments),
    invocationId: "A".repeat(24),
    dispatchStartedAt: DISPATCH_STARTED_AT,
    dispatchAttempt: 1,
    status: "indeterminate",
    error: "dispatch owner expired after the durable boundary",
    reservedAt: RESERVED_AT,
    settledAt: "2026-07-28T16:01:00.000Z",
  };
}

describe("governed launch_task crash recovery", () => {
  beforeEach(() => {
    mocks.qOne.mockReset();
    mocks.withLockedFlowState.mockReset();
  });

  it("derives a stable coordinator and worker identity from exact action context", () => {
    const first = fixture();
    const replay = deriveGovernedLaunchTaskIdentity({
      conversationId: CALL_ID,
      organizationId: ORG_ID,
      flowActionIdempotencyKey: first.flowActionIdempotencyKey,
    });
    expect(replay).toEqual(first.identity);
    expect(first.identity.workerIdempotencyKey).toMatch(/^cc:[a-f0-9]{64}$/);
    expect(first.identity.workerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(deriveGovernedLaunchTaskIdentity({
      conversationId: CALL_ID,
      organizationId: "55555555-5555-4555-8555-555555555555",
      flowActionIdempotencyKey: first.flowActionIdempotencyKey,
    }).workerId).not.toBe(first.identity.workerId);
  });

  it("verifies every immutable digest and returns only a stable acceptance result", () => {
    const value = fixture();
    const verified = verifyGovernedLaunchTaskSpawnReceipt({
      row: value.row,
      organizationId: ORG_ID,
      conversationId: CALL_ID,
      flowActionIdempotencyKey: value.flowActionIdempotencyKey,
      receiptId: RECEIPT_ID,
      runtimeDigest: RUNTIME_DIGEST,
      reservedAt: RESERVED_AT,
      actionArguments: { command: `  ${COMMAND}  ` },
    });
    expect(verified.result).toEqual({
      ok: true,
      worker_id: value.identity.workerId,
      spawn_status: "accepted",
    });
    expect(Object.keys(verified.result).sort()).toEqual(["ok", "spawn_status", "worker_id"]);
    expect(governedLaunchTaskRunActionResult(value.identity.workerId, RECEIPT_ID)).toEqual({
      ...verified.result,
      receipt_id: RECEIPT_ID,
      receipt_status: "succeeded",
    });
    expect(verified.proofResultSha256).toBe(hashFlowValue(verified.proofResult));
    expect(verified.proofResult).not.toHaveProperty("status");
    expect(verified.proofResult).not.toHaveProperty("result");
    expect(verified.proofResult).not.toHaveProperty("error");
    expect(verified.proofResult).not.toHaveProperty("ownerToken");
  });

  it("loads only the exact worker, organization, and conversation scope", async () => {
    const value = fixture();
    mocks.qOne.mockResolvedValue(value.row);
    await expect(loadGovernedLaunchTaskSpawnReceipt({
      workerId: value.identity.workerId,
      organizationId: ORG_ID,
      conversationId: CALL_ID,
    })).resolves.toBe(value.row);
    expect(mocks.qOne).toHaveBeenCalledWith(
      "SELECT * FROM load_governed_launch_task_spawn_receipt($1,$2,$3)",
      [value.identity.workerId, ORG_ID, CALL_ID],
    );
    mocks.qOne.mockClear();
    await expect(loadGovernedLaunchTaskSpawnReceipt({
      workerId: value.identity.workerId,
      organizationId: "not-an-org",
      conversationId: CALL_ID,
    })).rejects.toThrow(/organizationId must be a UUID/);
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it.each([
    ["worker input digest", (row: GovernedLaunchTaskSpawnReceiptRow) => ({
      ...row,
      worker_input_sha256: "f".repeat(64),
    })],
    ["self-consistent but wrong launch binding", (row: GovernedLaunchTaskSpawnReceiptRow) => {
      const workerInput = {
        ...(row.worker_input as Record<string, unknown>),
        context: { launchAuthority: { v: 1, flowReceiptId: RECEIPT_ID } },
      };
      return {
        ...row,
        worker_input: workerInput,
        worker_input_sha256: hashVoiceWorkerValue(workerInput),
      };
    }],
    ["manifest authority binding", (row: GovernedLaunchTaskSpawnReceiptRow) => ({
      ...row,
      capability_manifest: {
        v: 1,
        mode: "read_only",
        capabilities: ["search"],
        networkOrigins: [],
      },
    })],
    ["event bytes", (row: GovernedLaunchTaskSpawnReceiptRow) => ({
      ...row,
      event_unsigned_text: `${row.event_unsigned_text} `,
    })],
    ["cross-tenant scope", (row: GovernedLaunchTaskSpawnReceiptRow) => ({
      ...row,
      org_id: "55555555-5555-4555-8555-555555555555",
    })],
  ])("rejects tampered %s", (_label, mutate) => {
    const value = fixture();
    expect(() => verifyGovernedLaunchTaskSpawnReceipt({
      row: mutate(value.row),
      organizationId: ORG_ID,
      conversationId: CALL_ID,
      flowActionIdempotencyKey: value.flowActionIdempotencyKey,
      receiptId: RECEIPT_ID,
      runtimeDigest: RUNTIME_DIGEST,
      reservedAt: RESERVED_AT,
      actionArguments: { command: COMMAND },
    })).toThrow();
  });

  it("atomically promotes an indeterminate Flow receipt without invoking spawn again", async () => {
    const value = fixture();
    const receipt = indeterminateReceipt();
    const state = {
      ...createFlowExecutionState("2026-07-28T15:59:00.000Z"),
      actionReceipts: [receipt],
      revision: 4,
      updatedAt: "2026-07-28T16:01:00.000Z",
    };
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("FROM flow_action_receipts receipt")) {
          return {
            rows: [{
              status: "indeterminate",
              runtime_digest: RUNTIME_DIGEST,
              tool: "launch_task",
              arguments: { command: COMMAND },
              arguments_hash: receipt.argumentsHash,
              idempotency_key: LEDGER_IDEMPOTENCY_KEY,
              dispatch_started_at: new Date(DISPATCH_STARTED_AT),
              reconciliation_proof_id: null,
              result: null,
              result_hash: null,
              call_status: "active",
              call_runtime_digest: RUNTIME_DIGEST,
              capability_epoch: receipt.capabilityEpoch,
              invocation_id: receipt.invocationId,
              reserved_at: new Date(RESERVED_AT),
              db_now: new Date("2026-07-28T16:02:00.000Z"),
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("load_governed_launch_task_spawn_receipt")) {
          return { rows: [value.row], rowCount: 1 };
        }
        if (sql.includes("status = 'querying'") && sql.includes("SELECT id")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("COALESCE(MAX(attempt)")) {
          return { rows: [{ last_attempt: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    let recoveredState = state;
    mocks.withLockedFlowState.mockImplementation(async (_callId, mutate) => {
      const outcome = await mutate(state, client);
      recoveredState = outcome.state ?? state;
      return { state: outcome.state ?? state, value: outcome.value };
    });

    const outcome = await reconcileIndeterminateGovernedLaunchTask({
      callId: CALL_ID,
      organizationId: ORG_ID,
      conversationId: CALL_ID,
      receiptId: RECEIPT_ID,
      runtimeDigest: RUNTIME_DIGEST,
    });

    expect(outcome).toMatchObject({
      reconciled: true,
      replayed: false,
      receiptId: RECEIPT_ID,
      result: {
        ok: true,
        worker_id: value.identity.workerId,
        spawn_status: "accepted",
      },
    });
    expect(recoveredState.actionReceipts[0]?.settledAt).toBe("2026-07-28T16:02:00.000Z");
    expect(calls.some((sql) => /spawn_governed|spawn_voice_worker_job/.test(sql))).toBe(false);
    expect(calls.findIndex((sql) => sql.includes("INSERT INTO flow_action_reconciliation_proofs")))
      .toBeLessThan(calls.findIndex((sql) => sql.includes("SET status = 'committed'")));
    expect(calls.findIndex((sql) => sql.includes("SET status = 'committed'")))
      .toBeLessThan(calls.findIndex((sql) => sql.includes("UPDATE flow_action_receipts")));
  });

  it("keeps the exact projection backend-only and excludes mutable worker execution fields", () => {
    const migration = readFileSync(
      join(process.cwd(), "migrations/043_governed_voice_worker_runtime.sql"),
      "utf8",
    );
    const functionSql = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION public.load_governed_launch_task_spawn_receipt"),
      migration.indexOf("$load_governed_launch_task_spawn_receipt$;", migration.indexOf(
        "CREATE OR REPLACE FUNCTION public.load_governed_launch_task_spawn_receipt",
      )) + "$load_governed_launch_task_spawn_receipt$;".length,
    );
    expect(functionSql).toContain("SECURITY DEFINER");
    expect(functionSql).toContain("SET search_path = pg_catalog, extensions, public");
    expect(functionSql).toContain("job.id = worker_identity");
    expect(functionSql).toContain("job.org_id = organization_identity");
    expect(functionSql).toContain("job.conversation_id = conversation_identity");
    expect(functionSql).toContain("source_call.agent_id = conversation.agent_id");
    expect(functionSql).toContain("source_call.agent_version = conversation.agent_version");
    expect(functionSql).not.toMatch(/job\.(?:status|owner_token|result|error|checkpoint)/);
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.load_governed_launch_task_spawn_receipt(uuid,uuid,uuid) FROM %I",
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.load_governed_launch_task_spawn_receipt\(uuid,uuid,uuid\)\s+TO hacc_backend;/,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.load_governed_launch_task_spawn_receipt\(uuid,uuid,uuid\)\s+TO (?:anon|authenticated|service_role|hacc_worker);/,
    );
  });
});
