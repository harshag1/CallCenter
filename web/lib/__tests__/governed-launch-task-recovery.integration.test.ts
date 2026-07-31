import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { AgentFlowSchema } from "../flow";
import {
  CallRuntimeSnapshotSchema,
  callRuntimeDigest,
} from "../call-runtime-snapshot";
import { canonicalJson, GENESIS_HASH } from "../conversation-kernel";
import { getPool } from "../db";
import {
  deriveFlowActionInvocationId,
  enterFlowStep,
  hashFlowValue,
  selectFlowTopic,
} from "../flow-runtime";
import {
  loadFlowState,
  markFlowActionDispatchStartedAtomic,
  reserveFlowActionAtomic,
  settleFlowActionAtomic,
  withLockedFlowState,
} from "../flow-state-store";
import {
  buildGovernedLaunchTaskWorkerInput,
  deriveGovernedLaunchTaskActionContextKey,
  deriveGovernedLaunchTaskIdentity,
  reconcileIndeterminateGovernedLaunchTask,
  verifyGovernedLaunchTaskSpawnReceipt,
  type GovernedLaunchTaskSpawnReceiptRow,
} from "../governed-launch-task-recovery";
import {
  canonicalVoiceWorkerJson,
  hashVoiceWorkerValue,
} from "../voice-workers/schema";

vi.mock("server-only", () => ({}));

