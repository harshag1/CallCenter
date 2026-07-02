// Author: Harsha Gundala
// logout — deactivates the session and clears the cookie.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { q } from "@/lib/db";

export async function POST() {
  const token = (await cookies()).get("session_token")?.value;
  if (token) await q("UPDATE sessions_auth SET is_active = false WHERE token = $1", [token]);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete("session_token");
  return res;
}
