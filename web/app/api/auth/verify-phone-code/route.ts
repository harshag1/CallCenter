// Author: Harsha Gundala
// verify-phone-code — verifies phone ownership and completes staged onboarding.

import { NextResponse } from "next/server";
import {
  AUTH_NO_STORE_HEADERS,
  AuthRequestInputError,
  getSession,
  hasExactKeys,
  normalizePhoneNumber,
  readAuthJsonObject,
  reservePhoneVerificationAttempt,
} from "@/lib/auth";
import { checkPhoneVerification } from "@/lib/sms";
import { qOne } from "@/lib/db";
import {
  assertSameOriginBrowserMutation,
  PrivateRequestError,
} from "@/lib/private-json-request";

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
  if (!hasExactKeys(body, ["phone", "code"])) {
    return json({ error: "invalid request" }, 400);
  }
  const clean = normalizePhoneNumber(String(body.phone ?? ""));
  if (!clean) return json({ error: "enter a valid phone number" }, 400);
  if (typeof body.code !== "string" || !/^\d{4,10}$/.test(body.code)) {
    return json({ error: "wrong code" }, 401);
  }

  const attemptId = await reservePhoneVerificationAttempt(clean);
  if (!attemptId) return json({ error: "wrong code" }, 401);

  const approved = await checkPhoneVerification(clean, body.code).catch(() => false);
  if (!approved) {
    return json({ error: "wrong code" }, 401);
  }
  const consumed = await qOne<{ id: string }>(
     `WITH target_user AS MATERIALIZED (
       SELECT u.email
       FROM users u
       JOIN sessions_auth s
         ON s.email = u.email
        AND s.org_id = u.org_id
       WHERE u.email = $2
         AND u.org_id = $5
         AND u.phone_number = $3
         AND s.token = $4
         AND s.token_hash_version = 1
         AND s.is_active
         AND s.expires_at > statement_timestamp()
         AND s.last_used_at > statement_timestamp() - interval '7 days'
         AND s.last_used_at <= statement_timestamp() + interval '5 minutes'
       FOR UPDATE OF u, s
     ), consumed AS (
       UPDATE phone_codes p
       SET used = true
       WHERE p.id = $1
         AND p.phone_number = $3
         AND p.code_hmac = 'twilio-verify'
         AND p.used = false
         AND p.expires_at > statement_timestamp()
         AND EXISTS (SELECT 1 FROM target_user)
       RETURNING p.id, p.phone_number
     ), invalidated AS (
       UPDATE phone_codes p
       SET used = true
       FROM consumed c
       WHERE p.phone_number = c.phone_number
         AND p.id <> c.id
         AND p.used = false
       RETURNING 1
     ), updated AS (
       UPDATE users u
       SET phone_number = $3, phone_verified_at = now()
       FROM consumed c
       WHERE u.email = $2
         AND u.org_id = $5
         AND EXISTS (SELECT 1 FROM target_user)
       RETURNING u.email
     )
     SELECT c.id FROM consumed c WHERE EXISTS (SELECT 1 FROM updated)`,
    [
      attemptId,
      session.email,
      clean,
      session.authSessionTokenHash,
      session.orgId,
    ]
  );
  if (!consumed) return json({ error: "wrong code" }, 401);

  return json({ ok: true, next: "/studio" });
}
