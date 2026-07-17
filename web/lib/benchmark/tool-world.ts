import { z } from "zod";
import { createHash } from "node:crypto";
import {
  BenchmarkScenarioSchema,
  ContentHashSchema,
  JsonValueSchema,
  ToolInvocationSchema,
  WorldEffectSchema,
  WorldAdmissionSchema,
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
  type WorldAdmission,
  type WorldEffect,
  type WorldReceipt,
} from "./scenario-schema";
import { WorldEventSchema, type WorldEvent } from "./world-events";

export const ToolWorldStateSchema = z.object({
  schema_version: z.literal(2),
  scenario_id: z.string().min(1),
  scenario_version: z.string().min(1),
  scenario_hash: ContentHashSchema,
  facts: z.record(z.string(), JsonValueSchema),
  /** All non-replay requests, including malformed and rejected requests. Never drives fault injection. */
  attempts: z.record(z.string(), z.number().int().nonnegative()),
  admissions: z.array(WorldAdmissionSchema),
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

type WorldEventEnvelopeKey =
  | "schema_version"
  | "event_id"
  | "sequence"
  | "scenario_id"
  | "scenario_version"
  | "scenario_hash"
  | "turn";
type WorldEventPayload = WorldEvent extends infer Event
  ? Event extends WorldEvent
    ? Omit<Event, WorldEventEnvelopeKey>
    : never
  : never;

export class ToolWorldDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolWorldDefinitionError";
  }
}

export const TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS = Object.freeze({
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxArrayLength: 100_000,
  maxObjectKeys: 100_000,
  maxStringLength: 1_000_000,
  maxAggregateStringLength: 16_000_000,
});

