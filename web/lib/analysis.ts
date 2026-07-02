// Author: Harsha Gundala
// analysis.ts — post-call QA: transcript reconstruction → satisfaction, resolution, review.

import { q, qOne } from "./db";
import { chatJSON, MODELS } from "./xai";
import { log } from "./log";

const L = log("analysis");

const RESOLUTIONS = new Set(["ai_resolved", "human_resolved", "unresolved"]);

const SYSTEM = `You are a rigorous call-center QA analyst. Given a voice-call transcript, reply with JSON only:
{"satisfaction": <int 1-10>, "resolution": "ai_resolved" | "human_resolved" | "unresolved", "review": "<3-5 sentences>", "cutoff": <boolean>, "cutoff_context": "<string or empty>"}
- satisfaction: judge ONLY the customer's emotional state from their own words. 5 = normal/neutral, 1 = furious, 10 = delighted. Do not grade the agent here.
- resolution: "ai_resolved" if the AI agent fully handled the issue; "human_resolved" if the call was transferred to a human and the issue concluded there; "unresolved" otherwise (hung up, dead end, follow-up still needed).
- review: 3-5 sentences covering what happened, what went wrong or went great, and why.
- cutoff: true ONLY if the call clearly dropped mid-conversation — the caller was cut off mid-sentence or mid-thought while still engaged (NOT a natural goodbye, NOT the caller deliberately hanging up after being done).
- cutoff_context: when cutoff is true, 1-2 sentences: where the conversation stood and what the caller was in the middle of saying/doing, so a callback agent can resume seamlessly. Empty string otherwise.`;

type Analysis = { satisfaction: number; resolution: string; review: string; cutoff?: boolean; cutoff_context?: string };

function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?:\s|$)/);
  return (m ? m[0] : text).trim().slice(0, 300);
}

function sentimentFor(satisfaction: number): string {
  if (satisfaction >= 7) return "positive";
  if (satisfaction >= 4) return "neutral";
  return "negative";
}

/** Rebuilds the transcript from call events and writes satisfaction/resolution/review (+ summary/sentiment). */
export async function analyzeCall(callId: string): Promise<void> {
  const call = await qOne<{ id: string }>("SELECT id FROM calls WHERE id = $1", [callId]);
  if (!call) return;

  const events = await q<{ type: string; payload: { text?: string; name?: string; args?: unknown; transfer?: string } }>(
    "SELECT type, payload FROM call_events WHERE call_id = $1 ORDER BY id LIMIT 600",
    [callId]
  );

  let transferred = false;
  const lines: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case "user_said":
        if (e.payload.text) lines.push(`Caller: ${e.payload.text}`);
        break;
      case "agent_said":
        if (e.payload.text) lines.push(`Agent: ${e.payload.text}`);
        break;
      case "human_segment":
        transferred = true;
        if (e.payload.text) lines.push(`Human rep leg: ${e.payload.text}`);
        break;
      case "tool_call": {
        const name = e.payload.name ?? "tool";
        if (name === "contact_support") transferred = true;
        lines.push(`[tool_call: ${name} ${JSON.stringify(e.payload.args ?? {}).slice(0, 200)}]`);
        break;
      }
      case "state":
        if (e.payload.transfer) transferred = true;
        break;
    }
  }

  const transcript = lines.join("\n").slice(0, 14_000);
  if (transcript.replace(/\[tool_call[^\]]*\]/g, "").trim().length < 30) {
    await q(
      "UPDATE calls SET resolution = COALESCE(resolution, 'unresolved') WHERE id = $1",
      [callId]
    );
    await fireEndOfCallTasks(callId);
    return;
  }

  try {
    const a = await chatJSON<Analysis>(
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `${transferred ? "NOTE: a transfer to a human occurred during this call.\n\n" : ""}${transcript}`,
        },
      ],
      { model: MODELS.operator, maxTokens: 500, temperature: 0.2 }
    );
    const satisfaction = Math.min(Math.max(Math.round(Number(a.satisfaction) || 5), 1), 10);
    const resolution = RESOLUTIONS.has(a.resolution) ? a.resolution : transferred ? "human_resolved" : "unresolved";
    const review = String(a.review ?? "").slice(0, 2000);
    await q(
      `UPDATE calls SET satisfaction = $2, resolution = $3, review = $4, summary = $5, sentiment = $6 WHERE id = $1`,
      [callId, satisfaction, resolution, review, firstSentence(review), sentimentFor(satisfaction)]
    );
    L.info("call analyzed", { callId, data: { satisfaction, resolution } });

    // Cut-off mid-sentence? The agent's recall policy decides whether we call them back.
    if (a.cutoff) await maybeScheduleRecall(callId, String(a.cutoff_context ?? "")).catch(() => {});
  } catch (e) {
    L.warn("analysis failed", { callId, err: (e as Error).message });
  }

  await fireEndOfCallTasks(callId);
}

/** Fires end-of-call background tasks queued during the conversation (cron sweep is the backstop). */
async function fireEndOfCallTasks(callId: string): Promise<void> {
  try {
    const { runCallTask } = await import("./tasks");
    const queued = await q<{ id: string }>(
      "SELECT id FROM call_tasks WHERE call_id = $1 AND trigger_at = 'end_of_call' AND status = 'pending' ORDER BY created_at",
      [callId]
    );
    for (const t of queued) await runCallTask(t.id).catch(() => {});
  } catch { /* cron sweep is the backstop */ }
}


/** Policy-driven callback for calls that dropped mid-conversation (agents.recall_policy). */
async function maybeScheduleRecall(callId: string, cutoffContext: string): Promise<void> {
  const call = await qOne<{
    agent_id: string; direction: string; from_number: string | null; to_number: string | null;
    flow_id: string | null; parent_call_id: string | null;
    enabled: boolean | null; instructions: string | null;
  }>(
    `SELECT c.agent_id, c.direction, c.from_number, c.to_number, c.flow_id, c.parent_call_id,
            (a.recall_policy->>'enabled')::boolean AS enabled, a.recall_policy->>'instructions' AS instructions
     FROM calls c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1`,
    [callId]
  );
  if (!call || call.enabled === false) return;
  if (call.parent_call_id) return; // never recall a recall — one retry max
  const number = call.direction === "outbound" ? call.to_number : call.from_number;
  if (!number || !/^\+\d{7,15}$/.test(number)) return;
  const already = await qOne(
    "SELECT id FROM scheduled_calls WHERE parent_call_id = $1 LIMIT 1", [callId]
  );
  if (already) return;

  const reason =
    `CUT-OFF RECALL. The previous call with this person disconnected mid-conversation. ` +
    `Where it stood: ${cutoffContext || "unknown"}. ` +
    `Policy: ${call.instructions ?? "Apologize for the disconnect and pick up where the conversation left off."}`;
  await q(
    `INSERT INTO scheduled_calls (agent_id, to_number, run_at, reason, parent_call_id, created_by, flow_id)
     VALUES ($1,$2, now() + interval '2 minutes', $3, $4, 'recall-policy', $5)`,
    [call.agent_id, number, reason, callId, call.flow_id]
  );
  L.info("cut-off recall scheduled", { callId, data: { to: number } });
}
