import { createHash } from "node:crypto";
import { z } from "zod";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z][a-z0-9_.:-]{1,127}$/;
const MAX_POLICY_BYTES = 512 * 1024;

const JsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(JsonSchema), z.record(z.string(), JsonSchema),
]));

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type PolicyAuthority = "caller" | "tool" | "policy" | "operator" | "system";

function validateComparison(
  predicate: Readonly<{ operator: "exists" | "equals" | "not_equals" | "in"; value?: Json }>,
  ctx: z.RefinementCtx,
): void {
  if (predicate.operator !== "exists" && predicate.value === undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "comparison requires value" });
  }
  if (predicate.operator === "in" && !Array.isArray(predicate.value)) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "in requires an array" });
  }
}

const FactPredicateSchema = z.object({
  kind: z.literal("fact"),
  fact_id: z.string().regex(SAFE_ID),
  operator: z.enum(["exists", "equals", "not_equals", "in"]),
  value: JsonSchema.optional(),
  authorities: z.array(z.enum(["caller", "tool", "policy", "operator", "system"]))
    .min(1).max(5).optional(),
  max_age_seconds: z.number().int().positive().max(31_536_000).optional(),
}).strict().superRefine(validateComparison);

const ArgumentPredicateSchema = z.object({
  kind: z.literal("argument"),
  path: z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,7}$/),
  operator: z.enum(["exists", "equals", "not_equals", "in"]),
  value: JsonSchema.optional(),
}).strict().superRefine(validateComparison);

const ReceiptPredicateSchema = z.object({
  kind: z.literal("receipt"),
  action: z.string().regex(SAFE_ID),
  status: z.literal("succeeded"),
}).strict();

export const ActionPolicyPredicateSchema = z.discriminatedUnion("kind", [
  FactPredicateSchema,
  ArgumentPredicateSchema,
  ReceiptPredicateSchema,
]);
export type ActionPolicyPredicate = z.infer<typeof ActionPolicyPredicateSchema>;

export const ActionPolicySchema = z.object({
  action: z.string().regex(SAFE_ID),
  effect: z.enum(["read", "write", "opaque"]),
  require_all: z.array(ActionPolicyPredicateSchema).max(128).default([]),
  deny_if_any: z.array(ActionPolicyPredicateSchema).max(128).default([]),
  maximum_calls: z.number().int().positive().max(10_000).optional(),
  confirmation: z.object({
    authorities: z.array(z.enum(["caller", "operator"])).min(1).max(2),
    max_age_seconds: z.number().int().positive().max(3_600),
    readback_fields: z.array(z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,7}$/))
      .max(16).default([]),
  }).strict().optional(),
  postconditions: z.array(ArgumentPredicateSchema).max(128).default([]),
  provider_visible_result_fields: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/))
    .max(128).default([]),
}).strict();

export const ActionPolicySetSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(SAFE_ID),
  version: z.string().min(1).max(128),
  actions: z.array(ActionPolicySchema).min(1).max(1_024),
  default_decision: z.literal("deny").default("deny"),
}).strict().superRefine((policy, ctx) => {
  const names = policy.actions.map((action) => action.action);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "action policies must be unique" });
  }
});
export type ActionPolicySet = z.infer<typeof ActionPolicySetSchema>;

export type PolicyFact = Readonly<{
  fact_id: string;
  revision: number;
  value: Json;
  authority: PolicyAuthority;
  observed_at: string;
  evidence_sha256: string;
}>;

export type PolicyReceipt = Readonly<{
  action: string;
  status: "succeeded" | "failed" | "indeterminate";
  receipt_sha256: string;
}>;

export type ConfirmationEvidence = Readonly<{
  proposal_digest: string;
  challenge_digest: string;
  authority: "caller" | "operator";
  confirmed_at: string;
  evidence_sha256: string;
  state_revision: number;
  capability_epoch: number;
}>;

export type PreDispatchInput = Readonly<{
  policy: unknown;
  action: string;
  arguments: Readonly<Record<string, Json>>;
  state_head_sha256: string;
  state_revision: number;
  capability_epoch: number;
  facts: readonly PolicyFact[];
  receipts: readonly PolicyReceipt[];
  prior_call_count: number;
  confirmation?: ConfirmationEvidence;
  now: string;
}>;

export type PreDispatchDecision = Readonly<{
  decision: "allow" | "deny" | "require_confirmation";
  reason: string;
  action: string;
  effect: "read" | "write" | "opaque" | "unknown";
  policy_digest: string;
  state_head_sha256: string;
  state_revision: number;
  capability_epoch: number;
  arguments_sha256: string;
  proposal_digest: string;
  challenge_digest: string | null;
  evidence_sha256: readonly string[];
  decision_digest: string;
}>;

