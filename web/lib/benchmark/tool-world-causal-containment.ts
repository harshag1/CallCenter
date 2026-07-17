import { BenchmarkScenarioSchema, type BenchmarkScenario, type JsonValue } from "./scenario-schema";
import {
  ToolWorldStateSchema,
  createToolWorld,
  executeTool,
  parseBoundToolWorldState,
  scenarioContentHash,
  type ToolExecutionDisposition,
  type ToolWorldState,
} from "./tool-world";
import { canonicalJson, sha256Hex } from "./artifacts";

const BENCHMARK_VERSION = "tool-world-causal-containment.v1" as const;
const HASH_DOMAIN = "harshas-amazing-call-center/tool-world-causal-containment/v1\n";
const DEFAULT_SEED_START = 7_301;
const DEFAULT_SEEDS_PER_CASE = 32;

export const TOOL_WORLD_CAUSAL_CASES = Object.freeze([
  "replayed_delivery",
  "after_commit_retry",
  "reconnect_redelivery",
  "stale_snapshot_resume",
  "reordered_commit_ledger",
] as const);

export type ToolWorldCausalCase = typeof TOOL_WORLD_CAUSAL_CASES[number];

const SCENARIO: BenchmarkScenario = BenchmarkScenarioSchema.parse({
  schema_version: 1,
  id: "tool-world-causal-containment.v1",
  version: "1.0.0",
  title: "ToolWorld causal containment fixture",
  domain: "causal-containment",
  description: "A deterministic at-least-once delivery and persisted-ledger integrity fixture.",
  seed: DEFAULT_SEED_START,
  objective: "Commit each semantic credit exactly once and reject causally inconsistent persisted state.",
  max_turns: 20,
  initial_facts: {
    account_status: "open",
    credited_total: 0,
  },
  caller: {
    persona: "Deterministic offline transport scheduler",
    goal: "Exercise credit delivery and recovery schedules.",
    turns: [{
      id: "turn_01",
      phase: "test",
      utterance: "Apply the scheduled credit exactly once.",
    }],
  },
  tools: [{
    name: "apply_credit",
    description: "Apply one semantically keyed credit.",
    kind: "mutation",
    arguments: [
      { name: "op_id", description: "Stable semantic operation id.", type: "string", required: true },
      { name: "amount", description: "Positive deterministic credit amount.", type: "number", required: true, minimum: 1, maximum: 9 },
      { name: "inject_timeout", description: "Inject the fixed development-protocol post-commit timeout.", type: "boolean", required: true },
    ],
    prerequisites: [{
      id: "account_open",
      description: "Credits can commit only while the account is open.",
      left: { source: "world", path: "account_status" },
      operator: "equals",
      right: { literal: "open" },
    }],
    semantic_key: [{ source: "arguments", path: "op_id" }],
    duplicate_policy: "return_prior",
    effects: [{
      operation: "increment",
      path: "credited_total",
      value: { source: "arguments", path: "amount" },
      description: "Apply the credit to authoritative state.",
    }],
    result: {
      fields: [{ path: "credited_total", value: { source: "world", path: "credited_total" } }],
    },
    faults: [{
      id: "timeout_after_commit",
      attempt: 1,
      phase: "after_commit",
      when: [{
        id: "timeout_requested",
        description: "The deterministic schedule requests a post-commit timeout.",
        left: { source: "arguments", path: "inject_timeout" },
        operator: "equals",
        right: { literal: true },
      }],
      visible_error: {
        code: "transport_timeout",
        message: "The transport timed out after the authoritative commit.",
        retriable: true,
      },
    }],
  }],
  success_assertions: [{
    id: "credit_total_nonnegative",
    description: "The credit total remains non-negative.",
    severity: "critical",
    kind: "fact",
    predicate: {
      id: "credit_total_nonnegative_predicate",
      description: "The credit total is at least zero.",
      left: { source: "world", path: "credited_total" },
      operator: "greater_than_or_equal",
      right: { literal: 0 },
    },
  }],
  safety_invariants: [{
    id: "committed_prerequisites_hold",
    description: "Every committed credit carries recomputable prerequisite evidence.",
    severity: "critical",
    kind: "all_prerequisites_passed",
    tool: "apply_credit",
    minimum_committed_receipts: 1,
  }],
});

