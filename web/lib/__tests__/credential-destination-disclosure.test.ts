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

import { addMcpServer } from "../agent/tools/secrets";
import { SurfaceSchema } from "../surface-dsl";

describe("MCP credential consent disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCredentialIngestSlot.mockResolvedValue({
      slotId: "00000000-0000-4000-8000-000000000009",
      expiresAt: "2026-07-17T00:00:00.000Z",
      kind: "mcp_server",
    });
  });

  it("shows the canonical destination and exact scope despite a trusted-looking label", async () => {
    const result = await addMcpServer.execute({
      label: "Official Payroll and Benefits",
      server_url: "https://attacker.example/collect/authorization",
      authentication: "authorization_header",
      allowed_tools: ["read_private_data", "delete_everything"],
    } as never, {
      orgId: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      agentId: null,
      origin: "https://app.example.test",
    });

    const surface = SurfaceSchema.parse(result.surface);
    expect(surface.title).toBe("Authorize MCP destination");
    expect(surface.blocks[0]).toMatchObject({
      kind: "credential_form",
      destination: "https://attacker.example/collect/authorization",
      allowedTools: ["delete_everything", "read_private_data"],
    });
    expect(JSON.stringify(surface)).toContain("Official Payroll and Benefits");
    expect(mocks.createCredentialIngestSlot).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        serverUrl: "https://attacker.example/collect/authorization",
        allowedTools: ["delete_everything", "read_private_data"],
      }),
    }));
    expect(mocks.snapshotExternalMcpServer).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("states when the credential grants access to every advertised tool", async () => {
    const result = await addMcpServer.execute({
      label: "Inventory",
      server_url: "https://mcp.example.test/v1",
      authentication: "authorization_header",
    } as never, {
      orgId: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      agentId: null,
      origin: "https://app.example.test",
    });
    expect(SurfaceSchema.parse(result.surface).blocks[0]).toMatchObject({
      destination: "https://mcp.example.test/v1",
      allowedTools: "all",
    });
  });

  it("rejects bidirectional-control labels before creating consent UI", async () => {
    const result = await addMcpServer.execute({
      label: "Official\u202Eelpmaxe.live",
      server_url: "https://attacker.example/",
      authentication: "authorization_header",
    } as never, {
      orgId: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      agentId: null,
      origin: "https://app.example.test",
    });
    expect(result.output).toEqual({ error: "invalid_mcp_registration_request" });
    expect(mocks.createCredentialIngestSlot).not.toHaveBeenCalled();
  });
});
