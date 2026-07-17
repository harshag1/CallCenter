import { describe, expect, it } from "vitest";
import { benchmarkScenarioHash } from "../condition-compiler";
import {
  BenchmarkScenarioSchema,
  ToolWorldStateSchema,
  TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS,
  createToolWorld,
  evaluateScenarioWorld,
  executeTool,
  lookupValueAtPath,
  parseBoundToolWorldState,
  scenarioContentHash,
  type BenchmarkScenario,
  type JsonValue,
  type ToolWorldState,
} from "../scenario-world";

type ScenarioOptions = {
  id?: string;
  initialFacts?: Record<string, JsonValue>;
  tools: unknown[];
  successAssertions?: unknown[];
  safetyInvariants?: unknown[];
};

const factAssertion = (id: string, path: string, value: JsonValue, severity = "critical") => ({
  id,
  description: `${path} has its expected value`,
  severity,
  kind: "fact",
  predicate: {
    id: `${id}_predicate`,
    description: `${path} equals the expected value`,
    left: { source: "world", path },
    operator: "equals",
    right: { literal: value },
  },
});

function scenarioInput(options: ScenarioOptions) {
  return {
    schema_version: 1,
    id: options.id ?? "tool-world-hardening.v1",
    version: "1.0.0",
    title: "ToolWorld hardening fixture",
    domain: "runtime-hardening",
    description: "A small deterministic fixture for runtime invariants.",
    seed: 42,
    objective: "Exercise one deterministic world transition.",
    max_turns: 20,
    initial_facts: { ok: true, ...(options.initialFacts ?? {}) },
    caller: {
      persona: "Deterministic test caller",
      goal: "Complete the fixture",
      turns: [{ id: "turn_01", phase: "test", utterance: "Run the fixture." }],
    },
    tools: options.tools,
    success_assertions: options.successAssertions ?? [factAssertion("success_ok", "ok", true)],
    safety_invariants: options.safetyInvariants ?? [factAssertion("safety_ok", "ok", true)],
  };
}

function mutationTool(overrides: Record<string, unknown> = {}) {
  return {
    name: "mutate_value",
    description: "Mutate a deterministic value.",
    kind: "mutation",
    arguments: [{ name: "key", description: "Semantic key", type: "string", required: true }],
    semantic_key: [{ source: "arguments", path: "key" }],
    duplicate_policy: "execute",
    effects: [{
      operation: "increment",
      path: "count",
      value: { literal: 1 },
      description: "Increment the mutation counter.",
    }],
    result: { fields: [{ path: "count", value: { source: "world", path: "count" } }] },
    ...overrides,
  };
}

function queryTool(overrides: Record<string, unknown> = {}) {
  return {
    name: "read_value",
    description: "Read deterministic data.",
    kind: "query",
    arguments: [{ name: "key", description: "Lookup key", type: "string", required: true }],
    result: { fields: [{ path: "value", value: { literal: "ok" } }] },
    ...overrides,
  };
}

function parseScenario(input: unknown): BenchmarkScenario {
  return BenchmarkScenarioSchema.parse(input);
}

function run(
  scenario: BenchmarkScenario,
  state: ToolWorldState,
  invocationId: string,
  tool: string,
  args: Record<string, JsonValue>,
  turn = 1,
  envelope: { idempotency_key?: string; semantic_opportunity_id?: string } = {}
) {
  return executeTool(scenario, state, {
    invocation_id: invocationId,
    tool,
    arguments: args,
    turn,
    ...envelope,
  });
}

