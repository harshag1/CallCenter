// Author: Harsha Gundala
// telephony/twiml — Twilio voice webhook: routes PSTN calls into the media-stream bridge.

import { qOne } from "@/lib/db";
import { signScope } from "@/lib/voice";
import { log } from "@/lib/log";

const L = log("telephony/twiml");

function twiml(body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });
}

/**
 * Transfer: contact_support (lib/mcp.ts) redirects the live call to
 * `{PUBLIC_ORIGIN}/api/telephony/twiml?transfer=<E.164>&scope=<scope>` (GET or POST).
 * We fork media to the bridge in observe mode (both tracks) and Dial the human line.
 * Note: `<Start><Stream>` custom parameters arrive in start.customParameters, same as `<Connect><Stream>`.
 */
function transferTwiml(url: URL): Response | null {
  const transfer = url.searchParams.get("transfer");
  const scope = url.searchParams.get("scope");
  if (!transfer || !scope) return null;
  const bridge = process.env.BRIDGE_WS_URL;
  if (!bridge) return twiml("<Say>Bridge is not configured.</Say><Hangup/>");
  const number = transfer.replace(/[^+\d]/g, "");
  return twiml(
    `<Start><Stream url="${bridge}" track="both_tracks">` +
      `<Parameter name="scope" value="${scope}"/>` +
      `<Parameter name="mode" value="observe"/>` +
      `</Stream></Start><Dial>${number}</Dial>`
  );
}

export async function GET(req: Request) {
  return transferTwiml(new URL(req.url)) ?? twiml("<Hangup/>");
}

/**
 * Inbound: Twilio POSTs To/From — we resolve the bot by dialed number and create the call.
 * Outbound: originateCall() passes ?callId&scope so the answered leg joins its existing call row.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const transfer = transferTwiml(url);
  if (transfer) return transfer;
  const form = await req.formData().catch(() => new FormData());
  const bridge = process.env.BRIDGE_WS_URL;
  if (!bridge) return twiml("<Say>Bridge is not configured.</Say><Hangup/>");

  let callId = url.searchParams.get("callId");
  let scope = url.searchParams.get("scope");

  if (!callId) {
    const to = String(form.get("To") ?? "");
    const from = String(form.get("From") ?? "");
    const agent = await qOne<{ id: string; org_id: string; version: number }>(
      "SELECT id, org_id, active_version AS version FROM agents WHERE phone_number = $1",
      [to]
    );
    if (!agent) {
      L.warn("inbound call for unmapped number", { data: { to } });
      return twiml("<Say>This number is not assigned to an agent.</Say><Hangup/>");
    }
    const call = await qOne<{ id: string }>(
      `INSERT INTO calls (agent_id, agent_version, direction, from_number, to_number, twilio_call_sid)
       VALUES ($1,$2,'inbound',$3,$4,$5) RETURNING id`,
      [agent.id, agent.version, from, to, String(form.get("CallSid") ?? "") || null]
    );
    callId = call!.id;
    scope = signScope({ callId, agentId: agent.id, orgId: agent.org_id });
  }

  return twiml(
    `<Connect><Stream url="${bridge}">` +
      `<Parameter name="callId" value="${callId}"/>` +
      `<Parameter name="scope" value="${scope}"/>` +
      `</Stream></Connect>`
  );
}
