// Deterministic, provider-neutral execution state for deeply nested voice flows.

import { z } from "zod";
import {
  alwaysTools,
  findStep,
  type AgentFlow,
  type FlowNode,
  type FlowStep,
  type StepRef,
} from "./flow";

export const FlowExecutionStateSchema = z.object({
  version: z.literal(2),
  status: z.enum(["routing", "active", "completed", "failed"]),
  nodeId: z.string().nullable(),
  currentStep: z.string().nullable(),
  completedSteps: z.array(z.string()),
  attempts: z.record(z.string(), z.number().int().nonnegative()),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
  checkpoints: z.array(z.object({ step: z.string(), at: z.string() })),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export type FlowExecutionState = z.infer<typeof FlowExecutionStateSchema>;

export type RuntimeError = { error: string; code: string; allowed?: string[] };

function nowIso(now?: string) {
  return now ?? new Date().toISOString();
}

export function createFlowExecutionState(now?: string): FlowExecutionState {
  return {
    version: 2,
    status: "routing",
    nodeId: null,
    currentStep: null,
    completedSteps: [],
    attempts: {},
    outputs: {},
    checkpoints: [],
    revision: 0,
    updatedAt: nowIso(now),
  };
}

function updateState(state: FlowExecutionState, patch: Partial<FlowExecutionState>, now?: string): FlowExecutionState {
  return {
    ...state,
    ...patch,
    revision: state.revision + 1,
    updatedAt: nowIso(now),
  };
}

function topic(flow: AgentFlow, nodeId: string | null): FlowNode | undefined {
  return flow.nodes.find((node) => node.id === nodeId && (node.kind === "topic" || node.kind === "fallback"));
}

function directChildren(ref: StepRef): string[] {
  return (ref.step.steps ?? []).map((step) => `${ref.path}.${step.id}`);
}

export function allowedStepPaths(flow: AgentFlow, state: FlowExecutionState): string[] {
  const node = topic(flow, state.nodeId);
  if (!node || node.kind === "fallback") return [];
  if (!state.currentStep) return (node.steps ?? []).map((step) => `${node.id}.${step.id}`);

  const current = findStep(flow, state.currentStep);
  if (!current) return [];
  const explicit = (current.step.transitions ?? []).map((transition) => transition.to);
  return [...new Set([...directChildren(current), ...explicit])];
}

export function selectFlowTopic(
  flow: AgentFlow,
  state: FlowExecutionState,
  nodeId: string,
  now?: string
): FlowExecutionState | RuntimeError {
  const node = topic(flow, nodeId);
  if (!node) return { error: `unknown topic "${nodeId}"`, code: "unknown_topic" };
  return updateState(state, { status: "active", nodeId: node.id, currentStep: null }, now);
}

export function grantedTools(flow: AgentFlow, state: FlowExecutionState): string[] {
  const grants = new Set(alwaysTools(flow));
  const node = topic(flow, state.nodeId);
  for (const name of node?.tools ?? []) grants.add(name);
  if (state.currentStep) {
    const ref = findStep(flow, state.currentStep);
    for (const ancestor of ref?.ancestors ?? []) for (const name of ancestor.tools ?? []) grants.add(name);
    for (const name of ref?.step.tools ?? []) grants.add(name);
  }
  return [...grants];
}

export function enterFlowStep(
  flow: AgentFlow,
  state: FlowExecutionState,
  path: string,
  now?: string
): { state: FlowExecutionState; step: FlowStep; path: string; availableTools: string[]; nextSteps: string[] } | RuntimeError {
  const ref = findStep(flow, path);
  if (!ref) return { error: `unknown step "${path}"`, code: "unknown_step", allowed: allowedStepPaths(flow, state) };
  if (ref.nodeId !== state.nodeId) {
    return { error: `step "${path}" is outside the selected topic`, code: "wrong_topic", allowed: allowedStepPaths(flow, state) };
  }

  const allowed = allowedStepPaths(flow, state);
  const isTopLevelChoice = ref.ancestors.length === 0 && ref.nodeId === state.nodeId;
  const isRetry = state.currentStep === path;
  if (!isTopLevelChoice && !isRetry && !allowed.includes(path)) {
    return { error: `step "${path}" is not reachable from the current checkpoint`, code: "step_not_reachable", allowed };
  }

  const attempts = (state.attempts[path] ?? 0) + 1;
  if (attempts > (ref.step.max_attempts ?? 3)) {
    return { error: `step "${path}" exceeded its attempt limit`, code: "attempt_limit", allowed: ref.step.on_failure ? [ref.step.on_failure] : allowed };
  }
  const nextState = updateState(state, {
    status: "active",
    currentStep: path,
    attempts: { ...state.attempts, [path]: attempts },
  }, now);
  return {
    state: nextState,
    step: ref.step,
    path,
    availableTools: grantedTools(flow, nextState),
    nextSteps: allowedStepPaths(flow, nextState),
  };
}

export function completeFlowStep(
  flow: AgentFlow,
  state: FlowExecutionState,
  args: { path?: string; outputs?: Record<string, unknown> },
  now?: string
): { state: FlowExecutionState; nextSteps: string[] } | RuntimeError {
  const path = args.path ?? state.currentStep;
  if (!path || path !== state.currentStep) return { error: "complete_step must target the active step", code: "not_active_step" };
  const ref = findStep(flow, path);
  if (!ref) return { error: `unknown step "${path}"`, code: "unknown_step" };
  const outputs = args.outputs ?? {};
  const missing = (ref.step.required_outputs ?? []).filter((key) => outputs[key] === undefined || outputs[key] === null);
  if (missing.length) return { error: `missing required outputs: ${missing.join(", ")}`, code: "missing_outputs" };

  const completedSteps = [...new Set([...state.completedSteps, path])];
  const checkpoints = ref.step.checkpoint
    ? [...state.checkpoints, { step: path, at: nowIso(now) }]
    : state.checkpoints;
  const withCompletion = updateState(state, {
    completedSteps,
    outputs: { ...state.outputs, [path]: outputs },
    checkpoints,
  }, now);
  const nextSteps = allowedStepPaths(flow, withCompletion);
  const nextState = nextSteps.length
    ? withCompletion
    : updateState(withCompletion, { status: "completed", currentStep: null }, now);
  return { state: nextState, nextSteps };
}

export function flowStateSummary(flow: AgentFlow, state: FlowExecutionState) {
  const ref = state.currentStep ? findStep(flow, state.currentStep) : undefined;
  return {
    status: state.status,
    topic: state.nodeId,
    current_step: state.currentStep,
    instructions: ref?.step.instructions,
    success_criteria: ref?.step.success_criteria ?? [],
    required_outputs: ref?.step.required_outputs ?? [],
    available_tools: grantedTools(flow, state),
    next_steps: allowedStepPaths(flow, state),
    completed_steps: state.completedSteps,
    checkpoints: state.checkpoints,
    revision: state.revision,
  };
}