export const TOOL_WORLD_CAUSAL_PROTOCOL = Object.freeze({
  status: "fixed deterministic development design; outcomes observed; not a prospective preregistration",
  seed_start: DEFAULT_SEED_START,
  seeds_per_case: DEFAULT_SEEDS_PER_CASE,
  cases: TOOL_WORLD_CAUSAL_CASES,
  exclusions: "none; any thrown trial aborts artifact generation",
  invariants: Object.freeze([
    "one semantic mutation produces exactly one authoritative effect",
    "an exact invocation replay does not produce a second authoritative effect",
    "a distinct-invocation retry after a post-commit timeout reconciles to the prior committed receipt",
    "a reconnect round-trip preserves exact replay identity",
    "a stale fact snapshot grafted onto a newer ledger is rejected before execution",
    "a reordered event ledger is rejected before execution",
    "after rejecting corrupt persisted state, execution from the last canonical state reaches the oracle total",
  ]),
  success_rule: "all fixed invariants hold in every full-harness trial; the naive schema-only comparator accepts or executes the unsafe schedule",
  interval: "two-sided Wilson score interval at 95%; descriptive over these deterministic schedules only",
});

type HarnessOutcome =
  | "exact_replay_suppressed"
  | "semantic_retry_deduplicated"
  | "corrupt_resume_rejected_then_safe_recovery";

type CausalTrial = Readonly<{
  seed: number;
  case: ToolWorldCausalCase;
  schedule_hash: string;
  oracle_total: number;
  naive_comparator_total: number;
  harness_total: number;
  naive_comparator_unsafe_accept: boolean;
  harness_contained: boolean;
  harness_rejected_corruption: boolean;
  harness_outcome: HarnessOutcome;
  harness_effect_count: number;
}>;

type WilsonInterval = Readonly<{ lower: number; upper: number }>;

type CaseSummary = Readonly<{
  attempted: number;
  naive_comparator_unsafe_accept_count: number;
  naive_comparator_unsafe_accept_rate: number;
  naive_comparator_unsafe_accept_wilson_95: WilsonInterval;
  harness_contained_count: number;
  harness_containment_rate: number;
  harness_containment_wilson_95: WilsonInterval;
  harness_corrupt_state_rejection_count: number;
  harness_idempotent_suppression_count: number;
  schedule_set_hash: string;
}>;

export type ToolWorldCausalContainmentReport = Readonly<{
  schema_version: 1;
  benchmark_version: typeof BENCHMARK_VERSION;
  scenario_hash: string;
  seed_start: number;
  seeds_per_case: number;
  trial_count: number;
  design_status: "fixed-development-design" | "exploratory-variant";
  provider_calls: 0;
  endpoints: Readonly<{
    naive_schema_only: "schema-only persisted-state acceptance plus at-least-once mutation execution";
    full_harness: "ToolWorld v2 scenario-bound replay verification and idempotent execution";
  }>;
  protocol: typeof TOOL_WORLD_CAUSAL_PROTOCOL;
  aggregate: CaseSummary;
  cases: Readonly<Record<ToolWorldCausalCase, CaseSummary>>;
  trial_set_hash: string;
  claim_scope: string;
  result_hash: string;
}>;

function prng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function cloneState(state: ToolWorldState): ToolWorldState {
  return structuredClone(state);
}

function creditTotal(state: ToolWorldState): number {
  const total = state.facts.credited_total;
  if (typeof total !== "number") throw new Error("credited_total is not numeric");
  return total;
}

function invocation(seed: number, suffix: string, amount: number, injectTimeout: boolean, turn: number) {
  return {
    invocation_id: `inv-${seed}-${suffix}`,
    tool: "apply_credit",
    arguments: {
      op_id: `op-${seed}-${suffix.replace(/[^a-z0-9.-]/g, "-")}`,
      amount,
      inject_timeout: injectTimeout,
    } satisfies Record<string, JsonValue>,
    turn,
  };
}

function execute(state: ToolWorldState, call: ReturnType<typeof invocation>) {
  return executeTool(SCENARIO, state, call);
}

function scheduleHash(value: unknown): string {
  return sha256Hex(`${HASH_DOMAIN}schedule\n${canonicalJson(value)}`);
}

function naiveShapeAccepts(value: unknown): boolean {
  return ToolWorldStateSchema.safeParse(value).success;
}

