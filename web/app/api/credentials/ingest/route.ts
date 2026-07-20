// Authenticated, same-origin credential ingest. The plaintext body is never echoed,
// logged, placed in chat, or returned to the browser.

import { NextResponse } from "next/server";
import { getSession } from "../../../../lib/auth";
import {
  CredentialVaultError,
  finalizeCredentialIngestSlot,
  isValidCredentialValue,
} from "../../../../lib/credential-vault";
import {
  assertSameOriginBrowserMutation,
  PrivateRequestError,
  readPrivateJsonObject,
} from "../../../../lib/private-json-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Pragma": "no-cache",
  "Expires": "0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Origin, Sec-Fetch-Site",
} as const;

function noStoreJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function parseBody(value: unknown): { slotId: string; submissionId: string; credential: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PrivateRequestError(400);
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (
    keys.length !== 3
    || !Object.prototype.hasOwnProperty.call(body, "slot_id")
    || !Object.prototype.hasOwnProperty.call(body, "submission_id")
    || !Object.prototype.hasOwnProperty.call(body, "credential")
    || typeof body.slot_id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.slot_id)
    || typeof body.submission_id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.submission_id)
    || !isValidCredentialValue(body.credential)
  ) {
    throw new PrivateRequestError(400);
  }
  return {
    slotId: body.slot_id,
    submissionId: body.submission_id,
    credential: body.credential,
  };
}

export async function POST(request: Request) {
  try {
    assertSameOriginBrowserMutation(request);
    const body = parseBody(await readPrivateJsonObject(request, MAX_REQUEST_BODY_BYTES));
    const session = await getSession();
    if (!session) return noStoreJson({ error: "unauthorized" }, 401);

    const finalized = await finalizeCredentialIngestSlot({
      orgId: session.orgId,
      slotId: body.slotId,
      submissionId: body.submissionId,
      credential: body.credential,
    });
    if (finalized.status === "unavailable") {
      return noStoreJson({ error: "credential_slot_unavailable" }, 409);
    }
    if (finalized.status === "already_used") {
      return noStoreJson({ error: "credential_slot_already_used" }, 410);
    }
    return noStoreJson({
      ok: true,
      replayed: finalized.replayed,
      receipt: finalized.receipt,
    }, 200);
  } catch (error) {
    if (error instanceof PrivateRequestError) {
      if (error.status === 403) return noStoreJson({ error: "forbidden" }, 403);
      const label = error.status === 413
        ? "payload_too_large"
        : error.status === 415
          ? "unsupported_media_type"
          : "invalid_request";
      return noStoreJson({ error: label }, error.status);
    }
    if (error instanceof CredentialVaultError) {
      const status = error.code === "invalid_input" ? 400 : error.code === "sink_failed" ? 502 : 500;
      return noStoreJson({
        error: error.code === "invalid_input" ? "invalid_request" : "credential_finalize_failed",
      }, status);
    }
    // Do not include the error, request body, credential, or reference in logs or responses.
    return noStoreJson({ error: "credential_ingest_failed" }, 500);
  }
}
