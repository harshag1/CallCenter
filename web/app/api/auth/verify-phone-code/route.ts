// Author: Harsha Gundala
// verify-phone-code — verifies phone ownership and completes staged onboarding.

import { NextResponse } from "next/server";
import { getSession, normalizePhoneNumber } from "@/lib/auth";
import { checkPhoneVerification } from "@/lib/sms";
import { q, qOne } from "@/lib/db";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { phone, code } = await req.json().catch(() => ({}));
  const clean = normalizePhoneNumber(String(phone ?? ""));
  if (!clean) return NextResponse.json({ error: "enter a valid phone number" }, { status: 400 });

  const approved = await checkPhoneVerification(clean, String(code ?? "")).catch(() => false);
  if (!approved) {
    return NextResponse.json({ error: "wrong code" }, { status: 401 });
  }
  await q("UPDATE phone_codes SET used = true WHERE phone_number = $1 AND used = false", [clean]);
  await q("UPDATE users SET phone_number = $2, phone_verified_at = now() WHERE email = $1", [session.email, clean]);

  return NextResponse.json({ ok: true, next: "/studio" });
}
