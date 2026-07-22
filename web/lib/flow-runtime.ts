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

const FLOW_ACTION_INVOCATION_ID = /^[A-Za-z0-9_-]{24}$/;
export const MAX_FLOW_ACTION_RECEIPTS_PER_CALL = 512;
export const MAX_FLOW_ACTION_ARGUMENT_BYTES = 32 * 1024;
export const MAX_FLOW_ACTION_RESULT_BYTES = 64 * 1024;
export const MAX_FLOW_ACTION_ERROR_BYTES = 16 * 1024;
export const MAX_FLOW_HOT_STATE_BYTES = 8 * 1024 * 1024;

/**
 * Derives the opaque, provider-neutral identity forwarded to an integration.
 * Callers must include the call/session scope in `stableIdentity`; provider call IDs alone are
 * not globally unique. Eighteen digest bytes encode to exactly 24 unpadded base64url characters.
 */
export function deriveFlowActionInvocationId(stableIdentity: string): string {
  if (!stableIdentity || stableIdentity.length > 2_048) {
    throw new Error("stable action identity must contain 1 to 2048 characters");
  }
  return createHash("sha256")
    .update("hacc/flow-action-invocation/v1\0", "utf8")
    .update(stableIdentity, "utf8")
    .digest()
    .subarray(0, 18)
    .toString("base64url");
}

export const FlowActionReceiptSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  step: z.string().min(1),
  tool: z.string().min(1),
  capabilityEpoch: z.number().int().nonnegative(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  argumentsBytes: z.number().int().nonnegative().optional(),
  argumentsCompacted: z.literal(true).optional(),
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Server-generated identity propagated to integrations; the provider cannot choose it. */
  invocationId: z.string().regex(FLOW_ACTION_INVOCATION_ID).optional(),
  /** Provider request correlation is only a call-scoped replay key, never downstream authority. */
  providerInvocationId: z.string().min(1).max(256).optional(),
  dispatchStartedAt: z.iso.datetime().optional(),
  dispatchAttempt: z.number().int().nonnegative().optional(),
  reconciliationProofId: z.string().min(1).optional(),
  status: z.enum(["reserved", "succeeded", "failed", "indeterminate"]),
  result: z.unknown().optional(),
  resultBytes: z.number().int().nonnegative().optional(),
  resultCompacted: z.literal(true).optional(),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  error: z.string().optional(),
  reservedAt: z.iso.datetime(),
  settledAt: z.iso.datetime().optional(),
}).strict();

export type FlowActionReceipt = z.infer<typeof FlowActionReceiptSchema>;

