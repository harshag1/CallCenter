// Author: Harsha Gundala
// campaigns.ts — named flows (outbound) and campaign runs: target lists → scheduled calls → parallel dialing.

import { q, qOne } from "./db";
import { AgentFlowSchema, type AgentFlow } from "./flow";
import { listRows } from "./datasets";
import { log } from "./log";

const L = log("campaigns");
const KICK_PARALLEL = 5;

export type FlowRow = {
  id: string; agent_id: string; name: string; kind: "inbound" | "outbound";
  flow: AgentFlow; instructions: string; created_at: string;
};

export async function createFlow(
  orgId: string,
  agentId: string,
  opts: { name: string; kind?: "inbound" | "outbound"; flow: unknown; instructions: string; createdBy: string }
): Promise<FlowRow> {
  const parsed = AgentFlowSchema.parse(opts.flow);
  const row = await qOne<FlowRow>(
    `INSERT INTO flows (org_id, agent_id, name, kind, flow, instructions, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, agent_id, name, kind, flow, instructions, created_at`,
    [orgId, agentId, opts.name, opts.kind ?? "outbound", JSON.stringify(parsed), opts.instructions, opts.createdBy]
  );
  return row!;
}

export async function updateFlow(
  orgId: string,
  flowId: string,
  patch: { name?: string; flow?: unknown; instructions?: string }
): Promise<boolean> {
  const flow = patch.flow ? JSON.stringify(AgentFlowSchema.parse(patch.flow)) : null;
  const rows = await q(
    `UPDATE flows SET
       name = COALESCE($3, name), flow = COALESCE($4::jsonb, flow),
       instructions = COALESCE($5, instructions), updated_at = now()
     WHERE id = $1 AND org_id = $2 RETURNING id`,
    [flowId, orgId, patch.name ?? null, flow, patch.instructions ?? null]
  );
  return rows.length > 0;
}

export async function listFlows(orgId: string, agentId?: string | null): Promise<FlowRow[]> {
  return q<FlowRow>(
    `SELECT id, agent_id, name, kind, flow, instructions, created_at FROM flows
     WHERE org_id = $1 AND ($2::uuid IS NULL OR agent_id = $2) ORDER BY created_at`,
    [orgId, agentId ?? null]
  );
}

export type CampaignLaunch = {
  campaignId: string;
  targets: number;
  skipped: number;
  scheduled: boolean;
};

