// Author: Harsha Gundala
// settings/internet — internet-access toggle and enforced domain allowlist.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

const MAX_INTERNET_SETTINGS_BODY_BYTES = 4 * 1024;
const InternetSettingsSchema = z.object({
  enabled: z.unknown().optional(),
  add_domain: z.unknown().optional(),
  remove_domain: z.unknown().optional(),
}).strict();

function privateRequestError(error: unknown): NextResponse {
  const status = error instanceof PrivateRequestError ? error.status : 400;
  const message = status === 403
    ? "forbidden"
    : status === 413
      ? "payload too large"
      : status === 415
        ? "unsupported media type"
        : "invalid request";
  return NextResponse.json({ error: message }, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function POST(req: Request) {
  let rawBody: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    rawBody = await readPrivateJsonObject(req, MAX_INTERNET_SETTINGS_BODY_BYTES);
  } catch (error) {
    return privateRequestError(error);
  }
  const parsed = InternetSettingsSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const { enabled, add_domain, remove_domain } = parsed.data;

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (typeof enabled === "boolean") {
    await q("UPDATE orgs SET internet_enabled = $2 WHERE id = $1", [session.orgId, enabled]);
  }
  if (add_domain) {
    const clean = String(add_domain).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) {
      await q(
        "UPDATE orgs SET allowed_domains = array_append(array_remove(allowed_domains, $2), $2) WHERE id = $1",
        [session.orgId, clean]
      );
    } else {
      return NextResponse.json({ error: "invalid domain" }, { status: 400 });
    }
  }
  if (remove_domain) {
    await q("UPDATE orgs SET allowed_domains = array_remove(allowed_domains, $2) WHERE id = $1", [
      session.orgId, String(remove_domain),
    ]);
  }
  const org = await qOne<{ internet_enabled: boolean; allowed_domains: string[] }>(
    "SELECT internet_enabled, allowed_domains FROM orgs WHERE id = $1", [session.orgId]
  );
  return NextResponse.json(org);
}
