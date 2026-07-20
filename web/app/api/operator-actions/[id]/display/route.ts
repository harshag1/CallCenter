// Same-origin, authenticated projection of server-private proposal review data.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { qOne } from "@/lib/db";
import {
  verifyCampaignProposalDisplayTargets,
  type CampaignTargetPreview,
} from "@/lib/campaigns";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    assertSameOriginBrowserMutation(request);
    const body = await readPrivateJsonObject(request);
    if (Object.keys(body).length !== 0) return json({ error: "invalid_request" }, 400);

    const session = await getSession();
    if (!session) return json({ error: "unauthorized" }, 401);
    const { id } = await params;
    if (!UUID.test(id)) return json({ error: "invalid_request" }, 400);

    const proposal = await qOne<{
      action_arguments: unknown;
      arguments_sha256: string;
      estimated_units: number;
      private_display: unknown;
    }>(
      `SELECT oa.action_arguments, oa.arguments_sha256,
              oa.estimated_units, oa.private_display
       FROM operator_action_approvals oa
       JOIN users u ON u.org_id = oa.org_id AND u.email = oa.actor_email
       JOIN operator_action_policies p
         ON p.org_id = oa.org_id AND p.capability = oa.capability AND p.enabled = true
       WHERE oa.id = $1 AND oa.org_id = $2 AND oa.actor_email = $3
         AND u.operator_role IN ('operator','admin')
         AND oa.capability = 'run_campaign' AND oa.approved_at IS NULL
         AND oa.consumed_execution_id IS NULL AND oa.expires_at > now()`,
      [id, session.orgId, session.email]
    );
    if (!proposal) return json({ error: "proposal_display_unavailable" }, 404);

    const actionArguments = record(proposal.action_arguments);
    const privateDisplay = record(proposal.private_display);
    const targets = privateDisplay?.targets;
    const targetCount = actionArguments?.target_count;
    if (!actionArguments || !privateDisplay || !SHA256.test(proposal.arguments_sha256)
        || Object.keys(privateDisplay).length !== 1
        || !Array.isArray(targets)
        || !Number.isSafeInteger(targetCount) || Number(targetCount) < 1 || Number(targetCount) > 5_000
        || proposal.estimated_units !== targetCount || targets.length !== targetCount
        || targets.some((target) => typeof target !== "string" || !E164.test(target))
        || new Set(targets).size !== targets.length) {
      return json({ error: "proposal_display_integrity_failed" }, 409);
    }
    const sortedTargets = [...targets].sort();
    if (targets.some((target, index) => target !== sortedTargets[index])) {
      return json({ error: "proposal_display_integrity_failed" }, 409);
    }
    const preview = {
      schemaVersion: 1,
      orgId: actionArguments.org_id,
      agentId: actionArguments.agent_id,
      flowId: actionArguments.flow_id,
      datasetId: actionArguments.dataset_id,
      datasetSlug: actionArguments.dataset_slug,
      phoneColumn: actionArguments.phone_column,
      agentVersion: actionArguments.agent_version,
      flowSha256: actionArguments.flow_sha256,
      runtimeAdmissionScopeId: actionArguments.runtime_admission_scope_id,
      runtimeDigest: actionArguments.runtime_digest,
      targetSetSha256: actionArguments.target_set_sha256,
      targetCount,
      skipped: actionArguments.skipped_count,
    } as CampaignTargetPreview;
    if (!verifyCampaignProposalDisplayTargets(preview, targets)) {
      return json({ error: "proposal_display_integrity_failed" }, 409);
    }

    return json({
      proposal_id: id,
      arguments_sha256: proposal.arguments_sha256,
      target_count: targetCount,
      targets,
    }, 200);
  } catch (error) {
    if (error instanceof PrivateRequestError) {
      return json({ error: error.status === 415 ? "unsupported_media_type" : "invalid_request" }, error.status);
    }
    return json({ error: "proposal_display_unavailable" }, 500);
  }
}
