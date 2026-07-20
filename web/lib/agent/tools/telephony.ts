// Author: Harsha Gundala
// telephony.ts — operator tools: immediate outbound calls and timed recalls.

import { randomUUID } from "node:crypto";
import { q, qOne } from "../../db";
import {
  createNumberMonthlyCostQuote,
  createVoiceCostQuote,
  resolveVoiceMaxDurationSeconds,
} from "../../operator-pricing";
import { previewAvailablePhoneNumber } from "../../telephony";
import { buildVoiceRuntimeSnapshotForAdmission } from "../../voice";
import type { OperatorTool } from "../types";
import {
  OperatorActionDeniedError,
  proposeOperatorAction,
} from "./operator-capability-policy";

export const provisionPhoneNumber: OperatorTool = {
  name: "provision_phone_number",
  description:
    "Preview and propose buying one exact Twilio phone-number candidate for a bot. The browser must approve that exact number and its configured monthly spend reservation before purchase.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      area_code: { type: "string", description: "Optional 3-digit US area code preference." },
    },
    additionalProperties: false,
    required: ["agent_id"],
  },
  async execute(args, ctx) {
    const agentId = String(args.agent_id ?? "");
    const areaCode = args.area_code ? String(args.area_code).trim() : null;
    if (areaCode !== null && !/^\d{3}$/.test(areaCode)) return { output: { error: "area_code must be exactly three digits" } };
    let owned: { id: string; phone_number: string | null } | null;
    try {
      owned = await qOne<{ id: string; phone_number: string | null }>(
        "SELECT id, phone_number FROM agents WHERE id = $1 AND org_id = $2",
        [agentId, ctx.orgId]
      );
    } catch {
      return { output: { error: "phone_number_proposal_unavailable" } };
    }
    if (!owned) return { output: { error: "agent not found" } };
    if (owned.phone_number) return { output: { error: "agent already has a phone number" } };
    let proposal;
    try {
      const candidateNumber = await previewAvailablePhoneNumber(areaCode ?? undefined);
      const costQuote = createNumberMonthlyCostQuote({
        candidateE164: candidateNumber,
        countryCode: "US",
        numberType: "local",
      });
      proposal = await proposeOperatorAction({
        ctx,
        capability: "provision_phone_number",
        argumentsValue: {
          agent_id: agentId,
          area_code: areaCode,
          candidate_number: candidateNumber,
          country_code: "US",
          number_type: "local",
          cost_quote: costQuote,
        },
        estimatedUnits: costQuote.units,
        estimatedMicroUsd: costQuote.reservationMicroUsd,
      });
    } catch (error) {
      return {
        output: {
          error: error instanceof OperatorActionDeniedError
            ? error.code
            : "phone_number_proposal_unavailable",
        },
      };
    }
    return {
      output: { status: "human_confirmation_required", proposal_id: proposal.proposalId },
      operatorActionConfirmation: proposal,
      notice: "Review the recurring number purchase; no number has been bought",
    };
  },
};

