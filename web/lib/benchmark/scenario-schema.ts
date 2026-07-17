import { z } from "zod";

/** JSON-only values keep scenarios, traces, and receipts portable across runtimes. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

const IDENTIFIER = /^[a-z][a-z0-9_.-]{1,95}$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9]\d*))*$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export const IdentifierSchema = z.string().regex(IDENTIFIER);
export const ContentHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ArgumentNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/).refine(
  (name) => !FORBIDDEN_PATH_SEGMENTS.has(name),
  "argument name is reserved"
);

export const SafePathSchema = z.string().regex(PATH).refine(
  (path) => path.split(".").every((segment) => !FORBIDDEN_PATH_SEGMENTS.has(segment)),
  "path contains a forbidden segment"
);

function jsonPathExists(root: JsonValue, path: string): boolean {
  let current: JsonValue = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = /^(?:0|[1-9]\d*)$/.test(segment) ? Number(segment) : -1;
      if (index < 0 || index >= current.length || !Object.hasOwn(current, index)) return false;
      current = current[index];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return false;
    }
  }
  return true;
}

function canonicalJsonValue(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`
  ).join(",")}}`;
}

function argumentValueType(value: JsonValue): "string" | "number" | "boolean" | "object" | "array" | "null" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as "string" | "number" | "boolean" | "object";
}

export const ValueSourceSchema = z.union([
  z.object({ literal: JsonValueSchema }).strict(),
  z.object({
    source: z.enum(["world", "arguments", "runtime"]),
    path: SafePathSchema,
  }).strict(),
]);

export type ValueSource = z.infer<typeof ValueSourceSchema>;

export const PredicateSchema = z.object({
  id: IdentifierSchema,
  description: z.string().min(1),
  left: ValueSourceSchema,
  operator: z.enum([
    "equals",
    "not_equals",
    "exists",
    "not_exists",
    "in",
    "greater_than_or_equal",
    "less_than_or_equal",
    "contains",
  ]),
  right: ValueSourceSchema.optional(),
}).strict().superRefine((predicate, ctx) => {
  if (!["exists", "not_exists"].includes(predicate.operator) && !predicate.right) {
    ctx.addIssue({ code: "custom", path: ["right"], message: `${predicate.operator} requires a right operand` });
  }
  if (["exists", "not_exists"].includes(predicate.operator) && predicate.right) {
    ctx.addIssue({ code: "custom", path: ["right"], message: `${predicate.operator} does not accept a right operand` });
  }
});

export type Predicate = z.infer<typeof PredicateSchema>;

export const ToolArgumentSchema = z.object({
  name: ArgumentNameSchema,
  description: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  required: z.boolean().default(false),
  enum: z.array(JsonValueSchema).min(1).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  pattern: z.string().optional(),
}).strict().superRefine((argument, ctx) => {
  if (argument.enum) {
    const seen = new Set<string>();
    for (const [index, value] of argument.enum.entries()) {
      if (argumentValueType(value) !== argument.type) {
        ctx.addIssue({
          code: "custom",
          path: ["enum", index],
          message: `enum value must match argument type ${argument.type}`,
        });
      }
      const key = canonicalJsonValue(value);
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["enum", index], message: "enum values must be unique" });
      }
      seen.add(key);
    }
  }
  if ((argument.minimum !== undefined || argument.maximum !== undefined) && argument.type !== "number") {
    ctx.addIssue({ code: "custom", message: "minimum and maximum are valid only for number arguments" });
  }
  if (argument.minimum !== undefined && argument.maximum !== undefined && argument.minimum > argument.maximum) {
    ctx.addIssue({ code: "custom", path: ["minimum"], message: "minimum must not exceed maximum" });
  }
  if (argument.pattern !== undefined && argument.type !== "string") {
    ctx.addIssue({ code: "custom", path: ["pattern"], message: "pattern is valid only for string arguments" });
  }
  if (argument.pattern !== undefined) {
    try {
      new RegExp(argument.pattern);
    } catch {
      ctx.addIssue({ code: "custom", path: ["pattern"], message: "pattern must be a valid regular expression" });
    }
  }
});

export const WorldEffectSpecSchema = z.object({
  operation: z.enum(["set", "increment", "append"]),
  path: SafePathSchema,
  value: ValueSourceSchema,
  description: z.string().min(1),
}).strict();

export const ToolResultSpecSchema = z.object({
  fields: z.array(z.object({
    path: SafePathSchema,
    value: ValueSourceSchema,
  }).strict()).default([]),
  /** Paths are data from an untrusted external source, never instructions to the agent. */
  tainted_paths: z.array(z.object({
    path: SafePathSchema,
    kind: z.enum(["prompt_injection", "untrusted_external_text", "counterfeit_receipt"]),
    source: z.string().min(1),
    expected_handling: z.string().min(1),
  }).strict()).default([]),
}).strict().superRefine((result, ctx) => {
  const fields = new Set<string>();
  for (const [index, field] of result.fields.entries()) {
    if (fields.has(field.path)) {
      ctx.addIssue({ code: "custom", path: ["fields", index, "path"], message: `duplicate result path "${field.path}"` });
    }
    const overlap = [...fields].find((path) => path.startsWith(`${field.path}.`) || field.path.startsWith(`${path}.`));
    if (overlap) {
      ctx.addIssue({
        code: "custom",
        path: ["fields", index, "path"],
        message: `result path "${field.path}" overlaps ancestor or descendant "${overlap}"`,
      });
    }
    fields.add(field.path);
  }
  for (const [index, taint] of result.tainted_paths.entries()) {
    const represented = [...fields].some((path) => path === taint.path || path.startsWith(`${taint.path}.`) || taint.path.startsWith(`${path}.`));
    if (!represented) {
      ctx.addIssue({ code: "custom", path: ["tainted_paths", index, "path"], message: `tainted path "${taint.path}" has no result field` });
    }
  }
});

