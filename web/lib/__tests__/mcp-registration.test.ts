import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  createCredentialIngestSlot: vi.fn(),
  snapshotExternalMcpServer: vi.fn(),
}));

vi.mock("../db", () => ({ q: mocks.q }));
vi.mock("../credential-vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credential-vault")>();
  return { ...actual, createCredentialIngestSlot: mocks.createCredentialIngestSlot };
});
vi.mock("../remote-mcp-runtime", () => ({
  snapshotExternalMcpServer: mocks.snapshotExternalMcpServer,
}));

import { addMcpServer, setEnvVar } from "../agent/tools/secrets";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SLOT_ID = "00000000-0000-4000-8000-000000000009";
const context = {
  orgId: ORG_ID,
  email: "owner@example.test",
  agentId: null,
  origin: "https://app.example.test",
};

describe("model-facing credential schemas", () => {
  it("contain only non-secret slot-request metadata", () => {
    const envProperties = (setEnvVar.parameters.properties ?? {}) as Record<string, unknown>;
    const mcpProperties = (addMcpServer.parameters.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(envProperties).sort()).toEqual(["name"]);
    expect(Object.keys(mcpProperties).sort()).toEqual([
      "allowed_tools",
      "authentication",
      "label",
      "server_url",
    ]);
    const schemas = JSON.stringify({ env: setEnvVar.parameters, mcp: addMcpServer.parameters });
    for (const forbiddenKey of ["credential_ref", '"value"', '"auth_header"', '"credential"']) {
      expect(schemas).not.toContain(forbiddenKey);
    }
  });
});

describe("external MCP registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.q.mockResolvedValue([]);
    mocks.createCredentialIngestSlot.mockResolvedValue({
      slotId: SLOT_ID,
      expiresAt: "2026-07-10T12:10:00.000Z",
      kind: "mcp_server",
    });
    mocks.snapshotExternalMcpServer.mockImplementation(async (server: { id: string }) => ({
      id: server.id,
      label: "Inventory",
      namespace: `server_${server.id}`,
      serverUrl: "https://mcp.example.test/v1",
      allowedTools: ["reserve_slot"],
      catalogHash: "a".repeat(64),
      tools: [{
        name: `mcp_server_${server.id}_reserve_slot_deadbeef00`,
        remoteName: "reserve_slot",
        description: "Reserve a slot.",
        inputSchema: { type: "object" },
        outputSchema: null,
        schemaHash: "b".repeat(64),
      }],
    }));
  });

  it("probes a public server before persistence and returns stable Flow v2 tool names", async () => {
    const result = await addMcpServer.execute({
      label: "Inventory",
      server_url: "https://mcp.example.test/v1",
      authentication: "none",
      allowed_tools: ["reserve_slot"],
    } as never, context);

    expect(mocks.snapshotExternalMcpServer).toHaveBeenCalledBefore(mocks.q);
    expect(mocks.snapshotExternalMcpServer).toHaveBeenCalledWith(expect.objectContaining({
      org_id: ORG_ID,
      auth_header_encrypted: null,
      auth_encryption_slot_id: null,
      allowed_tools: ["reserve_slot"],
    }));
    expect(mocks.q).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO mcp_servers"),
      expect.arrayContaining([ORG_ID, "Inventory", null])
    );
    expect(result.output).toMatchObject({
      ok: true,
      catalog_hash: "a".repeat(64),
      tools: [{
        remote_name: "reserve_slot",
        schema_hash: "b".repeat(64),
        output_binding_root: "value",
      }],
    });
  });

  it("does not persist a public server whose discovery preflight fails", async () => {
    mocks.snapshotExternalMcpServer.mockRejectedValueOnce(new Error("private provider error"));
    const result = await addMcpServer.execute({
      label: "Inventory",
      server_url: "https://mcp.example.test/v1",
      authentication: "none",
    } as never, context);
    expect(result.output).toEqual({ error: "mcp_registration_preflight_failed" });
    expect(JSON.stringify(result)).not.toContain("private provider error");
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("creates a non-authorizing secure-input slot for an authenticated server", async () => {
    const result = await addMcpServer.execute({
      label: "Inventory",
      server_url: "https://mcp.example.test/v1",
      authentication: "authorization_header",
      allowed_tools: ["reserve_slot"],
    } as never, context);
    expect(mocks.createCredentialIngestSlot).toHaveBeenCalledWith({
      orgId: ORG_ID,
      request: {
        kind: "mcp_server",
        label: "Inventory",
        serverUrl: "https://mcp.example.test/v1",
        allowedTools: ["reserve_slot"],
      },
    });
    expect(mocks.snapshotExternalMcpServer).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({
      status: "awaiting_secure_input",
      slot_id: SLOT_ID,
      kind: "mcp_server",
    });
    expect(result.surface?.blocks[0]).toMatchObject({ kind: "credential_form", slotId: SLOT_ID });
    expect(JSON.stringify(result)).not.toContain("credential_ref");
  });

  it.each([
    ["legacy plaintext", { label: "Inventory", server_url: "https://mcp.example.test/v1", authentication: "authorization_header", auth_header: "Bearer must-never-enter-chat" }],
    ["legacy bearer ref", { label: "Inventory", server_url: "https://mcp.example.test/v1", authentication: "authorization_header", credential_ref: "cred_v1_forbidden" }],
    ["URL credential", { label: "Inventory", server_url: "https://user:pass@mcp.example.test/v1", authentication: "none" }],
  ])("rejects %s arguments before any credential or network action", async (_label, args) => {
    const result = await addMcpServer.execute(args as never, context);
    expect(result.output).toEqual({ error: "invalid_mcp_registration_request" });
    expect(mocks.createCredentialIngestSlot).not.toHaveBeenCalled();
    expect(mocks.snapshotExternalMcpServer).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });
});

describe("environment credential handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCredentialIngestSlot.mockResolvedValue({
      slotId: SLOT_ID,
      expiresAt: "2026-07-10T12:10:00.000Z",
      kind: "env_var",
    });
  });

  it("creates a browser-only slot from the exact env name without accepting a secret", async () => {
    const result = await setEnvVar.execute({ name: "OPENAI_API_KEY" } as never, context);
    expect(mocks.createCredentialIngestSlot).toHaveBeenCalledWith({
      orgId: ORG_ID,
      request: { kind: "env_var", name: "OPENAI_API_KEY" },
    });
    expect(result.output).toMatchObject({
      status: "awaiting_secure_input",
      slot_id: SLOT_ID,
      kind: "env_var",
    });
    expect(result.surface?.blocks[0]).toMatchObject({ kind: "credential_form", slotId: SLOT_ID });
    expect(JSON.stringify(result)).not.toContain("credential_ref");
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it.each([
    ["normalized-looking lowercase name", { name: "openai-api-key" }],
    ["plaintext value", { name: "OPENAI_API_KEY", value: "plaintext" }],
    ["legacy bearer reference", { name: "OPENAI_API_KEY", credential_ref: "cred_v1_forbidden" }],
  ])("rejects %s instead of normalizing or persisting it", async (_label, args) => {
    const result = await setEnvVar.execute(args as never, context);
    expect(result.output).toEqual({ error: "invalid_env_var_name" });
    expect(mocks.createCredentialIngestSlot).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });
});