export const FlowExecutionStateSchema = z.object({
  version: z.literal(2),
  status: z.enum(["routing", "active", "completed", "failed"]),
  nodeId: z.string().nullable(),
  currentStep: z.string().nullable(),
  completedSteps: z.array(z.string()),
  /** Total step admissions across successful cycles and retries; absent on legacy persisted state. */
  stepEntries: z.number().int().nonnegative().optional(),
  attempts: z.record(z.string(), z.number().int().nonnegative()),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
  checkpoints: z.array(z.object({ step: z.string(), at: z.iso.datetime() }).strict()),
  /** Changes only when the active capability set changes, never for receipt writes. */
  capabilityEpoch: z.number().int().nonnegative().default(0),
  /** Embedded receipts keep the pure runtime replayable; production also persists an atomic ledger. */
  actionReceipts: z.array(FlowActionReceiptSchema).default([]),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
}).strict().superRefine((state, ctx) => {
  const duplicate = (values: readonly string[]) => values.find((value, index) => values.indexOf(value) !== index);
  const duplicateCompleted = duplicate(state.completedSteps);
  if (duplicateCompleted) {
    ctx.addIssue({ code: "custom", path: ["completedSteps"], message: `duplicate completed step "${duplicateCompleted}"` });
  }
  if (state.status === "routing" && (state.nodeId !== null || state.currentStep !== null)) {
    ctx.addIssue({ code: "custom", message: "routing state cannot retain a topic or active step" });
  }
  if (state.status === "active" && state.nodeId === null) {
    ctx.addIssue({ code: "custom", path: ["nodeId"], message: "active state requires a selected topic" });
  }
  if ((state.status === "completed" || state.status === "failed") && state.currentStep !== null) {
    ctx.addIssue({ code: "custom", path: ["currentStep"], message: "terminal state cannot retain an active step" });
  }
  for (const step of state.completedSteps) {
    if (!Object.prototype.hasOwnProperty.call(state.outputs, step)) {
      ctx.addIssue({ code: "custom", path: ["outputs", step], message: "completed step is missing its durable output record" });
    }
  }
  for (const step of Object.keys(state.outputs)) {
    if (!state.completedSteps.includes(step)) {
      ctx.addIssue({ code: "custom", path: ["outputs", step], message: "output record belongs to an incomplete step" });
    }
    try {
      hashFlowValue(state.outputs[step]);
    } catch (error) {
      ctx.addIssue({ code: "custom", path: ["outputs", step], message: (error as Error).message });
    }
  }
  for (const [index, checkpoint] of state.checkpoints.entries()) {
    if (!state.completedSteps.includes(checkpoint.step)) {
      ctx.addIssue({ code: "custom", path: ["checkpoints", index], message: "checkpoint belongs to an incomplete step" });
    }
  }

  const receiptIds = new Set<string>();
  const invocationIds = new Set<string>();
  const providerInvocationIds = new Set<string>();
  for (const [index, receipt] of state.actionReceipts.entries()) {
    const path = ["actionReceipts", index] as (string | number)[];
    if (receiptIds.has(receipt.id)) {
      ctx.addIssue({ code: "custom", path: [...path, "id"], message: "duplicate action receipt identity" });
    }
    receiptIds.add(receipt.id);
    if (receipt.invocationId) {
      if (invocationIds.has(receipt.invocationId)) {
        ctx.addIssue({ code: "custom", path: [...path, "invocationId"], message: "duplicate downstream invocation identity" });
      }
      invocationIds.add(receipt.invocationId);
    }
    if (receipt.providerInvocationId) {
      if (providerInvocationIds.has(receipt.providerInvocationId)) {
        ctx.addIssue({ code: "custom", path: [...path, "providerInvocationId"], message: "duplicate provider invocation identity" });
      }
      providerInvocationIds.add(receipt.providerInvocationId);
    }
    if (receipt.arguments === undefined) {
      if (!receipt.argumentsCompacted || receipt.argumentsBytes === undefined ||
          receipt.status === "reserved" || receipt.status === "indeterminate") {
        ctx.addIssue({ code: "custom", path: [...path, "arguments"], message: "unsettled action arguments cannot be compacted" });
      }
    } else {
      try {
        const bytes = flowJsonBytes(receipt.arguments);
        if (hashFlowValue(receipt.arguments) !== receipt.argumentsHash) {
          ctx.addIssue({ code: "custom", path: [...path, "argumentsHash"], message: "action argument evidence hash is invalid" });
        }
        if (receipt.argumentsBytes !== undefined && receipt.argumentsBytes !== bytes) {
          ctx.addIssue({ code: "custom", path: [...path, "argumentsBytes"], message: "action argument byte evidence is invalid" });
        }
      } catch (error) {
        ctx.addIssue({ code: "custom", path: [...path, "arguments"], message: (error as Error).message });
      }
      if (receipt.argumentsCompacted) {
        ctx.addIssue({ code: "custom", path: [...path, "argumentsCompacted"], message: "action arguments cannot be both present and compacted" });
      }
    }
    const hasResult = Object.prototype.hasOwnProperty.call(receipt, "result");
    if (receipt.resultCompacted && (hasResult || !receipt.resultHash || receipt.status !== "succeeded")) {
      ctx.addIssue({ code: "custom", path: [...path, "resultCompacted"], message: "compacted result evidence is invalid" });
    } else if (!receipt.resultCompacted && hasResult !== (receipt.resultHash !== undefined)) {
      ctx.addIssue({ code: "custom", path: [...path, "resultHash"], message: "action result and its evidence hash must be present together" });
    } else if (hasResult) {
      try {
        const bytes = flowJsonBytes(receipt.result);
        if (hashFlowValue(receipt.result) !== receipt.resultHash) {
          ctx.addIssue({ code: "custom", path: [...path, "resultHash"], message: "action result evidence hash is invalid" });
        }
        if (receipt.resultBytes !== undefined && receipt.resultBytes !== bytes) {
          ctx.addIssue({ code: "custom", path: [...path, "resultBytes"], message: "action result byte evidence is invalid" });
        }
      } catch (error) {
        ctx.addIssue({ code: "custom", path: [...path, "result"], message: (error as Error).message });
      }
    }
    if (receipt.dispatchStartedAt && (receipt.dispatchAttempt ?? 0) < 1) {
      ctx.addIssue({ code: "custom", path: [...path, "dispatchAttempt"], message: "dispatched action needs a positive attempt count" });
    }
    if (!receipt.dispatchStartedAt && (receipt.dispatchAttempt ?? 0) !== 0) {
      ctx.addIssue({ code: "custom", path: [...path, "dispatchAttempt"], message: "undispatched action cannot have dispatch attempts" });
    }
    if ((receipt.status === "succeeded" || receipt.status === "indeterminate") && !receipt.dispatchStartedAt) {
      ctx.addIssue({ code: "custom", path: [...path, "dispatchStartedAt"], message: `${receipt.status} action is missing its dispatch boundary` });
    }
    if ((receipt.status === "reserved") === (receipt.settledAt !== undefined)) {
      ctx.addIssue({ code: "custom", path: [...path, "settledAt"], message: "receipt status and settlement timestamp disagree" });
    }
    if (receipt.reconciliationProofId && receipt.status !== "succeeded" && receipt.status !== "failed") {
      ctx.addIssue({
        code: "custom",
        path: [...path, "reconciliationProofId"],
        message: "only proof-resolved receipts may carry reconciliation evidence",
      });
    }
    if (receipt.reconciliationProofId && receipt.status === "failed" && hasResult) {
      ctx.addIssue({
        code: "custom",
        path: [...path, "result"],
        message: "authoritatively absent actions cannot carry a committed result",
      });
    }
  }
});