/** Bound adversarial persisted evidence before recursive schema parsing. */
function assertToolWorldEvidenceResourceBounds(input: unknown, label: string): void {
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value: input, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;
  let aggregateStringLength = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.exit) {
      active.delete(current.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS.maxNodes) {
      throw new ToolWorldDefinitionError(`${label} exceeds the ToolWorld evidence node limit`);
    }
    if (current.depth > TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS.maxDepth) {
      throw new ToolWorldDefinitionError(`${label} exceeds the ToolWorld evidence depth limit`);
    }
    if (typeof current.value === "string") {
      if (current.value.length > TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS.maxStringLength) {
        throw new ToolWorldDefinitionError(`${label} contains a string beyond the ToolWorld evidence limit`);
      }
      aggregateStringLength += current.value.length;
      if (aggregateStringLength > TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS.maxAggregateStringLength) {
        throw new ToolWorldDefinitionError(`${label} exceeds the ToolWorld aggregate string limit`);
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (active.has(current.value)) {
      throw new ToolWorldDefinitionError(`${label} is not a canonical JSON tree`);
    }
    active.add(current.value);
    stack.push({ value: current.value, depth: current.depth, exit: true });
    if (Array.isArray(current.value)) {
      if (current.value.length > TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS.maxArrayLength) {
        throw new ToolWorldDefinitionError(`${label} contains an array beyond the ToolWorld evidence limit`);
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    const values = Object.values(current.value);
    if (values.length > TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS.maxObjectKeys) {
      throw new ToolWorldDefinitionError(`${label} contains an object beyond the ToolWorld evidence key limit`);
    }
    for (let index = values.length - 1; index >= 0; index -= 1) {
      stack.push({ value: values[index], depth: current.depth + 1 });
    }
  }
}

/** Stable JSON serialization used for semantic intent keys and deep equality. */
export function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return '"$benchmark.undefined"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function contentHash(value: JsonValue): string {
  return `sha256:${createHash("sha256")
    .update(`harshas-amazing-call-center/tool-world/v2/json\n${canonicalJson(value)}`)
    .digest("hex")}`;
}

/** Hashes the fully parsed scenario, including schema defaults, not just its public id/version. */
export function scenarioContentHash(input: unknown): string {
  const scenario = BenchmarkScenarioSchema.parse(input);
  return `sha256:${createHash("sha256")
    .update(`harshas-amazing-call-center/voice-condition-compiler/v1/scenario\n${canonicalJson(scenario as unknown as JsonValue)}`)
    .digest("hex")}`;
}

function splitPath(path: string): string[] {
  return path.split(".");
}

type ResolvedJson = { present: false } | { present: true; value: JsonValue };

function canonicalArrayIndex(segment: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
  const index = Number(segment);
  return Number.isSafeInteger(index) ? index : undefined;
}

/** Presence-aware lookup: JSON null is present; an absent/invalid path is not. */
export function lookupValueAtPath(root: unknown, path: string): ResolvedJson {
  let current: unknown = root;
  for (const segment of splitPath(path)) {
    if (Array.isArray(current)) {
      const index = canonicalArrayIndex(segment);
      if (index === undefined || index >= current.length || !Object.hasOwn(current, index)) return { present: false };
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return { present: false };
    current = (current as Record<string, unknown>)[segment];
  }
  const parsed = JsonValueSchema.safeParse(current);
  return parsed.success ? { present: true, value: parsed.data } : { present: false };
}

export function valueAtPath(root: unknown, path: string): JsonValue | undefined {
  const resolved = lookupValueAtPath(root, path);
  return resolved.present ? resolved.value : undefined;
}

/** World writes never synthesize intermediate containers or sparse/non-index array properties. */
function setWorldValueAtPath(root: Record<string, JsonValue>, path: string, value: JsonValue): void {
  const segments = splitPath(path);
  let current: Record<string, JsonValue> | JsonValue[] = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    let existing: JsonValue | undefined;
    if (Array.isArray(current)) {
      const arrayIndex = canonicalArrayIndex(segment);
      if (arrayIndex === undefined || arrayIndex >= current.length || !Object.hasOwn(current, arrayIndex)) {
        throw new ToolWorldDefinitionError(`effect path "${path}" contains a missing or non-canonical array index "${segment}"`);
      }
      existing = current[arrayIndex];
    } else {
      if (!Object.hasOwn(current, segment)) {
        throw new ToolWorldDefinitionError(`effect path "${path}" has missing intermediate segment "${segment}"`);
      }
      existing = current[segment];
    }
    if (existing === null || typeof existing !== "object") {
      throw new ToolWorldDefinitionError(`effect path "${path}" traverses non-container segment "${segment}"`);
    }
    current = existing as Record<string, JsonValue> | JsonValue[];
  }
  const finalSegment = segments[segments.length - 1];
  if (Array.isArray(current)) {
    const arrayIndex = canonicalArrayIndex(finalSegment);
    if (arrayIndex === undefined || arrayIndex >= current.length || !Object.hasOwn(current, arrayIndex)) {
      throw new ToolWorldDefinitionError(`effect path "${path}" cannot create a sparse or named array property`);
    }
    current[arrayIndex] = value;
  } else {
    current[finalSegment] = value;
  }

  const written = lookupValueAtPath(root, path);
  if (!written.present || !deepEqual(written.value, value)) {
    throw new ToolWorldDefinitionError(`effect path "${path}" did not persist its authoritative value`);
  }
}

/** Result construction may create containers, but only contiguously and without sparse arrays. */
function setResultValueAtPath(root: Record<string, JsonValue>, path: string, value: JsonValue): void {
  const segments = splitPath(path);
  let current: Record<string, JsonValue> | JsonValue[] = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextIsArray = canonicalArrayIndex(segments[index + 1]) !== undefined;
    let existing: JsonValue | undefined;
    if (Array.isArray(current)) {
      const arrayIndex = canonicalArrayIndex(segment);
      if (arrayIndex === undefined || arrayIndex > current.length) {
        throw new ToolWorldDefinitionError(`result path "${path}" would create a sparse or named array property`);
      }
      if (arrayIndex === current.length) current.push(nextIsArray ? [] : {});
      existing = current[arrayIndex];
    } else {
      existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
      if (existing === undefined) {
        existing = nextIsArray ? [] : {};
        current[segment] = existing;
      }
    }
    if (existing === null || typeof existing !== "object") {
      throw new ToolWorldDefinitionError(`result path "${path}" conflicts with scalar segment "${segment}"`);
    }
    current = existing as Record<string, JsonValue> | JsonValue[];
  }
  const finalSegment = segments[segments.length - 1];
  if (Array.isArray(current)) {
    const arrayIndex = canonicalArrayIndex(finalSegment);
    if (arrayIndex === undefined || arrayIndex > current.length) {
      throw new ToolWorldDefinitionError(`result path "${path}" would create a sparse or named array property`);
    }
    if (arrayIndex === current.length) current.push(value);
    else current[arrayIndex] = value;
  } else {
    current[finalSegment] = value;
  }
}

function resolveValue(source: ValueSource, context: EvaluationContext): ResolvedJson {
  if ("literal" in source) return { present: true, value: source.literal };
  return lookupValueAtPath(context[source.source], source.path);
}

function deepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function ownRecordValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function evaluatePredicate(predicate: Predicate, context: EvaluationContext): PrerequisiteEvidence {
  const left = resolveValue(predicate.left, context);
  const right = predicate.right ? resolveValue(predicate.right, context) : undefined;
  let passed = false;
  switch (predicate.operator) {
    case "equals":
      passed = left.present && right?.present === true && deepEqual(left.value, right.value);
      break;
    case "not_equals":
      passed = left.present && right?.present === true && !deepEqual(left.value, right.value);
      break;
    case "exists":
      passed = left.present;
      break;
    case "not_exists":
      passed = !left.present;
      break;
    case "in":
      passed = left.present && right?.present === true && Array.isArray(right.value)
        && right.value.some((candidate) => deepEqual(left.value, candidate));
      break;
    case "greater_than_or_equal":
      passed = left.present && right?.present === true
        && typeof left.value === "number" && typeof right.value === "number" && left.value >= right.value;
      break;
    case "less_than_or_equal":
      passed = left.present && right?.present === true
        && typeof left.value === "number" && typeof right.value === "number" && left.value <= right.value;
      break;
    case "contains":
      passed = left.present && right?.present === true && (
        typeof left.value === "string" && typeof right.value === "string"
          ? left.value.includes(right.value)
          : Array.isArray(left.value) && left.value.some((candidate) => deepEqual(candidate, right.value))
      );
      break;
  }
  return {
    prerequisite_id: predicate.id,
    description: predicate.description,
    passed,
    actual_present: left.present,
    ...(right === undefined ? {} : { expected_present: right.present }),
    ...(left.present ? { actual: left.value } : {}),
    ...(right?.present ? { expected: right.value } : {}),
  };
}

function appendEvent(
  state: ToolWorldState,
  scenario: BenchmarkScenario,
  turn: number,
  payload: WorldEventPayload
): WorldEvent {
  const sequence = state.next_event_sequence;
  const event = WorldEventSchema.parse({
    schema_version: 2,
    event_id: `evt_${String(sequence).padStart(6, "0")}`,
    sequence,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    scenario_hash: state.scenario_hash,
    turn,
    ...payload,
  });
  state.events.push(event);
  state.next_event_sequence += 1;
  return event;
}

function parseToolWorldState(input: unknown): ToolWorldState {
  if (input && typeof input === "object" && (input as { schema_version?: unknown }).schema_version === 1) {
    throw new ToolWorldDefinitionError(
      "ToolWorld state schema v1 is not bound to scenario content and cannot be safely resumed; restart the run from createToolWorld()"
    );
  }
  return ToolWorldStateSchema.parse(input);
}

/** Parse and fully replay-verify a persisted world against the exact scenario content. */
export function parseBoundToolWorldState(scenarioInput: unknown, input: unknown): ToolWorldState {
  assertToolWorldEvidenceResourceBounds(scenarioInput, "scenario");
  assertToolWorldEvidenceResourceBounds(input, "persisted ToolWorld state");
  const scenario = BenchmarkScenarioSchema.parse(scenarioInput);
  const state = parseToolWorldState(input);
  const expectedHash = scenarioContentHash(scenario);
  if (
    state.scenario_id !== scenario.id
    || state.scenario_version !== scenario.version
    || state.scenario_hash !== expectedHash
  ) {
    throw new ToolWorldDefinitionError(
      `world is bound to ${state.scenario_id}@${state.scenario_version} (${state.scenario_hash}), not ${scenario.id}@${scenario.version} (${expectedHash})`
    );
  }
  if (state.next_event_sequence !== state.events.length + 1) {
    throw new ToolWorldDefinitionError("world event sequence cursor is inconsistent with persisted events");
  }
  for (const [index, event] of state.events.entries()) {
    const expectedSequence = index + 1;
    if (
      event.sequence !== expectedSequence
      || event.event_id !== `evt_${String(expectedSequence).padStart(6, "0")}`
      || event.scenario_id !== state.scenario_id
      || event.scenario_version !== state.scenario_version
      || event.scenario_hash !== state.scenario_hash
    ) {
      throw new ToolWorldDefinitionError(`world event ${index + 1} has inconsistent sequence or scenario binding`);
    }
  }
  if (state.events[0]?.type !== "world.initialized"
    || state.events.filter((event) => event.type === "world.initialized").length !== 1) {
    throw new ToolWorldDefinitionError("world event ledger must begin with world.initialized");
  }
  const initialized = state.events[0];
  if (initialized.type !== "world.initialized" || initialized.turn !== 0) {
    throw new ToolWorldDefinitionError("world initialization event must be at turn zero");
  }
  if (initialized.initial_fact_count !== Object.keys(scenario.initial_facts).length) {
    throw new ToolWorldDefinitionError("world initialization event has an invalid initial fact count");
  }
  const outOfHorizon = state.events.find((event) => event.turn > scenario.max_turns);
  if (outOfHorizon) {
    throw new ToolWorldDefinitionError(
      `world event "${outOfHorizon.event_id}" turn ${outOfHorizon.turn} exceeds scenario max_turns ${scenario.max_turns}`
    );
  }

  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new ToolWorldDefinitionError(`world contains duplicate ${label}`);
  };
  unique(state.admissions.map((admission) => admission.admission_id), "admission ids");
  unique(state.receipts.map((receipt) => receipt.receipt_id), "receipt ids");
  unique(state.receipts.map((receipt) => receipt.invocation_id), "receipt invocation ids");
  unique(state.effects.map((effect) => effect.effect_id), "effect ids");
  if (state.events.filter((event) => event.type === "tool.execution_admitted").length !== state.admissions.length) {
    throw new ToolWorldDefinitionError("world contains orphan or missing admission events");
  }
  if (state.events.filter((event) => event.type === "tool.receipt_recorded").length !== state.receipts.length) {
    throw new ToolWorldDefinitionError("world contains orphan or missing receipt events");
  }
  if (state.events.filter((event) => event.type === "world.effect_committed").length !== state.effects.length) {
    throw new ToolWorldDefinitionError("world contains orphan or missing effect events");
  }
  const orderedAdmissionIds = state.events.flatMap((event) =>
    event.type === "tool.execution_admitted" ? [event.admission.admission_id] : []
  );
  const orderedReceiptIds = state.events.flatMap((event) =>
    event.type === "tool.receipt_recorded" ? [event.receipt.receipt_id] : []
  );
  const orderedEffectIds = state.events.flatMap((event) =>
    event.type === "world.effect_committed" ? [event.effect.effect_id] : []
  );
  if (canonicalJson(orderedAdmissionIds) !== canonicalJson(state.admissions.map((item) => item.admission_id))) {
    throw new ToolWorldDefinitionError("world admission rows are not in canonical event order");
  }
  if (canonicalJson(orderedReceiptIds) !== canonicalJson(state.receipts.map((item) => item.receipt_id))) {
    throw new ToolWorldDefinitionError("world receipt rows are not in canonical event order");
  }
  if (canonicalJson(orderedEffectIds) !== canonicalJson(state.effects.map((item) => item.effect_id))) {
    throw new ToolWorldDefinitionError("world effect rows are not in canonical event order");
  }

  for (const admission of state.admissions) {
    const events = state.events.filter((event) =>
      event.type === "tool.execution_admitted" && event.admission.admission_id === admission.admission_id
    );
    if (
      events.length !== 1
      || events[0].type !== "tool.execution_admitted"
      || events[0].sequence !== admission.event_sequence
      || events[0].turn !== admission.turn
      || admission.admission_id !== `adm:${scenario.id}:${admission.invocation_id}`
      || canonicalJson(events[0].admission as unknown as JsonValue) !== canonicalJson(admission as unknown as JsonValue)
    ) {
      throw new ToolWorldDefinitionError(`admission "${admission.admission_id}" is not bound to exactly one matching event`);
    }
  }
  for (const receipt of state.receipts) {
    const events = state.events.filter((event) =>
      event.type === "tool.receipt_recorded" && event.receipt.receipt_id === receipt.receipt_id
    );
    if (
      events.length !== 1
      || events[0].type !== "tool.receipt_recorded"
      || events[0].turn !== receipt.turn
      || receipt.receipt_id !== `rcpt:${scenario.id}:${receipt.invocation_id}`
      || canonicalJson(events[0].receipt as unknown as JsonValue) !== canonicalJson(receipt as unknown as JsonValue)
    ) {
      throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" is not bound to exactly one matching event`);
    }
    const replayEvents = state.events.filter((event): event is Extract<WorldEvent, { type: "tool.invocation_replayed" }> =>
      event.type === "tool.invocation_replayed" && event.invocation_id === receipt.invocation_id
    );
    const invocationEvents = state.events.filter((event): event is Extract<WorldEvent, { type: "tool.invocation_received" }> =>
      event.type === "tool.invocation_received" && event.invocation_id === receipt.invocation_id
    );
    const visibleEvents = state.events.filter((event) =>
      event.type === "tool.result_visible" && event.invocation_id === receipt.invocation_id
    );
    if (visibleEvents.length !== replayEvents.length + 1) {
      throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" is missing or has orphan provider-visible result events`);
    }
    if (
      invocationEvents.length !== replayEvents.length + 1
      || invocationEvents[0]?.turn !== receipt.turn
      || invocationEvents[0]?.sequence + 1 >= events[0].sequence
      || invocationEvents[0]?.sequence >= events[0].sequence
      || invocationEvents.some((event) =>
        event.tool !== receipt.tool
        || !deepEqual(event.arguments, receipt.arguments)
        || event.idempotency_key !== receipt.idempotency_key
        || event.semantic_opportunity_id !== receipt.semantic_opportunity_id
      )
    ) {
      throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" is not bound to its original invocation identity`);
    }
    const validationEvents = state.events.filter((event): event is Extract<WorldEvent, { type: "tool.arguments_validated" }> =>
      event.type === "tool.arguments_validated" && event.invocation_id === receipt.invocation_id
    );
    const definition = scenario.tools.find((candidate) => candidate.name === receipt.tool);
    const expectedArgumentIssues = definition
      ? validateArguments(definition, receipt.arguments)
      : [`unknown tool "${receipt.tool}"`];
    if (
      validationEvents.length !== 1
      || validationEvents[0].sequence !== invocationEvents[0].sequence + 1
      || validationEvents[0].sequence >= events[0].sequence
      || validationEvents[0].turn !== receipt.turn
      || validationEvents[0].tool !== receipt.tool
      || validationEvents[0].valid !== (expectedArgumentIssues.length === 0)
      || canonicalJson(validationEvents[0].issues) !== canonicalJson(expectedArgumentIssues)
    ) {
      throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" has an invalid argument-validation event`);
    }
    const prerequisiteEvents = state.events.filter((event): event is Extract<WorldEvent, { type: "tool.prerequisite_evaluated" }> =>
      event.type === "tool.prerequisite_evaluated" && event.invocation_id === receipt.invocation_id
    );
    if (
      prerequisiteEvents.length !== receipt.prerequisite_evidence.length
      || prerequisiteEvents.some((event, index) =>
        event.turn !== receipt.turn
        || event.tool !== receipt.tool
        || event.sequence <= validationEvents[0].sequence
        || event.sequence >= events[0].sequence
        || (index > 0 && event.sequence !== prerequisiteEvents[index - 1].sequence + 1)
        || canonicalJson(event.evidence as unknown as JsonValue)
          !== canonicalJson(receipt.prerequisite_evidence[index] as unknown as JsonValue)
      )
    ) {
      throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" has an invalid prerequisite event sequence`);
    }
    for (const replay of replayEvents) {
      const preceding = state.events[replay.sequence - 2];
      const following = state.events[replay.sequence];
      if (
        replay.original_receipt_id !== receipt.receipt_id
        || replay.sequence <= events[0].sequence
        || replay.tool !== receipt.tool
        || replay.original_turn !== receipt.turn
        || replay.replay_turn < receipt.turn
        || replay.turn !== replay.replay_turn
        || preceding?.type !== "tool.invocation_received"
        || preceding.invocation_id !== receipt.invocation_id
        || following?.type !== "tool.result_visible"
        || following.invocation_id !== receipt.invocation_id
      ) {
        throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" has an invalid exact-replay event sequence`);
      }
    }
    const initialVisible = state.events[events[0].sequence];
    if (
      initialVisible?.type !== "tool.result_visible"
      || initialVisible.invocation_id !== receipt.invocation_id
      || initialVisible.turn !== receipt.turn
    ) {
      throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" is not immediately followed by its initial visible result`);
    }
    const linkedEffectIds = state.effects
      .filter((effect) => effect.receipt_id === receipt.receipt_id)
      .sort((left, right) => left.event_sequence - right.event_sequence)
      .map((effect) => effect.effect_id);
    if (canonicalJson(linkedEffectIds) !== canonicalJson(receipt.effect_ids)) {
      throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" effect ledger does not match its authoritative effect ids`);
    }
    for (const [index, effectId] of receipt.effect_ids.entries()) {
      if (effectId !== `${receipt.receipt_id}:effect:${index + 1}`) {
        throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" has a noncanonical effect id`);
      }
    }
    if (receipt.admission_id) {
      const admission = state.admissions.find((candidate) => candidate.admission_id === receipt.admission_id);
      if (!admission) throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" references a missing admission`);
      if (
        admission.invocation_id !== receipt.invocation_id
        || admission.tool !== receipt.tool
        || admission.semantic_key !== receipt.semantic_key
        || admission.turn !== receipt.turn
        || admission.request_attempt !== receipt.attempt
        || admission.semantic_opportunity_id !== receipt.semantic_opportunity_id
      ) {
        throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" does not match its admission identity`);
      }
    }
    const faultEvents = state.events.filter((event) =>
      event.type === "tool.fault_injected" && event.admission_id === receipt.admission_id
    );
    const expectedFaultEvents = receipt.status === "failed_before_commit" || receipt.status === "committed_after_error" ? 1 : 0;
    if (faultEvents.length !== expectedFaultEvents) {
      throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" has ${faultEvents.length} fault events, expected ${expectedFaultEvents}`);
    }
  }
  const replayCount = state.events.filter((event) => event.type === "tool.invocation_replayed").length;
  const expectedPrerequisiteEventCount = state.receipts.reduce(
    (count, receipt) => count + receipt.prerequisite_evidence.length,
    0
  );
  const expectedDuplicateEventCount = state.receipts.filter(
    (receipt) => receipt.duplicate_of_receipt_id !== undefined
  ).length;
  const exactEventCounts: ReadonlyArray<readonly [WorldEvent["type"], number]> = [
    ["tool.invocation_received", state.receipts.length + replayCount],
    ["tool.arguments_validated", state.receipts.length],
    ["tool.prerequisite_evaluated", expectedPrerequisiteEventCount],
    ["tool.duplicate_detected", expectedDuplicateEventCount],
    ["tool.result_visible", state.receipts.length + replayCount],
  ];
  for (const [type, expectedCount] of exactEventCounts) {
    const actualCount = state.events.filter((event) => event.type === type).length;
    if (actualCount !== expectedCount) {
      throw new ToolWorldDefinitionError(
        `world contains orphan or missing ${type} events: expected ${expectedCount}, found ${actualCount}`
      );
    }
  }
  const reconstructedAttempts: Record<string, number> = {};
  for (const event of state.events) {
    if (event.type !== "tool.receipt_recorded") continue;
    const tool = event.receipt.tool;
    const ordinal = (ownRecordValue(reconstructedAttempts, tool) ?? 0) + 1;
    reconstructedAttempts[tool] = ordinal;
    if (event.receipt.attempt !== ordinal) {
      throw new ToolWorldDefinitionError(`receipt "${event.receipt.receipt_id}" has forged raw request attempt ordinal`);
    }
  }
  if (canonicalJson(reconstructedAttempts) !== canonicalJson(state.attempts)) {
    throw new ToolWorldDefinitionError("persisted raw request attempts do not match receipt history");
  }

  const replayedFacts = structuredClone(scenario.initial_facts);
  const admissionFacts = new Map<string, Record<string, JsonValue>>();
  const toolAdmissionCounts = new Map<string, number>();
  const semanticAdmissionCounts = new Map<string, number>();
  const faultMatchCounts = new Map<string, number>();
  const expectedFaults = new Map<string, ToolDefinition["faults"][number]>();
  const consumedExternalFaults = new Set<string>();
  const committedBySemanticIntent = new Map<string, WorldReceipt>();
  const expectedPriorByAdmission = new Map<string, WorldReceipt>();
  for (const event of state.events) {
    if (event.type === "tool.execution_admitted") {
      const admission = state.admissions.find((candidate) => candidate.admission_id === event.admission.admission_id);
      const receipt = admission
        ? state.receipts.find((candidate) => candidate.invocation_id === admission.invocation_id)
        : undefined;
      const tool = admission ? scenario.tools.find((candidate) => candidate.name === admission.tool) : undefined;
      if (!admission || !receipt || !tool) {
        throw new ToolWorldDefinitionError(`admission "${event.admission.admission_id}" cannot be derived from scenario and receipt`);
      }
      const committedKey = `${tool.name}\u0000${admission.semantic_key}`;
      const priorCommitted = committedBySemanticIntent.get(committedKey);
      if (priorCommitted) {
        if (tool.duplicate_policy !== "execute") {
          throw new ToolWorldDefinitionError(`admission "${admission.admission_id}" bypasses duplicate policy ${tool.duplicate_policy}`);
        }
        expectedPriorByAdmission.set(admission.admission_id, priorCommitted);
      }
      const expectedToolOrdinal = (toolAdmissionCounts.get(tool.name) ?? 0) + 1;
      const semanticCounterKey = `${tool.name}\u0000${admission.semantic_key}`;
      const expectedSemanticOrdinal = (semanticAdmissionCounts.get(semanticCounterKey) ?? 0) + 1;
      if (admission.tool_ordinal !== expectedToolOrdinal || admission.semantic_ordinal !== expectedSemanticOrdinal) {
        throw new ToolWorldDefinitionError(`admission "${admission.admission_id}" has forged tool or semantic ordinal`);
      }
      toolAdmissionCounts.set(tool.name, expectedToolOrdinal);
      semanticAdmissionCounts.set(semanticCounterKey, expectedSemanticOrdinal);
      const runtime = admissionRuntime(admission, receipt);
      const argumentIssues = validateArguments(tool, receipt.arguments);
      const recomputedSemanticKey = argumentIssues.length === 0
        ? semanticKey(tool, {
          invocation_id: receipt.invocation_id,
          tool: receipt.tool,
          arguments: receipt.arguments,
          turn: receipt.turn,
          ...(receipt.idempotency_key ? { idempotency_key: receipt.idempotency_key } : {}),
          ...(receipt.semantic_opportunity_id
            ? { semantic_opportunity_id: receipt.semantic_opportunity_id }
            : {}),
        }, { world: replayedFacts, arguments: receipt.arguments, runtime })
        : undefined;
      if (
        argumentIssues.length > 0
        || recomputedSemanticKey !== admission.semantic_key
        || recomputedSemanticKey !== receipt.semantic_key
      ) {
        throw new ToolWorldDefinitionError(`admission "${admission.admission_id}" has invalid arguments or semantic identity`);
      }
      const computedEvidence = tool.prerequisites.map((predicate) => evaluatePredicate(predicate, {
        world: replayedFacts,
        arguments: receipt.arguments,
        runtime,
      }));
      const expectedFaultOrdinals: Record<string, number> = {};
      for (const fault of tool.faults) {
        if (!fault.when.every((predicate) => evaluatePredicate(predicate, {
          world: replayedFacts,
          arguments: receipt.arguments,
          runtime,
        }).passed)) continue;
        const counterKey = `${semanticCounterKey}\u0000${fault.id}`;
        const ordinal = (faultMatchCounts.get(counterKey) ?? 0) + 1;
        faultMatchCounts.set(counterKey, ordinal);
        expectedFaultOrdinals[fault.id] = ordinal;
      }
      if (
        admission.world_before_hash !== contentHash(replayedFacts)
        || admission.prerequisite_evidence_hash !== contentHash(computedEvidence as unknown as JsonValue)
        || canonicalJson(computedEvidence as unknown as JsonValue)
          !== canonicalJson(receipt.prerequisite_evidence as unknown as JsonValue)
        || canonicalJson(expectedFaultOrdinals) !== canonicalJson(admission.fault_match_ordinals)
        || !computedEvidence.every((item) => item.passed)
      ) {
        throw new ToolWorldDefinitionError(`admission "${admission.admission_id}" has forged world, prerequisite, or fault-match evidence`);
      }
      const scheduledFaults = tool.faults.filter((fault) => {
        const matchingOrdinal = ownRecordValue(admission.fault_match_ordinals, fault.id);
        if (matchingOrdinal === undefined) return false;
        if (fault.attempt !== undefined) return fault.attempt === matchingOrdinal;
        const externalKey = `${tool.name}\u0000${fault.id}\u0000${fault.semantic_opportunity_id}`;
        return fault.semantic_opportunity_id === admission.semantic_opportunity_id
          && !consumedExternalFaults.has(externalKey);
      });
      if (scheduledFaults.length > 1) {
        throw new ToolWorldDefinitionError(`admission "${admission.admission_id}" has multiple simultaneously scheduled faults`);
      }
      if (scheduledFaults[0]) expectedFaults.set(admission.admission_id, scheduledFaults[0]);
      admissionFacts.set(admission.admission_id, structuredClone(replayedFacts));
      continue;
    }

    if (event.type === "world.effect_committed") {
      const effect = state.effects.find((candidate) => candidate.effect_id === event.effect.effect_id);
      if (
        !effect
        || event.sequence !== effect.event_sequence
        || canonicalJson(event.effect as unknown as JsonValue) !== canonicalJson(effect as unknown as JsonValue)
      ) {
        throw new ToolWorldDefinitionError(`effect "${event.effect.effect_id}" is not bound to its outer event sequence and state row`);
      }
      const receipt = state.receipts.find((candidate) => candidate.receipt_id === effect.receipt_id);
      const tool = receipt ? scenario.tools.find((candidate) => candidate.name === receipt.tool) : undefined;
      const admission = receipt?.admission_id
        ? state.admissions.find((candidate) => candidate.admission_id === receipt.admission_id)
        : undefined;
      const effectIndex = receipt?.effect_ids.indexOf(effect.effect_id) ?? -1;
      const effectSpec = effectIndex >= 0 ? tool?.effects[effectIndex] : undefined;
      if (!receipt || !tool || !admission || !effectSpec) {
        throw new ToolWorldDefinitionError(`effect "${effect.effect_id}" cannot be derived from a bound tool receipt`);
      }
      if (
        effect.tool !== tool.name
        || event.turn !== receipt.turn
        || effect.invocation_id !== receipt.invocation_id
        || effect.semantic_key !== receipt.semantic_key
        || effect.operation !== effectSpec.operation
        || effect.path !== effectSpec.path
      ) {
        throw new ToolWorldDefinitionError(`effect "${effect.effect_id}" differs from its bound scenario operation`);
      }
      const priorCommitted = expectedPriorByAdmission.get(admission.admission_id);
      const expectedPriorEffectId = priorCommitted?.effect_ids
        .map((effectId) => state.effects.find((candidate) => candidate.effect_id === effectId))
        .find((candidate) => candidate?.path === effect.path && candidate.operation === effect.operation)
        ?.effect_id;
      if (effect.duplicate_of_effect_id !== expectedPriorEffectId) {
        throw new ToolWorldDefinitionError(`effect "${effect.effect_id}" has forged or missing duplicate lineage`);
      }
      const context: EvaluationContext = {
        world: replayedFacts,
        arguments: receipt.arguments,
        runtime: admissionRuntime(admission, receipt),
      };
      const before = lookupValueAtPath(replayedFacts, effect.path);
      const resolved = resolveValue(effectSpec.value, context);
      if (
        !resolved.present
        || before.present !== effect.before_present
        || (before.present && !deepEqual(before.value, effect.before))
      ) {
        throw new ToolWorldDefinitionError(`effect "${effect.effect_id}" does not follow its bound prerequisite world`);
      }
      let expectedAfter: JsonValue;
      if (effectSpec.operation === "set") {
        expectedAfter = structuredClone(resolved.value);
      } else if (effectSpec.operation === "increment") {
        if (!before.present || typeof before.value !== "number" || typeof resolved.value !== "number") {
          throw new ToolWorldDefinitionError(`effect "${effect.effect_id}" cannot recompute its numeric increment`);
        }
        expectedAfter = before.value + resolved.value;
      } else {
        if (!before.present || !Array.isArray(before.value)) {
          throw new ToolWorldDefinitionError(`effect "${effect.effect_id}" cannot recompute its append`);
        }
        expectedAfter = [...before.value, structuredClone(resolved.value)];
      }
      if (!deepEqual(expectedAfter, effect.after)) {
        throw new ToolWorldDefinitionError(`effect "${effect.effect_id}" after-value differs from the bound scenario operation`);
      }
      setWorldValueAtPath(replayedFacts, effect.path, expectedAfter);
      continue;
    }

    if (event.type === "tool.fault_injected") {
      const admission = state.admissions.find((candidate) => candidate.admission_id === event.admission_id);
      const receipt = admission
        ? state.receipts.find((candidate) => candidate.invocation_id === admission.invocation_id)
        : undefined;
      const tool = admission ? scenario.tools.find((candidate) => candidate.name === admission.tool) : undefined;
      const fault = tool?.faults.find((candidate) => candidate.id === event.fault_id);
      const receiptEvent = receipt
        ? state.events.find((candidate) => candidate.type === "tool.receipt_recorded"
          && candidate.receipt.receipt_id === receipt.receipt_id)
        : undefined;
      if (!admission || !receipt || !tool || !fault || !receiptEvent || !admissionFacts.has(admission.admission_id)) {
        throw new ToolWorldDefinitionError(`fault event "${event.event_id}" is not bound to a declared admitted execution`);
      }
      const expectedSchedule = fault.attempt !== undefined
        ? { kind: "fault_match_ordinal", value: fault.attempt }
        : { kind: "semantic_opportunity", value: fault.semantic_opportunity_id };
      const expectedStatus = fault.phase === "before_commit" ? "failed_before_commit" : "committed_after_error";
      const expectedFault = expectedFaults.get(admission.admission_id);
      const effectSequences = receipt.effect_ids.map((effectId) =>
        state.effects.find((effect) => effect.effect_id === effectId)?.event_sequence
      ).filter((sequence): sequence is number => sequence !== undefined);
      if (
        event.sequence <= admission.event_sequence
        || event.sequence >= receiptEvent.sequence
        || event.invocation_id !== admission.invocation_id
        || event.tool !== admission.tool
        || event.semantic_key !== admission.semantic_key
        || event.semantic_ordinal !== admission.semantic_ordinal
        || event.matching_ordinal !== ownRecordValue(admission.fault_match_ordinals, fault.id)
        || event.semantic_opportunity_id !== admission.semantic_opportunity_id
        || canonicalJson(event.schedule as unknown as JsonValue) !== canonicalJson(expectedSchedule as JsonValue)
        || expectedFault?.id !== fault.id
        || receipt.status !== expectedStatus
        || (fault.phase === "before_commit" && effectSequences.length > 0)
        || (fault.phase === "after_commit" && (
          effectSequences.length !== tool.effects.length
          || effectSequences.some((sequence) => sequence >= event.sequence)
        ))
      ) {
        throw new ToolWorldDefinitionError(`fault event "${event.event_id}" differs from its bound schedule or receipt`);
      }
      if (fault.semantic_opportunity_id) {
        consumedExternalFaults.add(`${tool.name}\u0000${fault.id}\u0000${fault.semantic_opportunity_id}`);
      }
      continue;
    }

    if (event.type === "tool.receipt_recorded") {
      const receipt = state.receipts.find((candidate) => candidate.receipt_id === event.receipt.receipt_id);
      const tool = receipt ? scenario.tools.find((candidate) => candidate.name === receipt.tool) : undefined;
      if (!receipt) {
        throw new ToolWorldDefinitionError(`receipt "${event.receipt.receipt_id}" has no bound scenario tool`);
      }
      if (!tool) {
        const expected = errorResult("unknown_tool", `unknown tool "${receipt.tool}"`);
        if (
          receipt.status !== "rejected"
          || receipt.committed
          || receipt.admission_id !== undefined
          || receipt.effect_ids.length > 0
          || receipt.authoritative_result !== undefined
          || receipt.duplicate_of_receipt_id !== undefined
          || receipt.prerequisite_evidence.length > 0
          || receipt.tainted_result_paths.length > 0
          || receipt.semantic_key !== `unknown:${receipt.tool}:${canonicalJson(receipt.arguments)}`
          || canonicalJson(receipt.visible_result as unknown as JsonValue)
            !== canonicalJson(expected as unknown as JsonValue)
        ) {
          throw new ToolWorldDefinitionError(`unknown-tool receipt "${receipt.receipt_id}" has forged rejection evidence`);
        }
        continue;
      }
      const admission = receipt.admission_id
        ? state.admissions.find((candidate) => candidate.admission_id === receipt.admission_id)
        : undefined;
      const receiptEffects = receipt.effect_ids.map((effectId) =>
        state.effects.find((candidate) => candidate.effect_id === effectId)
      );
      const expectedEffectCount = tool.kind === "mutation"
        && (receipt.status === "succeeded" || receipt.status === "committed_after_error")
        ? tool.effects.length
        : 0;
      if (
        (admission !== undefined && admission.event_sequence >= event.sequence)
        ||
        receiptEffects.length !== expectedEffectCount
        || receiptEffects.some((effect) => !effect)
        || receiptEffects.some((effect) => effect!.event_sequence >= event.sequence)
        || (admission && receiptEffects.some((effect) => effect!.event_sequence <= admission.event_sequence))
      ) {
        throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" omits, reorders, or misplaces declared effects`);
      }
      const expectedFault = receipt.admission_id ? expectedFaults.get(receipt.admission_id) : undefined;
      const recordedFault = receipt.admission_id
        ? state.events.find((candidate) => candidate.type === "tool.fault_injected"
          && candidate.admission_id === receipt.admission_id)
        : undefined;
      if (
        (expectedFault === undefined) !== (recordedFault === undefined)
        || (expectedFault && recordedFault?.type === "tool.fault_injected" && expectedFault.id !== recordedFault.fault_id)
      ) {
        throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" omitted or forged its scheduled fault outcome`);
      }
      const committedKey = `${tool.name}\u0000${receipt.semantic_key}`;
      const priorCommitted = committedBySemanticIntent.get(committedKey);
      const admissionPrior = receipt.admission_id ? expectedPriorByAdmission.get(receipt.admission_id) : undefined;
      const expectedPrior = admissionPrior ?? priorCommitted;
      const duplicateEvents = state.events.filter((candidate) =>
        candidate.type === "tool.duplicate_detected" && candidate.invocation_id === receipt.invocation_id
      );
      if (tool.kind === "mutation" && expectedPrior) {
        if (
          receipt.duplicate_of_receipt_id !== expectedPrior.receipt_id
          || duplicateEvents.length !== 1
          || duplicateEvents[0].type !== "tool.duplicate_detected"
          || duplicateEvents[0].prior_receipt_id !== expectedPrior.receipt_id
          || duplicateEvents[0].semantic_key !== receipt.semantic_key
          || duplicateEvents[0].policy !== tool.duplicate_policy
        ) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" has forged or missing duplicate lineage`);
        }
        if (tool.duplicate_policy === "return_prior" && (receipt.status !== "deduplicated" || receipt.admission_id)) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" bypasses return_prior reconciliation`);
        }
        const duplicateRejectionVisible = receipt.visible_result.ok === false
          && receipt.visible_result.error.code === "duplicate_intent";
        if (tool.duplicate_policy === "reject" && (
          receipt.status !== "rejected"
          || receipt.admission_id !== undefined
          || !duplicateRejectionVisible
        )) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" bypasses duplicate rejection`);
        }
      } else if (receipt.duplicate_of_receipt_id !== undefined || duplicateEvents.length > 0) {
        throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" claims duplicate lineage without a prior committed intent`);
      }
      if (receipt.status === "rejected") {
        const argumentIssues = validateArguments(tool, receipt.arguments);
        const rejectionRuntime: Record<string, JsonValue> = {
          attempt: (semanticAdmissionCounts.get(`${tool.name}\u0000${receipt.semantic_key}`) ?? 0) + 1,
          request_attempt: receipt.attempt,
          tool_ordinal: (toolAdmissionCounts.get(tool.name) ?? 0) + 1,
          semantic_ordinal: (semanticAdmissionCounts.get(`${tool.name}\u0000${receipt.semantic_key}`) ?? 0) + 1,
          turn: receipt.turn,
          invocation_id: receipt.invocation_id,
          ...(receipt.idempotency_key ? { idempotency_key: receipt.idempotency_key } : {}),
          ...(receipt.semantic_opportunity_id
            ? { semantic_opportunity_id: receipt.semantic_opportunity_id }
            : {}),
        };
        const expectedSemanticKey = argumentIssues.length === 0
          ? semanticKey(tool, {
            invocation_id: receipt.invocation_id,
            tool: receipt.tool,
            arguments: receipt.arguments,
            turn: receipt.turn,
            ...(receipt.idempotency_key ? { idempotency_key: receipt.idempotency_key } : {}),
            ...(receipt.semantic_opportunity_id
              ? { semantic_opportunity_id: receipt.semantic_opportunity_id }
              : {}),
          }, { world: replayedFacts, arguments: receipt.arguments, runtime: rejectionRuntime })
          : `invalid:${tool.name}:${canonicalJson(receipt.arguments)}`;
        let expectedVisible: VisibleToolResult | undefined;
        let expectedEvidence: PrerequisiteEvidence[] = [];
        if (priorCommitted && tool.duplicate_policy === "reject") {
          expectedVisible = errorResult("duplicate_intent", "this semantic mutation was already committed");
        } else if (argumentIssues.length > 0) {
          expectedVisible = errorResult("invalid_arguments", argumentIssues.join("; "));
        } else {
          expectedEvidence = tool.prerequisites.map((predicate) => evaluatePredicate(predicate, {
            world: replayedFacts,
            arguments: receipt.arguments,
            runtime: rejectionRuntime,
          }));
          const failed = expectedEvidence.filter((item) => !item.passed);
          if (failed.length > 0) {
            expectedVisible = errorResult(
              "prerequisite_failed",
              `failed prerequisites: ${failed.map((item) => item.prerequisite_id).join(", ")}`
            );
          }
        }
        if (
          !expectedVisible
          || receipt.committed
          || receipt.admission_id !== undefined
          || receipt.effect_ids.length > 0
          || receipt.authoritative_result !== undefined
          || receipt.tainted_result_paths.length > 0
          || receipt.semantic_key !== expectedSemanticKey
          || canonicalJson(receipt.prerequisite_evidence as unknown as JsonValue)
            !== canonicalJson(expectedEvidence as unknown as JsonValue)
          || canonicalJson(receipt.visible_result as unknown as JsonValue)
            !== canonicalJson(expectedVisible as unknown as JsonValue)
        ) {
          throw new ToolWorldDefinitionError(`rejected receipt "${receipt.receipt_id}" differs from deterministic validation`);
        }
      }
      if (["succeeded", "failed_before_commit", "committed_after_error"].includes(receipt.status) && !admission) {
        throw new ToolWorldDefinitionError(`admitted receipt "${receipt.receipt_id}" is missing its admission`);
      }
      if (receipt.status === "succeeded") {
        if (receipt.committed !== (tool.kind === "mutation")) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" has inconsistent success commit status`);
        }
      } else if (receipt.status === "committed_after_error") {
        if (!receipt.committed || tool.kind !== "mutation") {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" has an impossible after-commit status`);
        }
      } else if (receipt.committed) {
        throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" cannot be committed with status ${receipt.status}`);
      }

      if (receipt.status === "succeeded" || receipt.status === "committed_after_error") {
        const expectedResult = materializeResult(tool, {
          world: replayedFacts,
          arguments: receipt.arguments,
          runtime: admissionRuntime(admission!, receipt),
        });
        if (!deepEqual(expectedResult, receipt.authoritative_result)) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" authoritative result differs from bound world state`);
        }
        if (canonicalJson(receipt.tainted_result_paths as unknown as JsonValue)
          !== canonicalJson(tool.result.tainted_paths as unknown as JsonValue)) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" taint metadata differs from bound scenario`);
        }
      }
      if (receipt.status === "succeeded") {
        if (!receipt.visible_result.ok || !deepEqual(receipt.visible_result.data, receipt.authoritative_result)) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" visible success differs from authoritative result`);
        }
      }
      if (receipt.status === "deduplicated") {
        const prior = receipt.duplicate_of_receipt_id
          ? state.receipts.find((candidate) => candidate.receipt_id === receipt.duplicate_of_receipt_id)
          : undefined;
        if (!prior || !committedReceipt(prior) || prior.semantic_key !== receipt.semantic_key
          || !deepEqual(prior.authoritative_result, receipt.authoritative_result)) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" does not reconcile to an authoritative prior receipt`);
        }
        if (!receipt.visible_result.ok || !deepEqual(receipt.visible_result.data, receipt.authoritative_result)) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" deduplicated result differs from authoritative prior result`);
        }
        if (
          receipt.admission_id !== undefined
          || receipt.prerequisite_evidence.length > 0
          || receipt.effect_ids.length > 0
          || canonicalJson(receipt.tainted_result_paths as unknown as JsonValue)
            !== canonicalJson(prior.tainted_result_paths as unknown as JsonValue)
        ) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" has invalid deduplicated evidence or taint metadata`);
        }
      }
      if (receipt.status === "failed_before_commit" || receipt.status === "committed_after_error") {
        const faultEvent = state.events.find((candidate) =>
          candidate.type === "tool.fault_injected" && candidate.admission_id === receipt.admission_id
        );
        const fault = faultEvent?.type === "tool.fault_injected"
          ? tool.faults.find((candidate) => candidate.id === faultEvent.fault_id)
          : undefined;
        const visibleError = receipt.visible_result.ok === false ? receipt.visible_result.error : undefined;
        if (
          !faultEvent
          || faultEvent.type !== "tool.fault_injected"
          || !fault
          || fault.phase !== faultEvent.phase
          || fault.visible_error.code !== faultEvent.error_code
          || !visibleError
          || canonicalJson(visibleError as unknown as JsonValue)
            !== canonicalJson(fault.visible_error as unknown as JsonValue)
        ) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" visible fault differs from its bound fault specification`);
        }
        if (receipt.status === "failed_before_commit" && (
          receipt.authoritative_result !== undefined
          || receipt.effect_ids.length > 0
          || receipt.tainted_result_paths.length > 0
        )) {
          throw new ToolWorldDefinitionError(`receipt "${receipt.receipt_id}" exposes authoritative evidence for an uncommitted failure`);
        }
      }
      if (receipt.committed && !committedBySemanticIntent.has(committedKey)) {
        committedBySemanticIntent.set(committedKey, receipt);
      }
    }
  }
  for (const event of state.events) {
    if (event.type !== "tool.result_visible") continue;
    const receipt = state.receipts.find((candidate) => candidate.invocation_id === event.invocation_id);
    if (
      !receipt
      || receipt.tool !== event.tool
      || canonicalJson(receipt.visible_result as unknown as JsonValue)
        !== canonicalJson(event.result as unknown as JsonValue)
      || canonicalJson(receipt.tainted_result_paths.map((taint) => taint.path))
        !== canonicalJson(event.tainted_paths)
    ) {
      throw new ToolWorldDefinitionError(`visible result event "${event.event_id}" is not bound to its authoritative receipt`);
    }
  }
  if (!deepEqual(replayedFacts, state.facts)) {
    throw new ToolWorldDefinitionError("persisted world facts do not match replayed authoritative effects");
  }
  return state;
}

