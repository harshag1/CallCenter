// Author: Harsha Gundala
// telephony/events — authenticated, hash-bound, idempotent bridge event journal ingress.

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { qOne } from "@/lib/db";
import { verifyScope } from "@/lib/voice";
import { analyzeCall } from "@/lib/analysis";
import {
  PrivateRequestError,
  readStrictJsonObject,
} from "@/lib/private-json-request";

const MAX_BODY_BYTES = 600 * 1024;
const MAX_EVENTS = 50;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_PATTERN = /^MZ[0-9a-fA-F]{32}$/;
const BATCH_ID_PATTERN = /^event_batch_[0-9a-f]{64}$/;
const TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JournalEvent = {
  session_id: string;
  sequence: number;
  type: string;
  payload: Json;
  content_sha256: string;
};
type JournalBatch = {
  schema_version: 1;
  session_id: string;
  session_sha256: string;
  first_sequence: number | null;
  last_sequence: number | null;
  events: JournalEvent[];
  complete: boolean;
  batch_id: string;
  batch_sha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalJson(value: unknown, depth = 0, budget = { nodes: 0 }): string {
  budget.nodes += 1;
  if (depth > 32 || budget.nodes > 20_000) throw new Error("JSON structure limit exceeded");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") throw new Error("non-JSON value");
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1, budget)).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1, budget)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bearer(req: Request): string | null {
  const authorization = req.headers.get("authorization") ?? "";
  if (authorization.length > 4_096) return null;
  return authorization.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1] ?? null;
}