export type FlowExecutionState = z.infer<typeof FlowExecutionStateSchema>;

export type RuntimeError = { error: string; code: string; allowed?: string[] };

export function flowJsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

export function flowStateStorageBytes(state: FlowExecutionState): number {
  return flowJsonBytes(state);
}

function flowStateBudgetError(state: FlowExecutionState): RuntimeError | null {
  if (state.actionReceipts.length > MAX_FLOW_ACTION_RECEIPTS_PER_CALL) {
    return {
      error: `flow reached its ${MAX_FLOW_ACTION_RECEIPTS_PER_CALL}-receipt durable storage limit`,
      code: "flow_receipt_quota_exceeded",
    };
  }
  if (flowStateStorageBytes(state) > MAX_FLOW_HOT_STATE_BYTES) {
    return {
      error: `flow state exceeded its ${MAX_FLOW_HOT_STATE_BYTES}-byte durable storage limit`,
      code: "flow_state_storage_quota_exceeded",
    };
  }
  return null;
}

/** Removes replay payloads only after a step is durably complete; hashes and identities remain. */
function compactCompletedStepReceipts(
  receipts: readonly FlowActionReceipt[],
  completedStep: string
): FlowActionReceipt[] {
  return receipts.map((receipt) => {
    if (receipt.step !== completedStep ||
        (receipt.status !== "succeeded" && receipt.status !== "failed")) return receipt;
    const compacted: FlowActionReceipt = {
      ...receipt,
      ...(receipt.arguments !== undefined
        ? { argumentsBytes: receipt.argumentsBytes ?? flowJsonBytes(receipt.arguments), argumentsCompacted: true as const }
        : {}),
      ...(receipt.result !== undefined
        ? { resultBytes: receipt.resultBytes ?? flowJsonBytes(receipt.result), resultCompacted: true as const }
        : {}),
    };
    delete compacted.arguments;
    delete compacted.result;
    return compacted;
  });
}

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
    stepEntries: 0,
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

/**
 * Rotate grants when a host-owned policy changes the visible catalog without
 * changing the active Flow node. The normal transition helpers already call
 * updateCapabilities; this explicit boundary is for independently attested
 * policy changes such as turn-aware action readiness.
 */
