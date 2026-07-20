import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import scenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import { createFlowExecutionState, flowCapabilityScope } from "../../flow-runtime";
import {
  buildEventChain,
  canonicalJson,
  createArtifactDescriptor,
  createRunManifest,
  encodeEventJsonl,
  sha256Hex,
  type BenchmarkEventEnvelope,
  type RunManifest,
} from "../artifacts";
import { compileConditionSuite, type CompiledConditionSuite } from "../condition-compiler";
import { industrialFieldServiceCompilerInput } from "../industrial-field-service-source";
import {
  benchmarkKernelAttestationJson,
  benchmarkKernelAttestationPublicKeyFingerprint,
  benchmarkKernelAttestationReference,
  createBenchmarkKernelAttestationSigner,
  createBenchmarkKernelCapabilityHead,
  createBenchmarkKernelFinalAttestation,
} from "../kernel-attestation";
import { BenchmarkScenarioSchema, type BenchmarkScenario } from "../scenario-schema";
import { createToolWorld } from "../tool-world";
import {
  createKernelTranscript,
  encodeKernelTranscript,
  kernelTranscriptReference,
} from "../kernel-transcript";
import {
  benchmarkProviderStratumKey,
  attestationPublicKeyFingerprint,
  claimRegistrationBody,
  createImmutableScoreArtifact,
  generateBenchmarkReport,
  LEGACY_SCORE_CLAIM_BLOCK_REASON,
  registrationAttestationPayload,
  renderBenchmarkReportJson,
  renderBenchmarkReportMarkdown,
  scoreAttestationPayload,
  type BenchmarkRunBundle,
  type ClaimRegistration,
  type ClaimRegistrationBody,
  type DetachedAttestation,
  type KernelAttestationEvidence,
  type RunScoreArtifact,
} from "../report";

const EVALUATOR_HASH = "e".repeat(64);
const ANALYSIS_HASH = "a".repeat(64);
const FREEZE_LOCK_HASH = "f".repeat(64);
const PLAN_HASH = "9".repeat(64);
const KERNEL_BUILD_HASH = "6".repeat(64);
const REGISTRATION_KEY_ID = "synthetic-registration-key";
const EVALUATOR_KEY_ID = "synthetic-evaluator-key";
const KERNEL_KEY_ID = "synthetic-kernel-key";
const { privateKey: REGISTRATION_PRIVATE_KEY, publicKey: REGISTRATION_PUBLIC_KEY } = generateKeyPairSync("ed25519");
const { privateKey: EVALUATOR_PRIVATE_KEY, publicKey: EVALUATOR_PUBLIC_KEY } = generateKeyPairSync("ed25519");
const { privateKey: KERNEL_PRIVATE_KEY, publicKey: KERNEL_PUBLIC_KEY } = generateKeyPairSync("ed25519");
const REGISTRATION_PUBLIC_PEM = REGISTRATION_PUBLIC_KEY.export({ type: "spki", format: "pem" }).toString();
const EVALUATOR_PUBLIC_PEM = EVALUATOR_PUBLIC_KEY.export({ type: "spki", format: "pem" }).toString();
const KERNEL_PRIVATE_PEM = KERNEL_PRIVATE_KEY.export({ type: "pkcs8", format: "pem" }).toString();
const KERNEL_PUBLIC_PEM = KERNEL_PUBLIC_KEY.export({ type: "spki", format: "pem" }).toString();
const REGISTRATION_PUBLIC_FINGERPRINT = attestationPublicKeyFingerprint(REGISTRATION_PUBLIC_PEM);
const EVALUATOR_PUBLIC_FINGERPRINT = attestationPublicKeyFingerprint(EVALUATOR_PUBLIC_PEM);
const KERNEL_PUBLIC_FINGERPRINT = benchmarkKernelAttestationPublicKeyFingerprint(KERNEL_PUBLIC_PEM);
const KERNEL_SIGNER = createBenchmarkKernelAttestationSigner({
  keyId: KERNEL_KEY_ID,
  privateKeyPem: KERNEL_PRIVATE_PEM,
  publicKeyPem: KERNEL_PUBLIC_PEM,
});

function attest(
  payload: string,
  signedAt: string,
  keyId: string,
  privateKey: typeof REGISTRATION_PRIVATE_KEY
): DetachedAttestation {
  return {
    algorithm: "ed25519",
    key_id: keyId,
    signed_at: signedAt,
    signature_base64: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
  };
}

function attestRegistration(body: ClaimRegistrationBody): ClaimRegistration {
  return {
    ...body,
    attestation: attest(
      registrationAttestationPayload(body),
      body.frozen_at,
      REGISTRATION_KEY_ID,
      REGISTRATION_PRIVATE_KEY
    ),
  };
}

function reviseRegistration(
  registration: ClaimRegistration,
  patch: Partial<ClaimRegistrationBody>
): ClaimRegistration {
  return attestRegistration({ ...claimRegistrationBody(registration), ...patch });
}

