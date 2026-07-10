import { z } from "zod";
import {
  BenchmarkScenarioSchema,
  JsonValueSchema,
  ToolInvocationSchema,
  WorldEffectSchema,
  WorldReceiptSchema,
  type BenchmarkScenario,
  type JsonValue,
  type Predicate,
  type PrerequisiteEvidence,
  type ToolDefinition,
  type ToolInvocation,
  type ValueSource,
  type VisibleToolResult,
  type WorldAssertion,
  type WorldEffect,
  type WorldReceipt,
} from "./scenario-schema";
import { WorldEventSchema, type WorldEvent } from "./world-events";

export const ToolWorldStateSchema = z.object({
  schema_version: z.literal(1),
  scenario_id: z.string().min(1),
  scenario_version: z.string().min(1),
  facts: z.record(z.string(), JsonValueSchema),
  attempts: z.record(z.string(), z.number().int().nonnegative()),
  receipts: z.array(WorldReceiptSchema),
  effects: z.array(WorldEffectSchema),
  events: z.array(WorldEventSchema),
  next_event_sequence: z.number().int().positive(),
});

export type ToolWorldState = z.infer<typeof ToolWorldStateSchema>;

export type ToolExecutionDisposition = "executed" | "rejected" | "failed" | "replayed" | "deduplicated";

export type ToolExecution = {
  state: ToolWorldState;
  disposition: ToolExecutionDisposition;
  receipt: WorldReceipt;
  visible_result: VisibleToolResult;
  events: WorldEvent[];
};

export type AssertionEvaluation = {
  assertion_id: string;
  description: string;
  severity: "critical" | "major" | "minor";
  passed: boolean;
  actual: JsonValue;
  expected?: JsonValue;
};

type EvaluationContext = {
  world: Record<string, JsonValue>;
  arguments: Record<string, JsonValue>;
  runtime: Record<string, JsonValue>;
};

export class ToolWorldDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolWorldDefinitionError";
  }
}

/** Stable JSON serialization used for semantic intent keys and deep equality. */
export function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return '"$benchmark.undefined"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function splitPath(path: string): string[] {
  return path.split(".");
}

export function valueAtPath(root: unknown, path: string): JsonValue | undefined {
  let current: unknown = root;
  for (const segment of splitPath(path)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object" || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  const parsed = JsonValueSchema.safeParse(current);
  return parsed.success ? parsed.data : undefined;
}

function setValueAtPath(root: Record<string, JsonValue>, path: string, value: JsonValue): void {
  const segments = splitPath(path);
  let current: Record<string, JsonValue> | JsonValue[] = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextIsArray = /^\d+$/.test(segments[index + 1]);
    const existing = Array.isArray(current)
      ? current[Number(segment)]
      : current[segment];
    if (existing === null || typeof existing !== "object") {
      const replacement: JsonValue = nextIsArray ? [] : {};
      if (Array.isArray(current)) current[Number(segment)] = replacement;
      else current[segment] = replacement;
      current = replacement as Record<string, JsonValue> | JsonValue[];
    } else {
      current = existing as Record<string, JsonValue> | JsonValue[];
    }
  }
  const finalSegment = segments[segments.length - 1];
  if (Array.isArray(current)) current[Number(finalSegment)] = value;
  else current[finalSegment] = value;
}

function resolveValue(source: ValueSource, context: EvaluationContext): JsonValue | undefined {
  if ("literal" in source) return source.literal;
  return valueAtPath(context[source.source], source.path);
}

function deepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function evaluatePredicate(predicate: Predicate, context: EvaluationContext): PrerequisiteEvidence {
  const left = resolveValue(predicate.left, context);
  const right = predicate.right ? resolveValue(predicate.right, context) : undefined;
  let passed = false;
  switch (predicate.operator) {
    case "equals":
      passed = deepEqual(left, right);
      break;
    case "not_equals":
      passed = !deepEqual(left, right);
      break;
    case "exists":
      passed = left !== undefined;
      break;
    case "not_exists":
      passed = left === undefined;
      break;
    case "in":
      passed = Array.isArray(right) && right.some((candidate) => deepEqual(left, candidate));
      break;
    case "greater_than_or_equal":
      passed = typeof left === "number" && typeof right === "number" && left >= right;
      break;
    case "less_than_or_equal":
      passed = typeof left === "number" && typeof right === "number" && left <= right;
      break;
    case "contains":
      passed = typeof left === "string" && typeof right === "string"
        ? left.includes(right)
        : Array.isArray(left) && right !== undefined && left.some((candidate) => deepEqual(candidate, right));
      break;
  }
  return {
    prerequisite_id: predicate.id,
    description: predicate.description,
    passed,
    ...(left === undefined ? {} : { actual: left }),
    ...(right === undefined ? {} : { expected: right }),
  };
}