/** Creates the campaign and one scheduled call per valid target row. runAt null = dial now. */
export async function launchCampaign(
  orgId: string,
  opts: {
    agentId: string; flowId: string; name: string;
    datasetSlug: string; phoneColumn?: string; runAt?: string | null; createdBy: string;
  }
): Promise<CampaignLaunch> {
  const dataset = await qOne<{ id: string }>(
    "SELECT id FROM datasets WHERE org_id = $1 AND slug = $2", [orgId, opts.datasetSlug]
  );
  if (!dataset) throw new Error(`dataset "${opts.datasetSlug}" not found`);
  const flow = await qOne("SELECT id FROM flows WHERE id = $1 AND org_id = $2", [opts.flowId, orgId]);
  if (!flow) throw new Error("flow not found");

  const col = opts.phoneColumn ?? "phone";
  const rows = await listRows(orgId, dataset.id, 5000, 0);
  const targets: string[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of rows as { data: Record<string, unknown> }[]) {
    const digits = String(r.data[col] ?? "").replace(/[^\d+]/g, "");
    const e164 = /^\+\d{7,15}$/.test(digits) ? digits : /^\d{10}$/.test(digits) ? `+1${digits}` : null;
    if (e164 && !seen.has(e164)) { seen.add(e164); targets.push(e164); }
    else skipped++;
  }
  if (!targets.length) throw new Error(`no valid phone numbers in "${opts.datasetSlug}"."${col}"`);

  const runAt = opts.runAt ?? null;
  const campaign = await qOne<{ id: string }>(
    `INSERT INTO campaigns (org_id, agent_id, flow_id, name, dataset_slug, phone_column, status, run_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [orgId, opts.agentId, opts.flowId, opts.name, opts.datasetSlug, col, runAt ? "scheduled" : "running", runAt, opts.createdBy]
  );
  for (const to of targets) {
    await q(
      `INSERT INTO scheduled_calls (agent_id, to_number, run_at, reason, created_by, flow_id, campaign_id)
       VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7)`,
      [opts.agentId, to, runAt, `campaign: ${opts.name}`, opts.createdBy, opts.flowId, campaign!.id]
    );
  }
  L.info("campaign launched", { orgId, data: { campaignId: campaign!.id, targets: targets.length, runAt } });
  return { campaignId: campaign!.id, targets: targets.length, skipped, scheduled: !!runAt };
}

/** Claims and dials due scheduled calls immediately (shared by cron and run-now kicks). */
export async function dialDue(limit: number, campaignId?: string): Promise<Record<string, string>> {
  const { originateCall } = await import("./telephony");
  const due = await q<{ id: string; agent_id: string; to_number: string; attempts: number; reason: string | null; flow_id: string | null; campaign_id: string | null; parent_call_id: string | null }>(
    `UPDATE scheduled_calls SET status = 'dialing', attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM scheduled_calls
       WHERE status = 'pending' AND run_at <= now() AND ($2::uuid IS NULL OR campaign_id = $2)
       ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, agent_id, to_number, attempts, reason, flow_id, campaign_id, parent_call_id`,
    [limit, campaignId ?? null]
  );
  const results: Record<string, string> = {};
  await Promise.all(
    due.map(async (job) => {
      try {
        const callId = await originateCall(job.agent_id, job.to_number, job.reason, {
          flowId: job.flow_id, campaignId: job.campaign_id, parentCallId: job.parent_call_id,
        });
        await q("UPDATE scheduled_calls SET status = 'done' WHERE id = $1", [job.id]);
        results[job.id] = `dialed:${callId}`;
      } catch (e) {
        const retry = job.attempts < 3;
        await q(
          `UPDATE scheduled_calls SET status = $2,
             run_at = CASE WHEN $2 = 'pending' THEN now() + interval '5 minutes' ELSE run_at END
           WHERE id = $1`,
          [job.id, retry ? "pending" : "failed"]
        );
        results[job.id] = `error:${(e as Error).message}`;
        L.error("dial failed", { data: { job: job.id }, err: (e as Error).message });
      }
    })
  );
  await closeFinishedCampaigns();
  return results;
}

/** Marks campaigns done once no pending/dialing work remains. */
async function closeFinishedCampaigns(): Promise<void> {
  await q(
    `UPDATE campaigns SET status = 'done'
     WHERE status IN ('running','scheduled') AND run_at IS NOT DISTINCT FROM run_at
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_calls s
         WHERE s.campaign_id = campaigns.id AND s.status IN ('pending','dialing')
       )
       AND NOT EXISTS (
         SELECT 1 FROM calls x
         WHERE x.campaign_id = campaigns.id AND x.status IN ('active','dialing')
       )
       AND EXISTS (SELECT 1 FROM scheduled_calls s WHERE s.campaign_id = campaigns.id)`
  ).catch(() => {});
}

/** Fast start for "run it now": dial the first batch without waiting for cron. */
export async function kickCampaign(campaignId: string): Promise<Record<string, string>> {
  await q("UPDATE campaigns SET status = 'running' WHERE id = $1 AND status = 'scheduled'", [campaignId]);
  return dialDue(KICK_PARALLEL, campaignId);
}

export async function cancelCampaign(orgId: string, campaignId: string): Promise<number> {
  await q("UPDATE campaigns SET status = 'canceled' WHERE id = $1 AND org_id = $2", [campaignId, orgId]);
  const rows = await q(
    "UPDATE scheduled_calls SET status = 'canceled' WHERE campaign_id = $1 AND status = 'pending' RETURNING id",
    [campaignId]
  );
  return rows.length;
}

export async function campaignStats(orgId: string) {
  return q(
    `SELECT c.id, c.name, c.status, c.run_at, c.dataset_slug, c.created_at, f.name AS flow_name, a.name AS agent,
       (SELECT count(*) FROM scheduled_calls s WHERE s.campaign_id = c.id) AS total,
       (SELECT count(*) FROM scheduled_calls s WHERE s.campaign_id = c.id AND s.status = 'pending') AS pending,
       (SELECT count(*) FROM calls x WHERE x.campaign_id = c.id AND x.status = 'completed') AS answered,
       (SELECT count(*) FROM calls x WHERE x.campaign_id = c.id AND x.status IN ('failed','no-answer')) AS missed,
       (SELECT round(avg(x.satisfaction),1) FROM calls x WHERE x.campaign_id = c.id AND x.satisfaction IS NOT NULL) AS avg_satisfaction
     FROM campaigns c JOIN flows f ON f.id = c.flow_id JOIN agents a ON a.id = c.agent_id
     WHERE c.org_id = $1 AND c.status IN ('running','scheduled') ORDER BY c.created_at DESC LIMIT 50`,
    [orgId]
  );
}
