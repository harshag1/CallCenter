// Author: Harsha Gundala
// voice/webhooks — xAI SIP lifecycle: attaches the right bot to incoming calls and logs the conversation.

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { q, qOne } from "@/lib/db";
import { loadActiveAgent, buildVoiceSession } from "@/lib/voice";
import { log } from "@/lib/log";

const L = log("voice/webhooks");
export const maxDuration = 300;

function verifySignature(raw: string, signature: string | null): boolean {
  const secret = process.env.XAI_SIP_SIGNING_SECRET;
  if (!secret) return true; // not yet provisioned — accept during setup, tighten after registration
  if (!signature) return false;
  const expect = createHmac("sha256", secret).update(raw).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expect));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-xai-signature"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  const event = JSON.parse(raw);
  if (event.type !== "realtime.call.incoming") return NextResponse.json({ ok: true });

  const to = event.data?.to ?? event.sip_headers?.To ?? "";
  const from = event.data?.from ?? event.sip_headers?.From ?? "";
  const xaiCallId = event.data?.call_id ?? event.call_id;

  const agentRow = await qOne<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM agents WHERE phone_number = $1", [String(to).replace(/[^+\d]/g, "")]
  );
  if (!agentRow) {
    L.warn("incoming call for unknown number", { data: { to } });
    return NextResponse.json({ ok: true });
  }
  const agent = await loadActiveAgent(agentRow.id, agentRow.org_id);
  const origin = process.env.PUBLIC_ORIGIN ?? new URL(req.url).origin;
  const { callId, sessionUpdate } = await buildVoiceSession(agent!, "inbound", origin, { from, to });
  await q("UPDATE calls SET xai_call_id = $2 WHERE id = $1", [callId, xaiCallId]);

  // Attach: open the control WebSocket, configure the session, log transcript until hangup.
  attachControlSocket(xaiCallId, callId, sessionUpdate).catch((e) =>
    L.error("control socket failed", { callId, err: e.message })
  );
  return NextResponse.json({ ok: true });
}

async function attachControlSocket(xaiCallId: string, callId: string, sessionUpdate: Record<string, unknown>) {
  const ws = new WebSocket(`wss://api.x.ai/v1/realtime?call_id=${xaiCallId}`, {
    // @ts-expect-error — Node fetch WebSocket supports headers via this option bag
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
  });
  const save = (type: string, payload: unknown) =>
    q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,$2,$3)", [callId, type, JSON.stringify(payload)]).catch(() => {});

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify(sessionUpdate));
      ws.send(JSON.stringify({ type: "response.create" }));
      save("state", { state: "connected" });
      resolve();
    };
    ws.onerror = () => reject(new Error("ws error"));
  });

  await new Promise<void>((resolve) => {
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(String(m.data));
        if (ev.type === "conversation.item.input_audio_transcription.completed") {
          save("user_said", { text: ev.transcript });
        } else if (ev.type === "response.output_audio_transcript.done" || ev.type === "response.audio_transcript.done") {
          save("agent_said", { text: ev.transcript });
        } else if (ev.type === "error") {
          save("error", ev);
        }
      } catch { /* ignore non-JSON frames */ }
    };
    ws.onclose = async () => {
      await q(
        `UPDATE calls SET status = 'completed', ended_at = now(),
         duration_s = EXTRACT(EPOCH FROM (now() - started_at))::int WHERE id = $1 AND status = 'active'`,
        [callId]
      );
      resolve();
    };
  });
}
