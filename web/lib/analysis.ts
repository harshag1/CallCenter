// Author: Harsha Gundala
// analysis.ts — post-call QA: transcript reconstruction → satisfaction, resolution, review.

import { randomUUID } from "node:crypto";

import { q } from "./db";
import { log } from "./log";
import {
  claimPostCallAnalysis,
  markPostCallAnalysisDispatchStarted,
  settlePostCallAnalysisFailed,
  settlePostCallAnalysisSkipped,
  settlePostCallAnalysisSuccess,
  type PostCallAnalysisStatus,
  type ValidatedPostCallAnalysis,
} from "./post-call-analysis-store";
import { createServerInferenceRuntime } from "./server-inference";

const L = log("analysis");

const RESOLUTIONS = new Set<ValidatedPostCallAnalysis["resolution"]>([
  "ai_resolved",
  "human_resolved",
  "unresolved",
]);

const SYSTEM = `You are a rigorous call-center QA analyst. Given a voice-call transcript, reply with JSON only:
{"satisfaction": <int 1-10>, "resolution": "ai_resolved" | "human_resolved" | "unresolved", "review": "<3-5 sentences>", "cutoff": <boolean>, "cutoff_context": "<string or empty>"}
- satisfaction: judge ONLY the customer's emotional state from their own words. 5 = normal/neutral, 1 = furious, 10 = delighted. Do not grade the agent here.
- resolution: "ai_resolved" if the AI agent fully handled the issue; "human_resolved" if the call was transferred to a human and the issue concluded there; "unresolved" otherwise (hung up, dead end, follow-up still needed).
- review: 3-5 sentences covering what happened, what went wrong or went great, and why.
- cutoff: true ONLY if the call clearly dropped mid-conversation — the caller was cut off mid-sentence or mid-thought while still engaged (NOT a natural goodbye, NOT the caller deliberately hanging up after being done).
- cutoff_context: when cutoff is true, 1-2 sentences: where the conversation stood and what the caller was in the middle of saying/doing, so a callback agent can resume seamlessly. Empty string otherwise.`;

const ANALYSIS_KEYS = Object.freeze([
  "cutoff",
  "cutoff_context",
  "resolution",
  "review",
  "satisfaction",
]);

export type AnalyzeCallOutcome = Readonly<{
  status: PostCallAnalysisStatus | "not_found" | "store_unavailable";
  terminal: boolean;
}>;

function isTerminalStatus(status: AnalyzeCallOutcome["status"]): boolean {
  return status === "succeeded"
    || status === "skipped"
    || status === "failed"
    || status === "indeterminate";
}

/**
 * Runtime validation is intentionally stricter than a TypeScript cast. Model
 * output is untrusted data: strings such as `"false"`, null policy fields,
 * numeric strings, extra keys, and contradictory cutoff context all fail.
 */
export function parsePostCallAnalysis(value: unknown): ValidatedPostCallAnalysis {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("post-call analysis returned an invalid object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(ANALYSIS_KEYS)
    || typeof candidate.satisfaction !== "number"
    || !Number.isInteger(candidate.satisfaction)
    || candidate.satisfaction < 1
    || candidate.satisfaction > 10
    || typeof candidate.resolution !== "string"
    || !RESOLUTIONS.has(
      candidate.resolution as ValidatedPostCallAnalysis["resolution"],
    )
    || typeof candidate.review !== "string"
    || candidate.review.trim().length < 1
    || new TextEncoder().encode(candidate.review.trim()).byteLength > 2_000
    || typeof candidate.cutoff !== "boolean"
    || typeof candidate.cutoff_context !== "string"
    || new TextEncoder().encode(candidate.cutoff_context.trim()).byteLength > 2_000
    || (candidate.cutoff && candidate.cutoff_context.trim().length < 1)
    || (!candidate.cutoff && candidate.cutoff_context.trim().length > 0)
  ) {
    throw new Error("post-call analysis returned an invalid schema");
  }
  return Object.freeze({
    satisfaction: candidate.satisfaction,
    resolution:
      candidate.resolution as ValidatedPostCallAnalysis["resolution"],
    review: candidate.review.trim(),
    cutoff: candidate.cutoff,
    cutoff_context: candidate.cutoff_context.trim(),
  });
}

function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?:\s|$)/);
  return (m ? m[0] : text).trim().slice(0, 300);
}

function sentimentFor(satisfaction: number): string {
  if (satisfaction >= 7) return "positive";
  if (satisfaction >= 4) return "neutral";
  return "negative";
}

async function finish(
  callId: string,
  status: AnalyzeCallOutcome["status"],
): Promise<AnalyzeCallOutcome> {
  await fireEndOfCallTasks(callId);
  return Object.freeze({ status, terminal: isTerminalStatus(status) });
}

/**
 * Rebuilds the transcript and applies one versioned QA result. Every close
 * path first converges on the durable claim; only its exact owner can cross
 * the provider-dispatch boundary.
 */
export async function analyzeCall(callId: string): Promise<AnalyzeCallOutcome> {
  const ownerToken = randomUUID();
  let claim;
  try {
    claim = await claimPostCallAnalysis(callId, ownerToken);
  } catch (error) {
    L.warn("analysis authority unavailable", {
      callId,
      err: (error as Error).message,
    });
    return Object.freeze({ status: "store_unavailable", terminal: false });
  }
  if (!claim) {
    return Object.freeze({ status: "not_found", terminal: false });
  }
  if (claim.status !== "running" || claim.owner_token !== ownerToken) {
    return finish(callId, claim.status);
  }

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
    const skipped = await settlePostCallAnalysisSkipped(callId, ownerToken);
    return finish(callId, skipped?.status ?? "running");
  }

  try {
    const inference = createServerInferenceRuntime({
      purpose: "post_call_qa",
      workload: "generation",
      budget: {
        maxProviderRequests: 1,
        maxReservedOutputTokens: 500,
        maxInputBytesPerRequest: 64 * 1024,
        requestTimeoutMs: 30_000,
      },
    });
    const dispatched = await markPostCallAnalysisDispatchStarted(
      callId,
      ownerToken,
    );
    if (
      !dispatched
      || dispatched.status !== "running"
      || dispatched.owner_token !== ownerToken
      || !dispatched.dispatch_started_at
    ) {
      return finish(callId, dispatched?.status ?? "running");
    }
    const raw = await inference.completeJSON<unknown>(
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `${transferred ? "NOTE: a transfer to a human occurred during this call.\n\n" : ""}${transcript}`,
        },
      ],
      { maxOutputTokens: 500, temperature: 0.2 },
    );
    const analysis = parsePostCallAnalysis(raw);
    const settled = await settlePostCallAnalysisSuccess(
      callId,
      ownerToken,
      analysis,
      firstSentence(analysis.review),
      sentimentFor(analysis.satisfaction) as "positive" | "neutral" | "negative",
    );
    if (!settled) return finish(callId, "running");
    L.info("call analyzed", {
      callId,
      data: {
        satisfaction: analysis.satisfaction,
        resolution: analysis.resolution,
      },
    });
    return finish(callId, settled.status);
  } catch (e) {
    L.warn("analysis failed", { callId, err: (e as Error).message });
    const failed = await settlePostCallAnalysisFailed(
      callId,
      ownerToken,
    ).catch(() => null);
    return finish(callId, failed?.status ?? "running");
  }
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
