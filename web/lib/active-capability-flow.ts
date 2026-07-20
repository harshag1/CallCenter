import {
  findStep,
  topicNodes,
  type AgentFlow,
} from "./flow";
import {
  allowedStepPaths,
  describeNextSteps,
  flowCapabilityScope,
  hashFlowValue,
  type FlowExecutionState,
} from "./flow-runtime";
import type { VoiceToolDefinition } from "./voice-tools";

const MAX_DISCLOSED_COMPLETED_STEPS = 8;
const MAX_DISCLOSED_CHECKPOINTS = 4;
const MAX_DISCLOSED_PENDING_RECEIPTS = 16;
const MAX_DISCLOSED_DURABLE_OUTPUTS = 12;
const MAX_DISCLOSED_OMITTED_OUTPUTS = 4;
const MAX_DURABLE_OUTPUT_BYTES = 4 * 1024;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function activeStep(flow: AgentFlow, state: FlowExecutionState) {
  if (!state.currentStep || state.completedSteps.includes(state.currentStep)) return undefined;
  return findStep(flow, state.currentStep);
}

function unresolvedReceipts(state: FlowExecutionState) {
  return state.actionReceipts.filter((receipt) =>
    receipt.status === "reserved" || receipt.status === "indeterminate"
  );
}

function enterableStepPaths(flow: AgentFlow, state: FlowExecutionState): string[] {
  const allowed = allowedStepPaths(flow, state);
  const current = activeStep(flow, state);
  if (!current) return uniqueSorted(allowed);
  const hasUnresolved = unresolvedReceipts(state).some((receipt) => receipt.step === current.path);
  const attempts = state.attempts[current.path] ?? 0;
  const canRetry = !hasUnresolved && attempts < (current.step.max_attempts ?? 3);
  return uniqueSorted([...(canRetry ? [current.path] : []), ...allowed]);
}

function classifyDefinition(flow: AgentFlow): VoiceToolDefinition | null {
  const topics = topicNodes(flow);
  if (!topics.length) return null;
  return {
    name: "classify",
    description: "Classify the caller's current goal into exactly one routing topic. Use other only when none of the listed routing options fits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: { type: "string", enum: [...topics.map((topic) => topic.id), "other"] },
      },
      required: ["topic"],
    },
    effect: "write",
  };
}

function getStateDefinition(): VoiceToolDefinition {
  return {
    name: "get_flow_state",
    description: "Recover the current durable checkpoint and a fresh active capability catalog after uncertainty or reconnection.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    effect: "read",
  };
}

function enterStepDefinition(paths: readonly string[]): VoiceToolDefinition {
  return {
    name: "enter_step",
    description: "Enter exactly one currently reachable step path. The result replaces the active context and capability catalog.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string", enum: [...paths] } },
      required: ["path"],
    },
    effect: "write",
  };
}

function completeStepDefinition(path: string): VoiceToolDefinition {
  return {
    name: "complete_step",
    description: "Commit the active checkpoint only after its success criteria and required outputs are satisfied.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", const: path },
        outputs: { type: "object" },
      },
      required: ["outputs"],
    },
    effect: "write",
  };
}

function reconcileDefinition(receiptIds: readonly string[]): VoiceToolDefinition {
  return {
    name: "reconcile_action",
    description: "Resolve one indeterminate action through its pinned read-only proof contract before any retry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { receipt_id: { type: "string", enum: [...receiptIds] } },
      required: ["receipt_id"],
    },
    effect: "read",
  };
}

