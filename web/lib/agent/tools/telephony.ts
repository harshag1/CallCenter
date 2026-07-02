// Author: Harsha Gundala
// telephony.ts — operator tools: immediate outbound calls and timed recalls.

import { q, qOne } from "../../db";
import { originateCall, purchaseNumber } from "../../telephony";
import type { OperatorTool } from "../types";

export const provisionPhoneNumber: OperatorTool = {
  name: "provision_phone_number",
  description:
    "Buy a real phone number (via Twilio) and attach it to a bot. Callers dialing it reach the bot; the bot uses it as caller ID for outbound. ~$1.15/mo per number.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      area_code: { type: "string", description: "Optional 3-digit US area code preference." },
    },
    required: ["agent_id"],
  },
  async execute(args, ctx) {
    const owned = await qOne("SELECT id FROM agents WHERE id = $1 AND org_id = $2", [args.agent_id, ctx.orgId]);
    if (!owned) return { output: { error: "agent not found" } };
    try {
      const number = await purchaseNumber(args.area_code ? String(args.area_code) : undefined);
      await q("UPDATE agents SET phone_number = $2 WHERE id = $1", [args.agent_id, number]);
      return { output: { ok: true, phone_number: number }, notice: `${number} is live` };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};

export const placeCall: OperatorTool = {
  name: "place_call",
  description: "Place an outbound call RIGHT NOW from a bot to a phone number. For future calls use schedule_call.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      to_number: { type: "string", description: "E.164, e.g. +14155551234" },
      reason: { type: "string", description: "Why the bot is calling — it opens the call with this context." },
    },
    required: ["agent_id", "to_number", "reason"],
  },
  async execute(args, ctx) {
    const owned = await qOne("SELECT id FROM agents WHERE id = $1 AND org_id = $2", [args.agent_id, ctx.orgId]);
    if (!owned) return { output: { error: "agent not found" } };
    if (!/^\+\d{7,15}$/.test(String(args.to_number))) return { output: { error: "to_number must be E.164 (+1...)" } };
    try {
      const callId = await originateCall(String(args.agent_id), String(args.to_number), String(args.reason));
      return { output: { ok: true, call_id: callId }, notice: `Dialing ${args.to_number}…` };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};

export const scheduleCall: OperatorTool = {
  name: "schedule_call",
  description:
    "Schedule an outbound call (or a timed recall of a previous call) for a bot. run_at is ISO-8601 UTC; use a time ≤ now for 'call immediately'. The scheduler dials within a minute of run_at.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      to_number: { type: "string", description: "E.164, e.g. +14155551234" },
      run_at: { type: "string", description: "ISO-8601 timestamp" },
      reason: { type: "string" },
      parent_call_id: { type: "string", description: "Set when this is a recall of an earlier call." },
    },
    required: ["agent_id", "to_number", "run_at"],
  },
  async execute(args, ctx) {
    const owned = await qOne("SELECT id FROM agents WHERE id = $1 AND org_id = $2", [args.agent_id, ctx.orgId]);
    if (!owned) return { output: { error: "agent not found" } };
    if (!/^\+\d{7,15}$/.test(String(args.to_number))) return { output: { error: "to_number must be E.164 (+1...)" } };
    const rows = await q<{ id: string }>(
      `INSERT INTO scheduled_calls (agent_id, to_number, run_at, reason, parent_call_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [args.agent_id, args.to_number, args.run_at, args.reason ?? null, args.parent_call_id ?? null, `operator (${ctx.email})`]
    );
    return { output: { ok: true, id: rows[0].id }, notice: `Call scheduled for ${args.run_at}` };
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
