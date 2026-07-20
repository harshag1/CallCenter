// Author: Harsha Gundala
// telephony/status — signed, identity-bound, monotonic Twilio status callbacks.

import { NextResponse } from "next/server";
import { qOne } from "@/lib/db";
import { isUuid } from "@/lib/http";
import {
  normalizeE164,
  twilioAccountSid,
  verifiedTelephonyDeliveryReceipt,
  verifyTwilioWebhook,
} from "@/lib/telephony";
import { log } from "@/lib/log";

const L = log("telephony/status");
const CALL_SID_PATTERN = /^CA[0-9a-fA-F]{32}$/;

const STATUS = {
  queued: { rank: 10, internal: "dialing", terminal: false },
  initiated: { rank: 20, internal: "dialing", terminal: false },
  ringing: { rank: 30, internal: "dialing", terminal: false },
  "in-progress": { rank: 40, internal: "active", terminal: false },
  completed: { rank: 100, internal: "completed", terminal: true },
  busy: { rank: 100, internal: "no-answer", terminal: true },
  "no-answer": { rank: 100, internal: "no-answer", terminal: true },
  canceled: { rank: 100, internal: "no-answer", terminal: true },
  failed: { rank: 100, internal: "failed", terminal: true },
} as const;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function POST(req: Request) {
  const verified = await verifyTwilioWebhook(req);
  if (!verified) return json({ error: "invalid Twilio signature" }, 401);

  const callId = verified.query.get("callId");
  const callSid = verified.form.get("CallSid") ?? "";
  const accountSid = verified.form.get("AccountSid") ?? "";
  const to = normalizeE164(verified.form.get("To"));
  const rawStatus = verified.form.get("CallStatus") ?? "";
  const transition = STATUS[rawStatus as keyof typeof STATUS];
  const rawSequence = verified.form.get("SequenceNumber");
  const sequence = rawSequence === null || rawSequence === ""
    ? null
    : /^\d{1,10}$/.test(rawSequence) && Number(rawSequence) <= 2_147_483_647
      ? Number(rawSequence)
      : Number.NaN;

  if (
    !callId || !isUuid(callId) || !CALL_SID_PATTERN.test(callSid) ||
    accountSid !== twilioAccountSid() || !to || !transition || Number.isNaN(sequence)
  ) return json({ error: "invalid Twilio callback identity" }, 400);

  const terminalProviderStatus = rawStatus === "completed" || rawStatus === "busy"
      || rawStatus === "no-answer" || rawStatus === "canceled" || rawStatus === "failed"
    ? rawStatus
    : null;
  // Twilio create/2xx is only acceptance. A delivery receipt requires the
  // signed, identity-bound terminal callback and a canonical monotonic
  // sequence. Twilio sequence numbers are zero-based, so 0 is authoritative.
  const deliveryReceipt = terminalProviderStatus && sequence !== null && sequence >= 0
    ? verifiedTelephonyDeliveryReceipt({
        callId,
        providerCallSid: callSid,
        providerAccountSid: accountSid,
        recipient: to,
        providerStatus: terminalProviderStatus,
        sequence,
      })
    : null;
  const terminalCode = deliveryReceipt?.status === "delivered"
    ? "provider_terminal_delivered"
    : deliveryReceipt?.status === "terminal_failure"
      ? "provider_terminal_failure"
      : null;

  const updated = await qOne<{ id: string }>(
    `WITH updated_call AS (
       UPDATE calls
       SET twilio_account_sid = COALESCE(twilio_account_sid, $3),
           twilio_status = CASE WHEN $5 >= twilio_status_rank THEN $4 ELSE twilio_status END,
           twilio_status_rank = GREATEST(twilio_status_rank, $5),
           twilio_status_sequence = CASE
             WHEN $6::int IS NULL THEN twilio_status_sequence
             ELSE $6
           END,
           twilio_status_updated_at = now(),
           status = CASE WHEN $5 >= twilio_status_rank THEN $7 ELSE status END,
           ended_at = CASE WHEN $8 THEN COALESCE(ended_at, now()) ELSE ended_at END,
           duration_s = CASE WHEN $8 THEN COALESCE(duration_s, EXTRACT(EPOCH FROM (now() - started_at))::int) ELSE duration_s END,
           metadata = CASE WHEN $10::jsonb IS NULL THEN metadata ELSE
             metadata || jsonb_build_object('delivery_receipt', $10::jsonb)
           END
       WHERE id = $1 AND twilio_call_sid = $2 AND to_number = $9
         AND (twilio_account_sid IS NULL OR twilio_account_sid = $3)
         AND twilio_status_rank < 100
         AND (
           ($6::int IS NOT NULL AND (twilio_status_sequence IS NULL OR $6 > twilio_status_sequence))
           OR
           ($6::int IS NULL AND $5 > twilio_status_rank)
         )
       RETURNING id, scheduled_call_id
     ), updated_execution AS (
       UPDATE operator_action_executions execution
       SET result = jsonb_set(
             jsonb_set(
               jsonb_set(execution.result, '{delivery}', $10::jsonb, false),
               '{status}', to_jsonb($11::text), false
             ),
             '{code}', to_jsonb($12::text), false
           ),
           updated_at = now()
       FROM scheduled_calls scheduled
       JOIN updated_call call
         ON call.id = scheduled.id AND call.scheduled_call_id = scheduled.id
       WHERE $10::jsonb IS NOT NULL
         AND execution.id = scheduled.operator_execution_id
         AND execution.org_id = scheduled.org_id
         AND execution.capability = 'place_call'
         AND execution.status = 'succeeded'
         AND execution.result->>'call_id' = scheduled.id::text
         AND execution.result->>'status' = 'accepted'
         AND execution.result->>'code' = 'provider_accepted'
         AND execution.result->'delivery'->>'status' = 'accepted'
         AND execution.result->'delivery'->>'evidence_source' = 'provider_create_response'
         AND execution.result->'delivery'->>'verified_terminal' = 'false'
         AND execution.result->'delivery'->>'provider_message_id' = $2
         AND execution.result->'delivery'->>'account_binding_sha256' = $13
         AND execution.result->'delivery'->>'recipient_binding_sha256' = $14
       RETURNING execution.id
     )
     SELECT id FROM updated_call`,
    [
      callId,
      callSid,
      accountSid,
      rawStatus,
      transition.rank,
      sequence,
      transition.internal,
      transition.terminal,
      to,
      deliveryReceipt ? JSON.stringify(deliveryReceipt) : null,
      deliveryReceipt?.status ?? null,
      terminalCode,
      deliveryReceipt?.account_binding_sha256 ?? null,
      deliveryReceipt?.recipient_binding_sha256 ?? null,
    ]
  );

  if (updated && transition.terminal) {
    L.info("Twilio call reached terminal status", {
      callId,
      data: { twilioStatus: rawStatus, sequence },
    });
  }
  // Duplicates, stale sequence numbers, and already-terminal calls are successful no-ops.
  return json({ ok: true, applied: !!updated });
}