const integrationDatabaseUrl = process.env.CONVERSATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(integrationDatabaseUrl));
const originalEnvironment = {
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL,
  supabaseDatabaseUrl: process.env.SUPABASE_DB_URL,
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

integration("governed launch_task immutable recovery projection", () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl });
  const ids = {
    organization: randomUUID(),
    otherOrganization: randomUUID(),
    agent: randomUUID(),
    call: randomUUID(),
    otherConversation: randomUUID(),
    receipt: randomUUID(),
    recoveryCall: randomUUID(),
    recoveryReceipt: randomUUID(),
  };
  const flowActionIdempotencyKey = sha256("governed launch task integration fixture");
  const runtimeDigest = sha256("governed launch task integration runtime");
  const identity = deriveGovernedLaunchTaskIdentity({
    conversationId: ids.call,
    organizationId: ids.organization,
    flowActionIdempotencyKey,
  });
  const command = "Research the exact policy that applies to this caller.";
  const goalId = `call-${ids.call}`;
  const occurredAtMs = Date.parse("2026-07-28T20:00:00.000Z");
  const spawnOccurredAtMs = occurredAtMs + 1;
  const reservedAt = new Date(spawnOccurredAtMs).toISOString();

  beforeAll(async () => {
    if (integrationDatabaseUrl) {
      const hostname = new URL(integrationDatabaseUrl).hostname.toLowerCase();
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
      if (loopback) {
        process.env.DATABASE_URL = integrationDatabaseUrl;
        delete process.env.SUPABASE_DB_URL;
        process.env.DATABASE_SSL = "disable";
      } else {
        delete process.env.DATABASE_URL;
        process.env.SUPABASE_DB_URL = integrationDatabaseUrl;
        process.env.DATABASE_SSL = "verify-full";
      }
    }
    await pool.query(
      "INSERT INTO orgs(id,name) VALUES ($1,'Launch recovery'),($2,'Other tenant')",
      [ids.organization, ids.otherOrganization],
    );
    await pool.query(
      "INSERT INTO agents(id,org_id,name,active_version) VALUES ($1,$2,'Recovery agent',1)",
      [ids.agent, ids.organization],
    );
    await pool.query(
      "INSERT INTO agent_versions(agent_id,version,instructions,created_by) VALUES ($1,1,'test','integration-test')",
      [ids.agent],
    );
    await pool.query(
      "INSERT INTO calls(id,agent_id,agent_version,direction,status) VALUES ($1,$2,1,'web','active')",
      [ids.call, ids.agent],
    );
    await pool.query(
      "SELECT * FROM ensure_voice_conversation($1,$2,$3,1,$4)",
      [ids.call, ids.organization, ids.agent, ids.call],
    );
    await pool.query(
      "SELECT * FROM ensure_voice_conversation($1,$2,$3,1,NULL)",
      [ids.otherConversation, ids.organization, ids.agent],
    );

    const goalUnsignedText = canonicalJson({
      version: 1,
      conversationId: ids.call,
      sequence: 1,
      previousHash: GENESIS_HASH,
      eventId: "launch-recovery-goal",
      occurredAtMs,
      payload: {
        type: "goal.activated",
        goalId,
        description: "Complete the caller's live voice objective under host authority.",
      },
    });
    const goalHash = sha256(goalUnsignedText);
    const goalBatchText = JSON.stringify([{
      idempotencyKey: "launch-recovery-goal",
      unsignedEvent: goalUnsignedText,
      eventHash: goalHash,
    }]);
    await pool.query(
      "SELECT * FROM append_voice_conversation_events($1,$2,$3,$4,$5)",
      [
        ids.call,
        ids.organization,
        GENESIS_HASH,
        goalBatchText,
        sha256(goalBatchText),
      ],
    );

    const capabilityManifest = {
      v: 1,
      mode: "read_only",
      capabilities: ["knowledge.search"],
      networkOrigins: [],
    };
    const workerInput = buildGovernedLaunchTaskWorkerInput({
      command,
      receiptId: ids.receipt,
      runtimeDigest,
      identity,
    });
    const spawnPayload = {
      type: "worker.spawned",
      workerId: identity.workerId,
      goalId,
      purpose: command,
      policyEpoch: 0,
      dependencies: [],
    };
    const spawnUnsignedText = canonicalJson({
      version: 1,
      conversationId: ids.call,
      sequence: 2,
      previousHash: goalHash,
      eventId: identity.conversationEventId,
      occurredAtMs: spawnOccurredAtMs,
      payload: spawnPayload,
    });
    const spawnHash = sha256(spawnUnsignedText);
    const capabilityManifestSha256 = hashVoiceWorkerValue(capabilityManifest);
    const authority = {
      v: 1,
      conversationId: ids.call,
      organizationId: ids.organization,
      agentId: ids.agent,
      agentVersion: 1,
      source: "voice_call",
      sourceCallId: ids.call,
      conversationHeadSha256: spawnHash,
      conversationRevision: 2,
      goalId,
      policyEpoch: 0,
      factDependencies: [],
      capabilityManifestSha256,
    };
    await pool.query(
      `SELECT * FROM spawn_governed_voice_worker(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL
       )`,
      [
        ids.call,
        ids.organization,
        goalHash,
        identity.workerIdempotencyKey,
        spawnUnsignedText,
        spawnHash,
        identity.workerId,
        identity.workerIdempotencyKey,
        "call.research",
        canonicalVoiceWorkerJson(authority),
        hashVoiceWorkerValue(authority),
        canonicalVoiceWorkerJson(workerInput),
        hashVoiceWorkerValue(workerInput),
        canonicalVoiceWorkerJson(capabilityManifest),
        capabilityManifestSha256,
        ids.call,
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
    await getPool().end();
    for (const [name, value] of Object.entries({
      DATABASE_URL: originalEnvironment.databaseUrl,
      DATABASE_SSL: originalEnvironment.databaseSsl,
      SUPABASE_DB_URL: originalEnvironment.supabaseDatabaseUrl,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("lets only hacc_backend recover exact immutable spawn evidence", async () => {
    const client = await pool.connect();
    try {
      const rolePrivileges = await client.query<{
        rolname: string;
        can_assume: boolean;
        can_execute: boolean;
      }>(
        `SELECT
           role.rolname,
           current_user = role.rolname
             OR pg_has_role(current_user, role.rolname, 'SET') AS can_assume,
           has_function_privilege(
             role.rolname,
             'public.load_governed_launch_task_spawn_receipt(uuid,uuid,uuid)',
             'EXECUTE'
           ) AS can_execute
         FROM pg_roles role
         WHERE role.rolname = ANY($1::text[])
         ORDER BY role.rolname`,
        [[
          "anon",
          "authenticated",
          "service_role",
          "hacc_backend",
          "hacc_worker",
        ]],
      );
      const byRole = new Map(rolePrivileges.rows.map((role) => [role.rolname, role]));
      expect(byRole.get("hacc_backend")?.can_execute).toBe(true);
      expect(byRole.get("hacc_worker")?.can_execute).toBe(false);
      for (const role of ["anon", "authenticated", "service_role"]) {
        if (byRole.has(role)) expect(byRole.get(role)?.can_execute).toBe(false);
      }

      const assumedBackend = byRole.get("hacc_backend")?.can_assume === true;
      if (assumedBackend) await client.query("SET ROLE hacc_backend");
      const exact = await client.query<GovernedLaunchTaskSpawnReceiptRow>(
        "SELECT * FROM load_governed_launch_task_spawn_receipt($1,$2,$3)",
        [identity.workerId, ids.organization, ids.call],
      );
      const crossOrganization = await client.query(
        "SELECT id FROM load_governed_launch_task_spawn_receipt($1,$2,$3)",
        [identity.workerId, ids.otherOrganization, ids.call],
      );
      const crossConversation = await client.query(
        "SELECT id FROM load_governed_launch_task_spawn_receipt($1,$2,$3)",
        [identity.workerId, ids.organization, ids.otherConversation],
      );
      expect(exact.rows).toHaveLength(1);
      expect(crossOrganization.rows).toEqual([]);
      expect(crossConversation.rows).toEqual([]);
      expect(Object.keys(exact.rows[0]).sort()).toEqual([
        "capability_manifest",
        "capability_manifest_sha256",
        "conversation_agent_id",
        "conversation_agent_version",
        "conversation_id",
        "event_id",
        "event_idempotency_key",
        "event_occurred_at_ms",
        "event_payload",
        "event_previous_sha256",
        "event_sequence",
        "event_sha256",
        "event_type",
        "event_unsigned_text",
        "id",
        "idempotency_key",
        "org_id",
        "parent_worker_id",
        "source_call_id",
        "spawn_authority",
        "spawn_authority_sha256",
        "spawn_created_at",
        "worker_input",
        "worker_input_sha256",
        "worker_kind",
      ]);
      expect(Object.keys(exact.rows[0])).not.toEqual(expect.arrayContaining([
        "status",
        "owner_token",
        "lease_expires_at",
        "checkpoint",
        "result",
        "error",
      ]));
      expect(verifyGovernedLaunchTaskSpawnReceipt({
        row: exact.rows[0],
        organizationId: ids.organization,
        conversationId: ids.call,
        flowActionIdempotencyKey,
        receiptId: ids.receipt,
        runtimeDigest,
        reservedAt,
        actionArguments: { command },
      })).toMatchObject({
        identity,
        result: {
          ok: true,
          worker_id: identity.workerId,
          spawn_status: "accepted",
        },
      });
      if (assumedBackend) await client.query("RESET ROLE");

      for (const { rolname: role, canAssume, canExecute } of rolePrivileges.rows.map((entry) => ({
        rolname: entry.rolname,
        canAssume: entry.can_assume,
        canExecute: entry.can_execute,
      }))) {
        if (role === "hacc_backend" || canExecute || !canAssume) continue;
        await client.query(`SET ROLE ${role}`);
        await expect(client.query(
          "SELECT * FROM load_governed_launch_task_spawn_receipt($1,$2,$3)",
          [identity.workerId, ids.organization, ids.call],
        )).rejects.toMatchObject({ code: "42501" });
        await client.query("RESET ROLE");
      }
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  }, 30_000);

  it("atomically promotes an indeterminate Flow receipt from committed spawn proof", async () => {
    const recoveryFlow = AgentFlowSchema.parse({
      schema_version: 2,
      tool_exposure: "gateway",
      always_tools: [],
      nodes: [
        { id: "entry", label: "Incoming", kind: "incoming_call" },
        {
          id: "research",
          label: "Research",
          kind: "topic",
          steps: [{
            id: "launch",
            label: "Launch research",
            instructions: "Launch one bounded read-only worker.",
            tools: ["launch_task"],
            action_policies: [{
              tool: "launch_task",
              idempotency: "per_arguments",
              max_calls: 1,
            }],
          }],
        },
      ],
      edges: [{ from: "entry", to: "research" }],
    });
    const runtimeSnapshot = CallRuntimeSnapshotSchema.parse({
      v: 2,
      agentVersion: 1,
      namedFlowId: null,
      flow: recoveryFlow,
      instructions: "Recover committed launch_task spawn evidence.",
      codeRevision: "governed-launch-recovery-integration",
      toolManifest: [],
      extensionManifest: [],
      externalMcpManifest: [],
      environment: {
        internetEnabled: false,
        allowedDomains: [],
        docsReady: false,
        datasetSlugs: [],
        holdMusic: false,
      },
      createdAt: "2026-07-28T20:00:00.000Z",
    });
    const recoveryRuntimeDigest = callRuntimeDigest(runtimeSnapshot);
    await pool.query(
      `INSERT INTO calls(
         id,agent_id,agent_version,direction,status,runtime_snapshot,runtime_digest
       ) VALUES ($1,$2,1,'web','active',$3,$4)`,
      [
        ids.recoveryCall,
        ids.agent,
        JSON.stringify(runtimeSnapshot),
        recoveryRuntimeDigest,
      ],
    );
    await pool.query(
      "SELECT * FROM ensure_voice_conversation($1,$2,$3,1,$4)",
      [ids.recoveryCall, ids.organization, ids.agent, ids.recoveryCall],
    );

    const recoveryGoalId = `call-${ids.recoveryCall}`;
    const goalUnsignedText = canonicalJson({
      version: 1,
      conversationId: ids.recoveryCall,
      sequence: 1,
      previousHash: GENESIS_HASH,
      eventId: "launch-reconciliation-goal",
      occurredAtMs,
      payload: {
        type: "goal.activated",
        goalId: recoveryGoalId,
        description: "Complete the caller's live voice objective under host authority.",
      },
    });
    const goalHash = sha256(goalUnsignedText);
    const goalBatchText = JSON.stringify([{
      idempotencyKey: "launch-reconciliation-goal",
      unsignedEvent: goalUnsignedText,
      eventHash: goalHash,
    }]);
    await pool.query(
      "SELECT * FROM append_voice_conversation_events($1,$2,$3,$4,$5)",
      [
        ids.recoveryCall,
        ids.organization,
        GENESIS_HASH,
        goalBatchText,
        sha256(goalBatchText),
      ],
    );

    await withLockedFlowState(ids.recoveryCall, (state) => {
      const selected = selectFlowTopic(recoveryFlow, state, "research");
      if ("error" in selected) throw new Error(selected.error);
      return { state: selected, value: null };
    });
    await withLockedFlowState(ids.recoveryCall, (state) => {
      const entered = enterFlowStep(recoveryFlow, state, "research.launch");
      if ("error" in entered) throw new Error(entered.error);
      return { state: entered.state, value: null };
    });
    const activeState = await loadFlowState(ids.recoveryCall);
    const ownerToken = randomUUID();
    const reservation = await reserveFlowActionAtomic(
      ids.recoveryCall,
      recoveryFlow,
      {
        receiptId: ids.recoveryReceipt,
        invocationId: deriveFlowActionInvocationId(
          `launch-recovery:${ids.recoveryCall}`,
        ),
        ownerToken,
        runtimeDigest: recoveryRuntimeDigest,
        tool: "launch_task",
        arguments: { command },
        capabilityEpoch: activeState.capabilityEpoch,
      },
    );
    if ("error" in reservation) throw new Error(reservation.error);
    expect(reservation).toMatchObject({ execute: true, replayed: false });
    const marked = await markFlowActionDispatchStartedAtomic(ids.recoveryCall, {
      receiptId: reservation.receipt.id,
      ownerToken,
      runtimeDigest: recoveryRuntimeDigest,
    });
    if ("error" in marked) throw new Error(marked.error);
    const indeterminate = await settleFlowActionAtomic(ids.recoveryCall, {
      receiptId: reservation.receipt.id,
      ownerToken,
      status: "indeterminate",
      error: "response lost after the durable spawn boundary",
      deliveryState: "unknown",
    });
    if ("error" in indeterminate) throw new Error(indeterminate.error);
    expect(indeterminate.receipt.status).toBe("indeterminate");

    const actionContextKey = deriveGovernedLaunchTaskActionContextKey({
      organizationId: ids.organization,
      callId: ids.recoveryCall,
      ledgerIdempotencyKey: reservation.receipt.idempotencyKey,
    });
    const recoveryIdentity = deriveGovernedLaunchTaskIdentity({
      conversationId: ids.recoveryCall,
      organizationId: ids.organization,
      flowActionIdempotencyKey: actionContextKey,
    });
    const capabilityManifest = {
      v: 1,
      mode: "read_only",
      capabilities: ["knowledge.search"],
      networkOrigins: [],
    };
    const workerInput = buildGovernedLaunchTaskWorkerInput({
      command,
      receiptId: reservation.receipt.id,
      runtimeDigest: recoveryRuntimeDigest,
      identity: recoveryIdentity,
    });
    const spawnOccurredAt = Date.parse(reservation.receipt.reservedAt);
    if (!Number.isSafeInteger(spawnOccurredAt) || spawnOccurredAt < 0) {
      throw new Error("reserved launch timestamp is invalid");
    }
    const spawnUnsignedText = canonicalJson({
      version: 1,
      conversationId: ids.recoveryCall,
      sequence: 2,
      previousHash: goalHash,
      eventId: recoveryIdentity.conversationEventId,
      occurredAtMs: spawnOccurredAt,
      payload: {
        type: "worker.spawned",
        workerId: recoveryIdentity.workerId,
        goalId: recoveryGoalId,
        purpose: command,
        policyEpoch: 0,
        dependencies: [],
      },
    });
    const spawnHash = sha256(spawnUnsignedText);
    const capabilityManifestSha256 = hashVoiceWorkerValue(capabilityManifest);
    const authority = {
      v: 1,
      conversationId: ids.recoveryCall,
      organizationId: ids.organization,
      agentId: ids.agent,
      agentVersion: 1,
      source: "voice_call",
      sourceCallId: ids.recoveryCall,
      conversationHeadSha256: spawnHash,
      conversationRevision: 2,
      goalId: recoveryGoalId,
      policyEpoch: 0,
      factDependencies: [],
      capabilityManifestSha256,
    };
    await pool.query(
      `SELECT * FROM spawn_governed_voice_worker(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL
       )`,
      [
        ids.recoveryCall,
        ids.organization,
        goalHash,
        recoveryIdentity.workerIdempotencyKey,
        spawnUnsignedText,
        spawnHash,
        recoveryIdentity.workerId,
        recoveryIdentity.workerIdempotencyKey,
        "call.research",
        canonicalVoiceWorkerJson(authority),
        hashVoiceWorkerValue(authority),
        canonicalVoiceWorkerJson(workerInput),
        hashVoiceWorkerValue(workerInput),
        canonicalVoiceWorkerJson(capabilityManifest),
        capabilityManifestSha256,
        ids.recoveryCall,
      ],
    );

    const before = await pool.query<{ db_now: Date }>(
      "SELECT clock_timestamp() AS db_now",
    );
    const outcome = await reconcileIndeterminateGovernedLaunchTask({
      callId: ids.recoveryCall,
      organizationId: ids.organization,
      conversationId: ids.recoveryCall,
      receiptId: reservation.receipt.id,
      runtimeDigest: recoveryRuntimeDigest,
    });
    const after = await pool.query<{ db_now: Date }>(
      "SELECT clock_timestamp() AS db_now",
    );
    expect(outcome).toMatchObject({
      reconciled: true,
      replayed: false,
      receiptId: reservation.receipt.id,
      proofId: expect.any(String),
      result: {
        ok: true,
        worker_id: recoveryIdentity.workerId,
        spawn_status: "accepted",
      },
    });

    const persistedState = await loadFlowState(ids.recoveryCall);
    const persistedReceipt = persistedState.actionReceipts.find(
      ({ id }) => id === reservation.receipt.id,
    );
    expect(persistedReceipt).toMatchObject({
      status: "succeeded",
      result: {
        ok: true,
        worker_id: recoveryIdentity.workerId,
        spawn_status: "accepted",
      },
    });
    const evidence = await pool.query<{
      receipt_status: string;
      delivery_state: string;
      settled_at: Date;
      result_hash: string;
      reconciliation_proof_id: string;
      proof_status: string;
      proof_result_hash: string;
      authoritative_result_hash: string;
      completed_at: Date;
    }>(
      `SELECT
         receipt.status AS receipt_status,
         receipt.delivery_state,
         receipt.settled_at,
         receipt.result_hash,
         receipt.reconciliation_proof_id,
         proof.status AS proof_status,
         proof.proof_result_hash,
         proof.authoritative_result_hash,
         proof.completed_at
       FROM flow_action_receipts receipt
       JOIN flow_action_reconciliation_proofs proof
         ON proof.id = receipt.reconciliation_proof_id
       WHERE receipt.id = $1 AND receipt.call_id = $2`,
      [reservation.receipt.id, ids.recoveryCall],
    );
    const expectedResultHash = hashFlowValue({
      ok: true,
      worker_id: recoveryIdentity.workerId,
      spawn_status: "accepted",
    });
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({
      receipt_status: "succeeded",
      delivery_state: "committed",
      result_hash: expectedResultHash,
      reconciliation_proof_id: outcome.reconciled ? outcome.proofId : null,
      proof_status: "committed",
      authoritative_result_hash: expectedResultHash,
      proof_result_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      completed_at: expect.any(Date),
    });
    expect(evidence.rows[0].settled_at.toISOString()).toBe(
      persistedReceipt?.settledAt,
    );
    expect(evidence.rows[0].settled_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0].db_now.getTime(),
    );
    expect(evidence.rows[0].settled_at.getTime()).toBeLessThanOrEqual(
      after.rows[0].db_now.getTime(),
    );

    await expect(reconcileIndeterminateGovernedLaunchTask({
      callId: ids.recoveryCall,
      organizationId: ids.organization,
      conversationId: ids.recoveryCall,
      receiptId: reservation.receipt.id,
      runtimeDigest: recoveryRuntimeDigest,
    })).resolves.toMatchObject({
      reconciled: true,
      replayed: true,
      receiptId: reservation.receipt.id,
      proofId: evidence.rows[0].reconciliation_proof_id,
    });
    const proofCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM flow_action_reconciliation_proofs WHERE action_receipt_id=$1",
      [reservation.receipt.id],
    );
    expect(proofCount.rows).toEqual([{ count: "1" }]);
  }, 30_000);
});
