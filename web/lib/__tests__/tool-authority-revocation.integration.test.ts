import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));
const migration009 = readFileSync(
  fileURLToPath(new URL("../../migrations/009_remote_mcp_integrity.sql", import.meta.url)),
  "utf8"
);
const migration011 = readFileSync(
  fileURLToPath(new URL("../../migrations/011_tool_execution_boundary.sql", import.meta.url)),
  "utf8"
);
const migration025 = readFileSync(
  fileURLToPath(new URL("../../migrations/025_tool_authority_emergency_revocation.sql", import.meta.url)),
  "utf8"
);

integration("one-way integration authority revocation", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl, ssl: false });
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });

  async function rejected(sql: string, params: readonly unknown[], message: RegExp) {
    await client.query("SAVEPOINT rejected_revocation_mutation");
    await expect(client.query(sql, [...params])).rejects.toThrow(message);
    await client.query("ROLLBACK TO SAVEPOINT rejected_revocation_mutation");
    await client.query("RELEASE SAVEPOINT rejected_revocation_mutation");
  }

  it("cuts off only the exact tenant/revision, records an immutable audit, and survives early-migration reapply", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const serverId = randomUUID();
    const secondServerId = randomUUID();
    const toolId = randomUUID();
    const catalogHash = "a".repeat(64);
    const secondCatalogHash = "b".repeat(64);
    const endpoint = "https://generated-revocation.example.test/api/tool";
    const keyId = "tik_revocationtest00";
    const secondKeyId = "tik_revocationtest01";

    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO orgs (id,name) VALUES ($1,'Revocation tenant'),($2,'Other tenant')",
        [orgId, otherOrgId]
      );
      await client.query(
        `INSERT INTO mcp_servers
          (id,org_id,label,server_url,approved_manifest,approved_catalog_hash,approved_at)
         VALUES
          ($1,$2,'Pinned MCP','https://mcp-revocation.example.test/rpc',$3,$4,now()),
          ($5,$2,'Second MCP','https://mcp-revocation-2.example.test/rpc',$6,$7,now())`,
        [
          serverId,
          orgId,
          JSON.stringify({ manifestVersion: 2, id: serverId }),
          catalogHash,
          secondServerId,
          JSON.stringify({ manifestVersion: 2, id: secondServerId }),
          secondCatalogHash,
        ]
      );
      await client.query(
        `INSERT INTO tools
          (id,org_id,slug,description,input_schema,kind,source_code,created_by)
         VALUES ($1,$2,'revocation-tool','Revocation tool','{}','edge','async function run() {}','integration-test')`,
        [toolId, orgId]
      );
      for (const [candidateKey, project] of [
        [keyId, "hacc-revocation-tool-0"],
        [secondKeyId, "hacc-revocation-tool-1"],
      ] as const) {
        await client.query(
          `INSERT INTO tool_invocation_revisions
            (key_id,tool_id,public_key,private_key_encrypted,deployment_project,
             description,input_schema,source_code,created_by,status)
           VALUES ($1,$2,$3,$4,$5,'Revocation tool','{}','async function run() {}','integration-test','deploying')`,
          [candidateKey, toolId, "P".repeat(64), "K".repeat(64), project]
        );
        await client.query(
          `UPDATE tool_invocation_revisions
           SET status='live', endpoint_url=$2, deployed_at=clock_timestamp()
           WHERE key_id=$1`,
          [candidateKey, endpoint]
        );
      }

      // Normal rotation retires an old revision but deliberately does not revoke it. Pinned calls
      // can still resolve it until an operator uses the separate emergency latch.
      await client.query(
        "UPDATE tool_invocation_revisions SET status='retired' WHERE key_id=$1",
        [keyId]
      );
      // Apply 025 only after active/retired authority already exists. On a 001-024 database this
      // is the real upgrade path; on a fully migrated database it is the exact reapply path.
      await client.query(migration025);
      const auditBoundary = await client.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        backend_policy: boolean;
        owner_policy: boolean;
        backend_privilege: boolean;
      }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity,
                EXISTS (
                  SELECT 1 FROM pg_policies policy
                  WHERE policy.schemaname='hacc_private'
                    AND policy.tablename='tool_authority_revocations'
                    AND policy.policyname='hacc_backend_all'
                    AND policy.cmd='ALL'
                    AND policy.roles=ARRAY['hacc_backend']::name[]
                    AND policy.qual='false' AND policy.with_check='false'
                ) AS backend_policy,
                EXISTS (
                  SELECT 1 FROM pg_policies policy
                  WHERE policy.schemaname='hacc_private'
                    AND policy.tablename='tool_authority_revocations'
                    AND policy.policyname='hacc_migration_owner_all'
                    AND policy.cmd='ALL'
                    AND policy.roles=ARRAY[current_user]::name[]
                    AND policy.qual='true' AND policy.with_check='true'
                ) AS owner_policy,
                has_table_privilege('hacc_backend',
                  'hacc_private.tool_authority_revocations','SELECT')
                  OR has_table_privilege('hacc_backend',
                    'hacc_private.tool_authority_revocations','INSERT')
                  OR has_table_privilege('hacc_backend',
                    'hacc_private.tool_authority_revocations','UPDATE')
                  OR has_table_privilege('hacc_backend',
                    'hacc_private.tool_authority_revocations','DELETE')
                  AS backend_privilege
         FROM pg_class c
         WHERE c.oid='hacc_private.tool_authority_revocations'::regclass`
      );
      expect(auditBoundary.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
        backend_policy: true,
        owner_policy: true,
        backend_privilege: false,
      });
      expect((await client.query(
        `SELECT key_id FROM tool_invocation_revisions
         WHERE key_id=$1 AND status IN ('live','retired') AND revoked_at IS NULL`,
        [keyId]
      )).rowCount).toBe(1);

      // Wrong tenant and wrong revision bindings cannot revoke anything.
      expect((await client.query(
        `UPDATE mcp_servers
         SET revoked_at=clock_timestamp(), revoked_by='security@example.test',
             revocation_reason='suspected credential compromise'
         WHERE id=$1 AND org_id=$2 AND approved_catalog_hash=$3 AND revoked_at IS NULL`,
        [serverId, otherOrgId, catalogHash]
      )).rowCount).toBe(0);
      expect((await client.query(
        `UPDATE tool_invocation_revisions revision
         SET revoked_at=clock_timestamp(), revoked_by='security@example.test',
             revocation_reason='suspected signing key compromise'
         FROM tools tool
         WHERE revision.tool_id=tool.id AND tool.org_id=$1
           AND revision.key_id=$2 AND revision.endpoint_url=$3
           AND revision.status IN ('live','retired') AND revision.revoked_at IS NULL`,
        [orgId, keyId, `${endpoint}/wrong`]
      )).rowCount).toBe(0);

      expect((await client.query(
        `UPDATE mcp_servers
         SET revoked_at=clock_timestamp(), revoked_by='security@example.test',
             revocation_reason='suspected credential compromise'
         WHERE id=$1 AND org_id=$2 AND approved_catalog_hash=$3 AND revoked_at IS NULL`,
        [serverId, orgId, catalogHash]
      )).rowCount).toBe(1);
      expect((await client.query(
        `UPDATE tool_invocation_revisions revision
         SET revoked_at=clock_timestamp(), revoked_by='security@example.test',
             revocation_reason='suspected signing key compromise'
         FROM tools tool
         WHERE revision.tool_id=tool.id AND tool.org_id=$1
           AND revision.key_id=$2 AND revision.endpoint_url=$3
           AND revision.status IN ('live','retired') AND revision.revoked_at IS NULL`,
        [orgId, keyId, endpoint]
      )).rowCount).toBe(1);

      const audit = await client.query<{
        authority_kind: string;
        authority_id: string;
        org_id: string;
        revision_binding: Record<string, unknown>;
      }>(
        `SELECT authority_kind,authority_id,org_id,revision_binding
         FROM hacc_private.tool_authority_revocations
         WHERE authority_id = ANY($1)
         ORDER BY authority_kind`,
        [[serverId, keyId]]
      );
      expect(audit.rows).toEqual([
        {
          authority_kind: "generated_tool",
          authority_id: keyId,
          org_id: orgId,
          revision_binding: { tool_id: toolId, key_id: keyId, endpoint_url: endpoint },
        },
        {
          authority_kind: "remote_mcp",
          authority_id: serverId,
          org_id: orgId,
          revision_binding: { server_id: serverId, approved_catalog_hash: catalogHash },
        },
      ]);
      await rejected(
        "UPDATE mcp_servers SET revoked_at=NULL,revoked_by=NULL,revocation_reason=NULL WHERE id=$1",
        [serverId],
        /approved MCP server revisions are immutable/
      );
      await rejected(
        "UPDATE tool_invocation_revisions SET revocation_reason='changed after cutoff' WHERE key_id=$1",
        [keyId],
        /authority is immutable/
      );
      await rejected(
        "DELETE FROM hacc_private.tool_authority_revocations WHERE authority_id=$1",
        [keyId],
        /audit is append-only/
      );

      // Reapplying the exact earlier migrations must neither erase revocations nor reinstall a
      // trigger that blocks future one-way cutoffs.
      await client.query(migration009);
      await client.query(migration011);
      await client.query(migration025);
      expect((await client.query(
        "SELECT count(*)::int AS count FROM hacc_private.tool_authority_revocations WHERE authority_id = ANY($1)",
        [[serverId, keyId]]
      )).rows[0].count).toBe(2);

      expect((await client.query(
        `UPDATE mcp_servers
         SET revoked_at=clock_timestamp(), revoked_by='security@example.test',
             revocation_reason='second exact emergency cutoff'
         WHERE id=$1 AND org_id=$2 AND approved_catalog_hash=$3 AND revoked_at IS NULL`,
        [secondServerId, orgId, secondCatalogHash]
      )).rowCount).toBe(1);
      expect((await client.query(
        `UPDATE tool_invocation_revisions revision
         SET revoked_at=clock_timestamp(), revoked_by='security@example.test',
             revocation_reason='second exact emergency cutoff'
         FROM tools tool
         WHERE revision.tool_id=tool.id AND tool.org_id=$1
           AND revision.key_id=$2 AND revision.endpoint_url=$3
           AND revision.status IN ('live','retired') AND revision.revoked_at IS NULL`,
        [orgId, secondKeyId, endpoint]
      )).rowCount).toBe(1);
      expect((await client.query(
        "SELECT count(*)::int AS count FROM hacc_private.tool_authority_revocations WHERE authority_id = ANY($1)",
        [[secondServerId, secondKeyId]]
      )).rows[0].count).toBe(2);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
