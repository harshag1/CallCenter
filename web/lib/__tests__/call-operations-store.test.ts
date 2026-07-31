import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  qOne: vi.fn(),
  loadPersistedConversationState: vi.fn(),
}));
vi.mock("../db", () => ({ qOne: mocks.qOne }));
vi.mock("../conversation-store", () => ({
  loadPersistedConversationState: mocks.loadPersistedConversationState,
}));

import {
  CallOperationsConfigurationError,
  deriveOrganizationOperationsKey,
  loadCallOperationsProjection,
} from "../call-operations-store";

const CALL_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000003";
const WORKER_ID = "00000000-0000-4000-8000-000000000004";
const RECEIPT_ID = "00000000-0000-4000-8000-000000000005";
const ROOT_SECRET = "ab".repeat(32);
const HEAD_A = "cd".repeat(32);
const HEAD_B = "ef".repeat(32);
const NOW = 1_800_000_000_000;

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    callId: CALL_ID,
    organizationId: ORG_ID,
    capturedAtMs: NOW,
    callStatus: "active",
    conversationAuthority: null,
    flowState: {
      capabilityEpoch: 4,
      revision: 7,
      actionReceipts: [{
        id: RECEIPT_ID,
        tool: "membership_lookup",
        capabilityEpoch: 4,
        dispatchAttempt: 2,
        status: "indeterminate",
        dispatchStartedAt: "2027-01-15T07:59:50.000Z",
        reservedAt: "2027-01-15T07:59:49.000Z",
        settledAt: "2027-01-15T07:59:55.000Z",
        error: "provider_timeout",
      }],
    },
    actionSummary: {
      total: 1,
      byStatus: { indeterminate: 1 },
      maxCapabilityEpoch: 4,
    },
    durableWorkers: [{
      id: WORKER_ID,
      parentWorkerId: null,
      status: "running",
      authority: { policyEpoch: 3 },
      leaseExpiresAt: "2027-01-15T08:00:30.000Z",
      cancellationEpoch: 0,
      checkpointPresent: true,
      resultPresent: false,
      errorPresent: false,
      settledAt: null,
      deliveryState: "not_settled",
    }],
    durableWorkerSummary: {
      total: 1,
      byStatus: { running: 1 },
      byDeliveryState: { not_settled: 1 },
    },
    policyDecisions: [{
      stage: "pre_dispatch",
      observedAtMs: NOW - 5_000,
      decision: {
        decision: "deny",
        reason: "fresh_confirmation_required",
        action: "membership_lookup",
      },
    }],
    policySummary: { observations: 1, denials: 1, byDecision: { deny: 1 } },
    sourceObservations: [
      { source: "flow", observedAtMs: NOW - 1_000 },
      { source: "conversation", observedAtMs: null },
      { source: "workers", observedAtMs: NOW - 1_000 },
      { source: "policy", observedAtMs: NOW - 5_000 },
    ],
    recoveryObservations: [{
      kind: "worker_checkpointed",
      subjectId: WORKER_ID,
      observedAtMs: NOW - 10_000,
    }],
    recoverySummary: {
      observations: 1,
      byKind: { worker_checkpointed: 1 },
      lastObservedAtMs: NOW - 10_000,
    },
    ...overrides,
  };
}

