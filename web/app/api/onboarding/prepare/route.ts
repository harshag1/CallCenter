// Author: Harsha Gundala
// onboarding/prepare — fire-and-forget kick-off of background prep (runs during verification).

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession } from "@/lib/auth";
import { runOnboardingPrep } from "@/lib/onboarding";

export const maxDuration = 120;

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  waitUntil(runOnboardingPrep(session.orgId, session.email));
  return NextResponse.json({ ok: true });
}
