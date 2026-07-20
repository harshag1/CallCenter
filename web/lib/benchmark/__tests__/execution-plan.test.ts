import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BenchmarkFreezeLockSchema,
  BenchmarkPlanError,
  benchmarkFreezeLockSha256,
  benchmarkPairInvariantsSha256,
  benchmarkRunnerConfigSha256,
  createBenchmarkExecutionPlan,
  parseCanonicalBenchmarkExecutionPlan,
  parseCanonicalBenchmarkFreezeLock,
  serializeBenchmarkExecutionPlan,
  serializeBenchmarkFreezeLock,
  verifyExecutionPlanAgainstFreeze,
  type BenchmarkExecutionPlanBody,
  type BenchmarkFreezeLock,
} from "../execution-plan";
import { benchmarkKernelAttestationPublicKeyFingerprint } from "../kernel-attestation";

const H = (character: string) => character.repeat(64);
const COMMIT = "1".repeat(40);
const ATTESTATION_KEYS = generateKeyPairSync("ed25519");
const ATTESTATION_PUBLIC_KEY_PEM = ATTESTATION_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const ATTESTATION_PIN = Object.freeze({
  algorithm: "ed25519" as const,
  key_id: "kernel-attestation-test-v1",
  public_key_pem: ATTESTATION_PUBLIC_KEY_PEM,
  public_key_fingerprint_sha256: benchmarkKernelAttestationPublicKeyFingerprint(ATTESTATION_PUBLIC_KEY_PEM),
});

function freeze(overrides: Partial<BenchmarkFreezeLock> = {}): BenchmarkFreezeLock {
  return BenchmarkFreezeLockSchema.parse({
    schema_version: 1,
    protocol_id: "HACC-LHVR-v0.1",
    evidence_class: "canary",
    created_at: "2026-07-10T12:00:00.000Z",
    source_commit: COMMIT,
    source_tree: "2".repeat(40),
    dependency_lock_sha256: H("a"),
    protocol_sha256: H("b"),
    preregistration_sha256: H("c"),
    condition_compiler_sha256: H("d"),
    gateway_sha256: H("e"),
    evaluator_sha256: H("f"),
    artifact_schema_sha256: H("0"),
    audio_delivery_profile_sha256: H("1"),
    scenario_source_registry_sha256: H("2"),
    fixture_manifest_sha256: H("3"),
    caller_sequence_sha256: H("4"),
    randomization_sha256: H("5"),
    kernel_attestation: ATTESTATION_PIN,
    bundle: [{ path: "benchmarks/voice-long-horizon/PROTOCOL.md", sha256: H("6") }],
    provider_pins: [{
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      adapter_sha256: H("7"),
      session_settings_sha256: H("8"),
      pricing_snapshot_sha256: H("9"),
      pricing_formula_sha256: H("f"),
      provider_hard_session_caps_sha256: H("e"),
    }],
    registration: { status: "exploratory" },
    ...overrides,
  });
}