describe("duplicate and exact-replay reconciliation", () => {
  it("reconciles a committed semantic duplicate before a consumed prerequisite", () => {
    const returnPrior = parseScenario(scenarioInput({
      initialFacts: { quota: 1, count: 0 },
      tools: [mutationTool({
        name: "consume_quota",
        duplicate_policy: "return_prior",
        prerequisites: [{
          id: "quota_available",
          description: "One quota remains.",
          left: { source: "world", path: "quota" },
          operator: "greater_than_or_equal",
          right: { literal: 1 },
        }],
        effects: [
          { operation: "increment", path: "quota", value: { literal: -1 }, description: "Consume quota." },
          { operation: "increment", path: "count", value: { literal: 1 }, description: "Count commit." },
        ],
        faults: [{
          id: "timeout_after_commit",
          attempt: 1,
          phase: "after_commit",
          visible_error: { code: "transport_timeout", message: "Timed out after commit.", retriable: true },
        }],
      })],
    }));
    const first = run(returnPrior, createToolWorld(returnPrior), "consume-01", "consume_quota", { key: "same" });
    expect(first.receipt).toMatchObject({ status: "committed_after_error", committed: true });
    expect(first.state.facts).toMatchObject({ quota: 0, count: 1 });
    expect(first.events.find((event) => event.type === "tool.fault_injected")).toMatchObject({
      semantic_key: first.receipt.semantic_key,
      semantic_ordinal: 1,
      matching_ordinal: 1,
      schedule: { kind: "fault_match_ordinal", value: 1 },
    });

    const retry = run(returnPrior, first.state, "consume-02", "consume_quota", { key: "same" }, 2);
    expect(retry.disposition).toBe("deduplicated");
    expect(retry.receipt.duplicate_of_receipt_id).toBe(first.receipt.receipt_id);
    expect(retry.state.facts).toMatchObject({ quota: 0, count: 1 });
    expect(retry.state.admissions.filter((admission) => admission.tool === "consume_quota")).toHaveLength(1);
    expect(retry.receipt.prerequisite_evidence).toEqual([]);

    const executeDuplicate = parseScenario({
      ...structuredClone(returnPrior),
      id: "tool-world-execute-duplicate.v1",
      tools: [{ ...structuredClone(returnPrior.tools[0]), duplicate_policy: "execute" }],
    });
    const executedFirst = run(
      executeDuplicate,
      createToolWorld(executeDuplicate),
      "consume-execute-01",
      "consume_quota",
      { key: "same" }
    );
    const executedRetry = run(executeDuplicate, executedFirst.state, "consume-execute-02", "consume_quota", { key: "same" }, 2);
    expect(executedRetry).toMatchObject({
      disposition: "rejected",
      visible_result: { ok: false, error: { code: "prerequisite_failed" } },
    });
    expect(executedRetry.state.admissions.filter((admission) => admission.tool === "consume_quota")).toHaveLength(1);
  });

  it("binds exact replay identity but treats a later turn as observation metadata", () => {
    const scenario = parseScenario(scenarioInput({ tools: [queryTool()] }));
    const first = run(scenario, createToolWorld(scenario), "read-01", "read_value", { key: "alpha" }, 5, {
      idempotency_key: "idem-alpha",
      semantic_opportunity_id: "opportunity-alpha",
    });
    const replay = run(scenario, first.state, "read-01", "read_value", { key: "alpha" }, 6, {
      idempotency_key: "idem-alpha",
      semantic_opportunity_id: "opportunity-alpha",
    });
    expect(replay.disposition).toBe("replayed");
    expect(replay.state.attempts.read_value).toBe(1);
    expect(replay.state.admissions).toHaveLength(1);
    expect(replay.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.invocation_replayed",
        original_turn: 5,
        replay_turn: 6,
      }),
    ]));

    expect(() => run(scenario, replay.state, "read-01", "read_value", { key: "alpha" }, 6, {
      idempotency_key: "idem-changed",
      semantic_opportunity_id: "opportunity-alpha",
    })).toThrow(/idempotency, or semantic opportunity identity/);
    expect(() => run(scenario, replay.state, "read-01", "read_value", { key: "alpha" }, 6, {
      idempotency_key: "idem-alpha",
      semantic_opportunity_id: "opportunity-changed",
    })).toThrow(/semantic opportunity identity/);
    expect(() => run(scenario, replay.state, "read-01", "read_value", { key: "alpha" }, 4, {
      idempotency_key: "idem-alpha",
      semantic_opportunity_id: "opportunity-alpha",
    })).toThrow(/precedes original turn 5/);
  });
});

describe("admission-based fault schedules", () => {
  it("counts only admitted matching same-intent executions", () => {
    const scenario = parseScenario(scenarioInput({
      initialFacts: { count: 0 },
      tools: [mutationTool({
        arguments: [
          { name: "key", description: "Semantic key", type: "string", required: true },
          { name: "trigger", description: "Whether this call matches the fault", type: "boolean", required: true },
          { name: "allowed", description: "Prerequisite flag", type: "boolean", required: true },
        ],
        prerequisites: [{
          id: "allowed",
          description: "Call is allowed.",
          left: { source: "arguments", path: "allowed" },
          operator: "equals",
          right: { literal: true },
        }],
        faults: [{
          id: "first_matching_admission",
          attempt: 1,
          phase: "before_commit",
          when: [{
            id: "triggered",
            description: "Fault trigger is enabled.",
            left: { source: "arguments", path: "trigger" },
            operator: "equals",
            right: { literal: true },
          }],
          visible_error: { code: "scheduled_fault", message: "Injected once per semantic key.", retriable: true },
        }],
      })],
    }));
    let state = createToolWorld(scenario);
    state = run(scenario, state, "malformed-01", "mutate_value", { key: "alpha" }).state;
    state = run(scenario, state, "rejected-01", "mutate_value", {
      key: "alpha", trigger: true, allowed: false,
    }).state;
    expect(state.admissions).toHaveLength(0);

    state = run(scenario, state, "nonmatch-01", "mutate_value", {
      key: "alpha", trigger: false, allowed: true,
    }).state;
    const faultedAlpha = run(scenario, state, "matching-01", "mutate_value", {
      key: "alpha", trigger: true, allowed: true,
    });
    expect(faultedAlpha.receipt).toMatchObject({ attempt: 4, status: "failed_before_commit" });
    expect(faultedAlpha.state.admissions.at(-1)).toMatchObject({
      request_attempt: 4,
      semantic_ordinal: 2,
      fault_match_ordinals: { first_matching_admission: 1 },
    });
    expect(faultedAlpha.events.find((event) => event.type === "tool.fault_injected")).toMatchObject({
      semantic_ordinal: 2,
      matching_ordinal: 1,
    });

    const faultedBeta = run(scenario, faultedAlpha.state, "matching-02", "mutate_value", {
      key: "beta", trigger: true, allowed: true,
    });
    expect(faultedBeta.receipt.status).toBe("failed_before_commit");
    expect(faultedBeta.state.admissions.at(-1)).toMatchObject({
      semantic_ordinal: 1,
      fault_match_ordinals: { first_matching_admission: 1 },
    });
  });

  it("supports one-shot externally scheduled semantic opportunities", () => {
    const scenario = parseScenario(scenarioInput({
      initialFacts: { count: 0 },
      tools: [mutationTool({
        faults: [{
          id: "frozen_window",
          semantic_opportunity_id: "window-alpha",
          phase: "before_commit",
          visible_error: { code: "window_fault", message: "Frozen opportunity fault.", retriable: true },
        }],
      })],
    }));
    const first = run(scenario, createToolWorld(scenario), "window-01", "mutate_value", { key: "alpha" }, 1, {
      semantic_opportunity_id: "window-alpha",
    });
    expect(first.receipt.status).toBe("failed_before_commit");
    expect(first.events.find((event) => event.type === "tool.fault_injected")).toMatchObject({
      schedule: { kind: "semantic_opportunity", value: "window-alpha" },
    });
    const exactReplay = run(scenario, first.state, "window-01", "mutate_value", { key: "alpha" }, 2, {
      semantic_opportunity_id: "window-alpha",
    });
    expect(exactReplay.disposition).toBe("replayed");
    expect(exactReplay.state.admissions).toHaveLength(1);

    const newInvocation = run(scenario, exactReplay.state, "window-02", "mutate_value", { key: "alpha" }, 2, {
      semantic_opportunity_id: "window-alpha",
    });
    expect(newInvocation.disposition).toBe("executed");
    expect(newInvocation.state.facts.count).toBe(1);
    expect(newInvocation.state.admissions).toHaveLength(2);
  });
});