export const placeCall: OperatorTool = {
  name: "place_call",
  description: "Propose an outbound call from a bot right now. The browser must approve the exact origin, destination, runtime snapshot, enforced maximum duration, and configured spend reservation before any dial. For future calls use schedule_call.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      to_number: { type: "string", description: "E.164, e.g. +14155551234" },
      reason: { type: "string", description: "Why the bot is calling — it opens the call with this context." },
      max_duration_seconds: { type: "number", description: "Optional connected-call limit; defaults to the deployment cap and can never exceed it." },
    },
    additionalProperties: false,
    required: ["agent_id", "to_number", "reason"],
  },
  async execute(args, ctx) {
    const agentId = String(args.agent_id ?? "");
    const toNumber = String(args.to_number ?? "").trim();
    const reason = String(args.reason ?? "").trim();
    if (!/^\+[1-9]\d{6,14}$/.test(toNumber)) return { output: { error: "to_number must be E.164 (+1...)" } };
    if (!reason || reason.length > 2_000) return { output: { error: "reason must contain 1-2000 characters" } };
    let owned: { id: string; phone_number: string | null } | null;
    try {
      owned = await qOne<{ id: string; phone_number: string | null }>(
        "SELECT id, phone_number FROM agents WHERE id = $1 AND org_id = $2",
        [agentId, ctx.orgId]
      );
    } catch {
      return { output: { error: "call_proposal_unavailable" } };
    }
    if (!owned) return { output: { error: "agent not found" } };
    if (!owned.phone_number) return { output: { error: "agent has no approved outbound phone number" } };
    let proposal;
    try {
      const maxDurationSeconds = resolveVoiceMaxDurationSeconds(args.max_duration_seconds);
      const costQuote = createVoiceCostQuote({
        originE164: owned.phone_number,
        destinationE164: toNumber,
        maxDurationSeconds,
      });
      // This UUID is preallocated as scheduled_calls.id and the eventual calls.id.
      // The approved snapshot is therefore admitted for the exact call that can spend.
      const runtimeAdmissionScopeId = randomUUID();
      const runtime = await buildVoiceRuntimeSnapshotForAdmission({
        agentId,
        orgId: ctx.orgId,
        flowId: null,
        admissionScopeId: runtimeAdmissionScopeId,
      });
      proposal = await proposeOperatorAction({
        ctx,
        capability: "place_call",
        argumentsValue: {
          agent_id: agentId,
          from_number: owned.phone_number,
          to_number: toNumber,
          reason,
          max_duration_seconds: maxDurationSeconds,
          cost_quote: costQuote,
          agent_version: runtime.agentVersion,
          runtime_admission_scope_id: runtimeAdmissionScopeId,
          runtime_digest: runtime.digest,
        },
        estimatedUnits: costQuote.units,
        estimatedMicroUsd: costQuote.reservationMicroUsd,
      });
    } catch (error) {
      return {
        output: {
          error: error instanceof OperatorActionDeniedError
            ? error.code
            : "call_proposal_unavailable",
        },
      };
    }
    return {
      output: { status: "human_confirmation_required", proposal_id: proposal.proposalId },
      operatorActionConfirmation: proposal,
      notice: `Review the exact call to ${toNumber}; nothing has been dialed`,
    };
  },
};