describe("call operations durable store", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives deterministic, organization-separated HMAC keys", () => {
    const first = deriveOrganizationOperationsKey(ROOT_SECRET, ORG_ID);
    const replay = deriveOrganizationOperationsKey(ROOT_SECRET, ORG_ID);
    const isolated = deriveOrganizationOperationsKey(ROOT_SECRET, OTHER_ORG_ID);

    expect(first).toEqual(replay);
    expect(first).not.toEqual(isolated);
    expect(first).toHaveLength(32);
    expect(() => deriveOrganizationOperationsKey("too-short", ORG_ID))
      .toThrow(CallOperationsConfigurationError);
  });

  it("loads only the exact call and organization and emits no raw identities or content", async () => {
    mocks.qOne.mockResolvedValueOnce({ snapshot: snapshot() });

    const projection = await loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    });

    expect(mocks.qOne).toHaveBeenCalledWith(
      "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
      [CALL_ID, ORG_ID],
    );
    expect(mocks.loadPersistedConversationState).not.toHaveBeenCalled();
    expect(projection).toMatchObject({
      actions: { total: 1, byStatus: { indeterminate: 1 } },
      workers: { total: 1, byStatus: { running: 1 } },
      policy: { observations: 1, denials: 1 },
      freshness: {
        active: true,
        staleSources: [],
      },
      recovery: { observations: 1, byKind: { worker_checkpointed: 1 } },
      attention: expect.arrayContaining(["indeterminate_action", "policy_denial"]),
    });
    expect(projection?.freshness.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "conversation", state: "unavailable" }),
    ]));
    const encoded = JSON.stringify(projection);
    for (const forbidden of [
      CALL_ID,
      ORG_ID,
      WORKER_ID,
      RECEIPT_ID,
      "membership_lookup",
      "provider_timeout",
      "membership.verify",
    ]) expect(encoded).not.toContain(forbidden);
  });

  it("fails closed if the security-definer result escapes its requested tenant scope", async () => {
    mocks.qOne.mockResolvedValueOnce({
      snapshot: snapshot({ organizationId: OTHER_ORG_ID }),
    });

    await expect(loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    })).rejects.toThrow(/escaped its requested organization scope/);
    expect(mocks.loadPersistedConversationState).not.toHaveBeenCalled();
  });

  it("redacts an unrecognized database call status before projection", async () => {
    const privateStatus = "provider-debug-detail-containing-customer-data";
    mocks.qOne.mockResolvedValueOnce({
      snapshot: snapshot({ callStatus: privateStatus }),
    });

    const projection = await loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    });

    expect(projection?.freshness.callStatus).toBe("redacted_unknown");
    expect(JSON.stringify(projection)).not.toContain(privateStatus);
  });

  it("accepts the SQL boundary's closed unknown worker status without leaking content", async () => {
    mocks.qOne.mockResolvedValueOnce({
      snapshot: snapshot({
        durableWorkers: [{
          id: WORKER_ID,
          parentWorkerId: null,
          status: "redacted_unknown",
          authority: { policyEpoch: null },
          leaseExpiresAt: null,
          cancellationEpoch: 0,
          checkpointPresent: false,
          resultPresent: false,
          errorPresent: false,
          settledAt: null,
          deliveryState: "not_settled",
        }],
        durableWorkerSummary: {
          total: 1,
          byStatus: { redacted_unknown: 1 },
          byDeliveryState: { not_settled: 1 },
        },
      }),
    });

    const projection = await loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    });

    expect(projection?.workers).toMatchObject({
      total: 1,
      byStatus: { redacted_unknown: 1 },
      items: [expect.objectContaining({ status: "redacted_unknown" })],
    });
    expect(JSON.stringify(projection)).not.toContain("caller_secret");
  });

  it("accepts the SQL boundary's closed unknown action status without leaking content", async () => {
    mocks.qOne.mockResolvedValueOnce({
      snapshot: snapshot({
        flowState: {
          capabilityEpoch: 4,
          revision: 7,
          actionReceipts: [{
            id: RECEIPT_ID,
            tool: "redacted_tool",
            capabilityEpoch: 4,
            dispatchAttempt: 2,
            status: "redacted_unknown",
            reservedAt: "2027-01-15T07:59:49.000Z",
          }],
        },
        actionSummary: {
          total: 1,
          byStatus: { redacted_unknown: 1 },
          maxCapabilityEpoch: 4,
        },
      }),
    });

    const projection = await loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    });

    expect(projection?.actions).toMatchObject({
      total: 1,
      byStatus: { redacted_unknown: 1 },
      indeterminate: [],
    });
    expect(JSON.stringify(projection)).not.toContain("caller_secret");
  });

  it("rejects unexpected transcript or secret-bearing fields before projection", async () => {
    mocks.qOne.mockResolvedValueOnce({
      snapshot: snapshot({ transcript: "private caller words" }),
    });

    await expect(loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    })).rejects.toThrow();
  });

  it("returns null for missing and cross-tenant calls without attempting a conversation read", async () => {
    mocks.qOne.mockResolvedValueOnce({ snapshot: null });

    await expect(loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    })).resolves.toBeNull();
    expect(mocks.loadPersistedConversationState).not.toHaveBeenCalled();
  });

  it("rejects invalid redaction configuration before invoking the security-definer read", async () => {
    await expect(loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: "invalid",
    })).rejects.toBeInstanceOf(CallOperationsConfigurationError);
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("uses one O(1) SQL snapshot for a very long conversation head", async () => {
    mocks.qOne.mockResolvedValueOnce({
      snapshot: snapshot({
        conversationAuthority: {
          kind: "materialized_head",
          revision: 8_000_000,
          headSha256: HEAD_A,
          snapshotCapturedAtMs: NOW,
          eventRowsRead: 0,
        },
        sourceObservations: [
          { source: "flow", observedAtMs: NOW - 1_000 },
          { source: "conversation", observedAtMs: NOW - 500 },
          { source: "workers", observedAtMs: NOW - 1_000 },
          { source: "policy", observedAtMs: NOW - 5_000 },
        ],
      }),
    });

    const projection = await loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    });

    expect(mocks.qOne).toHaveBeenCalledTimes(1);
    expect(mocks.loadPersistedConversationState).not.toHaveBeenCalled();
    expect(projection?.authority).toMatchObject({
      conversationRevision: 8_000_000,
      conversationHeadSha256: HEAD_A,
    });
    expect(JSON.stringify(projection)).not.toContain("eventRowsRead");
  });

  it("cannot mix a newer post-snapshot conversation head into the projection", async () => {
    mocks.qOne.mockResolvedValueOnce({
      snapshot: snapshot({
        conversationAuthority: {
          kind: "materialized_head",
          revision: 41,
          headSha256: HEAD_A,
          snapshotCapturedAtMs: NOW,
          eventRowsRead: 0,
        },
      }),
    });
    mocks.loadPersistedConversationState.mockResolvedValueOnce({
      eventCount: 42,
      headHash: HEAD_B,
    });

    const projection = await loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    });

    expect(projection?.authority).toMatchObject({
      conversationRevision: 41,
      conversationHeadSha256: HEAD_A,
    });
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
    expect(mocks.loadPersistedConversationState).not.toHaveBeenCalled();
  });

  it("rejects a materialized head that is not bound to the root snapshot timestamp", async () => {
    mocks.qOne.mockResolvedValueOnce({
      snapshot: snapshot({
        conversationAuthority: {
          kind: "materialized_head",
          revision: 41,
          headSha256: HEAD_A,
          snapshotCapturedAtMs: NOW + 1,
          eventRowsRead: 0,
        },
      }),
    });

    await expect(loadCallOperationsProjection({
      callId: CALL_ID,
      organizationId: ORG_ID,
      redactionRootSecret: ROOT_SECRET,
    })).rejects.toThrow(/not bound to this bounded snapshot/);
  });
});

