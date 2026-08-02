/** Public, provider-neutral contracts. This module never reads credentials or opens a network connection. */

export const HACC_CORE_CONTRACT_VERSION = "0.1" as const;

export type MaybePromise<T> = T | Promise<T>;

export type Validator<T> = Readonly<{
  parse(value: unknown): T;
}>;

export type ToolEffect = "read" | "write" | "opaque";

export type ToolExecutionContext = Readonly<{
  callId: string;
  stepId: string;
  state: Readonly<Record<string, unknown>>;
  now: () => number;
}>;

export type ToolDefinition<Name extends string = string, Input = unknown, Output = unknown> = Readonly<{
  name: Name;
  description: string;
  input?: Validator<Input>;
  output?: Validator<Output>;
  effect?: ToolEffect;
  execute(input: Input, context: ToolExecutionContext): MaybePromise<Output>;
}>;

export type AnyToolDefinition = ToolDefinition<string, unknown, unknown>;

export type FlowTransition = Readonly<{
  to: string;
  when?: string;
}>;

export type FlowToolPolicy = Readonly<{
  tool: string;
  maxCalls?: number;
}>;

export type FlowStep = Readonly<{
  id: string;
  label: string;
  instructions: string;
  context?: string;
  tools?: readonly string[];
  toolPolicies?: readonly FlowToolPolicy[];
  requiredOutputs?: readonly string[];
  transitions?: readonly FlowTransition[];
  steps?: readonly FlowStep[];
}>;

export type FlowDefinition<Id extends string = string> = Readonly<{
  contractVersion: typeof HACC_CORE_CONTRACT_VERSION;
  id: Id;
  version: string;
  initial: string;
  alwaysTools?: readonly string[];
  steps: readonly FlowStep[];
}>;

export type AgentDefinition<Id extends string = string> = Readonly<{
  contractVersion: typeof HACC_CORE_CONTRACT_VERSION;
  id: Id;
  name: string;
  instructions: string;
  flow: FlowDefinition;
  tools: readonly AnyToolDefinition[];
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ScenarioEvent =
  | Readonly<{ type: "user"; text: string }>
  | Readonly<{ type: "tool"; name: string; input: unknown; saveAs?: string }>
  | Readonly<{ type: "complete"; outputs?: Readonly<Record<string, unknown>>; to?: string }>
  | Readonly<{ type: "expect"; step?: string; availableTools?: readonly string[]; state?: Readonly<Record<string, unknown>> }>;

export type ScenarioDefinition<Id extends string = string> = Readonly<{
  contractVersion: typeof HACC_CORE_CONTRACT_VERSION;
  id: Id;
  description: string;
  events: readonly ScenarioEvent[];
}>;

export type RuntimeTranscriptEvent = Readonly<{
  sequence: number;
  atMs: number;
  type: "started" | "user" | "tool_succeeded" | "step_completed" | "assertion_passed";
  stepId: string | null;
  data: Readonly<Record<string, unknown>>;
}>;

export type ToolReceipt = Readonly<{
  callId: string;
  tool: string;
  stepId: string;
  effect: ToolEffect;
  input: unknown;
  output: unknown;
  completedAtMs: number;
}>;

export type TestRuntimeSnapshot = Readonly<{
  agentId: string;
  currentStepId: string | null;
  availableTools: readonly string[];
  state: Readonly<Record<string, unknown>>;
  receipts: readonly ToolReceipt[];
  transcript: readonly RuntimeTranscriptEvent[];
}>;

export type TestRuntime = Readonly<{
  getSnapshot(): TestRuntimeSnapshot;
  invokeTool(name: string, input: unknown): Promise<ToolReceipt>;
  completeStep(outputs?: Readonly<Record<string, unknown>>, to?: string): TestRuntimeSnapshot;
  runScenario(scenario: ScenarioDefinition): Promise<TestRuntimeSnapshot>;
}>;

export class HaccDefinitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HaccDefinitionError";
  }
}

export class HaccRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HaccRuntimeError";
  }
}

const ID = /^[a-z][a-z0-9_.-]{0,63}$/;

function requireId(value: string, label: string): void {
  if (!ID.test(value)) {
    throw new HaccDefinitionError("invalid_id", `${label} must match ${ID}`);
  }
}

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new HaccDefinitionError("invalid_text", `${label} must be non-empty text`);
  }
}

function unique(values: readonly string[], label: string): readonly string[] {
  const copy = [...values];
  if (new Set(copy).size !== copy.length) {
    throw new HaccDefinitionError("duplicate_value", `${label} must not contain duplicates`);
  }
  return Object.freeze(copy);
}

