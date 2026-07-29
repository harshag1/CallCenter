// Author: Harsha Gundala
// onboarding/build — synthesizes the first bot (instructions + flow + voice) from a description.

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import { createServerInferenceRuntime } from "@/lib/server-inference";
import { slimInstructions, type AgentFlow } from "@/lib/flow";
import { buildOnboardingFlow } from "@/lib/onboarding-flow";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";
import { allowsLocalDevelopmentFundedAi } from "@/lib/deployment-funded-ai";
import { z } from "zod";

export const maxDuration = 120;

type BotSpec = {
  name: string;
  purpose: string;
  voice: "eve" | "ara" | "rex" | "sal" | "leo";
  instructions: string;
  flow: AgentFlow;
};

const GeneratedBotSpecSchema = z.object({
  name: z.string().min(1).max(80),
  purpose: z.enum(["support", "feedback", "outbound", "scheduling", "sales"]),
  voice: z.enum(["eve", "ara", "rex", "sal", "leo"]),
  instructions: z.string().min(1).max(16_000),
  flow: z.object({
    topics: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      label: z.string().min(1).max(96),
      context: z.string().min(1).max(8_000),
      steps: z.array(z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        label: z.string().min(1).max(96),
        instructions: z.string().min(1).max(4_000),
      }).strict()).min(2).max(5),
    }).strict()).min(1).max(4),
  }).strict(),
}).strict();

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
  const flow = buildOnboardingFlow({
    topics: [
      {
        id: "primary_goal",
        label: "Primary request",
        context:
          `Handle the configured ${purpose} request: ${normalized.slice(0, 2_000)}. ` +
          "Keep unverified caller claims separate from facts returned by the gateway.",
        steps: [
          {
            id: "understand",
            label: "Understand request",
            instructions:
              "Ask one question at a time until the desired outcome is explicit. Restate it and get confirmation.",
          },
          {
            id: "verify",
            label: "Verify details",
            instructions:
              "Confirm every name, date, number, destination, and commitment needed for the request. Do not invent missing facts.",
          },
          {
            id: "resolve",
            label: "Resolve safely",
            instructions:
              "Provide the result supported by current context and gateway receipts. If required authority or a capability is absent, use the human handoff.",
          },
        ],
      },
      {
        id: "take_message",
        label: "Take a message",
        context:
          "Capture a concise follow-up request when the primary request cannot be completed during the call. Do not promise an unsupported response time.",
        steps: [
          {
            id: "collect",
            label: "Collect message",
            instructions:
              "Collect the caller's name, the reason for follow-up, and a safe contact preference.",
          },
          {
            id: "confirm",
            label: "Confirm message",
            instructions:
              "Repeat the message and contact preference. Correct any mismatch before recording the outcome.",
          },
        ],
      },
    ],
  });
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
    flow,
  };
}

async function generateBotSpec(description: string, company: string): Promise<BotSpec> {
  const fallback = localBotSpec(description);
  if (!allowsLocalDevelopmentFundedAi()) return fallback;
  try {
    const inference = createServerInferenceRuntime({
      purpose: "onboarding",
      workload: "generation",
      budget: {
        maxProviderRequests: 1,
        maxReservedOutputTokens: 3000,
        maxInputBytesPerRequest: 128 * 1024,
        requestTimeoutMs: 60_000,
      },
    });
    const generated = await inference.completeJSON<unknown>(
      [
        {
          role: "system",
          content: `Design a production voice agent from the user's description. ${company}
Reply JSON only:
{"name":"<short bot name>","purpose":"support|feedback|outbound|scheduling|sales","voice":"eve|ara|rex|sal|leo",
"instructions":"<300-500 word voice-agent persona, goals, factual guardrails, escalation rules, and confirmation discipline>",
"flow":{"topics":[
{"id":"<safe_id>","label":"<2-4 words>","context":"<topic facts and boundaries>",
"steps":[{"id":"<safe_id>","label":"<2-4 words>","instructions":"<exact stage instructions>"}]}
]}}
Create 1-4 distinct routing topics. Each topic needs 2-5 ordered stages. Do not name tools or invent integrations. The host compiles this blueprint into Flow v2 and exclusively owns gateway authority, scoped actions, receipts, and persistence.`,
        },
        { role: "user", content: description },
      ],
      { maxOutputTokens: 3000 },
    );
    const candidate = GeneratedBotSpecSchema.parse(generated);
    return {
      name: candidate.name,
      purpose: candidate.purpose,
      voice: candidate.voice,
      instructions: candidate.instructions,
      flow: buildOnboardingFlow(candidate.flow),
    };
  } catch {
    // Model output has no authority. A malformed/missing response becomes the
    // same deterministic, semantically validated Flow-v2 starter as local mode.
    return fallback;
  }
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
    const spec = await generateBotSpec(description, company);
    const agent = await qOne<{ id: string }>(
      "INSERT INTO agents (org_id, name, purpose) VALUES ($1,$2,$3) RETURNING id",
      [session.orgId, spec.name, spec.purpose]
    );
    if (!agent) throw new Error("agent identity was not created");
    await q(
      `INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, created_by)
       VALUES ($1,1,$2,$3,$4,$5)`,
      [
        agent.id, slimInstructions(spec.instructions, spec.flow), spec.voice,
        JSON.stringify(spec.flow),
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
