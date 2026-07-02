// Author: Harsha Gundala
// send-phone-code — sends a phone verification code after email verification.

import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { generateCode, getSession, hmacCode, normalizePhoneNumber } from "@/lib/auth";
import { sendPhoneCode } from "@/lib/sms";
import { log } from "@/lib/log";

const L = log("auth/send-phone-code");

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { phone } = await req.json().catch(() => ({}));
  const clean = normalizePhoneNumber(String(phone ?? ""));
  if (!clean) return NextResponse.json({ error: "enter a valid phone number" }, { status: 400 });

  const recent = await q<{ n: string }>(
    "SELECT count(*) AS n FROM phone_codes WHERE phone_number = $1 AND created_at > now() - interval '10 minutes'",
    [clean]
  );
  if (Number(recent[0].n) >= 5) {
    return NextResponse.json({ error: "too many codes requested — wait a few minutes" }, { status: 429 });
  }

  const code = generateCode();
  await q(
    "INSERT INTO phone_codes (phone_number, code_hmac, expires_at) VALUES ($1,$2, now() + interval '10 minutes')",
    [clean, hmacCode(code)]
  );
  await q(
    "UPDATE users SET phone_number = $2, phone_verified_at = CASE WHEN phone_number = $2 THEN phone_verified_at ELSE NULL END WHERE email = $1",
    [session.email, clean]
  );

  try {
    await sendPhoneCode(clean, code);
  } catch (e) {
    L.error("send failed", { orgId: session.orgId, err: (e as Error).message });
    return NextResponse.json({ error: "could not send text message" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
