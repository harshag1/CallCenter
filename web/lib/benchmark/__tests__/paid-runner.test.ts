import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import type { PaidBenchmarkRunInput } from "../benchmark-cli";
import { compileConditionSuite } from "../condition-compiler";
import {
  benchmarkFreezeLockSha256,
  benchmarkPairInvariantsSha256,
  benchmarkRunnerConfigSha256,
  createBenchmarkExecutionPlan,
  type BenchmarkExecutionPlanBody,
  type BenchmarkFreezeLock,
} from "../execution-plan";
import { ScriptedFakeRealtimeClient, createNoToolFakeScript } from "../fake-realtime-client";
import {
  initializeFilesystemBudgetLedger,
  inspectFilesystemBudgetLedger,
  setFilesystemBudgetPaused,
} from "../filesystem-budget-ledger";
import {
  SCENARIO_SOURCE_REGISTRY_HASH,
  resolveScenarioSource,
} from "../scenario-source-registry";
import { trialAudioDeliveryProfileHash, type TrialSessionConfiguration } from "../orchestrator";
import {
  benchmarkPaidSessionSettingsSha256,
  benchmarkPaidSessionDescriptor,
  createProviderClient,
  executePaidBenchmarkRun,
} from "../paid-runner";
import { BenchmarkScenarioSchema } from "../scenario-schema";
import { deriveLongHorizonExecutionAuthorization } from "../long-horizon-execution";
import { LONG_HORIZON_SCENARIO_SUITE } from "../long-horizon-scenario-suite";
import { ResolvedBenchmarkEnvironment } from "../environment";
import {
  createCallerAudioFixtureManifest,
  createCallerPcmDescriptor,
  type CallerAudioFixtureManifest,
  type VerifiedFrozenCallerAudio,
} from "../audio-fixtures";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
} from "../kernel-attestation";
import {
  TRANSPORT_SMOKE_SCENARIO,
  createTransportSmokeFakeScript,
} from "../transport-smoke-scenario";
import { deriveExpectedProviderTransportPacketVerificationInput } from "../provider-packet-verifier";
import {
  PRE_CANARY_GATE_0_REQUIRED_CHECK_IDS,
  createPreCanaryProofCheck,
  createPreCanaryProofPacket,
} from "../pre-canary-proof";
import {
  createProviderPricingProof,
  providerHardSessionCapsSha256,
  providerPricingProofCostEnvelope,
  PROVIDER_PRICING_OFFICIAL_URLS,
  type ProviderHardSessionCaps,
  type ProviderPricingProof,
} from "../provider-pricing-proof";
import {
  PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256,
  PAID_PREFLIGHT_TAMPER_TESTS,
} from "../paid-preflight-emulator-manifest";

const roots: string[] = [];
const fixtureCache = new Map<string, Readonly<{
  fixtureTurns: readonly Readonly<{ id: string; text: string; pause_after_ms: number }>[];
  pcm16: ReadonlyMap<string, Uint8Array>;
  pcm24: ReadonlyMap<string, Uint8Array>;
  manifest: CallerAudioFixtureManifest;
}>>();
const H = (character: string) => character.repeat(64);
const ATTESTATION_KEYS = generateKeyPairSync("ed25519");
const ATTESTATION_PUBLIC_KEY_PEM = ATTESTATION_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const ATTESTATION_PRIVATE_KEY_PEM = ATTESTATION_KEYS.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ATTESTATION_SIGNER = createBenchmarkKernelAttestationSigner({
  keyId: "paid-runner-test-ed25519-v1",
  privateKeyPem: ATTESTATION_PRIVATE_KEY_PEM,
  publicKeyPem: ATTESTATION_PUBLIC_KEY_PEM,
});
const ATTESTATION_PIN = Object.freeze({
  algorithm: "ed25519" as const,
  key_id: ATTESTATION_SIGNER.keyId,
  public_key_pem: ATTESTATION_PUBLIC_KEY_PEM,
  public_key_fingerprint_sha256: benchmarkKernelAttestationPublicKeyFingerprint(ATTESTATION_PUBLIC_KEY_PEM),
});

function fastFakeTrialRuntime() {
  let monotonicMs = 0;
  return Object.freeze({
    sleep(durationMs: number) {
      monotonicMs += durationMs;
    },
    clock: Object.freeze({
      monotonicNowMs: () => monotonicMs,
      wallTimeIso: () => "2026-07-10T12:02:00.000Z",
    }),
  });
}

function renderTestPcm(sampleRateHz: 16_000 | 24_000, durationMs: number, phaseOffset: number): Uint8Array {
  const sampleCount = sampleRateHz * durationMs / 1_000;
  if (!Number.isSafeInteger(sampleCount)) throw new Error("test PCM duration must be sample exact");
  const period = sampleRateHz / 400;
  const quarter = period / 4;
  const bytes = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const phase = (index + phaseOffset) % period;
    const sample = phase < quarter
      ? Math.trunc(phase * 8_000 / quarter)
      : phase < 3 * quarter
        ? 8_000 - Math.trunc((phase - quarter) * 16_000 / (2 * quarter))
        : -8_000 + Math.trunc((phase - 3 * quarter) * 8_000 / quarter);
    bytes.writeInt16LE(sample, index * 2);
  }
  return bytes;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pricingProof(
  provider: "openai" | "xai" | "gemini",
  common: Omit<ProviderHardSessionCaps, "provider">,
): ProviderPricingProof {
  const capture = `Official ${provider} pricing capture for paid-runner boundary tests.`;
  const source = {
    official_url: PROVIDER_PRICING_OFFICIAL_URLS[provider],
    captured_sha256: sha256Hex(capture),
    captured_byte_length: Buffer.byteLength(capture),
  };
  const snapshot = provider === "openai"
    ? {
        schema_version: 1 as const,
        provider,
        model: "gpt-realtime-2.1" as const,
        currency: "USD" as const,
        verified_at: "2026-07-18T00:00:00.000Z",
        not_after: "2026-07-24T00:00:00.000Z",
        source,
        rates: {
          input_text_micro_usd_per_million_tokens: 4_000_000 as const,
          input_audio_micro_usd_per_million_tokens: 32_000_000 as const,
          output_text_micro_usd_per_million_tokens: 24_000_000 as const,
          output_audio_micro_usd_per_million_tokens: 64_000_000 as const,
        },
      }
    : provider === "xai"
      ? {
          schema_version: 1 as const,
          provider,
          model: "grok-voice-think-fast-1.0" as const,
          currency: "USD" as const,
          verified_at: "2026-07-18T00:00:00.000Z",
          not_after: "2026-07-24T00:00:00.000Z",
          source,
          rates: {
            sent_audio_micro_usd_per_minute: 50_000 as const,
            received_audio_micro_usd_per_minute: 50_000 as const,
            billable_text_event_micro_usd: 4_000 as const,
            function_call_output_event_micro_usd: 0 as const,
            response_create_event_micro_usd: 0 as const,
          },
        }
      : {
          schema_version: 1 as const,
          provider,
          model: "gemini-3.1-flash-live-preview" as const,
          currency: "USD" as const,
          verified_at: "2026-07-18T00:00:00.000Z",
          not_after: "2026-07-24T00:00:00.000Z",
          source,
          rates: {
            input_text_micro_usd_per_million_tokens: 750_000 as const,
            input_audio_micro_usd_per_million_tokens: 3_000_000 as const,
            output_text_micro_usd_per_million_tokens: 4_500_000 as const,
            output_audio_micro_usd_per_million_tokens: 12_000_000 as const,
          },
        };
  const caps = provider === "xai"
    ? {
        ...common,
        provider,
        max_sent_audio_ms: 60_000,
        max_received_audio_ms: 60_000,
        max_billable_text_events: 4,
        max_unreported_sent_audio_ms: 1_000,
        max_unreported_received_audio_ms: 1_000,
        max_unreported_billable_text_events: 1,
      }
    : {
        ...common,
        provider,
        max_billed_input_text_tokens: 1_000,
        max_billed_input_audio_tokens: 1_000,
        max_billed_output_text_tokens: 1_000,
        max_billed_output_audio_tokens: 1_000,
        max_unreported_input_text_tokens: 10,
        max_unreported_input_audio_tokens: 10,
        max_unreported_output_text_tokens: 10,
        max_unreported_output_audio_tokens: 10,
      };
  return createProviderPricingProof({
    snapshot,
    caps,
    safetyMarginMicroUsd: 10_000,
    sourceCapture: capture,
    now: new Date("2026-07-19T00:00:00.000Z"),
  });
}

