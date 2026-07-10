// Deterministic, provider-neutral execution state for deeply nested voice flows.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  alwaysActionPolicies,
  alwaysTools,
  findStep,
  topicEntryStepPaths,
  type AgentFlow,
  type FlowNode,
  type FlowStep,
  type StepRef,
} from "./flow";

export const FlowActionReceiptSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  step: z.string().min(1),
  tool: z.string().min(1),
  capabilityEpoch: z.number().int().nonnegative(),
  arguments: z.record(z.string(), z.unknown()),
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["reserved", "succeeded", "failed", "indeterminate"]),
  result: z.unknown().optional(),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  error: z.string().optional(),
  reservedAt: z.string(),
  settledAt: z.string().optional(),
});

export type FlowActionReceipt = z.infer<typeof FlowActionReceiptSchema>;

export const FlowExecutionStateSchema = z.object({
  version: z.literal(2),
  status: z.enum(["routing", "active", "completed", "failed"]),
  nodeId: z.string().nullable(),
  currentStep: z.string().nullable(),
  completedSteps: z.array(z.string()),
  attempts: z.record(z.string(), z.number().int().nonnegative()),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
  checkpoints: z.array(z.object({ step: z.string(), at: z.string() })),
  /** Changes only when the active capability set changes, never for receipt writes. */
  capabilityEpoch: z.number().int().nonnegative().default(0),
  /** Embedded receipts keep the pure runtime replayable; production also persists an atomic ledger. */
  actionReceipts: z.array(FlowActionReceiptSchema).default([]),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export type FlowExecutionState = z.infer<typeof FlowExecutionStateSchema>;

export type RuntimeError = { error: string; code: string; allowed?: string[] };

export function flowCapabilityScope(state: FlowExecutionState): { step: string; attempt: number } {
  if (state.currentStep && !state.completedSteps.includes(state.currentStep)) {
    return { step: state.currentStep, attempt: state.attempts[state.currentStep] ?? 0 };
  }
  if (state.status === "completed" || state.status === "failed") {
    return { step: `$flow.${state.status}`, attempt: 0 };
  }
  return { step: state.nodeId ? `$flow.${state.nodeId}` : "$flow.routing", attempt: 0 };
}

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
    capabilityEpoch: 0,
    actionReceipts: [],
    revision: 0,
    updatedAt: nowIso(now),
  };
}

function updateCapabilities(
  state: FlowExecutionState,
  patch: Partial<FlowExecutionState>,
  now?: string
): FlowExecutionState {
  return updateState(state, { ...patch, capabilityEpoch: state.capabilityEpoch + 1 }, now);
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("action arguments must contain only finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("action arguments must not contain cycles");
    seen.add(value);
    const encoded = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return encoded;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("action arguments must not contain cycles");
    seen.add(value);
    const record = value as Record<string, unknown>;
    const encoded = `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new Error("action arguments must not contain undefined values");
      return `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`;
    }).join(",")}}`;
    seen.delete(value);
    return encoded;
  }
  throw new Error(`action arguments contain unsupported ${typeof value} value`);
}

