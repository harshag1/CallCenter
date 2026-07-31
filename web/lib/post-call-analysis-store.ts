import "server-only";

import { qOne } from "./db";

export const POST_CALL_ANALYSIS_VERSION = "qa-v2";
export const POST_CALL_ANALYSIS_LEASE_MS = 60_000;

export type PostCallAnalysisStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "skipped"
  | "failed"
  | "indeterminate";

export type PostCallAnalysisRun = Readonly<{
  call_id: string;
  analysis_version: string;
  status: PostCallAnalysisStatus;
  owner_token: string | null;
  dispatch_started_at: Date | string | null;
  settled_at: Date | string | null;
  result: unknown;
  error_code: string | null;
}>;

export type ValidatedPostCallAnalysis = Readonly<{
  satisfaction: number;
  resolution: "ai_resolved" | "human_resolved" | "unresolved";
  review: string;
  cutoff: boolean;
  cutoff_context: string;
}>;

const ANALYSIS_STATUSES = new Set<PostCallAnalysisStatus>([
  "pending",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "indeterminate",
]);

function validatedRun(row: PostCallAnalysisRun | null): PostCallAnalysisRun | null {
  if (!row) return null;
  if (
    row.analysis_version !== POST_CALL_ANALYSIS_VERSION
    || !ANALYSIS_STATUSES.has(row.status)
    || typeof row.call_id !== "string"
    || (row.owner_token !== null && typeof row.owner_token !== "string")
    || (row.error_code !== null && typeof row.error_code !== "string")
  ) {
    throw new Error("post-call analysis store returned an invalid authority row");
  }
  return Object.freeze({ ...row });
}

export async function claimPostCallAnalysis(
  callId: string,
  ownerToken: string,
): Promise<PostCallAnalysisRun | null> {
  return validatedRun(await qOne<PostCallAnalysisRun>(
    `SELECT * FROM public.claim_post_call_analysis($1,$2,$3,$4)`,
    [
      callId,
      POST_CALL_ANALYSIS_VERSION,
      ownerToken,
      POST_CALL_ANALYSIS_LEASE_MS,
    ],
  ));
}

export async function markPostCallAnalysisDispatchStarted(
  callId: string,
  ownerToken: string,
): Promise<PostCallAnalysisRun | null> {
  return validatedRun(await qOne<PostCallAnalysisRun>(
    `SELECT * FROM public.mark_post_call_analysis_dispatch_started($1,$2,$3)`,
    [callId, POST_CALL_ANALYSIS_VERSION, ownerToken],
  ));
}

export async function settlePostCallAnalysisSuccess(
  callId: string,
  ownerToken: string,
  analysis: ValidatedPostCallAnalysis,
  summary: string,
  sentiment: "positive" | "neutral" | "negative",
): Promise<PostCallAnalysisRun | null> {
  return validatedRun(await qOne<PostCallAnalysisRun>(
    `SELECT * FROM public.settle_post_call_analysis_success(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
     )`,
    [
      callId,
      POST_CALL_ANALYSIS_VERSION,
      ownerToken,
      analysis.satisfaction,
      analysis.resolution,
      analysis.review,
      summary,
      sentiment,
      analysis.cutoff,
      analysis.cutoff_context,
    ],
  ));
}

export async function settlePostCallAnalysisSkipped(
  callId: string,
  ownerToken: string,
): Promise<PostCallAnalysisRun | null> {
  return validatedRun(await qOne<PostCallAnalysisRun>(
    `SELECT * FROM public.settle_post_call_analysis_skipped($1,$2,$3)`,
    [callId, POST_CALL_ANALYSIS_VERSION, ownerToken],
  ));
}

export async function settlePostCallAnalysisFailed(
  callId: string,
  ownerToken: string,
): Promise<PostCallAnalysisRun | null> {
  return validatedRun(await qOne<PostCallAnalysisRun>(
    `SELECT * FROM public.settle_post_call_analysis_failed($1,$2,$3,$4)`,
    [
      callId,
      POST_CALL_ANALYSIS_VERSION,
      ownerToken,
      "analysis_failed",
    ],
  ));
}