/** Deliberately naive comparator: every delivered mutation is applied, with no receipt or replay memory. */
function naiveAtLeastOnce(initialTotal: number, deliveredAmounts: readonly number[]): number {
  return deliveredAmounts.reduce((total, amount) => total + amount, initialTotal);
}

function strictRejects(value: unknown): boolean {
  try {
    parseBoundToolWorldState(SCENARIO, value);
    return false;
  } catch {
    return true;
  }
}

function requireDisposition(actual: ToolExecutionDisposition, expected: ToolExecutionDisposition): void {
  if (actual !== expected) throw new Error(`expected ${expected} disposition, received ${actual}`);
}

function runReplayedDelivery(seed: number, amount: number, turnGap: number): CausalTrial {
  const call = invocation(seed, "replay", amount, false, 1);
  const first = execute(createToolWorld(SCENARIO), call);
  const replay = execute(first.state, { ...call, turn: 1 + turnGap });
  requireDisposition(replay.disposition, "replayed");
  const oracleTotal = amount;
  const naiveTotal = naiveAtLeastOnce(0, [amount, amount]);
  const harnessTotal = creditTotal(replay.state);
  return Object.freeze({
    seed,
    case: "replayed_delivery",
    schedule_hash: scheduleHash({ call, replay_turn: 1 + turnGap }),
    oracle_total: oracleTotal,
    naive_comparator_total: naiveTotal,
    harness_total: harnessTotal,
    naive_comparator_unsafe_accept: naiveTotal !== oracleTotal,
    harness_contained: harnessTotal === oracleTotal && replay.state.effects.length === 1,
    harness_rejected_corruption: false,
    harness_outcome: "exact_replay_suppressed",
    harness_effect_count: replay.state.effects.length,
  });
}

function runAfterCommitRetry(seed: number, amount: number, turnGap: number): CausalTrial {
  const firstCall = invocation(seed, "timeout", amount, true, 1);
  const first = execute(createToolWorld(SCENARIO), firstCall);
  if (first.receipt.status !== "committed_after_error") {
    throw new Error(`expected committed_after_error, received ${first.receipt.status}`);
  }
  const retryCall = {
    ...invocation(seed, "timeout-retry", amount, false, 1 + turnGap),
    arguments: { ...firstCall.arguments, inject_timeout: false },
  };
  const retry = execute(first.state, retryCall);
  requireDisposition(retry.disposition, "deduplicated");
  const oracleTotal = amount;
  const naiveTotal = naiveAtLeastOnce(0, [amount, amount]);
  const harnessTotal = creditTotal(retry.state);
  return Object.freeze({
    seed,
    case: "after_commit_retry",
    schedule_hash: scheduleHash({ first: firstCall, retry: retryCall }),
    oracle_total: oracleTotal,
    naive_comparator_total: naiveTotal,
    harness_total: harnessTotal,
    naive_comparator_unsafe_accept: naiveTotal !== oracleTotal,
    harness_contained: harnessTotal === oracleTotal && retry.state.effects.length === 1,
    harness_rejected_corruption: false,
    harness_outcome: "semantic_retry_deduplicated",
    harness_effect_count: retry.state.effects.length,
  });
}

function runReconnectRedelivery(seed: number, amount: number, turnGap: number): CausalTrial {
  const call = invocation(seed, "reconnect", amount, false, 1);
  const first = execute(createToolWorld(SCENARIO), call);
  const resumed = parseBoundToolWorldState(SCENARIO, JSON.parse(JSON.stringify(first.state)));
  const replay = execute(resumed, { ...call, turn: 1 + turnGap });
  requireDisposition(replay.disposition, "replayed");
  const oracleTotal = amount;
  const naiveTotal = naiveAtLeastOnce(0, [amount, amount]);
  const harnessTotal = creditTotal(replay.state);
  return Object.freeze({
    seed,
    case: "reconnect_redelivery",
    schedule_hash: scheduleHash({ call, reconnect: "json-round-trip", replay_turn: 1 + turnGap }),
    oracle_total: oracleTotal,
    naive_comparator_total: naiveTotal,
    harness_total: harnessTotal,
    naive_comparator_unsafe_accept: naiveTotal !== oracleTotal,
    harness_contained: harnessTotal === oracleTotal && replay.state.effects.length === 1,
    harness_rejected_corruption: false,
    harness_outcome: "exact_replay_suppressed",
    harness_effect_count: replay.state.effects.length,
  });
}

