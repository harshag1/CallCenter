import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrations = resolve(process.cwd(), "migrations");
const acl = readFileSync(
  resolve(migrations, "042_voice_worker_function_acl.sql"),
  "utf8",
);
const runtime = readFileSync(
  resolve(migrations, "043_governed_voice_worker_runtime.sql"),
  "utf8",
);
const integrity = readFileSync(
  resolve(migrations, "044_governed_worker_drain_and_integrity.sql"),
  "utf8",
);

function functionBody(name: string, nextName: string): string {
  const start = runtime.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const end = runtime.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return runtime.slice(start, end);
}

function integrityFunctionBody(name: string, nextName: string): string {
  const start = integrity.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const end = integrity.indexOf(
    `CREATE OR REPLACE FUNCTION public.${nextName}`,
    start + 1,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return integrity.slice(start, end);
}

describe("governed worker runtime migration authority", () => {
  it("applies legacy ACL closure before adding the exact embedded-executor surface", () => {
    const ordered = readdirSync(migrations)
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort();
    expect(ordered.indexOf("042_voice_worker_function_acl.sql")).toBeLessThan(
      ordered.indexOf("043_governed_voice_worker_runtime.sql"),
    );
    for (const signature of [
      "claim_voice_worker_job\\(uuid,integer\\)",
      "heartbeat_voice_worker_job\\(uuid,uuid,integer\\)",
      "mark_voice_worker_dispatch_started\\(uuid,uuid\\)",
      "checkpoint_voice_worker_job\\(uuid,uuid,text,text\\)",
      "settle_voice_worker_job\\(uuid,uuid,text,text,text,text\\)",
    ]) {
      expect(acl).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${signature} FROM %I`,
      ));
      expect(acl).not.toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${signature} TO hacc_backend`,
      ));
    }
    expect(acl).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_voice_worker_job\(uuid,integer\) TO hacc_worker/,
    );
  });

  it("claims one exact worker and never performs a global tenant queue scan", () => {
    const claim = functionBody(
      "claim_voice_worker_job_exact",
      "heartbeat_voice_worker_job_exact",
    );
    expect(claim).toMatch(/WHERE id = worker_identity/);
    expect(claim).toMatch(/AND org_id = organization_identity/);
    expect(claim).toMatch(/AND conversation_id = conversation_identity/);
    expect(claim).toMatch(/FOR UPDATE/);
    expect(claim).not.toMatch(/ORDER BY created_at/);
    expect(claim).not.toMatch(/FOR .* IN\s+SELECT/);
  });

  it("cannot heartbeat or begin dispatch after cancellation changes the claimed epoch", () => {
    const heartbeat = functionBody(
      "heartbeat_voice_worker_job_exact",
      "mark_voice_worker_dispatch_started_exact",
    );
    expect(heartbeat).toMatch(/AND status = 'running'/);
    expect(heartbeat).toMatch(/AND claimed_cancellation_epoch = cancellation_epoch/);
    expect(heartbeat).not.toMatch(/status IN \('running','cancel_requested'\)/);

    const dispatch = functionBody(
      "mark_voice_worker_dispatch_started_exact",
      "settle_voice_worker_job_exact",
    );
    expect(dispatch).toMatch(/AND status = 'running'/);
    expect(dispatch).toMatch(/AND claimed_cancellation_epoch = cancellation_epoch/);

    const settlement = functionBody(
      "settle_voice_worker_job_exact",
      "load_voice_worker_status",
    );
    expect(settlement).toMatch(
      /job\.status = 'cancel_requested' AND terminal_status <> 'cancelled'/,
    );
    expect(settlement).toMatch(/voice_worker_cancellation_must_settle_cancelled/);
  });

  it("keeps status and terminal delivery projections scoped and content-minimal", () => {
    const status = functionBody(
      "load_voice_worker_status",
      "apply_governed_voice_worker_terminal",
    );
    expect(status).toMatch(/RETURNS TABLE\(id uuid, status text\)/);
    expect(status).toMatch(/job\.id = worker_identity/);
    expect(status).toMatch(/job\.org_id = organization_identity/);
    expect(status).toMatch(/job\.conversation_id = conversation_identity/);
    for (const bearer of ["owner_token", "lease_expires_at", "worker_input", "result", "error"]) {
      expect(status).not.toContain(bearer);
    }

    const terminal = runtime.slice(
      runtime.indexOf("CREATE OR REPLACE FUNCTION public.apply_governed_voice_worker_terminal"),
      runtime.indexOf("REVOKE ALL ON FUNCTION public.voice_worker_terminal_payload_sha256"),
    );
    expect(terminal).toMatch(/job\.conversation_id = conversation_identity/);
    expect(terminal).toMatch(/job\.org_id = organization_identity/);
    expect(terminal).toMatch(/worker\.status NOT IN \('failed','cancelled','indeterminate'\)/);
    expect(terminal).toMatch(/appended\.event_type <> 'worker\.finished'/);
  });

  it("revokes every embedded transition before granting only exact scoped functions to hacc_backend", () => {
    for (const role of ["anon", "authenticated", "service_role", "hacc_backend", "hacc_worker"]) {
      expect(runtime).toContain(`'${role}'`);
    }
    const defaultAclClosure = runtime.slice(
      runtime.indexOf("DO $governed_voice_worker_runtime_default_acl_closure$"),
      runtime.indexOf("DO $governed_voice_worker_runtime_grants$"),
    );
    for (const signature of [
      "voice_worker_terminal_payload_sha256\\(uuid,text,text,text\\)",
      "enqueue_voice_worker_terminal_projection\\(uuid\\)",
      "enqueue_voice_worker_terminal_projection_trigger\\(\\)",
      "claim_voice_worker_job_exact\\(uuid,uuid,uuid,uuid,integer\\)",
      "heartbeat_voice_worker_job_exact\\(uuid,uuid,uuid,uuid,integer\\)",
      "mark_voice_worker_dispatch_started_exact\\(uuid,uuid,uuid,uuid\\)",
      "settle_voice_worker_job_exact\\(uuid,uuid,uuid,uuid,text,text,text,text\\)",
      "load_voice_worker_status\\(uuid,uuid,uuid\\)",
      "apply_governed_voice_worker_terminal\\(uuid,uuid,uuid,uuid,uuid,text,text,text,text\\)",
    ]) {
      expect(defaultAclClosure).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${signature} FROM %I`,
      ));
    }
    expect(defaultAclClosure).toContain("'hacc_worker'");
    expect(runtime).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.(?:voice_worker_terminal_payload_sha256|enqueue_voice_worker_terminal_projection|enqueue_voice_worker_terminal_projection_trigger)/,
    );
    const backendGrant = runtime.slice(
      runtime.indexOf("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend')"),
      runtime.indexOf("END IF;", runtime.indexOf(
        "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend')",
      )),
    );
    expect(backendGrant).toContain("claim_voice_worker_job_exact");
    expect(backendGrant).toContain("heartbeat_voice_worker_job_exact");
    expect(backendGrant).toContain("mark_voice_worker_dispatch_started_exact");
    expect(backendGrant).toContain("settle_voice_worker_job_exact");
    expect(backendGrant).toContain("load_voice_worker_status");
    expect(backendGrant).toContain("apply_governed_voice_worker_terminal");
    expect(backendGrant).not.toMatch(/GRANT[\s\S]*public\.claim_voice_worker_job\(uuid,integer\)/);
    expect(runtime).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.heartbeat_voice_worker_job\(uuid,uuid,integer\)[\s\S]*TO hacc_backend/,
    );
  });

  it("resolves pgcrypto only through the fixed trusted extension paths", () => {
    const functionCount = (runtime.match(/CREATE OR REPLACE FUNCTION public\./g) ?? []).length;
    expect(functionCount).toBeGreaterThan(0);
    expect(runtime.match(/SET search_path = pg_catalog, extensions, public/g)).toHaveLength(
      functionCount,
    );
    expect(runtime).not.toContain("SET search_path = pg_catalog, public");
  });

  it("moves execution to an exact-only voice-worker role and leaves status on the backend", () => {
    expect(integrity).toContain("CREATE ROLE hacc_voice_worker");
    expect(integrity).toContain("CREATE ROLE hacc_voice_worker_runtime");
    expect(integrity).toMatch(
      /GRANT hacc_voice_worker TO hacc_voice_worker_runtime/,
    );
    const backend = integrity.slice(
      integrity.indexOf("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend')"),
      integrity.indexOf(
        "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_worker')",
      ),
    );
    for (const name of [
      "claim_voice_worker_job_exact",
      "heartbeat_voice_worker_job_exact",
      "mark_voice_worker_dispatch_started_exact",
      "settle_voice_worker_job_exact",
    ]) {
      expect(backend).toMatch(new RegExp(`REVOKE ALL ON FUNCTION[\\s\\S]*${name}`));
    }
    const exactWorker = integrity.slice(
      integrity.indexOf("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_voice_worker')"),
      integrity.indexOf("END IF;", integrity.indexOf(
        "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_voice_worker')",
      )),
    );
    expect(exactWorker).toContain("claim_voice_worker_job_exact");
    expect(exactWorker).toContain("next_governed_voice_worker_candidate");
    expect(exactWorker).not.toContain("load_voice_worker_status");
  });

  it("rejects noncanonical or schema-incompatible result bytes before enqueue", () => {
    const settlement = integrityFunctionBody(
      "settle_voice_worker_job_exact",
      "claim_voice_worker_job_exact",
    );
    expect(settlement).toContain("voice_worker_canonical_json(result_value)");
    expect(settlement).toContain("result_text <> canonical_result");
    expect(settlement).toContain("voice_worker_result_is_valid(result_value)");
    expect(settlement).toContain("voice_worker_result_schema_invalid");
    expect(integrity).toContain("citation - ARRAY['id','uri','title','excerpt','retrievedAt']");
    expect(integrity).toContain("seen_citation_ids");
  });

  it("discovers only content-free candidates and reclaims expired read-only dispatches", () => {
    const claim = integrityFunctionBody(
      "claim_voice_worker_job_exact",
      "next_governed_voice_worker_candidate",
    );
    expect(claim).toContain("candidate.capability_manifest->>'mode' = 'read_only'");
    expect(claim).toContain("candidate.worker_kind <> 'call.research'");
    expect(claim).toContain("candidate.source_call_id IS NULL");
    expect(claim).toContain("candidate.parent_worker_id IS NOT NULL");
    expect(claim).toContain("candidate.spawn_authority->>'source' <> 'voice_call'");
    expect(claim).toContain("candidate.spawn_authority->>'sourceCallId'");
    expect(claim).toContain("read_only_lease_reclaimed_after_process_loss");
    expect(claim).toContain("dispatch_started_at = NULL");
    expect(claim).toContain("candidate.execution_attempt_count >= 3");
    expect(claim).toContain("execution_attempt_count = execution_attempt_count + 1");
    expect(claim).toContain("worker_execution_attempt_limit");
    const candidate = integrityFunctionBody(
      "next_governed_voice_worker_candidate",
      "quarantine_voice_conversation_inbox",
    );
    expect(candidate).toMatch(
      /RETURNS TABLE\(\s*worker_id uuid,\s*organization_id uuid,\s*conversation_id uuid/,
    );
    for (const privateField of [
      "worker_input",
      "result",
      "owner_token",
      "capability_manifest_sha256",
    ]) {
      expect(candidate).not.toContain(privateField);
    }
    expect(candidate).toContain("job.worker_kind = 'call.research'");
    expect(candidate).toContain("job.source_call_id IS NOT NULL");
    expect(candidate).toContain("job.parent_worker_id IS NULL");
    expect(candidate).toContain("job.spawn_authority->>'source' = 'voice_call'");
    expect(candidate).toContain("LIMIT 1");
  });

  it("bounds poison delivery attempts and quarantines without advancing context", () => {
    expect(integrity).toContain("delivery_count >= 16");
    expect(integrity).toContain("delivery_count < 16");
    expect(integrity).toContain("quarantine_reason = 'delivery_attempt_limit'");
    const quarantine = integrityFunctionBody(
      "quarantine_voice_conversation_inbox",
      "claim_voice_conversation_inbox",
    );
    expect(quarantine).toContain("conversation.org_id = organization_identity");
    expect(quarantine).toContain("inbox.delivery_token = delivery_identity");
    expect(quarantine).not.toContain("context_version");
  });

  it("pins call agent version and repairs cancellation pgcrypto resolution", () => {
    const ensure = integrityFunctionBody(
      "ensure_voice_conversation",
      "voice_worker_canonical_json",
    );
    expect(ensure).toContain("SELECT agent_id, agent_version");
    expect(ensure).toContain("call_agent_version <> immutable_agent_version");
    expect(integrity).toContain(
      "ALTER FUNCTION public.request_voice_worker_cancellation(uuid,uuid)",
    );
    expect(integrity).toContain(
      "SET search_path = pg_catalog, extensions, public",
    );
  });
});