function snapshotSteps(steps: readonly FlowStep[]): readonly FlowStep[] {
  return Object.freeze(steps.map((step) => Object.freeze({
    ...step,
    ...(step.tools ? { tools: Object.freeze([...step.tools]) } : {}),
    ...(step.toolPolicies ? { toolPolicies: Object.freeze(step.toolPolicies.map((policy) => Object.freeze({ ...policy }))) } : {}),
    ...(step.requiredOutputs ? { requiredOutputs: Object.freeze([...step.requiredOutputs]) } : {}),
    ...(step.transitions ? { transitions: Object.freeze(step.transitions.map((transition) => Object.freeze({ ...transition }))) } : {}),
    ...(step.steps ? { steps: snapshotSteps(step.steps) } : {}),
  })));
}

/** Defines a tool without registration, environment reads, discovery, or side effects. */
export function defineTool<const Name extends string, Input = unknown, Output = unknown>(
  definition: ToolDefinition<Name, Input, Output>,
): ToolDefinition<Name, Input, Output> {
  requireId(definition.name, "tool name");
  requireText(definition.description, `tool ${definition.name} description`);
  if (typeof definition.execute !== "function") {
    throw new HaccDefinitionError("invalid_tool", `tool ${definition.name} requires execute`);
  }
  return Object.freeze({ ...definition });
}

type IndexedStep = Readonly<{ step: FlowStep; ancestors: readonly FlowStep[] }>;

function indexSteps(steps: readonly FlowStep[]): ReadonlyMap<string, IndexedStep> {
  const index = new Map<string, IndexedStep>();
  const visit = (items: readonly FlowStep[], ancestors: readonly FlowStep[]): void => {
    for (const original of items) {
      requireId(original.id, "flow step id");
      requireText(original.label, `flow step ${original.id} label`);
      requireText(original.instructions, `flow step ${original.id} instructions`);
      if (index.has(original.id)) {
        throw new HaccDefinitionError("duplicate_step", `duplicate flow step ${original.id}`);
      }
      const step: FlowStep = Object.freeze({
        ...original,
        ...(original.tools ? { tools: unique(original.tools, `step ${original.id} tools`) } : {}),
        ...(original.requiredOutputs ? { requiredOutputs: unique(original.requiredOutputs, `step ${original.id} required outputs`) } : {}),
        ...(original.toolPolicies ? { toolPolicies: Object.freeze(original.toolPolicies.map((policy) => Object.freeze({ ...policy }))) } : {}),
        ...(original.transitions ? { transitions: Object.freeze(original.transitions.map((transition) => Object.freeze({ ...transition }))) } : {}),
        ...(original.steps ? { steps: Object.freeze([...original.steps]) } : {}),
      });
      index.set(step.id, Object.freeze({ step, ancestors: Object.freeze([...ancestors]) }));
      if (step.steps) visit(step.steps, [...ancestors, step]);
    }
  };
  visit(steps, []);
  return index;
}

/** Defines and validates a bounded progressive-capability flow. */
export function defineFlow<const Id extends string>(
  definition: Omit<FlowDefinition<Id>, "contractVersion"> & { contractVersion?: typeof HACC_CORE_CONTRACT_VERSION },
): FlowDefinition<Id> {
  if (definition.contractVersion !== undefined && definition.contractVersion !== HACC_CORE_CONTRACT_VERSION) {
    throw new HaccDefinitionError("unsupported_contract", `core contract ${String(definition.contractVersion)} is unsupported`);
  }
  requireId(definition.id, "flow id");
  requireText(definition.version, `flow ${definition.id} version`);
  const steps = snapshotSteps(definition.steps);
  const index = indexSteps(steps);
  if (!index.has(definition.initial)) {
    throw new HaccDefinitionError("unknown_initial_step", `flow initial step ${definition.initial} does not exist`);
  }
  const alwaysTools = unique(definition.alwaysTools ?? [], `flow ${definition.id} always tools`);
  for (const { step } of index.values()) {
    for (const transition of step.transitions ?? []) {
      if (!index.has(transition.to)) {
        throw new HaccDefinitionError("unknown_transition", `step ${step.id} transitions to unknown step ${transition.to}`);
      }
    }
    for (const policy of step.toolPolicies ?? []) {
      requireId(policy.tool, `step ${step.id} policy tool`);
      if (policy.maxCalls !== undefined && (!Number.isInteger(policy.maxCalls) || policy.maxCalls < 1)) {
        throw new HaccDefinitionError("invalid_policy", `step ${step.id} tool ${policy.tool} maxCalls must be a positive integer`);
      }
    }
  }
  return Object.freeze({
    contractVersion: HACC_CORE_CONTRACT_VERSION,
    id: definition.id,
    version: definition.version,
    initial: definition.initial,
    alwaysTools,
    steps,
  });
}