export const scheduleCall: OperatorTool = {
  name: "schedule_call",
  description:
    "Propose an outbound call (or timed recall) for a bot. The browser must approve the exact destination, runtime snapshot, and schedule before a durable job exists. run_at is ISO-8601 UTC.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      to_number: { type: "string", description: "E.164, e.g. +14155551234" },
      run_at: { type: "string", description: "ISO-8601 timestamp" },
      reason: { type: "string" },
      parent_call_id: { type: "string", description: "Set when this is a recall of an earlier call." },
      max_duration_seconds: { type: "number", description: "Optional connected-call limit; defaults to the deployment cap and can never exceed it." },
    },
    additionalProperties: false,
    required: ["agent_id", "to_number", "run_at"],
  },
  async execute(args, ctx) {
    const agentId = String(args.agent_id ?? "");
    const toNumber = String(args.to_number ?? "").trim();
    const runAt = String(args.run_at ?? "");
    const reason = args.reason === undefined ? null : String(args.reason).trim();
    const parentCallId = args.parent_call_id === undefined ? null : String(args.parent_call_id);
    if (!/^\+[1-9]\d{6,14}$/.test(toNumber)) return { output: { error: "to_number must be E.164 (+1...)" } };
    const runAtMs = Date.parse(runAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(runAt) || !Number.isFinite(runAtMs)) {
      return { output: { error: "run_at must be an ISO-8601 UTC timestamp" } };
    }
    if (runAtMs > Date.now() + 366 * 24 * 3600_000) return { output: { error: "run_at cannot be more than 366 days away" } };
    const normalizedRunAt = new Date(runAtMs).toISOString();
    if (reason !== null && reason.length > 2_000) return { output: { error: "reason is too long" } };
    let owned: { id: string; phone_number: string | null } | null;
    try {
      owned = await qOne<{ id: string; phone_number: string | null }>(
        "SELECT id, phone_number FROM agents WHERE id = $1 AND org_id = $2",
        [agentId, ctx.orgId]
      );
    } catch {
      return { output: { error: "scheduled_call_proposal_unavailable" } };
    }
    if (!owned) return { output: { error: "agent not found" } };
    if (!owned.phone_number) return { output: { error: "agent has no approved outbound phone number" } };
    if (parentCallId) {
      let parent;
      try {
        parent = await qOne(
          `SELECT c.id FROM calls c JOIN agents a ON a.id = c.agent_id
           WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3`,
          [parentCallId, agentId, ctx.orgId]
        );
      } catch {
        return { output: { error: "scheduled_call_proposal_unavailable" } };
      }
      if (!parent) return { output: { error: "parent call not found for this agent" } };
    }
    let proposal;
    try {
      const maxDurationSeconds = resolveVoiceMaxDurationSeconds(args.max_duration_seconds);
      const costQuote = createVoiceCostQuote({
        originE164: owned.phone_number,
        destinationE164: toNumber,
        maxDurationSeconds,
      });
      // This UUID is preallocated as scheduled_calls.id and the eventual calls.id.
      const runtimeAdmissionScopeId = randomUUID();
      const runtime = await buildVoiceRuntimeSnapshotForAdmission({
        agentId,
        orgId: ctx.orgId,
        flowId: null,
        admissionScopeId: runtimeAdmissionScopeId,
      });
      proposal = await proposeOperatorAction({
        ctx,
        capability: "schedule_call",
        argumentsValue: {
          agent_id: agentId,
          from_number: owned.phone_number,
          to_number: toNumber,
          run_at: normalizedRunAt,
          reason,
          parent_call_id: parentCallId,
          max_duration_seconds: maxDurationSeconds,
          cost_quote: costQuote,
          agent_version: runtime.agentVersion,
          runtime_admission_scope_id: runtimeAdmissionScopeId,
          runtime_digest: runtime.digest,
        },
        estimatedUnits: costQuote.units,
        estimatedMicroUsd: costQuote.reservationMicroUsd,
      });
    } catch (error) {
      return {
        output: {
          error: error instanceof OperatorActionDeniedError
            ? error.code
            : "scheduled_call_proposal_unavailable",
        },
      };
    }
    return {
      output: { status: "human_confirmation_required", proposal_id: proposal.proposalId },
      operatorActionConfirmation: proposal,
      notice: `Review the exact scheduled call for ${normalizedRunAt}; no job has been created`,
    };
  },
};

export const listScheduledCalls: OperatorTool = {
  name: "list_scheduled_calls",
  description: "List pending/recent scheduled outbound calls and recalls.",
  parameters: { type: "object", properties: { status: { type: "string" } } },
  async execute(args, ctx) {
    const rows = await q(
      `SELECT s.id, a.name AS agent, s.to_number, s.run_at, s.reason, s.status, s.attempts, s.parent_call_id
       FROM scheduled_calls s JOIN agents a ON a.id = s.agent_id
       WHERE a.org_id = $1 AND ($2::text IS NULL OR s.status = $2)
       ORDER BY s.run_at DESC LIMIT 50`,
      [ctx.orgId, args.status ?? null]
    );
    return { output: rows };
  },
};

export const cancelScheduledCall: OperatorTool = {
  name: "cancel_scheduled_call",
  description: "Cancel a pending scheduled call.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async execute(args, ctx) {
    const rows = await q(
      `UPDATE scheduled_calls s SET status = 'canceled'
       FROM agents a WHERE s.id = $1 AND a.id = s.agent_id AND a.org_id = $2 AND s.status = 'pending'
       RETURNING s.id`,
      [args.id, ctx.orgId]
    );
    return { output: rows.length ? { ok: true } : { error: "not found or not pending" } };
  },
};