export function createToolWorld(input: unknown): ToolWorldState {
  const scenario = BenchmarkScenarioSchema.parse(input);
  const scenarioHash = scenarioContentHash(scenario);
  const state: ToolWorldState = {
    schema_version: 2,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    scenario_hash: scenarioHash,
    facts: structuredClone(scenario.initial_facts),
    attempts: {},
    admissions: [],
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
    const value = ownRecordValue(args, argument.name);
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
  const resolved = tool.semantic_key.length > 0
    ? tool.semantic_key.map((source) => resolveValue(source, context))
    : [{ present: true as const, value: invocation.arguments }];
  const missingIndex = resolved.findIndex((value) => !value.present);
  if (missingIndex >= 0) {
    throw new ToolWorldDefinitionError(
      `tool "${tool.name}" semantic key component ${missingIndex + 1} resolves to a missing path`
    );
  }
  const values = resolved.map((value) => value.present ? value.value : null);
  return `${tool.name}:${canonicalJson(values)}`;
}

function errorResult(code: string, message: string, retriable = false): VisibleToolResult {
  return { ok: false, error: { code, message, retriable } };
}

function materializeResult(tool: ToolDefinition, context: EvaluationContext): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (const field of tool.result.fields) {
    const value = resolveValue(field.value, context);
    if (!value.present) {
      throw new ToolWorldDefinitionError(`tool "${tool.name}" result path "${field.path}" resolves to undefined`);
    }
    setResultValueAtPath(result, field.path, structuredClone(value.value));
  }
  return JsonValueSchema.parse(result);
}

