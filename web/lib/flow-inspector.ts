import { alwaysTools, flowToolExposure, type AgentFlow, type FlowStep } from "@/lib/flow";

export type FlowInspection = {
  nodeCount: number;
  routeCount: number;
  stepCount: number;
  checkpointCount: number;
  maxStepDepth: number;
  toolExposure: "gateway" | "direct";
  alwaysTools: string[];
  scopedTools: string[];
};

function visitSteps(
  steps: FlowStep[],
  depth: number,
  state: { stepCount: number; checkpointCount: number; maxStepDepth: number; tools: Set<string> }
) {
  for (const step of steps) {
    state.stepCount += 1;
    state.maxStepDepth = Math.max(state.maxStepDepth, depth);
    if (step.checkpoint) state.checkpointCount += 1;
    for (const tool of step.tools ?? []) state.tools.add(tool);
    visitSteps(step.steps ?? [], depth + 1, state);
  }
}

/** A provider-free structural summary used by Studio's inspect surface. */
export function inspectFlow(flow: AgentFlow): FlowInspection {
  const state = {
    stepCount: 0,
    checkpointCount: 0,
    maxStepDepth: 0,
    tools: new Set<string>(),
  };

  for (const node of flow.nodes) {
    for (const tool of node.tools ?? []) state.tools.add(tool);
    visitSteps(node.steps ?? [], 1, state);
  }

  return {
    nodeCount: flow.nodes.length,
    routeCount: flow.edges.length,
    stepCount: state.stepCount,
    checkpointCount: state.checkpointCount,
    maxStepDepth: state.maxStepDepth,
    toolExposure: flowToolExposure(flow),
    alwaysTools: alwaysTools(flow),
    scopedTools: [...state.tools].sort(),
  };
}
