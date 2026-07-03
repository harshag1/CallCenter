// Author: Harsha Gundala
// experiments.ts — A/B prompt experiments: variant agent versions, weighted assignment, metrics.

import { q, qOne } from "./db";
import { log } from "./log";
import type { AgentFlow } from "./flow";

const L = log("experiments");
const VARIANT_KEYS = "abcdefgh";

export type Variant = { key: string; label: string; agent_version: number; weight: number };

export type Experiment = {
  id: string;
  org_id: string;
  agent_id: string;
  name: string;
  hypothesis: string | null;
  status: "running" | "stopped";
  variants: Variant[];
  created_by: string;
  created_at: string;
};

export type VariantInput = { label: string; instructions_patch: string };

/** Clones the active agent version per variant (instructions patched), inserts the experiment + its screen. */
export async function createExperiment(
  orgId: string,
  agentId: string,
  name: string,
  hypothesis: string | null,
  variants: VariantInput[],
  createdBy = "operator"
): Promise<Experiment & { screen_id: string }> {
  if (variants.length < 2 || variants.length > VARIANT_KEYS.length) {
    throw new Error(`experiments need 2-${VARIANT_KEYS.length} variants`);
  }
  const active = await qOne<{
    version: number; instructions: string; voice: string; flow: unknown;
    tool_ids: string[]; mcp_server_ids: string[]; settings: Record<string, unknown>;
  }>(
    `SELECT v.version, v.instructions, v.voice, v.flow, v.tool_ids, v.mcp_server_ids, v.settings
     FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
     WHERE a.id = $1 AND a.org_id = $2`,
    [agentId, orgId]
  );
  if (!active) throw new Error("agent not found");

  const next = await qOne<{ n: number }>(
    "SELECT COALESCE(MAX(version), 0) + 1 AS n FROM agent_versions WHERE agent_id = $1",
    [agentId]
  );
  const built: Variant[] = [];
  const weight = 1 / variants.length;
  for (let i = 0; i < variants.length; i++) {
    const version = next!.n + i;
    await q(
      `INSERT INTO agent_versions (agent_id, version, instructions, voice, flow, tool_ids, mcp_server_ids, settings, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'experiment')`,
      [
        agentId, version,
        `${active.instructions}\n\nVARIANT ADJUSTMENT:\n${variants[i].instructions_patch}`,
        active.voice, JSON.stringify(active.flow), active.tool_ids, active.mcp_server_ids,
        JSON.stringify(active.settings),
      ]
    );
    built.push({ key: VARIANT_KEYS[i], label: variants[i].label, agent_version: version, weight });
  }

  const exp = await qOne<Experiment>(
    `INSERT INTO experiments (org_id, agent_id, name, hypothesis, variants, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [orgId, agentId, name, hypothesis, JSON.stringify(built), createdBy]
  );
  const screen = await qOne<{ id: string }>(
    `INSERT INTO screens (org_id, title, icon, kind, experiment_id, created_by)
     VALUES ($1,$2,'flask-conical','experiment',$3,$4) RETURNING id`,
    [orgId, name, exp!.id, createdBy]
  );
  L.info("experiment created", { orgId, data: { experimentId: exp!.id, variants: built.length } });
  return { ...exp!, screen_id: screen!.id };
}

export async function stopExperiment(orgId: string, id: string): Promise<Experiment | null> {
  return qOne<Experiment>(
    "UPDATE experiments SET status = 'stopped' WHERE id = $2 AND org_id = $1 RETURNING *",
    [orgId, id]
  );
}

/** Weighted random pick from the latest running experiment for an agent. */
export async function pickVariant(
  agentId: string
): Promise<{ experimentId: string; variant: string; agentVersion: number } | null> {
  const exp = await qOne<{ id: string; variants: Variant[] }>(
    "SELECT id, variants FROM experiments WHERE agent_id = $1 AND status = 'running' ORDER BY created_at DESC LIMIT 1",
    [agentId]
  );
  if (!exp?.variants?.length) return null;
  const total = exp.variants.reduce((s, v) => s + (v.weight || 0), 0) || 1;
  let r = Math.random() * total;
  for (const v of exp.variants) {
    r -= v.weight || 0;
    if (r <= 0) return { experimentId: exp.id, variant: v.key, agentVersion: v.agent_version };
  }
  const last = exp.variants[exp.variants.length - 1];
  return { experimentId: exp.id, variant: last.key, agentVersion: last.agent_version };
}

export type VariantMetrics = {
  key: string;
  label: string;
  agent_version: number;
  calls: number;
  scored: number;
  avg_satisfaction: number | null;
  avg_duration_s: number | null;
  resolution: { ai_resolved: number; human_resolved: number; unresolved: number; pending: number };
  flow: AgentFlow | null;
};

export type ExperimentCall = {
  id: string;
  variant: string;
  satisfaction: number;
  duration_s: number | null;
  started_at: string;
  resolution: string | null;
  review: string | null;
};

export type ExperimentMetrics = {
  experiment: Experiment;
  agent: { id: string; name: string; phone_number: string | null } | null;
  variants: VariantMetrics[];
  daily: { day: string; variant: string; avg_satisfaction: number; calls: number }[];
  calls: ExperimentCall[];
};

/** Per-variant aggregates (incl. variant flows) + daily series + scored call points. */
export async function experimentMetrics(orgId: string, id: string): Promise<ExperimentMetrics | null> {
  const experiment = await qOne<Experiment>(
    "SELECT * FROM experiments WHERE id = $1 AND org_id = $2", [id, orgId]
  );
  if (!experiment) return null;

  const agent = await qOne<{ id: string; name: string; phone_number: string | null }>(
    "SELECT id, name, phone_number FROM agents WHERE id = $1", [experiment.agent_id]
  );
  const agg = await q<{
    variant: string; calls: number; scored: number; avg_satisfaction: number | null; avg_duration_s: number | null;
    ai_resolved: number; human_resolved: number; unresolved: number;
  }>(
    `SELECT variant, count(*)::int AS calls,
            count(satisfaction)::int AS scored,
            ROUND(AVG(satisfaction)::numeric, 2)::float AS avg_satisfaction,
            ROUND(AVG(duration_s)::numeric, 0)::float AS avg_duration_s,
            count(*) FILTER (WHERE resolution = 'ai_resolved')::int AS ai_resolved,
            count(*) FILTER (WHERE resolution = 'human_resolved')::int AS human_resolved,
            count(*) FILTER (WHERE resolution = 'unresolved')::int AS unresolved
     FROM calls WHERE experiment_id = $1 GROUP BY variant`,
    [id]
  );
  const daily = await q<{ day: string; variant: string; avg_satisfaction: number; calls: number }>(
    `SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day, variant,
            ROUND(AVG(satisfaction)::numeric, 2)::float AS avg_satisfaction, count(*)::int AS calls
     FROM calls WHERE experiment_id = $1 AND satisfaction IS NOT NULL
     GROUP BY 1, 2 ORDER BY 1`,
    [id]
  );
  const calls = await q<ExperimentCall>(
    `SELECT id, variant, satisfaction, duration_s, started_at, resolution, review
     FROM calls WHERE experiment_id = $1 AND satisfaction IS NOT NULL
     ORDER BY started_at`,
    [id]
  );
  const flows = await q<{ version: number; flow: AgentFlow }>(
    "SELECT version, flow FROM agent_versions WHERE agent_id = $1 AND version = ANY($2)",
    [experiment.agent_id, experiment.variants.map((v) => v.agent_version)]
  );

  const variants: VariantMetrics[] = experiment.variants.map((v) => {
    const a = agg.find((r) => r.variant === v.key);
    return {
      key: v.key,
      label: v.label,
      agent_version: v.agent_version,
      calls: a?.calls ?? 0,
      scored: a?.scored ?? 0,
      avg_satisfaction: a?.avg_satisfaction ?? null,
      avg_duration_s: a?.avg_duration_s ?? null,
      resolution: {
        ai_resolved: a?.ai_resolved ?? 0,
        human_resolved: a?.human_resolved ?? 0,
        unresolved: a?.unresolved ?? 0,
        pending: (a?.calls ?? 0) - (a?.ai_resolved ?? 0) - (a?.human_resolved ?? 0) - (a?.unresolved ?? 0),
      },
      flow: flows.find((f) => f.version === v.agent_version)?.flow ?? null,
    };
  });
  return { experiment, agent, variants, daily, calls };
}
