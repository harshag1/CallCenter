import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBenchmarkCli } from "../benchmark-cli";
import {
  createBenchmarkExecutionPlan,
  benchmarkPairInvariantsSha256,
  serializeBenchmarkExecutionPlan,
  serializeBenchmarkFreezeLock,
  type BenchmarkExecutionPlanBody,
  type BenchmarkFreezeLock,
} from "../execution-plan";
import { benchmarkKernelAttestationPublicKeyFingerprint } from "../kernel-attestation";
import {
  SCENARIO_SOURCE_REGISTRY_HASH,
  listScenarioSources,
  materializeScenarioSource,
} from "../scenario-source-registry";

const roots: string[] = [];
const H = (character: string) => character.repeat(64);
const ATTESTATION_KEYS = generateKeyPairSync("ed25519");
const ATTESTATION_PUBLIC_KEY_PEM = ATTESTATION_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const ATTESTATION_PIN = Object.freeze({
  algorithm: "ed25519" as const,
  key_id: "cli-kernel-attestation-v1",
  public_key_pem: ATTESTATION_PUBLIC_KEY_PEM,
  public_key_fingerprint_sha256: benchmarkKernelAttestationPublicKeyFingerprint(ATTESTATION_PUBLIC_KEY_PEM),
});

async function artifactTree(root: string, prefix = ""): Promise<ReadonlyMap<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      for (const [path, bytes] of await artifactTree(root, relativePath)) files.set(path, bytes);
    } else if (entry.isFile()) {
      files.set(relativePath, await readFile(join(root, relativePath)));
    }
  }
  return files;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hacc-cli-"));
  roots.push(path);
  return path;
}

function capturedIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout(value: string) { stdout += value; },
      stderr(value: string) { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function paidPlan() {
  const body: BenchmarkExecutionPlanBody = {
    schema_version: 1,
    plan_id: "paid-confirmation-test",
    mode: "canary",
    created_at: "2026-07-10T12:00:00.000Z",
    expires_at: "2026-07-11T12:00:00.000Z",
    freeze_lock_sha256: H("a"),
    source_commit: "1".repeat(40),
    release_gate: {
      pre_canary_packet_sha256: H("a"),
      provider_pricing_proof_sha256: H("b"),
      provider_hard_session_caps_sha256: H("c"),
      pricing_snapshot_sha256: H("2"),
      pricing_formula_sha256: H("4"),
      reservation_micro_usd: 5_000_000,
      conservative_liability_micro_usd: 4_900_000,
    },
    scenario: {
      path: "benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json",
      id: "industrial-field-service.v1",
      version: "1.0.0",
      canonical_sha256: H("b"),
      registry_key: `industrial-field-service.v1@1.0.0#sha256:${H("a")}`,
      registry_entry_sha256: H("6"),
      registry_catalog_sha256: H("7"),
    },
    fixture: {
      manifest_sha256: H("c"),
      caller_sequence_sha256: H("d"),
      rendition: "pcm16le_mono_24000",
    },
    cell: {
      run_id: "run-paid-confirmation-test",
      reservation_id: "reservation-paid-confirmation-test",
      pair_id: "pair-paid-confirmation-test",
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      condition: "full-harness",
    },
    pair_invariants_sha256: H("8"),
    study_plan_sha256: H("9"),
    condition_hash: H("e"),
    prompt_hash: H("f"),
    provider_tools_hash: H("0"),
    kernel_attestation: ATTESTATION_PIN,
    session_continuity: {
      schema_version: 1,
      application_reconnect: "disabled",
      provider_native_resumption: "disabled",
    },
    long_horizon_authorization: null,
    limits: {
      maxTurns: 24,
      maxSessionMs: 600_000,
      maxInputAudioBytes: 1_000_000,
      maxOutputAudioBytes: 2_000_000,
      maxToolCalls: 100,
      sessionReadyTimeoutMs: 15_000,
      responseTimeoutMs: 60_000,
    },
    audio_delivery: {
      schemaVersion: 1,
      chunkMs: 20,
      pace: "realtime",
      profile_sha256: H("1"),
    },
    cost_envelope: {
      pricing_snapshot_sha256: H("2"),
      limits_sha256: H("3"),
      formula_sha256: H("4"),
      components: [{ name: "pessimistic-cost", upper_bound_micro_usd: 4_900_000 }],
      safety_margin_micro_usd: 100_000,
    },
    maximum_micro_usd: 5_000_000,
    reservation_expires_at: "2026-07-10T12:15:00.000Z",
    ledger_id: "hacc-budget",
    output_root: "benchmarks/voice-long-horizon/results",
    artifact_schema_sha256: H("5"),
  };
  return createBenchmarkExecutionPlan({
    ...body,
    pair_invariants_sha256: benchmarkPairInvariantsSha256(body),
  });
}

function planningFreeze(
  evidenceClass: "pilot" | "confirmatory"
): BenchmarkFreezeLock {
  return {
    schema_version: 1,
    protocol_id: "HACC-LHVR-v0.1",
    evidence_class: evidenceClass,
    created_at: "2026-07-10T12:00:00.000Z",
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    dependency_lock_sha256: H("1"),
    protocol_sha256: H("2"),
    preregistration_sha256: H("3"),
    condition_compiler_sha256: H("4"),
    gateway_sha256: H("5"),
    evaluator_sha256: H("6"),
    artifact_schema_sha256: H("7"),
    audio_delivery_profile_sha256: H("8"),
    scenario_source_registry_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
    fixture_manifest_sha256: H("9"),
    caller_sequence_sha256: H("a"),
    randomization_sha256: H("b"),
    kernel_attestation: ATTESTATION_PIN,
    bundle: [{ path: "benchmarks/voice-long-horizon/PROTOCOL.md", sha256: H("c") }],
    provider_pins: [{
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      adapter_sha256: H("d"),
      session_settings_sha256: H("e"),
      pricing_snapshot_sha256: H("f"),
      pricing_formula_sha256: H("4"),
      hard_limits_sha256: H("3"),
    }],
    registration: evidenceClass === "confirmatory"
      ? {
          status: "frozen",
          freeze_tag: "benchmark-freeze-v1",
          freeze_tag_object_id: "3".repeat(40),
          target_commit: "1".repeat(40),
        }
      : { status: "exploratory" },
  };
}

describe("voice benchmark CLI", () => {
  it("prints a stable command surface and rejects unknown commands with exit 2", async () => {
    const output = capturedIo();
    expect(await runBenchmarkCli(["help"], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain("run paid");

    const bad = capturedIo();
    expect(await runBenchmarkCli(["definitely-not-a-command"], { io: bad.io })).toBe(2);
    expect(JSON.parse(bad.stderr())).toMatchObject({ exit_code: 2, error: { code: "unknown_command" } });
  });

  it("doctor is network-free and never renders credential values", async () => {
    const repository = await root();
    await mkdir(join(repository, "web"), { mode: 0o700 });
    const secret = "sk-doctor-must-never-print-this-value";
    await writeFile(join(repository, ".env"), `OPENAI_API_KEY=${secret}\n`, { mode: 0o600 });
    const output = capturedIo();
    const exit = await runBenchmarkCli(["doctor", "--json"], {
      repositoryRoot: repository,
      cwd: repository,
      io: output.io,
    });
    expect(exit).toBe(0);
    expect(output.stdout()).not.toContain(secret);
    expect(JSON.parse(output.stdout())).toMatchObject({ command: "doctor", network_calls: 0, spend_usd: "0" });
  });

  it("doctor fails closed when a requested ledger or freeze cannot be verified", async () => {
    const repository = await root();
    const missingLedger = capturedIo();
    expect(await runBenchmarkCli(["doctor", "--ledger", "missing-ledger.jsonl", "--json"], {
      repositoryRoot: repository,
      cwd: repository,
      io: missingLedger.io,
    })).toBe(5);
    expect(JSON.parse(missingLedger.stdout())).toMatchObject({
      command: "doctor",
      valid: false,
      checks: { ledger: { valid: false, reason_code: "ledger_invalid_or_unavailable" } },
      network_calls: 0,
      spend_usd: "0",
    });

    const invalidFreezePath = join(repository, "invalid-freeze.json");
    await writeFile(invalidFreezePath, "{}\n", { mode: 0o600 });
    const invalidFreeze = capturedIo();
    expect(await runBenchmarkCli(["doctor", "--freeze-lock", invalidFreezePath, "--json"], {
      repositoryRoot: repository,
      cwd: repository,
      io: invalidFreeze.io,
    })).toBe(5);
    expect(JSON.parse(invalidFreeze.stdout())).toMatchObject({
      valid: false,
      checks: { freeze: { valid: false, reason_code: "freeze_invalid_or_unavailable" } },
    });
  });

  it("lists registered sources and materializes canonical scenario JSON without clobbering", async () => {
    const repository = await root();
    const catalogOutput = capturedIo();
    expect(await runBenchmarkCli(["scenarios", "list", "--json"], {
      repositoryRoot: repository,
      cwd: repository,
      io: catalogOutput.io,
    })).toBe(0);
    const catalog = JSON.parse(catalogOutput.stdout());
    expect(catalog).toMatchObject({
      command: "scenarios list",
      registry_catalog_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
      count: listScenarioSources().length,
      network_calls: 0,
      spend_usd: "0",
    });
    expect(catalog.scenarios.some((entry: { heldOut: boolean; maxTurns: number }) => entry.heldOut && entry.maxTurns === 120)).toBe(true);

    const selected = listScenarioSources().find((entry) => entry.maxTurns === 32)!;
    const path = join(repository, "materialized", "scenario.json");
    const materializeOutput = capturedIo();
    expect(await runBenchmarkCli([
      "scenarios", "materialize",
      "--registry-key", selected.registryKey,
      "--out", path,
      "--json",
    ], { repositoryRoot: repository, cwd: repository, io: materializeOutput.io })).toBe(0);
    const expected = materializeScenarioSource(selected.registryKey);
    expect(await readFile(path, "utf8")).toBe(expected.canonicalScenarioJson);
    expect(JSON.parse(materializeOutput.stdout())).toMatchObject({
      registry_key: selected.registryKey,
      scenario_sha256: expected.canonicalScenarioSha256,
      held_out: false,
      network_calls: 0,
      spend_usd: "0",
    });

    const refusal = capturedIo();
    expect(await runBenchmarkCli([
      "scenarios", "materialize",
      "--registry-key", selected.registryKey,
      "--out", path,
      "--json",
    ], { repositoryRoot: repository, cwd: repository, io: refusal.io })).toBe(5);
    expect(refusal.stderr()).toContain("scenario_output_exists");
    expect(await readFile(path, "utf8")).toBe(expected.canonicalScenarioJson);
  });

  it("blocks held-out tuning and development scenarios mislabeled as confirmatory before fixture or spend access", async () => {
    const repository = await root();
    for (const testCase of [
      {
        mode: "pilot" as const,
        source: listScenarioSources().find((entry) => entry.heldOut && entry.maxTurns === 120)!,
        expectedCode: "held_out_source_not_exploratory",
      },
      {
        mode: "confirmatory" as const,
        source: listScenarioSources().find((entry) => (
          !entry.heldOut
          && entry.maxTurns === 32
          && entry.family !== "industrial-field-service"
        ))!,
        expectedCode: "development_source_not_confirmatory",
      },
    ]) {
      const freezePath = join(repository, `${testCase.mode}-freeze.json`);
      const scenarioPath = join(repository, `${testCase.mode}-scenario.json`);
      await writeFile(freezePath, serializeBenchmarkFreezeLock(planningFreeze(testCase.mode)), { mode: 0o600 });
      await writeFile(
        scenarioPath,
        materializeScenarioSource(testCase.source.registryKey).canonicalScenarioJson,
        { mode: 0o600 }
      );
      const output = capturedIo();
      const exit = await runBenchmarkCli([
        "plan",
        "--freeze-lock", freezePath,
        "--scenario", scenarioPath,
        "--provider", "openai",
        "--condition", "full-harness",
        "--mode", testCase.mode,
      ], { repositoryRoot: repository, cwd: repository, io: output.io });
      expect(exit).toBe(3);
      expect(output.stderr()).toContain(testCase.expectedCode);
    }
  });

  it("rejects a mismatched full paid hash before freeze, fixture, ledger, credentials, or executor", async () => {
    const repository = await root();
    const path = join(repository, "plan.json");
    const plan = paidPlan();
    await writeFile(path, serializeBenchmarkExecutionPlan(plan), { mode: 0o600 });
    let paidExecutions = 0;
    const output = capturedIo();
    const exit = await runBenchmarkCli([
      "run", "paid",
      "--plan", path,
      "--freeze-lock", join(repository, "missing-freeze.json"),
      "--fixture-root", join(repository, "missing-fixture"),
      "--ledger", join(repository, "missing-ledger"),
      "--confirm-paid-sha256", H("9"),
      "--confirm-max-usd", "0.5",
    ], {
      repositoryRoot: repository,
      cwd: repository,
      io: output.io,
      executePaid: async () => {
        paidExecutions += 1;
        throw new Error("must not execute");
      },
    });
    expect(exit).toBe(4);
    expect(paidExecutions).toBe(0);
    expect(output.stderr()).toContain("paid_hash_confirmation_mismatch");
  });

  it("categorically blocks paid execution when no crash-durable executor is installed", async () => {
    const output = capturedIo();
    const exit = await runBenchmarkCli(["run", "paid"], { io: output.io });
    expect(exit).toBe(3);
    expect(output.stderr()).toContain("paid_executor_unavailable");
  });

  it("runs paired adversarial harness/raw profiles in the ignored repo-local APFS journal at exactly $0", async () => {
    const output = capturedIo();
    const repositoryRoot = resolve(process.cwd(), "..");
    const outputRoot = resolve(
      repositoryRoot,
      `benchmarks/voice-long-horizon/.local/cli-smoke-${process.pid}-${Date.now()}`
    );
    roots.push(outputRoot);
    const exit = await runBenchmarkCli([
      "run", "offline",
      "--scenario", "benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json",
      "--condition", "full-harness",
      "--output-root", outputRoot,
      "--run-id", "offline-cli-harness",
      "--json",
    ], {
      repositoryRoot,
      cwd: repositoryRoot,
      io: output.io,
    });
    expect(exit).toBe(0);
    const result = JSON.parse(output.stdout());
    expect(result).toMatchObject({
      command: "run offline",
      run_id: "offline-cli-harness",
      status: "completed",
      profile: "full-harness-fault-e2e",
      world_task_success: true,
      network_calls: 0,
      paid_ledger_touched: false,
      spend_usd: "0",
    });
    expect(Object.values(result.fault_probes).every(Boolean)).toBe(true);
    expect(result.final_facts).toMatchObject({ close_count: 1, notification_count: 1, recorded_valve_id: "V-9B" });
    expect(await readFile(join(result.artifact_path, "FINALIZED.json"), "utf8")).toContain("offline-cli-harness");

    const reproductionRoot = `${outputRoot}-reproduction`;
    roots.push(reproductionRoot);
    const reproductionOutput = capturedIo();
    expect(await runBenchmarkCli([
      "run", "offline",
      "--scenario", "benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json",
      "--condition", "full-harness",
      "--output-root", reproductionRoot,
      "--run-id", "offline-cli-harness",
      "--json",
    ], {
      repositoryRoot,
      cwd: repositoryRoot,
      io: reproductionOutput.io,
    })).toBe(0);
    const reproduction = JSON.parse(reproductionOutput.stdout());
    const firstTree = await artifactTree(result.artifact_path);
    const secondTree = await artifactTree(reproduction.artifact_path);
    expect([...secondTree.keys()].sort()).toEqual([...firstTree.keys()].sort());
    expect(firstTree.size).toBeGreaterThan(40);
    for (const [path, bytes] of firstTree) {
      expect(secondTree.get(path)?.equals(bytes), `offline artifact differs: ${path}`).toBe(true);
    }

    const rawOutput = capturedIo();
    const rawExit = await runBenchmarkCli([
      "run", "offline",
      "--scenario", "benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json",
      "--condition", "raw-full",
      "--output-root", outputRoot,
      "--run-id", "offline-cli-raw-unsafe",
      "--json",
    ], {
      repositoryRoot,
      cwd: repositoryRoot,
      io: rawOutput.io,
    });
    expect(rawExit).toBe(0);
    const raw = JSON.parse(rawOutput.stdout());
    expect(raw).toMatchObject({
      profile: "raw-unsafe-grader-sensitivity",
      world_task_success: false,
      final_facts: { close_count: 2, notification_count: 1 },
      fault_probes: { close_retry_contained: false },
      network_calls: 0,
      paid_ledger_touched: false,
      spend_usd: "0",
    });
    // This correctness test performs three complete offline runs, recursively
    // compares two >40-file artifact trees, and exercises raw containment. It
    // asserts exact $0/network-free behavior but makes no latency claim.
  }, 120_000);
});
