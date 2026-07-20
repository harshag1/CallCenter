import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ q: vi.fn(), qOne: vi.fn() }));
vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));

import {
  ToolAuthorityRevocationError,
  revokeGeneratedToolAuthority,
  revokeRemoteMcpAuthority,
} from "../tool-authority-revocation";

const orgId = "8916eb0a-5332-4f4c-a330-746c516e83b9";
const serverId = "8916eb0a-5332-4f4c-a330-746c516e83ba";
const toolId = "8916eb0a-5332-4f4c-a330-746c516e83bc";
const keyId = "tik_revocationtest00";
const endpointUrl = "https://generated-revocation.example.test/api/tool";

describe("tool authority emergency revocation control plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.q.mockResolvedValue([]);
    mocks.qOne.mockResolvedValue(null);
  });

  it("binds a remote cutoff to tenant, immutable server id, and approved catalog digest", async () => {
    mocks.q.mockResolvedValueOnce([{
      authority_id: serverId,
      org_id: orgId,
      revoked_at: "2026-07-16T21:00:00.000Z",
      revoked_by: "security@example.test",
      revocation_reason: "credential compromise confirmed",
    }]);
    await expect(revokeRemoteMcpAuthority({
      orgId,
      serverId,
      approvedCatalogHash: "a".repeat(64),
      actor: " security@example.test ",
      reason: " credential compromise confirmed ",
    })).resolves.toEqual({
      authorityKind: "remote_mcp",
      authorityId: serverId,
      orgId,
      revokedAt: "2026-07-16T21:00:00.000Z",
      actor: "security@example.test",
      reason: "credential compromise confirmed",
      replayed: false,
    });
    expect(mocks.q).toHaveBeenCalledWith(
      expect.stringMatching(/id=\$1 AND org_id=\$2 AND approved_catalog_hash=\$3[\s\S]*revoked_at IS NULL/),
      [serverId, orgId, "a".repeat(64), "security@example.test", "credential compromise confirmed"]
    );
  });

  it("returns the immutable original receipt on an exact retry instead of overwriting audit fields", async () => {
    mocks.qOne.mockResolvedValueOnce({
      authority_id: serverId,
      org_id: orgId,
      revoked_at: new Date("2026-07-16T21:00:00.000Z"),
      revoked_by: "first-operator@example.test",
      revocation_reason: "first exact emergency reason",
    });
    await expect(revokeRemoteMcpAuthority({
      orgId,
      serverId,
      approvedCatalogHash: "a".repeat(64),
      actor: "retrying-operator@example.test",
      reason: "retry must not overwrite the audit",
    })).resolves.toMatchObject({
      actor: "first-operator@example.test",
      reason: "first exact emergency reason",
      replayed: true,
    });
  });

  it("binds generated cutoff to tenant, tool, key revision, and endpoint", async () => {
    mocks.q.mockResolvedValueOnce([{
      authority_id: keyId,
      org_id: orgId,
      revoked_at: "2026-07-16T21:00:00.000Z",
      revoked_by: "security@example.test",
      revocation_reason: "signing key compromise confirmed",
    }]);
    await expect(revokeGeneratedToolAuthority({
      orgId,
      toolId,
      keyId,
      endpointUrl,
      actor: "security@example.test",
      reason: "signing key compromise confirmed",
    })).resolves.toMatchObject({
      authorityKind: "generated_tool",
      authorityId: keyId,
      replayed: false,
    });
    expect(mocks.q).toHaveBeenCalledWith(
      expect.stringMatching(/tool\.id=\$1 AND tool\.org_id=\$2[\s\S]*revision\.key_id=\$3 AND revision\.endpoint_url=\$4/),
      [toolId, orgId, keyId, endpointUrl, "security@example.test", "signing key compromise confirmed"]
    );
  });

  it("rejects malformed or mismatched requests fail-closed", async () => {
    await expect(revokeGeneratedToolAuthority({
      orgId,
      toolId,
      keyId,
      endpointUrl: `${endpointUrl}/noncanonical/..`,
      actor: "security@example.test",
      reason: "signing key compromise confirmed",
    })).rejects.toBeInstanceOf(ToolAuthorityRevocationError);
    await expect(revokeRemoteMcpAuthority({
      orgId,
      serverId,
      approvedCatalogHash: "a".repeat(64),
      actor: "security@example.test",
      reason: "binding does not exist",
    })).rejects.toMatchObject({ code: "authority_binding_mismatch" });
  });
});