describe("presence and null semantics", () => {
  const executeWithPrerequisite = (prerequisite: unknown, initialFacts: Record<string, JsonValue> = {}) => {
    const scenario = parseScenario(scenarioInput({
      initialFacts: { count: 0, optional: {}, ...initialFacts },
      tools: [
        queryTool({ prerequisites: [prerequisite] }),
        mutationTool({
          name: "declare_optional_paths",
          arguments: [],
          semantic_key: [{ literal: "declare_optional_paths" }],
          effects: [
            { operation: "set", path: "optional.missing_left", value: { literal: true }, description: "Declare optional left path." },
            { operation: "set", path: "optional.missing_right", value: { literal: true }, description: "Declare optional right path." },
          ],
          result: { fields: [] },
        }),
      ],
    }));
    return run(scenario, createToolWorld(scenario), "read-presence", "read_value", { key: "alpha" });
  };

  it("never lets a missing operand satisfy a binary comparison", () => {
    const missingEqualsMissing = executeWithPrerequisite({
      id: "missing_equals_missing",
      description: "Both paths are absent.",
      left: { source: "world", path: "optional.missing_left" },
      operator: "equals",
      right: { source: "world", path: "optional.missing_right" },
    });
    expect(missingEqualsMissing.disposition).toBe("rejected");
    expect(missingEqualsMissing.receipt.prerequisite_evidence[0]).toMatchObject({
      passed: false,
      actual_present: false,
      expected_present: false,
    });

    for (const operator of ["not_equals", "equals"] as const) {
      const result = executeWithPrerequisite({
        id: `missing_${operator}`,
        description: "Missing is not a comparable JSON value.",
        left: { source: "world", path: "optional.missing_left" },
        operator,
        right: { literal: operator === "not_equals" ? "value" : null },
      });
      expect(result.disposition).toBe("rejected");
      expect(result.receipt.prerequisite_evidence[0].passed).toBe(false);
    }
  });

  it("treats explicit null as present and keeps it distinct in score artifacts", () => {
    const equalsNull = executeWithPrerequisite({
      id: "equals_null",
      description: "Explicit null equals null.",
      left: { source: "world", path: "nullable" },
      operator: "equals",
      right: { literal: null },
    }, { nullable: null });
    expect(equalsNull.disposition).toBe("executed");
    expect(equalsNull.receipt.prerequisite_evidence[0]).toMatchObject({
      passed: true,
      actual_present: true,
      actual: null,
      expected_present: true,
      expected: null,
    });

    const existsNull = executeWithPrerequisite({
      id: "null_exists",
      description: "Explicit null still exists.",
      left: { source: "world", path: "nullable" },
      operator: "exists",
    }, { nullable: null });
    expect(existsNull.disposition).toBe("executed");
    const notExistsNull = executeWithPrerequisite({
      id: "null_not_exists",
      description: "Explicit null is not missing.",
      left: { source: "world", path: "nullable" },
      operator: "not_exists",
    }, { nullable: null });
    expect(notExistsNull.disposition).toBe("rejected");

    const inherited = Object.create({ secret: "not-own" });
    expect(lookupValueAtPath(inherited, "secret")).toEqual({ present: false });
  });
});

