// Browser-only approval and exact server-side dispatch. No model sampling occurs here.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import {
  approveOperatorActionProposal,
  OperatorActionDeniedError,
} from "@/lib/agent/tools/operator-capability-policy";
import { dispatchApprovedOperatorAction } from "@/lib/agent/operator-action-dispatch";
import { requirePublicOrigin } from "@/lib/public-origin";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const CALL_SID = /^CA[a-f0-9]{32}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const PUBLIC_REJECTION_CODES = new Set([
  "approved_runtime_changed_or_unavailable",
  "approved_parent_call_changed_or_unavailable",
  "immediate_call_not_materialized",
  "immediate_call_not_claimed",
  "pre_dispatch_rejected",
  "provider_rejected",
  "agent_unavailable_for_number_purchase",
  "scheduled_call_not_materialized",
]);
const INDETERMINATE_OUTCOME_CODES = new Set([
  "provider_outcome_indeterminate_do_not_retry",
  "action_already_reserved_or_indeterminate",
  "dispatch_ownership_lost",
]);
const PUBLIC_DENIAL_CODES = new Set([
  "operator_role_required",
  "capability_policy_required",
  "daily_quota_exceeded",
  "fresh_exact_confirmation_required",
  "approval_idempotency_mismatch",
  "idempotency_actor_conflict",
  "idempotency_conflict",
  "idempotency_approval_conflict",
  "action_reservation_failed",
  "confirmation_already_consumed",
  "action_policy_unavailable",
]);
const MODEL_RECEIPT_STATUSES = new Set([
  "accepted", "delivered", "succeeded", "rejected", "indeterminate",
]);
const MODEL_RECEIPT_CODES = new Set([
  ...INDETERMINATE_OUTCOME_CODES,
  ...PUBLIC_DENIAL_CODES,
  "operator_action_denied",
  "authoritative_receipt_projection_failed_do_not_retry",
]);
const MODEL_RECEIPT_CAPABILITIES = new Set([
  "send_email", "send_sms", "place_call", "schedule_call",
  "provision_phone_number", "run_campaign",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function publicCallDeliveryReceipt(value: unknown): Record<string, unknown> | null {
  const input = record(value);
  if (!input) return null;
  const status = boundedString(input.status, 32);
  const evidenceSource = boundedString(input.evidence_source, 64);
  const providerMessageId = boundedString(input.provider_message_id, 64);
  const accountBinding = boundedString(input.account_binding_sha256, 64);
  const recipientBinding = boundedString(input.recipient_binding_sha256, 64);
  if (!providerMessageId || !CALL_SID.test(providerMessageId)
      || !accountBinding || !SHA256.test(accountBinding)
      || !recipientBinding || !SHA256.test(recipientBinding)) return null;
  if (status === "accepted" && evidenceSource === "provider_create_response"
      && input.verified_terminal === false) {
    return {
      status,
      evidence_source: evidenceSource,
      verified_terminal: false,
      provider_message_id: providerMessageId,
      account_binding_sha256: accountBinding,
      recipient_binding_sha256: recipientBinding,
    };
  }
  const providerStatus = boundedString(input.provider_status, 32);
  const terminalProof = boundedString(input.terminal_proof_sha256, 64);
  const sequence = input.sequence;
  const terminalStatusValid = status === "delivered"
    ? providerStatus === "completed"
    : status === "terminal_failure"
      && (providerStatus === "busy" || providerStatus === "no-answer"
        || providerStatus === "canceled" || providerStatus === "failed");
  if (!terminalStatusValid || evidenceSource !== "verified_status_webhook"
      || input.verified_terminal !== true || !terminalProof || !SHA256.test(terminalProof)
      || !Number.isSafeInteger(sequence) || Number(sequence) < 1) return null;
  return {
    status,
    evidence_source: evidenceSource,
    verified_terminal: true,
    provider_message_id: providerMessageId,
    provider_status: providerStatus,
    account_binding_sha256: accountBinding,
    recipient_binding_sha256: recipientBinding,
    terminal_proof_sha256: terminalProof,
    sequence: Number(sequence),
  };
}

/** A durable dispatcher receipt is still treated as untrusted at the HTTP/chat
 * boundary. Each capability gets an explicit public projection so a future
 * provider adapter cannot accidentally return server authority to the browser
 * or model-visible history. */
function publicActionResult(capability: string, value: unknown): Record<string, unknown> | null {
  const input = record(value);
  if (!input) return null;
  const status = boundedString(input.status, 32);
  const code = boundedString(input.code, 96);
  if ((status === "rejected" || status === "failed") && code && PUBLIC_REJECTION_CODES.has(code)) {
    const rejected: Record<string, unknown> = { status, code };
    if (capability === "place_call" && typeof input.call_id === "string" && UUID.test(input.call_id)) {
      rejected.call_id = input.call_id;
    }
    return rejected;
  }
  switch (capability) {
    case "send_email": {
      const to = boundedString(input.to, 254);
      return input.accepted === true && to && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)
        ? { accepted: true, to }
        : null;
    }
    case "send_sms": {
      const to = boundedString(input.to, 16);
      return input.accepted === true && to && E164.test(to)
        && Number.isSafeInteger(input.segments) && Number(input.segments) >= 1 && Number(input.segments) <= 100
        ? { accepted: true, to, segments: Number(input.segments) }
        : null;
    }
    case "place_call": {
      const callId = boundedString(input.call_id, 36);
      const delivery = publicCallDeliveryReceipt(input.delivery);
      const exactStatus = delivery?.status;
      const exactCode = exactStatus === "accepted"
        ? "provider_accepted"
        : exactStatus === "delivered"
          ? "provider_terminal_delivered"
          : exactStatus === "terminal_failure"
            ? "provider_terminal_failure"
            : null;
      return callId && UUID.test(callId) && status === exactStatus && code === exactCode && delivery
        ? { call_id: callId, status, code, delivery }
        : null;
    }
    case "schedule_call": {
      const id = boundedString(input.id, 36);
      const runAt = boundedString(input.run_at, 64);
      return status === "scheduled" && id && UUID.test(id) && runAt
        && Number.isFinite(Date.parse(runAt))
        ? { status, id, run_at: runAt }
        : null;
    }
    case "provision_phone_number": {
      const phoneNumber = boundedString(input.phone_number, 16);
      return phoneNumber && E164.test(phoneNumber) ? { phone_number: phoneNumber } : null;
    }
    case "run_campaign": {
      const campaignId = boundedString(input.campaignId, 36);
      if (!campaignId || !UUID.test(campaignId)
          || !Number.isSafeInteger(input.targets) || Number(input.targets) < 1 || Number(input.targets) > 5_000
          || !Number.isSafeInteger(input.skipped) || Number(input.skipped) < 0
          || typeof input.scheduled !== "boolean") return null;
      const projected: Record<string, unknown> = {
        campaign_id: campaignId,
        targets: Number(input.targets),
        skipped: Number(input.skipped),
        scheduled: input.scheduled,
      };
      if (input.initialDispatch === "queued_for_worker") {
        projected.initial_dispatch = "queued_for_worker";
      }
      return projected;
    }
    default:
      return null;
  }
}

/** System-role history is an authority channel, not a place to repeat
 * user-controlled recipients or message text. Keep only fixed enums, counts,
 * booleans, and opaque UUIDs; the browser receives the richer public receipt. */
function modelVisibleActionReceipt(
  capability: string,
  receipt: Record<string, unknown>,
  publicResult: Record<string, unknown> | null,
): Record<string, unknown> {
  const safeCapability = MODEL_RECEIPT_CAPABILITIES.has(capability) ? capability : "unknown";
  const candidateStatus = boundedString(receipt.status, 32);
  const safeStatus = candidateStatus && MODEL_RECEIPT_STATUSES.has(candidateStatus)
    ? candidateStatus
    : "indeterminate";
  const projected: Record<string, unknown> = {
    schema_version: 1,
    capability: safeCapability,
    status: safeStatus,
  };
  // Replay is an HTTP transport fact, not an action fact. Omitting it keeps the
  // durable receipt byte-stable across the first response and every replay.
  const code = boundedString(receipt.code, 96);
  if (code && MODEL_RECEIPT_CODES.has(code)) projected.code = code;
  if (!publicResult || safeCapability === "unknown") return projected;
  switch (safeCapability) {
    case "send_email":
      if (publicResult.accepted === true) projected.accepted = true;
      break;
    case "send_sms":
      if (publicResult.accepted === true) projected.accepted = true;
      if (Number.isSafeInteger(publicResult.segments)) projected.segments = publicResult.segments;
      break;
    case "place_call":
      if (typeof publicResult.call_id === "string" && UUID.test(publicResult.call_id)) {
        projected.call_id = publicResult.call_id;
      }
      if (publicResult.status === "accepted" || publicResult.status === "delivered"
          || publicResult.status === "terminal_failure" || publicResult.status === "failed"
          || publicResult.status === "rejected") {
        projected.provider_status = publicResult.status;
      }
      if (typeof publicResult.code === "string"
          && (PUBLIC_REJECTION_CODES.has(publicResult.code)
            || publicResult.code === "provider_accepted"
            || publicResult.code === "provider_terminal_delivered"
            || publicResult.code === "provider_terminal_failure")) {
        projected.provider_code = publicResult.code;
      }
      break;
    case "schedule_call":
      if (typeof publicResult.id === "string" && UUID.test(publicResult.id)) projected.call_id = publicResult.id;
      if (publicResult.status === "scheduled") projected.scheduled = true;
      break;
    case "provision_phone_number":
      projected.provisioned = true;
      break;
    case "run_campaign":
      if (typeof publicResult.campaign_id === "string" && UUID.test(publicResult.campaign_id)) {
        projected.campaign_id = publicResult.campaign_id;
      }
      if (Number.isSafeInteger(publicResult.targets)) projected.targets = publicResult.targets;
      if (typeof publicResult.scheduled === "boolean") projected.scheduled = publicResult.scheduled;
      break;
  }
  return projected;
}

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

async function persistCanonicalModelReceipt(input: Readonly<{
  proposalId: string;
  orgId: string;
  actorEmail: string;
  threadId: string;
  receipt: Record<string, unknown>;
}>): Promise<string | null> {
  const encoded = JSON.stringify(input.receipt);
  const receiptRows = await q<{ id: string }>(
    `UPDATE operator_action_executions oe
     SET public_receipt = COALESCE(oe.public_receipt, $4::jsonb),
         receipt_thread_id = COALESCE(oe.receipt_thread_id, $5),
         updated_at = CASE WHEN oe.public_receipt IS NULL THEN now() ELSE oe.updated_at END
     FROM operator_action_approvals oa
     WHERE oa.id = $1 AND oa.org_id = $2 AND oa.actor_email = $3
       AND oa.thread_id = $5 AND oa.consumed_execution_id = oe.id
       AND oe.org_id = oa.org_id AND oe.capability = oa.capability
       AND oe.status IN ('succeeded','indeterminate')
       AND (oe.public_receipt IS NULL OR oe.public_receipt = $4::jsonb)
       AND (oe.receipt_thread_id IS NULL OR oe.receipt_thread_id = $5)
     RETURNING oe.id`,
    [input.proposalId, input.orgId, input.actorEmail, encoded, input.threadId],
  ).catch(() => []);
  const executionId = receiptRows[0]?.id;
  if (!executionId) return null;

  await q(
    `INSERT INTO chat_messages
       (org_id, thread_id, role, content, operator_execution_id)
     VALUES ($1,$2,'system',$3::jsonb,$4)
     ON CONFLICT (operator_execution_id)
       WHERE operator_execution_id IS NOT NULL
     DO NOTHING`,
    [
      input.orgId,
      input.threadId,
      JSON.stringify({
        role: "system",
        content: `Authoritative operator action receipt: ${encoded}`,
      }),
      executionId,
    ],
  ).catch(() => {
    // The execution row is the durable outbox. runOperator republishes the
    // canonical receipt exactly once before reading this thread's history.
  });
  return executionId;
}

function browserReceiptFromSucceededResult(
  capability: string,
  result: unknown,
  replayed: boolean,
): { receipt: Record<string, unknown>; publicResult: Record<string, unknown> | null; knownRejection: boolean } {
  const publicResult = publicActionResult(capability, result);
  const knownRejection = publicResult?.status === "rejected" || publicResult?.status === "failed"
    || publicResult?.status === "terminal_failure";
  const acceptedPending = capability === "send_email" || capability === "send_sms"
    || capability === "schedule_call" || capability === "run_campaign"
    || publicResult?.status === "accepted";
  const receipt: Record<string, unknown> = publicResult
    ? {
        status: knownRejection
          ? "rejected"
          : publicResult.status === "delivered"
            ? "delivered"
            : acceptedPending
              ? "accepted"
              : "succeeded",
        replayed,
        result: publicResult,
      }
    : {
        status: "indeterminate",
        code: "authoritative_receipt_projection_failed_do_not_retry",
      };
  return { receipt, publicResult, knownRejection };
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

    const proposal = await qOne<{ thread_id: string }>(
      `SELECT thread_id FROM operator_action_approvals
       WHERE id = $1 AND org_id = $2 AND actor_email = $3`,
      [id, session.orgId, session.email]
    );
    if (!proposal || !UUID.test(proposal.thread_id)) {
      return json({ error: "proposal_unavailable" }, 404);
    }

    const approved = await approveOperatorActionProposal({
      proposalId: id,
      ctx: {
        orgId: session.orgId,
        email: session.email,
        agentId: null,
        origin: requirePublicOrigin(),
        threadId: proposal.thread_id,
      },
    });
    const outcome = await dispatchApprovedOperatorAction(approved);
    const succeeded = outcome.ok
      ? browserReceiptFromSucceededResult(approved.capability, outcome.value, outcome.replayed)
      : null;
    const publicResult = succeeded?.publicResult ?? null;
    const knownRejection = succeeded?.knownRejection ?? false;
    let receipt: Record<string, unknown>;
    if (outcome.ok) {
      receipt = succeeded!.receipt;
    } else {
      const outcomeCode = INDETERMINATE_OUTCOME_CODES.has(outcome.code)
        ? outcome.code
        : PUBLIC_DENIAL_CODES.has(outcome.code)
          ? outcome.code
          : "operator_action_denied";
      receipt = {
        status: INDETERMINATE_OUTCOME_CODES.has(outcome.code)
          ? "indeterminate"
          : "rejected",
        code: outcomeCode,
      };
    }

    const requiresDurableReceipt = outcome.ok
      || (!outcome.ok && outcome.code === "provider_outcome_indeterminate_do_not_retry");
    if (requiresDurableReceipt) {
      const modelReceipt = modelVisibleActionReceipt(approved.capability, receipt, publicResult);
      const executionId = await persistCanonicalModelReceipt({
        proposalId: id,
        orgId: session.orgId,
        actorEmail: session.email,
        threadId: proposal.thread_id,
        receipt: modelReceipt,
      });
      if (!executionId) {
        return json({
          ok: false,
          status: "indeterminate",
          code: "authoritative_receipt_unavailable_reconcile_status",
        }, 409);
      }
    }

    if (outcome.ok && publicResult) return json({ ok: !knownRejection, ...receipt }, 200);
    return json(
      { ok: false, ...receipt },
      receipt.status === "indeterminate" ? 409 : 403
    );
  } catch (error) {
    if (error instanceof PrivateRequestError) {
      return json({ error: error.status === 415 ? "unsupported_media_type" : "invalid_request" }, error.status);
    }
    if (error instanceof OperatorActionDeniedError) {
      if (error.code === "approval_in_progress_or_outcome_unknown_do_not_retry") {
        return json({
          ok: false,
          status: "indeterminate",
          code: error.code,
        }, 409);
      }
      const unavailable = error.code.includes("unavailable") || error.code.includes("expired");
      return json({ error: unavailable ? "proposal_unavailable" : "approval_denied" }, unavailable ? 404 : 403);
    }
    return json({ error: "operator_action_failed" }, 500);
  }
}

