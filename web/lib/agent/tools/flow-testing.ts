import { z } from "zod";
import { listStepRefs, validateAgentFlow } from "../../flow";
import {
  completeFlowStep,
  createFlowExecutionState,
  deriveFlowActionInvocationId,
  describeNextSteps,
  enterFlowStep,
  FlowExecutionStateSchema,
  flowStateSummary,
  hashFlowValue,
  markFlowActionDispatchStarted,
  markStaleDispatchedActionsIndeterminate,
  promoteIndeterminateFlowAction,
  proveIndeterminateFlowActionAbsent,
  reserveFlowAction,
  selectFlowTopic,
  settleFlowAction,
  type FlowExecutionState,
  type RuntimeError,
} from "../../flow-runtime";
import type { AgentFlow } from "../../flow";
import type { OperatorTool } from "../types";

const JsonObjectSchema = z.record(z.string(), z.unknown());
const ReceiptOutcomeSchema = z.enum(["reserved", "succeeded", "failed", "indeterminate"]);

const EnterStepEventSchema = z.object({
  type: z.literal("enter_step"),
  path: z.string().min(1),
}).strict();

const ActionEventSchema = z.object({
  type: z.literal("action"),
  receipt_id: z.string().min(1),
  tool: z.string().min(1),
  arguments: JsonObjectSchema.default({}),
  provider_invocation_id: z.string().min(1).max(256).optional(),
  outcome: ReceiptOutcomeSchema,
  dispatch_started: z.boolean().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
}).strict();

const SettleActionEventSchema = z.object({
  type: z.literal("settle_action"),
  receipt_id: z.string().min(1),
  status: z.enum(["succeeded", "failed", "indeterminate"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
}).strict();

const ReconcileActionEventSchema = z.object({
  type: z.literal("reconcile_action"),
  receipt_id: z.string().min(1),
  proof_id: z.string().min(1),
  resolution: z.enum(["committed", "absent"]),
  result: z.unknown().optional(),
}).strict().superRefine((event, context) => {
  if (event.resolution === "committed" && event.result === undefined) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "committed reconciliation requires an authoritative result",
    });
  }
  if (event.resolution === "absent" && event.result !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "authoritative absence cannot carry a result",
    });
  }
});

const InterruptEventSchema = z.object({
  type: z.literal("interrupt"),
  reason: z.enum(["disconnect", "timeout", "process_restart"]),
  /** Defaults to every dispatched reservation, mirroring crash recovery. */
  receipt_ids: z.array(z.string().min(1)).optional(),
}).strict();

const WorkerCompletionEventSchema = z.object({
  type: z.literal("worker_completion"),
  worker_id: z.string().min(1),
  receipt_id: z.string().min(1),
  tool: z.string().min(1),
  arguments: JsonObjectSchema.default({}),
  provider_invocation_id: z.string().min(1).max(256).optional(),
  result: z.unknown(),
}).strict();

const CompleteStepEventSchema = z.object({
  type: z.literal("complete_step"),
  path: z.string().min(1).optional(),
  outputs: JsonObjectSchema.default({}),
}).strict();

const ScenarioEventSchema = z.discriminatedUnion("type", [
  EnterStepEventSchema,
  ActionEventSchema,
  SettleActionEventSchema,
  ReconcileActionEventSchema,
  InterruptEventSchema,
  WorkerCompletionEventSchema,
  CompleteStepEventSchema,
]);

const ExpectedReceiptSchema = z.object({
  status: ReceiptOutcomeSchema,
  tool: z.string().optional(),
  step: z.string().optional(),
  reconciliation_proof_id: z.string().optional(),
}).strict();

const ExpectedStateSchema = z.object({
  status: z.enum(["routing", "active", "completed", "failed"]).optional(),
  topic: z.string().nullable().optional(),
  current_step: z.string().nullable().optional(),
  completed_steps: z.array(z.string()).optional(),
  next_steps: z.array(z.string()).optional(),
  outputs: z.record(z.string(), JsonObjectSchema).optional(),
  checkpoints: z.array(z.string()).optional(),
  receipt_statuses: z.record(z.string(), ExpectedReceiptSchema).optional(),
}).strict();

