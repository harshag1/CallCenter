// Author: Harsha Gundala
// onboarding.ts — background prep during verification: favicon, domain-tuned demo flow, agent, phone number.

import { q, qOne } from "./db";
import { researchJSON, chatJSON, MODELS } from "./xai";
import { resolveFavicon } from "./favicon";
import { purchaseNumber } from "./telephony";
import { AgentFlowSchema, slimInstructions, TOPIC_ICONS, type AgentFlow } from "./flow";
import { log } from "./log";

const L = log("onboarding");

export type OnboardingState = {
  started?: boolean;
  agent_id?: string;
  company?: string;
  persona?: string;
  flow_ready?: boolean;
  number_status?: "provisioning" | "ready" | "failed";
  number?: string;
  error?: string;
};

async function patchState(orgId: string, patch: Partial<OnboardingState>) {
  await q("UPDATE orgs SET onboarding = onboarding || $2 WHERE id = $1", [orgId, JSON.stringify(patch)]);
}

type DemoSpec = {
  company: string;
  bot_name: string;
  persona: string;
  voice: "eve" | "ara" | "rex" | "sal" | "leo";
  topics: {
    id: string;
    label: string;
    icon: string;
    context: string;
    steps: { id: string; label: string; instructions: string }[];
  }[];
};

const SPEC_SHAPE = `{"company":"<name>","bot_name":"<short friendly name>","persona":"<2-3 sentences: who the agent is, tone, company one-liner>","voice":"eve|ara|rex|sal|leo",
"topics":[{"id":"<snake_case>","label":"<2-3 words>","icon":"<one of: ${TOPIC_ICONS.join(", ")}>","context":"<4-6 sentences the agent needs when handling this topic: what it covers, key facts, guardrails>",
"steps":[{"id":"<snake_case>","label":"<2-3 words>","instructions":"<3-5 sentences: exactly how to execute this step on a call, what to collect, what to confirm, when to escalate>"}]}]}
Exactly 2 topics, each with 2-3 steps, grounded in what the company actually does.`;

async function generateDemoSpec(domain: string | null, email: string): Promise<DemoSpec> {
  if (domain) {
    return researchJSON<DemoSpec>(
      `Research the company behind "${domain}" on the live web, then design a demo inbound phone agent for it. Reply JSON only:\n${SPEC_SHAPE}`,
      domain,
      2500
    );
  }
  return chatJSON<DemoSpec>(
    [
      { role: "system", content: `Design a generic demo inbound support phone agent (the user signed up with a personal email: ${email}). Reply JSON only:\n${SPEC_SHAPE}` },
      { role: "user", content: "generic small-business receptionist demo" },
    ],
    { model: MODELS.fast, maxTokens: 2000 }
  );
}

export function assembleFlow(spec: DemoSpec, supportNumber: string | null): AgentFlow {
  const nodes: AgentFlow["nodes"] = [
    { id: "incoming", label: "Incoming Call", kind: "incoming_call" },
    ...spec.topics.map((t) => ({
      id: t.id,
      label: t.label,
      kind: "topic" as const,
      icon: TOPIC_ICONS.includes(t.icon as never) ? t.icon : "life-buoy",
      context: t.context,
      steps: t.steps,
    })),
    {
      id: "other",
      label: "Other",
      kind: "fallback" as const,
      icon: "phone-forwarded",
      context: "Anything outside the defined topics: offer to connect the caller with the support line.",
      support_number: supportNumber ?? undefined,
    },
  ];
  const edges = [
    ...spec.topics.map((t) => ({ from: "incoming", to: t.id })),
    { from: "incoming", to: "other" },
  ];
  return AgentFlowSchema.parse({ nodes, edges });
}

/** Idempotent full prep. Safe to fire-and-forget; progress lands on orgs.onboarding. */
export async function runOnboardingPrep(orgId: string, email: string): Promise<void> {
  const org = await qOne<{ domain: string | null; onboarding: OnboardingState }>(
    "SELECT domain, onboarding FROM orgs WHERE id = $1", [orgId]
  );
  if (!org) return;
  if (org.onboarding.started) {
    // Prep already ran — but a failed number purchase is retryable.
    if (org.onboarding.number_status === "failed" && org.onboarding.agent_id) {
      await patchState(orgId, { number_status: "provisioning", error: undefined });
      try {
        const number = await purchaseNumber();
        await q("UPDATE agents SET phone_number = $2 WHERE id = $1", [org.onboarding.agent_id, number]);
        await patchState(orgId, { number_status: "ready", number, error: null as never });
      } catch (e) {
        await patchState(orgId, { number_status: "failed", error: (e as Error).message });
      }
    }
    return;
  }
  await patchState(orgId, { started: true });

  try {
    // Favicon + demo spec race in parallel; user phone = default fallback support number.
    const [favicon, spec, user] = await Promise.all([
      org.domain ? resolveFavicon(org.domain).catch(() => null) : Promise.resolve(null),
      generateDemoSpec(org.domain, email),
      qOne<{ phone_number: string | null }>("SELECT phone_number FROM users WHERE email = $1", [email]),
    ]);

    if (favicon) await q("UPDATE orgs SET favicon_url = $2 WHERE id = $1", [orgId, favicon]);
    if (org.domain) {
      await q(
        "UPDATE orgs SET allowed_domains = $2, name = COALESCE($3, name) WHERE id = $1",
        [orgId, [org.domain], spec.company ?? null]
      );
    }

    const flow = assembleFlow(spec, user?.phone_number ?? null);
    const agent = await qOne<{ id: string }>(
      "INSERT INTO agents (org_id, name, purpose) VALUES ($1,$2,'support') RETURNING id",
      [orgId, spec.bot_name]
    );
    await q(
      `INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, created_by)
       VALUES ($1,1,$2,$3,$4,'onboarding-prep')`,
      [agent!.id, slimInstructions(spec.persona, flow), spec.voice, JSON.stringify(flow)]
    );
    await patchState(orgId, {
      agent_id: agent!.id,
      company: spec.company,
      persona: spec.persona,
      flow_ready: true,
      number_status: "provisioning",
    });

    try {
      const number = await purchaseNumber();
      await q("UPDATE agents SET phone_number = $2 WHERE id = $1", [agent!.id, number]);
      await patchState(orgId, { number_status: "ready", number });
    } catch (e) {
      L.error("number provisioning failed", { orgId, err: (e as Error).message });
      await patchState(orgId, { number_status: "failed", error: (e as Error).message });
    }
  } catch (e) {
    L.error("onboarding prep failed", { orgId, err: (e as Error).message });
    await patchState(orgId, { error: (e as Error).message, started: false });
  }
}