function runStaleSnapshotResume(seed: number, amounts: readonly [number, number, number]): CausalTrial {
  const [amountA, amountB, amountC] = amounts;
  const callA = invocation(seed, "stale-a", amountA, false, 1);
  const callB = invocation(seed, "stale-b", amountB, false, 2);
  const callC = invocation(seed, "stale-c", amountC, false, 3);
  const afterA = execute(createToolWorld(SCENARIO), callA).state;
  const staleFacts = structuredClone(afterA.facts);
  const current = execute(afterA, callB).state;
  const corrupt = cloneState(current);
  corrupt.facts = staleFacts;
  const naiveAccepts = naiveShapeAccepts(corrupt);
  const rejected = strictRejects(corrupt);
  const recovered = execute(current, callC).state;
  const oracleTotal = amountA + amountB + amountC;
  const staleTotal = corrupt.facts.credited_total;
  if (typeof staleTotal !== "number") throw new Error("corrupt stale fixture lost its numeric total");
  const naiveTotal = naiveAtLeastOnce(staleTotal, [amountC]);
  const harnessTotal = creditTotal(recovered);
  return Object.freeze({
    seed,
    case: "stale_snapshot_resume",
    schedule_hash: scheduleHash({ calls: [callA, callB, callC], graft: "facts-after-a-onto-ledger-after-b" }),
    oracle_total: oracleTotal,
    naive_comparator_total: naiveTotal,
    harness_total: harnessTotal,
    naive_comparator_unsafe_accept: naiveAccepts && naiveTotal !== oracleTotal,
    harness_contained: rejected && harnessTotal === oracleTotal && recovered.effects.length === 3,
    harness_rejected_corruption: rejected,
    harness_outcome: "corrupt_resume_rejected_then_safe_recovery",
    harness_effect_count: recovered.effects.length,
  });
}

function runReorderedCommitLedger(seed: number, amounts: readonly [number, number], reorderIndex: number): CausalTrial {
  const [amountA, amountB] = amounts;
  const callA = invocation(seed, "order-a", amountA, false, 1);
  const callB = invocation(seed, "order-b", amountB, false, 2);
  const canonical = execute(createToolWorld(SCENARIO), callA).state;
  const corrupt = cloneState(canonical);
  const rightIndex = reorderIndex + 1;
  [corrupt.events[reorderIndex], corrupt.events[rightIndex]] = [
    corrupt.events[rightIndex],
    corrupt.events[reorderIndex],
  ];
  const naiveAccepts = naiveShapeAccepts(corrupt);
  const rejected = strictRejects(corrupt);
  const recovered = execute(canonical, callB).state;
  const oracleTotal = amountA + amountB;
  const naiveTotal = naiveAtLeastOnce(creditTotal(corrupt), [amountB]);
  const harnessTotal = creditTotal(recovered);
  return Object.freeze({
    seed,
    case: "reordered_commit_ledger",
    schedule_hash: scheduleHash({ calls: [callA, callB], swapped_event_indices: [reorderIndex, rightIndex] }),
    oracle_total: oracleTotal,
    naive_comparator_total: naiveTotal,
    harness_total: harnessTotal,
    naive_comparator_unsafe_accept: naiveAccepts,
    harness_contained: rejected && harnessTotal === oracleTotal && recovered.effects.length === 2,
    harness_rejected_corruption: rejected,
    harness_outcome: "corrupt_resume_rejected_then_safe_recovery",
    harness_effect_count: recovered.effects.length,
  });
}

function runSeed(seed: number): readonly CausalTrial[] {
  const next = prng(seed);
  const amount = () => 1 + Math.floor(next() * 9);
  const turnGap = 1 + Math.floor(next() * 5);
  const eventsInOneSuccessfulMutation = 8;
  const reorderIndex = 1 + Math.floor(next() * (eventsInOneSuccessfulMutation - 2));
  return Object.freeze([
    runReplayedDelivery(seed, amount(), turnGap),
    runAfterCommitRetry(seed, amount(), turnGap),
    runReconnectRedelivery(seed, amount(), turnGap),
    runStaleSnapshotResume(seed, [amount(), amount(), amount()]),
    runReorderedCommitLedger(seed, [amount(), amount()], reorderIndex),
  ]);
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function wilson(successes: number, trials: number): WilsonInterval {
  if (trials === 0) return Object.freeze({ lower: 0, upper: 0 });
  const z = 1.959963984540054;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials) / denominator;
  return Object.freeze({ lower: rounded(Math.max(0, center - radius)), upper: rounded(Math.min(1, center + radius)) });
}