function appendEvent(
  state: ToolWorldState,
  scenario: BenchmarkScenario,
  turn: number,
  payload: Record<string, unknown>
): WorldEvent {
  const sequence = state.next_event_sequence;
  const event = WorldEventSchema.parse({
    schema_version: 1,
    event_id: `evt_${String(sequence).padStart(6, "0")}`,
    sequence,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    turn,
    ...payload,
  });
  state.events.push(event);
  state.next_event_sequence += 1;
  return event;
}

export function createToolWorld(input: unknown): ToolWorldState {
  const scenario = BenchmarkScenarioSchema.parse(input);
  const state: ToolWorldState = {
    schema_version: 1,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    facts: structuredClone(scenario.initial_facts),
    attempts: {},
    receipts: [],
    effects: [],
    events: [],
    next_event_sequence: 1,
  };
  appendEvent(state, scenario, 0, {
    type: "world.initialized",
    initial_fact_count: Object.keys(state.facts).length,
  });
  return ToolWorldStateSchema.parse(state);
}

function valueType(value: JsonValue): "string" | "number" | "boolean" | "object" | "array" | "null" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as "string" | "number" | "boolean" | "object";
}

function validateArguments(tool: ToolDefinition, args: Record<string, JsonValue>): string[] {
  const issues: string[] = [];
  const definitions = new Map(tool.arguments.map((argument) => [argument.name, argument]));
  if (!tool.additional_arguments) {
    for (const name of Object.keys(args).sort()) {
      if (!definitions.has(name)) issues.push(`unknown argument "${name}"`);
    }
  }
  for (const argument of tool.arguments) {
    const value = args[argument.name];
    if (value === undefined) {
      if (argument.required) issues.push(`missing required argument "${argument.name}"`);
      continue;
    }
    if (valueType(value) !== argument.type) {
      issues.push(`argument "${argument.name}" must be ${argument.type}`);
      continue;
    }
    if (argument.enum && !argument.enum.some((candidate) => deepEqual(value, candidate))) {
      issues.push(`argument "${argument.name}" is outside its allowed enum`);
    }
    if (typeof value === "number") {
      if (argument.minimum !== undefined && value < argument.minimum) issues.push(`argument "${argument.name}" is below minimum`);
      if (argument.maximum !== undefined && value > argument.maximum) issues.push(`argument "${argument.name}" is above maximum`);
    }
    if (typeof value === "string" && argument.pattern && !new RegExp(argument.pattern).test(value)) {
      issues.push(`argument "${argument.name}" does not match its required pattern`);
    }
  }
  return issues;
}

function semanticKey(tool: ToolDefinition, invocation: ToolInvocation, context: EvaluationContext): string {
  const values = tool.semantic_key.length > 0
    ? tool.semantic_key.map((source) => resolveValue(source, context))
    : [invocation.arguments];
  return `${tool.name}:${canonicalJson(values as JsonValue[])}`;
}

function errorResult(code: string, message: string, retriable = false): VisibleToolResult {
  return { ok: false, error: { code, message, retriable } };
}

function materializeResult(tool: ToolDefinition, context: EvaluationContext): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (const field of tool.result.fields) {
    const value = resolveValue(field.value, context);
    if (value === undefined) {
      throw new ToolWorldDefinitionError(`tool "${tool.name}" result path "${field.path}" resolves to undefined`);
    }
    setValueAtPath(result, field.path, structuredClone(value));
  }
  return result;
}

function committedReceipt(receipt: WorldReceipt): boolean {
  return (receipt.status === "succeeded" && receipt.committed) || receipt.status === "committed_after_error";
}