/** Stable across object key order so provider retries derive the same semantic action key. */
export function hashFlowValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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
  return updateCapabilities(state, { status: "active", nodeId: node.id, currentStep: null }, now);
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

  const unresolved = state.currentStep && !state.completedSteps.includes(state.currentStep)
    ? state.actionReceipts.filter((receipt) =>
      receipt.step === state.currentStep
      && (receipt.status === "reserved" || receipt.status === "indeterminate")
    )
    : [];
  if (unresolved.length > 0) {
    return {
      error: `cannot leave or retry ${state.currentStep} while action receipts need settlement or reconciliation: ${unresolved.map((receipt) => receipt.id).join(", ")}`,
      code: "pending_action_evidence",
      allowed: [],
    };
  }

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
  const nextState = updateCapabilities(state, {
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

export type FlowActionReservation = {
  state: FlowExecutionState;
  receipt: FlowActionReceipt;
  /** Only the owner of a newly persisted reservation may dispatch the side effect. */
  execute: boolean;
  replayed: boolean;
};

function actionIdempotencyKey(
  step: string,
  attempt: number,
  tool: string,
  mode: "none" | "per_step" | "per_arguments" | "per_call" | "per_call_arguments",
  argumentsHash: string,
  receiptId: string
): string {
  const material = mode === "per_call"
    ? { tool }
    : mode === "per_call_arguments"
      ? { tool, argumentsHash }
      : mode === "per_step"
    ? { step, attempt, tool }
    : mode === "per_arguments"
      ? { step, attempt, tool, argumentsHash }
      : { step, tool, receiptId };
  return hashFlowValue(material);
}

/**
 * Pure admission phase for an action. Persist the returned state before executing anything.
 * A matching prior reservation is replayed without granting execution ownership.
 */
export function reserveFlowAction(
  flow: AgentFlow,
  state: FlowExecutionState,
  args: {
    receiptId: string;
    tool: string;
    arguments: Record<string, unknown>;
    capabilityEpoch: number;
  },
  now?: string
): FlowActionReservation | RuntimeError {
  if (args.capabilityEpoch !== state.capabilityEpoch) {
    return {
      error: `capability epoch ${args.capabilityEpoch} is stale; current epoch is ${state.capabilityEpoch}`,
      code: "stale_capability",
    };
  }
  if (!args.receiptId) return { error: "receipt id is required", code: "invalid_receipt" };
  const scope = flowCapabilityScope(state);
  const ref = state.currentStep && !state.completedSteps.includes(state.currentStep)
    ? findStep(flow, state.currentStep)
    : undefined;
  if (state.currentStep && !state.completedSteps.includes(state.currentStep) && !ref) {
    return { error: `unknown active step "${state.currentStep}"`, code: "unknown_step" };
  }
  if (!grantedTools(flow, state).includes(args.tool)) {
    return {
      error: `action "${args.tool}" is not granted at ${state.currentStep}`,
      code: "action_not_granted",
      allowed: grantedTools(flow, state),
    };
  }

  let argumentsHash: string;
  try {
    argumentsHash = hashFlowValue(args.arguments);
  } catch (error) {
    return { error: (error as Error).message, code: "invalid_arguments" };
  }
  const policy = ref?.step.action_policies?.find((candidate) => candidate.tool === args.tool)
    ?? alwaysActionPolicies(flow).find((candidate) => candidate.tool === args.tool);
  const mode = policy?.idempotency ?? "none";
  const callScoped = mode === "per_call" || mode === "per_call_arguments";
  const idempotencyKey = actionIdempotencyKey(
    scope.step,
    scope.attempt,
    args.tool,
    mode,
    argumentsHash,
    args.receiptId
  );
  const existing = state.actionReceipts.find((receipt) =>
    (callScoped || receipt.capabilityEpoch === state.capabilityEpoch) &&
    receipt.idempotencyKey === idempotencyKey &&
    receipt.status !== "failed"
  );
  if (existing) {
    return {
      state,
      receipt: existing,
      execute: false,
      replayed: existing.status === "succeeded",
    };
  }

  const admitted = state.actionReceipts.filter((receipt) =>
    (callScoped || (receipt.capabilityEpoch === state.capabilityEpoch && receipt.step === scope.step)) &&
    receipt.tool === args.tool &&
    receipt.status !== "failed"
  ).length;
  if (policy?.max_calls !== undefined && admitted >= policy.max_calls) {
    return {
      error: `action "${args.tool}" reached its ${policy.max_calls}-call limit for ${scope.step}`,
      code: "action_call_limit",
    };
  }

  const receipt: FlowActionReceipt = {
    id: args.receiptId,
    idempotencyKey,
    step: scope.step,
    tool: args.tool,
    capabilityEpoch: state.capabilityEpoch,
    arguments: structuredClone(args.arguments),
    argumentsHash,
    status: "reserved",
    reservedAt: nowIso(now),
  };
  return {
    state: updateState(state, { actionReceipts: [...state.actionReceipts, receipt] }, now),
    receipt,
    execute: true,
    replayed: false,
  };
}

/** Records the authoritative action outcome without changing the active capability set. */
export function settleFlowAction(
  state: FlowExecutionState,
  args: {
    receiptId: string;
    status: "succeeded" | "failed" | "indeterminate";
    result?: unknown;
    error?: string;
  },
  now?: string
): { state: FlowExecutionState; receipt: FlowActionReceipt } | RuntimeError {
  const index = state.actionReceipts.findIndex((receipt) => receipt.id === args.receiptId);
  if (index < 0) return { error: `unknown action receipt "${args.receiptId}"`, code: "unknown_receipt" };
  const current = state.actionReceipts[index];
  if (current.status !== "reserved") return { state, receipt: current };
  let resultHash: string | undefined;
  if (args.result !== undefined) {
    try {
      resultHash = hashFlowValue(args.result);
    } catch (error) {
      return { error: (error as Error).message, code: "invalid_result" };
    }
  }
  const receipt: FlowActionReceipt = {
    ...current,
    status: args.status,
    ...(args.result !== undefined ? { result: structuredClone(args.result), resultHash } : {}),
    ...(args.error ? { error: args.error } : {}),
    settledAt: nowIso(now),
  };
  const actionReceipts = [...state.actionReceipts];
  actionReceipts[index] = receipt;
  return { state: updateState(state, { actionReceipts }, now), receipt };
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function resultAtPath(result: unknown, path: string): { found: boolean; value?: unknown } {
  const normalized = path === "$" ? [] : path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current = result;
  for (const segment of normalized) {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) return { found: false };
    if (current === null || typeof current !== "object") return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function matchesValueType(value: unknown, type: NonNullable<FlowStep["output_bindings"]>[number]["value_type"]): boolean {
  if (!type) return true;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  try {
    return hashFlowValue(left) === hashFlowValue(right);
  } catch {
    return Object.is(left, right);
  }
}

function verifiedOutputs(
  state: FlowExecutionState,
  ref: StepRef,
  supplied: Record<string, unknown>
): { outputs: Record<string, unknown> } | RuntimeError {
  const outputs = { ...supplied };
  for (const binding of ref.step.output_bindings ?? []) {
    const policy = ref.step.action_policies?.find((candidate) => candidate.tool === binding.tool);
    const callScoped = policy?.idempotency === "per_call" || policy?.idempotency === "per_call_arguments";
    const candidates = state.actionReceipts.filter((candidate) =>
      candidate.status === "succeeded" &&
      candidate.step === ref.path &&
      candidate.tool === binding.tool &&
      (candidate.capabilityEpoch === state.capabilityEpoch || callScoped)
    );
    if (candidates.length > 1) {
      return {
        error: `output "${binding.output}" has ambiguous successful ${binding.tool} receipts: ${candidates.map((receipt) => receipt.id).join(", ")}`,
        code: "ambiguous_action_evidence",
      };
    }
    const receipt = candidates[0];
    if (!receipt) {
      return {
        error: `output "${binding.output}" requires a successful ${binding.tool} receipt from the active step attempt`,
        code: "missing_action_evidence",
      };
    }
    const resolved = resultAtPath(receipt.result, binding.result_path);
    if (!resolved.found) {
      return {
        error: `receipt ${receipt.id} has no safe result path "${binding.result_path}" for output "${binding.output}"`,
        code: "missing_receipt_output",
      };
    }
    if (!matchesValueType(resolved.value, binding.value_type)) {
      return {
        error: `receipt output "${binding.output}" does not match declared type ${binding.value_type}`,
        code: "receipt_output_type",
      };
    }
    if (Object.prototype.hasOwnProperty.call(supplied, binding.output) && !valuesEqual(supplied[binding.output], resolved.value)) {
      return {
        error: `model-supplied output "${binding.output}" does not match authoritative receipt ${receipt.id}`,
        code: "bound_output_mismatch",
      };
    }
    outputs[binding.output] = resolved.value;
  }
  return { outputs };
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
  const pending = state.actionReceipts.filter((receipt) =>
    receipt.step === ref.path &&
    (receipt.status === "reserved" || receipt.status === "indeterminate")
  );
  if (pending.length) {
    return {
      error: `cannot complete ${path} while action receipts need settlement or reconciliation: ${pending.map((receipt) => receipt.id).join(", ")}`,
      code: "pending_action_evidence",
    };
  }
  const supplied = args.outputs ?? {};
  const verified = verifiedOutputs(state, ref, supplied);
  if ("error" in verified) return verified;
  const outputs = verified.outputs;
  const missing = (ref.step.required_outputs ?? []).filter((key) => outputs[key] === undefined || outputs[key] === null);
  if (missing.length) return { error: `missing required outputs: ${missing.join(", ")}`, code: "missing_outputs" };

  const completedSteps = [...new Set([...state.completedSteps, path])];
  const checkpoints = ref.step.checkpoint
    ? [...state.checkpoints, { step: path, at: nowIso(now) }]
    : state.checkpoints;
  const candidate: FlowExecutionState = {
    ...state,
    completedSteps,
    outputs: { ...state.outputs, [path]: outputs },
    checkpoints,
  };
  const nextSteps = allowedStepPaths(flow, candidate);
  const nextState = updateCapabilities(state, {
    completedSteps,
    outputs: candidate.outputs,
    checkpoints,
    ...(nextSteps.length ? {} : { status: "completed" as const, currentStep: null }),
  }, now);
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
    outputs: state.outputs,
    checkpoints: state.checkpoints,
    capability_epoch: state.capabilityEpoch,
    action_receipts: state.actionReceipts.map((receipt) => ({
      id: receipt.id,
      step: receipt.step,
      tool: receipt.tool,
      capability_epoch: receipt.capabilityEpoch,
      status: receipt.status,
      arguments_hash: receipt.argumentsHash,
      result_hash: receipt.resultHash,
      reserved_at: receipt.reservedAt,
      settled_at: receipt.settledAt,
    })),
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