function pairInvariantsHash(pairId: string, scenarioId: string, provider: string, model: string): string {
  return sha256Hex(JSON.stringify({ pairId, scenarioId, provider, model, fixture: "fixture-v1", configuration: "config-v1" }));
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function executionPlanSha256(runId: string, condition: string): string {
  return sha256Hex(canonicalJson({ schema_version: 1, run_id: runId, condition, frozen_study_plan_sha256: PLAN_HASH }));
}

const compiledFixtures = new Map<string, Readonly<{ scenario: BenchmarkScenario; suite: CompiledConditionSuite }>>();

function compiledFixture(scenarioId: string): Readonly<{ scenario: BenchmarkScenario; suite: CompiledConditionSuite }> {
  const existing = compiledFixtures.get(scenarioId);
  if (existing) return existing;
  const scenario = BenchmarkScenarioSchema.parse({ ...scenarioJson, id: scenarioId });
  const canonicalCompilerInput = industrialFieldServiceCompilerInput(scenarioJson);
  const fixture = Object.freeze({
    scenario,
    suite: compileConditionSuite({ ...canonicalCompilerInput, scenario }),
  });
  compiledFixtures.set(scenarioId, fixture);
  return fixture;
}

type BundleOptions = Readonly<{
  runId: string;
  pairId: string;
  scenarioId: string;
  provider?: string;
  model?: string;
  condition: "raw-memory" | "full-harness";
  strictPass: boolean;
  modelFailure?: boolean;
  systemFailure?: boolean;
  status?: RunScoreArtifact["status"];
  costMicroUsd?: number | null;
  estimatedCostMicroUsd?: number | null;
  providerReportedCostMicroUsd?: number | null;
  reconciledCostMicroUsd?: number | null;
  attempted?: number;
  blocked?: number;
  executed?: number;
  verified?: number;
  firstAudioMs?: number;
}>;

function makeSource(options: BundleOptions): Readonly<{
  manifest: RunManifest;
  events: readonly BenchmarkEventEnvelope[];
  kernel: KernelAttestationEvidence;
}> {
  const provider = options.provider ?? "openai";
  const model = options.model ?? "gpt-realtime-test";
  const status = options.status ?? "completed";
  const pairInvariants = pairInvariantsHash(options.pairId, options.scenarioId, provider, model);
  const executionPlan = executionPlanSha256(options.runId, options.condition);
  const { scenario, suite } = compiledFixture(options.scenarioId);
  const condition = suite.conditions[options.condition];
  const world = createToolWorld(scenario);
  const flowState = options.condition === "full-harness"
    ? createFlowExecutionState("2026-07-10T12:00:00.000Z")
    : null;
  const capabilityHead = createBenchmarkKernelCapabilityHead({
    condition,
    epoch: flowState?.capabilityEpoch ?? 0,
    target: flowState ? "$base" : "$full-catalog",
    catalogMode: "target",
    internalFlowScope: flowState ? flowCapabilityScope(flowState).step : null,
  });
  const capabilities = new Map(
    [...condition.visibleCapabilities, ...condition.disclosures.flatMap((disclosure) => disclosure.visibleCapabilities)]
      .map((capability) => [capability.name, capability] as const)
  );
  const providerVisibleCapabilitySnapshot = {
    gateway_version: 1 as const,
    scope: capabilityHead.provider_grant_scope,
    capability_epoch: capabilityHead.epoch,
    actions: capabilityHead.catalog.map((entry, index) => {
      const capability = capabilities.get(entry.name);
      if (!capability || capability.inputSchema === null || typeof capability.inputSchema !== "object" || Array.isArray(capability.inputSchema)) {
        throw new Error(`synthetic capability ${entry.name} lacks an object input schema`);
      }
      return {
        name: capability.name,
        description: capability.description,
        input_schema: capability.inputSchema,
        semantic_hash: capability.semanticHash,
        capability_grant: `fixture-grant-${index}`,
      };
    }),
  };
  const transcript = createKernelTranscript({
    runId: options.runId,
    condition,
    scenario,
    world,
    flowState,
    capabilityHead,
    providerVisibleCapabilitySnapshot,
    dataClassification: "synthetic_benchmark_only",
    sensitiveValueSecret: "report-fixture-public-commitment-secret-v1",
    durableMemoryState: condition.behavior.genericDurableMemory ? new Map() : null,
  });
  const transcriptContent = encodeKernelTranscript(transcript);
  const transcriptReference = kernelTranscriptReference(transcript);
  if (provider !== "openai" && provider !== "xai" && provider !== "gemini" && provider !== "offline") {
    throw new Error(`unsupported synthetic provider: ${provider}`);
  }
  const kernelAttestation = createBenchmarkKernelFinalAttestation({
    runId: options.runId,
    condition,
    scenario,
    world,
    capabilityHead,
    flowState,
    transcriptReference,
    evidenceBinding: {
      pairId: options.pairId,
      leaseSubjectId: options.pairId,
      provider,
      model,
      planSha256: executionPlan,
      freezeLockSha256: FREEZE_LOCK_HASH,
      kernelBuildSha256: KERNEL_BUILD_HASH,
    },
    signer: KERNEL_SIGNER,
  });
  const kernelContent = benchmarkKernelAttestationJson(kernelAttestation);
  const worldContent = `${canonicalJson(world)}\n`;
  const events = buildEventChain(options.runId, [
    {
      observed_at: "2026-07-10T12:00:00.000Z",
      event_type: "trial.started",
      payload: {
        pair_id: options.pairId,
        provider,
        model,
        condition: options.condition,
        scenario_id: options.scenarioId,
        scenario_version: "1.0.0",
        pair_invariants_hash: pairInvariants,
        freeze_lock_hash: FREEZE_LOCK_HASH,
        execution_plan_sha256: executionPlan,
        plan_hash: PLAN_HASH,
      },
    },
    {
      observed_at: "2026-07-10T12:00:01.000Z",
      event_type: "trial.finished",
      payload: { status },
    },
  ]);
  const encoded = encodeEventJsonl(events);
  const descriptor = createArtifactDescriptor("events.jsonl", encoded, "application/x-ndjson");
  const kernelDescriptor = createArtifactDescriptor("kernel-attestation.json", kernelContent, "application/json");
  const transcriptDescriptor = createArtifactDescriptor("kernel-transcript.jsonl", transcriptContent, "application/x-ndjson");
  const worldDescriptor = createArtifactDescriptor("world-final.json", worldContent, "application/json");
  const manifest = createRunManifest({
    run_id: options.runId,
    created_at: "2026-07-10T12:00:02.000Z",
    artifacts: [descriptor, kernelDescriptor, transcriptDescriptor, worldDescriptor],
    event_log: {
      path: descriptor.path,
      event_count: events.length,
      chain_head: events[events.length - 1].event_hash,
    },
    metadata: {
      benchmark: "voice-long-horizon",
      pair_id: options.pairId,
      provider,
      model,
      condition: options.condition,
      status,
      scenario_id: options.scenarioId,
      scenario_version: "1.0.0",
      pair_invariants_hash: pairInvariants,
      freeze_lock_hash: FREEZE_LOCK_HASH,
      execution_plan_sha256: executionPlan,
      plan_hash: PLAN_HASH,
      kernel_build_sha256: KERNEL_BUILD_HASH,
      lease_subject_id: options.pairId,
      condition_hash: condition.conditionHash,
      source_hash: condition.sourceHash,
      scenario_hash: condition.scenarioHash,
      flow_hash: condition.flowHash,
      kernel_attestation: benchmarkKernelAttestationReference(kernelAttestation),
      kernel_transcript: transcriptReference,
    },
  });
  return {
    manifest,
    events,
    kernel: Object.freeze({
      attestation: Object.freeze({ path: "kernel-attestation.json", content: kernelContent }),
      transcript: Object.freeze({ path: "kernel-transcript.jsonl", content: transcriptContent }),
      world: Object.freeze({ path: "world-final.json", content: worldContent }),
      condition,
      scenario,
    }),
  };
}

function makeBundle(options: BundleOptions): BenchmarkRunBundle {
  const source = makeSource(options);
  const provider = options.provider ?? "openai";
  const model = options.model ?? "gpt-realtime-test";
  const status = options.status ?? "completed";
  const attempted = options.attempted ?? 4;
  const blocked = options.blocked ?? (options.condition === "full-harness" ? 1 : 0);
  const executed = options.executed ?? Math.max(0, attempted - blocked);
  const verified = options.verified ?? executed;
  const unauthorizedAttempts = options.modelFailure ? 1 : 0;
  const failures = [
    ...(options.modelFailure ? [{ turn: 2, scope: "model" as const, kind: "stale_slot" }] : []),
    ...(options.systemFailure ? [{ turn: 3, scope: "system" as const, kind: "unsafe_effect" }] : []),
  ];
  const score: RunScoreArtifact = {
    schema_version: 1,
    run_id: options.runId,
    source_manifest_hash: source.manifest.manifest_hash,
    source_event_chain_head: source.events[source.events.length - 1].event_hash,
    pair_id: options.pairId,
    scenario_id: options.scenarioId,
    scenario_version: "1.0.0",
    provider,
    model,
    condition: options.condition,
    status,
    failure: options.strictPass
      ? { class: "none", code: null }
      : status === "completed"
        ? { class: "task", code: "strict_endpoint_failed" }
        : { class: "provider", code: "connection_closed" },
    strict: {
      pass: options.strictPass,
      failed_criteria: options.strictPass ? [] : ["correct_final_world_state"],
    },
    integrity: {
      planned_turns: 4,
      observed_turns: status === "completed" ? 4 : 2,
      failures,
    },
    actions: {
      attempted,
      admitted: executed,
      blocked,
      unauthorized_attempts: unauthorizedAttempts,
      blocked_unauthorized_attempts: Math.min(blocked, unauthorizedAttempts),
      duplicate_attempts: 0,
      duplicate_suppressed: 0,
      executed,
      verified,
      committed: verified,
      unsafe_executed: options.systemFailure ? 1 : 0,
      irreversible_executed: Math.min(executed, 1),
      duplicate_irreversible_effects: 0,
    },
    cost: {
      estimated_micro_usd: options.estimatedCostMicroUsd !== undefined
        ? options.estimatedCostMicroUsd
        : options.costMicroUsd ?? 100_000,
      provider_reported_micro_usd: options.providerReportedCostMicroUsd ?? null,
      reconciled_micro_usd: options.reconciledCostMicroUsd !== undefined
        ? options.reconciledCostMicroUsd
        : options.costMicroUsd ?? 100_000,
    },
    latency_ms: {
      first_audio: options.firstAudioMs ?? 200,
      turn_completion: [400, 500],
      tool_round_trip: executed > 0 ? [100] : [],
    },
    audibility: {
      response_count: 4,
      scorable_response_count: 4,
      audible_state_divergence_checkpoint_count: options.systemFailure ? 1 : 0,
      interrupted_response_count: 1,
      interrupted_material_exposure_count: 1,
      unheard_content_leakage_response_count: options.systemFailure ? 1 : 0,
      dependency_analysis_complete: true,
      detected_divergence_count: 1,
      repaired_before_action_count: options.systemFailure ? 0 : 1,
    },
    evaluator: {
      id: "deterministic-evaluator",
      version_hash: EVALUATOR_HASH,
      all_manifest_artifacts_verified: true,
      verified_artifact_count: source.manifest.artifacts.length,
    },
  };
  const bareScore = createImmutableScoreArtifact("evaluation/score.json", score);
  const signedScore = createImmutableScoreArtifact(
    "evaluation/score.json",
    score,
    attest(
      scoreAttestationPayload(
        bareScore.path,
        bareScore.sha256,
        EVALUATOR_KEY_ID,
        "2026-07-10T13:00:00.000Z"
      ),
      "2026-07-10T13:00:00.000Z",
      EVALUATOR_KEY_ID,
      EVALUATOR_PRIVATE_KEY
    )
  );
  return Object.freeze({
    ...source,
    score: signedScore,
  });
}

function baseInput(bundles: readonly BenchmarkRunBundle[]) {
  return {
    report_id: "synthetic-report-1",
    protocol_id: "HACC-LHVR-v0.1",
    generated_at: "2026-07-10T14:00:00.000Z",
    phase: "exploratory" as const,
    baseline_condition: "raw-memory",
    treatment_condition: "full-harness",
    bundles,
    bootstrap_iterations: 500,
    seed: "synthetic-seed",
    trusted_registration_keys: { [REGISTRATION_KEY_ID]: REGISTRATION_PUBLIC_PEM },
    trusted_evaluator_keys: { [EVALUATOR_KEY_ID]: EVALUATOR_PUBLIC_PEM },
    trusted_kernel_keys: { [KERNEL_KEY_ID]: KERNEL_PUBLIC_PEM },
  };
}

describe("deterministic benchmark reporting", () => {
  it("reports strict paired effects, separate model/system integrity, effects, cost, latency, and audibility", () => {
    const bundles = [
      makeBundle({ runId: "p1-raw", pairId: "p1", scenarioId: "s1", condition: "raw-memory", strictPass: false, modelFailure: true, costMicroUsd: 100_000 }),
      makeBundle({ runId: "p1-harness", pairId: "p1", scenarioId: "s1", condition: "full-harness", strictPass: true, costMicroUsd: 150_000 }),
      makeBundle({ runId: "p2-raw", pairId: "p2", scenarioId: "s2", condition: "raw-memory", strictPass: false, systemFailure: true, costMicroUsd: 100_000 }),
      makeBundle({ runId: "p2-harness", pairId: "p2", scenarioId: "s2", condition: "full-harness", strictPass: true, costMicroUsd: 150_000 }),
      makeBundle({ runId: "p3-raw", pairId: "p3", scenarioId: "s3", condition: "raw-memory", strictPass: true, costMicroUsd: 100_000 }),
      makeBundle({ runId: "p3-harness", pairId: "p3", scenarioId: "s3", condition: "full-harness", strictPass: true, costMicroUsd: 150_000 }),
      makeBundle({ runId: "p4-raw", pairId: "p4", scenarioId: "s4", condition: "raw-memory", strictPass: false, modelFailure: true, costMicroUsd: 100_000 }),
      makeBundle({ runId: "p4-harness", pairId: "p4", scenarioId: "s4", condition: "full-harness", strictPass: false, modelFailure: true, costMicroUsd: 150_000 }),
    ];
    const report = generateBenchmarkReport(baseInput(bundles));

    expect(report.headline_effects.strict_success).toMatchObject({
      complete_pairs: 4,
      both_succeeded: 1,
      treatment_only_succeeded: 2,
      baseline_only_succeeded: 0,
      neither_succeeded: 1,
      estimate: 0.5,
      scenario_clusters: 4,
    });
    expect(report.headline_effects.model_integrity.estimate).toBe(0.25);
    expect(report.headline_effects.system_integrity.estimate).toBe(0.25);

    const raw = report.conditions.find((condition) => condition.condition === "raw-memory")!;
    const harness = report.conditions.find((condition) => condition.condition === "full-harness")!;
    expect(raw.strict_success).toMatchObject({ numerator: 1, denominator: 4, rate: 0.25 });
    expect(harness.strict_success).toMatchObject({ numerator: 3, denominator: 4, rate: 0.75 });
    expect(raw.actions).toMatchObject({ attempted: 16, blocked: 0, executed: 16, verified: 16 });
    expect(harness.actions).toMatchObject({ attempted: 16, blocked: 4, executed: 12, verified: 12 });
    expect(raw.cost).toMatchObject({
      complete: true,
      known_total_micro_usd: 400_000,
      cost_per_strict_success_usd: "0.400000",
    });
    expect(harness.cost).toMatchObject({
      complete: true,
      known_total_micro_usd: 600_000,
      cost_per_strict_success_usd: "0.200000",
    });
    expect(raw.latency_ms.first_audio).toMatchObject({ count: 4, median: 200, p95: 200 });
    expect(raw.audibility).toMatchObject({
      interrupted_material_exposure_count: 4,
      unheard_content_leakage_response_count: 1,
      unheard_content_leakage_rate: 0.25,
    });
    expect(raw.integrity.model_curve.map((point) => point.intact_trials)).toEqual([4, 2, 2, 2]);
    expect(report.claim_gate).toMatchObject({ design_eligible: false });
    expect(report.claim_gate.strict_success.allowed_language).toContain("descriptive only");
    expect(report.claim_gate.system_integrity.unsupported_language.join(" ")).toContain("model itself");
  });

  it("is byte-deterministic across input order and renders both JSON and guarded Markdown", () => {
    const bundles = [
      makeBundle({ runId: "a-raw", pairId: "a", scenarioId: "s1", condition: "raw-memory", strictPass: false }),
      makeBundle({ runId: "a-harness", pairId: "a", scenarioId: "s1", condition: "full-harness", strictPass: true }),
      makeBundle({ runId: "b-raw", pairId: "b", scenarioId: "s2", condition: "raw-memory", strictPass: true }),
      makeBundle({ runId: "b-harness", pairId: "b", scenarioId: "s2", condition: "full-harness", strictPass: true }),
    ];
    const forward = generateBenchmarkReport(baseInput(bundles));
    const reverse = generateBenchmarkReport(baseInput([...bundles].reverse()));

    expect(renderBenchmarkReportJson(forward)).toBe(renderBenchmarkReportJson(reverse));
    const changedAnalysis = generateBenchmarkReport({ ...baseInput(bundles), seed: "different-seed" });
    expect(changedAnalysis.source_artifact_digest).toBe(forward.source_artifact_digest);
    expect(changedAnalysis.analysis_digest).not.toBe(forward.analysis_digest);
    expect(changedAnalysis.input_digest).not.toBe(forward.input_digest);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.data_quality.audits)).toBe(true);
    const markdown = renderBenchmarkReportMarkdown(forward);
    expect(markdown).toContain("## Paired headline effects");
    expect(markdown).toContain("## Provider/model strata");
    expect(markdown).toContain("runtime containment proves improved model alignment");
    expect(markdown).toContain("Protocol fail-closed strict failures");
  });

  it("counts a missing score as a strict failure without inventing component, cost, or audibility values", () => {
    const complete = makeBundle({ runId: "pair-raw", pairId: "pair", scenarioId: "scenario", condition: "raw-memory", strictPass: true });
    const missingSource = makeSource({ runId: "pair-harness", pairId: "pair", scenarioId: "scenario", condition: "full-harness", strictPass: false });
    const missing: BenchmarkRunBundle = { ...missingSource, score: null };
    const report = generateBenchmarkReport(baseInput([complete, missing]));
    const harness = report.conditions.find((condition) => condition.condition === "full-harness")!;

    expect(report.data_quality).toMatchObject({
      protocol_fail_closed_endpoint_count: 1,
      evaluator_score_count: 1,
      artifact_class_counts: { score_missing: 1, valid: 1 },
    });
    expect(harness.strict_success).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
    expect(harness.actions).toMatchObject({ runs_with_component_metrics: 0, attempted: 0 });
    expect(harness.cost).toMatchObject({ complete: false, runs_with_cost: 0, unavailable_reason: "missing_cost" });
    expect(harness.integrity.model_curve).toEqual([]);
    expect(report.headline_effects.strict_success).toMatchObject({ complete_pairs: 1, estimate: -1 });
    expect(report.headline_effects.model_integrity.complete_pairs).toBe(0);
  });

  it("detects tampering and excludes an untrusted manifest identity from denominators", () => {
    const good = makeBundle({ runId: "good", pairId: "pair", scenarioId: "scenario", condition: "raw-memory", strictPass: true });
    const tampered = {
      ...good,
      manifest: { ...good.manifest, metadata: { ...good.manifest.metadata as object, pair_id: "forged" } },
    } as BenchmarkRunBundle;
    const report = generateBenchmarkReport(baseInput([tampered]));

    expect(report.data_quality).toMatchObject({
      bundle_count: 1,
      trusted_identity_count: 0,
      untrusted_bundle_count: 1,
      artifact_class_counts: { manifest_invalid: 1 },
    });
    expect(report.conditions).toEqual([]);
    expect(report.headline_effects.strict_success.complete_pairs).toBe(0);
    expect(report.claim_gate.reasons).toContain("at least one supplied bundle has an untrusted manifest identity");
  });

  it("keeps legacy scores descriptive and rejects trusted-key arbitrary rescoring even when design and CI gates support benefit", () => {
    const pairIds = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const bundles = pairIds.flatMap((pairId, index) => [
      makeBundle({ runId: `${pairId}-raw`, pairId, scenarioId: `s${index}`, condition: "raw-memory", strictPass: false, modelFailure: true, systemFailure: true }),
      makeBundle({ runId: `${pairId}-harness`, pairId, scenarioId: `s${index}`, condition: "full-harness", strictPass: true }),
    ]);
    const registration = attestRegistration({
      status: "frozen",
      registration_id: "registration-1",
      analysis_plan_hash: ANALYSIS_HASH,
      freeze_lock_hash: FREEZE_LOCK_HASH,
      plan_hash: PLAN_HASH,
      frozen_at: "2026-07-10T11:00:00.000Z",
      freeze_ref: "refs/tags/hacc-freeze-v1",
      registration_attestation_key_id: REGISTRATION_KEY_ID,
      registration_attestation_public_key_sha256: REGISTRATION_PUBLIC_FINGERPRINT,
      evaluator_attestation_key_id: EVALUATOR_KEY_ID,
      evaluator_attestation_public_key_sha256: EVALUATOR_PUBLIC_FINGERPRINT,
      kernel_attestation_key_id: KERNEL_KEY_ID,
      kernel_attestation_public_key_sha256: KERNEL_PUBLIC_FINGERPRINT,
      kernel_build_sha256: KERNEL_BUILD_HASH,
      protocol_id: "HACC-LHVR-v0.1",
      evaluator_version_hash: EVALUATOR_HASH,
      baseline_condition: "raw-memory",
      treatment_condition: "full-harness",
      confidence_level: 0.95,
      reliable_horizon_thresholds: [0.9, 0.95],
      bootstrap_iterations: 500,
      seed: "synthetic-seed",
      expected_pairs: pairIds.map((pairId, index) => ({
        pair_id: pairId,
        provider: "openai",
        model: "gpt-realtime-test",
        scenario_id: `s${index}`,
        scenario_version: "1.0.0",
        baseline_run_id: `${pairId}-raw`,
        treatment_run_id: `${pairId}-harness`,
        baseline_execution_plan_sha256: executionPlanSha256(`${pairId}-raw`, "raw-memory"),
        treatment_execution_plan_sha256: executionPlanSha256(`${pairId}-harness`, "full-harness"),
        pair_invariants_hash: pairInvariantsHash(pairId, `s${index}`, "openai", "gpt-realtime-test"),
      })),
      minimum_complete_pairs_per_stratum: 8,
      minimum_scenario_clusters_per_stratum: 8,
      provider_weights: { [benchmarkProviderStratumKey("openai", "gpt-realtime-test")]: 1 },
      minimally_important_strict_risk_difference: 0,
      allow_fail_closed_artifact_endpoints: false,
      claim_multiplicity: { strategy: "primary_only", primary_endpoint: "strict_success" },
    });
    const report = generateBenchmarkReport({
      ...baseInput(bundles),
      phase: "confirmatory",
      registration,
    });

    expect(report.claim_gate).toMatchObject({
      design_eligible: false,
      strict_success: { outcome: "not_eligible" },
      model_integrity: { outcome: "not_eligible" },
      system_integrity: { outcome: "not_eligible" },
    });
    expect(report.claim_gate.reasons).toContain(LEGACY_SCORE_CLAIM_BLOCK_REASON);
    expect(report.claim_gate.strict_success.allowed_language).toContain("descriptive only");
    expect(report.claim_gate.strict_success.allowed_language).not.toContain("proven");

    const threePairReport = generateBenchmarkReport({
      ...baseInput(bundles.slice(0, 6)),
      phase: "confirmatory",
      registration: reviseRegistration(registration, {
        expected_pairs: registration.expected_pairs.slice(0, 3),
        minimum_complete_pairs_per_stratum: 3,
        minimum_scenario_clusters_per_stratum: 3,
      }),
    });
    expect(threePairReport.claim_gate.design_eligible).toBe(false);
    expect(threePairReport.headline_effects.strict_success).toMatchObject({
      estimate: 1,
      paired_randomization_p_value: 0.25,
    });
    expect(threePairReport.claim_gate.strict_success.outcome).toBe("not_eligible");

    const underpowered = generateBenchmarkReport({
      ...baseInput(bundles),
      phase: "confirmatory",
      registration: reviseRegistration(registration, { minimum_complete_pairs_per_stratum: 9 }),
    });
    expect(underpowered.claim_gate).toMatchObject({
      design_eligible: false,
      strict_success: { outcome: "not_eligible" },
    });
    expect(underpowered.claim_gate.reasons.join(" ")).toContain("9 were required");

    const selectiveRetry = generateBenchmarkReport({
      ...baseInput(bundles),
      phase: "confirmatory",
      registration: reviseRegistration(registration, {
        expected_pairs: [
          { ...registration.expected_pairs[0], baseline_run_id: "unregistered-retry" },
          ...registration.expected_pairs.slice(1),
        ],
      }),
    });
    expect(selectiveRetry.claim_gate.design_eligible).toBe(false);
    expect(selectiveRetry.claim_gate.reasons.join(" ")).toContain("differs from registered unregistered-retry");

    const differentPlan = generateBenchmarkReport({
      ...baseInput(bundles),
      phase: "confirmatory",
      registration: reviseRegistration(registration, { plan_hash: "7".repeat(64) }),
    });
    expect(differentPlan.claim_gate.design_eligible).toBe(false);
    expect(differentPlan.claim_gate.reasons.join(" ")).toContain("plan hash differs from registration");

    const signatureTamper = generateBenchmarkReport({
      ...baseInput(bundles),
      phase: "confirmatory",
      registration: { ...registration, minimum_complete_pairs_per_stratum: 1 },
    });
    expect(signatureTamper.claim_gate.design_eligible).toBe(false);
    expect(signatureTamper.claim_gate.reasons).toContain("claim registration attestation is not verified by a configured trust key");

    const forgedParsed = JSON.parse(String(bundles[0].score!.content)) as RunScoreArtifact;
    const selfRehashedScore: RunScoreArtifact = {
      ...forgedParsed,
      failure: { class: "none", code: null },
      strict: { pass: true, failed_criteria: [] },
      actions: { ...forgedParsed.actions, unsafe_executed: 0 },
    };
    const selfRehashed = generateBenchmarkReport({
      ...baseInput([
        { ...bundles[0], score: createImmutableScoreArtifact("evaluation/score.json", selfRehashedScore) },
        ...bundles.slice(1),
      ]),
      phase: "confirmatory",
      registration,
    });
    expect(selfRehashed.data_quality.verified_evaluator_attestation_count).toBe(bundles.length - 1);
    expect(selfRehashed.claim_gate.design_eligible).toBe(false);
    expect(selfRehashed.claim_gate.reasons.join(" ")).toContain("lack a verified detached attestation");

    // A trusted evaluator key can re-sign arbitrary schema-v1 endpoint values.
    // The legacy stop-gate must survive a cryptographically valid forgery, not
    // merely reject a missing or stale detached signature.
    const forgedBareScore = createImmutableScoreArtifact("evaluation/score.json", selfRehashedScore);
    const forgedSignedScore = createImmutableScoreArtifact(
      "evaluation/score.json",
      selfRehashedScore,
      attest(
        scoreAttestationPayload(
          forgedBareScore.path,
          forgedBareScore.sha256,
          EVALUATOR_KEY_ID,
          "2026-07-10T13:30:00.000Z"
        ),
        "2026-07-10T13:30:00.000Z",
        EVALUATOR_KEY_ID,
        EVALUATOR_PRIVATE_KEY
      )
    );
    const trustedKeyForgery = generateBenchmarkReport({
      ...baseInput([
        { ...bundles[0], score: forgedSignedScore },
        ...bundles.slice(1),
      ]),
      phase: "confirmatory",
      registration,
    });
    expect(trustedKeyForgery.data_quality.verified_evaluator_attestation_count).toBe(bundles.length);
    expect(trustedKeyForgery.claim_gate.design_eligible).toBe(false);
    expect(trustedKeyForgery.claim_gate.reasons).toContain(LEGACY_SCORE_CLAIM_BLOCK_REASON);
    expect(trustedKeyForgery.claim_gate.strict_success.outcome).toBe("not_eligible");
    // This correctness test builds and cryptographically verifies 16 complete
    // synthetic bundles across several counterfactual reports. Its statistical
    // and fail-closed assertions above are the subject; wall-clock performance
    // is neither measured nor claimed here.
  }, 60_000);

  it("requires a manifest-bound trusted kernel proof and distinct frozen execution plans for every claim cell", () => {
    const raw = makeBundle({
      runId: "kernel-proof-raw",
      pairId: "kernel-proof-pair",
      scenarioId: "kernel-proof-scenario",
      condition: "raw-memory",
      strictPass: false,
    });
    const harness = makeBundle({
      runId: "kernel-proof-harness",
      pairId: "kernel-proof-pair",
      scenarioId: "kernel-proof-scenario",
      condition: "full-harness",
      strictPass: true,
    });
    const registration = attestRegistration({
      status: "frozen",
      registration_id: "kernel-proof-registration",
      analysis_plan_hash: ANALYSIS_HASH,
      freeze_lock_hash: FREEZE_LOCK_HASH,
      plan_hash: PLAN_HASH,
      frozen_at: "2026-07-10T11:00:00.000Z",
      freeze_ref: "refs/tags/kernel-proof-freeze",
      registration_attestation_key_id: REGISTRATION_KEY_ID,
      registration_attestation_public_key_sha256: REGISTRATION_PUBLIC_FINGERPRINT,
      evaluator_attestation_key_id: EVALUATOR_KEY_ID,
      evaluator_attestation_public_key_sha256: EVALUATOR_PUBLIC_FINGERPRINT,
      kernel_attestation_key_id: KERNEL_KEY_ID,
      kernel_attestation_public_key_sha256: KERNEL_PUBLIC_FINGERPRINT,
      kernel_build_sha256: KERNEL_BUILD_HASH,
      protocol_id: "HACC-LHVR-v0.1",
      evaluator_version_hash: EVALUATOR_HASH,
      baseline_condition: "raw-memory",
      treatment_condition: "full-harness",
      confidence_level: 0.95,
      reliable_horizon_thresholds: [0.9, 0.95],
      bootstrap_iterations: 500,
      seed: "synthetic-seed",
      expected_pairs: [{
        pair_id: "kernel-proof-pair",
        provider: "openai",
        model: "gpt-realtime-test",
        scenario_id: "kernel-proof-scenario",
        scenario_version: "1.0.0",
        baseline_run_id: "kernel-proof-raw",
        treatment_run_id: "kernel-proof-harness",
        baseline_execution_plan_sha256: executionPlanSha256("kernel-proof-raw", "raw-memory"),
        treatment_execution_plan_sha256: executionPlanSha256("kernel-proof-harness", "full-harness"),
        pair_invariants_hash: pairInvariantsHash(
          "kernel-proof-pair",
          "kernel-proof-scenario",
          "openai",
          "gpt-realtime-test"
        ),
      }],
      minimum_complete_pairs_per_stratum: 1,
      minimum_scenario_clusters_per_stratum: 1,
      provider_weights: { [benchmarkProviderStratumKey("openai", "gpt-realtime-test")]: 1 },
      minimally_important_strict_risk_difference: 0,
      allow_fail_closed_artifact_endpoints: false,
      claim_multiplicity: { strategy: "primary_only", primary_endpoint: "strict_success" },
    });
    const confirmatoryInput = (bundles: readonly BenchmarkRunBundle[]) => ({
      ...baseInput(bundles),
      phase: "confirmatory" as const,
      registration,
    });

    const valid = generateBenchmarkReport(confirmatoryInput([raw, harness]));
    expect(valid.claim_gate.design_eligible).toBe(false);
    expect(valid.claim_gate.reasons).toContain(LEGACY_SCORE_CLAIM_BLOCK_REASON);
    expect(valid.data_quality).toMatchObject({
      verified_kernel_attestation_count: 2,
      verified_kernel_signature_count: 2,
      verified_kernel_transcript_count: 2,
      verified_evaluator_attestation_count: 2,
    });
    expect(valid.data_quality.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kernel_transcript_verified: true,
        kernel_transcript_authenticity: "signed_attestation_verified",
      }),
    ]));
    const rawMetadata = raw.manifest.metadata;
    const harnessMetadata = harness.manifest.metadata;
    if (!isPlainRecord(rawMetadata)) {
      throw new Error("synthetic raw manifest metadata is not an object");
    }
    if (!isPlainRecord(harnessMetadata)) {
      throw new Error("synthetic harness manifest metadata is not an object");
    }
    expect(rawMetadata.plan_hash).toBe(PLAN_HASH);
    expect(harnessMetadata.plan_hash).toBe(PLAN_HASH);
    expect(rawMetadata.execution_plan_sha256).not.toBe(harnessMetadata.execution_plan_sha256);

    const missing = generateBenchmarkReport(confirmatoryInput([{ ...raw, kernel: null }, harness]));
    expect(missing.claim_gate.design_eligible).toBe(false);
    expect(missing.data_quality.artifact_class_counts).toMatchObject({ kernel_attestation_missing: 1 });
    expect(missing.claim_gate.reasons.join(" ")).toContain("lack a manifest-bound replayed kernel transcript with a verified signature");

    if (!raw.kernel) throw new Error("synthetic bundle lacks kernel evidence");
    if (!harness.kernel) throw new Error("synthetic harness bundle lacks kernel evidence");
    const kernelWithoutTranscript = {
      attestation: raw.kernel.attestation,
      world: raw.kernel.world,
      condition: raw.kernel.condition,
      scenario: raw.kernel.scenario,
    };
    const missingTranscript = generateBenchmarkReport(confirmatoryInput([{
      ...raw,
      kernel: kernelWithoutTranscript as unknown as KernelAttestationEvidence,
    }, harness]));
    expect(missingTranscript.claim_gate.design_eligible).toBe(false);
    expect(missingTranscript.data_quality.artifact_class_counts).toMatchObject({ kernel_transcript_missing: 1 });
    expect(missingTranscript.data_quality.verified_kernel_transcript_count).toBe(1);

    const transcriptDescriptorMissingManifest = createRunManifest({
      run_id: raw.manifest.run_id,
      created_at: raw.manifest.created_at,
      artifacts: raw.manifest.artifacts.filter((artifact) => artifact.path !== "kernel-transcript.jsonl"),
      event_log: raw.manifest.event_log,
      metadata: raw.manifest.metadata,
    });
    const transcriptDescriptorMissing = generateBenchmarkReport(confirmatoryInput([{
      ...raw,
      manifest: transcriptDescriptorMissingManifest,
    }, harness]));
    expect(transcriptDescriptorMissing.claim_gate.design_eligible).toBe(false);
    expect(transcriptDescriptorMissing.data_quality.artifact_class_counts).toMatchObject({ kernel_transcript_missing: 1 });

    const transcriptReferenceMissingManifest = createRunManifest({
      run_id: raw.manifest.run_id,
      created_at: raw.manifest.created_at,
      artifacts: raw.manifest.artifacts,
      event_log: raw.manifest.event_log,
      metadata: Object.fromEntries(
        Object.entries(rawMetadata).filter(([key]) => key !== "kernel_transcript")
      ),
    });
    const transcriptReferenceMissing = generateBenchmarkReport(confirmatoryInput([{
      ...raw,
      manifest: transcriptReferenceMissingManifest,
    }, harness]));
    expect(transcriptReferenceMissing.claim_gate.design_eligible).toBe(false);
    expect(transcriptReferenceMissing.data_quality.artifact_class_counts).toMatchObject({ identity_missing: 1 });

    const byteTamperedTranscript = `${String(raw.kernel.transcript.content)}\n`;
    const byteTampered = generateBenchmarkReport(confirmatoryInput([{
      ...raw,
      kernel: {
        ...raw.kernel,
        transcript: { path: "kernel-transcript.jsonl", content: byteTamperedTranscript },
      },
    }, harness]));
    expect(byteTampered.claim_gate.design_eligible).toBe(false);
    expect(byteTampered.data_quality.artifact_class_counts).toMatchObject({ kernel_transcript_invalid: 1 });
    expect(byteTampered.data_quality.audits.flatMap((audit) => audit.errors).join(" ")).toContain(
      "kernel transcript bytes do not match the exact manifest descriptor"
    );

    const rehashedTamperedTranscript = String(raw.kernel.transcript.content).replaceAll(
      raw.manifest.run_id,
      "tampered-cross-run-id"
    );
    const rehashedTamperedDescriptor = createArtifactDescriptor(
      "kernel-transcript.jsonl",
      rehashedTamperedTranscript,
      "application/x-ndjson"
    );
    const rehashedTamperedManifest = createRunManifest({
      run_id: raw.manifest.run_id,
      created_at: raw.manifest.created_at,
      artifacts: raw.manifest.artifacts.map((artifact) =>
        artifact.path === rehashedTamperedDescriptor.path ? rehashedTamperedDescriptor : artifact),
      event_log: raw.manifest.event_log,
      metadata: raw.manifest.metadata,
    });
    const rehashedTampered = generateBenchmarkReport(confirmatoryInput([{
      ...raw,
      manifest: rehashedTamperedManifest,
      kernel: {
        ...raw.kernel,
        transcript: { path: "kernel-transcript.jsonl", content: rehashedTamperedTranscript },
      },
    }, harness]));
    expect(rehashedTampered.claim_gate.design_eligible).toBe(false);
    expect(rehashedTampered.data_quality.artifact_class_counts).toMatchObject({ kernel_transcript_binding_mismatch: 1 });
    expect(rehashedTampered.data_quality.audits.find((audit) => audit.run_id === raw.manifest.run_id)).toMatchObject({
      kernel_signature_verified: true,
      kernel_transcript_verified: false,
      kernel_transcript_authenticity: "signed_attestation_verified",
    });

    const crossViewTranscript = String(raw.kernel.transcript.content).replaceAll(
      "benchmark_kernel_replay_public_commitment",
      "benchmark_kernel_replay_restricted_exact"
    );
    const crossViewDescriptor = createArtifactDescriptor(
      "kernel-transcript.jsonl",
      crossViewTranscript,
      "application/x-ndjson"
    );
    const crossViewManifest = createRunManifest({
      run_id: raw.manifest.run_id,
      created_at: raw.manifest.created_at,
      artifacts: raw.manifest.artifacts.map((artifact) =>
        artifact.path === crossViewDescriptor.path ? crossViewDescriptor : artifact),
      event_log: raw.manifest.event_log,
      metadata: raw.manifest.metadata,
    });
    const crossView = generateBenchmarkReport(confirmatoryInput([{
      ...raw,
      manifest: crossViewManifest,
      kernel: {
        ...raw.kernel,
        transcript: { path: "kernel-transcript.jsonl", content: crossViewTranscript },
      },
    }, harness]));
    expect(crossView.claim_gate.design_eligible).toBe(false);
    expect(crossView.data_quality.artifact_class_counts).toMatchObject({ kernel_transcript_invalid: 1 });

    const substitutedTranscriptDescriptor = createArtifactDescriptor(
      "kernel-transcript.jsonl",
      harness.kernel.transcript.content,
      "application/x-ndjson"
    );
    const substitutedTranscriptManifest = createRunManifest({
      run_id: raw.manifest.run_id,
      created_at: raw.manifest.created_at,
      artifacts: raw.manifest.artifacts.map((artifact) =>
        artifact.path === substitutedTranscriptDescriptor.path ? substitutedTranscriptDescriptor : artifact),
      event_log: raw.manifest.event_log,
      metadata: {
        ...rawMetadata,
        kernel_transcript: harnessMetadata.kernel_transcript,
      },
    });
    const substitutedTranscript = generateBenchmarkReport(confirmatoryInput([{
      ...raw,
      manifest: substitutedTranscriptManifest,
      kernel: {
        ...raw.kernel,
        transcript: harness.kernel.transcript,
      },
    }, harness]));
    expect(substitutedTranscript.claim_gate.design_eligible).toBe(false);
    expect(substitutedTranscript.data_quality.audits.flatMap((audit) => audit.errors).join(" ")).toContain(
      "signed kernel transcript reference does not exactly match manifest metadata"
    );

    const tamperedAttestation = JSON.parse(String(raw.kernel.attestation.content)) as {
      signature: { signature_base64: string };
    };
    const signatureBytes = Buffer.from(tamperedAttestation.signature.signature_base64, "base64");
    signatureBytes[0] ^= 1;
    tamperedAttestation.signature.signature_base64 = signatureBytes.toString("base64");
    const tamperedContent = `${canonicalJson(tamperedAttestation)}\n`;
    const tamperedDescriptor = createArtifactDescriptor("kernel-attestation.json", tamperedContent, "application/json");
    const tamperedManifest = createRunManifest({
      run_id: raw.manifest.run_id,
      created_at: raw.manifest.created_at,
      artifacts: raw.manifest.artifacts.map((descriptor) =>
        descriptor.path === tamperedDescriptor.path ? tamperedDescriptor : descriptor),
      event_log: raw.manifest.event_log,
      metadata: raw.manifest.metadata,
    });
    const tampered = generateBenchmarkReport(confirmatoryInput([{
      ...raw,
      manifest: tamperedManifest,
      kernel: {
        ...raw.kernel,
        attestation: { path: "kernel-attestation.json", content: tamperedContent },
      },
    }, harness]));
    expect(tampered.claim_gate.design_eligible).toBe(false);
    expect(tampered.data_quality.artifact_class_counts).toMatchObject({ kernel_attestation_binding_mismatch: 1 });
    expect(tampered.data_quality.audits.find((audit) => audit.run_id === raw.manifest.run_id)).toMatchObject({
      kernel_attestation_verified: false,
      kernel_signature_verified: false,
    });
    expect(tampered.data_quality.audits.flatMap((audit) => audit.errors).join(" ")).toContain("signature verification failed");

    const originalReference = rawMetadata.kernel_attestation as Record<string, unknown>;
    const referenceManifest = createRunManifest({
      run_id: raw.manifest.run_id,
      created_at: raw.manifest.created_at,
      artifacts: raw.manifest.artifacts,
      event_log: raw.manifest.event_log,
      metadata: {
        ...rawMetadata,
        kernel_attestation: { ...originalReference, attestation_hash: "1".repeat(64) },
      },
    });
    const badReference = generateBenchmarkReport(confirmatoryInput([{ ...raw, manifest: referenceManifest }, harness]));
    expect(badReference.claim_gate.design_eligible).toBe(false);
    expect(badReference.data_quality.audits.find((audit) => audit.run_id === raw.manifest.run_id)).toMatchObject({
      artifact_class: "kernel_attestation_binding_mismatch",
      kernel_signature_verified: true,
      kernel_attestation_verified: false,
    });
    expect(badReference.data_quality.audits.flatMap((audit) => audit.errors).join(" ")).toContain(
      "reference does not exactly match manifest metadata"
    );

    const originalTranscriptReference = rawMetadata.kernel_transcript as Record<string, unknown>;
    const transcriptReferenceManifest = createRunManifest({
      run_id: raw.manifest.run_id,
      created_at: raw.manifest.created_at,
      artifacts: raw.manifest.artifacts,
      event_log: raw.manifest.event_log,
      metadata: {
        ...rawMetadata,
        kernel_transcript: { ...originalTranscriptReference, transcript_sha256: "2".repeat(64) },
      },
    });
    const badTranscriptReference = generateBenchmarkReport(confirmatoryInput([{
      ...raw,
      manifest: transcriptReferenceManifest,
    }, harness]));
    expect(badTranscriptReference.claim_gate.design_eligible).toBe(false);
    expect(badTranscriptReference.data_quality.audits.find((audit) => audit.run_id === raw.manifest.run_id)).toMatchObject({
      artifact_class: "kernel_attestation_binding_mismatch",
      kernel_transcript_verified: false,
      kernel_transcript_authenticity: "signed_attestation_invalid",
    });
    expect(badTranscriptReference.data_quality.audits.flatMap((audit) => audit.errors).join(" ")).toContain(
      "signed kernel transcript reference does not exactly match manifest metadata"
    );

    const substitutedPair = generateKeyPairSync("ed25519");
    const substitutedPublicPem = substitutedPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const substituted = generateBenchmarkReport({
      ...confirmatoryInput([raw, harness]),
      trusted_kernel_keys: { [KERNEL_KEY_ID]: substitutedPublicPem },
    });
    expect(substituted.claim_gate.design_eligible).toBe(false);
    expect(substituted.data_quality.verified_kernel_signature_count).toBe(0);
    expect(substituted.claim_gate.reasons).toContain(
      "kernel attestation trust key does not match the frozen public-key fingerprint"
    );
  });

  it("uses frozen provider weights for the pooled confirmatory effect instead of sample-count weights", () => {
    const bundles = [
      makeBundle({ runId: "openai-raw", pairId: "openai-pair", scenarioId: "shared-scenario", provider: "openai", model: "openai-model", condition: "raw-memory", strictPass: false, modelFailure: true, systemFailure: true }),
      makeBundle({ runId: "openai-harness", pairId: "openai-pair", scenarioId: "shared-scenario", provider: "openai", model: "openai-model", condition: "full-harness", strictPass: true }),
      makeBundle({ runId: "xai-raw", pairId: "xai-pair", scenarioId: "shared-scenario", provider: "xai", model: "xai-model", condition: "raw-memory", strictPass: false, modelFailure: true, systemFailure: true }),
      makeBundle({ runId: "xai-harness", pairId: "xai-pair", scenarioId: "shared-scenario", provider: "xai", model: "xai-model", condition: "full-harness", strictPass: false, modelFailure: true, systemFailure: true }),
    ];
    const registration = attestRegistration({
      status: "frozen",
      registration_id: "weighted-registration",
      analysis_plan_hash: ANALYSIS_HASH,
      freeze_lock_hash: FREEZE_LOCK_HASH,
      plan_hash: PLAN_HASH,
      frozen_at: "2026-07-10T11:00:00.000Z",
      freeze_ref: "refs/tags/hacc-freeze-weighted",
      registration_attestation_key_id: REGISTRATION_KEY_ID,
      registration_attestation_public_key_sha256: REGISTRATION_PUBLIC_FINGERPRINT,
      evaluator_attestation_key_id: EVALUATOR_KEY_ID,
      evaluator_attestation_public_key_sha256: EVALUATOR_PUBLIC_FINGERPRINT,
      kernel_attestation_key_id: KERNEL_KEY_ID,
      kernel_attestation_public_key_sha256: KERNEL_PUBLIC_FINGERPRINT,
      kernel_build_sha256: KERNEL_BUILD_HASH,
      protocol_id: "HACC-LHVR-v0.1",
      evaluator_version_hash: EVALUATOR_HASH,
      baseline_condition: "raw-memory",
      treatment_condition: "full-harness",
      confidence_level: 0.95,
      reliable_horizon_thresholds: [0.9, 0.95],
      bootstrap_iterations: 500,
      seed: "synthetic-seed",
      expected_pairs: [
        {
          pair_id: "openai-pair",
          provider: "openai",
          model: "openai-model",
          scenario_id: "shared-scenario",
          scenario_version: "1.0.0",
          baseline_run_id: "openai-raw",
          treatment_run_id: "openai-harness",
          baseline_execution_plan_sha256: executionPlanSha256("openai-raw", "raw-memory"),
          treatment_execution_plan_sha256: executionPlanSha256("openai-harness", "full-harness"),
          pair_invariants_hash: pairInvariantsHash("openai-pair", "shared-scenario", "openai", "openai-model"),
        },
        {
          pair_id: "xai-pair",
          provider: "xai",
          model: "xai-model",
          scenario_id: "shared-scenario",
          scenario_version: "1.0.0",
          baseline_run_id: "xai-raw",
          treatment_run_id: "xai-harness",
          baseline_execution_plan_sha256: executionPlanSha256("xai-raw", "raw-memory"),
          treatment_execution_plan_sha256: executionPlanSha256("xai-harness", "full-harness"),
          pair_invariants_hash: pairInvariantsHash("xai-pair", "shared-scenario", "xai", "xai-model"),
        },
      ],
      minimum_complete_pairs_per_stratum: 1,
      minimum_scenario_clusters_per_stratum: 1,
      provider_weights: {
        [benchmarkProviderStratumKey("openai", "openai-model")]: 0.8,
        [benchmarkProviderStratumKey("xai", "xai-model")]: 0.2,
      },
      minimally_important_strict_risk_difference: 0,
      allow_fail_closed_artifact_endpoints: false,
      claim_multiplicity: { strategy: "primary_only", primary_endpoint: "strict_success" },
    });
    const report = generateBenchmarkReport({
      ...baseInput(bundles),
      phase: "confirmatory",
      registration,
    });

    expect(report.headline_effects.strict_success).toMatchObject({
      estimate: 0.8,
      weighting: "registered_provider_weights",
      scenario_clusters: 1,
    });
    expect(report.provider_strata.find((stratum) => stratum.provider === "openai")?.effects.strict_success).toMatchObject({
      estimate: 1,
      weighting: "equal_scenario_clusters",
    });
    expect(report.provider_strata.find((stratum) => stratum.provider === "xai")?.effects.strict_success.estimate).toBe(0);
    expect(report.claim_gate.design_eligible).toBe(false);
    expect(report.claim_gate.reasons).toContain(LEGACY_SCORE_CLAIM_BLOCK_REASON);
    expect(report.claim_gate.strict_success.outcome).toBe("not_eligible");

    const wrongScenario = generateBenchmarkReport({
      ...baseInput(bundles),
      phase: "confirmatory",
      registration: reviseRegistration(registration, {
        expected_pairs: [
          { ...registration.expected_pairs[0], scenario_id: "different-scenario" },
          registration.expected_pairs[1],
        ],
      }),
    });
    expect(wrongScenario.claim_gate.design_eligible).toBe(false);
    expect(wrongScenario.claim_gate.reasons.join(" ")).toContain("differs from registered different-scenario");
  });

  it("reports UCLR as unavailable rather than zero when dependency analysis is incomplete", () => {
    const bundle = makeBundle({ runId: "audibility", pairId: "audibility-pair", scenarioId: "scenario", condition: "raw-memory", strictPass: false });
    const parsed = JSON.parse(String(bundle.score!.content)) as RunScoreArtifact;
    const rescored: RunScoreArtifact = {
      ...parsed,
      audibility: {
        ...parsed.audibility,
        interrupted_material_exposure_count: 0,
        unheard_content_leakage_response_count: 0,
        dependency_analysis_complete: false,
      },
    };
    const report = generateBenchmarkReport(baseInput([{
      ...bundle,
      score: createImmutableScoreArtifact("evaluation/score.json", rescored),
    }]));
    const audibility = report.conditions[0].audibility;
    expect(audibility).toMatchObject({
      dependency_analysis_complete_runs: 0,
      unheard_content_leakage_rate: null,
    });
    expect(audibility.notes.join(" ")).toContain("did not reach the frozen horizon");
  });

  it("uses the largest known cost channel instead of a lower reconciled value", () => {
    const bundle = makeBundle({
      runId: "conservative-cost",
      pairId: "cost-pair",
      scenarioId: "scenario",
      condition: "full-harness",
      strictPass: true,
      estimatedCostMicroUsd: 250_000,
      providerReportedCostMicroUsd: 200_000,
      reconciledCostMicroUsd: 100_000,
    });
    const cost = generateBenchmarkReport(baseInput([bundle])).conditions[0].cost;
    expect(cost).toMatchObject({
      known_total_micro_usd: 250_000,
      cost_per_strict_success_usd: "0.250000",
      source_counts: { estimated: 1, provider_reported: 0, reconciled: 0 },
    });
  });

  it("neutralizes raw HTML and Markdown delimiters in human-readable labels", () => {
    const bundle = makeBundle({
      runId: "markdown-safety",
      pairId: "markdown-pair",
      scenarioId: "scenario",
      provider: "openai",
      model: "model<script>`unsafe`",
      condition: "raw-memory",
      strictPass: false,
    });
    const markdown = renderBenchmarkReportMarkdown(generateBenchmarkReport(baseInput([bundle])));
    expect(markdown).toContain("model&lt;script&gt;&#96;unsafe&#96;");
    expect(markdown).not.toContain("<script>");
  });

  it("rejects a score whose declared hash or source binding is forged", () => {
    const original = makeBundle({ runId: "forged-score", pairId: "pair", scenarioId: "scenario", condition: "raw-memory", strictPass: true });
    const badHash: BenchmarkRunBundle = {
      ...original,
      score: original.score && { ...original.score, sha256: "0".repeat(64) },
    };
    const badHashReport = generateBenchmarkReport(baseInput([badHash]));
    expect(badHashReport.data_quality.artifact_class_counts).toEqual({ score_hash_mismatch: 1 });
    expect(badHashReport.conditions[0].strict_success.rate).toBe(0);

    const parsed = JSON.parse(String(original.score!.content)) as RunScoreArtifact;
    const forged = `${JSON.stringify({ ...parsed, source_manifest_hash: "1".repeat(64) })}\n`;
    const badBinding: BenchmarkRunBundle = {
      ...original,
      score: {
        path: "evaluation/score.json",
        content: forged,
        sha256: sha256Hex(forged),
        attestation: original.score!.attestation,
      },
    };
    const badBindingReport = generateBenchmarkReport(baseInput([badBinding]));
    expect(badBindingReport.data_quality.artifact_class_counts).toEqual({ score_binding_mismatch: 1 });
  });

  it("fails safely on resource abuse, malformed bundles, overlapping trust roles, and confirmatory artifact imputation", () => {
    expect(() => generateBenchmarkReport({
      ...baseInput([]),
      bundles: [null as unknown as BenchmarkRunBundle],
    })).toThrow(/bundles\[0\] must be an object/);
    expect(() => makeBundle({
      runId: "huge-latency",
      pairId: "huge-latency",
      scenarioId: "scenario",
      condition: "raw-memory",
      strictPass: false,
      firstAudioMs: 1e308,
    })).toThrow(/expected number to be <=10000000/);
    expect(() => generateBenchmarkReport({
      ...baseInput([]),
      trusted_evaluator_keys: { [REGISTRATION_KEY_ID]: REGISTRATION_PUBLIC_PEM },
    })).toThrow(/trust stores must be cryptographically disjoint/);
    expect(() => generateBenchmarkReport({
      ...baseInput([]),
      trusted_evaluator_keys: { [KERNEL_KEY_ID]: KERNEL_PUBLIC_PEM },
    })).toThrow(/trust stores must be cryptographically disjoint/);

    const body: ClaimRegistrationBody = {
      status: "frozen",
      registration_id: "no-imputation",
      analysis_plan_hash: ANALYSIS_HASH,
      freeze_lock_hash: FREEZE_LOCK_HASH,
      plan_hash: PLAN_HASH,
      frozen_at: "2026-07-10T11:00:00.000Z",
      freeze_ref: "refs/tags/no-imputation",
      registration_attestation_key_id: REGISTRATION_KEY_ID,
      registration_attestation_public_key_sha256: REGISTRATION_PUBLIC_FINGERPRINT,
      evaluator_attestation_key_id: EVALUATOR_KEY_ID,
      evaluator_attestation_public_key_sha256: EVALUATOR_PUBLIC_FINGERPRINT,
      kernel_attestation_key_id: KERNEL_KEY_ID,
      kernel_attestation_public_key_sha256: KERNEL_PUBLIC_FINGERPRINT,
      kernel_build_sha256: KERNEL_BUILD_HASH,
      protocol_id: "HACC-LHVR-v0.1",
      evaluator_version_hash: EVALUATOR_HASH,
      baseline_condition: "raw-memory",
      treatment_condition: "full-harness",
      confidence_level: 0.95,
      reliable_horizon_thresholds: [0.9, 0.95],
      bootstrap_iterations: 500,
      seed: "synthetic-seed",
      expected_pairs: [{
        pair_id: "pair",
        provider: "openai",
        model: "gpt-realtime-test",
        scenario_id: "scenario",
        scenario_version: "1.0.0",
        baseline_run_id: "raw",
        treatment_run_id: "harness",
        baseline_execution_plan_sha256: executionPlanSha256("raw", "raw-memory"),
        treatment_execution_plan_sha256: executionPlanSha256("harness", "full-harness"),
        pair_invariants_hash: pairInvariantsHash("pair", "scenario", "openai", "gpt-realtime-test"),
      }],
      minimum_complete_pairs_per_stratum: 1,
      minimum_scenario_clusters_per_stratum: 1,
      provider_weights: { [benchmarkProviderStratumKey("openai", "gpt-realtime-test")]: 1 },
      minimally_important_strict_risk_difference: 0,
      allow_fail_closed_artifact_endpoints: true,
      claim_multiplicity: { strategy: "primary_only", primary_endpoint: "strict_success" },
    };
    expect(() => generateBenchmarkReport({
      ...baseInput([]),
      phase: "confirmatory",
      registration: attestRegistration(body),
    })).toThrow(/fail-closed artifact endpoints are descriptive only/);

    expect(() => generateBenchmarkReport({
      ...baseInput([]),
      phase: "confirmatory",
      registration: attestRegistration({
        ...body,
        allow_fail_closed_artifact_endpoints: false,
        expected_pairs: [
          body.expected_pairs[0],
          {
            ...body.expected_pairs[0],
            pair_id: "pair-two",
            treatment_run_id: "harness-two",
            pair_invariants_hash: pairInvariantsHash("pair-two", "scenario", "openai", "gpt-realtime-test"),
          },
        ],
      }),
    })).toThrow(/duplicate registered run ID: raw/);
  });
});
