import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  issueBrowserCapabilityRotation,
  MAX_CAPABILITY_ROTATION,
} from "@/lib/capability-rotation";
import { rotateCapabilityLease } from "@/lib/capability-rotation-store";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";
import { verifyScope } from "@/lib/voice";

const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RotationBody = Readonly<{
  schema_version: 1;
  call_id: string;
  rotation: number;
}>;

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
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
    !exactKeys(record, ["schema_version", "call_id", "rotation"])
    || record.schema_version !== 1
    || typeof record.call_id !== "string" || !UUID.test(record.call_id)
    || !Number.isSafeInteger(record.rotation)
    || Number(record.rotation) < 1 || Number(record.rotation) > MAX_CAPABILITY_ROTATION
  ) return null;
  return {
    schema_version: 1,
    call_id: record.call_id,
    rotation: Number(record.rotation),
  };
}

export async function POST(request: Request) {
  let parsed: RotationBody | null;
  try {
    assertSameOriginBrowserMutation(request);
    parsed = parseBody(await readPrivateJsonObject(request, MAX_BODY_BYTES));
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    const label = status === 403
      ? "forbidden"
      : status === 413
        ? "request too large"
        : status === 415
          ? "unsupported media type"
          : "invalid request";
    return json({ error: label }, status);
  }
  if (!parsed) return json({ error: "invalid request" }, 400);
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const token = bearer(request);
  if (!token) return json({ error: "invalid capability" }, 401);
  const scope = verifyScope(token, {
    audience: "browser_refresh",
    purpose: "capability_rotation",
    method: "POST",
    provider: ["xai", "openai", "gemini"],
    callId: parsed.call_id,
    orgId: session.orgId,
  });
  if (!scope) return json({ error: "invalid capability" }, 401);
  const idempotencyKey = `${parsed.call_id}:${parsed.rotation}`;
  if (request.headers.get("idempotency-key") !== idempotencyKey) {
    return json({ error: "idempotency binding mismatch" }, 400);
  }

  try {
    const rotated = await rotateCapabilityLease({
      transport: "browser",
      scope,
      sessionId: parsed.call_id,
      requestedGeneration: parsed.rotation,
      idempotencyKey,
      nowEpoch: Math.floor(Date.now() / 1_000),
    });
    switch (rotated.status) {
      case "not_found": return json({ error: "active call not found" }, 404);
      case "too_early": return json({ error: "capability rotation is not due" }, 425);
      case "expired": return json({ error: "capability expired" }, 401);
      case "conflict": return json({ error: "capability rotation conflict" }, 409);
      case "rotated":
      case "replayed":
        break;
    }
    const bundle = issueBrowserCapabilityRotation(
      {
        callId: scope.callId,
        agentId: scope.agentId,
        orgId: scope.orgId,
        provider: rotated.lease.provider,
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
