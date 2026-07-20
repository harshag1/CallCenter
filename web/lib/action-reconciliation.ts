// Exact read-back contracts for actions whose response was lost after dispatch.
// Contracts are pinned server metadata. The model supplies only a receipt id.

import { z } from "zod";
import { hashFlowValue, type FlowActionReceipt } from "./flow-runtime";
import {
  compileVoiceToolSchema,
  isBoundedVoiceToolJson,
  normalizeVoiceToolSchema,
} from "./voice-tools/schema";

const TOOL_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PROOF_BYTES = 256 * 1024;
const MAX_RECONCILIATION_VALIDATORS = 1_024;

type ReconciliationValidator = ReturnType<typeof compileVoiceToolSchema>;
type AdmittedReconciliationSchema = Readonly<{
  normalized: Readonly<Record<string, unknown>>;
  hash: string;
  validator: ReconciliationValidator;
}>;
const reconciliationValidators = new Map<string, ReconciliationValidator>();
const objectRootSchemas = new WeakMap<object, AdmittedReconciliationSchema>();
const anyRootSchemas = new WeakMap<object, AdmittedReconciliationSchema>();

function portableReconciliationSchema(
  label: string,
  requireObjectRoot: boolean
) {
  return z.unknown().transform((value, ctx): Record<string, unknown> => {
    try {
      return normalizeVoiceToolSchema(value, { label, requireObjectRoot }) as Record<string, unknown>;
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : `${label} is invalid`,
      });
      return z.NEVER;
    }
  });
}

function admittedSchema(
  schema: Record<string, unknown>,
  options: { label: string; requireObjectRoot: boolean }
): AdmittedReconciliationSchema {
  const objectCache = options.requireObjectRoot ? objectRootSchemas : anyRootSchemas;
  const cachedForObject = objectCache.get(schema);
  if (cachedForObject) return cachedForObject;
  const normalized = normalizeVoiceToolSchema(schema, options);
  const hash = hashFlowValue(normalized);
  const key = `${options.requireObjectRoot ? "object" : "any"}:${hash}`;
  let validator = reconciliationValidators.get(key);
  if (!validator) {
    validator = compileVoiceToolSchema(normalized);
    if (reconciliationValidators.size >= MAX_RECONCILIATION_VALIDATORS) {
      const oldest = reconciliationValidators.keys().next().value as string | undefined;
      if (oldest) reconciliationValidators.delete(oldest);
    }
    reconciliationValidators.set(key, validator);
  }
  const admitted = Object.freeze({ normalized, hash, validator });
  objectCache.set(schema, admitted);
  objectCache.set(normalized, admitted);
  return admitted;
}

/** Canonical, bounded schema identity used when a Flow fallback meets source-pinned authority. */
export function reconciliationSchemaHash(
  schema: Record<string, unknown>,
  options: { label?: string; requireObjectRoot?: boolean } = {}
): string {
  return admittedSchema(schema, {
    label: options.label ?? "reconciliation schema",
    requireObjectRoot: options.requireObjectRoot ?? false,
  }).hash;
}

const SafePathSchema = z.string().min(1).max(512).superRefine((path, ctx) => {
  if (!safePathSegments(path)) ctx.addIssue({ code: "custom", message: "unsafe reconciliation path" });
});

const ReconciliationValueSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("invocation_id") }).strict(),
  z.object({ source: z.literal("call_id") }).strict(),
  z.object({ source: z.literal("organization_id") }).strict(),
  z.object({ source: z.literal("agent_id") }).strict(),
  z.object({ source: z.literal("action_argument"), path: SafePathSchema }).strict(),
  z.object({ source: z.literal("literal"), value: z.json() }).strict(),
]);

const ReconciliationPredicateSchema = z.object({
  resultPath: SafePathSchema,
  equals: ReconciliationValueSourceSchema,
}).strict();

function validatePredicateSet(
  predicates: readonly z.infer<typeof ReconciliationPredicateSchema>[],
  path: "committedWhen" | "absentWhen",
  ctx: z.RefinementCtx
): void {
  const predicatePaths = predicates.map((predicate) => predicate.resultPath);
  if (new Set(predicatePaths).size !== predicatePaths.length) {
    ctx.addIssue({ code: "custom", path: [path], message: "proof predicates must bind distinct result paths" });
  }
  if (!predicates.some((predicate) => predicate.equals.source === "invocation_id")) {
    ctx.addIssue({ code: "custom", path: [path], message: "proof must echo the gateway invocation id" });
  }
  if (!predicates.some((predicate) => predicate.equals.source === "literal")) {
    ctx.addIssue({ code: "custom", path: [path], message: "proof must contain an exact terminal literal" });
  }
  for (const [index, predicate] of predicates.entries()) {
    if (predicate.equals.source === "literal" &&
        predicate.equals.value !== null &&
        typeof predicate.equals.value === "object") {
      ctx.addIssue({
        code: "custom",
        path: [path, index, "equals", "value"],
        message: "terminal literals must be scalar JSON values",
      });
    }
  }
}