function parseBatch(candidate: unknown, idempotencyKey: string | null): JournalBatch | null {
  if (!isRecord(candidate) || !exactKeys(candidate, [
    "schema_version", "session_id", "session_sha256", "first_sequence", "last_sequence",
    "events", "complete", "batch_id", "batch_sha256",
  ])) return null;
  if (
    candidate.schema_version !== 1 || typeof candidate.session_id !== "string" ||
    !SESSION_PATTERN.test(candidate.session_id) ||
    candidate.session_sha256 !== sha256(candidate.session_id) ||
    typeof candidate.complete !== "boolean" || !Array.isArray(candidate.events) ||
    typeof candidate.batch_id !== "string" || !BATCH_ID_PATTERN.test(candidate.batch_id) ||
    typeof candidate.batch_sha256 !== "string" || !SHA256_PATTERN.test(candidate.batch_sha256) ||
    idempotencyKey !== candidate.batch_id
  ) return null;

  const events: JournalEvent[] = [];
  if (candidate.events.length > MAX_EVENTS) return null;
  for (const item of candidate.events) {
    if (!isRecord(item) || !exactKeys(item, ["session_id", "sequence", "type", "payload", "content_sha256"])) return null;
    if (
      item.session_id !== candidate.session_id || !Number.isSafeInteger(item.sequence) ||
      Number(item.sequence) < 1 || typeof item.type !== "string" || !TYPE_PATTERN.test(item.type) ||
      typeof item.content_sha256 !== "string" || !SHA256_PATTERN.test(item.content_sha256)
    ) return null;
    let expectedContent: string;
    try {
      expectedContent = sha256(canonicalJson({
        session_id: item.session_id,
        sequence: item.sequence,
        type: item.type,
        payload: item.payload,
      }));
    } catch {
      return null;
    }
    if (item.content_sha256 !== expectedContent) return null;
    events.push(item as JournalEvent);
  }

  if (candidate.complete) {
    if (events.length !== 0 || candidate.first_sequence !== null || candidate.last_sequence !== null) return null;
  } else {
    if (
      events.length < 1 || !Number.isSafeInteger(candidate.first_sequence) ||
      !Number.isSafeInteger(candidate.last_sequence) ||
      Number(candidate.first_sequence) < 1 ||
      Number(candidate.last_sequence) - Number(candidate.first_sequence) + 1 !== events.length
    ) return null;
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].sequence !== Number(candidate.first_sequence) + index) return null;
    }
  }

  const unsigned = {
    schema_version: 1,
    session_id: candidate.session_id,
    session_sha256: candidate.session_sha256,
    first_sequence: candidate.first_sequence,
    last_sequence: candidate.last_sequence,
    events,
    complete: candidate.complete,
  };
  let batchSha256: string;
  try {
    batchSha256 = sha256(canonicalJson(unsigned));
  } catch {
    return null;
  }
  if (candidate.batch_sha256 !== batchSha256 || candidate.batch_id !== `event_batch_${batchSha256}`) return null;
  return { ...unsigned, batch_id: candidate.batch_id, batch_sha256: candidate.batch_sha256 } as JournalBatch;
}

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function POST(req: Request) {
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return response({ error: "Content-Type must be application/json" }, 415);
  }
  const token = bearer(req);
  const scope = token ? verifyScope(token, {
    audience: "telephony_events",
    purpose: "event_journal",
    method: "POST",
    provider: "twilio",
  }) : null;
  if (!scope) return response({ error: "invalid scope" }, 401);

  let candidate: Record<string, unknown>;
  try {
    candidate = await readStrictJsonObject(req, MAX_BODY_BYTES);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return response({
      error: status === 413
        ? "invalid or oversized body"
        : status === 415
          ? "Content-Type must be application/json"
          : "invalid JSON",
    }, status);
  }
  const batch = parseBatch(candidate, req.headers.get("idempotency-key"));
  if (!batch || batch.session_id !== scope.providerStreamId) {
    return response({ error: "invalid event batch" }, 400);
  }

  const journal = await qOne<{
    identity_bound: boolean;
    authority_active: boolean;
    exact_replay: boolean;
    conflict: boolean;
    closed: boolean;
  }>(
    `WITH identity_binding AS MATERIALIZED (
       SELECT s.mode, s.stopped_at, c.status
       FROM telephony_stream_bindings s
       JOIN calls c ON c.id = s.call_id
       JOIN agents a ON a.id = c.agent_id
       WHERE s.stream_sid = $2 AND s.call_id = $1 AND s.provider = 'twilio'
         AND s.provider_call_sid = $10 AND s.provider_account_sid = $11 AND s.to_number = $12
         AND c.agent_id = $13 AND a.org_id = $14
         AND c.twilio_call_sid = $10 AND c.twilio_account_sid = $11
         AND c.to_number = $12
       FOR UPDATE OF s, c
     ),
     live_binding AS (
       SELECT mode FROM identity_binding
       WHERE stopped_at IS NULL AND status IN ('active','dialing')
     ),
     incoming AS (
       SELECT
         (event->>'sequence')::bigint AS sequence,
         event->>'type' AS type,
         event->'payload' AS payload,
         event->>'content_sha256' AS content_sha256
       FROM jsonb_array_elements($3::jsonb) AS event
     ),
     event_conflicts AS (
       SELECT 1 FROM incoming i
       JOIN call_events e
         ON e.call_id = $1 AND e.source = 'bridge' AND e.source_session_id = $2
        AND e.source_sequence = i.sequence
       WHERE EXISTS (SELECT 1 FROM identity_binding)
         AND (e.type <> i.type OR e.payload <> i.payload
          OR e.source_content_sha256 IS DISTINCT FROM i.content_sha256)
       LIMIT 1
     ),
     existing_batch AS (
       SELECT * FROM telephony_event_batches
       WHERE call_id = $1 AND session_id = $2 AND batch_id = $4
         AND EXISTS (SELECT 1 FROM identity_binding)
     ),
     exact_existing_batch AS (
       SELECT 1 FROM existing_batch
       WHERE batch_sha256 = $5 AND first_sequence IS NOT DISTINCT FROM $6::bigint
         AND last_sequence IS NOT DISTINCT FROM $7::bigint AND event_count = $8
         AND complete = $9
     ),
     batch_conflicts AS (
       SELECT 1 FROM existing_batch
       WHERE batch_sha256 <> $5 OR first_sequence IS DISTINCT FROM $6::bigint
          OR last_sequence IS DISTINCT FROM $7::bigint OR event_count <> $8
          OR complete <> $9
       LIMIT 1
     ),
     inserted_events AS (
       INSERT INTO call_events (
         call_id, type, payload, source, source_session_id, source_sequence, source_content_sha256
       )
       SELECT $1, i.type, i.payload, 'bridge', $2, i.sequence, i.content_sha256
       FROM incoming i
       WHERE EXISTS (SELECT 1 FROM live_binding)
         AND NOT EXISTS (SELECT 1 FROM event_conflicts)
         AND NOT EXISTS (SELECT 1 FROM batch_conflicts)
       ON CONFLICT (call_id, source, source_session_id, source_sequence)
         WHERE source IS NOT NULL AND source_session_id IS NOT NULL AND source_sequence IS NOT NULL
       DO UPDATE SET source_content_sha256 = call_events.source_content_sha256
       WHERE call_events.type = EXCLUDED.type
         AND call_events.payload = EXCLUDED.payload
         AND call_events.source_content_sha256 = EXCLUDED.source_content_sha256
       RETURNING id
     ),
     inserted_batch AS (
       INSERT INTO telephony_event_batches (
         call_id, session_id, batch_id, batch_sha256, first_sequence, last_sequence, event_count, complete
       )
       SELECT $1, $2, $4, $5, $6, $7, $8, $9
       WHERE EXISTS (SELECT 1 FROM live_binding)
         AND NOT EXISTS (SELECT 1 FROM event_conflicts)
         AND NOT EXISTS (SELECT 1 FROM batch_conflicts)
         AND (SELECT count(*) FROM inserted_events) = $8
       ON CONFLICT (call_id, session_id, batch_id) DO UPDATE
         SET batch_sha256 = telephony_event_batches.batch_sha256
       WHERE telephony_event_batches.batch_sha256 = EXCLUDED.batch_sha256
         AND telephony_event_batches.first_sequence IS NOT DISTINCT FROM EXCLUDED.first_sequence
         AND telephony_event_batches.last_sequence IS NOT DISTINCT FROM EXCLUDED.last_sequence
         AND telephony_event_batches.event_count = EXCLUDED.event_count
         AND telephony_event_batches.complete = EXCLUDED.complete
       RETURNING batch_id
     ),
     stopped_binding AS (
       UPDATE telephony_stream_bindings
       SET stopped_at = COALESCE(stopped_at, now())
       WHERE $9 AND stream_sid = $2
         AND EXISTS (SELECT 1 FROM inserted_batch)
         AND EXISTS (SELECT 1 FROM live_binding)
       RETURNING stream_sid
     ),
     closed_call AS (
       UPDATE calls
       SET status = 'completed', ended_at = COALESCE(ended_at, now()),
           duration_s = COALESCE(duration_s, EXTRACT(EPOCH FROM (now() - started_at))::int)
       WHERE $9 AND id = $1 AND status IN ('active','dialing')
         AND EXISTS (SELECT 1 FROM inserted_batch)
         AND EXISTS (SELECT 1 FROM live_binding WHERE mode = 'agent')
       RETURNING id
     )
     SELECT EXISTS (SELECT 1 FROM identity_binding) AS identity_bound,
            EXISTS (SELECT 1 FROM live_binding) AS authority_active,
            EXISTS (SELECT 1 FROM exact_existing_batch) AS exact_replay,
            EXISTS (SELECT 1 FROM event_conflicts)
              OR EXISTS (SELECT 1 FROM batch_conflicts)
              OR (
                EXISTS (SELECT 1 FROM live_binding)
                AND ((SELECT count(*) FROM inserted_events) <> $8
                  OR (SELECT count(*) FROM inserted_batch) <> 1)
              ) AS conflict,
            EXISTS (SELECT 1 FROM closed_call) AS closed,
            EXISTS (SELECT 1 FROM stopped_binding) AS stopped`,
    [
      scope.callId,
      batch.session_id,
      JSON.stringify(batch.events),
      batch.batch_id,
      batch.batch_sha256,
      batch.first_sequence,
      batch.last_sequence,
      batch.events.length,
      batch.complete,
      scope.providerCallId,
      scope.providerAccountId,
      scope.providerTo,
      scope.agentId,
      scope.orgId,
    ]
  );
  if (!journal?.identity_bound) return response({ error: "stream binding not found" }, 403);
  if (journal.conflict) return response({ error: "idempotency conflict" }, 409);
  if (!journal.authority_active && !journal.exact_replay) {
    return response({ error: "stream authority is no longer active" }, 403);
  }
  if (journal.closed) waitUntil(analyzeCall(scope.callId).catch(() => undefined));
  return response({ ok: true, batch_id: batch.batch_id });
}

export const _journalTest = { canonicalJson, parseBatch, sha256 };
