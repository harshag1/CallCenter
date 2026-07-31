// Server-only dispatch for exact browser-approved operator action proposals.

import { randomUUID } from "node:crypto";
import { q, qOne } from "../db";
import { originateCall, purchaseNumber } from "../telephony";
import { operatorCommunicationDispatch } from "../communications";
import {
  campaignAuthorizationArguments,
  kickCampaign,
  launchCampaign,
  type CampaignAuthorizationArguments,
  type CampaignTargetPreview,
} from "../campaigns";
import { buildVoiceRuntimeSnapshotForAdmission } from "../voice";
import { parseCallRuntimeSnapshot } from "../call-runtime-snapshot";
import {
  assertOperatorCostQuoteUsable,
  createEmailCostQuote,
  createNumberMonthlyCostQuote,
  createSmsCostQuote,
  createVoiceCostQuote,
  parseOperatorCostQuote,
  type OperatorCostQuoteV1,
  type OperatorCostUnitKind,
} from "../operator-pricing";
import {
  executeConfirmedOperatorAction,
  operatorActionArgumentsSha256,
  type ApprovedOperatorAction,
  type ConfirmedActionOutcome,
  type OperatorActionDispatchContext,
} from "./tools/operator-capability-policy";

type JsonObject = Record<string, unknown>;
type DispatchResult = Record<string, unknown>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

function exactObject(value: unknown, keys: readonly string[]): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid approved action arguments");
  const record = value as JsonObject;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("approved action argument shape changed");
  }
  return record;
}

function requiredString(record: JsonObject, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value || value.length > maxLength || /\u0000/.test(value)) {
    throw new Error(`invalid approved ${key}`);
  }
  return value;
}

function positiveInteger(record: JsonObject, key: string, max: number): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`invalid approved ${key}`);
  }
  return value as number;
}

function validatedApprovedCostQuote(
  value: unknown,
  approved: ApprovedOperatorAction,
  current: OperatorCostQuoteV1,
  expectedUnitKind: OperatorCostUnitKind
): OperatorCostQuoteV1 {
  const quote = parseOperatorCostQuote(value);
  if (quote.reservationMicroUsd !== approved.estimatedMicroUsd
      || quote.units !== approved.estimatedUnits) {
    throw new Error("approved cost quote does not match the reserved authority");
  }
  return assertOperatorCostQuoteUsable(quote, {
    reservationCapMicroUsd: approved.estimatedMicroUsd,
    expectedUnitKind,
    expectedPricingSnapshotSha256: current.pricingSnapshotSha256,
    expectedFormulaSha256: current.formulaSha256,
    expectedLimitsSha256: current.limitsSha256,
  });
}

function approvedExecution<T extends DispatchResult>(
  approved: ApprovedOperatorAction,
  dispatch: (context: OperatorActionDispatchContext) => Promise<T>
): Promise<ConfirmedActionOutcome<T>> {
  return executeConfirmedOperatorAction({
    ctx: approved.ctx,
    capability: approved.capability,
    argumentsValue: approved.argumentsValue,
    confirmationToken: approved.confirmationToken,
    approvalId: approved.approvalId,
    idempotencyKey: approved.idempotencyKey,
    estimatedUnits: approved.estimatedUnits,
    estimatedMicroUsd: approved.estimatedMicroUsd,
    dispatch,
  });
}

const GSM_BASIC = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""));
const GSM_EXTENDED = new Set("^{}\\[~]|€".split(""));

