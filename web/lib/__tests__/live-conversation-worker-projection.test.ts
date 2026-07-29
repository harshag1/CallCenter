import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("038 live conversation worker projection migration", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "migrations/038_live_conversation_worker_projection.sql"),
    "utf8",
  );

  it("exposes only an exact organization and conversation scoped immutable lookup", () => {
    expect(sql).toMatch(/SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/);
    expect(sql).toMatch(/job\.id = worker_identity/);
    expect(sql).toMatch(/job\.org_id = organization_identity/);
    expect(sql).toMatch(/job\.conversation_id = conversation_identity/);
    expect(sql).toMatch(/job\.status = 'succeeded'/);
    expect(sql).toMatch(/job\.result_sha256 IS NOT NULL/);
    expect(sql).toMatch(/job\.settled_at IS NOT NULL/);
    expect(sql).toMatch(
      /RETURNS TABLE\([\s\S]*spawn_authority[\s\S]*result_sha256[\s\S]*settled_at[\s\S]*\)/,
    );
    const projection = sql.slice(
      sql.indexOf("RETURNS TABLE("),
      sql.indexOf("LANGUAGE sql"),
    );
    for (const forbidden of [
      "owner_token",
      "lease_expires_at",
      "dispatch_started_at",
      "heartbeat_at",
      "checkpoint",
      "worker_input",
      "capability_manifest",
      "result jsonb",
      "error",
      "cancellation_epoch",
    ]) {
      expect(projection).not.toContain(forbidden);
    }
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.load_voice_worker_for_delivery\(uuid,uuid,uuid\) FROM PUBLIC/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*load_voice_worker_for_delivery\(uuid,uuid,uuid\)[\s\S]*TO hacc_backend/,
    );
    expect(sql).not.toMatch(/TO (?:anon|authenticated|service_role|hacc_worker)/);
    expect(sql).not.toMatch(/SELECT job\.\*/);
  });
});
