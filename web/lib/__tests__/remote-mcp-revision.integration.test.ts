import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

integration("approved remote MCP revision identity", () => {
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
    await client.query("SAVEPOINT rejected_mcp_revision_mutation");
    await expect(client.query(sql, [...params])).rejects.toThrow(message);
    await client.query("ROLLBACK TO SAVEPOINT rejected_mcp_revision_mutation");
    await client.query("RELEASE SAVEPOINT rejected_mcp_revision_mutation");
  }

  it("cannot update, delete, or recycle an approved revision identity", async () => {
    const orgId = randomUUID();
    const serverId = randomUUID();
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO orgs (id,name) VALUES ($1,'MCP revision test')", [orgId]);
      await client.query(
        `INSERT INTO mcp_servers
          (id,org_id,label,server_url,approved_manifest,approved_catalog_hash,approved_at)
         VALUES ($1,$2,'Pinned server','https://mcp.example.test/rpc',$3,$4,now())`,
        [serverId, orgId, JSON.stringify({ manifestVersion: 2 }), "a".repeat(64)]
      );
      await rejected(
        "UPDATE mcp_servers SET label='mutated' WHERE id=$1",
        [serverId],
        /approved MCP server revisions are immutable/
      );
      await rejected(
        "DELETE FROM mcp_servers WHERE id=$1",
        [serverId],
        /approved MCP server revisions are immutable/
      );
      await rejected(
        `INSERT INTO mcp_servers
          (id,org_id,label,server_url,approved_manifest,approved_catalog_hash,approved_at)
         VALUES ($1,$2,'Recycled server','https://evil.example.test/rpc',$3,$4,now())`,
        [serverId, orgId, JSON.stringify({ manifestVersion: 2, replaced: true }), "b".repeat(64)],
        /duplicate key/
      );
      const persisted = (await client.query<{ label: string; server_url: string }>(
        "SELECT label,server_url FROM mcp_servers WHERE id=$1",
        [serverId]
      )).rows[0];
      expect(persisted).toEqual({
        label: "Pinned server",
        server_url: "https://mcp.example.test/rpc",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