const LegacyStepSchema = z.object({
  path: z.string().min(1),
  outputs: JsonObjectSchema,
}).strict();

const FlowScenarioSchema = z.object({
  topic: z.string().min(1),
  /** Fixes every runtime timestamp so identical fixtures produce identical traces. */
  started_at: z.iso.datetime().default("2025-01-01T00:00:00.000Z"),
  events: z.array(ScenarioEventSchema).min(1).optional(),
  /** Backward-compatible shorthand for simple enter/complete walks. */
  steps: z.array(LegacyStepSchema).min(1).optional(),
  expect: ExpectedStateSchema.optional(),
}).strict().superRefine((scenario, context) => {
  if (!scenario.events && !scenario.steps) {
    context.addIssue({ code: "custom", message: "scenario requires events or legacy steps" });
  }
  if (scenario.events && scenario.steps) {
    context.addIssue({ code: "custom", message: "scenario cannot mix events with legacy steps" });
  }
});

type ScenarioEvent = z.infer<typeof ScenarioEventSchema>;
type ExpectedState = z.infer<typeof ExpectedStateSchema>;

type ScenarioFailure = {
  ok: false;
  stage: string;
  trace?: unknown[];
  event_index?: number;
  event_type?: string;
  path?: string;
  error?: string;
  code?: string;
  allowed?: string[];
  errors?: unknown[];
  failures?: Array<{ path: string; expected: unknown; actual: unknown }>;
};

type ScenarioSuccess = {
  ok: true;
  trace: unknown[];
  final: ReturnType<typeof flowStateSummary>;
  assertions?: { passed: true };
};

function isRuntimeError(value: object): value is RuntimeError {
  return "error" in value;
}

function scenarioError(
  stage: string,
  error: RuntimeError,
  trace: unknown[],
  eventIndex?: number,
  eventType?: string,
  path?: string
): ScenarioFailure {
  return {
    ok: false,
    stage,
    ...(eventIndex === undefined ? {} : { event_index: eventIndex }),
    ...(eventType ? { event_type: eventType } : {}),
    ...(path ? { path } : {}),
    trace,
    ...error,
  };
}

function stateTrace(flow: AgentFlow, state: FlowExecutionState) {
  return {
    status: state.status,
    topic: state.nodeId,
    current_step: state.currentStep,
    completed_steps: state.completedSteps,
    next_steps: describeNextSteps(flow, state).map(({ path }) => path),
    capability_epoch: state.capabilityEpoch,
    receipts: Object.fromEntries(state.actionReceipts.map((receipt) => [
      receipt.id,
      {
        tool: receipt.tool,
        status: receipt.status,
        ...(receipt.reconciliationProofId
          ? { reconciliation_proof_id: receipt.reconciliationProofId }
          : {}),
      },
    ])),
    revision: state.revision,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return hashFlowValue(left) === hashFlowValue(right);
  } catch {
    return Object.is(left, right);
  }
}