export const VisibleToolErrorSchema = z.object({
  code: IdentifierSchema,
  message: z.string().min(1),
  retriable: z.boolean(),
}).strict();

export const FaultSpecSchema = z.object({
  id: IdentifierSchema,
  /** One-based ordinal among admitted same-intent executions whose `when` predicates match. */
  attempt: z.number().int().positive().optional(),
  /** Optional frozen schedule key supplied by the condition-blind caller/runner. */
  semantic_opportunity_id: IdentifierSchema.optional(),
  phase: z.enum(["before_commit", "after_commit"]),
  when: z.array(PredicateSchema).default([]),
  visible_error: VisibleToolErrorSchema,
}).strict().superRefine((fault, ctx) => {
  if (fault.attempt === undefined && fault.semantic_opportunity_id === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "fault requires an admitted semantic attempt ordinal or semantic_opportunity_id",
    });
  }
  if (fault.attempt !== undefined && fault.semantic_opportunity_id !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "fault schedule must choose either admitted semantic ordinal or semantic_opportunity_id, not both",
    });
  }
});

export const ToolDefinitionSchema = z.object({
  name: IdentifierSchema,
  description: z.string().min(1),
  kind: z.enum(["query", "mutation"]),
  arguments: z.array(ToolArgumentSchema).default([]),
  additional_arguments: z.boolean().default(false),
  prerequisites: z.array(PredicateSchema).default([]),
  /** Ordered values form a stable semantic intent key for duplicate detection. */
  semantic_key: z.array(ValueSourceSchema).default([]),
  duplicate_policy: z.enum(["execute", "return_prior", "reject"]).default("execute"),
  effects: z.array(WorldEffectSpecSchema).default([]),
  result: ToolResultSpecSchema,
  faults: z.array(FaultSpecSchema).default([]),
}).strict().superRefine((tool, ctx) => {
  const argumentNames = new Set<string>();
  for (const [index, argument] of tool.arguments.entries()) {
    if (argumentNames.has(argument.name)) {
      ctx.addIssue({ code: "custom", path: ["arguments", index, "name"], message: `duplicate argument "${argument.name}"` });
    }
    argumentNames.add(argument.name);
  }
  const prerequisiteIds = new Set<string>();
  for (const [index, prerequisite] of tool.prerequisites.entries()) {
    if (prerequisiteIds.has(prerequisite.id)) {
      ctx.addIssue({ code: "custom", path: ["prerequisites", index, "id"], message: `duplicate prerequisite "${prerequisite.id}"` });
    }
    prerequisiteIds.add(prerequisite.id);
  }
  const faultIds = new Set<string>();
  const faultSchedules = new Set<string>();
  const faultScheduleModes = new Set<"attempt" | "semantic_opportunity">();
  for (const [index, fault] of tool.faults.entries()) {
    if (faultIds.has(fault.id)) {
      ctx.addIssue({ code: "custom", path: ["faults", index, "id"], message: `duplicate fault "${fault.id}"` });
    }
    faultIds.add(fault.id);
    const schedule = fault.attempt !== undefined
      ? `fault_match_ordinal:${fault.attempt}`
      : `semantic_opportunity:${fault.semantic_opportunity_id}`;
    faultScheduleModes.add(fault.attempt !== undefined ? "attempt" : "semantic_opportunity");
    if (faultSchedules.has(schedule)) {
      ctx.addIssue({
        code: "custom",
        path: ["faults", index],
        message: `duplicate fault schedule "${schedule}" makes declaration order affect behavior`,
      });
    }
    faultSchedules.add(schedule);
  }
  if (faultScheduleModes.size > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["faults"],
      message: "one tool cannot mix attempt and semantic-opportunity fault schedules because both may select one admission",
    });
  }
  if (tool.faults.length > 1 && faultScheduleModes.has("attempt")) {
    const firstWhen = canonicalJsonValue(tool.faults[0].when as unknown as JsonValue);
    if (tool.faults.some((fault) => canonicalJsonValue(fault.when as unknown as JsonValue) !== firstWhen)) {
      ctx.addIssue({
        code: "custom",
        path: ["faults"],
        message: "multiple attempt faults require identical match predicates so their ordinals cannot co-select",
      });
    }
  }
  const effectPaths = new Set<string>();
  for (const [index, effect] of tool.effects.entries()) {
    const overlap = [...effectPaths].find((path) => path === effect.path || path.startsWith(`${effect.path}.`) || effect.path.startsWith(`${path}.`));
    if (overlap) {
      ctx.addIssue({
        code: "custom",
        path: ["effects", index, "path"],
        message: `effect path "${effect.path}" overlaps "${overlap}" within one atomic tool execution`,
      });
    }
    effectPaths.add(effect.path);
  }
  if (tool.kind === "mutation" && tool.semantic_key.length === 0) {
    ctx.addIssue({ code: "custom", path: ["semantic_key"], message: "mutation tools require a semantic key" });
  }
  if (tool.semantic_key.some((source) => "source" in source && source.source === "runtime")) {
    ctx.addIssue({
      code: "custom",
      path: ["semantic_key"],
      message: "semantic keys cannot depend on runtime attempt/turn metadata",
    });
  }
  if (tool.kind === "mutation" && tool.effects.length === 0) {
    ctx.addIssue({ code: "custom", path: ["effects"], message: "mutation tools require at least one authoritative effect" });
  }
  if (tool.kind === "query" && tool.effects.length > 0) {
    ctx.addIssue({ code: "custom", path: ["effects"], message: "query tools cannot declare effects" });
  }
  if (tool.kind === "query") {
    if (tool.duplicate_policy !== "execute") {
      ctx.addIssue({
        code: "custom",
        path: ["duplicate_policy"],
        message: "query tools always execute and cannot advertise mutation reconciliation policies",
      });
    }
    for (const [index, fault] of tool.faults.entries()) {
      if (fault.phase === "after_commit") {
        ctx.addIssue({
          code: "custom",
          path: ["faults", index, "phase"],
          message: "query tools cannot fail after commit because they have no authoritative commit",
        });
      }
    }
  }

  const runtimePaths = new Set([
    "attempt",
    "request_attempt",
    "tool_ordinal",
    "semantic_ordinal",
    "turn",
    "invocation_id",
    "idempotency_key",
    "semantic_opportunity_id",
  ]);
  const referencedSources: Array<readonly [ValueSource, readonly (string | number)[]]> = [];
  const addPredicateSources = (predicate: Predicate, path: readonly (string | number)[]) => {
    referencedSources.push([predicate.left, [...path, "left"]]);
    if (predicate.right) referencedSources.push([predicate.right, [...path, "right"]]);
  };
  tool.semantic_key.forEach((source, index) => referencedSources.push([source, ["semantic_key", index]]));
  tool.prerequisites.forEach((predicate, index) => addPredicateSources(predicate, ["prerequisites", index]));
  tool.faults.forEach((fault, faultIndex) => fault.when.forEach((predicate, predicateIndex) =>
    addPredicateSources(predicate, ["faults", faultIndex, "when", predicateIndex])
  ));
  tool.effects.forEach((effect, index) => referencedSources.push([effect.value, ["effects", index, "value"]]));
  tool.result.fields.forEach((field, index) => referencedSources.push([field.value, ["result", "fields", index, "value"]]));
  for (const [source, path] of referencedSources) {
    if (!("source" in source)) continue;
    if (source.source === "arguments") {
      const [argumentName, ...nested] = source.path.split(".");
      const argument = tool.arguments.find((candidate) => candidate.name === argumentName);
      if (!argument) {
        ctx.addIssue({ code: "custom", path: [...path, "path"], message: `argument source references undeclared argument "${argumentName}"` });
      } else if (nested.length > 0 && !["object", "array"].includes(argument.type)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "path"],
          message: `argument source cannot traverse scalar argument "${argumentName}"`,
        });
      }
    }
    if (source.source === "runtime" && !runtimePaths.has(source.path)) {
      ctx.addIssue({ code: "custom", path: [...path, "path"], message: `runtime source references unsupported path "${source.path}"` });
    }
  }
});

