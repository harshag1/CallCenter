import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../../artifacts";
import {
  FilesystemDualEnvelopeBudget,
  TestOnlyEvidenceTap,
  TestOnlyInMemoryDualBudgetAdmission,
  callerPlanSha256,
  compileCondition,
  providerAcknowledgementSha256,
  runTestOnlyHaccProof,
  runHaccProof,
  signSchedule,
  verifySignedSchedule,
  type CallerScheduler,
  type CompiledCondition,
  type FrozenEvaluator,
  type OneShotProviderSession,
  type ProviderAcknowledgement,
  type ProviderConformanceAdapter,
  type ProviderIdentity,
  type ProviderRunResult,
  type ScheduleBody,
  type ScheduledUnit,
} from "..";

const hash = (value: string) => sha256Hex(value);
const identity: ProviderIdentity = Object.freeze({
  provider: "fake",
  model: "voice-model-pinned",
  voice: "voice-pinned",
  settings_sha256: hash("settings"),
});
const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function actionsFor(pair: string, unitId: string) {
  return Object.freeze([Object.freeze({
    action_id: `action-${unitId}`,
    at_ms: 0,
    kind: "audio" as const,
    payload_sha256: hash(`audio-${pair}`),
  })]);
}

function unit(input: Readonly<{
  id: string;
  pair: string;
  position: 1 | 2;
  arm: "native" | "hacc";
  phase: "testing" | "benchmark";
}>): ScheduledUnit {
  return Object.freeze({
    unit_id: input.id,
    pair_id: input.pair,
    pair_position: input.position,
    phase: input.phase,
    arm: input.arm,
    identity,
    scenario_sha256: hash(`scenario-${input.pair}`),
    // action_id is pair-stable so the Native and HACC arms receive an exactly
    // identical caller plan rather than merely equivalent audio bytes.
    caller_plan_sha256: callerPlanSha256(actionsFor(input.pair, input.pair)),
    tools_sha256: hash("tools"),
    substantive_context_sha256: hash("context"),
    maximum_micro_usd: 1_000_000,
  });
}

function body(): ScheduleBody {
  return Object.freeze({
    schema_version: 1,
    protocol: "HACC-Proof-v1",
    study_id: "proof-study-fixture",
    created_at: "2026-08-02T12:00:00.000Z",
    source_commit: "a".repeat(40),
    units: Object.freeze([
      unit({ id: "test-a", pair: "test-pair", position: 1, arm: "native", phase: "testing" }),
      unit({ id: "test-b", pair: "test-pair", position: 2, arm: "hacc", phase: "testing" }),
      unit({ id: "bench-b", pair: "bench-pair", position: 1, arm: "hacc", phase: "benchmark" }),
      unit({ id: "bench-a", pair: "bench-pair", position: 2, arm: "native", phase: "benchmark" }),
    ]),
  });
}

class FakeAdapter implements ProviderConformanceAdapter {
  readonly provider = "fake";
  readonly opened: string[] = [];
  preflightIdentity: ProviderIdentity = identity;
  readonly #results: Map<string, ProviderRunResult | Error>;

  constructor(results: Readonly<Record<string, ProviderRunResult | Error>> = {}) {
    this.#results = new Map(Object.entries(results));
  }

  async preflight(): Promise<ProviderAcknowledgement> {
    const body = {
      identity: this.preflightIdentity,
      conformance_version: "HACC-Proof-Provider-v1" as const,
      supports_one_shot_sessions: true as const,
    };
    return { ...body, acknowledgement_sha256: providerAcknowledgementSha256(body) };
  }

  async open(condition: CompiledCondition): Promise<OneShotProviderSession> {
    this.opened.push(condition.unit_id);
    const configured = this.#results.get(condition.unit_id);
    if (configured instanceof Error) throw configured;
    const result = configured ?? { disposition: "completed", estimated_micro_usd: 100_000 };
    return {
      session_id: `session-${condition.unit_id}`,
      async run(actions, observe) {
        observe({
          event_type: "audio.output",
          observed_at: "2026-08-02T12:00:01.000Z",
          payload: { action_count: actions.length },
        });
        return result;
      },
      async close() {},
    };
  }
}

const caller: CallerScheduler = {
  compile(scheduled) {
    const actions = actionsFor(scheduled.pair_id, scheduled.pair_id);
    return {
      caller_plan_sha256: callerPlanSha256(actions),
      actions,
    };
  },
};

