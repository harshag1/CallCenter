import { NextResponse } from "next/server";
import {
  issueBridgeCapabilityRotation,
  MAX_CAPABILITY_ROTATION,
} from "@/lib/capability-rotation";
import { rotateCapabilityLease } from "@/lib/capability-rotation-store";
import { PrivateRequestError, readStrictJsonObject } from "@/lib/private-json-request";
import { verifyScope } from "@/lib/voice";

const MAX_BODY_BYTES = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
const STREAM_SID = /^MZ[0-9a-fA-F]{32}$/;
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

type Connection = Readonly<{
  account_sid: string;
  call_sid: string;
  stream_sid: string;
  mode: "agent";
}>;

type RotationBody = Readonly<{
  schema_version: 1;
  session_id: string;
  bridge_instance_id: string;
  rotation: number;
  connection: Connection;
}>;

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function bearer(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.length > 4_096) return null;
  return authorization.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1] ?? null;
}

function parseBody(record: Record<string, unknown>): RotationBody | null {
  if (
    !exactKeys(record, ["schema_version", "session_id", "bridge_instance_id", "rotation", "connection"])
    || record.schema_version !== 1
    || typeof record.session_id !== "string" || !SAFE_ID.test(record.session_id)
    || typeof record.bridge_instance_id !== "string" || !SAFE_ID.test(record.bridge_instance_id)
    || !Number.isSafeInteger(record.rotation)
    || Number(record.rotation) < 1 || Number(record.rotation) > MAX_CAPABILITY_ROTATION
    || !record.connection || typeof record.connection !== "object" || Array.isArray(record.connection)
  ) return null;
  const connection = record.connection as Record<string, unknown>;
  if (
    !exactKeys(connection, ["account_sid", "call_sid", "stream_sid", "mode"])
    || typeof connection.account_sid !== "string" || !ACCOUNT_SID.test(connection.account_sid)
    || typeof connection.call_sid !== "string" || !CALL_SID.test(connection.call_sid)
    || typeof connection.stream_sid !== "string" || !STREAM_SID.test(connection.stream_sid)
    || connection.mode !== "agent"
  ) return null;
  return {
    schema_version: 1,
    session_id: record.session_id,
    bridge_instance_id: record.bridge_instance_id,
    rotation: Number(record.rotation),
    connection: {
      account_sid: connection.account_sid,
      call_sid: connection.call_sid,
      stream_sid: connection.stream_sid,
      mode: "agent",
    },
  };
}

export async function POST(request: Request) {
  const token = bearer(request);
  if (!token) return json({ error: "invalid capability" }, 401);
  let parsed: RotationBody | null;
  try {
    parsed = parseBody(await readStrictJsonObject(request, MAX_BODY_BYTES));
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    const label = status === 413
      ? "request too large"
      : status === 415
        ? "unsupported media type"
        : "invalid request";
    return json({ error: label }, status);
  }
  if (!parsed) return json({ error: "invalid request" }, 400);
  const scope = verifyScope(token, {
    audience: "bridge_refresh",
    purpose: "capability_rotation",
    method: "POST",
    provider: ["xai", "openai"],
    providerCallId: parsed.connection.call_sid,
    providerAccountId: parsed.connection.account_sid,
    providerStreamId: parsed.connection.stream_sid,
    transportProvider: "twilio",
  });
  if (!scope?.providerTo) return json({ error: "invalid capability" }, 401);
  const idempotencyKey = `${parsed.session_id}:${parsed.rotation}`;
  if (request.headers.get("idempotency-key") !== idempotencyKey) {
    return json({ error: "idempotency binding mismatch" }, 400);
  }

  try {
    const rotated = await rotateCapabilityLease({
      transport: "telephony",
      scope,
      sessionId: parsed.session_id,
      bridgeInstanceId: parsed.bridge_instance_id,
      streamSid: parsed.connection.stream_sid,
      requestedGeneration: parsed.rotation,
      idempotencyKey,
      nowEpoch: Math.floor(Date.now() / 1_000),
    });
    switch (rotated.status) {
      case "not_found": return json({ error: "active bridge session not found" }, 404);
      case "too_early": return json({ error: "capability rotation is not due" }, 425);
      case "expired": return json({ error: "capability expired" }, 401);
      case "conflict": return json({ error: "capability rotation conflict" }, 409);
      case "rotated":
      case "replayed":
        break;
    }
    const bundle = issueBridgeCapabilityRotation(
      {
        callId: scope.callId,
        agentId: scope.agentId,
        orgId: scope.orgId,
        provider: rotated.lease.provider,
        sessionId: parsed.session_id,
        bridgeInstanceId: parsed.bridge_instance_id,
        accountSid: parsed.connection.account_sid,
        callSid: parsed.connection.call_sid,
        to: scope.providerTo,
        streamSid: parsed.connection.stream_sid,
      },
      rotated.lease.rotation_root_jti,
      rotated.lease.generation,
      rotated.lease.issued_at,
    );
    return json(bundle, 200);
  } catch {
    return json({ error: "capability rotation unavailable" }, 503);
  }
}
