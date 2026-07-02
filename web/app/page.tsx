// Author: Harsha Gundala
// page.tsx — entry: route to login, onboarding, or workspace based on session state.

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { qOne } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.phoneVerifiedAt) redirect("/verify");
  const org = await qOne<{ onboarding: { agent_id?: string } }>(
    "SELECT onboarding FROM orgs WHERE id = $1", [session.orgId]
  );
  if (org?.onboarding?.agent_id) redirect("/studio");
  const hasAgents = await qOne("SELECT id FROM agents WHERE org_id = $1 LIMIT 1", [session.orgId]);
  redirect(hasAgents ? "/workspace" : "/onboarding");
}