export const CallerTurnSchema = z.object({
  id: IdentifierSchema,
  phase: IdentifierSchema,
  utterance: z.string().min(1),
  tags: z.array(z.enum([
    "task",
    "verification",
    "correction",
    "digression",
    "recall_probe",
    "adversarial_pressure",
    "injection_probe",
    "failure_recovery",
    "reconnect",
    "confirmation",
  ])).default([]),
  fact_updates: z.array(z.object({
    fact: IdentifierSchema,
    value: JsonValueSchema,
    supersedes: JsonValueSchema.optional(),
  }).strict()).default([]),
  expected_behavior: z.array(z.string().min(1)).default([]),
}).strict();

const WorldAssertionPredicateSchema = PredicateSchema.superRefine((predicate, ctx) => {
  if (!("source" in predicate.left) || predicate.left.source !== "world") {
    ctx.addIssue({
      code: "custom",
      path: ["left"],
      message: "world fact assertions require an authoritative world path on the left",
    });
  }
  if (predicate.right && "source" in predicate.right && predicate.right.source !== "world") {
    ctx.addIssue({
      code: "custom",
      path: ["right"],
      message: "world fact assertion right operands may reference only world state or a literal",
    });
  }
});

export const WorldReceiptStatusSchema = z.enum([
  "succeeded",
  "rejected",
  "failed_before_commit",
  "committed_after_error",
  "deduplicated",
]);

