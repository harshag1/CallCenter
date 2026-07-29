import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  canonicalVoiceWorkerJson,
  hashVoiceWorkerValue,
} from "../voice-workers/schema";

const integrationDatabaseUrl = process.env.CONVERSATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(integrationDatabaseUrl));

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

integration("044 governed worker drain and integrity", () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl });
  const ids = {
    organization: randomUUID(),
    agent: randomUUID(),
    call: randomUUID(),
    versionMismatchConversation: randomUUID(),
  };
  const manifest = {
    v: 1,
    mode: "read_only" as const,
    capabilities: ["search_knowledge"],
    networkOrigins: [],
  };
  const workerInput = {
    v: 1,
    objective: "Find the exact policy.",
    context: {},
    deliverable: "Return a bounded summary.",
  };

  async function spawn(
    workerId: string,
    workerKind = "call.research",
  ): Promise<void> {
    const manifestSha256 = hashVoiceWorkerValue(manifest);
    const authority = {
      v: 1,
      conversationId: ids.call,
      organizationId: ids.organization,
      agentId: ids.agent,
      agentVersion: 1,
      source: "voice_call" as const,
      sourceCallId: ids.call,
      conversationHeadSha256: "0".repeat(64),
      conversationRevision: 0,
      goalId: "call-primary",
      policyEpoch: 0,
      factDependencies: [],
      capabilityManifestSha256: manifestSha256,
    };
    await pool.query(
      `SELECT id FROM spawn_voice_worker_job(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL
       )`,
      [
        workerId,
        ids.call,
        `integrity:${workerId}`,
        workerKind,
        canonicalVoiceWorkerJson(authority),
        hashVoiceWorkerValue(authority),
        canonicalVoiceWorkerJson(workerInput),
        hashVoiceWorkerValue(workerInput),
        canonicalVoiceWorkerJson(manifest),
        manifestSha256,
        ids.call,
      ],
    );
  }

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO orgs(id,name) VALUES ($1,'Worker integrity')",
      [ids.organization],
    );
    await pool.query(
      "INSERT INTO agents(id,org_id,name,active_version) VALUES ($1,$2,'Worker agent',2)",
      [ids.agent, ids.organization],
    );
    await pool.query(
      `INSERT INTO agent_versions(agent_id,version,instructions,created_by)
       VALUES ($1,1,'v1','integration-test'),($1,2,'v2','integration-test')`,
      [ids.agent],
    );
    await pool.query(
      `INSERT INTO calls(id,agent_id,agent_version,direction,status)
       VALUES ($1,$2,1,'web','active')`,
      [ids.call, ids.agent],
    );
    await pool.query(
      "SELECT id FROM ensure_voice_conversation($1,$2,$3,1,$4)",
      [ids.call, ids.organization, ids.agent, ids.call],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects a source call whose immutable agent version does not match", async () => {
    await expect(pool.query(
      "SELECT id FROM ensure_voice_conversation($1,$2,$3,2,$4)",
      [
        ids.versionMismatchConversation,
        ids.organization,
        ids.agent,
        ids.call,
      ],
    )).rejects.toThrow(/voice_conversation_call_authority_mismatch/);
  });

  it("rejects noncanonical and schema-invalid direct SQL before accepting exact bytes", async () => {
    const workerId = randomUUID();
    const ownerToken = randomUUID();
    await spawn(workerId);
    await pool.query(
      "SELECT id FROM claim_voice_worker_job_exact($1,$2,$3,$4,120000)",
      [workerId, ids.organization, ids.call, ownerToken],
    );
    await pool.query(
      "SELECT id FROM mark_voice_worker_dispatch_started_exact($1,$2,$3,$4)",
      [workerId, ids.organization, ids.call, ownerToken],
    );
    const result = {
      v: 1,
      facts: [],
      citations: [],
      proposedActions: [],
      summary: "Exact canonical evidence.",
    };
    const noncanonical = JSON.stringify(result, null, 2);
    await expect(pool.query(
      `SELECT id FROM settle_voice_worker_job_exact(
         $1,$2,$3,$4,'succeeded',$5,$6,NULL
       )`,
      [
        workerId,
        ids.organization,
        ids.call,
        ownerToken,
        noncanonical,
        sha256(noncanonical),
      ],
    )).rejects.toThrow(/voice_worker_result_not_canonical/);

    const malformed = canonicalVoiceWorkerJson({ ...result, summary: "" });
    await expect(pool.query(
      `SELECT id FROM settle_voice_worker_job_exact(
         $1,$2,$3,$4,'succeeded',$5,$6,NULL
       )`,
      [
        workerId,
        ids.organization,
        ids.call,
        ownerToken,
        malformed,
        sha256(malformed),
      ],
    )).rejects.toThrow(/voice_worker_result_schema_invalid/);

    const canonical = canonicalVoiceWorkerJson(result);
    await expect(pool.query(
      `SELECT id FROM settle_voice_worker_job_exact(
         $1,$2,$3,$4,'succeeded',$5,$6,NULL
       )`,
      [
        workerId,
        ids.organization,
        ids.call,
        ownerToken,
        canonical,
        sha256(canonical),
      ],
    )).resolves.toMatchObject({ rows: [{ id: workerId }] });

    const inbox = await pool.query<{ id: string }>(
      "SELECT id FROM voice_conversation_inbox WHERE worker_id=$1",
      [workerId],
    );
    expect(inbox.rows).toHaveLength(1);
    await pool.query(
      "UPDATE voice_conversation_inbox SET delivery_count=16 WHERE id=$1",
      [inbox.rows[0]!.id],
    );
    const claimed = await pool.query(
      "SELECT id FROM claim_voice_conversation_inbox($1,$2,$3,30000,16)",
      [ids.call, ids.organization, randomUUID()],
    );
    expect(claimed.rows).toEqual([]);
    const quarantined = await pool.query(
      `SELECT quarantine_reason, application_id, applied_context_version
       FROM voice_conversation_inbox WHERE id=$1`,
      [inbox.rows[0]!.id],
    );
    expect(quarantined.rows).toEqual([{
      quarantine_reason: "delivery_attempt_limit",
      application_id: null,
      applied_context_version: null,
    }]);
  });

  it("reclaims process loss but terminalizes after the durable third attempt", async () => {
    const workerId = randomUUID();
    await spawn(workerId);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const ownerToken = randomUUID();
      const claimed = await pool.query<{
        id: string;
        execution_attempt_count: number;
      }>(
        "SELECT id,execution_attempt_count FROM claim_voice_worker_job_exact($1,$2,$3,$4,5000)",
        [workerId, ids.organization, ids.call, ownerToken],
      );
      expect(claimed.rows).toEqual([{
        id: workerId,
        execution_attempt_count: attempt,
      }]);
      await pool.query(
        "SELECT id FROM mark_voice_worker_dispatch_started_exact($1,$2,$3,$4)",
        [workerId, ids.organization, ids.call, ownerToken],
      );
      await pool.query(
        `UPDATE voice_worker_jobs
         SET claimed_at=clock_timestamp()-interval '10 seconds',
             heartbeat_at=clock_timestamp()-interval '6 seconds',
             lease_expires_at=clock_timestamp()-interval '1 second'
         WHERE id=$1`,
        [workerId],
      );
    }
    const exhausted = await pool.query(
      "SELECT id FROM claim_voice_worker_job_exact($1,$2,$3,$4,5000)",
      [workerId, ids.organization, ids.call, randomUUID()],
    );
    expect(exhausted.rows).toEqual([]);
    const status = await pool.query(
      "SELECT status,error->>'code' AS code,execution_attempt_count FROM voice_worker_jobs WHERE id=$1",
      [workerId],
    );
    expect(status.rows).toEqual([{
      status: "failed",
      code: "worker_execution_attempt_limit",
      execution_attempt_count: 3,
    }]);
  });

  it("exposes exact call-research transitions only to the narrow worker role", async () => {
    const privileges = await pool.query(
      `SELECT
         has_function_privilege(
           'hacc_voice_worker',
           'public.next_governed_voice_worker_candidate()',
           'EXECUTE'
         ) AS voice_can_discover,
         has_function_privilege(
           'hacc_voice_worker',
           'public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer)',
           'EXECUTE'
         ) AS voice_can_claim_exact,
         has_function_privilege(
           'hacc_voice_worker',
           'public.claim_voice_worker_job(uuid,integer)',
           'EXECUTE'
         ) AS voice_can_claim_global,
         has_function_privilege(
           'hacc_backend',
           'public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer)',
           'EXECUTE'
         ) AS backend_can_claim_exact,
         has_function_privilege(
           'hacc_worker',
           'public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer)',
           'EXECUTE'
         ) AS dialer_can_claim_exact`,
    );
    expect(privileges.rows).toEqual([{
      voice_can_discover: true,
      voice_can_claim_exact: true,
      voice_can_claim_global: false,
      backend_can_claim_exact: false,
      dialer_can_claim_exact: false,
    }]);

    const unrelatedWorker = randomUUID();
    await spawn(unrelatedWorker, "future.read.recipe");
    const callWorker = randomUUID();
    await spawn(callWorker);
    const workerConnection = await pool.connect();
    try {
      await workerConnection.query("BEGIN");
      const unrelated = await workerConnection.query(
        "SELECT id FROM claim_voice_worker_job_exact($1,$2,$3,$4,120000)",
        [
          unrelatedWorker,
          ids.organization,
          ids.call,
          randomUUID(),
        ],
      );
      expect(unrelated.rows).toEqual([]);
      const exact = await workerConnection.query(
        "SELECT id FROM claim_voice_worker_job_exact($1,$2,$3,$4,120000)",
        [
          callWorker,
          ids.organization,
          ids.call,
          randomUUID(),
        ],
      );
      expect(exact.rows).toEqual([{ id: callWorker }]);
    } finally {
      await workerConnection.query("ROLLBACK");
      workerConnection.release();
    }
  });
});
