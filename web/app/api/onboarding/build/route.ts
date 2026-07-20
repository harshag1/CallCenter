// Author: Harsha Gundala
// onboarding/build — synthesizes the first bot (instructions + flow + voice) from a description.

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { chatJSON, MODELS } from "@/lib/xai";
import { FlowSchema } from "@/lib/surface-dsl";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";
import { allowsLocalDevelopmentFundedAi } from "@/lib/deployment-funded-ai";

export const maxDuration = 120;

type BotSpec = {
  name: string;
  purpose: string;
  voice: "eve" | "ara" | "rex" | "sal" | "leo";
  instructions: string;
  flow: { nodes: { id: string; label: string; kind: string }[]; edges: { from: string; to: string; label?: string }[] };
};

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

function localBotSpec(description: string): BotSpec {
  const normalized = description.trim().replace(/\s+/g, " ");
  const words = normalized
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const name = `${words.slice(0, 3).join(" ") || "Reliable Voice"} Agent`.slice(0, 80);
  const lower = normalized.toLowerCase();
  const purpose = lower.includes("schedule") ? "scheduling"
    : lower.includes("sale") ? "sales"
      : lower.includes("feedback") ? "feedback"
        : lower.includes("outbound") ? "outbound"
          : "support";
  const stages = [
    ["start", "Open the call", "start"],
    ["understand", "Understand request", "state"],
    ["verify", "Verify details", "state"],
    ["decide", "Choose next step", "decision"],
    ["act", "Use approved tools", "tool"],
    ["confirm", "Confirm outcome", "state"],
    ["end", "Close the call", "end"],
  ];
  return {
    name,
    purpose,
    voice: "eve",
    instructions:
      `You are ${name}. Your configured purpose is: ${normalized.slice(0, 2_000)}. ` +
      "Speak in short, natural sentences. First identify the caller's goal. " +
      "Confirm important names, dates, numbers, destinations, and commitments out loud. " +
      "Follow the active flow one stage at a time and use only tools currently disclosed by the host. " +
      "Never invent account facts, policies, prices, availability, or tool results. " +
      "Before any consequential action, restate exactly what will happen and obtain the required approval. " +
      "If authority, context, or a tool result is missing, explain the limitation and offer a safe handoff. " +
      "After an action, verify the durable receipt before claiming success. End with a concise recap.",
    flow: {
      nodes: stages.map(([id, label, kind]) => ({ id, label, kind })),
      edges: stages.slice(0, -1).map(([id], index) => ({
        from: id,
        to: stages[index + 1]![0],
      })),
    },
  };
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    body = await readPrivateJsonObject(req, 64 * 1024);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return json({ error: status === 403 ? "forbidden" : "invalid request" }, status);
  }
  if (
    Object.keys(body).length !== 1
    || typeof body.description !== "string"
    || !body.description.trim()
    || new TextEncoder().encode(body.description).byteLength > 48 * 1024
    || /\u0000/.test(body.description)
  ) return json({ error: "description required" }, 400);

  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const description = body.description.trim();
  const requestSha256 = createHash("sha256").update(description, "utf8").digest("hex");

  const org = await qOne<{ scrape: { company?: string; description?: string } | null }>(
    `UPDATE orgs
     SET onboarding = COALESCE(onboarding, '{}'::jsonb) || jsonb_build_object(
       'build', jsonb_build_object(
         'request_sha256', $2::text,
         'status', 'building',
         'claimed_at', now()
       )
     )
     WHERE id = $1 AND NOT (COALESCE(onboarding, '{}'::jsonb) ? 'build')
     RETURNING scrape`,
    [session.orgId, requestSha256]
  );
  if (!org) {
    const existing = await qOne<{
      request_sha256: string | null;
      status: string | null;
      agent_id: string | null;
      name: string | null;
    }>(
      `SELECT onboarding->'build'->>'request_sha256' AS request_sha256,
              onboarding->'build'->>'status' AS status,
              onboarding->'build'->>'agent_id' AS agent_id,
              onboarding->'build'->>'name' AS name
       FROM orgs WHERE id = $1`,
      [session.orgId]
    );
    if (existing?.request_sha256 === requestSha256
        && existing.status === "completed" && existing.agent_id) {
      return json({ ok: true, agentId: existing.agent_id, name: existing.name ?? "Voice Agent" });
    }
    return json({
      error: "onboarding build is already claimed; retrying cannot start another provider request",
    }, 409);
  }
  const company = org?.scrape ? `Company context: ${org.scrape.company} — ${org.scrape.description}` : "";

  try {
    const spec = allowsLocalDevelopmentFundedAi()
      ? await chatJSON<BotSpec>(
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
          { role: "user", content: description },
        ],
        { model: MODELS.operator, maxTokens: 2000 }
      )
      : localBotSpec(description);

    const flow = FlowSchema.safeParse(spec.flow);
    const agent = await qOne<{ id: string }>(
      "INSERT INTO agents (org_id, name, purpose) VALUES ($1,$2,$3) RETURNING id",
      [session.orgId, spec.name, spec.purpose]
    );
    if (!agent) throw new Error("agent identity was not created");
    await q(
      `INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, created_by)
       VALUES ($1,1,$2,$3,$4,$5)`,
      [
        agent.id, spec.instructions, spec.voice,
        JSON.stringify(flow.success ? flow.data : { nodes: [], edges: [] }),
        `onboarding (${session.email})`,
      ]
    );
    await q(
      `UPDATE orgs
       SET onboarding = jsonb_set(
         onboarding,
         '{build}',
         jsonb_build_object(
           'request_sha256', $2::text,
           'status', 'completed',
           'agent_id', $3::text,
           'name', $4::text,
           'completed_at', now()
         )
       )
       WHERE id = $1 AND onboarding->'build'->>'request_sha256' = $2`,
      [session.orgId, requestSha256, agent.id, spec.name]
    );
    return json({ ok: true, agentId: agent.id, name: spec.name });
  } catch {
    await q(
      `UPDATE orgs
       SET onboarding = jsonb_set(
         onboarding,
         '{build}',
         jsonb_build_object(
           'request_sha256', $2::text,
           'status', 'failed',
           'failed_at', now()
         )
       )
       WHERE id = $1 AND onboarding->'build'->>'request_sha256' = $2`,
      [session.orgId, requestSha256]
    ).catch(() => {});
    return json({
      error: "onboarding build failed; it will not be retried automatically",
    }, 502);
  }
}
