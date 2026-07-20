// Author: Harsha Gundala
// verify-code — checks the OTP, establishes the session cookie, bootstraps user/org.

import { NextResponse } from "next/server";
import { qOne } from "@/lib/db";
import {
  AUTH_NO_STORE_HEADERS,
  AuthRequestInputError,
  hasExactKeys,
  hmacCode,
  normalizeEmailAddress,
  normalizePhoneNumber,
  readAuthJsonObject,
  revokePresentedSessions,
  sessionCookie,
  staleSessionCookieDeletions,
  verifyEmailCodeAndEstablishSession,
} from "@/lib/auth";

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
  if (!hasExactKeys(body, ["email", "code"], ["phone"])) {
    return json({ error: "invalid request" }, 400);
  }
  const clean = normalizeEmailAddress(body.email);
  if (!clean) {
    return json({ error: "invalid email" }, 400);
  }
  if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
    return json({ error: "wrong code" }, 401);
  }
  const cleanPhone = body.phone === undefined || body.phone === null || body.phone === ""
    ? null
    : normalizePhoneNumber(String(body.phone));
  if (body.phone !== undefined && body.phone !== null && body.phone !== "" && !cleanPhone) {
    return json({ error: "invalid phone" }, 400);
  }
  const token = await verifyEmailCodeAndEstablishSession({
    email: clean,
    codeHmac: hmacCode(body.code, clean),
    phoneNumber: cleanPhone,
  });
  if (!token) {
    return json({ error: "wrong code" }, 401);
  }
  // Rotate away every valid-shaped bearer supplied under current, development,
  // or legacy names. There is intentionally no legacy authentication fallback.
  await revokePresentedSessions(req.headers.get("cookie"));

  const hasAgents = await qOne(
    `SELECT a.id FROM agents a JOIN users u ON u.org_id = a.org_id WHERE u.email = $1 LIMIT 1`,
    [clean]
  );
  const res = NextResponse.json({
    ok: true,
    next: cleanPhone ? "/verify" : hasAgents ? "/workspace" : "/onboarding",
  }, { headers: AUTH_NO_STORE_HEADERS });
  for (const deletion of staleSessionCookieDeletions()) {
    res.cookies.set(deletion);
  }
  res.cookies.set(sessionCookie(token));
  return res;
}
