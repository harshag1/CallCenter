// Author: Harsha Gundala
// send-phone-code — sends a phone verification code after email verification.

import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import {
  AUTH_NO_STORE_HEADERS,
  AuthRequestInputError,
  getSession,
  hasExactKeys,
  issuePhoneVerificationMarker,
  normalizePhoneNumber,
  readAuthJsonObject,
} from "@/lib/auth";
import { startPhoneVerification } from "@/lib/sms";
import { log } from "@/lib/log";
import {
  assertSameOriginBrowserMutation,
  PrivateRequestError,
} from "@/lib/private-json-request";

const L = log("auth/send-phone-code");

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: AUTH_NO_STORE_HEADERS });
}

export async function POST(req: Request) {
  try {
    assertSameOriginBrowserMutation(req);
  } catch (error) {
    return json({ error: "forbidden" }, error instanceof PrivateRequestError ? error.status : 403);
  }
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await readAuthJsonObject(req);
  } catch (error) {
    const status = error instanceof AuthRequestInputError ? error.status : 400;
    return json({ error: "invalid request" }, status);
  }
  if (!hasExactKeys(body, ["phone"])) {
    return json({ error: "invalid request" }, 400);
  }
  const clean = normalizePhoneNumber(String(body.phone ?? ""));
  if (!clean) return json({ error: "enter a valid phone number" }, 400);

  const markerId = await issuePhoneVerificationMarker(clean);
  if (!markerId) {
    return json({ error: "too many codes requested — wait a few minutes" }, 429);
  }

  try {
    await startPhoneVerification(clean);
  } catch (e) {
    await q("UPDATE phone_codes SET used = true WHERE id = $1", [markerId]).catch(() => {});
    L.error("send failed", { orgId: session.orgId, kind: e instanceof Error ? e.name : "unknown" });
    return json({ error: "could not send text message" }, 502);
  }
  // Do not mutate staged account state until the provider confirms dispatch.
  await q(
    "UPDATE users SET phone_number = $2, phone_verified_at = CASE WHEN phone_number = $2 THEN phone_verified_at ELSE NULL END WHERE email = $1",
    [session.email, clean]
  );
  return json({ ok: true });
}