function paidGatePacket(input: Readonly<{
  freeze: BenchmarkFreezeLock;
  ledgerId: string;
  ledgerHeadSha256: string;
  proofs: Readonly<Record<"openai" | "xai" | "gemini", ProviderPricingProof>>;
}>) {
  const command = {
    id: "proof.command",
    cwd: "/workspace/web",
    argv: ["npm", "test"],
    exit_code: 0,
    stdout_sha256: H("1"),
    stderr_sha256: H("2"),
    combined_log_sha256: H("3"),
    raw_logs: "restricted_local_0600" as const,
    provider_environment_removed: true as const,
    duration_ms: 1,
  };
  const observed = (id: string): Readonly<Record<string, string | number | boolean | null>> => {
    if (id === "source.clean") return {
      clean: true, stable_snapshot: true, reachable_history_stable: true,
      opening_status_bytes: 0, closing_status_bytes: 0,
    };
    if (id === "source.public_history") return { finding_count: 0, reachable_commit_count: 1 };
    if (id === "source.working_tree_secrets") return { finding_count: 0 };
    if (id === "provider.offline_import_boundary") return { asserted: true };
    if (id === "provider.paid_preflight_emulator") return {
      tamper_credential_reads: 0,
      tamper_client_constructions: 0,
      tamper_reservations_consumed: 0,
      tamper_cases_passed: PAID_PREFLIGHT_TAMPER_TESTS.length,
      tamper_cases_total: PAID_PREFLIGHT_TAMPER_TESTS.length,
      happy_path_passed: true,
      manifest_sha256: PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256,
    };
    if (id === "budget.paused_zero") return { asserted: true };
    if (id === "freeze.verified") return { asserted: true };
    if (id === "offline.determinism") return { asserted: true };
    return { asserted: true };
  };
  const checks = PRE_CANARY_GATE_0_REQUIRED_CHECK_IDS.map((id) => createPreCanaryProofCheck({
    id,
    status: "pass",
    required_for: ["gate_0"],
    command_ids: [command.id],
    reason_codes: [],
    observed: observed(id),
  }));
  checks.push(createPreCanaryProofCheck({
    id: "pricing.gate1_executable_proofs",
    status: "pass",
    required_for: ["gate_1"],
    command_ids: [],
    reason_codes: [],
    observed: { verified_provider_count: 3, required_provider_count: 3 },
  }));
  return createPreCanaryProofPacket({
    schema_version: 1,
    kind: "hacc_pre_canary_no_spend_proof",
    generated_at: "2026-07-19T00:00:00.000Z",
    source: {
      commit: input.freeze.source_commit,
      tree: input.freeze.source_tree,
      clean: true,
      status_sha256: H("4"),
      publishable_file_manifest_sha256: H("5"),
    },
    provider_boundary: {
      offline_entrypoint: "web/scripts/voice-benchmark-offline.ts",
      runtime_import_closure_sha256: H("6"),
      runtime_input_count: 1,
      packet_entrypoint: "web/scripts/pre-canary-proof.ts",
      packet_runtime_import_closure_sha256: H("7"),
      packet_runtime_input_count: 1,
      forbidden_runtime_inputs: [],
      external_socket_imports: [],
      provider_client_construction_reachable: false,
      paid_executor_supplied: false,
      packet_provider_sessions_opened: 0,
      validation_contract_constructs_idle_clients: true,
    },
    budget: {
      ledger_verified: true,
      ledger_id: input.ledgerId,
      ledger_head_sha256: input.ledgerHeadSha256,
      state: "paused",
      paused: true,
      active_reservations_micro_usd: 0,
      conservative_settled_micro_usd: 0,
      scheduling_exposure_micro_usd: 0,
      provider_spend_usd: "0",
    },
    freeze: {
      verified: true,
      freeze_lock_sha256: benchmarkFreezeLockSha256(input.freeze),
      evidence_class: input.freeze.evidence_class,
      source_commit_matches: true,
    },
    pricing: {
      gate_1_reservation_micro_usd_per_provider: 5_000_000,
      executable_proof_count: 3,
      all_provider_proofs_verified: true,
      provider_proof_sha256: {
        openai: input.proofs.openai.proof_sha256,
        xai: input.proofs.xai.proof_sha256,
        gemini: input.proofs.gemini.proof_sha256,
      },
      provider_proofs: input.proofs,
    },
    determinism: {
      run_id: "paid-runner-gate0",
      historical_minimum_file_count: 49,
      observed_file_count_a: 49,
      observed_file_count_b: 49,
      exact_path_set_match: true,
      exact_byte_match: true,
      tree_sha256_a: H("9"),
      tree_sha256_b: H("9"),
      network_calls: 0,
      spend_usd: "0",
    },
    commands: [command],
    checks,
    artifacts: [],
  });
}