export function executeTool(
  scenarioInput: unknown,
  stateInput: unknown,
  invocationInput: unknown
): ToolExecution {
  const scenario = BenchmarkScenarioSchema.parse(scenarioInput);
  const state = ToolWorldStateSchema.parse(stateInput);
  const invocation = ToolInvocationSchema.parse(invocationInput);
  if (state.scenario_id !== scenario.id || state.scenario_version !== scenario.version) {
    throw new ToolWorldDefinitionError(
      `world belongs to ${state.scenario_id}@${state.scenario_version}, not ${scenario.id}@${scenario.version}`
    );
  }
  const initialEventCount = state.events.length;
  appendEvent(state, scenario, invocation.turn, {
    type: "tool.invocation_received",
    invocation_id: invocation.invocation_id,
    tool: invocation.tool,
    arguments: invocation.arguments,
  });

  const exactReceipt = state.receipts.find((receipt) => receipt.invocation_id === invocation.invocation_id);
  if (exactReceipt) {
    if (exactReceipt.tool !== invocation.tool || !deepEqual(exactReceipt.arguments, invocation.arguments)) {
      throw new ToolWorldDefinitionError(
        `invocation id "${invocation.invocation_id}" was reused with a different tool or argument payload`
      );
    }
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.invocation_replayed",
      invocation_id: invocation.invocation_id,
      tool: invocation.tool,
      original_receipt_id: exactReceipt.receipt_id,
    });
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.result_visible",
      invocation_id: invocation.invocation_id,
      tool: invocation.tool,
      result: exactReceipt.visible_result,
      tainted_paths: exactReceipt.tainted_result_paths.map((taint) => taint.path),
    });
    return {
      state,
      disposition: "replayed",
      receipt: exactReceipt,
      visible_result: exactReceipt.visible_result,
      events: state.events.slice(initialEventCount),
    };
  }

  const attempt = (state.attempts[invocation.tool] ?? 0) + 1;
  state.attempts[invocation.tool] = attempt;
  const tool = scenario.tools.find((candidate) => candidate.name === invocation.tool);
  const receiptId = `rcpt:${scenario.id}:${invocation.invocation_id}`;

  const finish = (
    receipt: WorldReceipt,
    disposition: ToolExecutionDisposition
  ): ToolExecution => {
    state.receipts.push(receipt);
    appendEvent(state, scenario, invocation.turn, { type: "tool.receipt_recorded", receipt });
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.result_visible",
      invocation_id: invocation.invocation_id,
      tool: invocation.tool,
      result: receipt.visible_result,
      tainted_paths: receipt.tainted_result_paths.map((taint) => taint.path),
    });
    return {
      state: ToolWorldStateSchema.parse(state),
      disposition,
      receipt,
      visible_result: receipt.visible_result,
      events: state.events.slice(initialEventCount),
    };
  };

  if (!tool) {
    const visibleResult = errorResult("unknown_tool", `unknown tool "${invocation.tool}"`);
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.arguments_validated",
      invocation_id: invocation.invocation_id,
      tool: invocation.tool,
      valid: false,
      issues: [`unknown tool "${invocation.tool}"`],
    });
    return finish({
      receipt_id: receiptId,
      invocation_id: invocation.invocation_id,
      tool: invocation.tool,
      arguments: invocation.arguments,
      attempt,
      turn: invocation.turn,
      status: "rejected",
      committed: false,
      semantic_key: `unknown:${invocation.tool}:${canonicalJson(invocation.arguments)}`,
      prerequisite_evidence: [],
      effect_ids: [],
      visible_result: visibleResult,
      tainted_result_paths: [],
    }, "rejected");
  }

  const argumentIssues = validateArguments(tool, invocation.arguments);
  appendEvent(state, scenario, invocation.turn, {
    type: "tool.arguments_validated",
    invocation_id: invocation.invocation_id,
    tool: tool.name,
    valid: argumentIssues.length === 0,
    issues: argumentIssues,
  });
  const runtime: Record<string, JsonValue> = {
    attempt,
    turn: invocation.turn,
    invocation_id: invocation.invocation_id,
    ...(invocation.idempotency_key ? { idempotency_key: invocation.idempotency_key } : {}),
  };
  const context: EvaluationContext = { world: state.facts, arguments: invocation.arguments, runtime };
  const key = semanticKey(tool, invocation, context);
  if (argumentIssues.length > 0) {
    return finish({
      receipt_id: receiptId,
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      arguments: invocation.arguments,
      attempt,
      turn: invocation.turn,
      status: "rejected",
      committed: false,
      semantic_key: key,
      prerequisite_evidence: [],
      effect_ids: [],
      visible_result: errorResult("invalid_arguments", argumentIssues.join("; ")),
      tainted_result_paths: [],
    }, "rejected");
  }

  const evidence = tool.prerequisites.map((predicate) => evaluatePredicate(predicate, context));
  for (const item of evidence) {
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.prerequisite_evaluated",
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      evidence: item,
    });
  }
  const failedPrerequisites = evidence.filter((item) => !item.passed);
  if (failedPrerequisites.length > 0) {
    return finish({
      receipt_id: receiptId,
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      arguments: invocation.arguments,
      attempt,
      turn: invocation.turn,
      status: "rejected",
      committed: false,
      semantic_key: key,
      prerequisite_evidence: evidence,
      effect_ids: [],
      visible_result: errorResult(
        "prerequisite_failed",
        `failed prerequisites: ${failedPrerequisites.map((item) => item.prerequisite_id).join(", ")}`
      ),
      tainted_result_paths: [],
    }, "rejected");
  }

  const priorReceipt = tool.kind === "mutation"
    ? state.receipts.find((receipt) => receipt.tool === tool.name && receipt.semantic_key === key && committedReceipt(receipt))
    : undefined;
  if (priorReceipt) {
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.duplicate_detected",
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      semantic_key: key,
      prior_receipt_id: priorReceipt.receipt_id,
      policy: tool.duplicate_policy,
    });
    if (tool.duplicate_policy === "return_prior") {
      const authoritativeResult = priorReceipt.authoritative_result ?? {};
      return finish({
        receipt_id: receiptId,
        invocation_id: invocation.invocation_id,
        tool: tool.name,
        arguments: invocation.arguments,
        attempt,
        turn: invocation.turn,
        status: "deduplicated",
        committed: false,
        semantic_key: key,
        duplicate_of_receipt_id: priorReceipt.receipt_id,
        prerequisite_evidence: evidence,
        effect_ids: [],
        authoritative_result: authoritativeResult,
        visible_result: { ok: true, data: authoritativeResult },
        tainted_result_paths: tool.result.tainted_paths,
      }, "deduplicated");
    }
    if (tool.duplicate_policy === "reject") {
      return finish({
        receipt_id: receiptId,
        invocation_id: invocation.invocation_id,
        tool: tool.name,
        arguments: invocation.arguments,
        attempt,
        turn: invocation.turn,
        status: "rejected",
        committed: false,
        semantic_key: key,
        duplicate_of_receipt_id: priorReceipt.receipt_id,
        prerequisite_evidence: evidence,
        effect_ids: [],
        visible_result: errorResult("duplicate_intent", "this semantic mutation was already committed"),
        tainted_result_paths: [],
      }, "rejected");
    }
  }

  const fault = tool.faults.find((candidate) =>
    candidate.attempt === attempt && candidate.when.every((predicate) => evaluatePredicate(predicate, context).passed)
  );
  if (fault?.phase === "before_commit") {
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.fault_injected",
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      fault_id: fault.id,
      phase: fault.phase,
      error_code: fault.visible_error.code,
    });
    return finish({
      receipt_id: receiptId,
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      arguments: invocation.arguments,
      attempt,
      turn: invocation.turn,
      status: "failed_before_commit",
      committed: false,
      semantic_key: key,
      ...(priorReceipt ? { duplicate_of_receipt_id: priorReceipt.receipt_id } : {}),
      prerequisite_evidence: evidence,
      effect_ids: [],
      visible_result: { ok: false, error: fault.visible_error },
      tainted_result_paths: [],
    }, "failed");
  }

  const effects: WorldEffect[] = [];
  for (const [index, effectSpec] of tool.effects.entries()) {
    const before = valueAtPath(state.facts, effectSpec.path);
    const resolved = resolveValue(effectSpec.value, context);
    if (resolved === undefined) {
      throw new ToolWorldDefinitionError(`tool "${tool.name}" effect "${effectSpec.path}" resolves to undefined`);
    }
    let after: JsonValue;
    if (effectSpec.operation === "set") {
      after = structuredClone(resolved);
    } else if (effectSpec.operation === "increment") {
      if (typeof before !== "number" || typeof resolved !== "number") {
        throw new ToolWorldDefinitionError(`increment effect "${effectSpec.path}" requires numeric current and delta values`);
      }
      after = before + resolved;
    } else {
      if (!Array.isArray(before)) {
        throw new ToolWorldDefinitionError(`append effect "${effectSpec.path}" requires an existing array`);
      }
      after = [...before, structuredClone(resolved)];
    }
    setValueAtPath(state.facts, effectSpec.path, after);
    const priorEffectId = priorReceipt?.effect_ids[index];
    const effect: WorldEffect = {
      effect_id: `${receiptId}:effect:${index + 1}`,
      receipt_id: receiptId,
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      semantic_key: key,
      event_sequence: state.next_event_sequence,
      operation: effectSpec.operation,
      path: effectSpec.path,
      ...(before === undefined ? {} : { before }),
      after,
      ...(priorEffectId ? { duplicate_of_effect_id: priorEffectId } : {}),
    };
    effects.push(effect);
    state.effects.push(effect);
    appendEvent(state, scenario, invocation.turn, { type: "world.effect_committed", effect });
  }

  const authoritativeResult = materializeResult(tool, context);
  if (fault?.phase === "after_commit") {
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.fault_injected",
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      fault_id: fault.id,
      phase: fault.phase,
      error_code: fault.visible_error.code,
    });
    return finish({
      receipt_id: receiptId,
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      arguments: invocation.arguments,
      attempt,
      turn: invocation.turn,
      status: "committed_after_error",
      committed: true,
      semantic_key: key,
      ...(priorReceipt ? { duplicate_of_receipt_id: priorReceipt.receipt_id } : {}),
      prerequisite_evidence: evidence,
      effect_ids: effects.map((effect) => effect.effect_id),
      authoritative_result: authoritativeResult,
      visible_result: { ok: false, error: fault.visible_error },
      tainted_result_paths: tool.result.tainted_paths,
    }, "failed");
  }

  return finish({
    receipt_id: receiptId,
    invocation_id: invocation.invocation_id,
    tool: tool.name,
    arguments: invocation.arguments,
    attempt,
    turn: invocation.turn,
    status: "succeeded",
    committed: tool.kind === "mutation",
    semantic_key: key,
    ...(priorReceipt ? { duplicate_of_receipt_id: priorReceipt.receipt_id } : {}),
    prerequisite_evidence: evidence,
    effect_ids: effects.map((effect) => effect.effect_id),
    authoritative_result: authoritativeResult,
    visible_result: { ok: true, data: authoritativeResult },
    tainted_result_paths: tool.result.tainted_paths,
  }, "executed");
}

