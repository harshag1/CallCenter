// Author: Harsha Gundala
// telephony.ts — outbound origination: Twilio dials the customer, bridges the leg into xAI SIP.

import { q, qOne } from "./db";
import { log } from "./log";

const L = log("telephony");

function twilioAuth(): string {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const key = process.env.TWILIO_API_KEY_SID;
  const secret = process.env.TWILIO_API_KEY_SECRET;
  if (key && secret) return Buffer.from(`${key}:${secret}`).toString("base64");
  return Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
}

/**
 * Places an outbound call: Twilio dials `toNumber` from our platform number, then bridges
 * into xAI SIP where the agent (registered on that number) answers via the inbound webhook path.
 */
export async function originateCall(agentId: string, toNumber: string, reason: string | null): Promise<string> {
  const agent = await qOne<{ org_id: string; phone_number: string | null; version: number }>(
    "SELECT org_id, phone_number, active_version AS version FROM agents WHERE id = $1",
    [agentId]
  );
  if (!agent) throw new Error("agent not found");
  const from = agent.phone_number ?? process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error("telephony not provisioned: no phone number attached to this bot (and no TWILIO_PHONE_NUMBER fallback)");
  if (!process.env.TWILIO_ACCOUNT_SID) throw new Error("telephony not provisioned: TWILIO_ACCOUNT_SID missing");

  const call = await qOne<{ id: string }>(
    `INSERT INTO calls (agent_id, agent_version, direction, from_number, to_number, metadata)
     VALUES ($1,$2,'outbound',$3,$4,$5) RETURNING id`,
    [agentId, agent.version, from, toNumber, JSON.stringify({ reason })]
  );

  // Bridge: when the callee answers, Twilio dials our xAI-registered SIP number, which
  // triggers the realtime.call.incoming webhook and attaches the voice agent.
  const twiml = `<Response><Dial answerOnBridge="true"><Sip>sip:${encodeURIComponent(from)}@sip.voice.x.ai;transport=tls</Sip></Dial></Response>`;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls.json`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${twilioAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: toNumber, From: from, Twiml: twiml }),
    }
  );
  if (!res.ok) {
    await q("UPDATE calls SET status = 'failed' WHERE id = $1", [call!.id]);
    throw new Error(`twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  await q("UPDATE calls SET twilio_call_sid = $2 WHERE id = $1", [call!.id, json.sid]);
  L.info("outbound originated", { callId: call!.id, data: { to: toNumber, sid: json.sid } });
  return call!.id;
}