function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error("undefined is not valid canonical JSON");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonicalJson(value)}`, "utf8").digest("hex");
}

function parsePolicy(input: unknown): ActionPolicySet {
  const policy = ActionPolicySetSchema.parse(input);
  if (Buffer.byteLength(canonicalJson(policy), "utf8") > MAX_POLICY_BYTES) {
    throw new Error("action policy set exceeds 512KB");
  }
  return policy;
}

function valueAtPath(root: unknown, path: string): unknown {
  let value = root;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function compare(actual: unknown, operator: "exists" | "equals" | "not_equals" | "in", expected?: Json): boolean {
  if (operator === "exists") return actual !== undefined;
  const same = actual !== undefined && canonicalJson(actual) === canonicalJson(expected);
  if (operator === "equals") return same;
  if (operator === "not_equals") return actual !== undefined && !same;
  return Array.isArray(expected) && expected.some((candidate) =>
    actual !== undefined && canonicalJson(actual) === canonicalJson(candidate));
}

function evaluatePredicate(
  predicate: ActionPolicyPredicate,
  input: PreDispatchInput,
  nowMs: number,
): Readonly<{ passed: boolean; evidence: readonly string[] }> {
  if (predicate.kind === "argument") {
    return { passed: compare(valueAtPath(input.arguments, predicate.path), predicate.operator, predicate.value), evidence: [] };
  }
  if (predicate.kind === "receipt") {
    const receipt = input.receipts.find((candidate) =>
      candidate.action === predicate.action && candidate.status === predicate.status);
    return { passed: Boolean(receipt), evidence: receipt ? [receipt.receipt_sha256] : [] };
  }
  const fact = input.facts.find((candidate) => candidate.fact_id === predicate.fact_id);
  if (!fact || (predicate.authorities && !predicate.authorities.includes(fact.authority))) {
    return { passed: false, evidence: [] };
  }
  const observedAtMs = Date.parse(fact.observed_at);
  const observedAtIsValid = Number.isFinite(observedAtMs)
    && new Date(observedAtMs).toISOString() === fact.observed_at
    && observedAtMs <= nowMs;
  if (!observedAtIsValid || (predicate.max_age_seconds !== undefined &&
      nowMs - observedAtMs > predicate.max_age_seconds * 1_000)) {
    return { passed: false, evidence: [fact.evidence_sha256] };
  }
  return {
    passed: compare(fact.value, predicate.operator, predicate.value),
    evidence: [fact.evidence_sha256],
  };
}

function finishDecision(body: Omit<PreDispatchDecision, "decision_digest">): PreDispatchDecision {
  const normalized = {
    ...body,
    evidence_sha256: Object.freeze([...new Set(body.evidence_sha256)].sort()),
  };
  return Object.freeze({
    ...normalized,
    decision_digest: sha256("hacc/action-policy-decision/v1", normalized),
  });
}

export function evaluatePreDispatch(input: PreDispatchInput): PreDispatchDecision {
  if (!SHA256.test(input.state_head_sha256) || !Number.isSafeInteger(input.state_revision) ||
      input.state_revision < 0 || !Number.isSafeInteger(input.capability_epoch) ||
      input.capability_epoch < 0 || !Number.isSafeInteger(input.prior_call_count) ||
      input.prior_call_count < 0) throw new Error("invalid action policy state binding");
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== input.now) {
    throw new Error("policy evaluation time must be canonical ISO-8601");
  }
  const policy = parsePolicy(input.policy);
  const policyDigest = sha256("hacc/action-policy-set/v1", policy);
  const argumentsHash = sha256("hacc/action-policy-arguments/v1", input.arguments);
  const proposalBody = {
    policy_digest: policyDigest, action: input.action, arguments_sha256: argumentsHash,
    state_head_sha256: input.state_head_sha256, state_revision: input.state_revision,
    capability_epoch: input.capability_epoch,
  };
  const proposalDigest = sha256("hacc/action-policy-proposal/v1", proposalBody);
  const item = policy.actions.find((candidate) => candidate.action === input.action);
  const base = {
    action: input.action,
    effect: item?.effect ?? "unknown" as const,
    policy_digest: policyDigest,
    state_head_sha256: input.state_head_sha256,
    state_revision: input.state_revision,
    capability_epoch: input.capability_epoch,
    arguments_sha256: argumentsHash,
    proposal_digest: proposalDigest,
  };
  if (!item) return finishDecision({ ...base, decision: "deny", reason: "action_not_governed", challenge_digest: null, evidence_sha256: [] });

  const denied = item.deny_if_any.map((predicate) => evaluatePredicate(predicate, input, nowMs));
  if (denied.some((result) => result.passed)) {
    return finishDecision({ ...base, decision: "deny", reason: "deny_condition_matched", challenge_digest: null,
      evidence_sha256: denied.flatMap((result) => result.evidence) });
  }
  const required = item.require_all.map((predicate) => evaluatePredicate(predicate, input, nowMs));
  if (required.some((result) => !result.passed)) {
    return finishDecision({ ...base, decision: "deny", reason: "required_evidence_missing", challenge_digest: null,
      evidence_sha256: required.flatMap((result) => result.evidence) });
  }
  if (item.maximum_calls !== undefined && input.prior_call_count >= item.maximum_calls) {
    return finishDecision({ ...base, decision: "deny", reason: "call_limit_reached", challenge_digest: null,
      evidence_sha256: required.flatMap((result) => result.evidence) });
  }
  if (item.confirmation) {
    const challengeDigest = sha256("hacc/action-policy-confirmation-challenge/v1", {
      proposal_digest: proposalDigest,
      readback: Object.fromEntries(item.confirmation.readback_fields.map((path) =>
        [path, valueAtPath(input.arguments, path) ?? null])),
    });
    const confirmation = input.confirmation;
    const confirmedAtMs = confirmation ? Date.parse(confirmation.confirmed_at) : Number.NaN;
    const fresh = confirmation && Number.isFinite(confirmedAtMs) &&
      new Date(confirmedAtMs).toISOString() === confirmation.confirmed_at &&
      confirmedAtMs <= nowMs &&
      nowMs - confirmedAtMs <= item.confirmation.max_age_seconds * 1_000;
    const valid = confirmation && fresh && confirmation.proposal_digest === proposalDigest &&
      confirmation.challenge_digest === challengeDigest &&
      confirmation.state_revision === input.state_revision &&
      confirmation.capability_epoch === input.capability_epoch &&
      item.confirmation.authorities.includes(confirmation.authority) &&
      SHA256.test(confirmation.evidence_sha256);
    if (!valid) return finishDecision({ ...base, decision: "require_confirmation", reason: "fresh_confirmation_required",
      challenge_digest: challengeDigest, evidence_sha256: required.flatMap((result) => result.evidence) });
    return finishDecision({ ...base, decision: "allow", reason: "allowed", challenge_digest: challengeDigest,
      evidence_sha256: [...required.flatMap((result) => result.evidence), confirmation.evidence_sha256] });
  }
  return finishDecision({ ...base, decision: "allow", reason: "allowed", challenge_digest: null,
    evidence_sha256: required.flatMap((result) => result.evidence) });
}

export type PostDispatchDecision = Readonly<{
  decision: "accept" | "reject" | "quarantine" | "require_reconciliation";
  reason: string;
  raw_result_sha256: string;
  provider_result: Readonly<Record<string, Json>> | null;
  decision_digest: string;
}>;

export function evaluatePostDispatch(input: Readonly<{
  policy: unknown;
  pre_dispatch: PreDispatchDecision;
  current_state_head_sha256: string;
  current_state_revision: number;
  current_capability_epoch: number;
  result: Readonly<Record<string, Json>>;
}>): PostDispatchDecision {
  const policy = parsePolicy(input.policy);
  const policyDigest = sha256("hacc/action-policy-set/v1", policy);
  const item = policy.actions.find((candidate) => candidate.action === input.pre_dispatch.action);
  const rawHash = sha256("hacc/action-policy-result/v1", input.result);
  const finish = (
    decision: PostDispatchDecision["decision"], reason: string,
    providerResult: Readonly<Record<string, Json>> | null,
  ): PostDispatchDecision => Object.freeze({
    decision, reason, raw_result_sha256: rawHash, provider_result: providerResult,
    decision_digest: sha256("hacc/action-policy-post-decision/v1", {
      decision, reason, raw_result_sha256: rawHash,
      pre_dispatch_digest: input.pre_dispatch.decision_digest,
      current_state_head_sha256: input.current_state_head_sha256,
      current_state_revision: input.current_state_revision,
      current_capability_epoch: input.current_capability_epoch,
    }),
  });
  if (!item || input.pre_dispatch.decision !== "allow") return finish("quarantine", "dispatch_was_not_allowed", null);
  if (input.pre_dispatch.policy_digest !== policyDigest) {
    return finish("quarantine", "policy_changed_after_decision", null);
  }
  if (input.current_state_head_sha256 !== input.pre_dispatch.state_head_sha256 ||
      input.current_state_revision !== input.pre_dispatch.state_revision ||
      input.current_capability_epoch !== input.pre_dispatch.capability_epoch) {
    return finish("quarantine", "authority_advanced_after_decision", null);
  }
  const failed = item.postconditions.some((predicate) =>
    !compare(valueAtPath(input.result, predicate.path), predicate.operator, predicate.value));
  if (failed) return item.effect === "read"
    ? finish("reject", "read_result_failed_postcondition", null)
    : finish("require_reconciliation", "effect_result_failed_postcondition", null);
  const projection = Object.freeze(Object.fromEntries(item.provider_visible_result_fields
    .filter((field) => Object.prototype.hasOwnProperty.call(input.result, field))
    .map((field) => [field, input.result[field]]))) as Readonly<Record<string, Json>>;
  return finish("accept", "accepted", projection);
}
