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
const PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\d+))*$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export const IdentifierSchema = z.string().regex(IDENTIFIER);

export const SafePathSchema = z.string().regex(PATH).refine(
  (path) => path.split(".").every((segment) => !FORBIDDEN_PATH_SEGMENTS.has(segment)),
  "path contains a forbidden segment"
);

export const ValueSourceSchema = z.union([
  z.object({ literal: JsonValueSchema }),
  z.object({
    source: z.enum(["world", "arguments", "runtime"]),
    path: SafePathSchema,
  }),
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
}).superRefine((predicate, ctx) => {
  if (!["exists", "not_exists"].includes(predicate.operator) && !predicate.right) {
    ctx.addIssue({ code: "custom", path: ["right"], message: `${predicate.operator} requires a right operand` });
  }
});

export type Predicate = z.infer<typeof PredicateSchema>;

export const ToolArgumentSchema = z.object({
  name: IdentifierSchema,
  description: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  required: z.boolean().default(false),
  enum: z.array(JsonValueSchema).min(1).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  pattern: z.string().optional(),
}).superRefine((argument, ctx) => {
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
});

export const ToolResultSpecSchema = z.object({
  fields: z.array(z.object({
    path: SafePathSchema,
    value: ValueSourceSchema,
  })).default([]),
  /** Paths are data from an untrusted external source, never instructions to the agent. */
  tainted_paths: z.array(z.object({
    path: SafePathSchema,
    kind: z.enum(["prompt_injection", "untrusted_external_text", "counterfeit_receipt"]),
    source: z.string().min(1),
    expected_handling: z.string().min(1),
  })).default([]),
}).superRefine((result, ctx) => {
  const fields = new Set<string>();
  for (const [index, field] of result.fields.entries()) {
    if (fields.has(field.path)) {
      ctx.addIssue({ code: "custom", path: ["fields", index, "path"], message: `duplicate result path "${field.path}"` });
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
});

export const FaultSpecSchema = z.object({
  id: IdentifierSchema,
  /** One-based, per-tool attempt number. Exact invocation replays do not consume attempts. */
  attempt: z.number().int().positive(),
  phase: z.enum(["before_commit", "after_commit"]),
  when: z.array(PredicateSchema).default([]),
  visible_error: VisibleToolErrorSchema,
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
}).superRefine((tool, ctx) => {
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
  for (const [index, fault] of tool.faults.entries()) {
    if (faultIds.has(fault.id)) {
      ctx.addIssue({ code: "custom", path: ["faults", index, "id"], message: `duplicate fault "${fault.id}"` });
    }
    faultIds.add(fault.id);
  }
  if (tool.kind === "mutation" && tool.semantic_key.length === 0) {
    ctx.addIssue({ code: "custom", path: ["semantic_key"], message: "mutation tools require a semantic key" });
  }
  if (tool.kind === "mutation" && tool.effects.length === 0) {
    ctx.addIssue({ code: "custom", path: ["effects"], message: "mutation tools require at least one authoritative effect" });
  }
  if (tool.kind === "query" && tool.effects.length > 0) {
    ctx.addIssue({ code: "custom", path: ["effects"], message: "query tools cannot declare effects" });
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
  })).default([]),
  expected_behavior: z.array(z.string().min(1)).default([]),
});

export const WorldAssertionSchema = z.discriminatedUnion("kind", [
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("fact"),
    predicate: PredicateSchema,
  }),
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("effect_count"),
    tool: IdentifierSchema,
    path: SafePathSchema.optional(),
    operator: z.enum(["equals", "less_than_or_equal", "greater_than_or_equal"]),
    value: z.number().int().nonnegative(),
  }),
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("effect_order"),
    before_tool: IdentifierSchema,
    after_tool: IdentifierSchema,
  }),
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("no_duplicate_effect"),
    tool: IdentifierSchema.optional(),
  }),
  z.object({
    id: IdentifierSchema,
    description: z.string().min(1),
    severity: z.enum(["critical", "major", "minor"]),
    kind: z.literal("all_prerequisites_passed"),
    tool: IdentifierSchema.optional(),
  }),
]);

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
  initial_facts: z.record(z.string(), JsonValueSchema),
  caller: z.object({
    persona: z.string().min(1),
    goal: z.string().min(1),
    private_facts: z.record(z.string(), JsonValueSchema).default({}),
    turns: z.array(CallerTurnSchema).min(1),
  }),
  tools: z.array(ToolDefinitionSchema).min(1),
  success_assertions: z.array(WorldAssertionSchema).min(1),
  safety_invariants: z.array(WorldAssertionSchema).min(1),
}).superRefine((scenario, ctx) => {
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

  const toolNames = new Set(scenario.tools.map((tool) => tool.name));
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
});

export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;

export const VisibleToolResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: JsonValueSchema }),
  z.object({ ok: z.literal(false), error: VisibleToolErrorSchema }),
]);

export type VisibleToolResult = z.infer<typeof VisibleToolResultSchema>;

export const PrerequisiteEvidenceSchema = z.object({
  prerequisite_id: IdentifierSchema,
  description: z.string(),
  passed: z.boolean(),
  actual: JsonValueSchema.optional(),
  expected: JsonValueSchema.optional(),
});

export const WorldEffectSchema = z.object({
  effect_id: z.string().min(1),
  receipt_id: z.string().min(1),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  semantic_key: z.string().min(1),
  event_sequence: z.number().int().positive(),
  operation: z.enum(["set", "increment", "append"]),
  path: SafePathSchema,
  before: JsonValueSchema.optional(),
  after: JsonValueSchema,
  duplicate_of_effect_id: z.string().min(1).optional(),
});

export const WorldReceiptSchema = z.object({
  receipt_id: z.string().min(1),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  arguments: z.record(z.string(), JsonValueSchema),
  attempt: z.number().int().positive(),
  turn: z.number().int().nonnegative(),
  status: z.enum(["succeeded", "rejected", "failed_before_commit", "committed_after_error", "deduplicated"]),
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
  })),
});

export type PrerequisiteEvidence = z.infer<typeof PrerequisiteEvidenceSchema>;
export type WorldEffect = z.infer<typeof WorldEffectSchema>;
export type WorldReceipt = z.infer<typeof WorldReceiptSchema>;
