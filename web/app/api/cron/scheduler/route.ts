// Author: Harsha Gundala
// cron/scheduler — dials due outbound calls/recalls (runs every minute via Vercel cron).

import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { log } from "@/lib/log";
import { analyzeCall } from "@/lib/analysis";
import { sweepCallTasks } from "@/lib/tasks";
import {
  dialDue,
  quarantineStaleIndeterminateCampaigns,
  reconcileStalePostBoundaryDispatches,
} from "@/lib/campaigns";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { sweepGeneratedToolCleanup } from "@/lib/toolfactory/cleanup";
import { sweepExpiredOperatorPrivateDisplays } from "@/lib/operator-action-maintenance";
import { drainGovernedCallWorkers } from "@/lib/governed-worker-drain";

const L = log("cron/scheduler");
export const maxDuration = 120;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!authorizeCronRequest(auth, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Approval display material has a deletion deadline independent of tenant
  // traffic. Run the bounded global sweep on every authorized minute tick.
  let expiredOperatorDisplaysScrubbed = 0;
  let operatorDisplayScrubUnavailable = false;
  try {
    expiredOperatorDisplaysScrubbed = await sweepExpiredOperatorPrivateDisplays(500);
  } catch (error) {
    operatorDisplayScrubUnavailable = true;
    L.warn("operator private display sweep failed", { err: (error as Error).message });
  }

  // A browser that disappears without /end must not keep an upload bearer alive.
  // The append-only receipt is the clock authority, so malformed call metadata
  // cannot extend this deadline.
  let staleRecordingCallsClosed = 0;
  let recordingCallSweepUnavailable = false;
  try {
    const rows = await q<{ id: string }>(
      `UPDATE calls c
       SET status = 'failed', ended_at = COALESCE(ended_at, now()),
           metadata = jsonb_set(
             COALESCE(c.metadata, '{}'::jsonb)
               || jsonb_build_object('recording_upload_expired_at', now()),
             '{recording_consent}',
             COALESCE((c.metadata->'recording_consent') - 'upload_token_hash', '{}'::jsonb),
             false
           )
       FROM recording_consent_receipts receipt
       WHERE c.id = receipt.call_id AND c.direction = 'web' AND c.status = 'active'
         AND receipt.upload_expires_at <= now()
       RETURNING c.id`
    );
    staleRecordingCallsClosed = rows.length;
  } catch (error) {
    recordingCallSweepUnavailable = true;
    L.warn("stale recording call sweep failed", { err: (error as Error).message });
  }

  // Retention is a deletion deadline, not a read-time hint. Sweep up to the
  // database function's hard maximum on every authorized minute tick.
  let recordingsPurged = 0;
  let recordingPurgeUnavailable = false;
  try {
    const rows = await q<{ purged: string }>(
      "SELECT purge_expired_call_recordings(5000)::text AS purged"
    );
    recordingsPurged = Number(rows[0]?.purged ?? 0);
    if (!Number.isSafeInteger(recordingsPurged) || recordingsPurged < 0) throw new Error("invalid purge count");
  } catch (error) {
    recordingPurgeUnavailable = true;
    L.warn("recording retention sweep failed", { err: (error as Error).message });
  }

  // First terminalize provider-boundary rows abandoned by a crashed worker.
  // This performs no provider I/O and makes those effects permanently non-retryable.
  const reconciledUnknownDispatches = await reconcileStalePostBoundaryDispatches(100);
  // Dialer (campaign-aware): claims due scheduled calls and originates in parallel.
  const results = await dialDue(15);
  // A recipient-free receipt releases configuration locks only after unknown
  // effects have remained quarantined for the fixed 24-hour safety window.
  const quarantinedCampaigns = await quarantineStaleIndeterminateCampaigns(25);
  // Analysis backstop: bridge-terminated calls can outlive their function context,
  // so sweep any recently-completed call that never got scored.
  const unanalyzed = await q<{ id: string }>(
    `SELECT c.id FROM calls c
     WHERE c.status = 'completed' AND c.satisfaction IS NULL
       AND c.ended_at > now() - interval '2 hours'
       AND (SELECT count(*) FROM call_events e WHERE e.call_id = c.id
            AND e.type IN ('user_said','agent_said','human_segment')) >= 1
     ORDER BY c.ended_at DESC LIMIT 5`
  );
  for (const c of unanalyzed) {
    await analyzeCall(c.id).catch((e) => L.warn("sweep analysis failed", { callId: c.id, err: (e as Error).message }));
  }

  const tasksRun = await sweepCallTasks().catch(() => 0);
  const generatedToolCleanup = await sweepGeneratedToolCleanup(5).catch(() => ({
    claimed: 0,
    cleaned: 0,
    cleanupRequired: 0,
    unavailable: true as const,
  }));
  const governedWorkerDrain = await drainGovernedCallWorkers({
    maximumWorkers: 2,
    wallClockMs: 45_000,
  }).catch(() => ({
    attempted: 0,
    executed: 0,
    claimRaces: 0,
    timeBudgetExhausted: false,
    unavailable: true as const,
  }));

  return NextResponse.json({
    processed: Object.keys(results).length,
    reconciledUnknownDispatches,
    quarantinedCampaigns,
    analyzed: unanalyzed.length,
    tasks: tasksRun,
    generatedToolCleanup,
    governedWorkerDrain,
    expiredOperatorDisplaysScrubbed,
    operatorDisplayScrubUnavailable,
    staleRecordingCallsClosed,
    recordingCallSweepUnavailable,
    recordingsPurged,
    recordingPurgeUnavailable,
    results,
  });
}
