// Author: Harsha Gundala
// onboarding/status — polled by the studio: prep progress, flow, favicon, live number state.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { qOne } from "@/lib/db";
import type { OnboardingState } from "@/lib/onboarding";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const org = await qOne<{
    favicon_url: string | null;
    internet_enabled: boolean;
    allowed_domains: string[];
    onboarding: OnboardingState;
    domain: string | null;
  }>(
    "SELECT favicon_url, internet_enabled, allowed_domains, onboarding, domain FROM orgs WHERE id = $1",
    [session.orgId]
  );
  if (!org) return NextResponse.json({ error: "org missing" }, { status: 404 });

  const agentId = org.onboarding.agent_id;
  const agent = agentId
    ? await qOne<{ id: string; name: string; phone_number: string | null; flow: unknown; version: number }>(
        `SELECT a.id, a.name, a.phone_number, v.flow, v.version
         FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
         WHERE a.id = $1`,
        [agentId]
      )
    : null;

  return NextResponse.json({
    onboarding: org.onboarding,
    favicon_url: org.favicon_url,
    internet_enabled: org.internet_enabled,
    allowed_domains: org.allowed_domains,
    domain: org.domain,
    userPhone: session.phoneNumber,
    agent,
  });
}