export const ActionReconciliationSpecSchema = z.object({
  queryTool: z.string().regex(TOOL_NAME),
  queryArguments: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
    ReconciliationValueSourceSchema
  ),
  committedWhen: z.array(ReconciliationPredicateSchema).min(2).max(16),
  /** Exact invocation-bound proof that the original mutation is authoritatively absent. */
  absentWhen: z.array(ReconciliationPredicateSchema).min(2).max(16),
  /**
   * Exact proof-envelope schema when the read-back source cannot publish one itself (notably
   * generated tools). This remains operator-authored Flow metadata and is bound into the call
   * runtime digest; it is never accepted from model arguments or a live tool response.
   */
  queryOutputSchema: portableReconciliationSchema(
    "reconciliation proof-envelope fallback schema",
    true
  ).optional(),
  authoritativeResultPath: SafePathSchema,
  /** Required when the mutated tool itself has no pinned output schema (for example generated tools). */
  authoritativeResultSchema: portableReconciliationSchema(
    "reconciliation authoritative-result fallback schema",
    false
  ).optional(),
  maxProofAttempts: z.number().int().min(1).max(10).default(3),
}).strict().superRefine((spec, ctx) => {
  const querySources = Object.values(spec.queryArguments);
  if (!querySources.some((source) => source.source === "invocation_id")) {
    ctx.addIssue({ code: "custom", path: ["queryArguments"], message: "query must receive the gateway invocation id" });
  }
  validatePredicateSet(spec.committedWhen, "committedWhen", ctx);
  validatePredicateSet(spec.absentWhen, "absentWhen", ctx);
  if (JSON.stringify(spec.absentWhen) === JSON.stringify(spec.committedWhen)) {
    ctx.addIssue({
      code: "custom",
      path: ["absentWhen"],
      message: "absent proof predicates must differ from committed proof predicates",
    });
  }
  const committedLiterals = spec.committedWhen.filter(
    (predicate) => predicate.equals.source === "literal"
  );
  const absentLiterals = spec.absentWhen.filter(
    (predicate) => predicate.equals.source === "literal"
  );
  const hasDisjointTerminalDiscriminator = committedLiterals.some((committed) =>
    absentLiterals.some((absent) =>
      absent.resultPath === committed.resultPath &&
      JSON.stringify(absent.equals.source === "literal" ? absent.equals.value : undefined) !==
        JSON.stringify(committed.equals.source === "literal" ? committed.equals.value : undefined)
    )
  );
  if (!hasDisjointTerminalDiscriminator) {
    ctx.addIssue({
      code: "custom",
      path: ["absentWhen"],
      message: "terminal proofs must share one discriminator path with distinct literal values",
    });
  }
});

export type ActionReconciliationSpec = z.infer<typeof ActionReconciliationSpecSchema>;
type ReconciliationValueSource = z.infer<typeof ReconciliationValueSourceSchema>;

export type ReconciliationScope = Readonly<{
  callId: string;
  organizationId: string;
  agentId: string;
}>;

export type ReconciliationToolDefinition = Readonly<{
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effect?: "read" | "write" | "opaque";
  reconciliation?: ActionReconciliationSpec;
}>;

