// Author: Harsha Gundala
// verify-phone-code — verifies phone ownership and completes staged onboarding.

import { NextResponse } from "next/server";
import { getSession, hmacCode, normalizePhoneNumber } from "@/lib/auth";
import { q, qOne } from "@/lib/db";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { phone, code } = await req.json().catch(() => ({}));
  const clean = normalizePhoneNumber(String(phone ?? ""));
  if (!clean) return NextResponse.json({ error: "enter a valid phone number" }, { status: 400 });

  const row = await qOne<{ id: string; attempts: number }>(
    `SELECT id, attempts FROM phone_codes
     WHERE phone_number = $1 AND used = false AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [clean]
  );
  if (!row || row.attempts >= 5) {
    return NextResponse.json({ error: "code expired — request a new one" }, { status: 401 });
  }

  const matches = await qOne("SELECT id FROM phone_codes WHERE id = $1 AND code_hmac = $2", [
    row.id,
    hmacCode(String(code ?? "")),
  ]);
  if (!matches) {
    await q("UPDATE phone_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    return NextResponse.json({ error: "wrong code" }, { status: 401 });
  }

  await q("UPDATE phone_codes SET used = true WHERE id = $1", [row.id]);
  await q("UPDATE users SET phone_number = $2, phone_verified_at = now() WHERE email = $1", [session.email, clean]);

  const hasAgents = await qOne("SELECT id FROM agents WHERE org_id = $1 LIMIT 1", [session.orgId]);
  return NextResponse.json({ ok: true, next: hasAgents ? "/workspace" : "/onboarding" });
}
