// Author: Harsha Gundala
// onboarding/build — synthesizes the first bot (instructions + flow + voice) from a description.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { chatJSON, MODELS } from "@/lib/xai";
import { FlowSchema } from "@/lib/surface-dsl";

export const maxDuration = 120;

type BotSpec = {
  name: string;
  purpose: string;
  voice: "eve" | "ara" | "rex" | "sal" | "leo";
  instructions: string;
  flow: { nodes: { id: string; label: string; kind: string }[]; edges: { from: string; to: string; label?: string }[] };
};

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { description } = await req.json().catch(() => ({}));
  if (typeof description !== "string" || !description.trim()) {
    return NextResponse.json({ error: "description required" }, { status: 400 });
  }

  const org = await qOne<{ scrape: { company?: string; description?: string } | null }>(
    "SELECT scrape FROM orgs WHERE id = $1", [session.orgId]
  );
  const company = org?.scrape ? `Company context: ${org.scrape.company} — ${org.scrape.description}` : "";

  const spec = await chatJSON<BotSpec>(
    [
      {
        role: "system",
        content: `Design a production voice agent from the user's description. ${company}
Reply JSON only:
{"name":"<short bot name>","purpose":"support|feedback|outbound|scheduling|sales","voice":"eve|ara|rex|sal|leo",
"instructions":"<300-500 word system prompt for a phone voice agent: persona, goals, guardrails, escalation rules, and explicit conversation stages. Voice-optimized: short sentences, confirm key details out loud.>",
"flow":{"nodes":[{"id":"...","label":"<3-4 words>","kind":"start|state|decision|tool|end"}],"edges":[{"from":"...","to":"...","label":"<optional>"}]}}
The flow must mirror the instructions' stages (6-10 nodes).`,
      },
      { role: "user", content: String(description) },
    ],
    { model: MODELS.operator, maxTokens: 2000 }
  );

  const flow = FlowSchema.safeParse(spec.flow);
  const agent = await qOne<{ id: string }>(
    "INSERT INTO agents (org_id, name, purpose) VALUES ($1,$2,$3) RETURNING id",
    [session.orgId, spec.name, spec.purpose]
  );
  await q(
    `INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, created_by)
     VALUES ($1,1,$2,$3,$4,$5)`,
    [
      agent!.id, spec.instructions, spec.voice,
      JSON.stringify(flow.success ? flow.data : { nodes: [], edges: [] }),
      `onboarding (${session.email})`,
    ]
  );
  return NextResponse.json({ ok: true, agentId: agent!.id, name: spec.name });
}
