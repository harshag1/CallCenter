// Author: Harsha Gundala
// verification-state — recovers staged onboarding state after email verification.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { qOne } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const hasAgents = await qOne("SELECT id FROM agents WHERE org_id = $1 LIMIT 1", [session.orgId]);
  return NextResponse.json({
    email: session.email,
    phone: session.phoneNumber,
    emailVerified: true,
    phoneVerified: Boolean(session.phoneVerifiedAt),
    next: hasAgents ? "/workspace" : "/onboarding",
  });
}
