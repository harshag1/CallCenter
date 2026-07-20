// Author: Harsha Gundala
// logout — deactivates the session and clears the cookie.

import { NextResponse } from "next/server";
import {
  allSessionCookieDeletions,
  AUTH_NO_STORE_HEADERS,
  revokePresentedSessions,
} from "@/lib/auth";
import {
  assertEmptyPrivateRequest,
  assertSameOriginBrowserMutation,
  PrivateRequestError,
} from "@/lib/private-json-request";

export async function POST(req: Request) {
  try {
    assertSameOriginBrowserMutation(req);
    await assertEmptyPrivateRequest(req);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : "invalid request" },
      { status, headers: AUTH_NO_STORE_HEADERS },
    );
  }
  await revokePresentedSessions(req.headers.get("cookie"));
  const res = NextResponse.json({ ok: true }, { headers: AUTH_NO_STORE_HEADERS });
  for (const deletion of allSessionCookieDeletions()) {
    // NextResponse.cookies.delete omits Secure. An explicit expired cookie is
    // required for conforming browsers to accept deletion of a __Host- cookie.
    res.cookies.set(deletion);
  }
  return res;
}