function summarize(trials: readonly CausalTrial[]): CaseSummary {
  const attempted = trials.length;
  const naiveUnsafe = trials.filter((trial) => trial.naive_comparator_unsafe_accept).length;
  const contained = trials.filter((trial) => trial.harness_contained).length;
  return Object.freeze({
    attempted,
    naive_comparator_unsafe_accept_count: naiveUnsafe,
    naive_comparator_unsafe_accept_rate: rounded(naiveUnsafe / attempted),
    naive_comparator_unsafe_accept_wilson_95: wilson(naiveUnsafe, attempted),
    harness_contained_count: contained,
    harness_containment_rate: rounded(contained / attempted),
    harness_containment_wilson_95: wilson(contained, attempted),
    harness_corrupt_state_rejection_count: trials.filter((trial) => trial.harness_rejected_corruption).length,
    harness_idempotent_suppression_count: trials.filter((trial) =>
      trial.harness_outcome === "exact_replay_suppressed"
      || trial.harness_outcome === "semantic_retry_deduplicated"
    ).length,
    schedule_set_hash: sha256Hex(`${HASH_DOMAIN}trial-set\n${canonicalJson(trials)}`),
  });
}

export function runToolWorldCausalContainment(input: {
  seed_start?: number;
  seeds_per_case?: number;
} = {}): ToolWorldCausalContainmentReport {
  const seedStart = input.seed_start ?? DEFAULT_SEED_START;
  const seedsPerCase = input.seeds_per_case ?? DEFAULT_SEEDS_PER_CASE;
  if (!Number.isSafeInteger(seedStart) || seedStart < 0) throw new Error("seed_start must be a non-negative safe integer");
  if (!Number.isSafeInteger(seedsPerCase) || seedsPerCase < 1 || seedsPerCase > 1_000) {
    throw new Error("seeds_per_case must be an integer in 1..1000");
  }
  if (seedStart + seedsPerCase - 1 > 0xffff_ffff) {
    throw new Error("seed range must fit in an unsigned 32-bit integer");
  }

  const trials: CausalTrial[] = [];
  for (let offset = 0; offset < seedsPerCase; offset += 1) {
    trials.push(...runSeed(seedStart + offset));
  }
  const byCase = Object.fromEntries(TOOL_WORLD_CAUSAL_CASES.map((caseName) => [
    caseName,
    summarize(trials.filter((trial) => trial.case === caseName)),
  ])) as Record<ToolWorldCausalCase, CaseSummary>;

  const body = Object.freeze({
    schema_version: 1 as const,
    benchmark_version: BENCHMARK_VERSION,
    scenario_hash: scenarioContentHash(SCENARIO),
    seed_start: seedStart,
    seeds_per_case: seedsPerCase,
    trial_count: trials.length,
    design_status: seedStart === DEFAULT_SEED_START && seedsPerCase === DEFAULT_SEEDS_PER_CASE
      ? "fixed-development-design" as const
      : "exploratory-variant" as const,
    provider_calls: 0 as const,
    endpoints: Object.freeze({
      naive_schema_only: "schema-only persisted-state acceptance plus at-least-once mutation execution" as const,
      full_harness: "ToolWorld v2 scenario-bound replay verification and idempotent execution" as const,
    }),
    protocol: TOOL_WORLD_CAUSAL_PROTOCOL,
    aggregate: summarize(trials),
    cases: Object.freeze(byCase),
    trial_set_hash: sha256Hex(`${HASH_DOMAIN}all-trials\n${canonicalJson(trials)}`),
    claim_scope: "Deterministic offline causal-failure containment in a synthetic ToolWorld fixture; not realtime-model quality, provider behavior, speech quality, or population inference.",
  });
  return Object.freeze({
    ...body,
    result_hash: sha256Hex(`${HASH_DOMAIN}report\n${canonicalJson(body)}`),
  });
}
