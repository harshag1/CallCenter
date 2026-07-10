// Deterministic, provider-neutral execution state for deeply nested voice flows.

import { z } from "zod";
import {
  alwaysTools,
  findStep,
  topicEntryStepPaths,
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

function transitionMatches(
  transition: NonNullable<FlowStep["transitions"]>[number],
  outputs: Record<string, unknown>
): boolean {
  const condition = transition.condition;
  if (!condition) return true;
  const actual = outputs[condition.output];
  switch (condition.operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "equals":
      return Object.is(actual, condition.value);
    case "not_equals":
      return !Object.is(actual, condition.value);
    case "in":
      return Array.isArray(condition.value) && condition.value.some((candidate) => Object.is(actual, candidate));
  }
}

function successfulNextSteps(ref: StepRef, outputs: Record<string, unknown>): string[] {
  return [...new Set([
    ...directChildren(ref),
    ...(ref.step.transitions ?? []).filter((transition) => transitionMatches(transition, outputs)).map((transition) => transition.to),
  ])];
}

export function allowedStepPaths(flow: AgentFlow, state: FlowExecutionState): string[] {
  if (state.status === "completed" || state.status === "failed") return [];
  const node = topic(flow, state.nodeId);
  if (!node || node.kind === "fallback") return [];
  if (!state.currentStep) return topicEntryStepPaths(flow, node.id);

  const current = findStep(flow, state.currentStep);
  if (!current) return [];
  if (state.completedSteps.includes(current.path)) return successfulNextSteps(current, state.outputs[current.path] ?? {});
  const attempts = state.attempts[current.path] ?? 0;
  return attempts >= (current.step.max_attempts ?? 3) && current.step.on_failure
    ? [current.step.on_failure]
    : [];
}

export function selectFlowTopic(
  flow: AgentFlow,
  state: FlowExecutionState,
  nodeId: string,
  now?: string
): FlowExecutionState | RuntimeError {
  const node = topic(flow, nodeId);
  if (!node) return { error: `unknown topic "${nodeId}"`, code: "unknown_topic" };
  if (node.kind === "topic" && flow.schema_version === 2 && !topicEntryStepPaths(flow, node.id).length) {
    return { error: `topic "${nodeId}" is reachable only through a flow transition`, code: "transition_only_topic" };
  }
  if (state.status === "active" && state.nodeId === nodeId) return state;
  if (
    state.status === "active" &&
    state.currentStep &&
    !state.completedSteps.includes(state.currentStep)
  ) {
    return {
      error: `complete or exhaust the active step "${state.currentStep}" before changing topics`,
      code: "active_step_incomplete",
      allowed: allowedStepPaths(flow, state),
    };
  }
  return updateState(state, { status: "active", nodeId: node.id, currentStep: null }, now);
}

export function grantedTools(flow: AgentFlow, state: FlowExecutionState): string[] {
  const grants = new Set(alwaysTools(flow));
  if (state.status === "completed" || state.status === "failed") return [...grants];
  const node = topic(flow, state.nodeId);
  for (const name of node?.tools ?? []) grants.add(name);
  if (state.currentStep && !state.completedSteps.includes(state.currentStep)) {
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
  if (state.status === "completed" || state.status === "failed") {
    return { error: "flow is already finished", code: "flow_finished" };
  }
  const ref = findStep(flow, path);
  if (!ref) return { error: `unknown step "${path}"`, code: "unknown_step", allowed: allowedStepPaths(flow, state) };

  const allowed = allowedStepPaths(flow, state);
  const isRetry = state.currentStep === path && !state.completedSteps.includes(path);
  if (ref.nodeId !== state.nodeId && !allowed.includes(path)) {
    return { error: `step "${path}" is outside the selected topic`, code: "wrong_topic", allowed };
  }
  if (!isRetry && !allowed.includes(path)) {
    return { error: `step "${path}" is not reachable from the current checkpoint`, code: "step_not_reachable", allowed };
  }

  const attempts = (state.attempts[path] ?? 0) + 1;
  if (attempts > (ref.step.max_attempts ?? 3)) {
    return { error: `step "${path}" exceeded its attempt limit`, code: "attempt_limit", allowed: ref.step.on_failure ? [ref.step.on_failure] : allowed };
  }
  const totalEntries = Object.values(state.attempts).reduce((sum, count) => sum + count, 0) + 1;
  if (flow.max_step_entries && totalEntries > flow.max_step_entries) {
    return {
      error: `flow exceeded its ${flow.max_step_entries}-entry circuit breaker`,
      code: "flow_entry_limit",
      allowed: [],
    };
  }
  const outputs = { ...state.outputs };
  delete outputs[path];
  const nextState = updateState(state, {
    status: "active",
    nodeId: ref.nodeId,
    currentStep: path,
    completedSteps: state.completedSteps.filter((completed) => completed !== path),
    attempts: { ...state.attempts, [path]: attempts },
    outputs,
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
  if (path && state.completedSteps.includes(path)) {
    return { state, nextSteps: allowedStepPaths(flow, state) };
  }
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
  const active = ref && !state.completedSteps.includes(ref.path) ? ref : undefined;
  return {
    status: state.status,
    topic: state.nodeId,
    current_step: active?.path ?? null,
    last_completed_step: !active && ref ? ref.path : null,
    instructions: active?.step.instructions,
    success_criteria: active?.step.success_criteria ?? [],
    required_outputs: active?.step.required_outputs ?? [],
    available_tools: grantedTools(flow, state),
    next_steps: describeNextSteps(flow, state),
    completed_steps: state.completedSteps,
    checkpoints: state.checkpoints,
    revision: state.revision,
  };
}

export function describeNextSteps(flow: AgentFlow, state: FlowExecutionState) {
  const current = state.currentStep ? findStep(flow, state.currentStep) : undefined;
  return allowedStepPaths(flow, state).map((path) => {
    const ref = findStep(flow, path);
    const transition = current?.step.transitions?.find((candidate) => candidate.to === path);
    const failure = current?.step.on_failure === path && !state.completedSteps.includes(current.path);
    return {
      path,
      label: ref?.step.label ?? path,
      ...(ref?.step.context ? { context: ref.step.context } : {}),
      kind: failure ? "failure" : transition ? "transition" : current ? "child" : "entry",
      ...(failure ? { when: `the active step cannot succeed within ${current?.step.max_attempts ?? 3} attempts` } : {}),
      ...(transition?.when ? { when: transition.when } : {}),
      ...(transition?.condition ? { condition: transition.condition } : {}),
    };
  });
}
