// Author: Harsha Gundala
// calls/[id]/events — transcript/tool event ingestion from the call widget + polling reads.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { isUuid } from "@/lib/http";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";
import {
  browserOutboundSpeechGateRejection,
  sanitizeBrowserOutboundSpeechGateEvidence,
  sanitizeBrowserOutboundSpeechGateRejection,
} from "@/lib/realtime/browser-outbound-speech-evidence";

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

async function ownsCall(callId: string, orgId: string) {
  if (!isUuid(callId)) return null;
  return qOne(
    "SELECT c.id FROM calls c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1 AND a.org_id = $2",
    [callId, orgId]
  );
}

type BrowserProvider = "openai" | "xai" | "gemini";
type SanitizedBrowserEvent = Readonly<{ type: string; payload: Record<string, unknown> }>;

const BROWSER_PROVIDERS = new Set<BrowserProvider>(["openai", "xai", "gemini"]);
const PERSISTENCE_STAGES = new Set(["events", "recording", "call_end"]);
const PERSISTENCE_REASONS = new Set(["timeout", "deadline_exhausted", "request_failed", "http_error"]);

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maximumCharacters: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximumCharacters
    ? value
    : null;
}

function provider(value: unknown): BrowserProvider | null {
  return typeof value === "string" && BROWSER_PROVIDERS.has(value as BrowserProvider)
    ? value as BrowserProvider
    : null;
}

/**
 * Reconstruct, rather than copy, every browser-journal payload. In particular, raw error
 * messages must never become durable because providers can echo PII or bearer credentials.
 */
function sanitizeBrowserEvent(value: unknown): SanitizedBrowserEvent | null {
  const event = record(value);
  if (!event || typeof event.type !== "string") return null;
  const payload = record(event.payload);
  if (!payload) return null;

  if (event.type === "user_said" || event.type === "agent_said") {
    const text = boundedString(payload.text, 32_000);
    return text ? { type: event.type, payload: { text } } : null;
  }

  if (event.type === "error") {
    const source = provider(payload.provider);
    if (!source || payload.code !== "provider_runtime_error") return null;
    return {
      type: "error",
      payload: { code: "provider_runtime_error", provider: source },
    };
  }

  if (event.type === "state") {
    const state = payload.state;
    const source = provider(payload.provider);
    if (!source) return null;
    if (state === "connected") {
      const model = boundedString(payload.model, 256);
      return model ? { type: "state", payload: { state, provider: source, model } } : null;
    }
    if (state === "provider_closed") {
      return { type: "state", payload: { state, provider: source } };
    }
    if (state === "session_limit" && source === "gemini" && payload.limitMinutes === 15) {
      return { type: "state", payload: { state, provider: source, limitMinutes: 15 } };
    }
    return null;
  }

  if (event.type === "recording_discarded" && payload.reason === "browser_size_limit") {
    return { type: "recording_discarded", payload: { reason: "browser_size_limit" } };
  }

  if (event.type === "recording_upload_failed") {
    const status = payload.status;
    return Number.isInteger(status) && Number(status) >= 0 && Number(status) <= 599
      ? { type: "recording_upload_failed", payload: { status } }
      : null;
  }

  if (event.type === "client_event_overflow") {
    const dropped = payload.dropped;
    return Number.isSafeInteger(dropped) && Number(dropped) > 0
      ? { type: "client_event_overflow", payload: { dropped } }
      : null;
  }

  if (event.type === "client_persistence_loss") {
    const stage = payload.stage;
    const reason = payload.reason;
    const pendingEvents = payload.pendingEvents;
    if (typeof stage !== "string" || !PERSISTENCE_STAGES.has(stage)
      || typeof reason !== "string" || !PERSISTENCE_REASONS.has(reason)
      || !Number.isInteger(pendingEvents) || Number(pendingEvents) < 0 || Number(pendingEvents) > 500) {
      return null;
    }
    return { type: "client_persistence_loss", payload: { stage, reason, pendingEvents } };
  }

  if (event.type === "outbound_speech_gate") {
    const evidence = sanitizeBrowserOutboundSpeechGateEvidence(payload);
    return evidence
      ? { type: "outbound_speech_gate", payload: evidence }
      : {
        type: "outbound_speech_gate_rejected",
        payload: browserOutboundSpeechGateRejection("server_validation"),
      };
  }

  if (event.type === "outbound_speech_gate_rejected") {
    const rejection = sanitizeBrowserOutboundSpeechGateRejection(payload);
    return rejection ? { type: "outbound_speech_gate_rejected", payload: rejection } : null;
  }

  return null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let body: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    body = await readPrivateJsonObject(req, 256 * 1024);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return json({ error: status === 403 ? "forbidden" : "invalid request" }, status);
  }
  if (Object.keys(body).length !== 1 || !Array.isArray(body.events)) {
    return json({ error: "events array required" }, 400);
  }
  if (body.events.length > 50) return json({ error: "invalid events" }, 400);
  const events = body.events.map(sanitizeBrowserEvent);
  if (events.some((event) => event === null)) return json({ error: "invalid events" }, 400);
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!(await ownsCall(id, session.orgId))) return json({ error: "not found" }, 404);
  for (const event of events as SanitizedBrowserEvent[]) {
    await q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,$2,$3)", [
      id, event.type, JSON.stringify(event.payload),
    ]);
  }
  return json({ ok: true });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!(await ownsCall(id, session.orgId))) return json({ error: "not found" }, 404);
  const after = Math.min(Math.max(Number(new URL(req.url).searchParams.get("after") ?? 0) || 0, 0), Number.MAX_SAFE_INTEGER);
  const events = await q(
    "SELECT id, ts, type, payload FROM call_events WHERE call_id = $1 AND id > $2 ORDER BY id LIMIT 300",
    [id, after]
  );
  return json({ events });
}