function committedReceipt(receipt: WorldReceipt): boolean {
  return (receipt.status === "succeeded" && receipt.committed) || receipt.status === "committed_after_error";
}

function describeFaultSchedule(fault: ToolDefinition["faults"][number]) {
  if (fault.attempt !== undefined) {
    return { kind: "fault_match_ordinal" as const, value: fault.attempt };
  }
  if (fault.semantic_opportunity_id !== undefined) {
    return { kind: "semantic_opportunity" as const, value: fault.semantic_opportunity_id };
  }
  throw new ToolWorldDefinitionError(`fault "${fault.id}" has no schedule`);
}

export function executeTool(
  scenarioInput: unknown,
  stateInput: unknown,
  invocationInput: unknown
): ToolExecution {
  const scenario = BenchmarkScenarioSchema.parse(scenarioInput);
  const state = parseBoundToolWorldState(scenario, stateInput);
  const invocation = ToolInvocationSchema.parse(invocationInput);
  if (invocation.turn > scenario.max_turns) {
    throw new ToolWorldDefinitionError(
      `tool invocation turn ${invocation.turn} exceeds scenario max_turns ${scenario.max_turns}`
    );
  }
  const initialEventCount = state.events.length;
  appendEvent(state, scenario, invocation.turn, {
    type: "tool.invocation_received",
    invocation_id: invocation.invocation_id,
    tool: invocation.tool,
    arguments: invocation.arguments,
    ...(invocation.idempotency_key ? { idempotency_key: invocation.idempotency_key } : {}),
    ...(invocation.semantic_opportunity_id ? { semantic_opportunity_id: invocation.semantic_opportunity_id } : {}),
  });

  const exactReceipt = state.receipts.find((receipt) => receipt.invocation_id === invocation.invocation_id);
  if (exactReceipt) {
    const identityChanged = exactReceipt.tool !== invocation.tool
      || !deepEqual(exactReceipt.arguments, invocation.arguments)
      || exactReceipt.idempotency_key !== invocation.idempotency_key
      || exactReceipt.semantic_opportunity_id !== invocation.semantic_opportunity_id;
    if (identityChanged) {
      throw new ToolWorldDefinitionError(
        `invocation id "${invocation.invocation_id}" was reused with different tool, arguments, idempotency, or semantic opportunity identity`
      );
    }
    if (invocation.turn < exactReceipt.turn) {
      throw new ToolWorldDefinitionError(
        `invocation id "${invocation.invocation_id}" replay turn ${invocation.turn} precedes original turn ${exactReceipt.turn}`
      );
    }
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.invocation_replayed",
      invocation_id: invocation.invocation_id,
      tool: invocation.tool,
      original_receipt_id: exactReceipt.receipt_id,
      original_turn: exactReceipt.turn,
      replay_turn: invocation.turn,
    });
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.result_visible",
      invocation_id: invocation.invocation_id,
      tool: invocation.tool,
      result: exactReceipt.visible_result,
      tainted_paths: exactReceipt.tainted_result_paths.map((taint) => taint.path),
    });
    return {
      state: parseBoundToolWorldState(scenario, state),
      disposition: "replayed",
      receipt: exactReceipt,
      visible_result: exactReceipt.visible_result,
      events: state.events.slice(initialEventCount),
    };
  }

  const attempt = (ownRecordValue(state.attempts, invocation.tool) ?? 0) + 1;
  state.attempts[invocation.tool] = attempt;
  const tool = scenario.tools.find((candidate) => candidate.name === invocation.tool);
  const receiptId = `rcpt:${scenario.id}:${invocation.invocation_id}`;
  const requestFields = {
    receipt_id: receiptId,
    invocation_id: invocation.invocation_id,
    tool: invocation.tool,
    arguments: invocation.arguments,
    ...(invocation.idempotency_key ? { idempotency_key: invocation.idempotency_key } : {}),
    ...(invocation.semantic_opportunity_id ? { semantic_opportunity_id: invocation.semantic_opportunity_id } : {}),
    attempt,
    turn: invocation.turn,
  };

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
      state: parseBoundToolWorldState(scenario, state),
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
      ...requestFields,
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
  if (argumentIssues.length > 0) {
    return finish({
      ...requestFields,
      tool: tool.name,
      status: "rejected",
      committed: false,
      semantic_key: `invalid:${tool.name}:${canonicalJson(invocation.arguments)}`,
      prerequisite_evidence: [],
      effect_ids: [],
      visible_result: errorResult("invalid_arguments", argumentIssues.join("; ")),
      tainted_result_paths: [],
    }, "rejected");
  }

  const preliminaryRuntime: Record<string, JsonValue> = {
    request_attempt: attempt,
    turn: invocation.turn,
    invocation_id: invocation.invocation_id,
    ...(invocation.idempotency_key ? { idempotency_key: invocation.idempotency_key } : {}),
    ...(invocation.semantic_opportunity_id ? { semantic_opportunity_id: invocation.semantic_opportunity_id } : {}),
  };
  const preliminaryContext: EvaluationContext = {
    world: state.facts,
    arguments: invocation.arguments,
    runtime: preliminaryRuntime,
  };
  const key = semanticKey(tool, invocation, preliminaryContext);

  // Reconcile a previously committed semantic intent before looking at mutable current prerequisites.
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
        ...requestFields,
        tool: tool.name,
        status: "deduplicated",
        committed: false,
        semantic_key: key,
        duplicate_of_receipt_id: priorReceipt.receipt_id,
        prerequisite_evidence: [],
        effect_ids: [],
        authoritative_result: authoritativeResult,
        visible_result: { ok: true, data: authoritativeResult },
        tainted_result_paths: priorReceipt.tainted_result_paths,
      }, "deduplicated");
    }
    if (tool.duplicate_policy === "reject") {
      return finish({
        ...requestFields,
        tool: tool.name,
        status: "rejected",
        committed: false,
        semantic_key: key,
        duplicate_of_receipt_id: priorReceipt.receipt_id,
        prerequisite_evidence: [],
        effect_ids: [],
        visible_result: errorResult("duplicate_intent", "this semantic mutation was already committed"),
        tainted_result_paths: [],
      }, "rejected");
    }
  }

  const toolOrdinal = state.admissions.filter((admission) => admission.tool === tool.name).length + 1;
  const semanticOrdinal = state.admissions.filter((admission) =>
    admission.tool === tool.name && admission.semantic_key === key
  ).length + 1;
  const runtime: Record<string, JsonValue> = {
    attempt: semanticOrdinal,
    request_attempt: attempt,
    tool_ordinal: toolOrdinal,
    semantic_ordinal: semanticOrdinal,
    turn: invocation.turn,
    invocation_id: invocation.invocation_id,
    ...(invocation.idempotency_key ? { idempotency_key: invocation.idempotency_key } : {}),
    ...(invocation.semantic_opportunity_id ? { semantic_opportunity_id: invocation.semantic_opportunity_id } : {}),
  };
  const context: EvaluationContext = { world: state.facts, arguments: invocation.arguments, runtime };

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
      ...requestFields,
      tool: tool.name,
      status: "rejected",
      committed: false,
      semantic_key: key,
      ...(priorReceipt ? { duplicate_of_receipt_id: priorReceipt.receipt_id } : {}),
      prerequisite_evidence: evidence,
      effect_ids: [],
      visible_result: errorResult(
        "prerequisite_failed",
        `failed prerequisites: ${failedPrerequisites.map((item) => item.prerequisite_id).join(", ")}`
      ),
      tainted_result_paths: [],
    }, "rejected");
  }

  const faultMatchOrdinals = Object.fromEntries(tool.faults
    .filter((candidate) => candidate.when.every((predicate) => evaluatePredicate(predicate, context).passed))
    .map((candidate) => [
      candidate.id,
      state.admissions.filter((prior) =>
        prior.tool === tool.name
        && prior.semantic_key === key
        && ownRecordValue(prior.fault_match_ordinals, candidate.id) !== undefined
      ).length + 1,
    ]));
  const admission: WorldAdmission = {
    admission_id: `adm:${scenario.id}:${invocation.invocation_id}`,
    invocation_id: invocation.invocation_id,
    tool: tool.name,
    semantic_key: key,
    turn: invocation.turn,
    request_attempt: attempt,
    tool_ordinal: toolOrdinal,
    semantic_ordinal: semanticOrdinal,
    ...(invocation.semantic_opportunity_id ? { semantic_opportunity_id: invocation.semantic_opportunity_id } : {}),
    fault_match_ordinals: faultMatchOrdinals,
    event_sequence: state.next_event_sequence,
    world_before_hash: contentHash(state.facts),
    prerequisite_evidence_hash: contentHash(evidence as unknown as JsonValue),
  };
  state.admissions.push(admission);
  appendEvent(state, scenario, invocation.turn, { type: "tool.execution_admitted", admission });

  const scheduledFaults = tool.faults.filter((candidate) =>
    (candidate.attempt !== undefined
      ? candidate.attempt === ownRecordValue(admission.fault_match_ordinals, candidate.id)
      : candidate.semantic_opportunity_id === invocation.semantic_opportunity_id
        && !state.events.some((event) =>
          event.type === "tool.fault_injected"
          && event.tool === tool.name
          && event.fault_id === candidate.id
          && event.semantic_opportunity_id === candidate.semantic_opportunity_id
        ))
    && ownRecordValue(admission.fault_match_ordinals, candidate.id) !== undefined
  );
  if (scheduledFaults.length > 1) {
    throw new ToolWorldDefinitionError(
      `tool "${tool.name}" has multiple faults scheduled for admission "${admission.admission_id}"`
    );
  }
  const fault = scheduledFaults[0];
  if (fault?.phase === "before_commit") {
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.fault_injected",
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      semantic_key: key,
      fault_id: fault.id,
      phase: fault.phase,
      error_code: fault.visible_error.code,
      admission_id: admission.admission_id,
      semantic_ordinal: admission.semantic_ordinal,
      ...(ownRecordValue(admission.fault_match_ordinals, fault.id)
        ? { matching_ordinal: ownRecordValue(admission.fault_match_ordinals, fault.id) }
        : {}),
      ...(admission.semantic_opportunity_id ? { semantic_opportunity_id: admission.semantic_opportunity_id } : {}),
      schedule: describeFaultSchedule(fault),
    });
    return finish({
      ...requestFields,
      tool: tool.name,
      admission_id: admission.admission_id,
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

  const nextFacts = structuredClone(state.facts);
  const effectContext: EvaluationContext = { ...context, world: nextFacts };
  const stagedEffects: Array<Omit<WorldEffect, "event_sequence">> = [];
  for (const [index, effectSpec] of tool.effects.entries()) {
    const before = lookupValueAtPath(nextFacts, effectSpec.path);
    const resolved = resolveValue(effectSpec.value, effectContext);
    if (!resolved.present) {
      throw new ToolWorldDefinitionError(`tool "${tool.name}" effect "${effectSpec.path}" resolves to undefined`);
    }
    let after: JsonValue;
    if (effectSpec.operation === "set") {
      after = structuredClone(resolved.value);
    } else if (effectSpec.operation === "increment") {
      if (!before.present || typeof before.value !== "number" || typeof resolved.value !== "number") {
        throw new ToolWorldDefinitionError(`increment effect "${effectSpec.path}" requires numeric current and delta values`);
      }
      after = before.value + resolved.value;
      if (!Number.isFinite(after)) {
        throw new ToolWorldDefinitionError(`increment effect "${effectSpec.path}" produced a non-finite value`);
      }
    } else {
      if (!before.present || !Array.isArray(before.value)) {
        throw new ToolWorldDefinitionError(`append effect "${effectSpec.path}" requires an existing array`);
      }
      after = [...before.value, structuredClone(resolved.value)];
    }
    setWorldValueAtPath(nextFacts, effectSpec.path, after);
    const priorEffectId = priorReceipt?.effect_ids
      .map((effectId) => state.effects.find((effect) => effect.effect_id === effectId))
      .find((effect) => effect?.path === effectSpec.path && effect.operation === effectSpec.operation)
      ?.effect_id;
    stagedEffects.push({
      effect_id: `${receiptId}:effect:${index + 1}`,
      receipt_id: receiptId,
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      semantic_key: key,
      operation: effectSpec.operation,
      path: effectSpec.path,
      before_present: before.present,
      ...(before.present ? { before: before.value } : {}),
      after,
      ...(priorEffectId ? { duplicate_of_effect_id: priorEffectId } : {}),
    });
  }
  const validatedFacts = z.record(z.string(), JsonValueSchema).parse(nextFacts);
  const authoritativeResult = materializeResult(tool, effectContext);
  state.facts = validatedFacts;
  const effects: WorldEffect[] = [];
  for (const staged of stagedEffects) {
    const effect: WorldEffect = { ...staged, event_sequence: state.next_event_sequence };
    effects.push(effect);
    state.effects.push(effect);
    appendEvent(state, scenario, invocation.turn, { type: "world.effect_committed", effect });
  }

  if (fault?.phase === "after_commit") {
    if (tool.kind !== "mutation") {
      throw new ToolWorldDefinitionError(`query tool "${tool.name}" cannot produce an after-commit fault`);
    }
    appendEvent(state, scenario, invocation.turn, {
      type: "tool.fault_injected",
      invocation_id: invocation.invocation_id,
      tool: tool.name,
      semantic_key: key,
      fault_id: fault.id,
      phase: fault.phase,
      error_code: fault.visible_error.code,
      admission_id: admission.admission_id,
      semantic_ordinal: admission.semantic_ordinal,
      ...(ownRecordValue(admission.fault_match_ordinals, fault.id)
        ? { matching_ordinal: ownRecordValue(admission.fault_match_ordinals, fault.id) }
        : {}),
      ...(admission.semantic_opportunity_id ? { semantic_opportunity_id: admission.semantic_opportunity_id } : {}),
      schedule: describeFaultSchedule(fault),
    });
    return finish({
      ...requestFields,
      tool: tool.name,
      admission_id: admission.admission_id,
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
    ...requestFields,
    tool: tool.name,
    admission_id: admission.admission_id,
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

function admissionRuntime(admission: WorldAdmission, receipt: WorldReceipt): Record<string, JsonValue> {
  return {
    attempt: admission.semantic_ordinal,
    request_attempt: admission.request_attempt,
    tool_ordinal: admission.tool_ordinal,
    semantic_ordinal: admission.semantic_ordinal,
    turn: receipt.turn,
    invocation_id: receipt.invocation_id,
    ...(receipt.idempotency_key ? { idempotency_key: receipt.idempotency_key } : {}),
    ...(receipt.semantic_opportunity_id ? { semantic_opportunity_id: receipt.semantic_opportunity_id } : {}),
  };
}

function replayFactsBeforeAdmission(
  scenario: BenchmarkScenario,
  state: ToolWorldState,
  admission: WorldAdmission
): { facts?: Record<string, JsonValue>; error?: string } {
  const facts = structuredClone(scenario.initial_facts);
  const effects = state.effects
    .filter((effect) => effect.event_sequence < admission.event_sequence)
    .sort((left, right) => left.event_sequence - right.event_sequence);
  const sequences = new Set<number>();
  for (const effect of effects) {
    if (sequences.has(effect.event_sequence)) return { error: `duplicate effect event sequence ${effect.event_sequence}` };
    sequences.add(effect.event_sequence);
    const before = lookupValueAtPath(facts, effect.path);
    if (before.present !== effect.before_present) {
      return { error: `effect ${effect.effect_id} before-presence does not match replayed world` };
    }
    if (before.present && !deepEqual(before.value, effect.before)) {
      return { error: `effect ${effect.effect_id} before-value does not match replayed world` };
    }
    try {
      setWorldValueAtPath(facts, effect.path, structuredClone(effect.after));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { facts };
}

function auditCommittedPrerequisites(
  scenario: BenchmarkScenario,
  state: ToolWorldState,
  assertion: Extract<WorldAssertion, { kind: "all_prerequisites_passed" }>
): { passed: boolean; violations: string[]; committedCount: number } {
  const committed = state.receipts.filter((receipt) =>
    receipt.committed && (assertion.tool === undefined || receipt.tool === assertion.tool)
  );
  const violations: string[] = [];
  if (committed.length < assertion.minimum_committed_receipts) {
    violations.push(`expected at least ${assertion.minimum_committed_receipts} committed receipt(s), found ${committed.length}`);
  }

  for (const receipt of committed) {
    const tool = scenario.tools.find((candidate) => candidate.name === receipt.tool);
    if (!tool) {
      violations.push(`${receipt.receipt_id}: tool is absent from bound scenario`);
      continue;
    }
    if (tool.prerequisites.length === 0) {
      violations.push(`${receipt.receipt_id}: committed tool declares no prerequisites to audit`);
      continue;
    }
    if (!receipt.admission_id) {
      violations.push(`${receipt.receipt_id}: committed receipt has no admission id`);
      continue;
    }
    const matchingAdmissions = state.admissions.filter((candidate) => candidate.admission_id === receipt.admission_id);
    if (matchingAdmissions.length !== 1) {
      violations.push(`${receipt.receipt_id}: expected one matching admission, found ${matchingAdmissions.length}`);
      continue;
    }
    const admission = matchingAdmissions[0];
    if (
      admission.invocation_id !== receipt.invocation_id
      || admission.tool !== receipt.tool
      || admission.semantic_key !== receipt.semantic_key
      || admission.turn !== receipt.turn
      || admission.request_attempt !== receipt.attempt
      || admission.semantic_opportunity_id !== receipt.semantic_opportunity_id
    ) {
      violations.push(`${receipt.receipt_id}: receipt and admission identity differ`);
      continue;
    }
    const admissionEvents = state.events.filter((event) =>
      event.type === "tool.execution_admitted" && event.admission.admission_id === admission.admission_id
    );
    if (
      admissionEvents.length !== 1
      || canonicalJson(admissionEvents[0].type === "tool.execution_admitted"
        ? admissionEvents[0].admission as unknown as JsonValue
        : null)
        !== canonicalJson(admission as unknown as JsonValue)
    ) {
      violations.push(`${receipt.receipt_id}: admission event is missing, duplicated, or inconsistent`);
      continue;
    }

    const replay = replayFactsBeforeAdmission(scenario, state, admission);
    if (!replay.facts) {
      violations.push(`${receipt.receipt_id}: ${replay.error ?? "could not replay world"}`);
      continue;
    }
    if (contentHash(replay.facts) !== admission.world_before_hash) {
      violations.push(`${receipt.receipt_id}: admission world hash does not match replayed authoritative state`);
      continue;
    }
    const computedEvidence = tool.prerequisites.map((predicate) => evaluatePredicate(predicate, {
      world: replay.facts!,
      arguments: receipt.arguments,
      runtime: admissionRuntime(admission, receipt),
    }));
    const declaredIds = tool.prerequisites.map((predicate) => predicate.id);
    const recordedIds = receipt.prerequisite_evidence.map((item) => item.prerequisite_id);
    if (canonicalJson(recordedIds) !== canonicalJson(declaredIds)) {
      violations.push(`${receipt.receipt_id}: recorded prerequisite ids are incomplete, duplicated, or out of order`);
      continue;
    }
    if (canonicalJson(receipt.prerequisite_evidence as unknown as JsonValue)
      !== canonicalJson(computedEvidence as unknown as JsonValue)) {
      violations.push(`${receipt.receipt_id}: recorded prerequisite evidence does not recompute from admission state`);
      continue;
    }
    if (contentHash(computedEvidence as unknown as JsonValue) !== admission.prerequisite_evidence_hash) {
      violations.push(`${receipt.receipt_id}: prerequisite evidence hash mismatch`);
      continue;
    }
    if (!computedEvidence.every((item) => item.passed)) {
      violations.push(`${receipt.receipt_id}: one or more declared prerequisites failed at admission`);
    }
  }

  return { passed: violations.length === 0, violations, committedCount: committed.length };
}

function compareCount(actual: number, operator: "equals" | "less_than_or_equal" | "greater_than_or_equal", expected: number): boolean {
  if (operator === "equals") return actual === expected;
  if (operator === "less_than_or_equal") return actual <= expected;
  return actual >= expected;
}

function evaluateBoundWorldAssertion(
  state: ToolWorldState,
  assertion: WorldAssertion,
  scenario: BenchmarkScenario
): AssertionEvaluation {
  let passed = false;
  let actual: JsonValue = null;
  let expected: JsonValue | undefined;
  if (assertion.kind === "fact") {
    const evidence = evaluatePredicate(assertion.predicate, { world: state.facts, arguments: {}, runtime: {} });
    passed = evidence.passed;
    actual = {
      present: evidence.actual_present,
      ...(evidence.actual_present ? { value: evidence.actual ?? null } : {}),
    };
    expected = evidence.expected_present === undefined
      ? undefined
      : {
        present: evidence.expected_present,
        ...(evidence.expected_present ? { value: evidence.expected ?? null } : {}),
      };
  } else if (assertion.kind === "effect_count") {
    const count = state.effects.filter((effect) =>
      effect.tool === assertion.tool && (assertion.path === undefined || effect.path === assertion.path)
    ).length;
    passed = compareCount(count, assertion.operator, assertion.value);
    actual = count;
    expected = assertion.value;
  } else if (assertion.kind === "receipt_count") {
    const count = state.receipts.filter((receipt) =>
      receipt.tool === assertion.tool && (assertion.status === undefined || receipt.status === assertion.status)
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
    const audit = auditCommittedPrerequisites(scenario, state, assertion);
    passed = audit.passed;
    actual = { committed_receipts: audit.committedCount, violations: audit.violations };
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

export function evaluateWorldAssertion(
  stateInput: unknown,
  assertion: WorldAssertion,
  scenarioInput: unknown
): AssertionEvaluation {
  const scenario = BenchmarkScenarioSchema.parse(scenarioInput);
  const state = parseBoundToolWorldState(scenario, stateInput);
  return evaluateBoundWorldAssertion(state, assertion, scenario);
}

export function evaluateScenarioWorld(scenarioInput: unknown, stateInput: unknown) {
  const scenario = BenchmarkScenarioSchema.parse(scenarioInput);
  const state = parseBoundToolWorldState(scenario, stateInput);
  const success = scenario.success_assertions.map((assertion) => evaluateBoundWorldAssertion(state, assertion, scenario));
  const safety = scenario.safety_invariants.map((assertion) => evaluateBoundWorldAssertion(state, assertion, scenario));
  return {
    success,
    safety,
    task_success: success.every((result) => result.passed) && safety.every((result) => result.passed),
  };
}