async function setup(id: string, scenarioOverride?: ReturnType<typeof BenchmarkScenarioSchema.parse>): Promise<Readonly<{
  input: PaidBenchmarkRunInput;
  ledgerPath: string;
  secret: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), "hacc-paid-runner-"));
  roots.push(root);
  const ledgerPath = join(root, "budget.jsonl");
  await initializeFilesystemBudgetLedger({
    ledgerPath,
    ledgerId: "hacc-paid-test-ledger",
    operationId: "initialize-paid-test-ledger",
    now: () => new Date("2026-07-10T12:00:00.000Z"),
  });
  const pausedLedger = await setFilesystemBudgetPaused({
    ledgerPath,
    operationId: "pause-for-gate0",
    paused: true,
    reasonCode: "gate0",
    evidenceSha256: H("f"),
    now: () => new Date("2026-07-10T12:00:01.000Z"),
  });
  const resumedLedger = await setFilesystemBudgetPaused({
    ledgerPath,
    operationId: "resume-after-gate0",
    paused: false,
    reasonCode: "manual-release",
    evidenceSha256: H("e"),
    now: () => new Date("2026-07-10T12:00:02.000Z"),
  });
  const scenario = scenarioOverride ?? BenchmarkScenarioSchema.parse(JSON.parse(await readFile(
    resolve(process.cwd(), "../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json"),
    "utf8"
  )));
  const scenarioSource = resolveScenarioSource(scenario);
  const suite = compileConditionSuite(scenarioSource.compilerInput);
  const condition = suite.conditions["raw-full"];
  // Large chunks keep descriptor-realistic multi-second PCM fixtures from
  // turning boundary tests into thousands of fsync-backed chunk events.
  const profile = { schemaVersion: 1 as const, chunkMs: 100, pace: "realtime" as const };
  const profileHash = trialAudioDeliveryProfileHash(profile);
  let cachedFixture = fixtureCache.get(scenarioSource.scenarioContentHash);
  if (!cachedFixture) {
    const fixtureTurns = Object.freeze(scenario.caller.turns.map((turn) => Object.freeze({
      id: turn.id,
      text: turn.utterance,
      pause_after_ms: 0,
    })));
    const pcm16 = new Map<string, Uint8Array>();
    const pcm24 = new Map<string, Uint8Array>();
    for (const [index, turn] of fixtureTurns.entries()) {
      const minimumSeconds = Math.max(
        0.25,
        Buffer.byteLength(turn.text, "utf8") / 100,
        turn.text.trim().split(/\s+/u).length * 60 / 500 * 0.25,
      );
      const durationMs = Math.ceil(minimumSeconds * 1_000) + 1;
      pcm16.set(turn.id, renderTestPcm(16_000, durationMs, index));
      pcm24.set(turn.id, renderTestPcm(24_000, durationMs, index));
    }
    const manifest = createCallerAudioFixtureManifest({
      generatedAt: "2026-07-10T12:00:00.000Z",
      scenario: {
        id: scenario.id,
        version: scenario.version,
        canonical_sha256: scenarioSource.scenarioContentHash,
      },
      turns: fixtureTurns,
      voice: "Paid Runner Test Voice",
      rateWpm: 500,
      toolchain: {
        macos: { product_version: "test", build_version: "test" },
        say: {
          implementation: "macos-say",
          binary_sha256: H("1"),
          version_source: "macos-bundle",
          voice_inventory_sha256: H("2"),
          selected_voice_metadata_sha256: H("3"),
          voice_asset_fingerprint_kind: "inventory-metadata-only",
        },
        ffmpeg: {
          version: "test",
          binary_sha256: H("4"),
          build_configuration_sha256: H("5"),
          libsoxr_enabled: true,
          libsoxr_library_name: "libsoxr",
          libsoxr_version: "test",
          libsoxr_binary_sha256: H("6"),
          conversion_profile: "pcm16le-mono-libsoxr-v1",
          argv_by_rendition: {
            pcm16le_mono_16000: ["ffmpeg", "16000"],
            pcm16le_mono_24000: ["ffmpeg", "24000"],
          },
        },
      },
      generatedTurns: fixtureTurns.map((turn) => ({
        caller_turn_id: turn.id,
        source_aiff_sha256: sha256Hex(`test-aiff:${turn.id}`),
        renditions: {
          pcm16le_mono_16000: createCallerPcmDescriptor({
            path: `pcm16le_mono_16000/${turn.id}.pcm`,
            bytes: pcm16.get(turn.id)!,
            sampleRateHz: 16_000,
          }),
          pcm16le_mono_24000: createCallerPcmDescriptor({
            path: `pcm16le_mono_24000/${turn.id}.pcm`,
            bytes: pcm24.get(turn.id)!,
            sampleRateHz: 24_000,
          }),
        },
      })),
    });
    cachedFixture = Object.freeze({ fixtureTurns, pcm16, pcm24, manifest });
    fixtureCache.set(scenarioSource.scenarioContentHash, cachedFixture);
  }
  const pcm = cachedFixture.pcm24;
  const fixtureManifest = cachedFixture.manifest;
  const callerSequenceSha256 = fixtureManifest.caller_sequence_sha256;
  const callerPcm = Object.freeze(scenario.caller.turns.map((turn) => Object.freeze({
    turnId: turn.id,
    audio: Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz: 24_000,
      channels: 1 as const,
      data: Uint8Array.from(pcm.get(turn.id)!),
    }),
  })));
  const hardCapsCommon = {
    schema_version: 1 as const,
    max_session_ms: Math.max(
      60_000,
      [...pcm.values()].reduce((total, bytes) => total + bytes.byteLength / 48, 0) + 60_000,
    ),
    forced_close_lead_ms: 1_000,
    meter_poll_interval_ms: 250,
    max_input_audio_bytes: [...pcm.values()].reduce((total, bytes) => total + bytes.byteLength, 0),
    max_output_audio_bytes: 1_000_000,
    max_tool_calls: 128,
    max_response_generations: Math.max(4, scenario.max_turns * 2),
    provider_connection_attempts: 1 as const,
    application_retries: 0 as const,
    provider_native_resumption: "disabled" as const,
    provider_transcription: { input: "disabled" as const, output: "disabled" as const },
    close_on_missing_usage: true as const,
    close_on_cap_reached: true as const,
  };
  const proofs = Object.freeze({
    openai: pricingProof("openai", hardCapsCommon),
    xai: pricingProof("xai", hardCapsCommon),
    gemini: pricingProof("gemini", hardCapsCommon),
  });
  const openaiProof = proofs.openai;
  const limits = {
    maxTurns: scenario.max_turns,
    maxSessionMs: hardCapsCommon.max_session_ms,
    maxInputAudioBytes: hardCapsCommon.max_input_audio_bytes,
    maxOutputAudioBytes: hardCapsCommon.max_output_audio_bytes,
    maxToolCalls: hardCapsCommon.max_tool_calls,
    sessionReadyTimeoutMs: 1_000,
    responseTimeoutMs: 1_000,
  };
  const audioDelivery = { ...profile, profile_sha256: profileHash };
  const runnerConfigSha256 = benchmarkRunnerConfigSha256({
    limits,
    audio_delivery: audioDelivery,
  });
  const longHorizonAuthorization = deriveLongHorizonExecutionAuthorization({
    scenario,
    callerPcm,
    mode: "pilot",
    maxSessionMs: limits.maxSessionMs,
    preregistrationSha256: H("3"),
    conditionSuiteSha256: suite.suiteHash,
    runnerConfigSha256,
  });
  const costEnvelope = providerPricingProofCostEnvelope(openaiProof, runnerConfigSha256);
  const provisionalBody: BenchmarkExecutionPlanBody = {
    schema_version: 1,
    plan_id: `paid-test-plan-${id}`,
    mode: "pilot",
    created_at: "2026-07-10T12:01:00.000Z",
    expires_at: "2030-07-12T12:01:00.000Z",
    freeze_lock_sha256: H("a"),
    source_commit: "1".repeat(40),
    release_gate: {
      pre_canary_packet_sha256: H("a"),
      provider_pricing_proof_sha256: openaiProof.proof_sha256,
      provider_hard_session_caps_sha256: providerHardSessionCapsSha256(openaiProof.caps),
      pricing_snapshot_sha256: openaiProof.derived.pricing_snapshot_sha256,
      pricing_formula_sha256: openaiProof.derived.formula_sha256,
      reservation_micro_usd: 5_000_000,
      conservative_liability_micro_usd: openaiProof.derived.conservative_liability_micro_usd,
    },
    scenario: {
      path: `benchmarks/voice-long-horizon/scenarios/${scenario.id}.json`,
      id: scenario.id,
      version: scenario.version,
      canonical_sha256: sha256Hex(canonicalJson(scenario)),
      registry_key: scenarioSource.registryKey,
      registry_entry_sha256: scenarioSource.registryEntryHash,
      registry_catalog_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
    },
    fixture: {
      manifest_sha256: fixtureManifest.manifest_sha256,
      caller_sequence_sha256: callerSequenceSha256,
      rendition: "pcm16le_mono_24000",
    },
    cell: {
      run_id: `paid-test-run-${id}`,
      reservation_id: `paid-test-reservation-${id}`,
      pair_id: `paid-test-pair-${id}`,
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      condition: "raw-full",
    },
    pair_invariants_sha256: H("8"),
    study_plan_sha256: H("7"),
    condition_hash: condition.conditionHash,
    prompt_hash: condition.initialPromptHash,
    provider_tools_hash: condition.providerToolsHash,
    kernel_attestation: ATTESTATION_PIN,
    session_continuity: {
      schema_version: 1,
      application_reconnect: "disabled",
      provider_native_resumption: "disabled",
    },
    long_horizon_authorization: longHorizonAuthorization,
    limits,
    audio_delivery: audioDelivery,
    cost_envelope: costEnvelope,
    maximum_micro_usd: 5_000_000,
    reservation_expires_at: "2030-07-11T12:16:00.000Z",
    ledger_id: "hacc-paid-test-ledger",
    reservation_authority: {
      ledger_open_head_sha256: resumedLedger.snapshot.head_sha256,
      consumption_id: `plan-consumption-${id}`,
    },
    output_root: "results",
    artifact_schema_sha256: H("0"),
  };
  const provisionalPlan = createBenchmarkExecutionPlan({
    ...provisionalBody,
    pair_invariants_sha256: benchmarkPairInvariantsSha256(provisionalBody),
  });
  const syntheticConfiguration: TrialSessionConfiguration = {
    provider: "openai",
    model: provisionalPlan.cell.model,
    conditionId: provisionalPlan.cell.condition,
    instructions: condition.initialPrompt,
    initialPrompt: condition.initialPrompt,
    renderedCapabilitySnapshot: "<dynamic-grants />",
    providerTools: condition.providerTools,
    conditionHash: condition.conditionHash,
    inputAudioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    audioDeliveryProfile: profile,
    audioDeliveryProfileHash: profileHash,
  };
  const settingsHash = benchmarkPaidSessionSettingsSha256(provisionalPlan, syntheticConfiguration);
  const freeze: BenchmarkFreezeLock = {
    schema_version: 1,
    protocol_id: "HACC-LHVR-v0.1",
    evidence_class: "pilot",
    created_at: "2026-07-10T12:00:00.000Z",
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    dependency_lock_sha256: H("1"),
    protocol_sha256: H("2"),
    preregistration_sha256: H("3"),
    condition_compiler_sha256: H("4"),
    gateway_sha256: H("5"),
    evaluator_sha256: H("6"),
    artifact_schema_sha256: H("0"),
    audio_delivery_profile_sha256: profileHash,
    scenario_source_registry_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
    fixture_manifest_sha256: fixtureManifest.manifest_sha256,
    caller_sequence_sha256: callerSequenceSha256,
    randomization_sha256: H("7"),
    kernel_attestation: ATTESTATION_PIN,
    bundle: [{ path: "benchmarks/voice-long-horizon/PROTOCOL.md", sha256: H("8") }],
    provider_pins: [{
      provider: "openai",
      model: provisionalPlan.cell.model,
      voice: provisionalPlan.cell.voice,
      adapter_sha256: H("9"),
      session_settings_sha256: settingsHash,
      pricing_snapshot_sha256: openaiProof.derived.pricing_snapshot_sha256,
      pricing_formula_sha256: openaiProof.derived.formula_sha256,
      provider_hard_session_caps_sha256: openaiProof.derived.hard_session_caps_sha256,
    }],
    registration: { status: "exploratory" },
  };
  const preCanaryPacket = paidGatePacket({
    freeze,
    ledgerId: "hacc-paid-test-ledger",
    ledgerHeadSha256: pausedLedger.snapshot.head_sha256,
    proofs,
  });
  const finalBody: BenchmarkExecutionPlanBody = {
    ...provisionalBody,
    freeze_lock_sha256: benchmarkFreezeLockSha256(freeze),
    release_gate: {
      ...provisionalBody.release_gate,
      pre_canary_packet_sha256: preCanaryPacket.packet_sha256,
    },
  };
  const plan = createBenchmarkExecutionPlan({
    ...finalBody,
    pair_invariants_sha256: benchmarkPairInvariantsSha256(finalBody),
  });
  const fixture = {
    manifest: fixtureManifest,
    readPcm(turnId: string) {
      const bytes = pcm.get(turnId);
      if (!bytes) throw new Error("unknown test turn");
      return Uint8Array.from(bytes);
    },
  } as unknown as VerifiedFrozenCallerAudio;
  const secret = "sk-paid-test-secret-never-persist";
  const environment = new ResolvedBenchmarkEnvironment(
    ["OPENAI_API_KEY"],
    new Map([["OPENAI_API_KEY", { value: secret, source: "paid-test" }]]) as never
  );
  return Object.freeze({
    ledgerPath,
    secret,
    input: Object.freeze({
      plan,
      freeze,
      scenario,
      condition,
      scenarioSource,
      suiteFlowHash: suite.flowHash,
      suiteScenarioHash: suite.scenarioHash,
      suiteSourceHash: suite.sourceHash,
      fixture,
      fixtureRendition: "pcm16le_mono_24000",
      kernelAttestationSigner: ATTESTATION_SIGNER,
      ledgerPath,
      outputRoot: join(root, "results"),
      environment,
      preCanaryPacket,
      providerPricingProof: openaiProof,
      humanConfirmation: {
        plan_sha256: plan.plan_sha256,
        maximum_usd: "5",
      },
    }),
  });
}