function body(lock: BenchmarkFreezeLock, overrides: Partial<BenchmarkExecutionPlanBody> = {}): BenchmarkExecutionPlanBody {
  const limits = {
    maxTurns: 24,
    maxSessionMs: 600_000,
    maxInputAudioBytes: 10_000_000,
    maxOutputAudioBytes: 20_000_000,
    maxToolCalls: 64,
    sessionReadyTimeoutMs: 15_000,
    responseTimeoutMs: 30_000,
  };
  const audioDelivery = {
    schemaVersion: 1 as const,
    chunkMs: 20,
    pace: "realtime" as const,
    profile_sha256: H("1"),
  };
  const base: BenchmarkExecutionPlanBody = {
    schema_version: 1,
    plan_id: "canary-openai-full-harness-001",
    mode: "canary",
    created_at: "2026-07-10T12:05:00.000Z",
    expires_at: "2026-07-11T12:05:00.000Z",
    freeze_lock_sha256: benchmarkFreezeLockSha256(lock),
    source_commit: COMMIT,
    release_gate: {
      pre_canary_packet_sha256: H("a"),
      provider_pricing_proof_sha256: H("b"),
      provider_hard_session_caps_sha256: H("e"),
      pricing_snapshot_sha256: H("9"),
      pricing_formula_sha256: H("f"),
      reservation_micro_usd: 5_000_000,
      conservative_liability_micro_usd: 4_900_000,
    },
    scenario: {
      path: "benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json",
      id: "industrial-field-service.v1",
      version: "1.0.0",
      canonical_sha256: H("a"),
      registry_key: `industrial-field-service.v1@1.0.0#sha256:${H("a")}`,
      registry_entry_sha256: H("1"),
      registry_catalog_sha256: H("2"),
    },
    fixture: {
      manifest_sha256: H("3"),
      caller_sequence_sha256: H("4"),
      rendition: "pcm16le_mono_24000",
    },
    cell: {
      run_id: "run-openai-full-harness-001",
      reservation_id: "reservation-openai-full-harness-001",
      pair_id: "pair-openai-001",
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      condition: "full-harness",
    },
    pair_invariants_sha256: H("8"),
    study_plan_sha256: lock.randomization_sha256,
    condition_hash: H("b"),
    prompt_hash: H("c"),
    provider_tools_hash: H("d"),
    kernel_attestation: ATTESTATION_PIN,
    session_continuity: {
      schema_version: 1,
      application_reconnect: "disabled",
      provider_native_resumption: "disabled",
    },
    long_horizon_authorization: null,
    limits,
    audio_delivery: audioDelivery,
    cost_envelope: {
      schema_version: 1,
      kind: "hacc_provider_gate1_cost_envelope",
      pricing_snapshot_sha256: H("9"),
      provider_hard_session_caps_sha256: H("e"),
      runner_config_sha256: benchmarkRunnerConfigSha256({
        limits,
        audio_delivery: audioDelivery,
      }),
      formula_sha256: H("f"),
      components: [{ name: "pessimistic-charge", upper_bound_micro_usd: 4_900_000 }],
      safety_margin_micro_usd: 100_000,
    },
    maximum_micro_usd: 5_000_000,
    reservation_expires_at: "2026-07-10T12:20:00.000Z",
    ledger_id: "hacc-public-benchmark-budget",
    reservation_authority: {
      ledger_open_head_sha256: H("7"),
      consumption_id: "plan-consumption-test",
    },
    output_root: "benchmarks/voice-long-horizon/results",
    artifact_schema_sha256: H("0"),
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    pair_invariants_sha256: overrides.pair_invariants_sha256
      ?? benchmarkPairInvariantsSha256(merged),
  };
}

