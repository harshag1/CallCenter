import {
  findStep,
  topicNodes,
  type AgentFlow,
} from "./flow";
import {
  allowedStepPaths,
  describeNextSteps,
  flowCapabilityScope,
  type FlowExecutionState,
} from "./flow-runtime";
import type { VoiceToolDefinition } from "./voice-tools";

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
      .map((receipt) => receipt.id));
    if (indeterminate.length) controls.push(reconcileDefinition(indeterminate));
  }
  return controls.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

/** Bounded later by the catalog serializer; never contains grants, credentials, or action args. */
export function activeFlowContext(
  flow: AgentFlow,
  state: FlowExecutionState
): Readonly<Record<string, unknown>> {
  const current = activeStep(flow, state);
  const scope = flowCapabilityScope(state);
  const pending = unresolvedReceipts(state).map((receipt) => ({
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
    completed_steps: state.completedSteps,
    durable_outputs: state.outputs,
    checkpoints: state.checkpoints,
    pending_action_receipts: pending,
    recent_settled_actions: recentSettled,
  };
}