export const WorldAssertionSchema = z.discriminatedUnion("kind", [
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("fact"),
    predicate: WorldAssertionPredicateSchema,
  }).strict(),
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("effect_count"),
    tool: IdentifierSchema,
    path: SafePathSchema.optional(),
    operator: z.enum(["equals", "less_than_or_equal", "greater_than_or_equal"]),
    value: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("receipt_count"),
    tool: IdentifierSchema,
    status: WorldReceiptStatusSchema.optional(),
    operator: z.enum(["equals", "less_than_or_equal", "greater_than_or_equal"]),
    value: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("effect_order"),
    before_tool: IdentifierSchema,
    after_tool: IdentifierSchema,
  }).strict(),
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("no_duplicate_effect"),
    tool: IdentifierSchema.optional(),
  }).strict(),
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("all_prerequisites_passed"),
    tool: IdentifierSchema.optional(),
    /** Prevents a safety assertion from passing only because nothing committed. */
    minimum_committed_receipts: z.number().int().positive().default(1),
  }).strict(),
]);

/**
 * Provider-run eligibility is part of the canonical scenario rather than
 * registry side metadata. As a result, changing a study role, eligibility
 * decision, or structural-realism result changes the scenario content hash.
 * Cross-scenario recomputation (for example, overlap with a development
 * fixture) remains the responsibility of the suite-specific auditor.
 */
export const BenchmarkExecutionPolicySchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("long_horizon"),
  study_role: z.enum(["development", "confirmatory-held-out"]),
  execution_eligibility: z.enum([
    "development-provider-eligible",
    "confirmatory-provider-eligible",
    "offline-stress-only",
  ]),
  provider_blockers: z.array(z.string().min(1)).min(1).optional(),
  declared_turn_count: z.number().int().positive(),
  structural_realism: z.object({
    comparator_scenario_id: IdentifierSchema,
    comparator_scenario_version: z.string().min(1),
    unique_utterances: z.number().int().positive(),
    unique_utterance_ratio: z.number().finite().min(0).max(1),
    development_overlap_turns: z.number().int().nonnegative(),
    development_overlap_ratio: z.number().finite().min(0).max(1),
    minimum_unique_utterance_ratio: z.number().finite().min(0).max(1),
    maximum_development_overlap_ratio: z.number().finite().min(0).max(1),
    confirmatory_eligible: z.boolean(),
    failures: z.array(z.string().min(1)),
  }).strict(),
}).strict().superRefine((policy, ctx) => {
  const realism = policy.structural_realism;
  if (policy.provider_blockers && new Set(policy.provider_blockers).size !== policy.provider_blockers.length) {
    ctx.addIssue({
      code: "custom",
      path: ["provider_blockers"],
      message: "provider blockers must be unique",
    });
  }
  if (realism.unique_utterances > policy.declared_turn_count) {
    ctx.addIssue({
      code: "custom",
      path: ["structural_realism", "unique_utterances"],
      message: "unique_utterances cannot exceed declared_turn_count",
    });
  }
  if (realism.development_overlap_turns > policy.declared_turn_count) {
    ctx.addIssue({
      code: "custom",
      path: ["structural_realism", "development_overlap_turns"],
      message: "development_overlap_turns cannot exceed declared_turn_count",
    });
  }
  const expectedUniqueRatio = realism.unique_utterances / policy.declared_turn_count;
  if (realism.unique_utterance_ratio !== expectedUniqueRatio) {
    ctx.addIssue({
      code: "custom",
      path: ["structural_realism", "unique_utterance_ratio"],
      message: "unique_utterance_ratio must equal unique_utterances / declared_turn_count",
    });
  }
  const expectedOverlapRatio = realism.development_overlap_turns / policy.declared_turn_count;
  if (realism.development_overlap_ratio !== expectedOverlapRatio) {
    ctx.addIssue({
      code: "custom",
      path: ["structural_realism", "development_overlap_ratio"],
      message: "development_overlap_ratio must equal development_overlap_turns / declared_turn_count",
    });
  }
  if (realism.confirmatory_eligible !== (realism.failures.length === 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["structural_realism", "confirmatory_eligible"],
      message: "confirmatory_eligible must be true exactly when failures is empty",
    });
  }
  if (policy.study_role === "development") {
    const expectedEligibility = policy.provider_blockers?.length
      ? "offline-stress-only"
      : "development-provider-eligible";
    if (policy.execution_eligibility !== expectedEligibility) {
      ctx.addIssue({
        code: "custom",
        path: ["execution_eligibility"],
        message: `development eligibility must be ${expectedEligibility} for the declared provider blockers`,
      });
    }
  }
  if (policy.study_role === "confirmatory-held-out") {
    const expectedEligibility = realism.confirmatory_eligible && !policy.provider_blockers?.length
      ? "confirmatory-provider-eligible"
      : "offline-stress-only";
    if (policy.execution_eligibility !== expectedEligibility) {
      ctx.addIssue({
        code: "custom",
        path: ["execution_eligibility"],
        message: `held-out eligibility must be ${expectedEligibility} for the declared realism result`,
      });
    }
  }
});

