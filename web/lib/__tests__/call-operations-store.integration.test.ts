import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const integrationDatabaseUrl = process.env.CONVERSATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(integrationDatabaseUrl));
const migration039 = readFileSync(
  new URL("../../migrations/039_call_operations_read_projection.sql", import.meta.url),
  "utf8",
);
const projectionFunction =
  "public.read_call_operations_snapshot(uuid,uuid)";
const nonBackendRuntimeRoles = [
  "anon",
  "authenticated",
  "service_role",
  "hacc_worker",
  "hacc_runtime",
  "hacc_worker_runtime",
] as const;

async function insertPendingWorkers(
  client: PoolClient,
  input: {
    conversationId: string;
    organizationId: string;
    callId: string;
    count: number;
    policyEpochJson?: string;
    createdAt?: string;
  },
): Promise<string[]> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO voice_worker_jobs (
       id,
       conversation_id,
       org_id,
       source_call_id,
       idempotency_key,
       worker_kind,
       spawn_authority,
       spawn_authority_sha256,
       worker_input,
       worker_input_sha256,
       capability_manifest,
       capability_manifest_sha256,
       created_at
     )
     SELECT
       gen_random_uuid(),
       $1,
       $2,
       $3,
       $4 || ordinal::text,
       'projection_probe',
       jsonb_build_object(
         'policyEpoch', $6::jsonb,
         'conversationHeadSha256', conversation.event_head_sha256,
         'conversationRevision', conversation.event_head_sequence
       ),
       repeat('a', 64),
       '{}'::jsonb,
       repeat('b', 64),
       jsonb_build_object(
         'v', 1,
         'mode', 'read_only',
         'capabilities', jsonb_build_array('projection.read'),
         'networkOrigins', '[]'::jsonb
       ),
       repeat('c', 64),
       COALESCE($7::timestamptz, clock_timestamp())
     FROM generate_series(1, $5::integer) ordinal
     JOIN public.voice_conversations conversation
       ON conversation.id = $1
      AND conversation.org_id = $2
     RETURNING id`,
    [
      input.conversationId,
      input.organizationId,
      input.callId,
      `${randomUUID()}:`,
      input.count,
      input.policyEpochJson ?? "3",
      input.createdAt ?? null,
    ],
  );
  return inserted.rows.map(({ id }) => id);
}

type ExplainNode = Readonly<{
  "Node Type"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: readonly ExplainNode[];
}>;

function collectExplainNodes(explain: unknown): ExplainNode[] {
  const document = Array.isArray(explain) ? explain[0] : null;
  const root = document && typeof document === "object"
    ? (document as { Plan?: ExplainNode }).Plan
    : undefined;
  const nodes: ExplainNode[] = [];
  const visit = (node: ExplainNode | undefined): void => {
    if (!node) return;
    nodes.push(node);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  return nodes;
}

function expectPhysicallyBoundedIndexPlan(
  explain: unknown,
  requiredIndex?: string | readonly string[],
  allowBoundedSort = false,
): void {
  const nodes = collectExplainNodes(explain);
  expect(nodes.length).toBeGreaterThan(0);
  expect(nodes.map((node) => node["Node Type"]).filter((nodeType) =>
    nodeType?.includes("Seq Scan")
      || nodeType?.includes("Bitmap"))).toEqual([]);
  if (!allowBoundedSort) {
    expect(nodes.filter((node) =>
      node["Node Type"]?.includes("Sort"))).toEqual([]);
  }
  expect(Math.max(...nodes.map((node) => node["Actual Rows"] ?? 0)))
    .toBeLessThanOrEqual(10_001);
  // A merge plan may sort only the already-capped private worker array. It
  // must never sort or consume more than the physical ceiling.
  expect(Math.max(
    0,
    ...nodes
      .filter((node) => node["Node Type"]?.includes("Sort"))
      .map((node) => node["Actual Rows"] ?? 0),
  )).toBeLessThanOrEqual(10_001);
  expect(nodes.reduce(
    (total, node) => total + (node["Rows Removed by Filter"] ?? 0),
    0,
  )).toBe(0);
  const usedIndexes = nodes
    .map((node) => node["Index Name"])
    .filter((indexName): indexName is string => Boolean(indexName));
  expect(usedIndexes.length).toBeGreaterThan(0);
  if (requiredIndex) {
    const requiredIndexes = typeof requiredIndex === "string"
      ? [requiredIndex]
      : requiredIndex;
    expect(usedIndexes.some((indexName) =>
      requiredIndexes.includes(indexName))).toBe(true);
  }
}

integration("039 tenant-scoped call operations projection", () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl });
  const ids = {
    org: randomUUID(),
    otherOrg: randomUUID(),
    agent: randomUUID(),
    call: randomUUID(),
    conversation: randomUUID(),
  };

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO orgs(id,name) VALUES ($1,'Operations projection'),($2,'Other operations tenant')",
      [ids.org, ids.otherOrg],
    );
    await pool.query(
      "INSERT INTO agents(id,org_id,name,active_version) VALUES ($1,$2,'Operations agent',1)",
      [ids.agent, ids.org],
    );
    await pool.query(
      "INSERT INTO agent_versions(agent_id,version,instructions,created_by) VALUES ($1,1,'private instructions','integration-test')",
      [ids.agent],
    );
    await pool.query(
      "INSERT INTO calls(id,agent_id,agent_version,direction,status) VALUES ($1,$2,1,'web','active')",
      [ids.call, ids.agent],
    );
    await pool.query(
      `INSERT INTO flow_runs(call_id,state,revision) VALUES (
         $1,
         jsonb_build_object(
           'version',2,'status','active','nodeId','private-node',
           'currentStep','private-step','completedSteps','[]'::jsonb,
           'attempts','{}'::jsonb,'outputs','{}'::jsonb,'checkpoints','[]'::jsonb,
           'capabilityEpoch',3,'actionReceipts','[]'::jsonb,
           'revision',1,'updatedAt','2026-07-28T12:00:00.000Z'
         ),
         1
       )
       ON CONFLICT (call_id) DO UPDATE
       SET state=EXCLUDED.state,revision=EXCLUDED.revision,updated_at=clock_timestamp()`,
      [ids.call],
    );
    await pool.query("SELECT * FROM ensure_voice_conversation($1,$2,$3,1,$4)", [
      ids.conversation,
      ids.org,
      ids.agent,
      ids.call,
    ]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM voice_conversation_calls WHERE conversation_id=$1", [ids.conversation]).catch(() => undefined);
    await pool.query("DELETE FROM voice_conversations WHERE id=$1", [ids.conversation]).catch(() => undefined);
    await pool.query("DELETE FROM calls WHERE id=$1", [ids.call]).catch(() => undefined);
    await pool.query("DELETE FROM agents WHERE id=$1", [ids.agent]).catch(() => undefined);
    await pool.query("DELETE FROM orgs WHERE id IN ($1,$2)", [ids.org, ids.otherOrg]).catch(() => undefined);
    await pool.end();
  });

  it("returns bounded operational truth only for the owning organization", async () => {
    const exact = await pool.query<{ snapshot: Record<string, unknown> | null }>(
      "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
      [ids.call, ids.org],
    );
    const crossTenant = await pool.query<{ snapshot: Record<string, unknown> | null }>(
      "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
      [ids.call, ids.otherOrg],
    );

    expect(crossTenant.rows).toEqual([{ snapshot: null }]);
    expect(exact.rows[0].snapshot).toMatchObject({
      schemaVersion: 2,
      callId: ids.call,
      organizationId: ids.org,
      callStatus: "active",
      conversationAuthority: {
        kind: "materialized_head",
        revision: 0,
        headSha256: "0".repeat(64),
        snapshotCapturedAtMs: expect.any(Number),
        eventRowsRead: 0,
      },
      flowState: {
        capabilityEpoch: 3,
        revision: 1,
        actionReceipts: [],
      },
      actionSummary: {
        total: 0,
        byStatus: {},
        maxCapabilityEpoch: null,
      },
      durableWorkerSummary: {
        total: 0,
        byStatus: {},
        byDeliveryState: {},
      },
      durableWorkers: [],
    });
    expect(exact.rows[0].snapshot).not.toHaveProperty("conversationId");
    expect(exact.rows[0].snapshot).not.toHaveProperty("durableWorkerIds");
    const encoded = JSON.stringify(exact.rows[0].snapshot);
    for (const secret of [
      "private instructions",
    ]) expect(encoded).not.toContain(secret);
  });

  it("redacts an unknown call lifecycle value without weakening tenant scope", async () => {
    const privateStatus = "customer-content-in-an-invalid-status";
    await pool.query("UPDATE calls SET status=$2 WHERE id=$1", [
      ids.call,
      privateStatus,
    ]);
    try {
      const exact = await pool.query<{ snapshot: Record<string, unknown> | null }>(
        "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
        [ids.call, ids.org],
      );
      const crossTenant = await pool.query<{ snapshot: Record<string, unknown> | null }>(
        "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
        [ids.call, ids.otherOrg],
      );

      expect(crossTenant.rows).toEqual([{ snapshot: null }]);
      expect(exact.rows[0].snapshot).toMatchObject({
        callStatus: "redacted_unknown",
      });
      expect(JSON.stringify(exact.rows[0].snapshot)).not.toContain(privateStatus);
    } finally {
      await pool.query("UPDATE calls SET status='active' WHERE id=$1", [ids.call]);
    }
  });

  it("omits legal PostgreSQL values outside the public time and integer domains", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `UPDATE flow_runs
         SET revision = -1, updated_at = 'infinity'::timestamptz
         WHERE call_id = $1`,
        [ids.call],
      );
      await client.query(
        `UPDATE voice_conversations
         SET event_head_sequence = 9007199254740992,
             event_head_sha256 = $2,
             updated_at = '1960-01-01T00:00:00Z'::timestamptz
         WHERE id = $1`,
        [ids.conversation, "e".repeat(64)],
      );

      const result = await client.query<{
        snapshot: {
          conversationAuthority: unknown;
          flowState: unknown;
          sourceObservations: Array<{
            source: string;
            observedAtMs: number | null;
          }>;
        };
      }>(
        "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
        [ids.call, ids.org],
      );

      expect(result.rows[0].snapshot.conversationAuthority).toBeNull();
      expect(result.rows[0].snapshot.flowState).toBeNull();
      expect(result.rows[0].snapshot.sourceObservations).toEqual(
        expect.arrayContaining([
          { source: "flow", observedAtMs: null },
          { source: "conversation", observedAtMs: null },
        ]),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("keeps worker summaries exact beyond the detail window and treats worker events as freshness", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const workerIds = await insertPendingWorkers(client, {
        conversationId: ids.conversation,
        organizationId: ids.org,
        callId: ids.call,
        count: 257,
      });
      const eventSha256 = randomUUID().replaceAll("-", "").repeat(2);
      const event = await client.query<{ observed_at_ms: string }>(
        `INSERT INTO voice_worker_events (
           conversation_id,
           worker_id,
           sequence,
           event_type,
           payload,
           payload_sha256,
           previous_event_sha256,
           event_sha256
         )
         VALUES ($1, $2, 1, 'cancellation_requested', '{}'::jsonb, $3, NULL, $4)
         RETURNING floor(extract(epoch FROM created_at) * 1000)::bigint
           AS observed_at_ms`,
        [
          ids.conversation,
          workerIds[0],
          "d".repeat(64),
          eventSha256,
        ],
      );
      const result = await client.query<{
        snapshot: {
          durableWorkers: Array<{ id: string }>;
          durableWorkerSummary: {
            total: number;
            byDeliveryState: Record<string, number>;
          };
          sourceObservations: Array<{
            source: string;
            observedAtMs: number | null;
          }>;
        };
      }>(
        "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
        [ids.call, ids.org],
      );
      const snapshot = result.rows[0].snapshot;

      expect(snapshot.durableWorkers).toHaveLength(256);
      expect(snapshot.durableWorkerSummary.total).toBe(257);
      expect(snapshot.durableWorkerSummary.byDeliveryState)
        .toEqual({ not_settled: 257 });
      expect(snapshot.sourceObservations.find(({ source }) => source === "workers"))
        .toEqual({
          source: "workers",
          observedAtMs: Number(event.rows[0].observed_at_ms),
        });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("redacts oversized tools and preserves unknown authority epochs without cast failure", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const receiptId = randomUUID();
      const receiptOwner = randomUUID();
      const proofId = randomUUID();
      const proofOwner = randomUUID();
      await client.query(
        `UPDATE flow_runs
         SET state = jsonb_set(
           state,
           '{capabilityEpoch}',
           '2147483648'::jsonb,
           true
         )
         WHERE call_id = $1`,
        [ids.call],
      );
      await insertPendingWorkers(client, {
        conversationId: ids.conversation,
        organizationId: ids.org,
        callId: ids.call,
        count: 1,
        policyEpochJson: "2147483648",
      });
      await client.query(
        `INSERT INTO flow_action_receipts (
           id,
           call_id,
           runtime_digest,
           capability_epoch,
           step_path,
           step_attempt,
           tool,
           invocation_id,
           arguments,
           arguments_hash,
           idempotency_key,
           status,
           owner_token,
           dispatch_lease_expires_at,
           owner_heartbeat_at
         )
         VALUES (
           $1,
           $2,
           $3,
           7,
           'adversarial',
           0,
           $4,
           $5,
           '{}'::jsonb,
           $6,
           $7,
           'reserved',
           $8,
           clock_timestamp() + interval '1 minute',
           clock_timestamp()
         )`,
        [
          receiptId,
          ids.call,
          "1".repeat(64),
          "private-tool-".padEnd(300, "x"),
          "A".repeat(24),
          "2".repeat(64),
          "3".repeat(64),
          receiptOwner,
        ],
      );
      await client.query(
        `UPDATE flow_action_receipts
         SET dispatch_started_at = clock_timestamp(),
             dispatch_attempt = 1,
             delivery_state = 'unknown'
         WHERE id = $1`,
        [receiptId],
      );
      const settled = await client.query<{ settled_at_ms: string }>(
        `UPDATE flow_action_receipts
         SET status = 'indeterminate',
             error = '{"code":"provider_timeout"}'::jsonb,
             settled_at = clock_timestamp()
         WHERE id = $1
         RETURNING floor(extract(epoch FROM settled_at) * 1000)::bigint
           AS settled_at_ms`,
        [receiptId],
      );
      await client.query(
        `INSERT INTO flow_action_reconciliation_proofs (
           id,
           call_id,
           action_receipt_id,
           runtime_digest,
           policy_hash,
           attempt,
           query_tool,
           query_arguments,
           query_arguments_hash,
           predicate,
           predicate_hash,
           authoritative_result_path,
           status,
           owner_token,
           lease_expires_at
         )
         VALUES (
           $1,
           $2,
           $3,
           $4,
           $5,
           1,
           'lookup',
           '{}'::jsonb,
           $6,
           '[]'::jsonb,
           $7,
           'result',
           'querying',
           $8,
           clock_timestamp() + interval '1 minute'
         )`,
        [
          proofId,
          ids.call,
          receiptId,
          "1".repeat(64),
          "4".repeat(64),
          "5".repeat(64),
          "6".repeat(64),
          proofOwner,
        ],
      );
      await client.query("SELECT pg_sleep(0.01)");
      const proof = await client.query<{ completed_at_ms: string }>(
        `UPDATE flow_action_reconciliation_proofs
         SET status = 'committed',
             proof_result = '{"terminal":"committed"}'::jsonb,
             proof_result_hash = $2,
             authoritative_result = '{"ok":true}'::jsonb,
             authoritative_result_hash = $3,
             completed_at = clock_timestamp()
         WHERE id = $1
         RETURNING floor(extract(epoch FROM completed_at) * 1000)::bigint
           AS completed_at_ms`,
        [proofId, "7".repeat(64), "8".repeat(64)],
      );
      await client.query(
        `UPDATE flow_action_receipts
         SET status = 'succeeded',
             result = '{"ok":true}'::jsonb,
             result_hash = $2,
             reconciliation_proof_id = $3,
             delivery_state = 'committed',
             error = NULL
         WHERE id = $1`,
        [receiptId, "8".repeat(64), proofId],
      );

      const result = await client.query<{
        snapshot: {
          flowState: {
            capabilityEpoch: number | null;
            actionReceipts: Array<{ tool: string }>;
          };
          durableWorkers: Array<{
            authority: { policyEpoch: number | null };
          }>;
          sourceObservations: Array<{
            source: string;
            observedAtMs: number | null;
          }>;
          recoveryObservations: Array<{
            kind: string;
            observedAtMs: number;
          }>;
        };
      }>(
        "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
        [ids.call, ids.org],
      );

      expect(result.rows[0].snapshot.flowState.capabilityEpoch).toBeNull();
      expect(result.rows[0].snapshot.flowState.actionReceipts)
        .toEqual([expect.objectContaining({ tool: "redacted_tool" })]);
      expect(result.rows[0].snapshot.durableWorkers[0].authority.policyEpoch)
        .toBeNull();
      const proofCompletedAtMs = Number(proof.rows[0].completed_at_ms);
      expect(proofCompletedAtMs).toBeGreaterThan(
        Number(settled.rows[0].settled_at_ms),
      );
      expect(result.rows[0].snapshot.sourceObservations
        .find(({ source }) => source === "flow")?.observedAtMs)
        .toBe(proofCompletedAtMs);
      expect(result.rows[0].snapshot.recoveryObservations)
        .toContainEqual(expect.objectContaining({
          kind: "action_reconciled",
          observedAtMs: proofCompletedAtMs,
        }));
      expect(JSON.stringify(result.rows[0].snapshot))
        .not.toContain("private-tool-");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("physically bounds an adversarial worker cap before failing closed", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await insertPendingWorkers(client, {
        conversationId: ids.conversation,
        organizationId: ids.org,
        callId: ids.call,
        // The contract fails at 10,001 identities. Keep the fixture just above
        // that boundary so the test exercises the cap without making
        // trigger-heavy fixture construction the performance measurement.
        count: 10_100,
        createdAt: "2026-07-28T12:00:00.000Z",
      });
      await client.query("ANALYZE voice_worker_jobs");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL enable_indexscan = on");
      await client.query("SET LOCAL enable_indexonlyscan = on");
      await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
      await client.query("SET LOCAL plan_cache_mode = force_custom_plan");

      const capPlan = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT count(*)
         FROM (
           SELECT 1
           FROM voice_worker_jobs job
           WHERE job.org_id = $1
             AND job.conversation_id = $2
           LIMIT 10001
         ) bounded_workers`,
        [ids.org, ids.conversation],
      );
      expectPhysicallyBoundedIndexPlan(
        capPlan.rows[0]["QUERY PLAN"],
      );

      const orderedPlan = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT array_agg(indexed.id ORDER BY indexed.created_at DESC, indexed.id)
         FROM (
           SELECT job.id, job.created_at
           FROM voice_worker_jobs job
           WHERE job.org_id = $1
             AND job.conversation_id = $2
           ORDER BY job.created_at DESC, job.id
           LIMIT 10000
         ) indexed`,
        [ids.org, ids.conversation],
      );
      expectPhysicallyBoundedIndexPlan(
        orderedPlan.rows[0]["QUERY PLAN"],
        "idx_voice_worker_jobs_org_conversation_created",
      );

      await expect(client.query(
        "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
        [ids.call, ids.org],
      )).rejects.toMatchObject({
        code: "54000",
        message: "call_operations_worker_identity_limit_exceeded",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }, 30_000);

  it("physically bounds the source-call fallback when no conversation is bound", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const unboundCallId = randomUUID();
      const distractorCallId = randomUUID();
      const unboundConversationId = randomUUID();
      await client.query(
        `INSERT INTO calls(id,agent_id,agent_version,direction,status)
         VALUES
           ($1,$3,1,'web','active'),
           ($2,$3,1,'web','active')`,
        [unboundCallId, distractorCallId, ids.agent],
      );
      await client.query(
        "SELECT * FROM ensure_voice_conversation($1,$2,$3,1,NULL)",
        [unboundConversationId, ids.org, ids.agent],
      );
      await insertPendingWorkers(client, {
        conversationId: unboundConversationId,
        organizationId: ids.org,
        callId: unboundCallId,
        count: 10_100,
        createdAt: "2026-07-28T12:00:00.000Z",
      });
      await insertPendingWorkers(client, {
        conversationId: unboundConversationId,
        organizationId: ids.org,
        callId: distractorCallId,
        count: 10_100,
        createdAt: "2026-07-28T12:00:00.000Z",
      });
      await client.query("ANALYZE voice_worker_jobs");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL enable_indexscan = on");
      await client.query("SET LOCAL enable_indexonlyscan = on");
      await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
      await client.query("SET LOCAL plan_cache_mode = force_custom_plan");

      const capPlan = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT count(*)
         FROM (
           SELECT 1
           FROM voice_worker_jobs job
           WHERE job.org_id = $1
             AND job.source_call_id = $2
           LIMIT 10001
         ) bounded_workers`,
        [ids.org, unboundCallId],
      );
      expectPhysicallyBoundedIndexPlan(
        capPlan.rows[0]["QUERY PLAN"],
        "idx_voice_worker_jobs_org_source_call_created",
      );

      await expect(client.query(
        "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
        [unboundCallId, ids.org],
      )).rejects.toMatchObject({
        code: "54000",
        message: "call_operations_worker_identity_limit_exceeded",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }, 40_000);

  it("uses exact recovery indexes under unrelated-event skew and hostile caller GUCs", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const unrelatedConversationId = randomUUID();
      await client.query(
        "SELECT * FROM ensure_voice_conversation($1,$2,$3,1,NULL)",
        [unrelatedConversationId, ids.org, ids.agent],
      );
      const [scopedWorkerId] = await insertPendingWorkers(client, {
        conversationId: ids.conversation,
        organizationId: ids.org,
        callId: ids.call,
        count: 1,
      });
      const [unrelatedWorkerId] = await insertPendingWorkers(client, {
        conversationId: unrelatedConversationId,
        organizationId: ids.org,
        callId: ids.call,
        count: 1,
      });
      await client.query(
        `INSERT INTO voice_worker_events (
           conversation_id,
           worker_id,
           sequence,
           event_type,
           payload,
           payload_sha256,
           previous_event_sha256,
           event_sha256,
           created_at
         )
         SELECT
           $1,
           $2,
           ordinal,
           'checkpointed',
           '{}'::jsonb,
           repeat('d', 64),
           NULL,
           lpad(to_hex(ordinal), 64, '0'),
           timestamptz '2026-07-28 12:00:00+00'
         FROM generate_series(1, 20000) ordinal`,
        [unrelatedConversationId, unrelatedWorkerId],
      );
      await client.query(
        `INSERT INTO voice_worker_events (
           conversation_id,
           worker_id,
           sequence,
           event_type,
           payload,
           payload_sha256,
           previous_event_sha256,
           event_sha256,
           created_at
         )
         VALUES (
           $1,
           $2,
           1,
           'checkpointed',
           '{}'::jsonb,
           repeat('e', 64),
           NULL,
           repeat('f', 64),
           timestamptz '2026-07-28 12:00:00+00'
         )`,
        [ids.conversation, scopedWorkerId],
      );
      await client.query("ANALYZE voice_worker_jobs");
      await client.query("ANALYZE voice_worker_events");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL enable_indexscan = on");
      await client.query("SET LOCAL enable_indexonlyscan = on");
      await client.query("SET LOCAL enable_nestloop = on");
      await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
      await client.query("SET LOCAL plan_cache_mode = force_custom_plan");

      const capPlan = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT count(*)
         FROM (
           SELECT 1
           FROM unnest(ARRAY[$1]::uuid[]) scoped_worker(worker_id)
           JOIN voice_worker_jobs scoped_job
             ON scoped_job.id = scoped_worker.worker_id
            AND scoped_job.org_id = $2
           CROSS JOIN LATERAL (
             SELECT event.id
             FROM voice_worker_events event
             WHERE event.conversation_id = scoped_job.conversation_id
               AND event.worker_id = scoped_worker.worker_id
               AND event.event_type IN (
                 'checkpointed',
                 'reclaimed',
                 'indeterminate'
               )
             LIMIT 10001
           ) recovery_event
           LIMIT 10001
         ) bounded_recovery_observations`,
        [scopedWorkerId, ids.org],
      );
      expectPhysicallyBoundedIndexPlan(
        capPlan.rows[0]["QUERY PLAN"],
        "idx_voice_worker_events_recovery",
      );

      const detailPlan = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT event.id
         FROM voice_worker_events event
         WHERE event.conversation_id = $1
           AND event.worker_id = $2
           AND event.event_type IN (
             'checkpointed',
             'reclaimed',
             'indeterminate'
           )
         ORDER BY event.created_at DESC, event.id
         LIMIT 10001`,
        [ids.conversation, scopedWorkerId],
      );
      expectPhysicallyBoundedIndexPlan(
        detailPlan.rows[0]["QUERY PLAN"],
        [
          "idx_voice_worker_events_recovery",
          "voice_worker_events_worker_id_sequence_key",
        ],
        true,
      );

      await client.query("SET LOCAL enable_indexscan = off");
      await client.query("SET LOCAL enable_indexonlyscan = off");
      await client.query("SET LOCAL enable_nestloop = off");
      const snapshot = await client.query<{
        snapshot: {
          recoveryObservations: Array<{ kind: string }>;
        };
      }>(
        "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
        [ids.call, ids.org],
      );
      expect(snapshot.rows[0].snapshot.recoveryObservations)
        .toContainEqual(expect.objectContaining({ kind: "worker_checkpointed" }));
      const restoredCallerSettings = await client.query<{
        enable_indexscan: string;
        enable_indexonlyscan: string;
        enable_nestloop: string;
      }>(
        `SELECT
           current_setting('enable_indexscan') AS enable_indexscan,
           current_setting('enable_indexonlyscan') AS enable_indexonlyscan,
           current_setting('enable_nestloop') AS enable_nestloop`,
      );
      expect(restoredCallerSettings.rows).toEqual([{
        enable_indexscan: "off",
        enable_indexonlyscan: "off",
        enable_nestloop: "off",
      }]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }, 20_000);

  it("removes stale runtime grants on reapply while preserving only backend execution", async () => {
    const existingRoles = await pool.query<{ rolname: string }>(
      `SELECT rolname
       FROM pg_roles
       WHERE rolname = ANY($1::text[])
       ORDER BY rolname`,
      [[...nonBackendRuntimeRoles, "hacc_backend"]],
    );
    const roleNames = existingRoles.rows.map(({ rolname }) => rolname);
    expect(roleNames).toContain("hacc_backend");
    expect(roleNames).toContain("hacc_worker");

    await pool.query(
      `GRANT EXECUTE ON FUNCTION ${projectionFunction} TO PUBLIC`,
    );
    await pool.query(
      `GRANT EXECUTE ON FUNCTION ${projectionFunction}
       TO hacc_backend WITH GRANT OPTION`,
    );
    for (const role of nonBackendRuntimeRoles) {
      if (roleNames.includes(role)) {
        await pool.query(
          `GRANT EXECUTE ON FUNCTION ${projectionFunction} TO "${role}"`,
        );
      }
    }

    await pool.query(migration039);
    await pool.query(migration039);

    const acl = await pool.query<{
      rolname: string;
      direct_execute: boolean;
      grantable: boolean;
    }>(
      `SELECT runtime_role.rolname,
              EXISTS (
                SELECT 1
                FROM pg_proc projection
                CROSS JOIN LATERAL aclexplode(
                  COALESCE(
                    projection.proacl,
                    acldefault('f', projection.proowner)
                  )
                ) privilege
                WHERE projection.oid = $1::regprocedure
                  AND privilege.grantee = runtime_role.oid
                  AND privilege.privilege_type = 'EXECUTE'
              ) AS direct_execute,
              COALESCE((
                SELECT bool_or(privilege.is_grantable)
                FROM pg_proc projection
                CROSS JOIN LATERAL aclexplode(
                  COALESCE(
                    projection.proacl,
                    acldefault('f', projection.proowner)
                  )
                ) privilege
                WHERE projection.oid = $1::regprocedure
                  AND privilege.grantee = runtime_role.oid
                  AND privilege.privilege_type = 'EXECUTE'
              ), false) AS grantable
       FROM pg_roles runtime_role
       WHERE runtime_role.rolname = ANY($2::text[])
       ORDER BY runtime_role.rolname`,
      [projectionFunction, roleNames],
    );
    const publicAcl = await pool.query<{ direct_execute: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_proc projection
         CROSS JOIN LATERAL aclexplode(
           COALESCE(
             projection.proacl,
             acldefault('f', projection.proowner)
           )
         ) privilege
         WHERE projection.oid = $1::regprocedure
           AND privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
       ) AS direct_execute`,
      [projectionFunction],
    );
    const exactRuntimeAcl = await pool.query<{
      rolname: string;
      grantable: boolean;
      owner_is_runtime: boolean;
    }>(
      `SELECT grantee.rolname,
              privilege.is_grantable AS grantable,
              owner_role.rolname = ANY($2::text[]) AS owner_is_runtime
       FROM pg_proc projection
       JOIN pg_roles owner_role
         ON owner_role.oid = projection.proowner
       CROSS JOIN LATERAL aclexplode(
         COALESCE(
           projection.proacl,
           acldefault('f', projection.proowner)
         )
       ) privilege
       JOIN pg_roles grantee
         ON grantee.oid = privilege.grantee
       WHERE projection.oid = $1::regprocedure
         AND privilege.privilege_type = 'EXECUTE'
         AND privilege.grantee <> projection.proowner
       ORDER BY grantee.rolname`,
      [
        projectionFunction,
        [...nonBackendRuntimeRoles, "hacc_backend"],
      ],
    );
    const functionConfig = await pool.query<{ proconfig: string[] }>(
      `SELECT proconfig
       FROM pg_proc
       WHERE oid = $1::regprocedure`,
      [projectionFunction],
    );

    expect(publicAcl.rows).toEqual([{ direct_execute: false }]);
    expect(acl.rows).toEqual(roleNames.sort().map((rolname) => ({
      rolname,
      direct_execute: rolname === "hacc_backend",
      grantable: false,
    })));
    expect(exactRuntimeAcl.rows).toEqual([{
      rolname: "hacc_backend",
      grantable: false,
      owner_is_runtime: false,
    }]);
    expect(functionConfig.rows).toEqual([{
      proconfig: [
        "search_path=pg_catalog, public",
        "enable_seqscan=off",
        "enable_bitmapscan=off",
        "enable_indexscan=on",
        "enable_indexonlyscan=on",
        "enable_nestloop=on",
        "max_parallel_workers_per_gather=0",
        "plan_cache_mode=force_custom_plan",
      ],
    }]);
  });
});