describe("039 call operations migration contract", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "migrations/039_call_operations_read_projection.sql"),
    "utf8",
  );

  it("keeps tenant ownership inside the default-deny definer boundary", () => {
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
    expect(sql).toMatch(/agent\.org_id = organization_identity/);
    expect(sql).toMatch(/job\.org_id = organization_identity/);
    expect(sql).toMatch(/binding\.org_id = organization_identity/);
    expect(sql).toContain("RETURN NULL");
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.read_call_operations_snapshot\(uuid,uuid\) FROM PUBLIC/);
    expect(sql).toMatch(
      /FOR runtime_role IN[\s\S]*CROSS JOIN LATERAL aclexplode\([\s\S]*AND privilege\.grantee <> projection\.proowner/,
    );
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.read_call_operations_snapshot\(uuid,uuid\) FROM %I CASCADE/,
    );
    const runtimeRevocation = sql.indexOf(
      "REVOKE EXECUTE ON FUNCTION public.read_call_operations_snapshot(uuid,uuid) FROM %I CASCADE",
    );
    const backendGrant = sql.indexOf(
      "GRANT EXECUTE ON FUNCTION public.read_call_operations_snapshot(uuid,uuid)",
    );
    expect(runtimeRevocation).toBeGreaterThan(-1);
    expect(backendGrant).toBeGreaterThan(runtimeRevocation);
    expect(sql).not.toMatch(/GRANT\s+SELECT\s+ON/i);
  });

  it("projects bounded details, complete aggregates, and recovery/freshness evidence", () => {
    expect(sql).toMatch(/LIMIT 256/g);
    expect(sql).toMatch(/LIMIT 10001/);
    expect(sql).toMatch(/IF action_receipt_count > 10000 THEN/);
    expect(sql).toMatch(/IF worker_identity_count > 10000 THEN/);
    expect(sql).toMatch(/IF policy_observation_count > 10000 THEN/);
    expect(sql).toMatch(/IF recovery_observation_count > 10000 THEN/);
    expect(sql).toContain("call_operations_action_receipt_limit_exceeded");
    expect(sql).toContain("call_operations_worker_identity_limit_exceeded");
    expect(sql).toContain("call_operations_policy_observation_limit_exceeded");
    expect(sql).toContain("call_operations_recovery_observation_limit_exceeded");
    expect(sql).toContain("'durableWorkerSummary'");
    expect(sql).toContain("'byDeliveryState'");
    expect(sql).not.toContain("'durableWorkerIds'");
    expect(sql).toContain("'actionSummary'");
    expect(sql).toContain("'conversationAuthority'");
    expect(sql).toContain("'policySummary'");
    expect(sql).toContain("'sourceObservations'");
    expect(sql).toContain("'recoverySummary'");
    expect(sql).toContain("'action_reconciled'");
    expect(sql).toContain("'worker_reclaimed'");
    expect(sql).toContain("'worker_indeterminate'");
    expect(sql).toContain("ELSE 'redacted_unknown'");
    expect(sql).toMatch(
      /SELECT CASE[\s\S]*END AS status[\s\S]*FROM public\.voice_worker_jobs job[\s\S]*GROUP BY scoped\.status/,
    );
    expect(sql).toMatch(
      /SELECT max\(latest_event\.created_at\)[\s\S]*FROM unnest\(worker_identity_array\)[\s\S]*event_job\.org_id = organization_identity[\s\S]*CROSS JOIN LATERAL[\s\S]*ORDER BY event\.sequence DESC[\s\S]*LIMIT 1/,
    );
    const freshnessStart = sql.indexOf("SELECT max(latest_event.created_at)");
    const freshnessEnd = sql.indexOf(") latest_event", freshnessStart);
    expect(freshnessStart).toBeGreaterThan(-1);
    expect(freshnessEnd).toBeGreaterThan(freshnessStart);
    expect(sql.slice(freshnessStart, freshnessEnd))
      .not.toContain("event.event_type");
    expect(sql).toMatch(
      /conversation\.event_head_sequence[\s\S]*conversation\.event_head_sha256[\s\S]*'eventRowsRead', 0/,
    );
    expect(sql).not.toMatch(/FROM public\.voice_conversation_events/);
    expect(sql).not.toContain("'conversationId'");
    for (const privateFlowLabel of [
      "'nodeId'",
      "'currentStep'",
      "'completedSteps'",
    ]) expect(sql).not.toContain(privateFlowLabel);
    expect(sql).toMatch(
      /jsonb_typeof\(run\.state->'capabilityEpoch'\) = 'number'\s+THEN CASE[\s\S]*::numeric <= 2147483647[\s\S]*::integer/,
    );
    expect(sql).toMatch(
      /jsonb_typeof\(job\.spawn_authority->'policyEpoch'\) = 'number'\s+THEN CASE[\s\S]*::numeric[\s\S]*<= 2147483647[\s\S]*::integer/,
    );
    expect(sql).toContain("call_operations_function_owner_is_runtime_role");
    expect(sql).toMatch(
      /WITH RECURSIVE inherited_roles\(roleid\)[\s\S]*FROM pg_auth_members/,
    );
    expect(sql).toMatch(
      /inheriting_roles\(roleid\) AS \([\s\S]*WHERE membership\.roleid = function_owner[\s\S]*JOIN inheriting_roles inheriting[\s\S]*inheriting\.roleid = membership\.roleid/,
    );
    for (const runtimeRole of [
      "anon",
      "authenticated",
      "service_role",
      "hacc_backend",
      "hacc_worker",
      "hacc_runtime",
      "hacc_worker_runtime",
    ]) expect(sql).toContain(`'${runtimeRole}'`);
    expect(sql).not.toMatch(
      /ALTER FUNCTION public\.read_call_operations_snapshot\(uuid,uuid\) OWNER TO/,
    );
    expect(sql).toMatch(
      /index_definition IS NULL[\s\S]*index_ready IS DISTINCT FROM true/,
    );
    expect(sql).toContain(
      "USING btree (conversation_id, worker_id, created_at DESC, id) INCLUDE (event_type)",
    );
    expect(sql).toContain("SET enable_seqscan = off");
    expect(sql).toContain("SET enable_bitmapscan = off");
    expect(sql).toContain("SET enable_indexscan = on");
    expect(sql).toContain("SET enable_indexonlyscan = on");
    expect(sql).toContain("SET enable_nestloop = on");
    expect(sql).toContain("SET max_parallel_workers_per_gather = 0");
    expect(sql).toContain("SET plan_cache_mode = force_custom_plan");
    expect(sql).toMatch(
      /SELECT count\(\*\)::integer\s+INTO worker_identity_count[\s\S]*SELECT 1[\s\S]*LIMIT 10001[\s\S]*IF worker_identity_count > 10000 THEN/,
    );
    const workerCapProbe = sql.slice(
      sql.indexOf("SELECT count(*)::integer\n    INTO worker_identity_count"),
      sql.indexOf("IF worker_identity_count > 10000 THEN"),
    );
    expect(workerCapProbe).not.toContain("ORDER BY");
    const recoveryCapProbe = sql.slice(
      sql.indexOf("SELECT count(*)::integer\n  INTO recovery_observation_count"),
      sql.indexOf("IF recovery_observation_count > 10000 THEN"),
    );
    expect(recoveryCapProbe).not.toContain("ORDER BY");
    expect(recoveryCapProbe).toContain(
      "event.conversation_id = scoped_job.conversation_id",
    );
    expect(sql.match(
      /event\.conversation_id = scoped_job\.conversation_id/g,
    )).toHaveLength(2);
  });

  it("maps the unconstrained calls.status column to a closed public enum", () => {
    expect(sql).toMatch(
      /SELECT CASE call\.status\s+WHEN 'active' THEN 'active'\s+WHEN 'dialing' THEN 'dialing'\s+WHEN 'completed' THEN 'completed'\s+WHEN 'failed' THEN 'failed'\s+ELSE 'redacted_unknown'\s+END\s+INTO call_status/,
    );
    expect(sql).not.toMatch(/SELECT\s+call\.status\s+INTO call_status/);
  });

  it("never selects secret-bearing bodies into the returned JSON", () => {
    for (const forbiddenProjectionKey of [
      "'arguments'",
      "'result'",
      "'checkpoint'",
      "'ownerToken'",
      "'idempotencyKey'",
      "'transcript'",
      "'payload'",
    ]) expect(sql).not.toContain(forbiddenProjectionKey);
  });
});