/**
 * Read-only reconciliation for a browser that lost the approval response.
 * PUT is used so the strict same-origin boundary receives Origin consistently;
 * this handler never reserves, dispatches, or contacts a provider.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOriginBrowserMutation(request);
    const body = await readPrivateJsonObject(request);
    if (Object.keys(body).length !== 0) return json({ error: "invalid_request" }, 400);

    const session = await getSession();
    if (!session) return json({ error: "unauthorized" }, 401);
    const { id } = await params;
    if (!UUID.test(id)) return json({ error: "invalid_request" }, 400);

    const statusRow = await qOne<{
      capability: string;
      thread_id: string;
      execution_status: string | null;
      result: unknown;
    }>(
      `SELECT oa.capability, oa.thread_id,
              oe.status AS execution_status, oe.result
       FROM operator_action_approvals oa
       JOIN users actor
         ON actor.email = oa.actor_email AND actor.org_id = oa.org_id
        AND actor.operator_role IN ('operator','admin')
       JOIN operator_action_policies policy
         ON policy.org_id = oa.org_id AND policy.capability = oa.capability
        AND policy.enabled = true
       LEFT JOIN operator_action_executions oe
         ON oe.id = oa.consumed_execution_id
        AND oe.org_id = oa.org_id AND oe.capability = oa.capability
       WHERE oa.id = $1 AND oa.org_id = $2 AND oa.actor_email = $3`,
      [id, session.orgId, session.email],
    );
    if (!statusRow || !UUID.test(statusRow.thread_id)) {
      return json({ error: "proposal_unavailable" }, 404);
    }
    if (statusRow.execution_status !== "succeeded" && statusRow.execution_status !== "indeterminate") {
      return json({ ok: false, status: "pending", code: "action_status_pending" }, 202);
    }

    const succeeded = statusRow.execution_status === "succeeded"
      ? browserReceiptFromSucceededResult(statusRow.capability, statusRow.result, true)
      : null;
    const receipt = succeeded?.receipt ?? {
      status: "indeterminate",
      code: "provider_outcome_indeterminate_do_not_retry",
    };
    const publicResult = succeeded?.publicResult ?? null;
    const modelReceipt = modelVisibleActionReceipt(statusRow.capability, receipt, publicResult);
    const executionId = await persistCanonicalModelReceipt({
      proposalId: id,
      orgId: session.orgId,
      actorEmail: session.email,
      threadId: statusRow.thread_id,
      receipt: modelReceipt,
    });
    if (!executionId) {
      return json({
        ok: false,
        status: "indeterminate",
        code: "authoritative_receipt_unavailable_reconcile_status",
      }, 409);
    }

    if (succeeded) {
      return json({ ok: !succeeded.knownRejection, ...succeeded.receipt }, 200);
    }
    return json({ ok: false, ...receipt }, 409);
  } catch (error) {
    if (error instanceof PrivateRequestError) {
      return json({ error: error.status === 415 ? "unsupported_media_type" : "invalid_request" }, error.status);
    }
    return json({ error: "operator_action_status_failed" }, 500);
  }
}