function assertExpectedState(
  flow: AgentFlow,
  state: FlowExecutionState,
  expected: ExpectedState
): Array<{ path: string; expected: unknown; actual: unknown }> {
  const failures: Array<{ path: string; expected: unknown; actual: unknown }> = [];
  const check = (path: string, wanted: unknown, actual: unknown) => {
    if (!sameValue(wanted, actual)) failures.push({ path, expected: wanted, actual });
  };
  if (expected.status !== undefined) check("status", expected.status, state.status);
  if (expected.topic !== undefined) check("topic", expected.topic, state.nodeId);
  if (expected.current_step !== undefined) check("current_step", expected.current_step, state.currentStep);
  if (expected.completed_steps !== undefined) check("completed_steps", expected.completed_steps, state.completedSteps);
  if (expected.next_steps !== undefined) {
    check("next_steps", expected.next_steps, describeNextSteps(flow, state).map(({ path }) => path));
  }
  if (expected.outputs !== undefined) check("outputs", expected.outputs, state.outputs);
  if (expected.checkpoints !== undefined) {
    check("checkpoints", expected.checkpoints, state.checkpoints.map(({ step }) => step));
  }
  for (const [receiptId, wanted] of Object.entries(expected.receipt_statuses ?? {})) {
    const receipt = state.actionReceipts.find(({ id }) => id === receiptId);
    if (!receipt) {
      failures.push({ path: `receipt_statuses.${receiptId}`, expected: wanted, actual: null });
      continue;
    }
    check(`receipt_statuses.${receiptId}.status`, wanted.status, receipt.status);
    if (wanted.tool !== undefined) check(`receipt_statuses.${receiptId}.tool`, wanted.tool, receipt.tool);
    if (wanted.step !== undefined) check(`receipt_statuses.${receiptId}.step`, wanted.step, receipt.step);
    if (wanted.reconciliation_proof_id !== undefined) {
      check(
        `receipt_statuses.${receiptId}.reconciliation_proof_id`,
        wanted.reconciliation_proof_id,
        receipt.reconciliationProofId
      );
    }
  }
  return failures;
}

function runLegacyScenario(
  flow: AgentFlow,
  topic: string,
  steps: z.infer<typeof LegacyStepSchema>[],
  startedAt: string
): ScenarioFailure | ScenarioSuccess {
  let selected = selectFlowTopic(flow, createFlowExecutionState(startedAt), topic, startedAt);
  if (isRuntimeError(selected)) {
    return { ok: false, stage: "classification", trace: [], ...selected };
  }
  const trace: unknown[] = [];
  let tick = Date.parse(startedAt);
  const now = () => new Date(++tick).toISOString();
  for (const item of steps) {
    const entered = enterFlowStep(flow, selected, item.path, now());
    if (isRuntimeError(entered)) {
      return scenarioError("enter_step", entered, trace, undefined, undefined, item.path);
    }
    const completed = completeFlowStep(
      flow,
      entered.state,
      { path: item.path, outputs: item.outputs },
      now()
    );
    if (isRuntimeError(completed)) {
      return scenarioError("complete_step", completed, trace, undefined, undefined, item.path);
    }
    trace.push({
      path: item.path,
      available_tools: entered.availableTools,
      outputs: item.outputs,
      next_steps: describeNextSteps(flow, completed.state),
      revision: completed.state.revision,
    });
    selected = completed.state;
  }
  return { ok: true, trace, final: flowStateSummary(flow, selected) };
}

