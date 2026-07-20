import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.CREDENTIAL_VAULT_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));
const VAULT_MASTER_KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

integration("credential vault database boundary", () => {
  const ids = { orgA: randomUUID(), orgB: randomUUID(), orgC: randomUUID() };
  let modules: Awaited<ReturnType<typeof loadModules>>;

  async function loadModules() {
    if (databaseUrl) {
      process.env.DATABASE_URL = databaseUrl;
      process.env.DATABASE_SSL = "disable";
    }
    process.env.ENV_VAULT_MASTER_KEY = VAULT_MASTER_KEY;
    const [db, vault] = await Promise.all([import("../db"), import("../credential-vault")]);
    return { db, vault };
  }

  beforeAll(async () => {
    modules = await loadModules();
    await modules.db.q(
      "INSERT INTO orgs (id, name) VALUES ($1,'Credential A'),($2,'Credential B'),($3,'Credential C')",
      [ids.orgA, ids.orgB, ids.orgC]
    );
  });

  afterAll(async () => {
    if (!modules) return;
    await modules.db.q("DELETE FROM orgs WHERE id = ANY($1::uuid[])", [[ids.orgA, ids.orgB, ids.orgC]]).catch(() => {});
    await modules.db.getPool().end();
  });


  it("finalizes an env slot atomically and replays without replacing the stored secret", async () => {
    const submissionId = randomUUID();
    const slot = await modules.vault.createCredentialIngestSlot({
      orgId: ids.orgA,
      request: { kind: "env_var", name: "OPENAI_API_KEY" },
    });
    expect(slot).toMatchObject({ kind: "env_var" });

    await expect(modules.vault.finalizeCredentialIngestSlot({
      orgId: ids.orgA,
      slotId: slot.slotId,
      submissionId,
      credential: "sk-first-form-secret",
    })).resolves.toMatchObject({ status: "completed", replayed: false });
    await expect(modules.vault.finalizeCredentialIngestSlot({
      orgId: ids.orgA,
      slotId: slot.slotId,
      submissionId,
      credential: "sk-replay-must-not-overwrite",
    })).resolves.toMatchObject({ status: "completed", replayed: true });
    await expect(modules.vault.finalizeCredentialIngestSlot({
      orgId: ids.orgA,
      slotId: slot.slotId,
      submissionId: randomUUID(),
      credential: "sk-different-submission-must-not-overwrite",
    })).resolves.toEqual({ status: "already_used" });
    await expect(modules.vault.finalizeCredentialIngestSlot({
      orgId: ids.orgB,
      slotId: slot.slotId,
      submissionId,
      credential: "sk-cross-org",
    })).resolves.toEqual({ status: "unavailable" });

    const stored = await modules.db.q<{ value_encrypted: string; value_encryption_slot_id: string }>(
      `SELECT value_encrypted, value_encryption_slot_id
       FROM env_vars WHERE org_id = $1 AND name = 'OPENAI_API_KEY'`,
      [ids.orgA]
    );
    expect(stored).toHaveLength(1);
    // The handoff slot is ephemeral, but its UUID is a durable AEAD generation
    // stored on the sink. Pruning the slot must not make the credential unreadable.
    await modules.db.q(
      "DELETE FROM hacc_private.credential_ingest_slots WHERE slot_id = $1",
      [slot.slotId]
    );
    expect((await import("../vault")).decryptCredentialSecret(stored[0].value_encrypted, {
      orgId: ids.orgA,
      sinkKind: "env_var",
      sinkId: "OPENAI_API_KEY",
      slotId: stored[0].value_encryption_slot_id,
    })).toBe(
      "sk-first-form-secret"
    );
  });

  it("allows one concurrent first finalization and never duplicates the sink effect", async () => {
    const submissionId = randomUUID();
    const slot = await modules.vault.createCredentialIngestSlot({
      orgId: ids.orgA,
      request: { kind: "env_var", name: "CONCURRENT_API_KEY" },
    });
    const results = await Promise.all(Array.from({ length: 25 }, () =>
      modules.vault.finalizeCredentialIngestSlot({
        orgId: ids.orgA,
        slotId: slot.slotId,
        submissionId,
        credential: "one-concurrent-secret",
      })
    ));
    expect(results.filter((result) => result.status === "completed" && !result.replayed)).toHaveLength(1);
    expect(results.every((result) => result.status === "completed" || result.status === "unavailable")).toBe(true);
    await expect(modules.db.q(
      "SELECT 1 FROM env_vars WHERE org_id = $1 AND name = 'CONCURRENT_API_KEY'",
      [ids.orgA]
    )).resolves.toHaveLength(1);
  });

  it("counts completed slots against the bounded live issuance window", async () => {
    for (let index = 0; index < 25; index += 1) {
      const slot = await modules.vault.createCredentialIngestSlot({
        orgId: ids.orgB,
        request: { kind: "env_var", name: `QUOTA_KEY_${index}` },
      });
      await expect(modules.vault.finalizeCredentialIngestSlot({
        orgId: ids.orgB,
        slotId: slot.slotId,
        submissionId: randomUUID(),
        credential: `quota-secret-${index}`,
      })).resolves.toMatchObject({ status: "completed", replayed: false });
    }

    await expect(modules.vault.createCredentialIngestSlot({
      orgId: ids.orgB,
      request: { kind: "env_var", name: "QUOTA_KEY_BLOCKED" },
    })).rejects.toMatchObject({ code: "unavailable" });
    await expect(modules.db.q(
      `SELECT 1 FROM hacc_private.credential_ingest_slots
       WHERE org_id = $1 AND expires_at > now()`,
      [ids.orgB]
    )).resolves.toHaveLength(25);
  });

  it("never admits a 26th live slot under concurrent quota pressure", async () => {
    for (let index = 0; index < 24; index += 1) {
      await modules.vault.createCredentialIngestSlot({
        orgId: ids.orgC,
        request: { kind: "env_var", name: `CONCURRENT_QUOTA_${index}` },
      });
    }
    const pressure = await Promise.allSettled(Array.from({ length: 40 }, (_, index) =>
      modules.vault.createCredentialIngestSlot({
        orgId: ids.orgC,
        request: { kind: "env_var", name: `CONCURRENT_PRESSURE_${index}` },
      })
    ));
    expect(pressure.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(modules.db.q(
      `SELECT 1 FROM hacc_private.credential_ingest_slots
       WHERE org_id = $1 AND expires_at > now()`,
      [ids.orgC]
    )).resolves.toHaveLength(25);
  });

  it("does not finalize an expired slot", async () => {
    const slot = await modules.vault.createCredentialIngestSlot({
      orgId: ids.orgA,
      request: { kind: "env_var", name: "EXPIRED_SLOT_KEY" },
    });
    await modules.db.q(
      `UPDATE hacc_private.credential_ingest_slots
       SET created_at = now() - interval '10 minutes',
           expires_at = now() - interval '5 minutes'
       WHERE slot_id = $1`,
      [slot.slotId]
    );
    await expect(modules.vault.finalizeCredentialIngestSlot({
      orgId: ids.orgA,
      slotId: slot.slotId,
      submissionId: randomUUID(),
      credential: "expired-must-not-persist",
    })).resolves.toEqual({ status: "unavailable" });
    await expect(modules.db.q(
      "SELECT 1 FROM env_vars WHERE org_id = $1 AND name = 'EXPIRED_SLOT_KEY'",
      [ids.orgA]
    )).resolves.toHaveLength(0);
  });

  it("binds an authenticated MCP secret to its org, server, and slot generation", async () => {
    const submissionId = randomUUID();
    const slot = await modules.vault.createCredentialIngestSlot({
      orgId: ids.orgA,
      request: {
        kind: "mcp_server",
        label: "Context-bound MCP",
        serverUrl: "https://mcp-context.example.test/api",
        allowedTools: ["inventory.read"],
      },
    });
    const { encryptCredentialSecret, decryptCredentialSecret } = await import("../vault");
    const finalized = await modules.vault.finalizeCredentialIngestSlot({
      orgId: ids.orgA,
      slotId: slot.slotId,
      submissionId,
      credential: "Bearer context-bound-secret",
    }, {
      query: modules.db.q,
      encrypt: encryptCredentialSecret,
      randomUUID,
      snapshotMcp: async (server) => ({
        serverUrl: server.server_url,
        allowedTools: server.allowed_tools,
        catalogHash: "a".repeat(64),
        tools: [],
      } as never),
    });
    expect(finalized).toMatchObject({ status: "completed", replayed: false });
    if (finalized.status !== "completed" || finalized.receipt.kind !== "mcp_server") {
      throw new Error("expected MCP completion receipt");
    }
    const rows = await modules.db.q<{
      id: string;
      org_id: string;
      auth_header_encrypted: string;
      auth_encryption_slot_id: string;
    }>(
      `SELECT id, org_id, auth_header_encrypted, auth_encryption_slot_id
       FROM mcp_servers WHERE id = $1`,
      [finalized.receipt.id]
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const context = {
      orgId: row.org_id,
      sinkKind: "mcp_server" as const,
      sinkId: row.id,
      slotId: row.auth_encryption_slot_id,
    };
    await modules.db.q(
      "DELETE FROM hacc_private.credential_ingest_slots WHERE slot_id = $1",
      [slot.slotId]
    );
    expect(decryptCredentialSecret(row.auth_header_encrypted, context))
      .toBe("Bearer context-bound-secret");
    expect(() => decryptCredentialSecret(row.auth_header_encrypted, {
      ...context,
      orgId: ids.orgB,
    })).toThrow("credential ciphertext authentication failed");
    expect(() => decryptCredentialSecret(row.auth_header_encrypted, {
      ...context,
      sinkId: randomUUID(),
    })).toThrow("credential ciphertext authentication failed");
    expect(() => decryptCredentialSecret(row.auth_header_encrypted, {
      ...context,
      slotId: randomUUID(),
    })).toThrow("credential ciphertext authentication failed");
  });

  it("fences a slow MCP finalizer after its lease expires and a retry wins", async () => {
    const submissionId = randomUUID();
    const slot = await modules.vault.createCredentialIngestSlot({
      orgId: ids.orgA,
      request: {
        kind: "mcp_server",
        label: "Lease-fenced MCP",
        serverUrl: "https://mcp-lease.example.test/api",
      },
    });
    const { decryptCredentialSecret, encryptCredentialSecret } = await import("../vault");

    let discoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { discoveryStarted = resolve; });
    let releaseDiscovery!: (manifest: {
      serverUrl: string;
      allowedTools: null;
      catalogHash: string;
      tools: never[];
    }) => void;
    const stalledDiscovery = new Promise<{
      serverUrl: string;
      allowedTools: null;
      catalogHash: string;
      tools: never[];
    }>((resolve) => { releaseDiscovery = resolve; });

    const staleFinalizer = modules.vault.finalizeCredentialIngestSlot({
      orgId: ids.orgA,
      slotId: slot.slotId,
      submissionId,
      credential: "Bearer stale-finalizer-secret",
    }, {
      query: modules.db.q,
      encrypt: encryptCredentialSecret,
      randomUUID,
      snapshotMcp: async () => {
        discoveryStarted();
        return stalledDiscovery as never;
      },
    });
    const staleExpectation = expect(staleFinalizer).rejects.toMatchObject({ code: "sink_failed" });
    await started;

    // Simulate a discovery call that outlived its 45-second claim without making
    // the suite sleep. The lifecycle CHECK remains valid while the lease is past.
    await modules.db.q(
      `UPDATE hacc_private.credential_ingest_slots
       SET claimed_at = now() - interval '2 minutes',
           claim_expires_at = now() - interval '1 minute'
       WHERE slot_id = $1 AND state = 'finalizing'`,
      [slot.slotId]
    );

    const winner = await modules.vault.finalizeCredentialIngestSlot({
      orgId: ids.orgA,
      slotId: slot.slotId,
      submissionId,
      credential: "Bearer retry-winner-secret",
    }, {
      query: modules.db.q,
      encrypt: encryptCredentialSecret,
      randomUUID,
      snapshotMcp: async (server) => ({
        serverUrl: server.server_url,
        allowedTools: server.allowed_tools,
        catalogHash: "b".repeat(64),
        tools: [],
      } as never),
    });
    expect(winner).toMatchObject({ status: "completed", replayed: false });
    if (winner.status !== "completed" || winner.receipt.kind !== "mcp_server") {
      throw new Error("expected retry winner MCP receipt");
    }

    releaseDiscovery({
      serverUrl: "https://mcp-lease.example.test/api",
      allowedTools: null,
      catalogHash: "a".repeat(64),
      tools: [],
    });
    await staleExpectation;

    const rows = await modules.db.q<{
      id: string;
      org_id: string;
      auth_header_encrypted: string;
      auth_encryption_slot_id: string;
      approved_catalog_hash: string;
    }>(
      `SELECT id, org_id, auth_header_encrypted, auth_encryption_slot_id, approved_catalog_hash
       FROM mcp_servers WHERE id = $1`,
      [winner.receipt.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].approved_catalog_hash).toBe("b".repeat(64));
    expect(decryptCredentialSecret(rows[0].auth_header_encrypted, {
      orgId: rows[0].org_id,
      sinkKind: "mcp_server",
      sinkId: rows[0].id,
      slotId: rows[0].auth_encryption_slot_id,
    })).toBe("Bearer retry-winner-secret");
    await expect(modules.db.q<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM hacc_private.credential_ingest_slots WHERE slot_id = $1",
      [slot.slotId]
    )).resolves.toEqual([{ state: "completed", attempts: 2 }]);
  });

  it("bounds repeated failed MCP finalization attempts and never writes a registry row", async () => {
    const slot = await modules.vault.createCredentialIngestSlot({
      orgId: ids.orgA,
      request: {
        kind: "mcp_server",
        label: "Unavailable MCP",
        serverUrl: "https://mcp-unavailable.example.test/api",
      },
    });
    const { encryptCredentialSecret } = await import("../vault");
    const submissionId = randomUUID();
    const snapshotMcp = async () => { throw new Error("bounded test failure"); };
    const dependencies = {
      query: modules.db.q,
      encrypt: encryptCredentialSecret,
      randomUUID,
      snapshotMcp,
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(modules.vault.finalizeCredentialIngestSlot({
        orgId: ids.orgA,
        slotId: slot.slotId,
        submissionId,
        credential: "Bearer failed-sink-secret",
      }, dependencies)).rejects.toMatchObject({ code: "sink_failed" });
    }
    await expect(modules.vault.finalizeCredentialIngestSlot({
      orgId: ids.orgA,
      slotId: slot.slotId,
      submissionId,
      credential: "Bearer failed-sink-secret",
    }, dependencies)).resolves.toEqual({ status: "unavailable" });
    await expect(modules.db.q<{ state: string; attempts: number; last_error_code: string }>(
      "SELECT state, attempts, last_error_code FROM hacc_private.credential_ingest_slots WHERE slot_id = $1",
      [slot.slotId]
    )).resolves.toEqual([{ state: "pending", attempts: 5, last_error_code: "sink_failed" }]);
    await expect(modules.db.q(
      "SELECT 1 FROM mcp_servers WHERE org_id = $1 AND label = 'Unavailable MCP'",
      [ids.orgA]
    )).resolves.toHaveLength(0);
  });
});
