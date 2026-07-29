// Author: Harsha Gundala
// onboarding/scrape — company research through configured server inference.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { createServerInferenceRuntime } from "@/lib/server-inference";
import { log } from "@/lib/log";
import { allowsLocalDevelopmentFundedAi } from "@/lib/deployment-funded-ai";
import { PRIVATE_NO_STORE_HEADERS } from "@/lib/private-json-request";

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
  if (!session) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }
  if (!session.orgDomain) {
    return NextResponse.json({ scrape: null }, { headers: PRIVATE_NO_STORE_HEADERS });
  }

  const cached = await qOne<{ scrape: Scrape | null }>("SELECT scrape FROM orgs WHERE id = $1", [session.orgId]);
  if (cached?.scrape) {
    return NextResponse.json({ scrape: cached.scrape }, { headers: PRIVATE_NO_STORE_HEADERS });
  }
  if (!allowsLocalDevelopmentFundedAi()) {
    return NextResponse.json({ scrape: null }, { headers: PRIVATE_NO_STORE_HEADERS });
  }

  try {
    const inference = createServerInferenceRuntime({
      purpose: "onboarding",
      workload: "research",
      budget: {
        maxProviderRequests: 1,
        maxReservedOutputTokens: 1400,
        maxInputBytesPerRequest: 64 * 1024,
        requestTimeoutMs: 45_000,
      },
    });
    const scrape = await inference.researchJSON<Scrape>(
      `Research the company behind the domain "${session.orgDomain}" on the live web. Reply JSON only:
{"company":"<name>","description":"<1 sentence>","industry":"<short>","suggestions":[{"label":"<3-5 word bot idea>","purpose":"support|feedback|outbound|scheduling|sales","prompt":"<2-3 sentence bot description personalized to this company, written as if the user typed it>"}]}
      Give exactly 4 suggestions covering distinct purposes, grounded in what the company actually does.`,
      session.orgDomain,
      { maxOutputTokens: 1400 },
    );
    await q("UPDATE orgs SET scrape = $2, name = COALESCE($3, name) WHERE id = $1", [
      session.orgId, JSON.stringify(scrape), scrape.company ?? null,
    ]);
    return NextResponse.json({ scrape }, { headers: PRIVATE_NO_STORE_HEADERS });
  } catch (e) {
    L.warn("scrape failed", { orgId: session.orgId, err: (e as Error).message });
    return NextResponse.json({ scrape: null }, { headers: PRIVATE_NO_STORE_HEADERS });
  }
}
