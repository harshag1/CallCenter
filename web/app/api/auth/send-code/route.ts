// Author: Harsha Gundala
// send-code — emails a 6-digit OTP; codes are HMAC'd at rest, 10-minute expiry.

import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import {
  anonymousAuthAbuseSourceHmac,
  AUTH_NO_STORE_HEADERS,
  AuthRequestInputError,
  generateCode,
  hasExactKeys,
  hmacCode,
  issueEmailVerificationCode,
  normalizeEmailAddress,
  readAuthJsonObject,
} from "@/lib/auth";
import { sendLoginCode } from "@/lib/email";
import { log } from "@/lib/log";

const L = log("auth/send-code");

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: AUTH_NO_STORE_HEADERS });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readAuthJsonObject(req);
  } catch (error) {
    const status = error instanceof AuthRequestInputError ? error.status : 400;
    return json({ error: "invalid request" }, status);
  }
  if (!hasExactKeys(body, ["email"])) {
    return json({ error: "invalid email" }, 400);
  }
  const clean = normalizeEmailAddress(body.email);
  if (!clean) return json({ error: "invalid email" }, 400);

  // Anonymous funded delivery is unavailable unless a trusted edge provided a
  // non-spoofable client identity for the durable per-source abuse budget.
  const requestSourceHmac = anonymousAuthAbuseSourceHmac(req);
  if (!requestSourceHmac) {
    return json({ error: "too many codes requested — wait a few minutes" }, 429);
  }
  const code = generateCode();
  const issuedId = await issueEmailVerificationCode(
    clean,
    hmacCode(code, clean),
    requestSourceHmac,
  );
  if (!issuedId) {
    return json({ error: "too many codes requested — wait a few minutes" }, 429);
  }
  try {
    // The durable auth_codes UUID is also the provider replay key. If this
    // delivery is retried after an ambiguous response, Resend cannot fan it
    // out into a second email.
    await sendLoginCode(clean, code, issuedId);
  } catch (e) {
    await q("UPDATE auth_codes SET used = true WHERE id = $1", [issuedId]).catch(() => {});
    L.error("send failed", { kind: e instanceof Error ? e.name : "unknown" });
    return json({ error: "could not send email" }, 502);
  }
  return json({ ok: true });
}
