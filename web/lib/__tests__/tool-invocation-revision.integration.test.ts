import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));
const migrationSql = readFileSync(
  fileURLToPath(new URL("../../migrations/011_tool_execution_boundary.sql", import.meta.url)),
  "utf8"
);

integration("append-only generated-tool invocation revisions", () => {
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

  async function expectRejectedMutation(
    sql: string,
    params: readonly unknown[],
    message: RegExp
  ): Promise<void> {
    await client.query("SAVEPOINT rejected_revision_mutation");
    await expect(client.query(sql, [...params])).rejects.toThrow(message);
    await client.query("ROLLBACK TO SAVEPOINT rejected_revision_mutation");
    await client.query("RELEASE SAVEPOINT rejected_revision_mutation");
  }

  it("allows only one-way finalization and freezes every authority field", async () => {
    const orgId = randomUUID();
    const toolId = randomUUID();
    await client.query("BEGIN");
    try {
      await client.query(migrationSql);
      await client.query("INSERT INTO orgs (id, name) VALUES ($1, 'Revision lifecycle test')", [orgId]);
      await client.query(
        `INSERT INTO tools
          (id, org_id, slug, description, input_schema, kind, source_code, created_by)
         VALUES ($1,$2,'revision-test','Revision test','{}','edge','async function run() {}','integration-test')`,
        [toolId, orgId]
      );
      await expectRejectedMutation(
        "UPDATE tools SET invocation_key_id=$2 WHERE id=$1",
        [toolId, "tik_partialpointer00"],
        /tools_invocation_boundary_consistent/
      );
      await expectRejectedMutation(
        "UPDATE tools SET deployment_project=$2 WHERE id=$1",
        [toolId, "hacc-tool-partial-pointer"],
        /tools_invocation_boundary_consistent/
      );
      await client.query(
        `INSERT INTO tool_invocation_revisions
          (key_id, tool_id, public_key, private_key_encrypted, deployment_project,
           description, input_schema, source_code, created_by, status)
         VALUES ($1,$2,$3,$4,$5,'Revision test','{}','async function run() {}','integration-test','deploying')`,
        ["tik_aaaaaaaaaaaaaaaa", toolId, "P".repeat(64), "K".repeat(64), "hacc-tool-revision-a"]
      );

      await expectRejectedMutation(
        "UPDATE tool_invocation_revisions SET source_code = 'changed' WHERE key_id = $1",
        ["tik_aaaaaaaaaaaaaaaa"],
        /authority is immutable/
      );
      await expectRejectedMutation(
        "UPDATE tool_invocation_revisions SET status = 'deploying' WHERE key_id = $1",
        ["tik_aaaaaaaaaaaaaaaa"],
        /invalid tool invocation revision transition/
      );

      await client.query(
        `UPDATE tool_invocation_revisions
         SET status = 'live', endpoint_url = $2, deployed_at = now()
         WHERE key_id = $1`,
        ["tik_aaaaaaaaaaaaaaaa", "https://revision-a.example.test/api/tool"]
      );
      await expectRejectedMutation(
        "UPDATE tool_invocation_revisions SET endpoint_url = $2 WHERE key_id = $1",
        ["tik_aaaaaaaaaaaaaaaa", "https://attacker.example.test/api/tool"],
        /invalid tool invocation revision transition|endpoint is immutable/
      );
      await expectRejectedMutation(
        "UPDATE tool_invocation_revisions SET status = 'failed' WHERE key_id = $1",
        ["tik_aaaaaaaaaaaaaaaa"],
        /invalid tool invocation revision transition/
      );
      await client.query(
        "UPDATE tool_invocation_revisions SET status = 'retired' WHERE key_id = $1",
        ["tik_aaaaaaaaaaaaaaaa"]
      );
      await expectRejectedMutation(
        "UPDATE tool_invocation_revisions SET status = 'live' WHERE key_id = $1",
        ["tik_aaaaaaaaaaaaaaaa"],
        /invalid tool invocation revision transition/
      );
      await expectRejectedMutation(
        "DELETE FROM tool_invocation_revisions WHERE key_id = $1",
        ["tik_aaaaaaaaaaaaaaaa"],
        /append-only/
      );

      await client.query(
        `INSERT INTO tool_invocation_revisions
          (key_id, tool_id, public_key, private_key_encrypted, deployment_project,
           description, input_schema, source_code, created_by, status)
         VALUES ($1,$2,$3,$4,$5,'Revision test','{}','async function run() {}','integration-test','deploying')`,
        ["tik_bbbbbbbbbbbbbbbb", toolId, "Q".repeat(64), "L".repeat(64), "hacc-tool-revision-b"]
      );
      await client.query(
        "UPDATE tool_invocation_revisions SET status = 'failed' WHERE key_id = $1",
        ["tik_bbbbbbbbbbbbbbbb"]
      );
      await expectRejectedMutation(
        `UPDATE tool_invocation_revisions
         SET status = 'live', endpoint_url = $2, deployed_at = now()
         WHERE key_id = $1`,
        ["tik_bbbbbbbbbbbbbbbb", "https://revision-b.example.test/api/tool"],
        /invalid tool invocation revision transition/
      );

      await client.query(
        `INSERT INTO tool_invocation_revisions
          (key_id, tool_id, public_key, private_key_encrypted, deployment_project,
           description, input_schema, source_code, created_by, status)
         VALUES ($1,$2,$3,$4,$5,'Revision test','{}','async function run() {}','integration-test','deploying')`,
        ["tik_cccccccccccccccc", toolId, "R".repeat(64), "M".repeat(64), "hacc-tool-revision-c"]
      );
      await client.query(
        "UPDATE tool_invocation_revisions SET status = 'retired' WHERE key_id = $1",
        ["tik_cccccccccccccccc"]
      );
      await client.query(
        `INSERT INTO tool_invocation_revisions
          (key_id, tool_id, public_key, private_key_encrypted, deployment_project,
           description, input_schema, source_code, created_by, status)
         VALUES ($1,$2,$3,$4,$5,'Revision test','{}','async function run() {}','integration-test','deploying')`,
        ["tik_dddddddddddddddd", toolId, "S".repeat(64), "N".repeat(64), "hacc-tool-revision-d"]
      );
      await client.query(
        `UPDATE tool_invocation_revisions
         SET status = 'live', endpoint_url = $2, deployed_at = now()
         WHERE key_id = $1`,
        ["tik_dddddddddddddddd", "https://revision-a.example.test/api/tool"]
      );
      await client.query(
        `UPDATE tools
         SET invocation_key_id = $2, deployment_project = $3
         WHERE id = $1`,
        [toolId, "tik_dddddddddddddddd", "hacc-tool-revision-d"]
      );

      // Reapply the exact migration after a durable live pointer exists. The
      // removed public/private columns are temporarily reconstructed as NULL,
      // which must neither invalidate nor overwrite the final pointer shape.
      await client.query(migrationSql);
      await client.query(migrationSql);
      const statuses = await client.query<{ key_id: string; status: string }>(
        "SELECT key_id, status FROM tool_invocation_revisions WHERE tool_id = $1 ORDER BY key_id",
        [toolId]
      );
      expect(statuses.rows).toEqual([
        { key_id: "tik_aaaaaaaaaaaaaaaa", status: "retired" },
        { key_id: "tik_bbbbbbbbbbbbbbbb", status: "failed" },
        { key_id: "tik_cccccccccccccccc", status: "retired" },
        { key_id: "tik_dddddddddddddddd", status: "live" },
      ]);
      const pointer = await client.query<{
        invocation_key_id: string;
        deployment_project: string;
      }>(
        `SELECT invocation_key_id, deployment_project
         FROM tools WHERE id = $1`,
        [toolId]
      );
      expect(pointer.rows).toEqual([{
        invocation_key_id: "tik_dddddddddddddddd",
        deployment_project: "hacc-tool-revision-d",
      }]);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