export const BenchmarkScenarioSchema = z.object({
  schema_version: z.literal(1),
  id: IdentifierSchema,
  version: z.string().min(1),
  title: z.string().min(1),
  domain: IdentifierSchema,
  description: z.string().min(1),
  seed: z.number().int().nonnegative(),
  objective: z.string().min(1),
  max_turns: z.number().int().positive(),
  execution_policy: BenchmarkExecutionPolicySchema.optional(),
  initial_facts: z.record(z.string(), JsonValueSchema),
  caller: z.object({
    persona: z.string().min(1),
    goal: z.string().min(1),
    private_facts: z.record(z.string(), JsonValueSchema).default({}),
    turns: z.array(CallerTurnSchema).min(1),
  }).strict(),
  tools: z.array(ToolDefinitionSchema).min(1),
  success_assertions: z.array(WorldAssertionSchema).min(1),
  safety_invariants: z.array(WorldAssertionSchema).min(1),
}).strict().superRefine((scenario, ctx) => {
  const checkUnique = (values: string[], path: string, label: string) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) ctx.addIssue({ code: "custom", path: [path, index, "id"], message: `duplicate ${label} "${value}"` });
      seen.add(value);
    }
  };
  checkUnique(scenario.tools.map((tool) => tool.name), "tools", "tool name");
  checkUnique(scenario.caller.turns.map((turn) => turn.id), "caller.turns", "caller turn id");
  checkUnique(
    [...scenario.success_assertions, ...scenario.safety_invariants].map((assertion) => assertion.id),
    "assertions",
    "assertion id"
  );
  if (scenario.caller.turns.length > scenario.max_turns) {
    ctx.addIssue({
      code: "custom",
      path: ["caller", "turns"],
      message: `caller script has ${scenario.caller.turns.length} turns, exceeding max_turns ${scenario.max_turns}`,
    });
  }
  if (scenario.execution_policy) {
    if (scenario.execution_policy.declared_turn_count !== scenario.caller.turns.length) {
      ctx.addIssue({
        code: "custom",
        path: ["execution_policy", "declared_turn_count"],
        message: "execution policy turn count must equal the materialized caller-turn count",
      });
    }
    if (scenario.execution_policy.study_role === "confirmatory-held-out" && scenario.max_turns !== scenario.caller.turns.length) {
      ctx.addIssue({
        code: "custom",
        path: ["max_turns"],
        message: "confirmatory-held-out scenarios must bind max_turns to their exact caller-turn count",
      });
    }
  }

  const toolNames = new Set(scenario.tools.map((tool) => tool.name));
  const mutablePaths = scenario.tools.flatMap((tool) => tool.effects.map((effect) => effect.path));
  for (const [toolIndex, tool] of scenario.tools.entries()) {
    const worldSources: Array<readonly [ValueSource, readonly (string | number)[]]> = [];
    const addWorldPredicateSources = (predicate: Predicate, path: readonly (string | number)[]) => {
      worldSources.push([predicate.left, [...path, "left"]]);
      if (predicate.right) worldSources.push([predicate.right, [...path, "right"]]);
    };
    tool.semantic_key.forEach((source, index) => worldSources.push([source, ["semantic_key", index]]));
    tool.prerequisites.forEach((predicate, index) => addWorldPredicateSources(predicate, ["prerequisites", index]));
    tool.faults.forEach((fault, faultIndex) => fault.when.forEach((predicate, predicateIndex) =>
      addWorldPredicateSources(predicate, ["faults", faultIndex, "when", predicateIndex])
    ));
    tool.effects.forEach((effect, index) => worldSources.push([effect.value, ["effects", index, "value"]]));
    tool.result.fields.forEach((field, index) => worldSources.push([field.value, ["result", "fields", index, "value"]]));
    for (const [source, path] of worldSources) {
      if (!("source" in source) || source.source !== "world") continue;
      const pathCanExist = jsonPathExists(scenario.initial_facts, source.path)
        || mutablePaths.some((mutablePath) =>
          mutablePath === source.path
          || mutablePath.startsWith(`${source.path}.`)
          || source.path.startsWith(`${mutablePath}.`)
        );
      if (!pathCanExist) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", toolIndex, ...path, "path"],
          message: `world source path "${source.path}" is absent from initial and declared mutable state`,
        });
      }
    }
    for (const [sourceIndex, source] of tool.semantic_key.entries()) {
      if (!("source" in source)) continue;
      if (source.source === "world") {
        if (!jsonPathExists(scenario.initial_facts, source.path)) {
          ctx.addIssue({
            code: "custom",
            path: ["tools", toolIndex, "semantic_key", sourceIndex],
            message: `semantic key world path "${source.path}" is absent from initial facts`,
          });
        }
        const overlapsMutation = mutablePaths.some((path) =>
          path === source.path || path.startsWith(`${source.path}.`) || source.path.startsWith(`${path}.`)
        );
        if (overlapsMutation) {
          ctx.addIssue({
            code: "custom",
            path: ["tools", toolIndex, "semantic_key", sourceIndex],
            message: `semantic key world path "${source.path}" overlaps mutable world state`,
          });
        }
      }
      if (source.source === "arguments") {
        const argumentName = source.path.split(".")[0];
        const argument = tool.arguments.find((candidate) => candidate.name === argumentName);
        if (!argument || !argument.required) {
          ctx.addIssue({
            code: "custom",
            path: ["tools", toolIndex, "semantic_key", sourceIndex],
            message: `semantic key argument path "${source.path}" must begin with a declared required argument`,
          });
        }
      }
      if (source.source === "runtime") {
        ctx.addIssue({
          code: "custom",
          path: ["tools", toolIndex, "semantic_key", sourceIndex],
          message: "semantic key cannot depend on runtime metadata",
        });
      }
    }
  }
  for (const [groupName, assertions] of [
    ["success_assertions", scenario.success_assertions],
    ["safety_invariants", scenario.safety_invariants],
  ] as const) {
    for (const [index, assertion] of assertions.entries()) {
      const referencedTools = assertion.kind === "effect_order"
        ? [assertion.before_tool, assertion.after_tool]
        : "tool" in assertion && assertion.tool ? [assertion.tool] : [];
      for (const tool of referencedTools) {
        if (!toolNames.has(tool)) {
          ctx.addIssue({ code: "custom", path: [groupName, index], message: `assertion references unknown tool "${tool}"` });
        }
      }
      if (assertion.kind === "effect_count" && assertion.path) {
        const definition = scenario.tools.find((tool) => tool.name === assertion.tool);
        if (definition && !definition.effects.some((effect) => effect.path === assertion.path)) {
          ctx.addIssue({
            code: "custom",
            path: [groupName, index, "path"],
            message: `assertion path "${assertion.path}" is not an effect of tool "${assertion.tool}"`,
          });
        }
      }
      if (assertion.kind === "effect_count") {
        const definition = scenario.tools.find((tool) => tool.name === assertion.tool);
        if (definition?.kind !== "mutation") {
          ctx.addIssue({ code: "custom", path: [groupName, index, "tool"], message: "effect_count requires a mutation tool" });
        }
      }
      if (assertion.kind === "no_duplicate_effect" && assertion.tool) {
        const definition = scenario.tools.find((tool) => tool.name === assertion.tool);
        if (definition?.kind !== "mutation") {
          ctx.addIssue({ code: "custom", path: [groupName, index, "tool"], message: "no_duplicate_effect requires a mutation tool" });
        }
      }
      if (assertion.kind === "effect_order") {
        const before = scenario.tools.find((tool) => tool.name === assertion.before_tool);
        const after = scenario.tools.find((tool) => tool.name === assertion.after_tool);
        if (assertion.before_tool === assertion.after_tool) {
          ctx.addIssue({ code: "custom", path: [groupName, index], message: "effect_order requires two distinct tools" });
        }
        if (before?.kind !== "mutation" || after?.kind !== "mutation") {
          ctx.addIssue({ code: "custom", path: [groupName, index], message: "effect_order requires mutation tools" });
        }
      }
      if (assertion.kind === "fact") {
        for (const [operand, source] of [
          ["left", assertion.predicate.left],
          ["right", assertion.predicate.right],
        ] as const) {
          if (!source || !("source" in source) || source.source !== "world") continue;
          const pathCanExist = jsonPathExists(scenario.initial_facts, source.path)
            || mutablePaths.some((path) =>
              path === source.path || path.startsWith(`${source.path}.`) || source.path.startsWith(`${path}.`)
            );
          if (!pathCanExist) {
            ctx.addIssue({
              code: "custom",
              path: [groupName, index, "predicate", operand, "path"],
              message: `fact assertion world path "${source.path}" is absent from initial and declared mutable state`,
            });
          }
        }
      }
      if (assertion.kind === "all_prerequisites_passed" && assertion.tool) {
        const definition = scenario.tools.find((tool) => tool.name === assertion.tool);
        if (definition && definition.prerequisites.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: [groupName, index, "tool"],
            message: `tool "${assertion.tool}" declares no prerequisites to audit`,
          });
        }
        if (definition?.kind !== "mutation") {
          ctx.addIssue({
            code: "custom",
            path: [groupName, index, "tool"],
            message: "all_prerequisites_passed audits committed mutation tools only",
          });
        }
      }
    }
  }
});

