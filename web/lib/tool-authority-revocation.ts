// Explicit control-plane helpers for one-way emergency integration cutoffs.

import { q, qOne } from "./db";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const GENERATED_KEY = /^tik_[A-Za-z0-9_-]{16}$/;

export class ToolAuthorityRevocationError extends Error {
  readonly code: "invalid_revocation_request" | "authority_binding_mismatch";

  constructor(code: ToolAuthorityRevocationError["code"]) {
    super(code === "invalid_revocation_request"
      ? "tool authority revocation request is invalid"
      : "tool authority revision was not found with the exact tenant binding");
    this.name = "ToolAuthorityRevocationError";
    this.code = code;
  }
}

type RevocationReason = Readonly<{ actor: string; reason: string }>;
export type ToolAuthorityRevocationReceipt = Readonly<{
  authorityKind: "remote_mcp" | "generated_tool";
  authorityId: string;
  orgId: string;
  revokedAt: string;
  actor: string;
  reason: string;
  replayed: boolean;
}>;

type RevokedRow = {
  authority_id: string;
  org_id: string;
  revoked_at: Date | string;
  revoked_by: string;
  revocation_reason: string;
};

function validatedReason(input: RevocationReason): { actor: string; reason: string } {
  const actor = typeof input.actor === "string" ? input.actor.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!actor || actor.length > 256 || reason.length < 8 || reason.length > 2_048) {
    throw new ToolAuthorityRevocationError("invalid_revocation_request");
  }
  return { actor, reason };
}

function receipt(
  kind: ToolAuthorityRevocationReceipt["authorityKind"],
  row: RevokedRow,
  replayed: boolean
): ToolAuthorityRevocationReceipt {
  return Object.freeze({
    authorityKind: kind,
    authorityId: row.authority_id,
    orgId: row.org_id,
    revokedAt: new Date(row.revoked_at).toISOString(),
    actor: row.revoked_by,
    reason: row.revocation_reason,
    replayed,
  });
}

/**
 * Revokes one immutable remote registration. The catalog digest prevents a stale operator view
 * from cutting off a different revision that happens to reuse an external endpoint.
 */
export async function revokeRemoteMcpAuthority(input: Readonly<{
  orgId: string;
  serverId: string;
  approvedCatalogHash: string;
}> & RevocationReason): Promise<ToolAuthorityRevocationReceipt> {
  if (!UUID.test(input.orgId) || !UUID.test(input.serverId) || !SHA256.test(input.approvedCatalogHash)) {
    throw new ToolAuthorityRevocationError("invalid_revocation_request");
  }
  const { actor, reason } = validatedReason(input);
  const [revoked] = await q<RevokedRow>(
    `UPDATE mcp_servers
     SET revoked_at=clock_timestamp(), revoked_by=$4, revocation_reason=$5
     WHERE id=$1 AND org_id=$2 AND approved_catalog_hash=$3
       AND approved_manifest IS NOT NULL AND revoked_at IS NULL
     RETURNING id::text AS authority_id, org_id::text, revoked_at, revoked_by, revocation_reason`,
    [input.serverId, input.orgId, input.approvedCatalogHash, actor, reason]
  );
  if (revoked) return receipt("remote_mcp", revoked, false);

  const existing = await qOne<RevokedRow>(
    `SELECT id::text AS authority_id, org_id::text, revoked_at, revoked_by, revocation_reason
     FROM mcp_servers
     WHERE id=$1 AND org_id=$2 AND approved_catalog_hash=$3 AND revoked_at IS NOT NULL`,
    [input.serverId, input.orgId, input.approvedCatalogHash]
  );
  if (existing) return receipt("remote_mcp", existing, true);
  throw new ToolAuthorityRevocationError("authority_binding_mismatch");
}

/**
 * Revokes one generated signing revision, not the mutable latest-tool pointer. Endpoint + key +
 * tenant identity must all match, so ordinary redeploy/retirement remains a separate operation.
 */
export async function revokeGeneratedToolAuthority(input: Readonly<{
  orgId: string;
  toolId: string;
  keyId: string;
  endpointUrl: string;
}> & RevocationReason): Promise<ToolAuthorityRevocationReceipt> {
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpointUrl);
  } catch {
    throw new ToolAuthorityRevocationError("invalid_revocation_request");
  }
  if (!UUID.test(input.orgId) || !UUID.test(input.toolId) || !GENERATED_KEY.test(input.keyId) ||
      endpoint.protocol !== "https:" || endpoint.toString() !== input.endpointUrl) {
    throw new ToolAuthorityRevocationError("invalid_revocation_request");
  }
  const { actor, reason } = validatedReason(input);
  const [revoked] = await q<RevokedRow>(
    `UPDATE tool_invocation_revisions revision
     SET revoked_at=clock_timestamp(), revoked_by=$5, revocation_reason=$6
     FROM tools tool
     WHERE revision.tool_id=tool.id
       AND tool.id=$1 AND tool.org_id=$2
       AND revision.key_id=$3 AND revision.endpoint_url=$4
       AND revision.status IN ('live','retired') AND revision.revoked_at IS NULL
     RETURNING revision.key_id AS authority_id, tool.org_id::text, revision.revoked_at,
               revision.revoked_by, revision.revocation_reason`,
    [input.toolId, input.orgId, input.keyId, input.endpointUrl, actor, reason]
  );
  if (revoked) return receipt("generated_tool", revoked, false);

  const existing = await qOne<RevokedRow>(
    `SELECT revision.key_id AS authority_id, tool.org_id::text, revision.revoked_at,
            revision.revoked_by, revision.revocation_reason
     FROM tool_invocation_revisions revision
     JOIN tools tool ON tool.id=revision.tool_id
     WHERE tool.id=$1 AND tool.org_id=$2
       AND revision.key_id=$3 AND revision.endpoint_url=$4
       AND revision.status IN ('live','retired') AND revision.revoked_at IS NOT NULL`,
    [input.toolId, input.orgId, input.keyId, input.endpointUrl]
  );
  if (existing) return receipt("generated_tool", existing, true);
  throw new ToolAuthorityRevocationError("authority_binding_mismatch");
}