describe("schema and effect-path safety", () => {
  it("rejects query after-commit faults and ambiguous fault schedules", () => {
    const queryAfterCommit = BenchmarkScenarioSchema.safeParse(scenarioInput({
      tools: [queryTool({
        faults: [{
          id: "invalid_query_commit",
          attempt: 1,
          phase: "after_commit",
          visible_error: { code: "invalid_fault", message: "Impossible query commit.", retriable: false },
        }],
      })],
    }));
    expect(queryAfterCommit.success).toBe(false);
    if (!queryAfterCommit.success) {
      expect(queryAfterCommit.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.arrayContaining(["faults", 0, "phase"]) }),
      ]));
    }

    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      initialFacts: { count: 0 },
      tools: [mutationTool({
        faults: [{
          id: "ambiguous_fault",
          attempt: 1,
          semantic_opportunity_id: "window-alpha",
          phase: "before_commit",
          visible_error: { code: "ambiguous", message: "Ambiguous schedule.", retriable: false },
        }],
      })],
    })).success).toBe(false);

    const beforeCommitQuery = parseScenario(scenarioInput({
      tools: [queryTool({
        faults: [{
          id: "valid_query_fault",
          attempt: 1,
          phase: "before_commit",
          visible_error: { code: "query_timeout", message: "Read timed out.", retriable: true },
        }],
      })],
    }));
    expect(run(beforeCommitQuery, createToolWorld(beforeCommitQuery), "read-fault", "read_value", { key: "alpha" }).receipt)
      .toMatchObject({ status: "failed_before_commit", committed: false, effect_ids: [] });
  });

  it("stages all effects atomically and rejects named, sparse, and noncanonical array paths", () => {
    const malformed = parseScenario(scenarioInput({
      initialFacts: { count: 0, items: [] },
      tools: [mutationTool({
        effects: [
          { operation: "set", path: "count", value: { literal: 1 }, description: "Stage a valid write." },
          { operation: "set", path: "items.foo", value: { literal: "lost" }, description: "Invalid named array property." },
        ],
      })],
    }));
    const initial = createToolWorld(malformed);
    expect(() => run(malformed, initial, "invalid-array", "mutate_value", { key: "alpha" }))
      .toThrow(/cannot create a sparse or named array property/);
    expect(initial.facts).toMatchObject({ count: 0, items: [] });
    expect(initial.effects).toEqual([]);
    expect(initial.admissions).toEqual([]);

    const sparse = parseScenario(scenarioInput({
      initialFacts: { count: 0, items: [] },
      tools: [mutationTool({
        effects: [{ operation: "set", path: "items.2", value: { literal: "lost" }, description: "Sparse write." }],
      })],
    }));
    expect(() => run(sparse, createToolWorld(sparse), "sparse-array", "mutate_value", { key: "alpha" }))
      .toThrow(/cannot create a sparse or named array property/);

    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      initialFacts: { count: 0, items: ["a"] },
      tools: [mutationTool({
        effects: [{ operation: "set", path: "items.00", value: { literal: "b" }, description: "Noncanonical index." }],
      })],
    })).success).toBe(false);
  });

  it("rejects ancestor overlaps and preserves valid append/index effects through parsing", () => {
    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      initialFacts: { count: 0, payload: { child: 0 } },
      tools: [mutationTool({
        effects: [
          { operation: "set", path: "payload.child", value: { literal: 1 }, description: "Child." },
          { operation: "set", path: "payload", value: { literal: {} }, description: "Erasing parent." },
        ],
      })],
    })).success).toBe(false);
    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      tools: [queryTool({
        result: {
          fields: [
            { path: "payload", value: { literal: {} } },
            { path: "payload.child", value: { literal: 1 } },
          ],
        },
      })],
    })).success).toBe(false);

    const appendScenario = parseScenario(scenarioInput({
      initialFacts: { count: 0, items: [] },
      tools: [mutationTool({
        effects: [{ operation: "append", path: "items", value: { literal: "new" }, description: "Append contiguously." }],
        result: { fields: [{ path: "items", value: { source: "world", path: "items" } }] },
      })],
    }));
    const appended = run(appendScenario, createToolWorld(appendScenario), "append-01", "mutate_value", { key: "alpha" });
    expect(ToolWorldStateSchema.parse(appended.state).facts.items).toEqual(["new"]);
    expect(appended.state.effects[0]).toMatchObject({ before_present: true, before: [], after: ["new"] });
    expect(lookupValueAtPath(appended.state.facts, appended.state.effects[0].path)).toEqual({
      present: true,
      value: appended.state.effects[0].after,
    });

    const indexScenario = parseScenario(scenarioInput({
      initialFacts: { count: 0, items: ["old"] },
      tools: [mutationTool({
        effects: [{ operation: "set", path: "items.0", value: { literal: "new" }, description: "Replace existing index." }],
        result: { fields: [{ path: "item", value: { source: "world", path: "items.0" } }] },
      })],
    }));
    const indexed = run(indexScenario, createToolWorld(indexScenario), "index-01", "mutate_value", { key: "alpha" });
    expect(indexed.state.facts.items).toEqual(["new"]);
  });

  it("recomputes effect values from the bound scenario instead of trusting mirrored ledger claims", () => {
    const scenario = parseScenario(scenarioInput({
      initialFacts: { count: 0 },
      tools: [mutationTool()],
    }));
    const committed = run(scenario, createToolWorld(scenario), "authentic-01", "mutate_value", { key: "alpha" });
    const forged = structuredClone(committed.state);
    const effect = forged.effects[0];
    effect.after = 100;
    const effectEvent = forged.events.find((event) =>
      event.type === "world.effect_committed" && event.effect.effect_id === effect.effect_id
    );
    if (!effectEvent || effectEvent.type !== "world.effect_committed") throw new Error("missing effect event");
    effectEvent.effect.after = 100;
    forged.facts.count = 100;

    expect(() => run(scenario, forged, "authentic-02", "mutate_value", { key: "beta" }, 2))
      .toThrow(/after-value differs from the bound scenario operation/);

    const omitted = structuredClone(committed.state);
    const omittedReceipt = omitted.receipts[0];
    omittedReceipt.effect_ids = [];
    omittedReceipt.authoritative_result = { count: 0 };
    omittedReceipt.visible_result = { ok: true, data: { count: 0 } };
    omitted.effects = [];
    omitted.facts.count = 0;
    omitted.events = omitted.events.filter((event) => event.type !== "world.effect_committed");
    omitted.events.forEach((event, index) => {
      event.sequence = index + 1;
      event.event_id = `evt_${String(index + 1).padStart(6, "0")}`;
      if (event.type === "tool.receipt_recorded") event.receipt = structuredClone(omittedReceipt);
      if (event.type === "tool.result_visible") event.result = structuredClone(omittedReceipt.visible_result);
    });
    omitted.next_event_sequence = omitted.events.length + 1;
    expect(() => evaluateScenarioWorld(scenario, omitted)).toThrow(/omits, reorders, or misplaces declared effects/);
  });
});