/** Exact Flow-v2 control plane currently callable through capability_gateway. */
export function activeFlowControlDefinitions(
  flow: AgentFlow,
  state: FlowExecutionState
): VoiceToolDefinition[] {
  const controls: VoiceToolDefinition[] = [getStateDefinition()];
  if (state.status === "routing") {
    const classify = classifyDefinition(flow);
    if (classify) controls.push(classify);
  }
  if (state.status === "active") {
    const paths = enterableStepPaths(flow, state);
    if (paths.length) controls.push(enterStepDefinition(paths));
    const current = activeStep(flow, state);
    if (current) controls.push(completeStepDefinition(current.path));
    const indeterminate = uniqueSorted(state.actionReceipts
      .filter((receipt) => receipt.status === "indeterminate")
      .map((receipt) => receipt.id))
      .slice(0, MAX_DISCLOSED_PENDING_RECEIPTS);
    if (indeterminate.length) controls.push(reconcileDefinition(indeterminate));
  }
  return controls.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function boundedDurableContext(
  flow: AgentFlow,
  state: FlowExecutionState,
  current: ReturnType<typeof activeStep>
): Readonly<{
  outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  omitted: readonly Readonly<{ step: string; sha256: string; bytes: number }>[];
  omittedCount: number;
}> {
  const priority = new Set<string>();
  if (state.currentStep) priority.add(state.currentStep);
  for (const [index] of (current?.ancestors ?? []).entries()) {
    priority.add(current!.path.split(".").slice(0, index + 2).join("."));
  }
  for (const next of allowedStepPaths(flow, state)) {
    const ref = findStep(flow, next);
    for (const [index] of (ref?.ancestors ?? []).entries()) {
      priority.add(ref!.path.split(".").slice(0, index + 2).join("."));
    }
  }
  for (const path of [...state.completedSteps].reverse()) priority.add(path);

  const outputs: Record<string, Readonly<Record<string, unknown>>> = Object.create(null);
  const omitted: Array<Readonly<{ step: string; sha256: string; bytes: number }>> = [];
  let usedBytes = 2;
  let considered = 0;
  let omittedCount = 0;
  for (const path of priority) {
    const value = state.outputs[path];
    if (!value) continue;
    considered += 1;
    const bytes = Buffer.byteLength(JSON.stringify({ [path]: value }), "utf8");
    if (
      Object.keys(outputs).length < MAX_DISCLOSED_DURABLE_OUTPUTS &&
      usedBytes + bytes <= MAX_DURABLE_OUTPUT_BYTES
    ) {
      outputs[path] = value;
      usedBytes += bytes;
      continue;
    }
    omittedCount += 1;
    if (omitted.length < MAX_DISCLOSED_OMITTED_OUTPUTS) {
      omitted.push(Object.freeze({ step: path, sha256: hashFlowValue(value), bytes }));
    }
  }
  omittedCount += Math.max(0, Object.keys(state.outputs).length - considered);
  return Object.freeze({
    outputs: Object.freeze(outputs),
    omitted: Object.freeze(omitted),
    omittedCount,
  });
}

/** Bounded later by the catalog serializer; never contains grants, credentials, or action args. */
export function activeFlowContext(
  flow: AgentFlow,
  state: FlowExecutionState
): Readonly<Record<string, unknown>> {
  const current = activeStep(flow, state);
  const scope = flowCapabilityScope(state);
  const allPending = unresolvedReceipts(state);
  const pending = allPending.slice(0, MAX_DISCLOSED_PENDING_RECEIPTS).map((receipt) => ({
    receipt_id: receipt.id,
    step: receipt.step,
    tool: receipt.tool,
    status: receipt.status,
  }));
  const recentSettled = state.actionReceipts
    .filter((receipt) => receipt.status === "succeeded" || receipt.status === "failed")
    .slice(-16)
    .map((receipt) => ({
      receipt_id: receipt.id,
      step: receipt.step,
      tool: receipt.tool,
      status: receipt.status,
    }));
  const durable = boundedDurableContext(flow, state, current);
  const completedSteps = state.completedSteps.slice(-MAX_DISCLOSED_COMPLETED_STEPS);
  const checkpoints = state.checkpoints.slice(-MAX_DISCLOSED_CHECKPOINTS);
  return {
    catalog_mode: state.status === "routing"
      ? "routing"
      : state.status === "completed" || state.status === "failed"
        ? "terminal"
        : current
          ? "step"
          : "transition",
    status: state.status,
    topic: state.nodeId,
    current_step: current?.path ?? null,
    attempt: scope.attempt,
    capability_epoch: state.capabilityEpoch,
    state_revision: state.revision,
    ...(state.status === "routing" ? {
      routing_options: topicNodes(flow).map((topic) => ({
        topic: topic.id,
        label: topic.label,
        ...(topic.context ? { context: topic.context } : {}),
      })),
    } : {}),
    ...(current ? {
      active_step: {
        path: current.path,
        label: current.step.label,
        ...(current.step.context ? { context: current.step.context } : {}),
        instructions: current.step.instructions,
        success_criteria: current.step.success_criteria ?? [],
        required_outputs: current.step.required_outputs ?? [],
        checkpoint: current.step.checkpoint ?? false,
        attempt: scope.attempt,
        max_attempts: current.step.max_attempts ?? 3,
      },
    } : {}),
    next_steps: describeNextSteps(flow, state),
    completed_step_count: state.completedSteps.length,
    completed_steps: completedSteps,
    completed_steps_truncated: completedSteps.length !== state.completedSteps.length,
    durable_output_count: Object.keys(state.outputs).length,
    durable_outputs: durable.outputs,
    omitted_durable_outputs: durable.omitted,
    omitted_durable_output_count: durable.omittedCount,
    checkpoint_count: state.checkpoints.length,
    checkpoints,
    checkpoints_truncated: checkpoints.length !== state.checkpoints.length,
    pending_action_receipt_count: allPending.length,
    pending_action_receipts: pending,
    pending_action_receipts_truncated: pending.length !== allPending.length,
    recent_settled_actions: recentSettled,
  };
}