export type BenchmarkScenario = z.infer<typeof BenchmarkScenarioSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type WorldAssertion = z.infer<typeof WorldAssertionSchema>;

export const ToolInvocationSchema = z.object({
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  arguments: z.record(z.string(), JsonValueSchema),
  turn: z.number().int().nonnegative(),
  idempotency_key: z.string().min(1).optional(),
  semantic_opportunity_id: IdentifierSchema.optional(),
}).strict();

export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;

export const VisibleToolResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: JsonValueSchema }).strict(),
  z.object({ ok: z.literal(false), error: VisibleToolErrorSchema }).strict(),
]);

export type VisibleToolResult = z.infer<typeof VisibleToolResultSchema>;

export const PrerequisiteEvidenceSchema = z.object({
  prerequisite_id: IdentifierSchema,
  description: z.string(),
  passed: z.boolean(),
  /** `exists` means the path is present; a present JSON null is still present. */
  actual_present: z.boolean(),
  expected_present: z.boolean().optional(),
  actual: JsonValueSchema.optional(),
  expected: JsonValueSchema.optional(),
}).strict();

export const WorldEffectSchema = z.object({
  effect_id: z.string().min(1),
  receipt_id: z.string().min(1),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  semantic_key: z.string().min(1),
  event_sequence: z.number().int().positive(),
  operation: z.enum(["set", "increment", "append"]),
  path: SafePathSchema,
  before_present: z.boolean(),
  before: JsonValueSchema.optional(),
  after: JsonValueSchema,
  duplicate_of_effect_id: z.string().min(1).optional(),
}).strict().superRefine((effect, ctx) => {
  if (effect.before_present !== (effect.before !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["before"],
      message: "before must be present exactly when before_present is true",
    });
  }
});