export function rotateFlowCapabilityEpoch(
  state: FlowExecutionState,
  now?: string
): FlowExecutionState {
  return updateCapabilities(state, {}, now);
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
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("flow values must contain only JSON objects and arrays");
    }
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
  const present = Object.prototype.hasOwnProperty.call(outputs, condition.output);
  const actual = outputs[condition.output];
  switch (condition.operator) {
    case "exists":
      return present && actual !== undefined && actual !== null;
    case "equals":
      return present && valuesEqual(actual, condition.value);
    case "not_equals":
      return present && !valuesEqual(actual, condition.value);
    case "in":
      return present && Array.isArray(condition.value) && condition.value.some((candidate) => valuesEqual(actual, candidate));
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
  if (state.status === "completed" || state.status === "failed") {
    return { error: "flow is already finished", code: "flow_finished" };
  }
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
  if (state.status === "active" && state.currentStep) {
    const pending = allowedStepPaths(flow, state);
    if (pending.length) {
      return {
        error: `enter the pending flow transition before changing topics`,
        code: "pending_flow_transition",
        allowed: pending,
      };
    }
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
  const incompleteAncestor = ref.ancestors
    .map((_ancestor, index) => ref.path.split(".").slice(0, index + 2).join("."))
    .find((ancestorPath) => !state.completedSteps.includes(ancestorPath));
  if (incompleteAncestor) {
    return {
      error: `step "${path}" cannot inherit authority from incomplete ancestor "${incompleteAncestor}"`,
      code: "ancestor_step_incomplete",
      allowed,
    };
  }

  // A successful transition back to the same path starts a new iteration, not another retry.
  // Consecutive retries of the still-active step continue to consume max_attempts.
  const attempts = isRetry ? (state.attempts[path] ?? 0) + 1 : 1;
  if (attempts > (ref.step.max_attempts ?? 3)) {
    return { error: `step "${path}" exceeded its attempt limit`, code: "attempt_limit", allowed: ref.step.on_failure ? [ref.step.on_failure] : allowed };
  }
  const totalEntries = (
    state.stepEntries ??
    // Legacy state did not distinguish completed iterations from retries. Preserve the
    // conservative historical lower bound, then use the monotonic counter from this entry on.
    Object.values(state.attempts).reduce((sum, count) => sum + count, 0)
  ) + 1;
  if (flow.max_step_entries && totalEntries > flow.max_step_entries) {
    return {
      error: `flow exceeded its ${flow.max_step_entries}-entry circuit breaker`,
      code: "flow_entry_limit",
      allowed: [],
    };
  }
  const inReenteredSubtree = (candidate: string) => candidate === path || candidate.startsWith(`${path}.`);
  const outputs = Object.fromEntries(
    Object.entries(state.outputs).filter(([candidate]) => !inReenteredSubtree(candidate))
  );
  const nextState = updateCapabilities(state, {
    status: "active",
    nodeId: ref.nodeId,
    currentStep: path,
    completedSteps: state.completedSteps.filter((completed) => !inReenteredSubtree(completed)),
    stepEntries: totalEntries,
    attempts: { ...state.attempts, [path]: attempts },
    outputs,
    checkpoints: state.checkpoints.filter((checkpoint) => !inReenteredSubtree(checkpoint.step)),
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
    /** Opaque gateway-derived identity forwarded to the downstream integration. */
    invocationId: string;
    tool: string;
    arguments: Record<string, unknown>;
    capabilityEpoch: number;
    providerInvocationId?: string;
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
  if (!FLOW_ACTION_INVOCATION_ID.test(args.invocationId)) {
    return {
      error: "action invocation identity must be exactly 24 base64url characters",
      code: "invalid_invocation_identity",
    };
  }
  if (args.providerInvocationId !== undefined && (args.providerInvocationId.length < 1 || args.providerInvocationId.length > 256)) {
    return { error: "provider invocation identity is invalid", code: "invalid_invocation_identity" };
  }
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
  let argumentsBytes: number;
  try {
    argumentsHash = hashFlowValue(args.arguments);
    argumentsBytes = flowJsonBytes(args.arguments);
  } catch (error) {
    return { error: (error as Error).message, code: "invalid_arguments" };
  }
  if (argumentsBytes > MAX_FLOW_ACTION_ARGUMENT_BYTES) {
    return {
      error: `action arguments exceed the ${MAX_FLOW_ACTION_ARGUMENT_BYTES}-byte durable storage limit`,
      code: "action_arguments_too_large",
    };
  }
  const semanticIdentityMatches = (receipt: FlowActionReceipt): boolean =>
    receipt.tool === args.tool &&
    receipt.argumentsHash === argumentsHash &&
    receipt.step === scope.step;
  const exactReceipt = state.actionReceipts.find((receipt) => receipt.id === args.receiptId);
  if (exactReceipt) {
    if (exactReceipt.invocationId !== args.invocationId || !semanticIdentityMatches(exactReceipt)) {
      return {
        error: "receipt identity was replayed with different action semantics",
        code: "receipt_identity_conflict",
      };
    }
    return {
      state,
      receipt: exactReceipt,
      execute: false,
      replayed: exactReceipt.status === "succeeded",
    };
  }
  const exactInvocation = state.actionReceipts.find((receipt) =>
    receipt.invocationId === args.invocationId
  );
  if (exactInvocation) {
    if (!semanticIdentityMatches(exactInvocation)) {
      return {
        error: "action invocation identity was replayed with different action semantics",
        code: "invocation_identity_conflict",
      };
    }
    return {
      state,
      receipt: exactInvocation,
      execute: false,
      replayed: exactInvocation.status === "succeeded",
    };
  }
  if (args.providerInvocationId) {
    const delivered = state.actionReceipts.find((receipt) =>
      receipt.providerInvocationId === args.providerInvocationId
    );
    if (delivered) {
      if (
        delivered.invocationId !== args.invocationId ||
        !semanticIdentityMatches(delivered)
      ) {
        return {
          error: "provider invocation identity was replayed with different action semantics",
          code: "invocation_identity_conflict",
        };
      }
      return {
        state,
        receipt: delivered,
        execute: false,
        replayed: delivered.status === "succeeded",
      };
    }
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
  if (state.actionReceipts.length >= MAX_FLOW_ACTION_RECEIPTS_PER_CALL) {
    return {
      error: `flow reached its ${MAX_FLOW_ACTION_RECEIPTS_PER_CALL}-receipt durable storage limit`,
      code: "flow_receipt_quota_exceeded",
    };
  }

  const receipt: FlowActionReceipt = {
    id: args.receiptId,
    idempotencyKey,
    step: scope.step,
    tool: args.tool,
    capabilityEpoch: state.capabilityEpoch,
    arguments: structuredClone(args.arguments),
    argumentsBytes,
    argumentsHash,
    invocationId: args.invocationId,
    ...(args.providerInvocationId ? { providerInvocationId: args.providerInvocationId } : {}),
    status: "reserved",
    reservedAt: nowIso(now),
  };
  const nextState = updateState(state, { actionReceipts: [...state.actionReceipts, receipt] }, now);
  const budgetError = flowStateBudgetError(nextState);
  if (budgetError) return budgetError;
  return {
    state: nextState,
    receipt,
    execute: true,
    replayed: false,
  };
}

/** Persists the one-way dispatch boundary before any integration receives the request. */
export function markFlowActionDispatchStarted(
  state: FlowExecutionState,
  args: { receiptId: string },
  now?: string
): { state: FlowExecutionState; receipt: FlowActionReceipt } | RuntimeError {
  const index = state.actionReceipts.findIndex((receipt) => receipt.id === args.receiptId);
  if (index < 0) return { error: `unknown action receipt "${args.receiptId}"`, code: "unknown_receipt" };
  const current = state.actionReceipts[index];
  if (current.status !== "reserved") {
    return { error: `action receipt "${args.receiptId}" is not dispatchable`, code: "receipt_not_dispatchable" };
  }
  if (current.dispatchStartedAt) {
    return { error: `action receipt "${args.receiptId}" already crossed the dispatch boundary`, code: "dispatch_already_started" };
  }
  const receipt: FlowActionReceipt = {
    ...current,
    dispatchStartedAt: nowIso(now),
    dispatchAttempt: (current.dispatchAttempt ?? 0) + 1,
  };
  const actionReceipts = [...state.actionReceipts];
  actionReceipts[index] = receipt;
  return { state: updateState(state, { actionReceipts }, now), receipt };
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
  let resultHash: string | undefined;
  let resultBytes: number | undefined;
  if (args.error !== undefined && flowJsonBytes({ message: args.error }) > MAX_FLOW_ACTION_ERROR_BYTES) {
    return {
      error: `action error exceeds the ${MAX_FLOW_ACTION_ERROR_BYTES}-byte durable storage limit`,
      code: "action_error_too_large",
    };
  }
  if (args.result !== undefined) {
    try {
      resultHash = hashFlowValue(args.result);
      resultBytes = flowJsonBytes(args.result);
    } catch (error) {
      return { error: (error as Error).message, code: "invalid_result" };
    }
    if (resultBytes > MAX_FLOW_ACTION_RESULT_BYTES) {
      return {
        error: `action result exceeds the ${MAX_FLOW_ACTION_RESULT_BYTES}-byte durable storage limit`,
        code: "action_result_too_large",
      };
    }
  }
  if (current.status !== "reserved") {
    const exactReplay = current.status === args.status &&
      current.resultHash === resultHash &&
      current.error === (args.error || undefined);
    return exactReplay
      ? { state, receipt: current }
      : {
          error: `terminal receipt "${args.receiptId}" cannot be rewritten with a different outcome`,
          code: "receipt_settlement_conflict",
        };
  }
  if ((args.status === "succeeded" || args.status === "indeterminate") && !current.dispatchStartedAt) {
    return {
      error: `action receipt "${args.receiptId}" has not crossed the durable dispatch boundary`,
      code: "dispatch_not_started",
    };
  }
  const receipt: FlowActionReceipt = {
    ...current,
    status: args.status,
    ...(args.result !== undefined ? { result: structuredClone(args.result), resultHash, resultBytes } : {}),
    ...(args.error ? { error: args.error } : {}),
    settledAt: nowIso(now),
  };
  const actionReceipts = [...state.actionReceipts];
  actionReceipts[index] = receipt;
  const nextState = updateState(state, { actionReceipts }, now);
  const budgetError = flowStateBudgetError(nextState);
  return budgetError ?? { state: nextState, receipt };
}

/** The only legal promotion for an ambiguous action: exact, persisted read-back proof. */
export function promoteIndeterminateFlowAction(
  state: FlowExecutionState,
  args: { receiptId: string; proofId: string; result: unknown },
  now?: string
): { state: FlowExecutionState; receipt: FlowActionReceipt } | RuntimeError {
  const index = state.actionReceipts.findIndex((receipt) => receipt.id === args.receiptId);
  if (index < 0) return { error: `unknown action receipt "${args.receiptId}"`, code: "unknown_receipt" };
  const current = state.actionReceipts[index];
  if (current.status !== "indeterminate") {
    return { error: "only an indeterminate action can be reconciled", code: "receipt_not_indeterminate" };
  }
  if (!current.dispatchStartedAt) {
    return { error: "indeterminate action is missing its dispatch boundary", code: "receipt_dispatch_boundary_missing" };
  }
  let resultHash: string;
  let resultBytes: number;
  try {
    resultHash = hashFlowValue(args.result);
    resultBytes = flowJsonBytes(args.result);
  } catch (error) {
    return { error: (error as Error).message, code: "invalid_result" };
  }
  if (resultBytes > MAX_FLOW_ACTION_RESULT_BYTES) {
    return {
      error: `action result exceeds the ${MAX_FLOW_ACTION_RESULT_BYTES}-byte durable storage limit`,
      code: "action_result_too_large",
    };
  }
  const receipt: FlowActionReceipt = {
    ...current,
    status: "succeeded",
    result: structuredClone(args.result),
    resultHash,
    resultBytes,
    reconciliationProofId: args.proofId,
    settledAt: nowIso(now),
  };
  const actionReceipts = [...state.actionReceipts];
  actionReceipts[index] = receipt;
  const nextState = updateState(state, { actionReceipts }, now);
  const budgetError = flowStateBudgetError(nextState);
  return budgetError ?? { state: nextState, receipt };
}

/**
 * The only retry-safe resolution for an ambiguous mutation: an exact persisted proof that the
 * gateway invocation is authoritatively absent downstream. Timeouts, pending states, and
 * unrecognized responses remain indeterminate.
 */
export function proveIndeterminateFlowActionAbsent(
  state: FlowExecutionState,
  args: { receiptId: string; proofId: string },
  now?: string
): { state: FlowExecutionState; receipt: FlowActionReceipt } | RuntimeError {
  const index = state.actionReceipts.findIndex((receipt) => receipt.id === args.receiptId);
  if (index < 0) return { error: `unknown action receipt "${args.receiptId}"`, code: "unknown_receipt" };
  const current = state.actionReceipts[index];
  if (current.status !== "indeterminate") {
    return { error: "only an indeterminate action can be reconciled", code: "receipt_not_indeterminate" };
  }
  if (!current.dispatchStartedAt) {
    return { error: "indeterminate action is missing its dispatch boundary", code: "receipt_dispatch_boundary_missing" };
  }
  if (!args.proofId) {
    return { error: "authoritative absence requires a proof identity", code: "invalid_reconciliation_proof" };
  }
  const receipt: FlowActionReceipt = {
    ...current,
    status: "failed",
    error: "authoritative read-back proved this invocation was not committed",
    reconciliationProofId: args.proofId,
    settledAt: nowIso(now),
  };
  const actionReceipts = [...state.actionReceipts];
  actionReceipts[index] = receipt;
  return { state: updateState(state, { actionReceipts }, now), receipt };
}

/** Crash recovery never redispatches receipts that may have crossed the network boundary. */
export function markStaleDispatchedActionsIndeterminate(
  state: FlowExecutionState,
  receiptIds: readonly string[],
  now?: string
): FlowExecutionState {
  const stale = new Set(receiptIds);
  let changed = false;
  const actionReceipts = state.actionReceipts.map((receipt) => {
    if (!stale.has(receipt.id) || receipt.status !== "reserved" || !receipt.dispatchStartedAt) {
      return receipt;
    }
    changed = true;
    return {
      ...receipt,
      status: "indeterminate" as const,
      error: "dispatch owner expired after the action crossed the durable dispatch boundary",
      settledAt: nowIso(now),
    };
  });
  return changed ? updateState(state, { actionReceipts }, now) : state;
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function safeFlowOutputKey(key: string): boolean {
  return key.length > 0 && !UNSAFE_PATH_SEGMENTS.has(key);
}

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

export type FlowBoundArgumentEvidence = Readonly<{
  argument: string;
  source_kind: "receipt_result";
  source_tool: string;
  source_step: string;
  source_receipt_id: string;
  source_receipt_result_hash: string;
  result_path: string;
}>;

export type FlowBoundArgumentResolution = Readonly<{
  modelArguments: Readonly<Record<string, unknown>>;
  effectiveArguments: Readonly<Record<string, unknown>>;
  evidence: readonly FlowBoundArgumentEvidence[];
}>;

/**
 * Resolves operator-declared arguments from authoritative receipts before action admission.
 * The model cannot name a receipt, provide the bound value, or reach across step attempts.
 */
export function resolveFlowBoundArguments(
  flow: AgentFlow,
  state: FlowExecutionState,
  tool: string,
  modelArguments: Readonly<Record<string, unknown>>
): FlowBoundArgumentResolution | RuntimeError {
  const stepPath = state.currentStep;
  if (!stepPath || state.completedSteps.includes(stepPath)) {
    return { error: "receipt-bound arguments require an active step", code: "bound_argument_no_active_step" };
  }
  const ref = findStep(flow, stepPath);
  if (!ref) return { error: `unknown active step "${stepPath}"`, code: "unknown_step" };
  const policy = ref.step.action_policies?.find((candidate) => candidate.tool === tool);
  const bindings = policy?.bound_arguments ?? [];
  if (bindings.length === 0) {
    return {
      modelArguments: structuredClone(modelArguments),
      effectiveArguments: structuredClone(modelArguments),
      evidence: Object.freeze([]),
    };
  }

  const effectiveArguments = structuredClone(modelArguments) as Record<string, unknown>;
  const evidence: FlowBoundArgumentEvidence[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.argument)) {
      return { error: `bound argument "${binding.argument}" is declared more than once`, code: "invalid_bound_argument_declaration" };
    }
    seen.add(binding.argument);
    if (Object.prototype.hasOwnProperty.call(modelArguments, binding.argument)) {
      return {
        error: `model must not supply host-bound argument "${binding.argument}"`,
        code: "bound_argument_override",
      };
    }
    const candidates = state.actionReceipts.filter((receipt) =>
      receipt.status === "succeeded"
      && receipt.step === stepPath
      && receipt.capabilityEpoch === state.capabilityEpoch
      && receipt.tool === binding.source.tool
    );
    if (candidates.length > 1) {
      return {
        error: `bound argument "${binding.argument}" has ambiguous current-step receipt authority`,
        code: "ambiguous_bound_argument_source",
      };
    }
    const receipt = candidates[0];
    if (!receipt) {
      const stale = state.actionReceipts.some((candidate) =>
        candidate.status === "succeeded" && candidate.tool === binding.source.tool
      );
      return stale
        ? { error: `bound argument "${binding.argument}" has only stale receipt authority`, code: "stale_bound_argument_source" }
        : { error: `bound argument "${binding.argument}" is missing successful receipt authority`, code: "missing_bound_argument_source" };
    }
    if (receipt.result === undefined || !receipt.resultHash || receipt.resultCompacted) {
      return {
        error: `bound argument "${binding.argument}" source receipt has no live authoritative result`,
        code: "missing_bound_argument_source",
      };
    }
    const resolved = resultAtPath(receipt.result, binding.source.result_path);
    if (!resolved.found) {
      return {
        error: `bound argument "${binding.argument}" source path is absent or unsafe`,
        code: "missing_bound_argument_output",
      };
    }
    try {
      hashFlowValue(resolved.value);
    } catch {
      return { error: `bound argument "${binding.argument}" is not finite JSON`, code: "invalid_bound_argument_output" };
    }
    effectiveArguments[binding.argument] = structuredClone(resolved.value);
    evidence.push(Object.freeze({
      argument: binding.argument,
      source_kind: "receipt_result",
      source_tool: binding.source.tool,
      source_step: stepPath,
      source_receipt_id: receipt.id,
      source_receipt_result_hash: receipt.resultHash,
      result_path: binding.source.result_path,
    }));
  }
  return Object.freeze({
    modelArguments: Object.freeze(structuredClone(modelArguments)),
    effectiveArguments: Object.freeze(effectiveArguments),
    evidence: Object.freeze(evidence),
  });
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
  if (!path || path !== state.currentStep) return { error: "complete_step must target the active step", code: "not_active_step" };
  if (state.completedSteps.includes(path)) {
    return { state, nextSteps: allowedStepPaths(flow, state) };
  }
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
  if (supplied === null || Array.isArray(supplied) || typeof supplied !== "object") {
    return { error: "step outputs must be a JSON object", code: "invalid_outputs" };
  }
  const unsafeOutput = Object.keys(supplied).find((key) => !safeFlowOutputKey(key));
  if (unsafeOutput) {
    return { error: `step output key "${unsafeOutput}" is unsafe`, code: "invalid_outputs" };
  }
  try {
    hashFlowValue(supplied);
  } catch (error) {
    return { error: (error as Error).message, code: "invalid_outputs" };
  }
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
    actionReceipts: compactCompletedStepReceipts(state.actionReceipts, path),
  };
  const nextSteps = allowedStepPaths(flow, candidate);
  const nextState = updateCapabilities(state, {
    completedSteps,
    outputs: candidate.outputs,
    checkpoints,
    actionReceipts: candidate.actionReceipts,
    ...(nextSteps.length ? {} : { status: "completed" as const, currentStep: null }),
  }, now);
  const budgetError = flowStateBudgetError(nextState);
  return budgetError ?? { state: nextState, nextSteps };
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
