// Author: Harsha Gundala
// experiments-tools.ts — operator tools: create/stop A/B experiments and render results.

import { createExperiment, stopExperiment, experimentMetrics } from "../../experiments";
import type { Surface } from "../../surface-dsl";
import type { OperatorTool, ToolResult } from "../types";

export const createExperimentTool: OperatorTool = {
  name: "create_experiment",
  description:
    "Start an A/B experiment on an agent's prompt. Each variant clones the active version with its instructions_patch appended; live calls are split evenly and scored on satisfaction/resolution. Also creates a results screen.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      name: { type: "string" },
      hypothesis: { type: "string" },
      variants: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, instructions_patch: { type: "string" } },
          required: ["label", "instructions_patch"],
        },
        minItems: 2,
      },
    },
    required: ["agent_id", "name", "variants"],
  },
  async execute(args, ctx) {
    try {
      const experiment = await createExperiment(
        ctx.orgId, String(args.agent_id), String(args.name),
        args.hypothesis ? String(args.hypothesis) : null,
        args.variants as { label: string; instructions_patch: string }[],
        `operator (${ctx.email})`
      );
      return {
        output: { ok: true, experiment_id: experiment.id, screen_id: experiment.screen_id, variants: experiment.variants },
        notice: `Experiment "${experiment.name}" is live`,
        navigate: { tab: "screens", screenId: experiment.screen_id, experimentId: experiment.id },
      };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};

export const stopExperimentTool: OperatorTool = {
  name: "stop_experiment",
  description: "Stop a running experiment — new calls go back to the agent's active version.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async execute(args, ctx) {
    const experiment = await stopExperiment(ctx.orgId, String(args.id)).catch(() => null);
    if (!experiment) return { output: { error: "experiment not found" } };
    return { output: { ok: true, status: experiment.status }, notice: `Experiment "${experiment.name}" stopped` };
  },
};

export const experimentResults: OperatorTool = {
  name: "experiment_results",
  description: "Fetch an experiment's per-variant metrics (calls, avg satisfaction, resolution split, daily trend) and render a results dashboard.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async execute(args, ctx): Promise<ToolResult> {
    const m = await experimentMetrics(ctx.orgId, String(args.id)).catch(() => null);
    if (!m) return { output: { error: "experiment not found" } };

    const variantKeys = [...new Set(m.daily.map((d) => d.variant))];
    const surface: Surface = {
      title: `Experiment — ${m.experiment.name}`,
      blocks: [
        {
          kind: "stat_row",
          stats: m.variants.map((v) => ({
            label: `${v.key.toUpperCase()} · ${v.label}`,
            value: v.avg_satisfaction != null ? `${v.avg_satisfaction}/10` : "—",
            delta: `${v.calls} calls`,
          })),
        },
        ...(m.daily.length
          ? [{
              kind: "chart",
              type: "line" as const,
              series: variantKeys.map((k) => ({
                name: m.variants.find((v) => v.key === k)?.label ?? k,
                points: m.daily.filter((d) => d.variant === k).map((d) => ({ x: d.day, y: d.avg_satisfaction })),
              })),
            }]
          : []),
        {
          kind: "table",
          columns: [
            { key: "variant", label: "Variant" },
            { key: "calls", label: "Calls" },
            { key: "avg", label: "Avg satisfaction" },
            { key: "ai", label: "AI resolved" },
            { key: "human", label: "Human resolved" },
            { key: "unresolved", label: "Unresolved" },
          ],
          rows: m.variants.map((v) => ({
            variant: `${v.key.toUpperCase()} · ${v.label}`,
            calls: v.calls,
            avg: v.avg_satisfaction ?? "—",
            ai: v.resolution.ai_resolved,
            human: v.resolution.human_resolved,
            unresolved: v.resolution.unresolved,
          })),
        },
      ],
    };
    return {
      output: {
        experiment: { id: m.experiment.id, name: m.experiment.name, status: m.experiment.status, hypothesis: m.experiment.hypothesis },
        variants: m.variants.map(({ flow: _flow, ...rest }) => rest), // flows are bulky — keep model context lean
        daily: m.daily,
      },
      surface,
    };
  },
};