/** Validates the trusted, pinned catalog as one closed reconciliation authority set. */
export function assertTrustedReconciliationCatalog(
  definitions: readonly ReconciliationToolDefinition[]
): void {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  for (const action of definitions) {
    if (!action.reconciliation) continue;
    const spec = ActionReconciliationSpecSchema.parse(action.reconciliation);
    const query = byName.get(spec.queryTool);
    const authoritativeResultSchema = action.outputSchema ?? spec.authoritativeResultSchema;
    if (!action.effect || action.effect === "read" ||
        !authoritativeResultSchema) {
      throw new Error(`reconcilable action ${action.name} must declare a non-read effect and authoritative output schema`);
    }
    const queryOutputSchema = query?.outputSchema ?? spec.queryOutputSchema;
    if (!query || query.name === action.name || query.effect !== "read" || !queryOutputSchema) {
      throw new Error(`reconciliation query ${spec.queryTool} must be a distinct pinned read-only tool with an output schema`);
    }
    try {
      const sourceActionOutput = action.outputSchema
        ? admittedSchema(action.outputSchema, {
            label: `${action.name} source output schema`,
            requireObjectRoot: false,
          })
        : null;
      const fallbackActionOutput = spec.authoritativeResultSchema
        ? admittedSchema(spec.authoritativeResultSchema, {
            label: `${action.name} authoritative result fallback schema`,
            requireObjectRoot: false,
          })
        : null;
      if (sourceActionOutput && fallbackActionOutput &&
          sourceActionOutput.hash !== fallbackActionOutput.hash) {
        throw new Error(
          `reconciliation policy cannot replace the pinned authoritative output schema of ${action.name}`
        );
      }
      const sourceQueryOutput = query.outputSchema
        ? admittedSchema(query.outputSchema, {
            label: `${query.name} source output schema`,
            requireObjectRoot: true,
          })
        : null;
      const fallbackQueryOutput = spec.queryOutputSchema
        ? admittedSchema(spec.queryOutputSchema, {
            label: `${query.name} proof-envelope fallback schema`,
            requireObjectRoot: true,
          })
        : null;
      if (sourceQueryOutput && fallbackQueryOutput &&
          sourceQueryOutput.hash !== fallbackQueryOutput.hash) {
        throw new Error(`reconciliation policy cannot replace the pinned output schema of ${query.name}`);
      }
      admittedSchema(action.inputSchema, {
        label: `${action.name} input schema`,
        requireObjectRoot: true,
      });
      admittedSchema(query.inputSchema, {
        label: `${query.name} input schema`,
        requireObjectRoot: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid portable schema";
      throw new Error(`reconciliation authority for ${action.name} is invalid: ${message}`);
    }
  }
}

export type DerivedReconciliation = Readonly<{
  queryArguments: Record<string, unknown>;
  policyHash: string;
  predicateHash: string;
}>;

function safePathSegments(path: string): string[] | null {
  const normalized = path === "$" ? "" : path.replace(/^\$\.?/, "");
  const segments = normalized ? normalized.split(".") : [];
  if (segments.some((segment) => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) return null;
  return segments;
}

export function reconciliationValueAtPath(
  value: unknown,
  path: string
): { found: boolean; value?: unknown } {
  const segments = safePathSegments(path);
  if (!segments) return { found: false };
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function sourceValue(
  source: ReconciliationValueSource,
  receipt: FlowActionReceipt,
  scope: ReconciliationScope
): { found: boolean; value?: unknown } {
  switch (source.source) {
    case "invocation_id":
      return receipt.invocationId ? { found: true, value: receipt.invocationId } : { found: false };
    case "call_id":
      return { found: true, value: scope.callId };
    case "organization_id":
      return { found: true, value: scope.organizationId };
    case "agent_id":
      return { found: true, value: scope.agentId };
    case "action_argument":
      return reconciliationValueAtPath(receipt.arguments, source.path);
    case "literal":
      return { found: true, value: source.value };
  }
}

export function deriveReconciliation(
  specInput: unknown,
  receipt: FlowActionReceipt,
  scope: ReconciliationScope
): DerivedReconciliation {
  const spec = ActionReconciliationSpecSchema.parse(specInput);
  if (receipt.status !== "indeterminate" || !receipt.invocationId || !receipt.dispatchStartedAt) {
    throw new Error("receipt is not eligible for exact reconciliation");
  }
  const queryArguments: Record<string, unknown> = {};
  for (const [target, source] of Object.entries(spec.queryArguments)) {
    const resolved = sourceValue(source, receipt, scope);
    if (!resolved.found) throw new Error(`reconciliation source for ${target} is unavailable`);
    queryArguments[target] = structuredClone(resolved.value);
  }
  return Object.freeze({
    queryArguments,
    policyHash: hashFlowValue(spec),
    // One digest commits to both terminal outcomes. Hashing only the success
    // predicate would let an absence policy drift without changing the proof
    // row's predicate identity.
    predicateHash: hashFlowValue({
      committedWhen: spec.committedWhen,
      absentWhen: spec.absentWhen,
    }),
  });
}

function boundedProofJson(value: unknown): boolean {
  if (!isBoundedVoiceToolJson(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PROOF_BYTES;
  } catch {
    return false;
  }
}

function exactEqual(left: unknown, right: unknown): boolean {
  try {
    return hashFlowValue(left) === hashFlowValue(right);
  } catch {
    return false;
  }
}

function validatesSchema(
  schema: Record<string, unknown> | undefined,
  value: unknown,
  options: { label: string; requireObjectRoot: boolean }
): boolean {
  if (!schema || !isBoundedVoiceToolJson(value)) return false;
  try {
    return Boolean(admittedSchema(schema, options).validator(value));
  } catch {
    return false;
  }
}

/** The derived query payload must still satisfy the exact pinned read-tool input schema. */
export function reconciliationArgumentsMatchSchema(
  schema: Record<string, unknown> | undefined,
  value: Record<string, unknown>
): boolean {
  return validatesSchema(schema, value, {
    label: "reconciliation query input schema",
    requireObjectRoot: true,
  });
}

export type ReconciliationEvaluation =
  | Readonly<{
      outcome: "committed";
      committed: true;
      authoritativeResult: unknown;
      proofResultHash: string;
      authoritativeResultHash: string;
    }>
  | Readonly<{
      outcome: "absent";
      committed: false;
      authoritativeAbsent: true;
      proofResultHash: string;
    }>
  | Readonly<{
      outcome: "indeterminate";
      committed: false;
      reason: "invalid_proof" | "pending_or_unknown" | "result_missing" | "result_schema_mismatch";
    }>;

function predicatesMatch(
  predicates: readonly z.infer<typeof ReconciliationPredicateSchema>[],
  receipt: FlowActionReceipt,
  scope: ReconciliationScope,
  proofResult: unknown
): boolean {
  return predicates.every((predicate) => {
    const actual = reconciliationValueAtPath(proofResult, predicate.resultPath);
    const expected = sourceValue(predicate.equals, receipt, scope);
    return actual.found && expected.found && exactEqual(actual.value, expected.value);
  });
}

export function evaluateReconciliationProof(
  specInput: unknown,
  receipt: FlowActionReceipt,
  scope: ReconciliationScope,
  proofResult: unknown,
  queryOutputSchema: Record<string, unknown> | undefined,
  originalOutputSchema: Record<string, unknown> | undefined
): ReconciliationEvaluation {
  const parsed = ActionReconciliationSpecSchema.safeParse(specInput);
  if (!parsed.success || !boundedProofJson(proofResult)) {
    return { outcome: "indeterminate", committed: false, reason: "invalid_proof" };
  }
  if (!validatesSchema(queryOutputSchema, proofResult, {
    label: "reconciliation proof-envelope schema",
    requireObjectRoot: true,
  })) {
    return { outcome: "indeterminate", committed: false, reason: "invalid_proof" };
  }
  const spec = parsed.data;
  const committed = predicatesMatch(spec.committedWhen, receipt, scope, proofResult);
  const absent = predicatesMatch(spec.absentWhen, receipt, scope, proofResult);
  if (committed && absent) {
    return { outcome: "indeterminate", committed: false, reason: "invalid_proof" };
  }
  if (absent) {
    return Object.freeze({
      outcome: "absent" as const,
      committed: false as const,
      authoritativeAbsent: true as const,
      proofResultHash: hashFlowValue(proofResult),
    });
  }
  if (!committed) {
    return { outcome: "indeterminate", committed: false, reason: "pending_or_unknown" };
  }
  const authoritative = reconciliationValueAtPath(proofResult, spec.authoritativeResultPath);
  if (!authoritative.found) {
    return { outcome: "indeterminate", committed: false, reason: "result_missing" };
  }
  // A source-published action schema is stronger authority than a Flow fallback. The policy may
  // supply a schema only for sources that publish none; it can never widen/replace one at proof
  // time, even if admission validation were accidentally bypassed.
  if (!validatesSchema(
    originalOutputSchema ?? spec.authoritativeResultSchema,
    authoritative.value,
    { label: "reconciliation authoritative result schema", requireObjectRoot: false }
  )) {
    return { outcome: "indeterminate", committed: false, reason: "result_schema_mismatch" };
  }
  return Object.freeze({
    outcome: "committed" as const,
    committed: true as const,
    authoritativeResult: structuredClone(authoritative.value),
    proofResultHash: hashFlowValue(proofResult),
    authoritativeResultHash: hashFlowValue(authoritative.value),
  });
}
