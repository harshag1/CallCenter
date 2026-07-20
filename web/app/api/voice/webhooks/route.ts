// Author: Harsha Gundala
// voice/webhooks — Standard Webhooks-verified xAI SIP attachment and lifecycle journal.

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { Webhook } from "standardwebhooks";
import WebSocket from "ws";
import { q, qOne } from "@/lib/db";
import { loadActiveAgent, voiceSessionSpecForCall } from "@/lib/voice";
import { buildProviderSessionUpdate } from "@/lib/realtime/registry";
import { normalizeE164 } from "@/lib/telephony";
import { requirePublicOrigin } from "@/lib/public-origin";
import { log } from "@/lib/log";
import { xaiSipSigningSecret } from "@/lib/high-authority-secrets";

const L = log("voice/webhooks");
const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const XAI_CALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_WEBHOOK_BYTES = 256 * 1024;
export const maxDuration = 300;

type XaiIncomingEvent = {
  object: "event";
  id: string;
  type: "realtime.call.incoming";
  created_at: number;
  data: {
    call_id: string;
    sip_headers: Array<{ name: string; value: string }>;
    metadata?: Record<string, unknown>;
  };
};

function json(body: Record<string, unknown>, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

async function rawBody(req: Request): Promise<string | null> {
  const advertised = req.headers.get("content-length");
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_WEBHOOK_BYTES)) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function verifyXaiWebhook(raw: string, req: Request): unknown | null {
  const webhookId = req.headers.get("webhook-id") ?? "";
  const timestamp = req.headers.get("webhook-timestamp") ?? "";
  const signature = req.headers.get("webhook-signature") ?? "";
  if (!WEBHOOK_ID_PATTERN.test(webhookId) || timestamp.length > 32 || signature.length > 2_048) return null;
  try {
    return new Webhook(xaiSipSigningSecret()).verify(raw, {
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    });
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function incomingEvent(value: unknown): XaiIncomingEvent | null {
  if (!isRecord(value) || value.object !== "event" || value.type !== "realtime.call.incoming" ||
      typeof value.id !== "string" || value.id.length > 128 ||
      !Number.isSafeInteger(value.created_at) || !isRecord(value.data)) return null;
  const data = value.data;
  if (typeof data.call_id !== "string" || !XAI_CALL_ID_PATTERN.test(data.call_id) || !Array.isArray(data.sip_headers) ||
      data.sip_headers.length > 100) return null;
  for (const header of data.sip_headers) {
    if (!isRecord(header) || typeof header.name !== "string" || header.name.length > 128 ||
        typeof header.value !== "string" || header.value.length > 4_096) return null;
  }
  return value as XaiIncomingEvent;
}

function sipHeader(event: XaiIncomingEvent, name: string): string | null {
  const target = name.toLowerCase();
  return event.data.sip_headers.find((header) => header.name.toLowerCase() === target)?.value ?? null;
}

function phoneFromSip(value: string | null): string | null {
  if (!value) return null;
  const matched = value.match(/\+[1-9]\d{6,14}/)?.[0];
  return normalizeE164(matched);
}

async function claimReceipt(webhookId: string, payloadSha256: string, eventType: string, createdAt: number) {
  const claimed = await qOne<{ webhook_id: string }>(
    `INSERT INTO provider_webhook_receipts (
       provider, webhook_id, payload_sha256, event_type, provider_created_at, status
     ) VALUES ('xai',$1,$2,$3,to_timestamp($4),'processing')
     ON CONFLICT (provider, webhook_id) DO UPDATE
       SET status = 'processing', attempts = provider_webhook_receipts.attempts + 1,
           processing_started_at = now(), last_error = NULL
       WHERE provider_webhook_receipts.payload_sha256 = EXCLUDED.payload_sha256
         AND (
           provider_webhook_receipts.status = 'failed'
           OR provider_webhook_receipts.processing_started_at < now() - interval '5 minutes'
         )
     RETURNING webhook_id`,
    [webhookId, payloadSha256, eventType, createdAt]
  );
  if (claimed) return { state: "claimed" as const };
  const existing = await qOne<{ payload_sha256: string; status: string }>(
    "SELECT payload_sha256, status FROM provider_webhook_receipts WHERE provider = 'xai' AND webhook_id = $1",
    [webhookId]
  );
  if (!existing || existing.payload_sha256 !== payloadSha256) return { state: "conflict" as const };
  return { state: existing.status === "processed" ? "processed" as const : "busy" as const };
}

async function finishReceipt(webhookId: string, callId: string | null) {
  await q(
    `UPDATE provider_webhook_receipts SET status = 'processed', processed_at = now(), call_id = $2, last_error = NULL
     WHERE provider = 'xai' AND webhook_id = $1`,
    [webhookId, callId]
  );
}

async function failReceipt(webhookId: string) {
  await q(
    `UPDATE provider_webhook_receipts SET status = 'failed', last_error = $2
     WHERE provider = 'xai' AND webhook_id = $1`,
    [webhookId, "sip_attachment_failed"]
  ).catch(() => undefined);
}

type AttachedSocket = { done: Promise<void> };

async function attachControlSocket(
  xaiCallId: string,
  callId: string,
  sessionUpdate: Record<string, unknown>
): Promise<AttachedSocket> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey || apiKey.length < 16 || apiKey.length > 4_096 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new Error("XAI_API_KEY is required for SIP control sockets");
  }
  const url = new URL("wss://api.x.ai/v1/realtime");
  url.searchParams.set("call_id", xaiCallId);
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: 8_000,
    maxPayload: 2 * 1024 * 1024,
  });
  const save = (type: string, payload: unknown) =>
    q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,$2,$3)", [
      callId, type, JSON.stringify(payload ?? {}),
    ]).catch(() => undefined);

  let readySettled = false;
  let greeted = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const readyTimer = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("xAI SIP session acknowledgement timed out"));
      ws.close();
    }
  }, 8_000);

  ws.on("open", () => {
    ws.send(JSON.stringify(sessionUpdate));
    void save("state", { state: "connected", provider: "xai" });
  });
  ws.on("message", (raw) => {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(raw));
      if (!isRecord(parsed) || typeof parsed.type !== "string") return;
      event = parsed;
    } catch {
      return;
    }
    if (event.type === "session.updated" && !greeted) {
      greeted = true;
      ws.send(JSON.stringify({ type: "response.create" }));
      if (!readySettled) {
        readySettled = true;
        clearTimeout(readyTimer);
        resolveReady();
      }
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      void save("user_said", { text: event.transcript });
    } else if (event.type === "response.output_audio_transcript.done" || event.type === "response.audio_transcript.done") {
      void save("agent_said", { text: event.transcript });
    } else if (event.type === "error") {
      // Provider error bodies may echo bearer credentials, session instructions, or caller PII.
      void save("error", { code: "provider_runtime_error", provider: "xai" });
      if (!readySettled) {
        readySettled = true;
        clearTimeout(readyTimer);
        rejectReady(new Error("xAI rejected SIP session configuration"));
        ws.close(1008, "session configuration rejected");
      }
    }
  });
  ws.on("error", () => {
    void save("error", { code: "provider_runtime_error", provider: "xai" });
    if (!readySettled) {
      readySettled = true;
      clearTimeout(readyTimer);
      rejectReady(new Error("xAI SIP control socket failed"));
    }
  });
  ws.on("close", () => {
    clearTimeout(readyTimer);
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("xAI SIP control socket closed before session acknowledgement"));
    }
    void q(
      `UPDATE calls SET status = 'completed', ended_at = COALESCE(ended_at, now()),
       duration_s = COALESCE(duration_s, EXTRACT(EPOCH FROM (now() - started_at))::int)
       WHERE id = $1 AND status = 'active'`,
      [callId]
    ).finally(resolveDone);
  });

  await ready;
  return { done };
}

