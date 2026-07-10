import { listStepRefs, validateAgentFlow } from "../../flow";
import {
  completeFlowStep,
  createFlowExecutionState,
  enterFlowStep,
  flowStateSummary,
  selectFlowTopic,
} from "../../flow-runtime";
import type { OperatorTool } from "../types";

export const validateFlowTool: OperatorTool = {
  name: "validate_flow",
  description: "Validate a Flow v1/v2 definition without saving it. Reports schema/topology errors, unreachable nodes, every absolute step path, scoped tools, checkpoints, and required outputs.",
  parameters: {
    type: "object",
    properties: { flow: { type: "object" } },
    required: ["flow"],
  },
  async execute(args) {
    const validated = validateAgentFlow(args.flow);
    const refs = validated.flow ? listStepRefs(validated.flow) : [];
    return {
      output: {
        valid: validated.diagnostics.every((diagnostic) => diagnostic.level !== "error"),
        diagnostics: validated.diagnostics,
        summary: validated.flow ? {
          schema_version: validated.flow.schema_version ?? 1,
          nodes: validated.flow.nodes.length,
          steps: refs.length,
          max_depth: refs.reduce((max, ref) => Math.max(max, ref.path.split(".").length - 1), 0),
          checkpoints: refs.filter((ref) => ref.step.checkpoint).map((ref) => ref.path),
        } : null,
        steps: refs.map((ref) => ({
          path: ref.path,
          label: ref.step.label,
          tools: ref.step.tools ?? [],
          required_outputs: ref.step.required_outputs ?? [],
          transitions: ref.step.transitions ?? [],
        })),
      },
    };
  },
};
export const testFlowScenario: OperatorTool = {
  name: "test_flow_scenario",
  description: "Deterministically walk a Flow v2 scenario before deployment. Enters the topic and each requested absolute step, applies outputs, and returns grants/checkpoints or the exact failure.",
  parameters: {
    type: "object",
    properties: {
      flow: { type: "object" },
      topic: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, outputs: { type: "object" } },
          required: ["path", "outputs"],
        },
      },
    },
    required: ["flow", "topic", "steps"],
  },
  async execute(args) {
    const validated = validateAgentFlow(args.flow);
    const errors = validated.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (!validated.flow || errors.length) return { output: { ok: false, stage: "validation", errors } };
    let selected = selectFlowTopic(validated.flow, createFlowExecutionState(), String(args.topic));
    if ("error" in selected) return { output: { ok: false, stage: "classification", ...selected } };
    const trace: unknown[] = [];
    for (const item of args.steps as { path: string; outputs: Record<string, unknown> }[]) {
      const entered = enterFlowStep(validated.flow, selected, item.path);
      if ("error" in entered) return { output: { ok: false, stage: "enter_step", path: item.path, trace, ...entered } };
      trace.push({ path: item.path, available_tools: entered.availableTools, next_steps: entered.nextSteps });
      const completed = completeFlowStep(validated.flow, entered.state, { path: item.path, outputs: item.outputs });
      if ("error" in completed) return { output: { ok: false, stage: "complete_step", path: item.path, trace, ...completed } };
      selected = completed.state;
    }
    return { output: { ok: true, trace, final: flowStateSummary(validated.flow, selected) } };
  },
};
