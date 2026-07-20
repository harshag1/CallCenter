// Author: Harsha Gundala
// onboarding/prepare — fire-and-forget kick-off of background prep (runs during verification).

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession } from "@/lib/auth";
import { runOnboardingPrep } from "@/lib/onboarding";
import {
  assertEmptyPrivateRequest,
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
} from "@/lib/private-json-request";

export const maxDuration = 120;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function POST(req: Request) {
  try {
    assertSameOriginBrowserMutation(req);
    await assertEmptyPrivateRequest(req);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return json({ error: status === 403 ? "forbidden" : "invalid request" }, status);
  }
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  waitUntil(runOnboardingPrep(session.orgId, session.email));
  return json({ ok: true });
}