async function expectRefusedBeforeSpend(
  prepared: Awaited<ReturnType<typeof setup>>,
  input: PaidBenchmarkRunInput,
  error: RegExp,
  now: () => Date = () => new Date("2026-07-19T00:00:00.000Z"),
): Promise<void> {
  let credentialReads = 0;
  let clientCreations = 0;
  const guardedInput = Object.freeze({
    ...input,
    environment: {
      require() {
        credentialReads += 1;
        throw new Error("credential access must remain unreachable");
      },
    } as unknown as ResolvedBenchmarkEnvironment,
  });

  await expect(executePaidBenchmarkRun(guardedInput, {
    now,
    createClient: () => {
      clientCreations += 1;
      throw new Error("provider client construction must remain unreachable");
    },
  })).rejects.toThrowError(error);
  expect(credentialReads, "credential reads before refusal").toBe(0);
  expect(clientCreations, "client constructions before refusal").toBe(0);
  expect(
    (await inspectFilesystemBudgetLedger({ ledgerPath: input.ledgerPath })).reservations,
    "budget reservations before refusal"
  ).toEqual([]);
}

describe("paid benchmark execution boundary", () => {
  it("requires exact plan and $5 human confirmation at the direct executor boundary before spend", async () => {
    const prepared = await setup("direct-confirmation-boundary");
    const { humanConfirmation: _confirmation, ...withoutConfirmation } = prepared.input;
    void _confirmation;
    await expectRefusedBeforeSpend(
      prepared,
      withoutConfirmation as PaidBenchmarkRunInput,
      /exact human-confirmed plan SHA-256/,
    );
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      humanConfirmation: {
        ...prepared.input.humanConfirmation,
        plan_sha256: H("0"),
      },
    }), /exact human-confirmed plan SHA-256/);
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      humanConfirmation: {
        ...prepared.input.humanConfirmation,
        maximum_usd: "5.0",
      },
    }), /exact human-confirmed \$5 maximum/);
  });

  it("detaches the validated plan before the first await so caller mutation cannot retarget reservation", async () => {
    const prepared = await setup("detached-plan-snapshot");
    const originalRunId = prepared.input.plan.cell.run_id;
    const pending = executePaidBenchmarkRun(prepared.input, {
      ...fastFakeTrialRuntime(),
      createClient: async (_input, _configuration, apiKey) => {
        expect(apiKey).toBe(prepared.secret);
        return new ScriptedFakeRealtimeClient({
          script: createNoToolFakeScript({
            turnIds: prepared.input.scenario.caller.turns.map((turn) => turn.id),
          }),
        });
      },
    });
    (prepared.input.plan.cell as { run_id: string }).run_id = "mutated-after-call";
    const result = await pending;
    expect(result.runId).toBe(originalRunId);
    expect((await inspectFilesystemBudgetLedger({
      ledgerPath: prepared.ledgerPath,
    })).reservations[0]?.run_id).toBe(originalRunId);
  }, 30_000);

  it("detaches descriptor-verified PCM before the first await so readPcm mutation cannot substitute paid audio", async () => {
    const prepared = await setup("detached-pcm-snapshot");
    const expected = new Map(prepared.input.scenario.caller.turns.map((turn) => [
      turn.id,
      prepared.input.fixture.readPcm(turn.id, prepared.input.fixtureRendition),
    ]));
    let substitute = false;
    let reads = 0;
    const mutableFixture = {
      manifest: prepared.input.fixture.manifest,
      readPcm(turnId: string, rendition: "pcm16le_mono_16000" | "pcm16le_mono_24000") {
        reads += 1;
        const original = prepared.input.fixture.readPcm(turnId, rendition);
        if (!substitute) return original;
        const malicious = Uint8Array.from(original);
        malicious[0] ^= 0xff;
        return malicious;
      },
    } as unknown as VerifiedFrozenCallerAudio;
    const pending = executePaidBenchmarkRun(Object.freeze({
      ...prepared.input,
      fixture: mutableFixture,
    }), {
      ...fastFakeTrialRuntime(),
      createClient: async () => new ScriptedFakeRealtimeClient({
        script: createNoToolFakeScript({
          turnIds: prepared.input.scenario.caller.turns.map((turn) => turn.id),
        }),
      }),
    });

    // An async function executes synchronously until its first await. If the
    // runner retained readPcm by reference, every later read would now return
    // attacker-selected bytes.
    substitute = true;
    const result = await pending;
    expect(reads).toBe(prepared.input.scenario.caller.turns.length);
    for (const [turnId, bytes] of expected) {
      expect(
        new Uint8Array(await readFile(join(result.artifactPath, "frozen-input", `${turnId}.pcm`)))
      ).toEqual(bytes);
    }
  }, 30_000);

  it("refuses initially substituted PCM before credentials, reservation, or client creation", async () => {
    const prepared = await setup("initial-pcm-substitution");
    const maliciousFixture = {
      manifest: prepared.input.fixture.manifest,
      readPcm(turnId: string, rendition: "pcm16le_mono_16000" | "pcm16le_mono_24000") {
        const bytes = prepared.input.fixture.readPcm(turnId, rendition);
        const malicious = Uint8Array.from(bytes);
        malicious[0] ^= 0xff;
        return malicious;
      },
    } as unknown as VerifiedFrozenCallerAudio;
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      fixture: maliciousFixture,
    }), /PCM bytes differ from frozen descriptor/);
  });

  it("refuses forged descriptor and matching substituted PCM when the recorded manifest self-hash is stale", async () => {
    const prepared = await setup("stale-manifest-self-hash");
    const forgedManifest = JSON.parse(canonicalJson(prepared.input.fixture.manifest));
    const firstTurn = prepared.input.scenario.caller.turns[0]!;
    const original = prepared.input.fixture.readPcm(firstTurn.id, prepared.input.fixtureRendition);
    const malicious = Uint8Array.from(original);
    malicious[0] ^= 0xff;
    forgedManifest.turns[0].renditions[prepared.input.fixtureRendition].sha256 = sha256Hex(malicious);
    let pcmReads = 0;
    const maliciousFixture = {
      manifest: forgedManifest,
      readPcm(turnId: string, rendition: "pcm16le_mono_16000" | "pcm16le_mono_24000") {
        pcmReads += 1;
        return turnId === firstTurn.id
          ? Uint8Array.from(malicious)
          : prepared.input.fixture.readPcm(turnId, rendition);
      },
    } as unknown as VerifiedFrozenCallerAudio;
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      fixture: maliciousFixture,
    }), /manifest verification failed: manifest_sha256 mismatch/);
    expect(pcmReads, "PCM reads before manifest self-hash refusal").toBe(0);
  });

  it("constructs all three real pinned provider adapters offline with the same canonical gateway", async () => {
    const prepared = await setup("real-client-construction");
    const variants = Object.freeze([
      { provider: "openai" as const, model: "gpt-realtime-2.1", voice: "marin", sampleRateHz: 24_000 },
      { provider: "xai" as const, model: "grok-voice-think-fast-1.0", voice: "Ara", sampleRateHz: 24_000 },
      { provider: "gemini" as const, model: "gemini-3.1-flash-live-preview", voice: "Aoede", sampleRateHz: 16_000 },
    ]);

    for (const variant of variants) {
      const plan = Object.freeze({
        ...prepared.input.plan,
        cell: Object.freeze({
          ...prepared.input.plan.cell,
          provider: variant.provider,
          model: variant.model,
          voice: variant.voice,
        }),
      });
      const configuration: TrialSessionConfiguration = Object.freeze({
        provider: variant.provider,
        model: variant.model,
        conditionId: prepared.input.condition.id,
        instructions: prepared.input.condition.initialPrompt,
        initialPrompt: prepared.input.condition.initialPrompt,
        renderedCapabilitySnapshot: "<host-owned-catalog-without-grants />",
        providerTools: prepared.input.condition.providerTools,
        conditionHash: prepared.input.condition.conditionHash,
        inputAudioFormat: Object.freeze({
          encoding: "pcm16" as const,
          sampleRateHz: variant.sampleRateHz,
          channels: 1 as const,
        }),
        audioDeliveryProfile: Object.freeze({
          schemaVersion: 1,
          chunkMs: prepared.input.plan.audio_delivery.chunkMs,
          pace: "realtime" as const,
        }),
        audioDeliveryProfileHash: prepared.input.plan.audio_delivery.profile_sha256,
      });
      const sessionSettingsSha256 = benchmarkPaidSessionSettingsSha256(plan, configuration);
      const descriptor = benchmarkPaidSessionDescriptor(plan, configuration);
      const input: PaidBenchmarkRunInput = Object.freeze({
        ...prepared.input,
        plan,
        freeze: Object.freeze({
          ...prepared.input.freeze,
          provider_pins: Object.freeze([Object.freeze({
            provider: variant.provider,
            model: variant.model,
            voice: variant.voice,
            adapter_sha256: H("9"),
            session_settings_sha256: sessionSettingsSha256,
            pricing_snapshot_sha256: H("d"),
            pricing_formula_sha256: H("f"),
            provider_hard_session_caps_sha256: H("e"),
          })]),
        }),
      });

      const client = createProviderClient(input, configuration, "offline-construction-key");
      expect(client).toMatchObject({ provider: variant.provider, state: "idle" });
      expect(configuration.providerTools).toHaveLength(1);
      expect(configuration.providerTools[0]).toBe(prepared.input.condition.providerTools[0]);
      expect(JSON.stringify(configuration.providerTools)).not.toContain("capability_grant");
      expect(descriptor).toMatchObject({ hard_limits: prepared.input.plan.limits });
      expect(descriptor).toMatchObject({
        provider_transcription: { input: "disabled", output: "disabled" },
      });
      client.close(1000, "offline construction proof complete");
    }
  });

  it("orders reserve -> partial -> intent -> client -> opened -> audio -> settlement -> atomic finalize", async () => {
    const prepared = await setup("success");
    const { environment: resolvedEnvironment, ...lazyInputBody } = prepared.input;
    if (!resolvedEnvironment) throw new Error("test setup did not provide a resolved environment");
    const openTriplet = await Promise.all([
      readFile(prepared.ledgerPath),
      readFile(`${prepared.ledgerPath}.head.json`),
      readFile(`${prepared.ledgerPath}.signing-key.pem`),
    ]);
    let environmentResolutions = 0;
    let credentialReads = 0;
    let clientCreations = 0;
    const lazyInput: PaidBenchmarkRunInput = Object.freeze({
      ...lazyInputBody,
      resolveCredentialEnvironment: async () => {
        environmentResolutions += 1;
        const partialJournal = join(
          prepared.input.outputRoot,
          prepared.input.plan.plan_sha256,
          `${prepared.input.plan.cell.run_id}.partial`,
          "journal.jsonl",
        );
        expect(
          await readFile(partialJournal, "utf8"),
          "durable partial before environment resolution",
        ).toContain("budget.reservation_durable");
        expect(
          await readdir(`${prepared.ledgerPath}.plan-consumptions`),
          "one-shot anchor before environment resolution",
        ).toHaveLength(1);
        expect(
          (await inspectFilesystemBudgetLedger({ ledgerPath: prepared.ledgerPath })).reservations,
          "budget reservation before environment resolution",
        ).toHaveLength(1);
        return {
          require(name: string) {
            credentialReads += 1;
            return resolvedEnvironment.require(name);
          },
        } as unknown as ResolvedBenchmarkEnvironment;
      },
    });
    const result = await executePaidBenchmarkRun(lazyInput, {
      ...fastFakeTrialRuntime(),
      createClient: async (_input, configuration, apiKey) => {
        clientCreations += 1;
        expect(apiKey).toBe(prepared.secret);
        expect(configuration.inputAudioFormat.sampleRateHz).toBe(24_000);
        const budget = await inspectFilesystemBudgetLedger({ ledgerPath: prepared.ledgerPath });
        expect(budget.reservations[0]?.status).toBe("opening");
        return new ScriptedFakeRealtimeClient({
          script: createNoToolFakeScript({ turnIds: prepared.input.scenario.caller.turns.map((turn) => turn.id) }),
        });
      },
    });

    expect(environmentResolutions).toBe(1);
    expect(credentialReads).toBe(1);
    expect(clientCreations).toBe(1);
    expect(result).toMatchObject({ status: "completed", runId: "paid-test-run-success" });
    const budget = await inspectFilesystemBudgetLedger({ ledgerPath: prepared.ledgerPath });
    expect(budget.reservations[0]).toMatchObject({ status: "settled", terminal_outcome: "completed" });
    expect(budget.conservative_settled_micro_usd).toBe(5_000_000);
    const journal = await readFile(join(result.artifactPath, "journal.jsonl"), "utf8");
    expect(journal).not.toContain(prepared.secret);
    expect(journal.indexOf("budget.connection_intent_durable")).toBeLessThan(journal.indexOf("budget.session_opened_durable"));
    expect(journal.indexOf("budget.session_opened_durable")).toBeLessThan(journal.indexOf("caller.audio_chunk_intent"));
    expect(journal).toContain("kernel.attestation_verified_before_settlement");
    expect(journal).toContain("kernel.persisted_attestation_verified");
    expect(journal).toContain("kernel.persisted_transcript_verified");
    expect(journal).toContain("provider.persisted_transport_evidence_verified");
    expect(journal).toContain("budget.filesystem_settled");
    const persistedTranscript = await readFile(
      join(result.artifactPath, "final", "kernel-transcript.jsonl"),
      "utf8"
    );
    expect(persistedTranscript.trim().split("\n").length).toBeGreaterThan(0);
    const runnerManifest = JSON.parse(await readFile(
      join(result.artifactPath, "final", "runner-manifest.json"),
      "utf8"
    ));
    expect(runnerManifest).toMatchObject({
      schema_version: 1,
      manifest_type: "paid_benchmark_completion",
      run_id: prepared.input.plan.cell.run_id,
      kernel_transcript: {
        path: "final/kernel-transcript.jsonl",
        reference: { transcript_entry_count: expect.any(Number) },
      },
      provider_transport_evidence: {
        path: "final/provider-transport-evidence.json",
        wire_observations: { path: "final/provider-wire-observations.jsonl" },
        gate1_transport_smoke_eligible: false,
        claim_boundary: "transport_compatibility_only",
      },
    });
    const providerEvidence = JSON.parse(await readFile(
      join(result.artifactPath, "final", "provider-transport-evidence.json"),
      "utf8",
    ));
    expect(providerEvidence).toMatchObject({
      schema_version: 1,
      provider: "openai",
      session: { ready: true, configuration: null },
      gate1_transport_smoke: {
        eligible: false,
        errors: expect.arrayContaining([
          "session_configuration_missing",
          "wire_observation_chain_invalid_or_empty",
          "exactly_one_gateway_roundtrip_not_proven",
        ]),
        claim_boundary: "transport_compatibility_only",
      },
    });
    await Promise.all([
      writeFile(prepared.ledgerPath, openTriplet[0], { mode: 0o600 }),
      writeFile(`${prepared.ledgerPath}.head.json`, openTriplet[1], { mode: 0o600 }),
      writeFile(`${prepared.ledgerPath}.signing-key.pem`, openTriplet[2], { mode: 0o600 }),
    ]);
    const { environment: _replayEnvironment, ...replayInputBody } = prepared.input;
    void _replayEnvironment;
    let replayEnvironmentResolutions = 0;
    let replayCredentialReads = 0;
    let replayClientCreations = 0;
    await expect(executePaidBenchmarkRun(Object.freeze({
      ...replayInputBody,
      resolveCredentialEnvironment: async () => {
        replayEnvironmentResolutions += 1;
        return {
          require() {
            replayCredentialReads += 1;
            return prepared.secret;
          },
        } as unknown as ResolvedBenchmarkEnvironment;
      },
    }), {
      ...fastFakeTrialRuntime(),
      createClient: async () => {
        replayClientCreations += 1;
        throw new Error("provider client must remain unreachable on plan replay");
      },
    })).rejects.toThrow(/already consumed/);
    expect(replayEnvironmentResolutions).toBe(0);
    expect(replayCredentialReads).toBe(0);
    expect(replayClientCreations).toBe(0);
    const kernelAttestation = JSON.parse(await readFile(
      join(result.artifactPath, "final", "kernel-attestation.json"),
      "utf8"
    ));
    expect(kernelAttestation).toMatchObject({
      bindings: {
        pair_id: prepared.input.plan.cell.pair_id,
        plan_sha256: prepared.input.plan.plan_sha256,
        freeze_lock_sha256: prepared.input.plan.freeze_lock_sha256,
        kernel_build_sha256: prepared.input.freeze.gateway_sha256,
        signing_key_id: ATTESTATION_SIGNER.keyId,
        signing_public_key_sha256: ATTESTATION_SIGNER.publicKeySha256,
      },
      signature: { algorithm: "ed25519", key_id: ATTESTATION_SIGNER.keyId },
    });
  }, 30_000);

  it("persists the transport-smoke provider call to exact signed-kernel read-only receipt linkage", async () => {
    const prepared = await setup("transport-smoke-linkage", TRANSPORT_SMOKE_SCENARIO);
    const result = await executePaidBenchmarkRun(prepared.input, {
      ...fastFakeTrialRuntime(),
      createClient: async (_input, configuration) => new ScriptedFakeRealtimeClient({
        script: createTransportSmokeFakeScript("openai"),
        initialCapabilitySnapshot: configuration.renderedCapabilitySnapshot,
      }),
    });

    expect(result).toMatchObject({ status: "completed" });
    const linkage = JSON.parse(await readFile(
      join(result.artifactPath, "final", "provider-read-only-receipt-linkage.json"),
      "utf8",
    ));
    expect(linkage).toMatchObject({
      schema_version: 1,
      linkage_type: "provider_read_only_toolworld_receipt",
      provider_call_id: "transport-smoke-call-001",
      tool: "read_service_status",
      safety_proof: {
        tool_kind: "query",
        declared_effect_count: 0,
        committed: false,
        receipt_effect_count: 0,
        world_effect_count: 0,
        tainted_result_path_count: 0,
        outcome_class: "success_executed",
      },
    });
    const runnerManifest = JSON.parse(await readFile(
      join(result.artifactPath, "final", "runner-manifest.json"),
      "utf8",
    ));
    await expect(deriveExpectedProviderTransportPacketVerificationInput({
      complete_directory: result.artifactPath,
      expected: {
        run_id: prepared.input.plan.cell.run_id,
        pair_id: prepared.input.plan.cell.pair_id,
        provider: prepared.input.plan.cell.provider,
        model: prepared.input.plan.cell.model,
        plan_sha256: prepared.input.plan.plan_sha256,
        freeze_lock_sha256: prepared.input.plan.freeze_lock_sha256,
      },
      plan_pinned_trust: {
        keyId: prepared.input.plan.kernel_attestation.key_id,
        publicKeySha256:
          prepared.input.plan.kernel_attestation.public_key_fingerprint_sha256,
        publicKeyPem: prepared.input.plan.kernel_attestation.public_key_pem,
      },
    })).rejects.toThrow("provider packet evidence differs from the canonical provider/model");
    // The deterministic ScriptedFake client is runner-path evidence only and
    // intentionally has no provider wire chain, so it must never mint C3.
    expect(runnerManifest.provider_transport_packet).toBeNull();
    expect(runnerManifest.provider_transport_evidence).toMatchObject({
      gate1_transport_smoke_eligible: false,
    });
  }, 30_000);

  it("preserves a partial and full liability when a Gate 1 canary is not C3-eligible", async () => {
    const prepared = await setup("ineligible-gate1-canary", TRANSPORT_SMOKE_SCENARIO);
    const freeze: BenchmarkFreezeLock = Object.freeze({
      ...prepared.input.freeze,
      evidence_class: "canary",
    });
    const proofs = prepared.input.preCanaryPacket.pricing.provider_proofs;
    if (!proofs.openai || !proofs.xai || !proofs.gemini) {
      throw new Error("test Gate 0 packet omitted provider proofs");
    }
    const preCanaryPacket = paidGatePacket({
      freeze,
      ledgerId: prepared.input.plan.ledger_id,
      ledgerHeadSha256: prepared.input.preCanaryPacket.budget.ledger_head_sha256!,
      proofs: { openai: proofs.openai, xai: proofs.xai, gemini: proofs.gemini },
    });
    const { plan_sha256: _planSha256, ...priorBody } = prepared.input.plan;
    void _planSha256;
    const body: BenchmarkExecutionPlanBody = {
      ...priorBody,
      mode: "canary",
      freeze_lock_sha256: benchmarkFreezeLockSha256(freeze),
      release_gate: {
        ...priorBody.release_gate,
        pre_canary_packet_sha256: preCanaryPacket.packet_sha256,
      },
      pair_invariants_sha256: H("0"),
    };
    const plan = createBenchmarkExecutionPlan({
      ...body,
      pair_invariants_sha256: benchmarkPairInvariantsSha256(body),
    });
    await expect(executePaidBenchmarkRun({
      ...prepared.input,
      plan,
      freeze,
      preCanaryPacket,
      humanConfirmation: {
        plan_sha256: plan.plan_sha256,
        maximum_usd: "5",
      },
    }, {
      ...fastFakeTrialRuntime(),
      now: () => new Date("2026-07-19T00:00:00.000Z"),
      createClient: async (_input, configuration) => new ScriptedFakeRealtimeClient({
        script: createTransportSmokeFakeScript("openai"),
        initialCapabilitySnapshot: configuration.renderedCapabilitySnapshot,
      }),
    })).rejects.toThrow(/durable partial and budget liability were preserved/);
    const budget = await inspectFilesystemBudgetLedger({ ledgerPath: prepared.ledgerPath });
    expect(budget.conservative_settled_micro_usd).toBe(5_000_000);
    expect(budget.reservations[0]).toMatchObject({
      status: "settled",
      terminal_outcome: "failed",
    });
  }, 30_000);

  it("retains a pessimistic settled liability and partial when client construction fails", async () => {
    const prepared = await setup("factory-failure");
    await expect(executePaidBenchmarkRun(prepared.input, {
      createClient: () => {
        throw new Error(`provider rejected ${prepared.secret}`);
      },
    })).rejects.toThrowError(/durable partial and budget liability were preserved/);

    const budget = await inspectFilesystemBudgetLedger({ ledgerPath: prepared.ledgerPath });
    expect(budget.reservations[0]).toMatchObject({ status: "settled", terminal_outcome: "failed" });
    expect(budget.conservative_settled_micro_usd).toBe(5_000_000);
    const partial = join(prepared.input.outputRoot, prepared.input.plan.plan_sha256, `${prepared.input.plan.cell.run_id}.partial`, "journal.jsonl");
    const journal = await readFile(partial, "utf8");
    expect(journal).not.toContain(prepared.secret);
    expect(journal).toContain("run.partial_preserved");
  });

  it("preserves a durable partial and full liability when lazy credential resolution fails", async () => {
    const prepared = await setup("credential-resolution-failure");
    const { environment: resolvedEnvironment, ...lazyInputBody } = prepared.input;
    if (!resolvedEnvironment) throw new Error("test setup did not provide a resolved environment");
    let environmentResolutions = 0;
    let clientCreations = 0;
    const partial = join(
      prepared.input.outputRoot,
      prepared.input.plan.plan_sha256,
      `${prepared.input.plan.cell.run_id}.partial`,
    );

    await expect(executePaidBenchmarkRun(Object.freeze({
      ...lazyInputBody,
      resolveCredentialEnvironment: async () => {
        environmentResolutions += 1;
        const journalBeforeFailure = await readFile(join(partial, "journal.jsonl"), "utf8");
        expect(journalBeforeFailure).toContain("run.partial_opened");
        expect(journalBeforeFailure).toContain("budget.reservation_durable");
        throw new Error(`credential store failed near ${prepared.secret}`);
      },
    }), {
      createClient: () => {
        clientCreations += 1;
        throw new Error("provider client must remain unreachable");
      },
    })).rejects.toThrowError(/durable partial and budget liability were preserved/);

    expect(environmentResolutions).toBe(1);
    expect(clientCreations).toBe(0);
    const budget = await inspectFilesystemBudgetLedger({ ledgerPath: prepared.ledgerPath });
    expect(budget.reservations[0]).toMatchObject({
      status: "reserved",
      terminal_outcome: null,
      maximum_micro_usd: 5_000_000,
    });
    expect(budget.active_reservations_micro_usd).toBe(5_000_000);
    expect(budget.scheduling_exposure_micro_usd).toBe(5_000_000);
    const journal = await readFile(join(partial, "journal.jsonl"), "utf8");
    expect(journal).not.toContain(prepared.secret);
    expect(journal).toContain("run.partial_opened");
    expect(journal).toContain("budget.reservation_durable");
    expect(journal).toContain("run.partial_preserved");
  });

  it("rejects an execution-plan body mutation with a stale self-hash before spend", async () => {
    const prepared = await setup("stale-plan-self-hash");
    const forged = Object.freeze({
      ...prepared.input,
      plan: Object.freeze({ ...prepared.input.plan, prompt_hash: H("a") }),
    });

    await expectRefusedBeforeSpend(prepared, forged, /plan hash is invalid/);
  });

  it("rejects a missing Gate 0 packet before credentials, reservation, or provider creation", async () => {
    const prepared = await setup("missing-gate0-packet");
    await expectRefusedBeforeSpend(
      prepared,
      {
        ...prepared.input,
        preCanaryPacket: undefined,
      } as unknown as PaidBenchmarkRunInput,
      /not JSON-serializable|canonical verified Gate 0 packet/,
    );
  });

  it("rejects a tampered Gate 0 packet before credentials, reservation, or provider creation", async () => {
    const prepared = await setup("tampered-gate0-packet");
    const tampered = {
      ...prepared.input.preCanaryPacket,
      source: {
        ...prepared.input.preCanaryPacket.source,
        commit: "f".repeat(40),
      },
    };
    await expectRefusedBeforeSpend(
      prepared,
      {
        ...prepared.input,
        preCanaryPacket: tampered,
      } as PaidBenchmarkRunInput,
      /canonical verified Gate 0 packet|packet_hash_mismatch/,
    );
  });

  it("rejects a stale Gate 0 pricing packet before credentials, reservation, or provider creation", async () => {
    const prepared = await setup("stale-gate0-packet");
    await expectRefusedBeforeSpend(
      prepared,
      prepared.input,
      /provider_pricing_proof_stale_or_invalid|gate_1_not_ready/,
      () => new Date("2026-07-25T00:00:00.000Z"),
    );
  });

  it("rejects a replacement ledger that reuses the Gate 0 ledger ID before provider creation", async () => {
    const prepared = await setup("replacement-ledger");
    const root = await mkdtemp(join(tmpdir(), "hacc-replacement-ledger-"));
    roots.push(root);
    const replacementLedgerPath = join(root, "budget.jsonl");
    await initializeFilesystemBudgetLedger({
      ledgerPath: replacementLedgerPath,
      ledgerId: prepared.input.plan.ledger_id,
      operationId: "replacement-ledger-init",
    });
    await expectRefusedBeforeSpend(
      prepared,
      {
        ...prepared.input,
        ledgerPath: replacementLedgerPath,
      },
      /does not descend from the exact Gate 0 paused-zero head/,
    );
  });

  it("rejects a missing or tampered selected pricing proof before provider creation", async () => {
    const missing = await setup("missing-selected-pricing-proof");
    await expectRefusedBeforeSpend(
      missing,
      {
        ...missing.input,
        providerPricingProof: undefined,
      } as unknown as PaidBenchmarkRunInput,
      /Invalid input|paid execution inputs differ/,
    );

    const tampered = await setup("tampered-selected-pricing-proof");
    await expectRefusedBeforeSpend(
      tampered,
      {
        ...tampered.input,
        providerPricingProof: {
          ...tampered.input.providerPricingProof,
          proof_sha256: H("0"),
        },
      } as PaidBenchmarkRunInput,
      /hash is invalid|hash mismatch|paid execution inputs differ/,
    );
  });

  it("rejects a pricing-formula substitution before spend", async () => {
    const prepared = await setup("pricing-formula-substitution");
    const { plan_sha256: _planSha256, ...body } = prepared.input.plan;
    void _planSha256;
    const tamperedBody: BenchmarkExecutionPlanBody = {
      ...body,
      cost_envelope: {
        ...body.cost_envelope,
        formula_sha256: H("a"),
      },
      release_gate: {
        ...body.release_gate,
        pricing_formula_sha256: H("a"),
      },
    };
    const tamperedPlan = createBenchmarkExecutionPlan({
      ...tamperedBody,
      pair_invariants_sha256: benchmarkPairInvariantsSha256(tamperedBody),
    });
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      plan: tamperedPlan,
      humanConfirmation: {
        plan_sha256: tamperedPlan.plan_sha256,
        maximum_usd: "5",
      },
    }), /paid cost envelope is not the exact Gate 0 pricing proof decomposition/);
  });

  it("rejects a provider/model identity substitution before spend", async () => {
    const prepared = await setup("provider-model-substitution");
    const { plan_sha256: _planSha256, ...body } = prepared.input.plan;
    void _planSha256;
    const tamperedBody: BenchmarkExecutionPlanBody = {
      ...body,
      cell: {
        ...body.cell,
        provider: "xai",
        model: "grok-voice-think-fast-1.0",
        voice: "Ara",
      },
    };
    const tamperedPlan = createBenchmarkExecutionPlan({
      ...tamperedBody,
      pair_invariants_sha256: benchmarkPairInvariantsSha256(tamperedBody),
    });
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      plan: tamperedPlan,
      humanConfirmation: {
        plan_sha256: tamperedPlan.plan_sha256,
        maximum_usd: "5",
      },
    }), /paid execution inputs differ|provider pricing proof mismatch/);
  });

  it("rejects a forged compiler binding before credentials, reservation, or client creation", async () => {
    const prepared = await setup("forged-source");
    const forged = Object.freeze({
      ...prepared.input,
      suiteFlowHash: H("e"),
    });

    await expectRefusedBeforeSpend(prepared, forged, /compiler suite binding differs/);
  });

  it("rejects a signer that claims the pinned identity but cannot prove private-key possession before spend", async () => {
    const prepared = await setup("forged-signer");
    const wrongKeys = generateKeyPairSync("ed25519");
    const wrongSigner = createBenchmarkKernelAttestationSigner({
      keyId: "wrong-private-key",
      privateKeyPem: wrongKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: wrongKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const forgedSigner = Object.freeze({
      algorithm: "ed25519" as const,
      keyId: ATTESTATION_SIGNER.keyId,
      publicKeySha256: ATTESTATION_SIGNER.publicKeySha256,
      sign: wrongSigner.sign,
    });
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      kernelAttestationSigner: forgedSigner,
    }), /prove possession/);
  });

  it("rejects frozen kernel-build substitution before spend", async () => {
    const prepared = await setup("kernel-build-substitution");
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      freeze: Object.freeze({ ...prepared.input.freeze, gateway_sha256: H("e") }),
    }), /paid release gate is invalid: freeze_mismatch/);
  });

  it("rejects a freeze-lock body mutation before credentials, reservation, or client creation", async () => {
    const prepared = await setup("freeze-lock-body-substitution");
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      freeze: Object.freeze({ ...prepared.input.freeze, evaluator_sha256: H("e") }),
    }), /paid release gate is invalid: freeze_mismatch/);
  });

  it("rejects internally rehashed runner limits that differ from the exact frozen provider caps before spend", async () => {
    const prepared = await setup("provider-caps-runner-limits-substitution");
    expect(prepared.input.plan.limits).toMatchObject({
      maxSessionMs: prepared.input.providerPricingProof.caps.max_session_ms,
      maxInputAudioBytes: prepared.input.providerPricingProof.caps.max_input_audio_bytes,
      maxOutputAudioBytes: prepared.input.providerPricingProof.caps.max_output_audio_bytes,
      maxToolCalls: prepared.input.providerPricingProof.caps.max_tool_calls,
    });
    const { plan_sha256: _planSha, ...body } = prepared.input.plan;
    void _planSha;
    const limits = {
      ...body.limits,
      maxToolCalls: body.limits.maxToolCalls - 1,
    };
    const runnerConfigSha256 = benchmarkRunnerConfigSha256({
      limits,
      audio_delivery: body.audio_delivery,
    });
    const tamperedBody: BenchmarkExecutionPlanBody = {
      ...body,
      limits,
      cost_envelope: providerPricingProofCostEnvelope(
        prepared.input.providerPricingProof,
        runnerConfigSha256,
      ),
      pair_invariants_sha256: H("0"),
    };
    const tamperedPlan = createBenchmarkExecutionPlan({
      ...tamperedBody,
      pair_invariants_sha256: benchmarkPairInvariantsSha256(tamperedBody),
    });
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      plan: tamperedPlan,
      humanConfirmation: {
        plan_sha256: tamperedPlan.plan_sha256,
        maximum_usd: "5",
      },
    }), /plan-bound Gate 0 pricing proof/);
  });

  it("recomputes the plan-pinned long-horizon PCM authorization before credentials or budget", async () => {
    const source = LONG_HORIZON_SCENARIO_SUITE.find((candidate) =>
      candidate.family === "travel-disruption" && candidate.turnCount === 32
    );
    if (!source) throw new Error("missing 32-turn long-horizon test source");
    const prepared = await setup("long-horizon-auth", source.scenario);
    expect(prepared.input.plan.long_horizon_authorization).not.toBeNull();
    const { plan_sha256: _planSha, ...body } = prepared.input.plan;
    void _planSha;
    const tamperedBody: BenchmarkExecutionPlanBody = {
      ...body,
      long_horizon_authorization: {
        ...prepared.input.plan.long_horizon_authorization!,
        verified_audio_binding_sha256: H("0"),
      },
      pair_invariants_sha256: H("0"),
    };
    const tamperedPlan = createBenchmarkExecutionPlan({
      ...tamperedBody,
      pair_invariants_sha256: benchmarkPairInvariantsSha256(tamperedBody),
    });
    await expectRefusedBeforeSpend(prepared, Object.freeze({
      ...prepared.input,
      plan: tamperedPlan,
      humanConfirmation: {
        plan_sha256: tamperedPlan.plan_sha256,
        maximum_usd: "5",
      },
    }), /long-horizon execution authorization differs/);
  });

  it("keeps all three 120-turn fixtures offline-only before any scheduling primitive exists", () => {
    const heldOut = LONG_HORIZON_SCENARIO_SUITE.filter((candidate) => candidate.turnCount === 120);
    expect(heldOut).toHaveLength(3);
    for (const source of heldOut) {
      const callerPcm = source.scenario.caller.turns.map((turn, index) => ({
        turnId: turn.id,
        audio: {
          encoding: "pcm16" as const,
          sampleRateHz: 24_000,
          channels: 1 as const,
          data: Uint8Array.from({ length: 640 }, (_, byte) => (index + byte) & 0xff),
        },
      }));
      expect(() => deriveLongHorizonExecutionAuthorization({
        scenario: source.scenario,
        callerPcm,
        mode: "confirmatory",
        maxSessionMs: 15 * 60_000,
        preregistrationSha256: H("3"),
        conditionSuiteSha256: H("4"),
        runnerConfigSha256: H("5"),
      })).toThrow(/offline-stress-only/);
    }
  });
});