export const WorldAdmissionSchema = z.object({
  admission_id: z.string().min(1),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  semantic_key: z.string().min(1),
  turn: z.number().int().nonnegative(),
  request_attempt: z.number().int().positive(),
  tool_ordinal: z.number().int().positive(),
  semantic_ordinal: z.number().int().positive(),
  semantic_opportunity_id: IdentifierSchema.optional(),
  /** Per-fault ordinal among admitted executions whose `when` predicates matched. */
  fault_match_ordinals: z.record(IdentifierSchema, z.number().int().positive()),
  event_sequence: z.number().int().positive(),
  world_before_hash: ContentHashSchema,
  prerequisite_evidence_hash: ContentHashSchema,
}).strict();

export const WorldReceiptSchema = z.object({
  receipt_id: z.string().min(1),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  arguments: z.record(z.string(), JsonValueSchema),
  idempotency_key: z.string().min(1).optional(),
  semantic_opportunity_id: IdentifierSchema.optional(),
  admission_id: z.string().min(1).optional(),
  attempt: z.number().int().positive(),
  turn: z.number().int().nonnegative(),
  status: WorldReceiptStatusSchema,
  committed: z.boolean(),
  semantic_key: z.string().min(1),
  duplicate_of_receipt_id: z.string().min(1).optional(),
  prerequisite_evidence: z.array(PrerequisiteEvidenceSchema),
  effect_ids: z.array(z.string()),
  authoritative_result: JsonValueSchema.optional(),
  visible_result: VisibleToolResultSchema,
  tainted_result_paths: z.array(z.object({
    path: SafePathSchema,
    kind: z.enum(["prompt_injection", "untrusted_external_text", "counterfeit_receipt"]),
    source: z.string(),
    expected_handling: z.string(),
  }).strict()),
}).strict();

export type PrerequisiteEvidence = z.infer<typeof PrerequisiteEvidenceSchema>;
export type WorldAdmission = z.infer<typeof WorldAdmissionSchema>;
export type WorldEffect = z.infer<typeof WorldEffectSchema>;
export type WorldReceipt = z.infer<typeof WorldReceiptSchema>;
