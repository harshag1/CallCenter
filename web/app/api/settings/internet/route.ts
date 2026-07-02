// Author: Harsha Gundala
// settings/internet — internet-access toggle and enforced domain allowlist.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { enabled, add_domain, remove_domain } = await req.json().catch(() => ({}));

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