export async function POST(req: Request) {
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "Content-Type must be application/json" }, 415);
  }
  const raw = await rawBody(req);
  if (raw === null) return json({ error: "webhook body too large" }, 413);
  const verified = verifyXaiWebhook(raw, req);
  if (!verified) return json({ error: "invalid webhook signature" }, 401);

  const webhookId = req.headers.get("webhook-id")!;
  const payloadSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  const eventType = isRecord(verified) && typeof verified.type === "string" ? verified.type.slice(0, 128) : "unknown";
  const createdAt = isRecord(verified) && Number.isSafeInteger(verified.created_at) ? Number(verified.created_at) : 0;
  const receipt = await claimReceipt(webhookId, payloadSha256, eventType, createdAt);
  if (receipt.state === "conflict") return json({ error: "webhook id payload conflict" }, 409);
  if (receipt.state === "processed") return json({ ok: true, duplicate: true });
  if (receipt.state === "busy") return json({ error: "webhook is already processing" }, 503, { "Retry-After": "5" });

  let callId: string | null = null;
  try {
    if (!isRecord(verified) || verified.type !== "realtime.call.incoming") {
      await finishReceipt(webhookId, null);
      return json({ ok: true });
    }
    const event = incomingEvent(verified);
    if (!event) throw new Error("invalid realtime.call.incoming payload");
    const to = phoneFromSip(sipHeader(event, "To"));
    const from = phoneFromSip(sipHeader(event, "From"));
    if (!to || !from) throw new Error("SIP From/To headers must contain E.164 numbers");

    const agent = await qOne<{ id: string; org_id: string; version: number }>(
      "SELECT id, org_id, active_version AS version FROM agents WHERE phone_number = $1",
      [to]
    );
    if (!agent) {
      L.warn("xAI incoming call for unknown number");
      await finishReceipt(webhookId, null);
      return json({ ok: true });
    }
    const activeAgent = await loadActiveAgent(agent.id, agent.org_id);
    if (!activeAgent) throw new Error("agent version is unavailable");

    const call = await qOne<{ id: string }>(
      `INSERT INTO calls (agent_id, agent_version, direction, status, from_number, to_number, xai_call_id)
       VALUES ($1,$2,'inbound','active',$3,$4,$5)
       ON CONFLICT (xai_call_id) WHERE xai_call_id IS NOT NULL DO UPDATE SET xai_call_id = calls.xai_call_id
       WHERE calls.agent_id = EXCLUDED.agent_id AND calls.from_number = EXCLUDED.from_number
         AND calls.to_number = EXCLUDED.to_number AND calls.status = 'active'
       RETURNING id`,
      [agent.id, agent.version, from, to, event.data.call_id]
    );
    if (!call) throw new Error("xAI call identity conflicts with an existing call");
    callId = call.id;

    const spec = await voiceSessionSpecForCall(activeAgent, call.id, "inbound", requirePublicOrigin());
    if (spec.provider !== "xai") throw new Error("xAI SIP number is mapped to a non-xAI voice provider");
    const sessionUpdate = buildProviderSessionUpdate(spec, "pcmu");
    const attached = await attachControlSocket(event.data.call_id, call.id, sessionUpdate);
    waitUntil(attached.done);
    await finishReceipt(webhookId, call.id);
    return json({ ok: true });
  } catch {
    await failReceipt(webhookId);
    if (callId) {
      await q(
        "UPDATE calls SET status = 'failed', ended_at = COALESCE(ended_at, now()) WHERE id = $1 AND status = 'active'",
        [callId]
      ).catch(() => undefined);
    }
    L.error("xAI SIP webhook failed", {
      callId: callId ?? undefined,
      code: "sip_attachment_failed",
    });
    return json({ error: "xAI SIP attachment failed" }, 503, { "Retry-After": "5" });
  }
}

export const _xaiWebhookTest = { incomingEvent, phoneFromSip, verifyXaiWebhook };