/** Defines an agent and checks that every capability named by its flow exists. */
export function defineAgent<const Id extends string>(
  definition: Omit<AgentDefinition<Id>, "contractVersion"> & { contractVersion?: typeof HACC_CORE_CONTRACT_VERSION },
): AgentDefinition<Id> {
  if (definition.contractVersion !== undefined && definition.contractVersion !== HACC_CORE_CONTRACT_VERSION) {
    throw new HaccDefinitionError("unsupported_contract", `core contract ${String(definition.contractVersion)} is unsupported`);
  }
  requireId(definition.id, "agent id");
  requireText(definition.name, `agent ${definition.id} name`);
  requireText(definition.instructions, `agent ${definition.id} instructions`);
  const names = definition.tools.map((tool) => tool.name);
  unique(names, `agent ${definition.id} tools`);
  const known = new Set(names);
  const index = indexSteps(definition.flow.steps);
  const referenced = [
    ...(definition.flow.alwaysTools ?? []),
    ...[...index.values()].flatMap(({ step }) => [
      ...(step.tools ?? []),
      ...(step.toolPolicies ?? []).map((policy) => policy.tool),
    ]),
  ];
  for (const name of referenced) {
    if (!known.has(name)) {
      throw new HaccDefinitionError("unknown_tool", `flow references undefined tool ${name}`);
    }
  }
  return Object.freeze({
    contractVersion: HACC_CORE_CONTRACT_VERSION,
    id: definition.id,
    name: definition.name,
    instructions: definition.instructions,
    flow: definition.flow,
    tools: Object.freeze([...definition.tools]),
    ...(definition.metadata ? { metadata: Object.freeze({ ...definition.metadata }) } : {}),
  });
}

export function defineScenario<const Id extends string>(
  definition: Omit<ScenarioDefinition<Id>, "contractVersion"> & { contractVersion?: typeof HACC_CORE_CONTRACT_VERSION },
): ScenarioDefinition<Id> {
  if (definition.contractVersion !== undefined && definition.contractVersion !== HACC_CORE_CONTRACT_VERSION) {
    throw new HaccDefinitionError("unsupported_contract", `core contract ${String(definition.contractVersion)} is unsupported`);
  }
  requireId(definition.id, "scenario id");
  requireText(definition.description, `scenario ${definition.id} description`);
  return Object.freeze({
    contractVersion: HACC_CORE_CONTRACT_VERSION,
    id: definition.id,
    description: definition.description,
    events: Object.freeze(definition.events.map((event) => Object.freeze({ ...event }))),
  });
}

