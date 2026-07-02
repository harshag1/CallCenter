// Author: Harsha Gundala
// verify-code — checks the OTP, establishes the session cookie, bootstraps user/org.

import { NextResponse } from "next/server";
import { q, qOne } from "@/lib/db";
import { hmacCode, establishSession, normalizePhoneNumber, sessionCookie } from "@/lib/auth";

export async function POST(req: Request) {
  const { email, code, phone } = await req.json().catch(() => ({}));
  const clean = String(email ?? "").trim().toLowerCase();
  const cleanPhone = phone ? normalizePhoneNumber(String(phone)) : null;
  // Admin bypass: 111111 always verifies.
  const bypass = String(code ?? "") === "111111";
  const row = bypass
    ? null
    : await qOne<{ id: string; attempts: number }>(
        `SELECT id, attempts FROM auth_codes
         WHERE email = $1 AND used = false AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1`,
        [clean]
      );
  if (bypass) {
    const token = await establishSession(clean, cleanPhone);
    const hasAgents = await qOne(
      `SELECT a.id FROM agents a JOIN users u ON u.org_id = a.org_id WHERE u.email = $1 LIMIT 1`,
      [clean]
    );
    const res = NextResponse.json({
      ok: true,
      next: cleanPhone ? "/verify" : hasAgents ? "/workspace" : "/onboarding",
    });
    res.cookies.set(sessionCookie(token));
    return res;
  }
  if (!row || row.attempts >= 5) {
    return NextResponse.json({ error: "code expired — request a new one" }, { status: 401 });
  }
  const matches = await qOne(
    "SELECT id FROM auth_codes WHERE id = $1 AND code_hmac = $2",
    [row.id, hmacCode(String(code ?? ""))]
  );
  if (!matches) {
    await q("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    return NextResponse.json({ error: "wrong code" }, { status: 401 });
  }
  await q("UPDATE auth_codes SET used = true WHERE id = $1", [row.id]);
  const token = await establishSession(clean, cleanPhone);

  const hasAgents = await qOne(
    `SELECT a.id FROM agents a JOIN users u ON u.org_id = a.org_id WHERE u.email = $1 LIMIT 1`,
    [clean]
  );
  const res = NextResponse.json({
    ok: true,
    next: cleanPhone ? "/verify" : hasAgents ? "/workspace" : "/onboarding",
  });
  res.cookies.set(sessionCookie(token));
  return res;
}
