// Author: Harsha Gundala
// onboarding/scrape — company research from the login email domain via Grok live search.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { researchJSON } from "@/lib/xai";
import { log } from "@/lib/log";

const L = log("onboarding/scrape");
export const maxDuration = 60;

type Scrape = {
  company: string;
  description: string;
  industry: string;
  suggestions: { label: string; purpose: string; prompt: string }[];
};

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!session.orgDomain) return NextResponse.json({ scrape: null });

  const cached = await qOne<{ scrape: Scrape | null }>("SELECT scrape FROM orgs WHERE id = $1", [session.orgId]);
  if (cached?.scrape) return NextResponse.json({ scrape: cached.scrape });

  try {
    const scrape = await researchJSON<Scrape>(
      `Research the company behind the domain "${session.orgDomain}" on the live web. Reply JSON only:
{"company":"<name>","description":"<1 sentence>","industry":"<short>","suggestions":[{"label":"<3-5 word bot idea>","purpose":"support|feedback|outbound|scheduling|sales","prompt":"<2-3 sentence bot description personalized to this company, written as if the user typed it>"}]}
Give exactly 4 suggestions covering distinct purposes, grounded in what the company actually does.`,
      session.orgDomain,
      1400
    );
    await q("UPDATE orgs SET scrape = $2, name = COALESCE($3, name) WHERE id = $1", [
      session.orgId, JSON.stringify(scrape), scrape.company ?? null,
    ]);
    return NextResponse.json({ scrape });
  } catch (e) {
    L.warn("scrape failed", { orgId: session.orgId, err: (e as Error).message });
    return NextResponse.json({ scrape: null });
  }
}