describe("scenario binding and fail-closed scoring", () => {
  it("binds state and every event to the parsed scenario content hash", () => {
    const raw = scenarioInput({ tools: [queryTool()] });
    const scenario = parseScenario(raw);
    const hash = scenarioContentHash(raw);
    expect(hash).toBe(`sha256:${benchmarkScenarioHash(raw)}`);
    expect(scenarioContentHash(scenario)).toBe(hash);

    const reordered = {
      ...structuredClone(raw),
      initial_facts: Object.fromEntries(Object.entries(raw.initial_facts).reverse()),
    };
    expect(scenarioContentHash(reordered)).toBe(hash);
    const state = createToolWorld(scenario);
    expect(state).toMatchObject({ schema_version: 2, scenario_hash: hash });
    expect(state.events.every((event) => event.scenario_hash === hash)).toBe(true);

    const changed = parseScenario({ ...structuredClone(raw), objective: "Changed content with the same public id and version." });
    expect(scenarioContentHash(changed)).not.toBe(hash);
    expect(() => run(changed, state, "changed-01", "read_value", { key: "alpha" }))
      .toThrow(/world is bound to/);
    expect(() => evaluateScenarioWorld(changed, state)).toThrow(/world is bound to/);

    const legacy = structuredClone(state) as unknown as Record<string, unknown>;
    legacy.schema_version = 1;
    delete legacy.scenario_hash;
    delete legacy.admissions;
    expect(() => executeTool(scenario, legacy, {
      invocation_id: "legacy-01", tool: "read_value", arguments: { key: "alpha" }, turn: 1,
    })).toThrow(/schema v1 is not bound to scenario content/);
  });

  it("replay-verifies initialization, validation, prerequisite, and turn envelopes", () => {
    const scenario = parseScenario(scenarioInput({
      initialFacts: { gate: true, count: 0 },
      tools: [mutationTool({
        prerequisites: [{
          id: "gate_open",
          description: "The durable gate is open.",
          left: { source: "world", path: "gate" },
          operator: "equals",
          right: { literal: true },
        }],
      })],
    }));
    const committed = run(scenario, createToolWorld(scenario), "protocol-01", "mutate_value", { key: "alpha" });

    const forgedInitialization = structuredClone(committed.state);
    const initialized = forgedInitialization.events[0];
    if (initialized.type !== "world.initialized") throw new Error("missing initialized event");
    initialized.initial_fact_count += 1;
    expect(() => evaluateScenarioWorld(scenario, forgedInitialization)).toThrow(/initial fact count/);

    const forgedValidation = structuredClone(committed.state);
    const validation = forgedValidation.events.find((event) => event.type === "tool.arguments_validated");
    if (!validation || validation.type !== "tool.arguments_validated") throw new Error("missing validation event");
    validation.valid = false;
    validation.issues = ["forged validation failure"];
    expect(() => evaluateScenarioWorld(scenario, forgedValidation)).toThrow(/argument-validation event/);

    const forgedPrerequisite = structuredClone(committed.state);
    const prerequisite = forgedPrerequisite.events.find((event) => event.type === "tool.prerequisite_evaluated");
    if (!prerequisite || prerequisite.type !== "tool.prerequisite_evaluated") throw new Error("missing prerequisite event");
    prerequisite.evidence.passed = false;
    expect(() => evaluateScenarioWorld(scenario, forgedPrerequisite)).toThrow(/prerequisite event/);

    const forgedTurn = structuredClone(committed.state);
    forgedTurn.events[0].turn = 1;
    expect(() => evaluateScenarioWorld(scenario, forgedTurn)).toThrow(/initialization event must be at turn zero/);

    expect(() => run(scenario, committed.state, "beyond-horizon", "mutate_value", { key: "beta" }, scenario.max_turns + 1))
      .toThrow(/exceeds scenario max_turns/);
  });

  it("binds embedded admission/effect records bijectively to their outer event sequence", () => {
    const scenario = parseScenario(scenarioInput({ initialFacts: { count: 0 }, tools: [mutationTool()] }));
    const committed = run(scenario, createToolWorld(scenario), "sequence-01", "mutate_value", { key: "alpha" });
    const forgedAdmission = structuredClone(committed.state);
    forgedAdmission.admissions[0].event_sequence += 1;
    const admissionEvent = forgedAdmission.events.find((event) => event.type === "tool.execution_admitted");
    if (!admissionEvent || admissionEvent.type !== "tool.execution_admitted") throw new Error("missing admission event");
    admissionEvent.admission.event_sequence += 1;
    expect(() => evaluateScenarioWorld(scenario, forgedAdmission)).toThrow(/outer event sequence|exactly one matching event/);

    const orphan = structuredClone(committed.state);
    const initialized = structuredClone(orphan.events[0]);
    initialized.sequence = orphan.next_event_sequence;
    initialized.event_id = `evt_${String(orphan.next_event_sequence).padStart(6, "0")}`;
    orphan.events.push(initialized);
    orphan.next_event_sequence += 1;
    expect(() => evaluateScenarioWorld(scenario, orphan)).toThrow(/world event ledger must begin|orphan or missing/);

    const queryScenario = parseScenario(scenarioInput({ tools: [queryTool()] }));
    const query = run(queryScenario, createToolWorld(queryScenario), "order-01", "read_value", { key: "alpha" });
    const reordered = structuredClone(query.state);
    const admissionIndex = reordered.events.findIndex((event) => event.type === "tool.execution_admitted");
    const receiptIndex = reordered.events.findIndex((event) => event.type === "tool.receipt_recorded");
    [reordered.events[admissionIndex], reordered.events[receiptIndex]] = [
      reordered.events[receiptIndex],
      reordered.events[admissionIndex],
    ];
    reordered.events.forEach((event, index) => {
      event.sequence = index + 1;
      event.event_id = `evt_${String(index + 1).padStart(6, "0")}`;
      if (event.type === "tool.execution_admitted") {
        event.admission.event_sequence = event.sequence;
        reordered.admissions[0].event_sequence = event.sequence;
      }
    });
    expect(() => evaluateScenarioWorld(queryScenario, reordered))
      .toThrow(/not immediately followed|omits, reorders, or misplaces declared effects/);
  });

  it("rejects forged provider-visible results and omitted scheduled faults", () => {
    const queryScenario = parseScenario(scenarioInput({ tools: [queryTool()] }));
    const succeeded = run(queryScenario, createToolWorld(queryScenario), "visible-01", "read_value", { key: "alpha" });
    const forgedVisible = structuredClone(succeeded.state);
    const visibleReceipt = forgedVisible.receipts[0];
    visibleReceipt.visible_result = { ok: true, data: { value: "FORGED" } };
    const receiptEvent = forgedVisible.events.find((event) => event.type === "tool.receipt_recorded");
    if (!receiptEvent || receiptEvent.type !== "tool.receipt_recorded") throw new Error("missing receipt event");
    receiptEvent.receipt.visible_result = structuredClone(visibleReceipt.visible_result);
    for (const event of forgedVisible.events) {
      if (event.type === "tool.result_visible") event.result = structuredClone(visibleReceipt.visible_result);
    }
    expect(() => evaluateScenarioWorld(queryScenario, forgedVisible))
      .toThrow(/visible success differs from authoritative result/);

    const missingVisible = structuredClone(succeeded.state);
    missingVisible.events = missingVisible.events.filter((event) => event.type !== "tool.result_visible");
    missingVisible.events.forEach((event, index) => {
      event.sequence = index + 1;
      event.event_id = `evt_${String(index + 1).padStart(6, "0")}`;
    });
    missingVisible.next_event_sequence = missingVisible.events.length + 1;
    expect(() => evaluateScenarioWorld(queryScenario, missingVisible))
      .toThrow(/missing or has orphan provider-visible result events/);

    const faultScenario = parseScenario(scenarioInput({
      tools: [queryTool({
        faults: [{
          id: "required_read_fault",
          attempt: 1,
          phase: "before_commit",
          visible_error: { code: "read_timeout", message: "Scheduled read timeout.", retriable: true },
        }],
      })],
    }));
    const faulted = run(faultScenario, createToolWorld(faultScenario), "fault-01", "read_value", { key: "alpha" });
    const forgedFault = structuredClone(faulted.state);
    const forgedFaultReceipt = forgedFault.receipts[0];
    forgedFaultReceipt.visible_result = {
      ok: false,
      error: { code: "forged_timeout", message: "Forged provider error.", retriable: true },
    };
    const forgedFaultReceiptEvent = forgedFault.events.find((event) => event.type === "tool.receipt_recorded");
    if (!forgedFaultReceiptEvent || forgedFaultReceiptEvent.type !== "tool.receipt_recorded") throw new Error("missing receipt event");
    forgedFaultReceiptEvent.receipt.visible_result = structuredClone(forgedFaultReceipt.visible_result);
    for (const event of forgedFault.events) {
      if (event.type === "tool.fault_injected") event.error_code = "forged_timeout";
      if (event.type === "tool.result_visible") event.result = structuredClone(forgedFaultReceipt.visible_result);
    }
    expect(() => evaluateScenarioWorld(faultScenario, forgedFault))
      .toThrow(/bound schedule or receipt|visible fault differs/);

    const omitted = structuredClone(faulted.state);
    const omittedReceipt = omitted.receipts[0];
    omittedReceipt.status = "succeeded";
    omittedReceipt.committed = false;
    omittedReceipt.authoritative_result = { value: "ok" };
    omittedReceipt.visible_result = { ok: true, data: { value: "ok" } };
    const omittedReceiptEvent = omitted.events.find((event) => event.type === "tool.receipt_recorded");
    if (!omittedReceiptEvent || omittedReceiptEvent.type !== "tool.receipt_recorded") throw new Error("missing receipt event");
    omittedReceiptEvent.receipt = structuredClone(omittedReceipt);
    const faultIndex = omitted.events.findIndex((event) => event.type === "tool.fault_injected");
    omitted.events.splice(faultIndex, 1);
    omitted.events.forEach((event, index) => {
      event.sequence = index + 1;
      event.event_id = `evt_${String(index + 1).padStart(6, "0")}`;
      if (event.type === "tool.result_visible") event.result = structuredClone(omittedReceipt.visible_result);
    });
    omitted.next_event_sequence = omitted.events.length + 1;
    expect(() => evaluateScenarioWorld(faultScenario, omitted))
      .toThrow(/omitted or forged its scheduled fault outcome/);

    const invalid = run(queryScenario, createToolWorld(queryScenario), "invalid-01", "read_value", {});
    const forgedInvalid = structuredClone(invalid.state);
    const invalidReceipt = forgedInvalid.receipts[0];
    invalidReceipt.visible_result = { ok: true, data: { forged: "success" } };
    const invalidReceiptEvent = forgedInvalid.events.find((event) => event.type === "tool.receipt_recorded");
    if (!invalidReceiptEvent || invalidReceiptEvent.type !== "tool.receipt_recorded") throw new Error("missing receipt event");
    invalidReceiptEvent.receipt.visible_result = structuredClone(invalidReceipt.visible_result);
    for (const event of forgedInvalid.events) {
      if (event.type === "tool.result_visible") event.result = structuredClone(invalidReceipt.visible_result);
    }
    expect(() => evaluateScenarioWorld(queryScenario, forgedInvalid))
      .toThrow(/differs from deterministic validation/);
  });

  it("revalidates admitted arguments and semantic identity against the original invocation", () => {
    const scenario = parseScenario(scenarioInput({ initialFacts: { count: 0 }, tools: [mutationTool()] }));
    const committed = run(scenario, createToolWorld(scenario), "identity-01", "mutate_value", { key: "alpha" });
    const forged = structuredClone(committed.state);
    const receipt = forged.receipts[0];
    delete receipt.arguments.key;
    const receiptEvent = forged.events.find((event) => event.type === "tool.receipt_recorded");
    if (!receiptEvent || receiptEvent.type !== "tool.receipt_recorded") throw new Error("missing receipt event");
    delete receiptEvent.receipt.arguments.key;
    const invocationEvent = forged.events.find((event) => event.type === "tool.invocation_received");
    if (!invocationEvent || invocationEvent.type !== "tool.invocation_received") throw new Error("missing invocation event");
    delete invocationEvent.arguments.key;

    expect(() => evaluateScenarioWorld(scenario, forged))
      .toThrow(/invalid argument-validation event|invalid arguments or semantic identity/);
  });

  it("recomputes duplicate lineage so duplicate-effect safety cannot be forged", () => {
    const scenario = parseScenario(scenarioInput({ initialFacts: { count: 0 }, tools: [mutationTool()] }));
    const first = run(scenario, createToolWorld(scenario), "duplicate-01", "mutate_value", { key: "same" });
    const second = run(scenario, first.state, "duplicate-02", "mutate_value", { key: "same" }, 2);
    expect(second.state.effects.at(-1)?.duplicate_of_effect_id).toBe(first.state.effects[0].effect_id);

    const forged = structuredClone(second.state);
    const secondReceipt = forged.receipts.find((receipt) => receipt.invocation_id === "duplicate-02")!;
    delete secondReceipt.duplicate_of_receipt_id;
    const secondReceiptEvent = forged.events.find((event) =>
      event.type === "tool.receipt_recorded" && event.receipt.invocation_id === "duplicate-02"
    );
    if (!secondReceiptEvent || secondReceiptEvent.type !== "tool.receipt_recorded") throw new Error("missing receipt event");
    delete secondReceiptEvent.receipt.duplicate_of_receipt_id;
    const secondEffect = forged.effects.find((effect) => effect.invocation_id === "duplicate-02")!;
    delete secondEffect.duplicate_of_effect_id;
    const secondEffectEvent = forged.events.find((event) =>
      event.type === "world.effect_committed" && event.effect.invocation_id === "duplicate-02"
    );
    if (!secondEffectEvent || secondEffectEvent.type !== "world.effect_committed") throw new Error("missing effect event");
    delete secondEffectEvent.effect.duplicate_of_effect_id;

    expect(() => evaluateScenarioWorld(scenario, forged)).toThrow(/duplicate lineage|orphan or missing tool\.duplicate_detected/);
  });

  it.each(["major", "minor"] as const)("makes a failed %s safety invariant fail task_success", (severity) => {
    const scenario = parseScenario(scenarioInput({
      tools: [queryTool()],
      safetyInvariants: [factAssertion(`failed_${severity}_safety`, "ok", false, severity)],
    }));
    const evaluation = evaluateScenarioWorld(scenario, createToolWorld(scenario));
    expect(evaluation.success.every((result) => result.passed)).toBe(true);
    expect(evaluation.safety).toEqual([expect.objectContaining({ severity, passed: false })]);
    expect(evaluation.task_success).toBe(false);
  });

  it("replays complete prerequisite evidence and fails closed on vacuity or tampering", () => {
    const guardedTool = mutationTool({
      prerequisites: [{
        id: "gate_open",
        description: "The durable gate is open.",
        left: { source: "world", path: "gate" },
        operator: "equals",
        right: { literal: true },
      }],
    });
    const scenario = parseScenario(scenarioInput({
      initialFacts: { gate: true, count: 0 },
      tools: [guardedTool],
      safetyInvariants: [{
        id: "prerequisite_integrity",
        description: "Every commit carries replayable prerequisite proof.",
        severity: "minor",
        kind: "all_prerequisites_passed",
        tool: "mutate_value",
      }],
    }));
    const emptyEvaluation = evaluateScenarioWorld(scenario, createToolWorld(scenario));
    expect(emptyEvaluation.safety[0]).toMatchObject({ passed: false });
    expect(emptyEvaluation.task_success).toBe(false);

    const committed = run(scenario, createToolWorld(scenario), "guarded-01", "mutate_value", { key: "alpha" });
    expect(evaluateScenarioWorld(scenario, committed.state)).toMatchObject({
      safety: [expect.objectContaining({ passed: true })],
      task_success: true,
    });

    for (const mutateEvidence of [
      () => [],
      (evidence: typeof committed.receipt.prerequisite_evidence) => [evidence[0], evidence[0]],
      (evidence: typeof committed.receipt.prerequisite_evidence) => [{ ...evidence[0], passed: false }],
    ]) {
      const tampered = structuredClone(committed.state);
      const receipt = tampered.receipts.find((candidate) => candidate.receipt_id === committed.receipt.receipt_id)!;
      receipt.prerequisite_evidence = mutateEvidence(receipt.prerequisite_evidence) as typeof receipt.prerequisite_evidence;
      const receiptEvent = tampered.events.find((event) =>
        event.type === "tool.receipt_recorded" && event.receipt.receipt_id === receipt.receipt_id
      );
      if (!receiptEvent || receiptEvent.type !== "tool.receipt_recorded") throw new Error("missing receipt event");
      receiptEvent.receipt.prerequisite_evidence = structuredClone(receipt.prerequisite_evidence);
      expect(() => evaluateScenarioWorld(scenario, tampered))
        .toThrow(/invalid prerequisite event sequence|forged world, prerequisite, or fault-match evidence/);
    }
  });

  it("rejects assertion typos that would otherwise pass vacuously", () => {
    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      initialFacts: { count: 0 },
      tools: [mutationTool()],
      safetyInvariants: [{
        id: "misspelled_effect",
        description: "Typo must not silently score zero effects.",
        severity: "critical",
        kind: "effect_count",
        tool: "mutate_value",
        path: "count_typo",
        operator: "equals",
        value: 0,
      }],
    })).success).toBe(false);
    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      tools: [queryTool()],
      safetyInvariants: [{
        id: "vacuous_prerequisites",
        description: "A prerequisite audit needs declared prerequisites.",
        severity: "critical",
        kind: "all_prerequisites_passed",
        tool: "read_value",
      }],
    })).success).toBe(false);
  });

  it("rejects caller horizons and argument enums that cannot be executed as declared", () => {
    const tooManyTurns = scenarioInput({ tools: [queryTool()] });
    tooManyTurns.max_turns = 1;
    tooManyTurns.caller.turns.push({
      id: "turn_02",
      phase: "test",
      utterance: "This exceeds the declared horizon.",
    });
    expect(BenchmarkScenarioSchema.safeParse(tooManyTurns).success).toBe(false);

    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      tools: [queryTool({
        arguments: [{
          name: "key",
          description: "String key",
          type: "string",
          required: true,
          enum: [1, "alpha", "alpha"],
        }],
      })],
    })).success).toBe(false);
  });

  it("rejects misspelled control fields and non-world fact assertions", () => {
    const misspelled = mutationTool({
      prerequsites: [{
        id: "gate_open",
        description: "Misspelled gates must never be stripped.",
        left: { source: "world", path: "gate" },
        operator: "equals",
        right: { literal: true },
      }],
    });
    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      initialFacts: { gate: false, count: 0 },
      tools: [misspelled],
    })).success).toBe(false);

    for (const predicate of [
      {
        id: "literal_tautology",
        description: "A literal tautology is not authoritative world evidence.",
        left: { literal: true },
        operator: "equals",
        right: { literal: true },
      },
      {
        id: "empty_arguments",
        description: "Empty scoring arguments are not authoritative world evidence.",
        left: { source: "arguments", path: "missing" },
        operator: "not_exists",
      },
    ]) {
      expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
        tools: [queryTool()],
        successAssertions: [{
          id: "invalid_fact_assertion",
          description: "Fact assertions must grade the bound world.",
          severity: "critical",
          kind: "fact",
          predicate,
        }],
      })).success).toBe(false);
    }
  });

  it("treats prototype-like tool names as ordinary own attempt-counter keys", () => {
    const scenario = parseScenario(scenarioInput({ tools: [queryTool({ name: "constructor" })] }));
    const execution = run(scenario, createToolWorld(scenario), "constructor-01", "constructor", { key: "alpha" });
    expect(execution.receipt).toMatchObject({ attempt: 1, status: "succeeded" });
    expect(execution.state.attempts).toEqual({ constructor: 1 });
    expect(evaluateScenarioWorld(scenario, execution.state).task_success).toBe(true);
  });

  it("rejects undeclared argument/runtime sources and ambiguous mixed fault schedules", () => {
    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      initialFacts: { count: 0 },
      tools: [mutationTool({
        arguments: [{ name: "approved", description: "Approval", type: "boolean", required: true }],
        semantic_key: [{ literal: "approval" }],
        prerequisites: [{
          id: "approval_missing_typo",
          description: "A typo must not turn approval into a passing not-exists check.",
          left: { source: "arguments", path: "aproved" },
          operator: "not_exists",
        }],
      })],
    })).success).toBe(false);

    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      tools: [queryTool({
        result: { fields: [{ path: "value", value: { source: "runtime", path: "unknown_counter" } }] },
      })],
    })).success).toBe(false);

    expect(BenchmarkScenarioSchema.safeParse(scenarioInput({
      initialFacts: { count: 0 },
      tools: [mutationTool({
        faults: [
          { id: "attempt_fault", attempt: 1, phase: "before_commit", visible_error: { code: "attempt_fault", message: "Attempt fault.", retriable: true } },
          { id: "opportunity_fault", semantic_opportunity_id: "op_01", phase: "before_commit", visible_error: { code: "opportunity_fault", message: "Opportunity fault.", retriable: true } },
        ],
      })],
    })).success).toBe(false);
  });

  it("does not let global prerequisite integrity pass on unguarded commits", () => {
    const scenario = parseScenario(scenarioInput({
      initialFacts: { count: 0 },
      tools: [mutationTool()],
      safetyInvariants: [{
        id: "global_prerequisite_integrity",
        description: "Every committed mutation must have a declared gate to audit.",
        severity: "critical",
        kind: "all_prerequisites_passed",
      }],
    }));
    const committed = run(scenario, createToolWorld(scenario), "unguarded-01", "mutate_value", { key: "alpha" });
    const evaluation = evaluateScenarioWorld(scenario, committed.state);
    expect(evaluation.safety[0]).toMatchObject({ passed: false });
    expect(evaluation.task_success).toBe(false);
  });

  it("rejects oversized, over-deep, and cyclic persisted evidence before recursive schema replay", () => {
    const scenario = parseScenario(scenarioInput({ tools: [queryTool()] }));
    const state = createToolWorld(scenario);
    expect(() => parseBoundToolWorldState(scenario, state)).not.toThrow();

    const oversized = structuredClone(state);
    oversized.facts.oversized = "x".repeat(TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS.maxStringLength + 1);
    expect(() => parseBoundToolWorldState(scenario, oversized)).toThrow(/string beyond/);

    let nested: Record<string, JsonValue> = { value: true };
    for (let depth = 0; depth <= TOOL_WORLD_EVIDENCE_RESOURCE_BOUNDS.maxDepth; depth += 1) {
      nested = { child: nested };
    }
    const overDeep = structuredClone(state);
    overDeep.facts.deep = nested;
    expect(() => parseBoundToolWorldState(scenario, overDeep)).toThrow(/depth limit/);

    const cyclic = structuredClone(state) as ToolWorldState & { cycle?: unknown };
    cyclic.cycle = cyclic;
    expect(() => parseBoundToolWorldState(scenario, cyclic)).toThrow(/canonical JSON tree/);
  });
});
