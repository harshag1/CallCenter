// Author: Harsha Gundala
// telephony.ts — Twilio: outbound origination into the media-stream bridge, number search + purchase.

import { q, qOne } from "./db";
import { signScope } from "./voice";
import { log } from "./log";

const L = log("telephony");
const TW = "https://api.twilio.com/2010-04-01";

function sid(): string {
  const v = process.env.TWILIO_ACCOUNT_SID;
  if (!v) throw new Error("TWILIO_ACCOUNT_SID missing");
  return v;
}

function auth(): string {
  // Account token first — the provided SK key pair belongs to a different Twilio account.
  if (process.env.TWILIO_AUTH_TOKEN) return Buffer.from(`${sid()}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  return Buffer.from(`${process.env.TWILIO_API_KEY_SID}:${process.env.TWILIO_API_KEY_SECRET}`).toString("base64");
}

async function twilio(path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${TW}/Accounts/${sid()}${path}`, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: `Basic ${auth()}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`twilio ${res.status}: ${(json as { message?: string }).message ?? "unknown"}`);
  return json as Record<string, unknown>;
}

/** Places an outbound call: Twilio dials the callee; on answer the leg streams into the bridge. */
export async function originateCall(agentId: string, toNumber: string, reason: string | null): Promise<string> {
  const agent = await qOne<{ org_id: string; phone_number: string | null; version: number }>(
    "SELECT org_id, phone_number, active_version AS version FROM agents WHERE id = $1",
    [agentId]
  );
  if (!agent) throw new Error("agent not found");
  const from = agent.phone_number ?? process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error("no phone number: attach one to this bot (provision_phone_number) or set TWILIO_PHONE_NUMBER");
  if (!process.env.BRIDGE_WS_URL) throw new Error("BRIDGE_WS_URL not configured");

  const call = await qOne<{ id: string }>(
    `INSERT INTO calls (agent_id, agent_version, direction, from_number, to_number, metadata)
     VALUES ($1,$2,'outbound',$3,$4,$5) RETURNING id`,
    [agentId, agent.version, from, toNumber, JSON.stringify({ reason })]
  );
  const scope = signScope({ callId: call!.id, agentId, orgId: agent.org_id });
  const origin = process.env.PUBLIC_ORIGIN!;
  const twimlUrl = `${origin}/api/telephony/twiml?callId=${call!.id}&scope=${encodeURIComponent(scope)}`;

  try {
    const res = await twilio("/Calls.json", { To: toNumber, From: from, Url: twimlUrl, Method: "POST" });
    await q("UPDATE calls SET twilio_call_sid = $2 WHERE id = $1", [call!.id, String(res.sid)]);
  } catch (e) {
    await q("UPDATE calls SET status = 'failed' WHERE id = $1", [call!.id]);
    throw e;
  }
  L.info("outbound originated", { callId: call!.id, data: { to: toNumber } });
  return call!.id;
}

/** Buys a voice-enabled number and points its webhook at our TwiML endpoint. */
export async function purchaseNumber(areaCode?: string): Promise<string> {
  const query = new URLSearchParams({ VoiceEnabled: "true", PageSize: "1" });
  if (areaCode) query.set("AreaCode", areaCode);
  const avail = await twilio(`/AvailablePhoneNumbers/US/Local.json?${query}`);
  const candidate = (avail.available_phone_numbers as { phone_number: string }[])?.[0]?.phone_number;
  if (!candidate) throw new Error(`no available numbers${areaCode ? ` in area code ${areaCode}` : ""}`);

  const bought = await twilio("/IncomingPhoneNumbers.json", {
    PhoneNumber: candidate,
    VoiceUrl: `${process.env.PUBLIC_ORIGIN}/api/telephony/twiml`,
    VoiceMethod: "POST",
  });
  L.info("number purchased", { data: { number: String(bought.phone_number) } });
  return String(bought.phone_number);
}