describe("benchmark freeze lock and paid execution plan", () => {
  it("round-trips one canonical object and binds the full plan body hash", () => {
    const lock = freeze();
    const plan = createBenchmarkExecutionPlan(body(lock));
    const encoded = serializeBenchmarkExecutionPlan(plan);
    expect(parseCanonicalBenchmarkExecutionPlan(encoded)).toEqual(plan);
    expect(plan.plan_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parseCanonicalBenchmarkFreezeLock(serializeBenchmarkFreezeLock(lock))).toEqual(lock);
    expect(() => verifyExecutionPlanAgainstFreeze({
      plan,
      freeze: lock,
      now: new Date("2026-07-10T12:06:00.000Z"),
    })).not.toThrow();
  });

  it("pins reconnect and provider-native resumption as disabled pair invariants", () => {
    const lock = freeze();
    const primary = body(lock);
    const exploratoryContinuity = {
      schema_version: 1,
      application_reconnect: "disabled",
      provider_native_resumption: "enabled",
    };
    expect(benchmarkPairInvariantsSha256({
      ...primary,
      session_continuity: exploratoryContinuity,
    })).not.toBe(primary.pair_invariants_sha256);
    expect(() => createBenchmarkExecutionPlan({
      ...primary,
      session_continuity: exploratoryContinuity,
    } as never)).toThrow(/Invalid input/);
  });

  it("rejects duplicate/noncanonical JSON before schema or hash checks", () => {
    const lock = freeze();
    const plan = createBenchmarkExecutionPlan(body(lock));
    const encoded = serializeBenchmarkExecutionPlan(plan);
    expect(() => parseCanonicalBenchmarkExecutionPlan(` ${encoded}`)).toThrow(BenchmarkPlanError);
    expect(() => parseCanonicalBenchmarkExecutionPlan(encoded.replace(
      '"schema_version":1',
      '"schema_version":1,"schema_version":1'
    ))).toThrowError(/duplicate keys|noncanonical/);
  });

  it("rejects content tampering even when the JSON remains canonical", () => {
    const lock = freeze();
    const plan = createBenchmarkExecutionPlan(body(lock));
    const value = JSON.parse(serializeBenchmarkExecutionPlan(plan));
    value.maximum_micro_usd = 600_000;
    const tampered = `${JSON.stringify(value, Object.keys(value).sort())}\n`;
    expect(() => parseCanonicalBenchmarkExecutionPlan(tampered)).toThrow();
  });

  it("rejects fixture, pricing, source, and provider-pin substitution", () => {
    const lock = freeze();
    const plan = createBenchmarkExecutionPlan(body(lock));
    const wrongFixture = freeze({ fixture_manifest_sha256: H("f") });
    expect(() => verifyExecutionPlanAgainstFreeze({ plan, freeze: wrongFixture })).toThrowError(/does not bind|fixture/);
  });

  it("keeps provider caps and runner configuration as separate fail-closed commitments", () => {
    const lock = freeze();
    const baseline = body(lock);
    expect(() => createBenchmarkExecutionPlan({
      ...baseline,
      limits: { ...baseline.limits, maxToolCalls: baseline.limits.maxToolCalls + 1 },
    })).toThrowError(/runner configuration hash/);

    const wrongCapsLock = freeze({
      provider_pins: [{
        ...lock.provider_pins[0],
        provider_hard_session_caps_sha256: H("d"),
      }],
    });
    const plan = createBenchmarkExecutionPlan(body(wrongCapsLock));
    expect(() => verifyExecutionPlanAgainstFreeze({
      plan,
      freeze: wrongCapsLock,
    })).toThrowError(/hard-session caps/);
  });

  it("freezes the attestation trust root and rejects incompatible key IDs", () => {
    const wrongLock = freeze({
      kernel_attestation: { ...ATTESTATION_PIN, key_id: "different-kernel-key" },
    });
    const plan = createBenchmarkExecutionPlan(body(wrongLock, {
      kernel_attestation: ATTESTATION_PIN,
    }));
    expect(() => verifyExecutionPlanAgainstFreeze({
      plan,
      freeze: wrongLock,
    })).toThrowError(/trust root/);
    expect(() => createBenchmarkExecutionPlan(body(freeze(), {
      kernel_attestation: { ...ATTESTATION_PIN, key_id: "invalid/key" },
    }))).toThrowError(/unsupported characters/);
  });

  it("separates cell execution hashes from the shared study and pair identities", () => {
    const lock = freeze();
    const baseline = createBenchmarkExecutionPlan(body(lock, {
      cell: {
        ...body(lock).cell,
        run_id: "run-openai-raw-001",
        reservation_id: "reservation-openai-raw-001",
        condition: "raw-full",
      },
      condition_hash: H("1"),
      prompt_hash: H("2"),
      provider_tools_hash: H("3"),
    }));
    const treatment = createBenchmarkExecutionPlan(body(lock, {
      cell: {
        ...body(lock).cell,
        run_id: "run-openai-harness-001",
        reservation_id: "reservation-openai-harness-001",
        condition: "full-harness",
      },
      condition_hash: H("4"),
      prompt_hash: H("5"),
      provider_tools_hash: H("6"),
    }));
    expect(baseline.plan_sha256).not.toBe(treatment.plan_sha256);
    expect(baseline.pair_invariants_sha256).toBe(treatment.pair_invariants_sha256);
    expect(baseline.study_plan_sha256).toBe(lock.randomization_sha256);
    expect(treatment.study_plan_sha256).toBe(lock.randomization_sha256);

    expect(() => createBenchmarkExecutionPlan(body(lock, {
      pair_invariants_sha256: H("0"),
    }))).toThrowError(/pair invariants hash/);
    expect(() => createBenchmarkExecutionPlan(body(lock, {
      study_plan_sha256: H("0"),
    }))).not.toThrow();
    const wrongStudy = createBenchmarkExecutionPlan(body(lock, { study_plan_sha256: H("0") }));
    expect(() => verifyExecutionPlanAgainstFreeze({ plan: wrongStudy, freeze: lock })).toThrowError(/study-plan hash/);
  });

  it("categorically blocks an exploratory confirmatory lock and mutable latest models", () => {
    expect(() => freeze({ evidence_class: "confirmatory" })).toThrowError(/confirmatory freeze/);
    expect(() => freeze({
      provider_pins: [{
        provider: "openai",
        model: "gpt-realtime-latest",
        voice: "marin",
        adapter_sha256: H("7"),
        session_settings_sha256: H("8"),
        pricing_snapshot_sha256: H("9"),
        pricing_formula_sha256: H("f"),
        provider_hard_session_caps_sha256: H("e"),
      }],
    })).toThrowError(/mutable latest aliases/);
  });

  it("rejects expired plans and caller-declared maxima below their envelope", () => {
    const lock = freeze();
    const plan = createBenchmarkExecutionPlan(body(lock));
    expect(() => verifyExecutionPlanAgainstFreeze({
      plan,
      freeze: lock,
      now: new Date("2026-07-12T00:00:00.000Z"),
    })).toThrowError(/expired/);
    expect(() => createBenchmarkExecutionPlan(body(lock, { maximum_micro_usd: 499_999 }))).toThrowError(/maximum/);
  });
});
