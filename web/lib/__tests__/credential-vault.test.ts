import { describe, expect, it, vi } from "vitest";
import {
  CredentialVaultError,
  createCredentialIngestSlot,
  finalizeCredentialIngestSlot,
  type CredentialSlotDependencies,
  type CredentialVaultQuery,
} from "../credential-vault";
import { mcpAuthorizationCredentialPurpose } from "../remote-mcp-runtime";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-07-10T12:00:00.000Z");
const SLOT_ID = "00000000-0000-4000-8000-000000000021";
const CLAIM_ID = "00000000-0000-4000-8000-000000000022";
const SERVER_ID = "00000000-0000-4000-8000-000000000023";
const SUBMISSION_ID = "00000000-0000-4000-8000-000000000024";
const OTHER_SUBMISSION_ID = "00000000-0000-4000-8000-000000000025";

function slotDependencies(
  overrides: Partial<CredentialSlotDependencies> = {}
): CredentialSlotDependencies {
  const query = vi.fn<CredentialVaultQuery>();
  query.mockResolvedValue([]);
  const encrypt = vi.fn<CredentialSlotDependencies["encrypt"]>();
  encrypt.mockReturnValue("encrypted-only");
  const randomUUID = vi.fn<() => string>();
  randomUUID.mockReturnValue(SLOT_ID);
  const snapshotMcp = vi.fn<CredentialSlotDependencies["snapshotMcp"]>();
  const effectiveQuery = overrides.query ?? query;
  const transaction: NonNullable<CredentialSlotDependencies["transaction"]> = async (work) => (
    work(effectiveQuery)
  );
  return { query: effectiveQuery, transaction, encrypt, randomUUID, snapshotMcp, ...overrides };
}