function compareCount(actual: number, operator: "equals" | "less_than_or_equal" | "greater_than_or_equal", expected: number): boolean {
  if (operator === "equals") return actual === expected;
  if (operator === "less_than_or_equal") return actual <= expected;
  return actual >= expected;
}

export function evaluateWorldAssertion(stateInput: unknown, assertion: WorldAssertion): AssertionEvaluation {
  const state = ToolWorldStateSchema.parse(stateInput);
  let passed = false;
  let actual: JsonValue = null;
  let expected: JsonValue | undefined;
  if (assertion.kind === "fact") {
    const evidence = evaluatePredicate(assertion.predicate, { world: state.facts, arguments: {}, runtime: {} });
    passed = evidence.passed;
    actual = evidence.actual ?? null;
    expected = evidence.expected;
  } else if (assertion.kind === "effect_count") {
    const count = state.effects.filter((effect) =>
      effect.tool === assertion.tool && (assertion.path === undefined || effect.path === assertion.path)
    ).length;
    passed = compareCount(count, assertion.operator, assertion.value);
    actual = count;
    expected = assertion.value;
  } else if (assertion.kind === "effect_order") {
    const before = state.effects.filter((effect) => effect.tool === assertion.before_tool).map((effect) => effect.event_sequence);
    const after = state.effects.filter((effect) => effect.tool === assertion.after_tool).map((effect) => effect.event_sequence);
    passed = before.length > 0 && after.length > 0 && Math.max(...before) < Math.min(...after);
    actual = { before_sequences: before, after_sequences: after };
    expected = "every before-tool effect precedes every after-tool effect";
  } else if (assertion.kind === "no_duplicate_effect") {
    const duplicates = state.effects.filter((effect) =>
      effect.duplicate_of_effect_id && (assertion.tool === undefined || effect.tool === assertion.tool)
    );
    passed = duplicates.length === 0;
    actual = duplicates.map((effect) => effect.effect_id);
    expected = [];
  } else {
    const violatingReceipts = state.receipts.filter((receipt) =>
      receipt.committed &&
      (assertion.tool === undefined || receipt.tool === assertion.tool) &&
      receipt.prerequisite_evidence.some((item) => !item.passed)
    );
    passed = violatingReceipts.length === 0;
    actual = violatingReceipts.map((receipt) => receipt.receipt_id);
    expected = [];
  }
  return {
    assertion_id: assertion.id,
    description: assertion.description,
    severity: assertion.severity,
    passed,
    actual,
    ...(expected === undefined ? {} : { expected }),
  };
}

export function evaluateScenarioWorld(scenarioInput: unknown, stateInput: unknown) {
  const scenario = BenchmarkScenarioSchema.parse(scenarioInput);
  const state = ToolWorldStateSchema.parse(stateInput);
  const success = scenario.success_assertions.map((assertion) => evaluateWorldAssertion(state, assertion));
  const safety = scenario.safety_invariants.map((assertion) => evaluateWorldAssertion(state, assertion));
  return {
    success,
    safety,
    task_success: success.every((result) => result.passed) && safety
      .filter((result) => result.severity === "critical")
      .every((result) => result.passed),
  };
}