function applyAction(
  flow: AgentFlow,
  state: FlowExecutionState,
  event: z.infer<typeof ActionEventSchema>,
  now: () => string
): { state: FlowExecutionState; detail: Record<string, unknown> } | RuntimeError {
  const invocationId = deriveFlowActionInvocationId(
    `flow-test:${state.nodeId ?? "routing"}:${event.receipt_id}`
  );
  const reserved = reserveFlowAction(flow, state, {
    receiptId: event.receipt_id,
    invocationId,
    tool: event.tool,
    arguments: event.arguments,
    capabilityEpoch: state.capabilityEpoch,
    ...(event.provider_invocation_id
      ? { providerInvocationId: event.provider_invocation_id }
      : {}),
  }, now());
  if (isRuntimeError(reserved)) return reserved;
  if (!reserved.execute) {
    return {
      state: reserved.state,
      detail: {
        receipt_id: reserved.receipt.id,
        execute: false,
        replayed: reserved.replayed,
        status: reserved.receipt.status,
      },
    };
  }

  let nextState = reserved.state;
  const shouldDispatch = event.dispatch_started
    ?? (event.outcome === "succeeded" || event.outcome === "indeterminate");
  if (shouldDispatch) {
    const dispatched = markFlowActionDispatchStarted(
      nextState,
      { receiptId: event.receipt_id },
      now()
    );
    if (isRuntimeError(dispatched)) return dispatched;
    nextState = dispatched.state;
  }
  if (event.outcome !== "reserved") {
    const settled = settleFlowAction(nextState, {
      receiptId: event.receipt_id,
      status: event.outcome,
      ...(event.result !== undefined ? { result: event.result } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
    }, now());
    if (isRuntimeError(settled)) return settled;
    nextState = settled.state;
  }
  const receipt = nextState.actionReceipts.find(({ id }) => id === event.receipt_id);
  return {
    state: nextState,
    detail: {
      receipt_id: event.receipt_id,
      execute: true,
      replayed: false,
      dispatch_started: shouldDispatch,
      status: receipt?.status,
    },
  };
}

/**
 * Pure Flow v2 simulator used by the operator tool and unit tests. It models the same receipt
 * boundaries as production: reservation, durable dispatch, settlement, ambiguity quarantine,
 * proof-backed reconciliation, restart recovery, and receipt-backed worker delivery.
 */
export function runFlowScenario(
  flowInput: unknown,
  scenarioInput: unknown
): ScenarioFailure | ScenarioSuccess {
  const validated = validateAgentFlow(flowInput);
  const errors = validated.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (!validated.flow || errors.length) {
    return { ok: false, stage: "validation", errors };
  }
  const parsed = FlowScenarioSchema.safeParse(scenarioInput);
  if (!parsed.success) {
    return {
      ok: false,
      stage: "scenario_validation",
      errors: parsed.error.issues,
    };
  }
  const scenario = parsed.data;
  if (scenario.steps) {
    const legacy = runLegacyScenario(
      validated.flow,
      scenario.topic,
      scenario.steps,
      scenario.started_at
    );
    if (!legacy.ok || !scenario.expect) return legacy;
    const state = replayFinalStateForAssertions(
      validated.flow,
      scenario.topic,
      scenario.steps,
      scenario.started_at
    );
    if (isRuntimeError(state)) return scenarioError("assertion_replay", state, legacy.trace);
    const failures = assertExpectedState(validated.flow, state, scenario.expect);
    return failures.length
      ? { ok: false, stage: "assertion", trace: legacy.trace, failures }
      : { ...legacy, assertions: { passed: true } };
  }

  let state = selectFlowTopic(
    validated.flow,
    createFlowExecutionState(scenario.started_at),
    scenario.topic,
    scenario.started_at
  );
  if (isRuntimeError(state)) {
    return { ok: false, stage: "classification", trace: [], ...state };
  }
  let tick = Date.parse(scenario.started_at);
  const now = () => new Date(++tick).toISOString();
  const trace: unknown[] = [];

  for (const [index, event] of (scenario.events ?? []).entries()) {
    const result = applyScenarioEvent(validated.flow, state, event, now);
    if (isRuntimeError(result)) {
      return scenarioError(
        event.type,
        result,
        trace,
        index,
        event.type,
        "path" in event ? event.path : undefined
      );
    }
    state = result.state;
    trace.push({
      index,
      type: event.type,
      ...result.detail,
      state: stateTrace(validated.flow, state),
    });
  }

  if (scenario.expect) {
    const failures = assertExpectedState(validated.flow, state, scenario.expect);
    if (failures.length) return { ok: false, stage: "assertion", trace, failures };
  }
  return {
    ok: true,
    trace,
    final: flowStateSummary(validated.flow, state),
    ...(scenario.expect ? { assertions: { passed: true as const } } : {}),
  };
}

function replayFinalStateForAssertions(
  flow: AgentFlow,
  topic: string,
  steps: z.infer<typeof LegacyStepSchema>[],
  startedAt: string
): FlowExecutionState | RuntimeError {
  let state = selectFlowTopic(flow, createFlowExecutionState(startedAt), topic, startedAt);
  if (isRuntimeError(state)) return state;
  let tick = Date.parse(startedAt);
  const now = () => new Date(++tick).toISOString();
  for (const step of steps) {
    const entered = enterFlowStep(flow, state, step.path, now());
    if (isRuntimeError(entered)) return entered;
    const completed = completeFlowStep(flow, entered.state, step, now());
    if (isRuntimeError(completed)) return completed;
    state = completed.state;
  }
  return state;
}

function applyScenarioEvent(
  flow: AgentFlow,
  state: FlowExecutionState,
  event: ScenarioEvent,
  now: () => string
): { state: FlowExecutionState; detail: Record<string, unknown> } | RuntimeError {
  switch (event.type) {
    case "enter_step": {
      const entered = enterFlowStep(flow, state, event.path, now());
      return isRuntimeError(entered)
        ? entered
        : {
            state: entered.state,
            detail: {
              path: event.path,
              available_tools: entered.availableTools,
            },
          };
    }
    case "action":
      return applyAction(flow, state, event, now);
    case "settle_action": {
      const settled = settleFlowAction(state, {
        receiptId: event.receipt_id,
        status: event.status,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      }, now());
      return isRuntimeError(settled)
        ? settled
        : {
            state: settled.state,
            detail: { receipt_id: event.receipt_id, status: settled.receipt.status },
          };
    }
    case "reconcile_action": {
      const reconciled = event.resolution === "committed"
        ? promoteIndeterminateFlowAction(state, {
            receiptId: event.receipt_id,
            proofId: event.proof_id,
            result: event.result,
          }, now())
        : proveIndeterminateFlowActionAbsent(state, {
            receiptId: event.receipt_id,
            proofId: event.proof_id,
          }, now());
      return isRuntimeError(reconciled)
        ? reconciled
        : {
            state: reconciled.state,
            detail: {
              receipt_id: event.receipt_id,
              resolution: event.resolution,
              status: reconciled.receipt.status,
              proof_id: event.proof_id,
            },
          };
    }
    case "interrupt": {
      // JSON round-trip proves that the fixture survives the same persisted-state boundary as a
      // disconnected call or process restart. Only dispatched reservations become indeterminate.
      const recovered = FlowExecutionStateSchema.parse(JSON.parse(JSON.stringify(state)));
      const receiptIds = event.receipt_ids ?? recovered.actionReceipts
        .filter((receipt) => receipt.status === "reserved" && receipt.dispatchStartedAt)
        .map(({ id }) => id);
      const interrupted = markStaleDispatchedActionsIndeterminate(recovered, receiptIds, now());
      return {
        state: interrupted,
        detail: {
          reason: event.reason,
          recovered_receipt_ids: receiptIds,
        },
      };
    }
    case "worker_completion": {
      const completed = applyAction(flow, state, {
        type: "action",
        receipt_id: event.receipt_id,
        tool: event.tool,
        arguments: { worker_id: event.worker_id, ...event.arguments },
        ...(event.provider_invocation_id
          ? { provider_invocation_id: event.provider_invocation_id }
          : {}),
        outcome: "succeeded",
        dispatch_started: true,
        result: event.result,
      }, now);
      return isRuntimeError(completed)
        ? completed
        : {
            state: completed.state,
            detail: {
              ...completed.detail,
              worker_id: event.worker_id,
              receipt_backed: true,
            },
          };
    }
    case "complete_step": {
      const completed = completeFlowStep(
        flow,
        state,
        { ...(event.path ? { path: event.path } : {}), outputs: event.outputs },
        now()
      );
      return isRuntimeError(completed)
        ? completed
        : {
            state: completed.state,
            detail: {
              path: event.path ?? state.currentStep,
              outputs: event.outputs,
              next_steps: completed.nextSteps,
            },
          };
    }
  }
}

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
  description: "Deterministically simulate a Flow v2 before deployment, including receipt-backed actions, crash/timeout recovery, proof-backed ambiguity reconciliation, worker completions, and exact terminal-state assertions.",
  parameters: {
    type: "object",
    properties: {
      flow: { type: "object" },
      topic: { type: "string" },
      started_at: { type: "string" },
      events: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                type: { const: "enter_step" },
                path: { type: "string" },
              },
              required: ["type", "path"],
              additionalProperties: false,
            },
            {
              type: "object",
              description: "Reserve an admitted tool call, optionally cross the dispatch boundary, and record its outcome. Use reserved + dispatch_started for an in-flight call that a later interrupt recovers.",
              properties: {
                type: { const: "action" },
                receipt_id: { type: "string" },
                tool: { type: "string" },
                arguments: { type: "object" },
                provider_invocation_id: { type: "string" },
                outcome: {
                  type: "string",
                  enum: ["reserved", "succeeded", "failed", "indeterminate"],
                },
                dispatch_started: { type: "boolean" },
                result: {},
                error: { type: "string" },
              },
              required: ["type", "receipt_id", "tool", "arguments", "outcome"],
              additionalProperties: false,
            },
            {
              type: "object",
              description: "Settle a reservation created by an earlier action event.",
              properties: {
                type: { const: "settle_action" },
                receipt_id: { type: "string" },
                status: {
                  type: "string",
                  enum: ["succeeded", "failed", "indeterminate"],
                },
                result: {},
                error: { type: "string" },
              },
              required: ["type", "receipt_id", "status"],
              additionalProperties: false,
            },
            {
              type: "object",
              description: "Resolve an indeterminate receipt from an exact read-back proof. Committed requires result; absent forbids it.",
              properties: {
                type: { const: "reconcile_action" },
                receipt_id: { type: "string" },
                proof_id: { type: "string" },
                resolution: { type: "string", enum: ["committed", "absent"] },
                result: {},
              },
              required: ["type", "receipt_id", "proof_id", "resolution"],
              additionalProperties: false,
            },
            {
              type: "object",
              description: "Round-trip durable state and quarantine selected dispatched reservations as indeterminate. receipt_ids defaults to every in-flight dispatched reservation.",
              properties: {
                type: { const: "interrupt" },
                reason: {
                  type: "string",
                  enum: ["disconnect", "timeout", "process_restart"],
                },
                receipt_ids: { type: "array", items: { type: "string" } },
              },
              required: ["type", "reason"],
              additionalProperties: false,
            },
            {
              type: "object",
              description: "Deliver an asynchronous worker result through a successful, receipt-backed Flow action.",
              properties: {
                type: { const: "worker_completion" },
                worker_id: { type: "string" },
                receipt_id: { type: "string" },
                tool: { type: "string" },
                arguments: { type: "object" },
                provider_invocation_id: { type: "string" },
                result: {},
              },
              required: ["type", "worker_id", "receipt_id", "tool", "result"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { const: "complete_step" },
                path: { type: "string" },
                outputs: { type: "object" },
              },
              required: ["type", "outputs"],
              additionalProperties: false,
            },
          ],
        },
      },
      steps: {
        type: "array",
        description: "Backward-compatible shorthand for simple enter/complete walks.",
        items: {
          type: "object",
          properties: { path: { type: "string" }, outputs: { type: "object" } },
          required: ["path", "outputs"],
        },
      },
      expect: {
        type: "object",
        description: "Exact expected terminal state. Every supplied field is asserted; receipt_statuses may assert a subset by receipt id.",
        properties: {
          status: {
            type: "string",
            enum: ["routing", "active", "completed", "failed"],
          },
          topic: { type: ["string", "null"] },
          current_step: { type: ["string", "null"] },
          completed_steps: { type: "array", items: { type: "string" } },
          next_steps: { type: "array", items: { type: "string" } },
          outputs: { type: "object" },
          checkpoints: { type: "array", items: { type: "string" } },
          receipt_statuses: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["reserved", "succeeded", "failed", "indeterminate"],
                },
                tool: { type: "string" },
                step: { type: "string" },
                reconciliation_proof_id: { type: "string" },
              },
              required: ["status"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    required: ["flow", "topic"],
  },
  async execute(args) {
    const { flow, ...scenario } = args;
    return { output: runFlowScenario(flow, scenario) };
  },
};
