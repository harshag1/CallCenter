// Author: Harsha Gundala
// telephony/twiml — verified Twilio Voice webhook that binds calls to Media Streams.

import { createHash } from "node:crypto";
import { qOne } from "@/lib/db";
import { signScope, verifyScope } from "@/lib/voice";
import {
  normalizeE164,
  requireBridgeWsUrl,
  twilioAccountSid,
  verifyTwilioWebhook,
  type VerifiedTwilioRequest,
} from "@/lib/telephony";
import { isUuid } from "@/lib/http";
import { log } from "@/lib/log";

const L = log("telephony/twiml");
const CALL_SID_PATTERN = /^CA[0-9a-fA-F]{32}$/;
const CALLER_IDENTITY_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/;
const TWILIO_STREAM_PARAMETER_BUDGET_BYTES = 500;
const BRIDGE_TOKEN_PARAMETER_NAME = "bridgeToken";

type TwilioIdentity = {
  accountSid: string;
  callSid: string;
  to: string;
  from: string;
};

type BoundCall = {
  id: string;
  agent_id: string;
  org_id: string;
  to_number: string;
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function twiml(body: string, status = 200) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function unauthorized() {
  return new Response("invalid Twilio signature", {
    status: 401,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

function identity(params: URLSearchParams): TwilioIdentity | null {
  const accountSid = params.get("AccountSid") ?? "";
  const callSid = params.get("CallSid") ?? "";
  const to = normalizeE164(params.get("To"));
  const fromRaw = params.get("From") ?? "";
  const from = normalizeE164(fromRaw) ?? (
    fromRaw === fromRaw.trim() && CALLER_IDENTITY_PATTERN.test(fromRaw) ? fromRaw : ""
  );
  if (accountSid !== twilioAccountSid() || !CALL_SID_PATTERN.test(callSid) || !to || !from) return null;
  return { accountSid, callSid, to, from };
}

function bridgeCapability(call: BoundCall, provider: TwilioIdentity): string {
  const bridgeOriginSha256 = createHash("sha256")
    .update(requireBridgeWsUrl(), "utf8")
    .digest("hex");
  const token = signScope(
    { callId: call.id, agentId: call.agent_id, orgId: call.org_id },
    {
      audience: "bridge_bootstrap",
      purpose: "telephony_stream_exchange",
      method: "POST",
      provider: "twilio",
      ttlSeconds: 5 * 60,
      providerCallId: provider.callSid,
      providerAccountId: provider.accountSid,
      providerTo: provider.to,
      bridgeOriginSha256,
    }
  );
  if (
    Buffer.byteLength(BRIDGE_TOKEN_PARAMETER_NAME, "utf8") +
      Buffer.byteLength(token, "utf8") > TWILIO_STREAM_PARAMETER_BUDGET_BYTES
  ) {
    throw new Error("bridge bootstrap capability exceeds Twilio's custom-parameter budget");
  }
  return token;
}

function agentStream(call: BoundCall, provider: TwilioIdentity): Response {
  const bridge = requireBridgeWsUrl();
  const capability = bridgeCapability(call, provider);
  return twiml(
    `<Connect><Stream url="${escapeXml(bridge)}">` +
      `<Parameter name="${BRIDGE_TOKEN_PARAMETER_NAME}" value="${escapeXml(capability)}"/>` +
      `<Parameter name="mode" value="agent"/>` +
      `</Stream></Connect>`
  );
}

async function transferTwiml(verified: VerifiedTwilioRequest, provider: TwilioIdentity): Promise<Response | null> {
  const transfer = normalizeE164(verified.query.get("transfer"));
  const token = verified.query.get("capability") ?? "";
  if (!transfer && !token) return null;
  if (!transfer || !token) return twiml("<Hangup/>", 403);

  const scope = verifyScope(token, {
    audience: "telephony-transfer",
    purpose: "human-transfer",
    method: "GET",
    provider: "twilio",
    providerCallId: provider.callSid,
    providerAccountId: provider.accountSid,
    providerTo: provider.to,
    authorizedTarget: transfer,
  });
  if (!scope) return twiml("<Hangup/>", 403);

  const call = await qOne<BoundCall>(
    `SELECT c.id, c.agent_id, a.org_id, c.to_number
     FROM calls c JOIN agents a ON a.id = c.agent_id
     WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3
       AND c.twilio_call_sid = $4 AND c.twilio_account_sid = $5 AND c.to_number = $6
       AND c.status IN ('active','dialing')`,
    [scope.callId, scope.agentId, scope.orgId, provider.callSid, provider.accountSid, provider.to]
  );
  if (!call) return twiml("<Hangup/>", 403);

  // The standalone bridge intentionally has no passive observe mode. A
  // verified transfer therefore hands the call to the human directly instead
  // of accidentally keeping an agent-capable stream attached to that leg.
  return twiml(`<Dial>${escapeXml(transfer)}</Dial>`);
}

async function handle(req: Request): Promise<Response> {
  const verified = await verifyTwilioWebhook(req);
  if (!verified) return unauthorized();
  const provider = identity(req.method === "GET" ? verified.query : verified.form);
  if (!provider) return twiml("<Hangup/>", 403);

  const transfer = await transferTwiml(verified, provider);
  if (transfer) return transfer;
  if (req.method !== "POST") return twiml("<Hangup/>");

  const outboundCallId = verified.query.get("callId");
  if (outboundCallId !== null) {
    if (!isUuid(outboundCallId)) return twiml("<Hangup/>", 403);
    const call = await qOne<BoundCall>(
      `WITH bound AS (
         UPDATE calls
         SET twilio_call_sid = COALESCE(twilio_call_sid, $2),
             twilio_account_sid = COALESCE(twilio_account_sid, $3),
             twilio_status = 'in-progress',
             twilio_status_rank = GREATEST(twilio_status_rank, 40),
             twilio_status_updated_at = now(),
             status = 'active'
         WHERE id = $1 AND direction = 'outbound' AND to_number = $4
           AND status IN ('active','dialing')
           AND (twilio_call_sid IS NULL OR twilio_call_sid = $2)
           AND (twilio_account_sid IS NULL OR twilio_account_sid = $3)
         RETURNING id, agent_id, to_number
       )
       SELECT bound.id, bound.agent_id, a.org_id, bound.to_number
       FROM bound JOIN agents a ON a.id = bound.agent_id`,
      [outboundCallId, provider.callSid, provider.accountSid, provider.to]
    );
    return call ? agentStream(call, provider) : twiml("<Hangup/>", 403);
  }

  const agent = await qOne<{ id: string; org_id: string; version: number }>(
    `SELECT id, org_id, active_version AS version FROM agents WHERE phone_number = $1
       AND NOT EXISTS (
         SELECT 1 FROM agents duplicate
         WHERE duplicate.phone_number = $1 AND duplicate.id <> agents.id
       )`,
    [provider.to]
  );
  if (!agent) {
    L.warn("inbound call for unmapped number");
    return twiml("<Say>This number is not assigned to an agent.</Say><Hangup/>");
  }

  const call = await qOne<BoundCall>(
    `INSERT INTO calls (
       agent_id, agent_version, direction, status, from_number, to_number,
       twilio_call_sid, twilio_account_sid, twilio_status, twilio_status_rank, twilio_status_updated_at
     ) VALUES ($1,$2,'inbound','active',$3,$4,$5,$6,'in-progress',40,now())
     ON CONFLICT (twilio_call_sid) WHERE twilio_call_sid IS NOT NULL DO UPDATE
       SET twilio_account_sid = COALESCE(calls.twilio_account_sid, EXCLUDED.twilio_account_sid),
           twilio_status = CASE WHEN calls.twilio_status_rank < 100 THEN 'in-progress' ELSE calls.twilio_status END,
           twilio_status_rank = GREATEST(calls.twilio_status_rank, 40),
           twilio_status_updated_at = CASE WHEN calls.twilio_status_rank < 100 THEN now() ELSE calls.twilio_status_updated_at END
       WHERE calls.agent_id = EXCLUDED.agent_id
         AND calls.to_number = EXCLUDED.to_number
         AND calls.from_number = EXCLUDED.from_number
         AND (calls.twilio_account_sid IS NULL OR calls.twilio_account_sid = EXCLUDED.twilio_account_sid)
         AND calls.status IN ('active','dialing')
     RETURNING id, agent_id, $7::uuid AS org_id, to_number`,
    [agent.id, agent.version, provider.from, provider.to, provider.callSid, provider.accountSid, agent.org_id]
  );
  return call ? agentStream(call, provider) : twiml("<Hangup/>", 409);
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