function evaluator(probe?: { calls: number }): FrozenEvaluator {
  return {
    async evaluate(input) {
      if (probe) probe.calls += 1;
      expect(input.raw_evidence_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(input.raw_events.at(-1)).toMatchObject({ event_type: "itt.finalized" });
      expect(input.itt_ledger).toHaveLength(body().units.length);
      return { schema_version: 1, evaluator_id: "frozen-fake-v1", scores: { strict_success: 1 } };
    },
  };
}

describe("HACC-Proof-v1 fail-closed runner", () => {
  it("compiles the pair into registered Native and Full HACC while preserving every parity field", () => {
    const native = compileCondition(body().units[0]!);
    const hacc = compileCondition(body().units[1]!);
    expect(native.treatment).toEqual({
      mode: "registered_native",
      response_plan: false,
      progressive_capabilities: false,
      durable_authority: false,
      effect_receipts: false,
      async_workers: false,
    });
    expect(hacc.treatment).toEqual({
      mode: "full_hacc",
      response_plan: true,
      progressive_capabilities: true,
      durable_authority: true,
      effect_receipts: true,
      async_workers: true,
    });
    expect({ ...native, arm: undefined, unit_id: undefined, treatment: undefined, condition_sha256: undefined })
      .toEqual({ ...hacc, arm: undefined, unit_id: undefined, treatment: undefined, condition_sha256: undefined });
  });

  it("executes a signed AB/BA plan exactly once and evaluates only its finalized raw evidence", async () => {
    const adapter = new FakeAdapter();
    const probe = { calls: 0 };
    const result = await runTestOnlyHaccProof({
      schedule: signSchedule(body(), privateKeyPem),
      providers: [adapter],
      caller,
      evaluator: evaluator(probe),
      now: () => new Date("2026-08-02T12:00:02.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.gates).toEqual({
      schedule_verified: true,
      budget_admission: "passed",
      provider_conformance: "passed",
      testing: "passed",
      benchmark: "passed",
      raw_finalized_before_evaluation: true,
    });
    expect(adapter.opened).toEqual(["test-a", "test-b", "bench-b", "bench-a"]);
    expect(result.terminal_ledger.every((entry) => entry.opening_count === 1 && entry.disposition === "completed")).toBe(true);
    expect(result.budget.testing_settled_micro_usd).toBe(200_000);
    expect(result.budget.benchmark_settled_micro_usd).toBe(200_000);
    expect(probe.calls).toBe(1);
  });

  it("rejects schedule tampering and invalid AB/BA ordering before provider contact", async () => {
    const signed = signSchedule(body(), privateKeyPem);
    const tampered = {
      ...signed,
      body: { ...signed.body, study_id: "tampered" },
    };
    expect(() => verifySignedSchedule(tampered)).toThrow("schedule body hash mismatch");

    const invalid: ScheduleBody = {
      ...body(),
      units: body().units.map((entry, index) => index === 2 ? { ...entry, arm: "native" } : entry),
    };
    expect(() => signSchedule(invalid, privateKeyPem)).toThrow(/parity|AB\/BA/u);
  });

  it("stops the entire ITT population after one failed testing unit without retry or replacement", async () => {
    const adapter = new FakeAdapter({
      "test-a": { disposition: "failed", estimated_micro_usd: 250_000, reason: "synthetic failure" },
    });
    const result = await runTestOnlyHaccProof({
      schedule: signSchedule(body(), privateKeyPem),
      providers: [adapter],
      caller,
      evaluator: evaluator(),
    });

    expect(result.status).toBe("stopped");
    expect(adapter.opened).toEqual(["test-a"]);
    expect(result.gates.testing).toBe("failed");
    expect(result.gates.benchmark).toBe("not_opened");
    expect(result.terminal_ledger).toHaveLength(4);
    expect(result.terminal_ledger[0]).toMatchObject({ opening_count: 1, disposition: "failed" });
    expect(result.terminal_ledger.slice(1).every((entry) => entry.opening_count === 0
      && entry.disposition === "not_opened_gate_stopped")).toBe(true);
  });

  it("fails before opening when provider acknowledgement drifts from the pinned identity", async () => {
    const adapter = new FakeAdapter();
    adapter.preflightIdentity = { ...identity, model: "unregistered-model" };
    const result = await runTestOnlyHaccProof({
      schedule: signSchedule(body(), privateKeyPem),
      providers: [adapter],
      caller,
      evaluator: evaluator(),
    });

    expect(result.gates.provider_conformance).toBe("failed");
    expect(adapter.opened).toEqual([]);
    expect(result.terminal_ledger.every((entry) => entry.disposition === "not_opened_gate_stopped")).toBe(true);
  });

  it("fails dual-budget admission before provider preflight or opening", async () => {
    const adapter = new FakeAdapter();
    const result = await runTestOnlyHaccProof({
      schedule: signSchedule(body(), privateKeyPem),
      providers: [adapter],
      caller,
      evaluator: evaluator(),
      budget: new TestOnlyInMemoryDualBudgetAdmission({
        testing_micro_usd: 1_999_999,
        benchmark_micro_usd: 100_000_000,
      }),
    });

    expect(result.gates.budget_admission).toBe("failed");
    expect(result.gates.provider_conformance).toBe("not_run");
    expect(adapter.opened).toEqual([]);
  });

  it("permanently quarantines an ambiguous opening attempt", async () => {
    const adapter = new FakeAdapter({ "test-a": new Error("connection outcome unknown") });
    const result = await runTestOnlyHaccProof({
      schedule: signSchedule(body(), privateKeyPem),
      providers: [adapter],
      caller,
      evaluator: evaluator(),
    });

    expect(adapter.opened).toEqual(["test-a"]);
    expect(result.terminal_ledger[0]).toMatchObject({
      opening_count: 1,
      session_id: "unacknowledged:test-a",
      disposition: "ambiguous",
      estimated_micro_usd: 1_000_000,
    });
    expect(result.terminal_ledger.slice(1).every((entry) => entry.opening_count === 0)).toBe(true);
  });

  it("does not open a provider when the scheduler substitutes caller actions", async () => {
    const adapter = new FakeAdapter();
    const substitutedCaller: CallerScheduler = {
      compile(scheduled) {
        return {
          caller_plan_sha256: scheduled.caller_plan_sha256,
          actions: [{ action_id: "substitution", at_ms: 0, kind: "audio", payload_sha256: hash("wrong") }],
        };
      },
    };
    const result = await runTestOnlyHaccProof({
      schedule: signSchedule(body(), privateKeyPem),
      providers: [adapter],
      caller: substitutedCaller,
      evaluator: evaluator(),
    });
    expect(adapter.opened).toEqual([]);
    expect(result.stop_reason).toContain("caller plan mismatch");
    expect(result.terminal_ledger.every((entry) => entry.opening_count === 0)).toBe(true);
  });
});

describe("EvidenceTap custody", () => {
  it("forbids evaluation before raw finalization and all raw mutation afterward", () => {
    const tap = new TestOnlyEvidenceTap();
    expect(() => tap.recordEvaluation({ score: 1 })).toThrow("before raw finalization");
    tap.append("fixture", "2026-08-02T12:00:00.000Z", { value: true });
    tap.finalizeRaw();
    expect(() => tap.append("late", "2026-08-02T12:00:01.000Z", {})).toThrow("already finalized");
    tap.recordEvaluation({ score: 1 });
    expect(() => tap.recordEvaluation({ score: 2 })).toThrow("only be recorded once");
  });
});

describe("paid authority boundary", () => {
  it("rejects benchmark-local budget and evidence authorities before provider contact", async () => {
    const adapter = new FakeAdapter();
    const fakeInput = {
      schedule: signSchedule(body(), privateKeyPem),
      budget: new TestOnlyInMemoryDualBudgetAdmission({
        testing_micro_usd: 100_000_000,
        benchmark_micro_usd: 100_000_000,
      }),
      evidence: { authority_kind: "benchmark_fake" },
      providers: [adapter],
      caller,
    } as unknown as Parameters<typeof runHaccProof>[0];
    await expect(runHaccProof(fakeInput)).rejects.toThrow("production filesystem dual-envelope");
    expect(adapter.opened).toEqual([]);

    const fakeEvidenceInput = {
      ...fakeInput,
      budget: new FilesystemDualEnvelopeBudget({
        ledgerPath: "/definitely/not/opened/child.json",
        standingAggregateLedgerPath: "/definitely/not/opened/aggregate.json",
      }),
    } as unknown as Parameters<typeof runHaccProof>[0];
    await expect(runHaccProof(fakeEvidenceInput)).rejects.toThrow("production EvidenceTapV2");
    expect(adapter.opened).toEqual([]);
  });
});