describe("non-authorizing credential ingest slots", () => {
  it("creates an org-bound env slot containing destination metadata but no credential bearer", async () => {
    const query = vi.fn<CredentialVaultQuery>();
    query
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([{ expires_at: new Date(NOW.getTime() + 10 * 60_000) }]);
    const result = await createCredentialIngestSlot({
      orgId: ORG_A,
      request: { kind: "env_var", name: "OPENAI_API_KEY" },
    }, slotDependencies({ query }));

    expect(result).toEqual({
      slotId: SLOT_ID,
      expiresAt: "2026-07-10T12:10:00.000Z",
      kind: "env_var",
    });
    expect(query.mock.calls[0][0]).toContain("pg_try_advisory_xact_lock");
    expect(query.mock.calls[1][0]).toContain("credential_ingest_slots");
    expect(query.mock.calls[1][0]).not.toContain("pg_try_advisory_xact_lock");
    expect(query.mock.calls[1][0]).toContain("expires_at > now()) < $7");
    expect(query.mock.calls[1][0]).not.toContain("state IN");
    const params = query.mock.calls[1][1] as unknown[];
    expect(params).toContain("env_var:OPENAI_API_KEY");
    expect(params).toContain(JSON.stringify({ kind: "env_var", name: "OPENAI_API_KEY" }));
    expect(JSON.stringify(params)).not.toContain("credential_ref");
    expect(JSON.stringify(params)).not.toContain("sk-");
  });

  it("creates a canonical MCP slot with a stable server id distinct from the public slot id", async () => {
    const query = vi.fn<CredentialVaultQuery>();
    query
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([{ expires_at: new Date(NOW.getTime() + 10 * 60_000) }]);
    const randomUUID = vi.fn<() => string>();
    randomUUID.mockReturnValueOnce(SERVER_ID).mockReturnValueOnce(SLOT_ID);
    await createCredentialIngestSlot({
      orgId: ORG_A,
      request: {
        kind: "mcp_server",
        label: "Inventory",
        serverUrl: "https://mcp.example.test/api",
        allowedTools: ["stock.read"],
      },
    }, slotDependencies({ query, randomUUID }));
    const config = JSON.parse(String(query.mock.calls[1][1]?.[4]));
    expect(config).toEqual({
      kind: "mcp_server",
      serverId: SERVER_ID,
      label: "Inventory",
      serverUrl: "https://mcp.example.test/api",
      allowedTools: ["stock.read"],
    });
    expect(config.serverId).not.toBe(SLOT_ID);
  });

  it("atomically writes an env sink and completes the slot before returning", async () => {
    const plaintext = "sk-form-only-secret";
    const query = vi.fn<CredentialVaultQuery>();
    query
      .mockResolvedValueOnce([{
        purpose: "env_var:OPENAI_API_KEY",
        sink_kind: "env_var",
        sink_config: { kind: "env_var", name: "OPENAI_API_KEY" },
      }])
      .mockResolvedValueOnce([{ ok: 1 }]);
    const encrypt = vi.fn(() => "ciphertext-only");
    const randomUUID = vi.fn(() => CLAIM_ID);

    await expect(finalizeCredentialIngestSlot({
      orgId: ORG_A,
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: plaintext,
    }, slotDependencies({ query, encrypt, randomUUID }))).resolves.toEqual({
      status: "completed",
      replayed: false,
      receipt: { kind: "env_var", name: "OPENAI_API_KEY" },
    });

    expect(encrypt).toHaveBeenCalledWith(plaintext, {
      orgId: ORG_A,
      sinkKind: "env_var",
      sinkId: "OPENAI_API_KEY",
      slotId: SLOT_ID,
    });
    expect(query.mock.calls[1][0]).toContain("INSERT INTO env_vars");
    expect(query.mock.calls[1][0]).toContain("UPDATE hacc_private.credential_ingest_slots");
    expect(query.mock.calls[1][0]).toContain("SELECT slot_id");
    expect(query.mock.calls[1][0]).toContain("value_encryption_slot_id");
    expect(query.mock.calls[1][0]).toContain("completion_submission_id");
    expect(query.mock.calls[1][1]).toContain("ciphertext-only");
    expect(query.mock.calls[1][1]).toContain(SUBMISSION_ID);
    expect(query.mock.calls[1][1]).not.toContain(plaintext);
  });

  it("replays a completed non-secret receipt without encrypting or touching the sink", async () => {
    const query = vi.fn<CredentialVaultQuery>();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        state: "completed",
        completion_receipt: { kind: "env_var", name: "OPENAI_API_KEY" },
        completion_submission_id: SUBMISSION_ID,
      }]);
    const deps = slotDependencies({ query, randomUUID: vi.fn(() => CLAIM_ID) });
    await expect(finalizeCredentialIngestSlot({
      orgId: ORG_A,
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: "replacement-must-not-be-used",
    }, deps)).resolves.toEqual({
      status: "completed",
      replayed: true,
      receipt: { kind: "env_var", name: "OPENAI_API_KEY" },
    });
    expect(deps.encrypt).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects a different submission identity after completion without touching the sink", async () => {
    const query = vi.fn<CredentialVaultQuery>();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        state: "completed",
        completion_receipt: { kind: "env_var", name: "OPENAI_API_KEY" },
        completion_submission_id: SUBMISSION_ID,
      }]);
    const deps = slotDependencies({ query, randomUUID: vi.fn(() => CLAIM_ID) });
    await expect(finalizeCredentialIngestSlot({
      orgId: ORG_A,
      slotId: SLOT_ID,
      submissionId: OTHER_SUBMISSION_ID,
      credential: "replacement-must-not-be-used",
    }, deps)).resolves.toEqual({ status: "already_used" });
    expect(deps.encrypt).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not distinguish cross-org, expired, busy, or missing slots", async () => {
    const query = vi.fn<CredentialVaultQuery>();
    query.mockResolvedValue([]);
    await expect(finalizeCredentialIngestSlot({
      orgId: ORG_B,
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: "secret",
    }, slotDependencies({ query, randomUUID: vi.fn(() => CLAIM_ID) }))).resolves.toEqual({
      status: "unavailable",
    });
    expect(query.mock.calls[0][1]).toContain(ORG_B);
    expect(query.mock.calls[1][1]).toContain(ORG_B);
  });

  it("aborts a failed MCP sink without persisting plaintext or a registry row", async () => {
    const query = vi.fn<CredentialVaultQuery>();
    query
      .mockResolvedValueOnce([{
        purpose: mcpAuthorizationCredentialPurpose("https://mcp.example.test/api"),
        sink_kind: "mcp_server",
        sink_config: {
          kind: "mcp_server",
          serverId: SERVER_ID,
          label: "Inventory",
          serverUrl: "https://mcp.example.test/api",
          allowedTools: ["stock.read"],
        },
      }])
      .mockResolvedValueOnce([]);
    const snapshotMcp = vi.fn<CredentialSlotDependencies["snapshotMcp"]>();
    snapshotMcp.mockRejectedValueOnce(new Error("remote echoed Bearer private"));

    await expect(finalizeCredentialIngestSlot({
      orgId: ORG_A,
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: "Bearer private",
    }, slotDependencies({
      query,
      randomUUID: vi.fn(() => CLAIM_ID),
      snapshotMcp,
    }))).rejects.toEqual(new CredentialVaultError("sink_failed"));
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO mcp_servers"))).toBe(false);
    expect(query.mock.calls[1][0]).toContain("state = 'pending'");
    expect(JSON.stringify(query.mock.calls)).not.toContain("Bearer private");
  });
});