function valueAtPath(state: Readonly<Record<string, unknown>>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, state);
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Creates a deterministic, offline runtime. Tool execution occurs only when the caller invokes it. */
export function createTestRuntime(input: Readonly<{
  agent: AgentDefinition;
  initialState?: Readonly<Record<string, unknown>>;
  now?: () => number;
}>): TestRuntime {
  const { agent } = input;
  const now = input.now ?? (() => Date.now());
  const stepIndex = indexSteps(agent.flow.steps);
  const tools = new Map(agent.tools.map((tool) => [tool.name, tool]));
  let currentStepId: string | null = agent.flow.initial;
  let state: Record<string, unknown> = { ...(input.initialState ?? {}) };
  const receipts: ToolReceipt[] = [];
  const transcript: RuntimeTranscriptEvent[] = [];
  const calls = new Map<string, number>();
  let sequence = 0;

  const append = (type: RuntimeTranscriptEvent["type"], data: Readonly<Record<string, unknown>>): void => {
    transcript.push(Object.freeze({ sequence: ++sequence, atMs: now(), type, stepId: currentStepId, data: Object.freeze({ ...data }) }));
  };

  const active = (): IndexedStep => {
    if (!currentStepId) throw new HaccRuntimeError("flow_complete", "the flow is already complete");
    const found = stepIndex.get(currentStepId);
    if (!found) throw new HaccRuntimeError("invalid_state", `active step ${currentStepId} is missing`);
    return found;
  };

  const available = (): readonly string[] => {
    if (!currentStepId) return Object.freeze([...(agent.flow.alwaysTools ?? [])].sort());
    const { step, ancestors } = active();
    return Object.freeze([...new Set([
      ...(agent.flow.alwaysTools ?? []),
      ...ancestors.flatMap((ancestor) => ancestor.tools ?? []),
      ...(step.tools ?? []),
    ])].sort());
  };

  const snapshot = (): TestRuntimeSnapshot => Object.freeze({
    agentId: agent.id,
    currentStepId,
    availableTools: available(),
    state: Object.freeze({ ...state }),
    receipts: Object.freeze([...receipts]),
    transcript: Object.freeze([...transcript]),
  });

  const invokeTool = async (name: string, rawInput: unknown): Promise<ToolReceipt> => {
    const { step } = active();
    if (!available().includes(name)) {
      throw new HaccRuntimeError("tool_not_active", `tool ${name} is not active in step ${step.id}`);
    }
    const tool = tools.get(name);
    if (!tool) throw new HaccRuntimeError("unknown_tool", `tool ${name} is undefined`);
    const policy = [...(step.toolPolicies ?? []), ...active().ancestors.flatMap((item) => item.toolPolicies ?? [])]
      .find((candidate) => candidate.tool === name);
    const callKey = `${step.id}:${name}`;
    const count = calls.get(callKey) ?? 0;
    if (policy?.maxCalls !== undefined && count >= policy.maxCalls) {
      throw new HaccRuntimeError("tool_call_limit", `tool ${name} exceeded maxCalls in step ${step.id}`);
    }
    const parsedInput = tool.input ? tool.input.parse(rawInput) : rawInput;
    const callId = `test-${sequence + 1}-${name}`;
    const rawOutput = await tool.execute(parsedInput, Object.freeze({
      callId,
      stepId: step.id,
      state: Object.freeze({ ...state }),
      now,
    }));
    const output = tool.output ? tool.output.parse(rawOutput) : rawOutput;
    calls.set(callKey, count + 1);
    const receipt = Object.freeze({
      callId,
      tool: name,
      stepId: step.id,
      effect: tool.effect ?? "opaque",
      input: parsedInput,
      output,
      completedAtMs: now(),
    });
    receipts.push(receipt);
    append("tool_succeeded", { callId, tool: name });
    return receipt;
  };

  const completeStep = (outputs: Readonly<Record<string, unknown>> = {}, to?: string): TestRuntimeSnapshot => {
    const { step } = active();
    const nextState = { ...state, ...outputs };
    const missing = (step.requiredOutputs ?? []).filter((key) => valueAtPath(nextState, key) === undefined);
    if (missing.length) {
      throw new HaccRuntimeError("missing_required_output", `step ${step.id} is missing: ${missing.join(", ")}`);
    }
    let next = to;
    if (next !== undefined && !(step.transitions ?? []).some((transition) => transition.to === next)) {
      throw new HaccRuntimeError("invalid_transition", `step ${step.id} cannot transition to ${next}`);
    }
    next ??= step.transitions?.[0]?.to;
    state = nextState;
    currentStepId = next ?? null;
    append("step_completed", { completedStepId: step.id, nextStepId: currentStepId });
    return snapshot();
  };

  const runScenario = async (scenario: ScenarioDefinition): Promise<TestRuntimeSnapshot> => {
    for (const event of scenario.events) {
      if (event.type === "user") {
        append("user", { text: event.text });
      } else if (event.type === "tool") {
        const receipt = await invokeTool(event.name, event.input);
        if (event.saveAs) state = { ...state, [event.saveAs]: receipt.output };
      } else if (event.type === "complete") {
        completeStep(event.outputs ?? {}, event.to);
      } else {
        const current = snapshot();
        if (event.step !== undefined && current.currentStepId !== event.step) {
          throw new HaccRuntimeError("scenario_assertion", `expected step ${event.step}, received ${String(current.currentStepId)}`);
        }
        if (event.availableTools !== undefined && !equalValue([...current.availableTools].sort(), [...event.availableTools].sort())) {
          throw new HaccRuntimeError("scenario_assertion", `available tools did not match at step ${String(current.currentStepId)}`);
        }
        for (const [path, expected] of Object.entries(event.state ?? {})) {
          if (!equalValue(valueAtPath(current.state, path), expected)) {
            throw new HaccRuntimeError("scenario_assertion", `state ${path} did not match`);
          }
        }
        append("assertion_passed", {});
      }
    }
    return snapshot();
  };

  append("started", { flowId: agent.flow.id });
  return Object.freeze({ getSnapshot: snapshot, invokeTool, completeStep, runScenario });
}