function smsSegments(message: string): number {
  let septets = 0;
  for (const character of message) {
    if (GSM_BASIC.has(character)) septets += 1;
    else if (GSM_EXTENDED.has(character)) septets += 2;
    else {
      const units = [...message].reduce(
        (count, entry) => count + (entry.codePointAt(0)! > 0xffff ? 2 : 1),
        0
      );
      return units <= 70 ? 1 : Math.ceil(units / 67);
    }
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

async function dispatchEmail(approved: ApprovedOperatorAction): Promise<ConfirmedActionOutcome<DispatchResult>> {
  const args = exactObject(approved.argumentsValue, ["brand", "cost_quote", "message", "subject", "to"]);
  const to = requiredString(args, "to", 254).toLowerCase();
  const subject = requiredString(args, "subject", 200);
  const message = requiredString(args, "message", 20_000);
  const brand = args.brand === null ? null : requiredString(args, "brand", 200);
  if (!EMAIL.test(to)) throw new Error("approved email address is invalid");
  validatedApprovedCostQuote(
    args.cost_quote,
    approved,
    createEmailCostQuote({ recipient: to }),
    "email_send"
  );
  return approvedExecution(approved, async ({ executionId }) => {
    const receipt = await operatorCommunicationDispatch.email({
      to,
      subject,
      message,
      brand,
      context: {
        approvalId: approved.approvalId,
        executionId,
        expectedQuote: parseOperatorCostQuote(args.cost_quote),
      },
    });
    if (receipt.status === "indeterminate") {
      throw new Error("provider email outcome is indeterminate");
    }
    if (receipt.status === "rejected") {
      return { status: "rejected", code: "provider_rejected" };
    }
    return { accepted: true, to, communication_receipt: receipt };
  });
}

async function dispatchSms(approved: ApprovedOperatorAction): Promise<ConfirmedActionOutcome<DispatchResult>> {
  const args = exactObject(approved.argumentsValue, ["cost_quote", "message", "segments", "to"]);
  const to = requiredString(args, "to", 16);
  const message = requiredString(args, "message", 1_500);
  const segments = positiveInteger(args, "segments", 100);
  if (!E164.test(to) || smsSegments(message) !== segments || approved.estimatedUnits !== segments) {
    throw new Error("approved SMS arguments changed");
  }
  validatedApprovedCostQuote(
    args.cost_quote,
    approved,
    createSmsCostQuote({ destinationE164: to, segmentCount: segments }),
    "sms_segment"
  );
  return approvedExecution(approved, async ({ executionId }) => {
    const receipt = await operatorCommunicationDispatch.sms({
      to,
      message,
      segments,
      context: {
        approvalId: approved.approvalId,
        executionId,
        expectedQuote: parseOperatorCostQuote(args.cost_quote),
      },
    });
    if (receipt.status === "indeterminate") {
      throw new Error("provider SMS outcome is indeterminate");
    }
    if (receipt.status === "rejected") {
      return { status: "rejected", code: "provider_rejected" };
    }
    return { accepted: true, to, segments, communication_receipt: receipt };
  });
}

type RuntimeBoundCall = Readonly<{
  agentId: string;
  fromNumber: string;
  toNumber: string;
  reason: string;
  maxDurationSeconds: number;
  agentVersion: number;
  /** Preallocated scheduled_calls.id and eventual calls.id. */
  callId: string;
  runtimeDigest: string;
}>;

function runtimeBoundCall(
  argumentsValue: unknown,
  approved: ApprovedOperatorAction
): RuntimeBoundCall {
  const args = exactObject(argumentsValue, [
    "agent_id", "agent_version", "cost_quote", "from_number", "max_duration_seconds",
    "reason", "runtime_admission_scope_id", "runtime_digest", "to_number",
  ]);
  const parsed = {
    agentId: requiredString(args, "agent_id", 36),
    fromNumber: requiredString(args, "from_number", 16),
    toNumber: requiredString(args, "to_number", 16),
    reason: requiredString(args, "reason", 2_000),
    maxDurationSeconds: positiveInteger(args, "max_duration_seconds", 86_400),
    agentVersion: positiveInteger(args, "agent_version", 2_147_483_647),
    callId: requiredString(args, "runtime_admission_scope_id", 36),
    runtimeDigest: requiredString(args, "runtime_digest", 64),
  };
  if (!UUID.test(parsed.agentId) || !UUID.test(parsed.callId)
      || !E164.test(parsed.fromNumber) || !E164.test(parsed.toNumber)
      || !SHA256.test(parsed.runtimeDigest)) {
    throw new Error("approved call runtime binding is invalid");
  }
  validatedApprovedCostQuote(
    args.cost_quote,
    approved,
    createVoiceCostQuote({
      originE164: parsed.fromNumber,
      destinationE164: parsed.toNumber,
      maxDurationSeconds: parsed.maxDurationSeconds,
    }),
    "voice_minute"
  );
  return Object.freeze(parsed);
}

async function rebuildRuntime(approved: ApprovedOperatorAction, call: RuntimeBoundCall) {
  const current = await qOne<{ id: string; phone_number: string | null }>(
    "SELECT id, phone_number FROM agents WHERE id = $1 AND org_id = $2",
    [
    call.agentId,
    approved.ctx.orgId,
    ]
  );
  if (!current || current.phone_number !== call.fromNumber) {
    throw new Error("approved agent origin no longer belongs to this organization");
  }
  const rebuilt = await buildVoiceRuntimeSnapshotForAdmission({
    agentId: call.agentId,
    orgId: approved.ctx.orgId,
    flowId: null,
    admissionScopeId: call.callId,
  });
  const runtime = parseCallRuntimeSnapshot(rebuilt.snapshot, rebuilt.digest);
  if (rebuilt.agentVersion !== call.agentVersion || runtime.digest !== call.runtimeDigest) {
    throw new Error("agent runtime changed after approval");
  }
  return runtime;
}

async function dispatchImmediateCall(approved: ApprovedOperatorAction): Promise<ConfirmedActionOutcome<DispatchResult>> {
  const call = runtimeBoundCall(approved.argumentsValue, approved);
  return approvedExecution(approved, async ({ executionId }) => {
    let runtime: Awaited<ReturnType<typeof rebuildRuntime>>;
    try {
      runtime = await rebuildRuntime(approved, call);
    } catch {
      return { status: "rejected", code: "approved_runtime_changed_or_unavailable" };
    }

    const argumentsSha256 = operatorActionArgumentsSha256("place_call", approved.argumentsValue);
    const authorityManifest = {
      v: 1,
      capability: "place_call",
      callId: call.callId,
      orgId: approved.ctx.orgId,
      operatorExecutionId: executionId,
      operatorArgumentsSha256: argumentsSha256,
      runtimeDigest: runtime.digest,
      targetSetSha256: null,
      agentVersion: call.agentVersion,
      flowId: null,
      campaignId: null,
    };
    const materialized = await q<{ id: string }>(
      `INSERT INTO scheduled_calls
         (id, org_id, agent_id, agent_version, to_number, run_at, reason,
          created_by, status, operator_execution_id, operator_arguments_sha256,
          runtime_snapshot, runtime_digest, authority_manifest)
       SELECT $1,$2,a.id,$3,$4,now(),$5,$6,'pending',$7,$8,$9::jsonb,$10,$11::jsonb
       FROM agents a
       WHERE a.id = $12 AND a.org_id = $2
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        call.callId,
        approved.ctx.orgId,
        call.agentVersion,
        call.toNumber,
        call.reason,
        `operator (${approved.ctx.email})`,
        executionId,
        argumentsSha256,
        JSON.stringify(runtime.snapshot),
        runtime.digest,
        JSON.stringify(authorityManifest),
        call.agentId,
      ]
    );
    if (materialized.length !== 1) {
      return { status: "rejected", code: "immediate_call_not_materialized" };
    }

    // Immediate calls use the same reserve-before-dispatch invariant as the
    // scheduler, but are claimed only by this approval request. dialDue never
    // admits place_call rows, so an expired lease cannot become a surprise call.
    const claimToken = randomUUID();
    const claimed = await q<{ id: string }>(
      `UPDATE scheduled_calls s
       SET status = 'dialing', attempts = attempts + 1, claim_token = $3,
           claimed_at = now(), claim_lease_expires_at = now() + interval '60 seconds'
       FROM operator_action_executions oe
       WHERE s.id = $1 AND s.org_id = $2 AND s.status = 'pending'
         AND s.claim_token IS NULL AND s.dispatch_started_at IS NULL
         AND oe.id = s.operator_execution_id AND oe.org_id = s.org_id
         AND oe.id = $4 AND oe.capability = 'place_call'
         AND oe.status = 'dispatching' AND oe.arguments_sha256 = $5
       RETURNING s.id`,
      [call.callId, approved.ctx.orgId, claimToken, executionId, argumentsSha256]
    );
    if (claimed.length !== 1) {
      const canceled = await q<{ id: string }>(
        `UPDATE scheduled_calls
         SET status = 'canceled'
         WHERE id = $1 AND org_id = $2 AND status = 'pending'
           AND claim_token IS NULL AND dispatch_started_at IS NULL
         RETURNING id`,
        [call.callId, approved.ctx.orgId]
      );
      if (canceled.length !== 1) throw new Error("immediate call claim ownership is uncertain");
      return { status: "rejected", code: "immediate_call_not_claimed" };
    }

    try {
      const outcome = await originateCall(call.agentId, call.toNumber, call.reason, {
        scheduledCallId: call.callId,
        claimToken,
        expectedAgentVersion: call.agentVersion,
        maxDurationSeconds: call.maxDurationSeconds,
        runtimeSnapshot: runtime.snapshot,
        runtimeDigest: runtime.digest,
      });
      if (outcome.status === "indeterminate") {
        throw new Error("provider call outcome is indeterminate");
      }
      return outcome.status === "accepted"
        ? {
            call_id: outcome.callId,
            status: outcome.status,
            code: outcome.code,
            delivery: outcome.delivery,
          }
        : { call_id: outcome.callId, status: outcome.status, code: outcome.code };
    } catch (error) {
      const released = await q<{ id: string }>(
        `UPDATE scheduled_calls
         SET status = 'failed', claim_token = NULL, claim_lease_expires_at = NULL
         WHERE id = $1 AND org_id = $2 AND claim_token = $3
           AND status = 'dialing' AND dispatch_started_at IS NULL
         RETURNING id`,
        [call.callId, approved.ctx.orgId, claimToken]
      ).catch(() => []);
      if (released.length === 1) {
        return { call_id: call.callId, status: "failed", code: "pre_dispatch_rejected" };
      }
      await q(
        `UPDATE scheduled_calls
         SET status = 'indeterminate', claim_token = NULL, claim_lease_expires_at = NULL
         WHERE id = $1 AND org_id = $2 AND claim_token = $3
           AND status = 'dialing' AND dispatch_started_at IS NOT NULL`,
        [call.callId, approved.ctx.orgId, claimToken]
      ).catch(() => {});
      throw error;
    }
  });
}

async function dispatchNumberProvision(approved: ApprovedOperatorAction): Promise<ConfirmedActionOutcome<DispatchResult>> {
  const args = exactObject(approved.argumentsValue, [
    "agent_id", "area_code", "candidate_number", "cost_quote", "country_code", "number_type",
  ]);
  const agentId = requiredString(args, "agent_id", 36);
  const areaCode = args.area_code === null ? null : requiredString(args, "area_code", 3);
  const candidateNumber = requiredString(args, "candidate_number", 16);
  const countryCode = requiredString(args, "country_code", 2);
  const numberType = requiredString(args, "number_type", 64);
  if (!UUID.test(agentId) || !E164.test(candidateNumber)
      || countryCode !== "US" || numberType !== "local"
      || (areaCode !== null && !/^\d{3}$/.test(areaCode))) {
    throw new Error("approved number purchase is invalid");
  }
  validatedApprovedCostQuote(
    args.cost_quote,
    approved,
    createNumberMonthlyCostQuote({
      candidateE164: candidateNumber,
      countryCode,
      numberType,
    }),
    "phone_number_month"
  );
  return approvedExecution(approved, async ({ executionId }) => {
    const reserved = await q<{ id: string }>(
      `UPDATE agents
       SET phone_number_provisioning_execution_id = $3
       WHERE id = $1 AND org_id = $2 AND phone_number IS NULL
         AND phone_number_provisioning_execution_id IS NULL
       RETURNING id`,
      [agentId, approved.ctx.orgId, executionId]
    );
    if (reserved.length !== 1) {
      return { status: "rejected", code: "agent_unavailable_for_number_purchase" };
    }
    const number = await purchaseNumber(candidateNumber);
    if (number !== candidateNumber) throw new Error("purchased number does not match approved candidate");
    const attached = await q<{ id: string }>(
      `UPDATE agents
       SET phone_number = $3, phone_number_provisioning_execution_id = NULL
       WHERE id = $1 AND org_id = $2 AND phone_number IS NULL
         AND phone_number_provisioning_execution_id = $4
       RETURNING id`,
      [agentId, approved.ctx.orgId, number, executionId]
    );
    if (attached.length !== 1) throw new Error("purchased number outcome requires manual reconciliation");
    return { phone_number: number };
  });
}

type ScheduledArguments = RuntimeBoundCall & Readonly<{
  runAt: string;
  parentCallId: string | null;
  nullableReason: string | null;
}>;

function scheduledArguments(approved: ApprovedOperatorAction): ScheduledArguments {
  const args = exactObject(approved.argumentsValue, [
    "agent_id", "agent_version", "cost_quote", "from_number", "max_duration_seconds",
    "parent_call_id", "reason", "run_at", "runtime_admission_scope_id", "runtime_digest", "to_number",
  ]);
  const reason = args.reason === null ? null : requiredString(args, "reason", 2_000);
  const parentCallId = args.parent_call_id === null ? null : requiredString(args, "parent_call_id", 36);
  const call = runtimeBoundCall({
    agent_id: args.agent_id,
    agent_version: args.agent_version,
    cost_quote: args.cost_quote,
    from_number: args.from_number,
    max_duration_seconds: args.max_duration_seconds,
    reason: reason ?? "scheduled call",
    runtime_admission_scope_id: args.runtime_admission_scope_id,
    runtime_digest: args.runtime_digest,
    to_number: args.to_number,
  }, approved);
  const runAt = requiredString(args, "run_at", 64);
  const parsed = new Date(runAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== runAt
      || (parentCallId !== null && !UUID.test(parentCallId))) {
    throw new Error("approved scheduled-call arguments are invalid");
  }
  return Object.freeze({ ...call, runAt, parentCallId, nullableReason: reason });
}

async function dispatchScheduledCall(approved: ApprovedOperatorAction): Promise<ConfirmedActionOutcome<DispatchResult>> {
  const call = scheduledArguments(approved);
  return approvedExecution(approved, async ({ executionId }) => {
    let runtime: Awaited<ReturnType<typeof rebuildRuntime>>;
    try {
      runtime = await rebuildRuntime(approved, call);
      if (call.parentCallId) {
        const parent = await qOne(
          `SELECT c.id FROM calls c JOIN agents a ON a.id = c.agent_id
           WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3`,
          [call.parentCallId, call.agentId, approved.ctx.orgId]
        );
        if (!parent) {
          return { status: "rejected", code: "approved_parent_call_changed_or_unavailable" };
        }
      }
    } catch {
      return { status: "rejected", code: "approved_runtime_changed_or_unavailable" };
    }
    const argumentsSha256 = operatorActionArgumentsSha256("schedule_call", approved.argumentsValue);
    const authorityManifest = {
      v: 1,
      capability: "schedule_call",
      callId: call.callId,
      orgId: approved.ctx.orgId,
      operatorExecutionId: executionId,
      operatorArgumentsSha256: argumentsSha256,
      runtimeDigest: runtime.digest,
      targetSetSha256: null,
      agentVersion: call.agentVersion,
      flowId: null,
      campaignId: null,
    };
    const rows = await q<{ id: string }>(
      `INSERT INTO scheduled_calls
         (id, org_id, agent_id, agent_version, to_number, run_at, reason,
          parent_call_id, created_by, status, operator_execution_id,
          operator_arguments_sha256, runtime_snapshot, runtime_digest, authority_manifest)
       SELECT $1,$2,a.id,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11::jsonb,$12,$13::jsonb
       FROM agents a WHERE a.id = $14 AND a.org_id = $2
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        call.callId,
        approved.ctx.orgId,
        call.agentVersion,
        call.toNumber,
        call.runAt,
        call.nullableReason,
        call.parentCallId,
        `operator (${approved.ctx.email})`,
        executionId,
        argumentsSha256,
        JSON.stringify(runtime.snapshot),
        runtime.digest,
        JSON.stringify(authorityManifest),
        call.agentId,
      ]
    );
    if (rows.length !== 1) return { status: "rejected", code: "scheduled_call_not_materialized" };
    return { status: "scheduled", id: rows[0].id, run_at: call.runAt };
  });
}

function campaignAuthorization(argumentsValue: unknown): {
  authorization: CampaignAuthorizationArguments;
  preview: CampaignTargetPreview;
} {
  const args = exactObject(argumentsValue, [
    "action", "agent_id", "agent_version", "campaign_name", "dataset_id", "dataset_slug",
    "cost_quote", "flow_id", "flow_sha256", "from_number", "max_duration_seconds",
    "org_id", "phone_column", "run_at",
    "runtime_admission_scope_id", "runtime_digest", "schema_version", "skipped_count",
    "target_count", "target_set_sha256", "worst_case_micro_usd",
  ]);
  if (args.schema_version !== 1 || args.action !== "run_campaign") {
    throw new Error("approved campaign schema is invalid");
  }
  const authorization = args as unknown as CampaignAuthorizationArguments;
  const preview: CampaignTargetPreview = Object.freeze({
    schemaVersion: 1,
    orgId: requiredString(args, "org_id", 36),
    agentId: requiredString(args, "agent_id", 36),
    flowId: requiredString(args, "flow_id", 36),
    datasetId: requiredString(args, "dataset_id", 36),
    datasetSlug: requiredString(args, "dataset_slug", 48),
    phoneColumn: requiredString(args, "phone_column", 48),
    agentVersion: positiveInteger(args, "agent_version", 2_147_483_647),
    flowSha256: requiredString(args, "flow_sha256", 64),
    runtimeAdmissionScopeId: requiredString(args, "runtime_admission_scope_id", 36),
    runtimeDigest: requiredString(args, "runtime_digest", 64),
    targetSetSha256: requiredString(args, "target_set_sha256", 64),
    targetCount: positiveInteger(args, "target_count", 5_000),
    skipped: Number(args.skipped_count),
  });
  if (!Number.isSafeInteger(preview.skipped) || preview.skipped < 0) {
    throw new Error("approved campaign skipped count is invalid");
  }
  // Reconstructing through the canonical helper rejects malformed names,
  // times, costs, digests, and preview bindings before authority is consumed.
  const rebuilt = campaignAuthorizationArguments(preview, {
    name: requiredString(args, "campaign_name", 160),
    runAt: args.run_at === null ? null : requiredString(args, "run_at", 64),
    fromNumber: requiredString(args, "from_number", 16),
    maxDurationSeconds: positiveInteger(args, "max_duration_seconds", 86_400),
    costQuote: args.cost_quote as CampaignAuthorizationArguments["cost_quote"],
    worstCaseMicroUsd: positiveInteger(args, "worst_case_micro_usd", 1_000_000_000_000),
  });
  if (operatorActionArgumentsSha256("run_campaign", rebuilt)
      !== operatorActionArgumentsSha256("run_campaign", authorization)) {
    throw new Error("approved campaign arguments are not canonical");
  }
  return { authorization: rebuilt, preview };
}

async function dispatchCampaign(approved: ApprovedOperatorAction): Promise<ConfirmedActionOutcome<DispatchResult>> {
  const { authorization, preview } = campaignAuthorization(approved.argumentsValue);
  if (authorization.org_id !== approved.ctx.orgId
      || authorization.cost_quote.units !== approved.estimatedUnits
      || authorization.worst_case_micro_usd !== approved.estimatedMicroUsd) {
    throw new Error("approved campaign authority does not match this organization or reservation");
  }
  const outcome = await approvedExecution(approved, ({ executionId, idempotencyKey }) => launchCampaign(
    approved.ctx.orgId,
    {
      preview,
      name: authorization.campaign_name,
      runAt: authorization.run_at,
      fromNumber: authorization.from_number,
      maxDurationSeconds: authorization.max_duration_seconds,
      costQuote: authorization.cost_quote,
      worstCaseMicroUsd: authorization.worst_case_micro_usd,
      operatorExecutionId: executionId,
      idempotencyKey,
    }
  ));
  if (!outcome.ok || outcome.replayed || outcome.value.scheduled) return outcome;
  try {
    const initialBatch = await kickCampaign(approved.ctx.orgId, outcome.value.campaignId as string);
    return { ...outcome, value: { ...outcome.value, initialBatch } };
  } catch {
    return { ...outcome, value: { ...outcome.value, initialDispatch: "queued_for_worker" } };
  }
}

/** Dispatches only the immutable proposal loaded and approved server-side. */
export async function dispatchApprovedOperatorAction(
  approved: ApprovedOperatorAction
): Promise<ConfirmedActionOutcome<DispatchResult>> {
  switch (approved.capability) {
    case "send_email": return dispatchEmail(approved);
    case "send_sms": return dispatchSms(approved);
    case "place_call": return dispatchImmediateCall(approved);
    case "schedule_call": return dispatchScheduledCall(approved);
    case "provision_phone_number": return dispatchNumberProvision(approved);
    case "run_campaign": return dispatchCampaign(approved);
  }
}
