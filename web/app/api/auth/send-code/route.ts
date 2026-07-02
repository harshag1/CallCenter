// Author: Harsha Gundala
// send-code — emails a 6-digit OTP; codes are HMAC'd at rest, 10-minute expiry.

import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { generateCode, hmacCode } from "@/lib/auth";
import { sendLoginCode } from "@/lib/email";
import { log } from "@/lib/log";

const L = log("auth/send-code");

export async function POST(req: Request) {
  const { email } = await req.json().catch(() => ({}));
  const clean = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  const recent = await q<{ n: string }>(
    "SELECT count(*) AS n FROM auth_codes WHERE email = $1 AND created_at > now() - interval '10 minutes'",
    [clean]
  );
  if (Number(recent[0].n) >= 5) {
    return NextResponse.json({ error: "too many codes requested — wait a few minutes" }, { status: 429 });
  }
  const code = generateCode();
  await q(
    "INSERT INTO auth_codes (email, code_hmac, expires_at) VALUES ($1,$2, now() + interval '10 minutes')",
    [clean, hmacCode(code)]
  );
  try {
    await sendLoginCode(clean, code);
  } catch (e) {
    L.error("send failed", { err: (e as Error).message });
    return NextResponse.json({ error: "could not send email" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
