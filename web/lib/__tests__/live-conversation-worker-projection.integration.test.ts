import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  canonicalVoiceWorkerJson,
  hashVoiceWorkerValue,
} from "../voice-workers/schema";

const integrationDatabaseUrl = process.env.CONVERSATION_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(integrationDatabaseUrl));

integration("038 live conversation worker projection", () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl });
  const ids = {
    org: randomUUID(),
    otherOrg: randomUUID(),
    agent: randomUUID(),
    call: randomUUID(),
    conversation: randomUUID(),
    otherConversation: randomUUID(),
    worker: randomUUID(),
  };
  const manifest = {
    v: 1,
    mode: "read_only",
    capabilities: ["knowledge.search"],
    networkOrigins: [],
  };
  const workerInput = {
    v: 1,
    objective: "Find the relevant policy.",
    context: {},
    deliverable: "Return cited facts.",
  };
  const ownerToken = randomUUID();

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO orgs(id,name) VALUES ($1,'Live route projection'),($2,'Other tenant')",
      [ids.org, ids.otherOrg],
    );
    await pool.query(
      "INSERT INTO agents(id,org_id,name,active_version) VALUES ($1,$2,'Projection agent',1)",
      [ids.agent, ids.org],
    );
    await pool.query(
      "INSERT INTO agent_versions(agent_id,version,instructions,created_by) VALUES ($1,1,'test','integration-test')",
      [ids.agent],
    );
    await pool.query(
      "INSERT INTO calls(id,agent_id,agent_version,direction,status) VALUES ($1,$2,1,'web','active')",
      [ids.call, ids.agent],
    );
    await pool.query("SELECT * FROM ensure_voice_conversation($1,$2,$3,1,$4)", [
      ids.conversation,
      ids.org,
      ids.agent,
      ids.call,
    ]);
    await pool.query("SELECT * FROM ensure_voice_conversation($1,$2,$3,1,NULL)", [
      ids.otherConversation,
      ids.org,
      ids.agent,
    ]);
    const manifestSha256 = hashVoiceWorkerValue(manifest);
    const authority = {
      v: 1,
      conversationId: ids.conversation,
      organizationId: ids.org,
      agentId: ids.agent,
      agentVersion: 1,
      source: "voice_call",
      sourceCallId: ids.call,
      conversationHeadSha256: "0".repeat(64),
      conversationRevision: 0,
      goalId: "call-primary",
      policyEpoch: 0,
      factDependencies: [],
      capabilityManifestSha256: manifestSha256,
    };
    await pool.query(
      `SELECT * FROM spawn_voice_worker_job(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL
       )`,
      [
        ids.worker,
        ids.conversation,
        "live-route-projection:test",
        "call.research",
        canonicalVoiceWorkerJson(authority),
        hashVoiceWorkerValue(authority),
        canonicalVoiceWorkerJson(workerInput),
        hashVoiceWorkerValue(workerInput),
        canonicalVoiceWorkerJson(manifest),
        manifestSha256,
        ids.call,
      ],
    );
    const claimed = await pool.query(
      "SELECT id FROM claim_voice_worker_job_exact($1,$2,$3,$4,120000)",
      [ids.worker, ids.org, ids.conversation, ownerToken],
    );
    expect(claimed.rows).toEqual([{ id: ids.worker }]);
    await pool.query(
      "SELECT id FROM mark_voice_worker_dispatch_started_exact($1,$2,$3,$4)",
      [ids.worker, ids.org, ids.conversation, ownerToken],
    );
    const result = {
      v: 1,
      facts: [],
      citations: [],
      proposedActions: [],
      summary: "The immutable read-only worker completed.",
    };
    await pool.query(
      `SELECT id FROM settle_voice_worker_job_exact(
         $1,$2,$3,$4,'succeeded',$5,$6,NULL
       )`,
      [
        ids.worker,
        ids.org,
        ids.conversation,
        ownerToken,
        canonicalVoiceWorkerJson(result),
        hashVoiceWorkerValue(result),
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns one immutable worker only for the exact organization and conversation", async () => {
    const exact = await pool.query(
      "SELECT * FROM load_voice_worker_for_delivery($1,$2,$3)",
      [ids.worker, ids.org, ids.conversation],
    );
    expect(exact.rows).toHaveLength(1);
    expect(exact.rows[0]).toEqual({
      id: ids.worker,
      org_id: ids.org,
      conversation_id: ids.conversation,
      source_call_id: ids.call,
      spawn_authority: expect.objectContaining({
        agentId: ids.agent,
        conversationId: ids.conversation,
        organizationId: ids.org,
        source: "voice_call",
        sourceCallId: ids.call,
      }),
      spawn_authority_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      result_sha256: hashVoiceWorkerValue({
        v: 1,
        facts: [],
        citations: [],
        proposedActions: [],
        summary: "The immutable read-only worker completed.",
      }),
      settled_at: expect.any(Date),
    });

    const crossOrganization = await pool.query(
      "SELECT id FROM load_voice_worker_for_delivery($1,$2,$3)",
      [ids.worker, ids.otherOrg, ids.conversation],
    );
    const crossConversation = await pool.query(
      "SELECT id FROM load_voice_worker_for_delivery($1,$2,$3)",
      [ids.worker, ids.org, ids.otherConversation],
    );
    expect(crossOrganization.rows).toEqual([]);
    expect(crossConversation.rows).toEqual([]);

    await expect(pool.query(
      "UPDATE voice_worker_jobs SET source_call_id=NULL WHERE id=$1",
      [ids.worker],
    )).rejects.toThrow(/voice worker spawn authority and input are immutable/);
  });

  it("gives hacc_backend the projection but no worker bearer or legacy executor transition", async () => {
    const privileges = await pool.query<{
      can_load_delivery: boolean;
      can_read_jobs: boolean;
      can_append_event: boolean;
      can_claim_legacy: boolean;
      can_heartbeat_legacy: boolean;
      can_settle_legacy: boolean;
    }>(
      `SELECT
         has_function_privilege(
           'hacc_backend',
           'public.load_voice_worker_for_delivery(uuid,uuid,uuid)',
           'EXECUTE'
         ) AS can_load_delivery,
         has_table_privilege(
           'hacc_backend',
           'public.voice_worker_jobs',
           'SELECT'
         ) AS can_read_jobs,
         has_function_privilege(
           'hacc_backend',
           'public.append_voice_worker_event(uuid,text,text,text)',
           'EXECUTE'
         ) AS can_append_event,
         has_function_privilege(
           'hacc_backend',
           'public.claim_voice_worker_job(uuid,integer)',
           'EXECUTE'
         ) AS can_claim_legacy,
         has_function_privilege(
           'hacc_backend',
           'public.heartbeat_voice_worker_job(uuid,uuid,integer)',
           'EXECUTE'
         ) AS can_heartbeat_legacy,
         has_function_privilege(
           'hacc_backend',
           'public.settle_voice_worker_job(uuid,uuid,text,text,text,text)',
           'EXECUTE'
         ) AS can_settle_legacy`,
    );
    expect(privileges.rows).toEqual([{
      can_load_delivery: true,
      can_read_jobs: false,
      can_append_event: false,
      can_claim_legacy: false,
      can_heartbeat_legacy: false,
      can_settle_legacy: false,
    }]);
  });
});
