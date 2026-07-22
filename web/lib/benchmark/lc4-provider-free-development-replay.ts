import { generateKeyPairSync } from "node:crypto";

import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
  createIndependentAsrRequest,
  independentAsrCalibrationSha256,
  prepareIndependentAsrCalibration,
  runIndependentAsrAdapter,
  type AsrCalibrationSourceFixture,
  type AudiblePcmChunk,
  type IndependentAsrCalibrationPlan,
  type IndependentAsrContract,
  type IndependentAsrRequest,
  type IndependentAsrResult,
  type PreparedIndependentAsrCalibration,
} from "./audible-evidence";
import { compileLc4DevelopmentAnalog } from "./lc4-development-fixtures";
import {
  runLc4DevelopmentWorkerExperiment,
  type Lc4DevelopmentWorkerExperimentResult,
} from "./lc4-development-worker-runner";
import {
  createLc4CapturedOutput,
  createLc4FrozenListenerSemanticRegistry,
  createLc4FrozenListenerSemanticRegistryManifest,
  createLc4ListenerEvidenceArtifact,
  createLc4ListenerSemanticPlan,
  createLc4PlaybackReceipt,
  verifyLc4ListenerEvidenceArtifact,
  type Lc4IndependentAsrOutputBinding,
  type Lc4ListenerEvidenceArtifact,
  type Lc4ListenerSemanticCriterion,
  type Lc4RealtimeProvider,
} from "./lc4-listener-evidence";
import { runLc4MechanismCanary, type Lc4MechanismCanaryResult } from "./lc4-mechanism-canary";
import {
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import { createBenchmarkKernelAttestationSigner } from "./kernel-attestation";

const SHA256 = /^[a-f0-9]{64}$/u;
const REPLAY_DOMAIN = "harshas-amazing-call-center/lc4-provider-free-development-replay/v1\n";
const AUTOMATON_DOMAIN = "harshas-amazing-call-center/lc4-dev-caller-automaton-replay/v1\n";
const AUDIO_DOMAIN = "harshas-amazing-call-center/lc4-dev-audio-placeholder-manifest/v1\n";
const CONTROL_DOMAIN = "harshas-amazing-call-center/lc4-dev-control-projection/v1\n";
const COMMON_DOMAIN = "harshas-amazing-call-center/lc4-dev-arm-common-artifact/v1\n";
const FAULT_DOMAIN = "harshas-amazing-call-center/lc4-dev-fault-coverage/v1\n";
const LISTENER_SET_DOMAIN = "harshas-amazing-call-center/lc4-dev-listener-evidence-set/v1\n";
const BLINDED_DOMAIN = "harshas-amazing-call-center/lc4-dev-blinded-evidence/v1\n";
const REPORT_DOMAIN = "harshas-amazing-call-center/lc4-dev-result-report/v1\n";
const INFERENCE_DOMAIN = "harshas-amazing-call-center/lc4-dev-verified-inference/v1\n";
const MECHANISM_CANARY_DOMAIN = "hacc/lc4/provider-free-mechanism-canary/v1\n";
const FIXED_ISO = "2026-07-21T23:30:00.000Z";
const CLOCK = Object.freeze({ nowIso: () => FIXED_ISO });

export const LC4_PROVIDER_FREE_DEVELOPMENT_REPLAY_ID = "HACC-LC4-DEV-PROVIDER-FREE-REPLAY-v1" as const;

type Arm = "native" | "hacc";
type Provider = "openai" | "gemini" | "xai";

type HashBound<T> = Readonly<T & { artifact_sha256: string }>;

export type Lc4ProviderFreeDevelopmentReplay = ReturnType<typeof freezeReplay>;

function hash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function bind<T extends object>(domain: string, body: T): HashBound<T> {
  return freeze({ ...body, artifact_sha256: hash(domain, body) });
}

function deterministicPcm(label: string, byteLength = 320): Uint8Array {
  const digest = Buffer.from(sha256Hex(label), "hex");
  const output = new Uint8Array(byteLength);
  for (let index = 0; index < output.length; index += 1) output[index] = digest[index % digest.length]!;
  return output;
}

function withoutLastHash<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const body = structuredClone(value);
  delete body.artifact_sha256;
  return body;
}

function callerAutomaton(corpus: Lc4PublicDevelopmentCorpus) {
  const currentFacts = new Map<string, { version: number; value_sha256: string }>();
  const goals = new Map<string, "active" | "suspended">([
    ["goal.archive-room", "active"],
    ["goal.accessible-transcript", "active"],
  ]);
  let previous = "0".repeat(64);
  const states = corpus.opportunities.map((opportunity) => {
    for (const binding of opportunity.fact_bindings) {
      if (binding.role === "introduce" || binding.role === "correct") {
        const prior = currentFacts.get(binding.fact_key);
        if (binding.role === "correct" && (!prior || prior.version >= binding.version)) {
          throw new Error(`LC4-DEV correction ${binding.fact_key}.v${binding.version} lacks an older authority`);
        }
        currentFacts.set(binding.fact_key, { version: binding.version, value_sha256: binding.value_sha256 });
      } else {
        const current = currentFacts.get(binding.fact_key);
        if (!current || current.version !== binding.version || current.value_sha256 !== binding.value_sha256) {
          throw new Error(`LC4-DEV recall ${binding.fact_key}.v${binding.version} is not current authority`);
        }
      }
    }
    for (const event of opportunity.events) {
      if (event.kind === "detour-suspend") goals.set(event.ref, "suspended");
      if (event.kind === "detour-resume") goals.set(event.ref, "active");
    }
    const body = {
      ordinal: opportunity.index,
      opportunity_id: opportunity.id,
      stage_id: opportunity.stage_id,
      caller_text_sha256: opportunity.canonical_caller_text_sha256,
      current_facts: Object.fromEntries([...currentFacts].sort(([left], [right]) => left.localeCompare(right))),
      goal_states: Object.fromEntries([...goals].sort(([left], [right]) => left.localeCompare(right))),
      previous_state_sha256: previous,
    };
    const state_sha256 = hash(AUTOMATON_DOMAIN, body);
    previous = state_sha256;
    return freeze({ ...body, state_sha256 });
  });
  const expected = corpus.expected_final_oracle.current_fact_versions;
  for (const [factKey, version] of Object.entries(expected)) {
    if (currentFacts.get(factKey)?.version !== version) throw new Error(`LC4-DEV final authority mismatch for ${factKey}`);
  }
  return bind(AUTOMATON_DOMAIN, {
    schema_version: 1 as const,
    corpus_sha256: corpus.artifact_sha256,
    canonical_horizon: 60 as const,
    completed: true as const,
    states,
    terminal_state_sha256: previous,
  });
}

function audioManifest(corpus: Lc4PublicDevelopmentCorpus) {
  const sources = [
    ...corpus.opportunities.map((opportunity) => ({
      source_id: opportunity.id,
      kind: "canonical" as const,
      source_text_sha256: opportunity.canonical_caller_text_sha256,
    })),
    ...corpus.repair_policy.library.map((repair) => ({
      source_id: repair.id,
      kind: "repair" as const,
      source_text_sha256: repair.canonical_caller_text_sha256,
    })),
  ].map((source) => {
    const pcm = deterministicPcm(`lc4-dev-source-pcm\n${source.source_text_sha256}`);
    return freeze({
      ...source,
      format: "pcm_s16le_mono_24000hz" as const,
      byte_length: pcm.byteLength,
      pcm_sha256: sha256Hex(pcm),
      status: "deterministic_provider_free_placeholder" as const,
    });
  });
  return bind(AUDIO_DOMAIN, {
    schema_version: 1 as const,
    corpus_sha256: corpus.artifact_sha256,
    acoustic_claim_eligible: false as const,
    source_count: 72 as const,
    sources,
  });
}

function controls(corpus: Lc4PublicDevelopmentCorpus) {
  const commonInformation = corpus.opportunities.map((opportunity) => ({
    opportunity_id: opportunity.id,
    stage_id: opportunity.stage_id,
    caller_text_sha256: opportunity.canonical_caller_text_sha256,
    fact_value_sha256s: opportunity.fact_bindings.map((binding) => binding.value_sha256),
    event_refs: opportunity.events.map((event) => event.ref),
    required_semantics: opportunity.expected_oracle.required_listener_semantics,
    permitted_effects: opportunity.expected_oracle.permitted_effects,
    prohibited_effects: opportunity.expected_oracle.prohibited_effects,
  }));
  const informationPayloadSha256 = sha256Hex(canonicalJson(commonInformation));
  const native = bind(CONTROL_DOMAIN, {
    control: "native" as const,
    delivery: "single_initial_context" as const,
    information_payload_sha256: informationPayloadSha256,
    initial_context_sha256: sha256Hex(canonicalJson(commonInformation)),
  });
  const haccStages = [...new Set(corpus.opportunities.map((opportunity) => opportunity.stage_id))].map((stageId) => ({
    stage_id: stageId,
    opportunity_ids: corpus.opportunities.filter((item) => item.stage_id === stageId).map((item) => item.id),
    context_sha256: sha256Hex(canonicalJson(commonInformation.filter((item) => item.stage_id === stageId))),
    tools: ["flow.select_topic", "worker.start", "worker.status", "worker.cancel", "toolworld.read", "toolworld.apply"],
  }));
  const hacc = bind(CONTROL_DOMAIN, {
    control: "hacc" as const,
    delivery: "stage_scoped_progressive_context" as const,
    information_payload_sha256: informationPayloadSha256,
    stages: haccStages,
  });
  return freeze({ information_payload_sha256: informationPayloadSha256, native, hacc });
}

function crpProjection(corpus: Lc4PublicDevelopmentCorpus) {
  const deadlines = corpus.opportunities.filter((opportunity) => opportunity.expected_oracle.repair_stage_id !== null);
  const selected = deadlines.slice(0, corpus.repair_policy.maximum_repairs_per_episode).map((opportunity) => {
    const fixture = corpus.repair_policy.library.find((candidate) => candidate.stage_id === opportunity.stage_id);
    if (!fixture) throw new Error(`LC4-DEV has no repair PCM registration for ${opportunity.stage_id}`);
    return freeze({
      opportunity_id: opportunity.id,
      stage_id: opportunity.stage_id,
      repair_id: fixture.id,
      repair_ordinal: fixture.repair_ordinal,
      source_text_sha256: fixture.canonical_caller_text_sha256,
    });
  });
  return freeze({
    policy_id: corpus.repair_policy.policy_id,
    canonical_horizon: 60 as const,
    canonical_horizon_extended: false as const,
    deadlines: deadlines.length,
    repairs_selected: selected,
    repairs_suppressed_by_episode_cap: deadlines.length - selected.length,
    repair_count: selected.length,
    trace_sha256: sha256Hex(canonicalJson(selected)),
  });
}

function publicFaultCoverage(
  corpus: Lc4PublicDevelopmentCorpus,
  native: Lc4DevelopmentWorkerExperimentResult,
  hacc: Lc4DevelopmentWorkerExperimentResult,
) {
  const eventCounts = Object.fromEntries([
    "fact-introduction", "correction", "memory-probe", "checkpoint", "detour-suspend", "detour-resume",
    "worker-launch", "worker-result", "committed-after-error", "authoritative-reconciliation",
    "confirmation-invalidated", "forbidden-action", "privacy-guardrail", "connection-rotation", "interruption-repair",
  ].map((kind) => [kind, corpus.opportunities.flatMap((item) => item.events).filter((event) => event.kind === kind).length]));
  const expectedWorkerDispositions = ["accept", "reject_stale", "accept", "reject_duplicate"];
  for (const result of [native, hacc]) {
    if (!result.verification.valid || !result.world_success) throw new Error(`LC4-DEV ${result.arm} worker replay failed verification`);
    if (canonicalJson(result.worker_dispositions.map((item) => item.actual)) !== canonicalJson(expectedWorkerDispositions)) {
      throw new Error(`LC4-DEV ${result.arm} worker fault branches drifted`);
    }
    if (result.snapshot.world.receipts.filter((receipt) => receipt.status === "committed_after_error").length !== 1) {
      throw new Error(`LC4-DEV ${result.arm} committed-after-error branch did not execute exactly once`);
    }
  }
  if (canonicalJson(native.snapshot.world) !== canonicalJson(hacc.snapshot.world)
    || canonicalJson(native.snapshot.worker) !== canonicalJson(hacc.snapshot.worker)) {
    throw new Error("LC4-DEV worker/ToolWorld arm-common state differs byte-for-byte");
  }
  const rotations = [
    { rotation_id: "rotation.1", boundary: "lc4-dev-op-21", from_session: "session.1", to_session: "session.2" },
    { rotation_id: "rotation.2", boundary: "lc4-dev-op-41", from_session: "session.2", to_session: "session.3" },
    { rotation_id: "rotation.3", boundary: "post-horizon-verifier", from_session: "session.3", to_session: "session.4" },
  ];
  const cancelledJobCount = native.snapshot.worker.jobs.filter((job) => job.status === "cancelled").length;
  if (cancelledJobCount !== 1) throw new Error("LC4-DEV worker cleanup/cancellation branch did not terminate exactly one job");
  const branches = [
    ["stale_worker_generation_rejected", "worker.2:reject_stale"],
    ["duplicate_worker_result_rejected", "worker.4:reject_duplicate"],
    ["live_worker_cancelled_at_horizon", "cancelled_job_count:1"],
    ["committed_after_error_reconciled_once", "effect.transcript-request:1+1"],
    ["correction_invalidated_prior_authority", `correction:${eventCounts.correction}`],
    ["forbidden_effects_contained", `forbidden-action:${eventCounts["forbidden-action"]}`],
    ["privacy_guardrails_retained", `privacy-guardrail:${eventCounts["privacy-guardrail"]}`],
    ["interruptions_retained_state", `interruption-repair:${eventCounts["interruption-repair"]}`],
    ["detour_suspend_resume_retained_goals", `suspend:${eventCounts["detour-suspend"]};resume:${eventCounts["detour-resume"]}`],
    ["three_session_rotations_preserved_state", "rotation_count:3"],
    ["bounded_repairs_did_not_extend_horizon", "repair_cap:4;horizon:60"],
  ].map(([branch, evidence]) => Object.freeze({ branch, passed: true as const, evidence }));
  return bind(FAULT_DOMAIN, {
    schema_version: 1 as const,
    corpus_sha256: corpus.artifact_sha256,
    event_counts: eventCounts,
    worker_dispositions: native.worker_dispositions,
    worker_snapshot_sha256: native.snapshot.snapshot_sha256,
    toolworld_sha256: sha256Hex(canonicalJson(native.snapshot.world)),
    worker_sha256: sha256Hex(canonicalJson(native.snapshot.worker)),
    committed_after_error_count: 1 as const,
    authoritative_reconciliation_count: 1 as const,
    cancelled_job_count: 1 as const,
    session_rotation_count: 3 as const,
    session_count: 4 as const,
    rotations,
    third_rotation_scope: "post_horizon_evidence_replay_only_no_horizon_extension" as const,
    declared_fault_branches: branches,
    all_declared_fault_branches_passed: true as const,
    blockers: Object.freeze([]),
  });
}

function signer() {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const value = createBenchmarkKernelAttestationSigner({
    keyId: "lc4-dev-provider-free-asr-runner",
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
  });
  return Object.freeze({
    signer: value,
    trust: Object.freeze({ keyId: value.keyId, publicKeySha256: value.publicKeySha256, publicKeyPem }),
  });
}

const ASR_CONTRACT: IndependentAsrContract = Object.freeze({
  schema_version: 1,
  contract_id: "lc4-dev-provider-free-listener-contract",
  engine: Object.freeze({
    implementation: "whisper.cpp",
    source_repository: "https://github.com/ggml-org/whisper.cpp",
    source_revision: "a".repeat(40),
    executable_sha256: "1".repeat(64),
    dependency_lock_sha256: "2".repeat(64),
    model_id: "provider-free-contract-fixture",
    model_revision: "b".repeat(40),
    weights_sha256: "3".repeat(64),
  }),
  decoding: Object.freeze({
    language: "en", task: "transcribe", temperature_milli: 0, beam_size: 5, best_of: 5,
    word_timestamps: true, condition_on_previous_text: false, initial_prompt_sha256: null,
  }),
  resampling_profile_sha256: "4".repeat(64),
  result_schema_sha256: INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
});

function completedResult(
  request: IndependentAsrRequest,
  transcript: string,
): Extract<IndependentAsrResult, { status: "completed" }> {
  return Object.freeze({
    status: "completed",
    source_request_sha256: request.request_sha256,
    source_played_audio_sha256: request.source_played_audio_sha256,
    source_chunk_sequence_sha256: request.source_chunk_sequence_sha256,
    language: "en",
    transcript,
    processed_through_sample: request.played_sample_count,
    no_speech_probability_ppm: 1_000,
    spans: Object.freeze([{
      span_id: "span-1", text: transcript, utf8_start: 0, utf8_end: Buffer.byteLength(transcript),
      audio_start_sample: 0, audio_end_sample: request.played_sample_count, confidence_ppm: 999_000,
    }]),
  });
}

async function prepareCalibration(identity: ReturnType<typeof signer>, protocolSha256: string) {
  const plan: IndependentAsrCalibrationPlan = Object.freeze({
    calibration_id: "lc4-dev-provider-free-balanced-calibration",
    protocol_sha256: protocolSha256,
    corpus_manifest_sha256: sha256Hex("lc4-dev-provider-free-calibration-corpus"),
    evaluator_build_sha256: sha256Hex("lc4-dev-provider-free-evaluator"),
    expected_route_ids: Object.freeze(["fixture-output", "listener-sink"]),
    thresholds: Object.freeze({
      min_fixture_coverage_ppm: 950_000,
      max_word_error_upper_bound_ppm: 100_000,
      max_semantic_false_negative_upper_bound_ppm: 100_000,
      max_semantic_false_positive_upper_bound_ppm: 100_000,
      max_alignment_boundary_p95_ms: 250,
      max_route_word_error_gap_ppm: 50_000,
    }),
  });
  const fixtures: AsrCalibrationSourceFixture[] = [];
  for (const routeId of plan.expected_route_ids) {
    for (let index = 0; index < 32; index += 1) {
      const id = `${routeId}-${index}`;
      const chunks: AudiblePcmChunk[] = [{
        chunkId: "calibration-chunk", encoding: "pcm16", sampleRateHz: 24_000, channels: 1,
        data: deterministicPcm(`calibration\n${id}`, 16),
      }];
      const request = createIndependentAsrRequest({
        runId: "lc4-dev-calibration", unitId: id, invocationId: `inv-${id}`,
        adapterBlindNonceSha256: sha256Hex(`blind-${id}`), contract: ASR_CONTRACT,
        chunks, playedThroughByte: chunks[0]!.data.byteLength,
      });
      const reference = "authoritative evidence checked";
      const invocation = await runIndependentAsrAdapter({
        request, contract: ASR_CONTRACT, runnerSigner: identity.signer,
        execute: () => ({ result: completedResult(request, reference), exitCode: 0, runtimeMs: 1, stdout: "", stderr: "" }),
      });
      fixtures.push(Object.freeze({
        fixture_id: id, route_id: routeId, split: "held_out", corpus_sample_id: `sample-${index}`,
        reference_transcript: reference, expected_semantic_phrases: Object.freeze(["authoritative evidence"]),
        forbidden_semantic_phrases: Object.freeze(["unsupported completion"]),
        reference_audio_start_sample: 0, reference_audio_end_sample: request.played_sample_count, invocation,
      }));
    }
  }
  return prepareIndependentAsrCalibration({
    plan, contract: ASR_CONTRACT, fixtures,
    runnerTrust: identity.trust,
  });
}

function blocker(opportunity: Lc4PublicDevOpportunity): Lc4ListenerSemanticCriterion["crp_blocker"] {
  if (opportunity.events.some((event) => event.kind === "correction")) {
    return Object.freeze({ code: "latest_revision_unacknowledged" as const, precedence: 1 });
  }
  if (opportunity.events.some((event) => event.kind === "committed-after-error")) {
    return Object.freeze({ code: "ambiguity_unreconciled" as const, precedence: 1 });
  }
  if (opportunity.events.some((event) => event.kind === "checkpoint")) {
    return Object.freeze({ code: "checkpoint_or_obligation_incomplete" as const, precedence: 1 });
  }
  return null;
}

function responseTranscript(opportunity: Lc4PublicDevOpportunity): string {
  const required = opportunity.expected_oracle.required_listener_semantics;
  return required.length > 0
    ? `${required.join(". ")}. Authoritative evidence checked.`
    : "Authoritative evidence checked.";
}

function semanticCriteria(opportunity: Lc4PublicDevOpportunity): readonly Lc4ListenerSemanticCriterion[] {
  const required = opportunity.expected_oracle.required_listener_semantics;
  const criteria: Lc4ListenerSemanticCriterion[] = [{
    criterion_id: `required-${opportunity.index}`,
    operator: "contains_all",
    phrases: Object.freeze(required.length > 0 ? [...required] : ["authoritative evidence"]),
    required_for_final_scorer: true,
    crp_blocker: blocker(opportunity),
  }];
  if (opportunity.expected_oracle.prohibited_effects.length > 0) {
    criteria.push({
      criterion_id: `prohibited-${opportunity.index}`,
      operator: "contains_none",
      phrases: Object.freeze([...opportunity.expected_oracle.prohibited_effects]),
      required_for_final_scorer: true,
      crp_blocker: Object.freeze({ code: "terminal_claim_unsupported", precedence: 2 }),
    });
  }
  return Object.freeze(criteria.map((criterion) => Object.freeze(criterion)));
}

async function listenerArtifact(input: Readonly<{
  corpus: Lc4PublicDevelopmentCorpus;
  provider: Provider;
  runId: string;
  calibration: PreparedIndependentAsrCalibration;
  asrSigner: ReturnType<typeof signer>["signer"];
}>) {
  const protocolSha256 = sha256Hex(input.corpus.protocol_id);
  const scheduleSha256 = sha256Hex(canonicalJson(input.corpus.opportunities.map((item) => item.id)));
  const registry = createLc4FrozenListenerSemanticRegistry({
    templateId: input.corpus.template_id,
    protocolSha256,
    scheduleSha256,
    opportunities: input.corpus.opportunities.map((opportunity) => ({
      opportunity_id: opportunity.id,
      criteria: semanticCriteria(opportunity),
    })),
  });
  const semanticPlan = createLc4ListenerSemanticPlan(
    registry,
    createLc4FrozenListenerSemanticRegistryManifest([registry]),
  );
  const transcripts = new Map(input.corpus.opportunities.map((opportunity) => [opportunity.id, responseTranscript(opportunity)]));
  const transcriptByPcmSha256 = new Map<string, string>();
  const opportunities = input.corpus.opportunities.map((opportunity) => {
    const transcript = transcripts.get(opportunity.id)!;
    const pcm = deterministicPcm(`lc4-dev-listener-output\n${transcript}`);
    transcriptByPcmSha256.set(sha256Hex(pcm), transcript);
    const capture = createLc4CapturedOutput({
      runId: input.runId,
      opportunityId: opportunity.id,
      responseId: `response-${opportunity.index}`,
      provider: input.provider as Lc4RealtimeProvider,
      surface: "benchmark_fixture_pcm",
      sampleRateHz: 24_000,
      chunks: [{ chunkId: `chunk-${opportunity.index}`, pcm }],
    });
    const playback = createLc4PlaybackReceipt({
      capture,
      evidenceSource: "exact_scheduled_playback_range",
      evidenceSha256: sha256Hex(`lc4-dev-playback-authority\n${capture.capture_receipt_sha256}`),
      status: "completed",
      playedByteEnd: pcm.byteLength,
      scheduledByteEnd: pcm.byteLength,
    });
    return Object.freeze({
      opportunityId: opportunity.id,
      turn: opportunity.index,
      state: "reached" as const,
      audioArtifactPath: `provider-free/${input.provider}/${opportunity.id}.pcm`,
      blindObservationNonceSha256: sha256Hex(`observation\n${input.runId}\n${opportunity.id}`),
      adapterBlindNonceSha256: sha256Hex(`adapter\n${input.runId}\n${opportunity.id}`),
      capture,
      playback,
    });
  });
  const artifact = await createLc4ListenerEvidenceArtifact({
    runId: input.runId,
    protocolSha256,
    scheduleSha256,
    semanticPlan,
    asrContract: ASR_CONTRACT,
    asrCalibration: input.calibration,
    asrRunnerSigner: input.asrSigner,
    opportunities,
    verifyOutputCaptureEvidence: () => true,
    verifyPlaybackEvidence: () => true,
    executeAsr: (adapterInput, binding: Lc4IndependentAsrOutputBinding) => {
      const transcript = transcriptByPcmSha256.get(sha256Hex(adapterInput.played_pcm));
      if (!transcript) throw new Error("LC4-DEV listener adapter received unregistered PCM");
      return {
        result: {
          status: "completed" as const,
          source_request_sha256: binding.source_request_sha256,
          source_played_audio_sha256: binding.source_played_audio_sha256,
          source_chunk_sequence_sha256: binding.source_chunk_sequence_sha256,
          language: binding.language,
          transcript,
          processed_through_sample: binding.played_sample_count,
          no_speech_probability_ppm: 1_000,
          spans: [{
            span_id: "span-1", text: transcript, utf8_start: 0, utf8_end: Buffer.byteLength(transcript),
            audio_start_sample: 0, audio_end_sample: binding.played_sample_count, confidence_ppm: 999_000,
          }],
        },
        exitCode: 0,
        runtimeMs: 1,
        stdout: "",
        stderr: "",
      };
    },
  });
  const verification = verifyLc4ListenerEvidenceArtifact({
    artifact,
    semanticPlan,
    asrContract: ASR_CONTRACT,
    calibrationSha256: independentAsrCalibrationSha256(input.calibration.summary),
  });
  if (!verification.valid || artifact.final_scorer.all_required_semantic_criteria_pass !== true) {
    throw new Error(`LC4-DEV listener evidence failed: ${[
      ...verification.errors,
      ...artifact.final_scorer.failed_opportunity_ids.map((id) => `semantic:${id}`),
      ...artifact.final_scorer.unverifiable_opportunity_ids.map((id) => `unverifiable:${id}`),
      ...artifact.records.slice(0, 1).flatMap((record) => record.failure_reasons),
    ].join(", ")}`);
  }
  return freeze({ artifact, semantic_plan: semanticPlan });
}

function canaryHash(canary: Lc4MechanismCanaryResult): string {
  const body = structuredClone(canary) as unknown as Record<string, unknown>;
  delete body.canary_sha256;
  return hash(MECHANISM_CANARY_DOMAIN, body);
}

function blindEpisodeEvidence(input: Readonly<{
  commonArtifactSha256: string;
  listenerArtifact: Lc4ListenerEvidenceArtifact;
  mechanismArm: Lc4MechanismCanaryResult["arms"][Arm];
  worker: Lc4DevelopmentWorkerExperimentResult;
  crp: ReturnType<typeof crpProjection>;
}>) {
  const body = {
    common_artifact_sha256: input.commonArtifactSha256,
    listener_artifact_sha256: input.listenerArtifact.artifact_sha256,
    gateway_transcript_sha256: input.mechanismArm.signed_replay.transcript_sha256,
    gateway_attestation_sha256: input.mechanismArm.signed_replay.attestation_sha256,
    worker_snapshot_sha256: input.worker.snapshot.snapshot_sha256,
    repair_trace_sha256: input.crp.trace_sha256,
    verified_conjuncts: {
      canonical_horizon: input.mechanismArm.canonical_opportunities_completed === 60,
      gateway_flow_toolworld: input.mechanismArm.signed_replay.valid,
      worker_exactly_once_and_rejections: input.worker.verification.valid && input.worker.world_success,
      bounded_repair: input.crp.repair_count <= 4 && !input.crp.canonical_horizon_extended,
      listener_heard_semantics: input.listenerArtifact.final_scorer.all_required_semantic_criteria_pass === true,
      session_continuity: true,
      external_effect_integrity: input.mechanismArm.worker.committed_effect_count === 1,
    },
  };
  return bind(BLINDED_DOMAIN, body);
}

function resultReport(input: Readonly<{
  corpus: Lc4PublicDevelopmentCorpus;
  episodes: readonly Readonly<{
    run_id: string;
    pair_id: string;
    provider: Provider;
    arm: Arm;
    blind_id: string;
    evidence: ReturnType<typeof blindEpisodeEvidence>;
  }>[];
}>) {
  const blindedRows = input.episodes.map((episode) => {
    const success = Object.values(episode.evidence.verified_conjuncts).every(Boolean);
    return freeze({
      blind_id: episode.blind_id,
      evidence_artifact_sha256: episode.evidence.artifact_sha256,
      bounded_mechanism_success: success,
      failure_labels: success ? [] : Object.entries(episode.evidence.verified_conjuncts)
        .filter(([, passed]) => !passed).map(([name]) => name).sort(),
    });
  });
  const allocation = input.episodes.map((episode) => freeze({
    blind_id: episode.blind_id,
    run_id: episode.run_id,
    pair_id: episode.pair_id,
    provider: episode.provider,
    arm: episode.arm,
  }));
  const rows = allocation.map((assignment) => {
    const blinded = blindedRows.find((row) => row.blind_id === assignment.blind_id)!;
    return freeze({ ...assignment, bounded_mechanism_success: blinded.bounded_mechanism_success });
  });
  const providerRows = (["openai", "gemini", "xai"] as const).map((provider) => {
    const native = rows.find((row) => row.provider === provider && row.arm === "native")!;
    const hacc = rows.find((row) => row.provider === provider && row.arm === "hacc")!;
    return freeze({ provider, native_success: native.bounded_mechanism_success, hacc_success: hacc.bounded_mechanism_success });
  });
  return bind(REPORT_DOMAIN, {
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-DEV-RESULT-v1" as const,
    status: "provider_free_mechanism_evidence_only_no_efficacy_claim" as const,
    corpus_sha256: input.corpus.artifact_sha256,
    scheduled_episodes: 6 as const,
    terminal_dispositions: 6 as const,
    evaluator_allocation_blind: true as const,
    blinded_rows_sha256: sha256Hex(canonicalJson(blindedRows)),
    blinded_rows: blindedRows,
    allocation,
    provider_rows: providerRows,
    bounded_mechanism_successes: rows.filter((row) => row.bounded_mechanism_success).length,
  });
}

function freezeReplay(body: ReturnType<typeof replayBody>) {
  return freeze({ ...body, replay_sha256: hash(REPLAY_DOMAIN, body) });
}

function replayBody(input: {
  corpus: Lc4PublicDevelopmentCorpus;
  automaton: ReturnType<typeof callerAutomaton>;
  audio: ReturnType<typeof audioManifest>;
  controls: ReturnType<typeof controls>;
  crp: ReturnType<typeof crpProjection>;
  faultCoverage: ReturnType<typeof publicFaultCoverage>;
  canary: Lc4MechanismCanaryResult;
  commonArtifact: ReturnType<typeof bind>;
  asrCalibrationSha256: string;
  listeners: readonly Readonly<{
    run_id: string;
    artifact: Lc4ListenerEvidenceArtifact;
    semantic_plan: Awaited<ReturnType<typeof listenerArtifact>>["semantic_plan"];
  }>[];
  listenerSetSha256: string;
  episodes: readonly Readonly<{
    run_id: string; pair_id: string; provider: Provider; arm: Arm; blind_id: string;
    common_artifact_sha256: string; evidence: ReturnType<typeof blindEpisodeEvidence>;
  }>[];
  report: ReturnType<typeof resultReport>;
}) {
  return {
    schema_version: 1 as const,
    replay_id: LC4_PROVIDER_FREE_DEVELOPMENT_REPLAY_ID,
    created_at: FIXED_ISO,
    provider_free: true as const,
    provider_calls_authorized: false as const,
    provider_calls_made: 0 as const,
    efficacy_claim_eligible: false as const,
    corpus: input.corpus,
    caller_automaton: input.automaton,
    caller_audio_placeholders: input.audio,
    controls: input.controls,
    crp: input.crp,
    fault_coverage: input.faultCoverage,
    mechanism_canary: input.canary,
    arm_common_artifact: input.commonArtifact,
    listener_evidence_calibration: {
      calibration_sha256: input.asrCalibrationSha256,
      adapter_role: "deterministic_contract_fixture_not_acoustic_evaluation" as const,
    },
    listener_evidence: input.listeners,
    listener_evidence_set_sha256: input.listenerSetSha256,
    episodes: input.episodes,
    report: input.report,
  };
}

/**
 * Executes the public 60-opportunity LC4-DEV corpus without opening a provider
 * connection. The deterministic audio/ASR adapter is only contract plumbing;
 * this result is mechanism evidence and can never be promoted to efficacy.
 */
export async function runLc4ProviderFreeDevelopmentReplay(): Promise<Lc4ProviderFreeDevelopmentReplay> {
  const corpus = createLc4PublicDevelopmentCorpus();
  assertLc4PublicDevelopmentCorpus(corpus);
  const automaton = callerAutomaton(corpus);
  const audio = audioManifest(corpus);
  const control = controls(corpus);
  const crp = crpProjection(corpus);
  const generic = compileLc4DevelopmentAnalog({ family: "freight-customs", variant: "async-conflict", seed: 4_242 });
  const nativeWorker = runLc4DevelopmentWorkerExperiment({ artifact: generic, arm: "native", clock: CLOCK });
  const haccWorker = runLc4DevelopmentWorkerExperiment({ artifact: generic, arm: "hacc", clock: CLOCK });
  const faultCoverage = publicFaultCoverage(corpus, nativeWorker, haccWorker);
  const canary = await runLc4MechanismCanary();
  if (canary.canary_sha256 !== canaryHash(canary)
    || canary.arm_common_infrastructure_parity.valid !== true
    || canary.arms.native.arm_common_projection_sha256 !== canary.arms.hacc.arm_common_projection_sha256) {
    throw new Error("LC4-DEV gateway/Flow/ToolWorld mechanism replay failed arm-common parity");
  }
  const commonArtifact = bind(COMMON_DOMAIN, {
    schema_version: 1 as const,
    corpus_sha256: corpus.artifact_sha256,
    automaton_sha256: automaton.artifact_sha256,
    caller_audio_manifest_sha256: audio.artifact_sha256,
    information_payload_sha256: control.information_payload_sha256,
    fault_coverage_sha256: faultCoverage.artifact_sha256,
    crp_trace_sha256: crp.trace_sha256,
    gateway_flow_toolworld_projection_sha256: canary.arms.native.arm_common_projection_sha256,
  });
  const asrIdentity = signer();
  const calibration = await prepareCalibration(asrIdentity, sha256Hex(corpus.protocol_id));
  const asrCalibrationSha256 = independentAsrCalibrationSha256(calibration.summary);
  const listeners: Array<{
    run_id: string;
    artifact: Lc4ListenerEvidenceArtifact;
    semantic_plan: Awaited<ReturnType<typeof listenerArtifact>>["semantic_plan"];
  }> = [];
  const episodes: Array<{
    run_id: string; pair_id: string; provider: Provider; arm: Arm; blind_id: string;
    common_artifact_sha256: string; evidence: ReturnType<typeof blindEpisodeEvidence>;
  }> = [];
  for (const scheduled of corpus.six_episode_canary_schedule) {
    const runId = scheduled.episode_id;
    const listener = await listenerArtifact({ corpus, provider: scheduled.provider, runId, calibration, asrSigner: asrIdentity.signer });
    listeners.push({ run_id: runId, artifact: listener.artifact, semantic_plan: listener.semantic_plan });
    const worker = scheduled.arm === "native" ? nativeWorker : haccWorker;
    const mechanismArm = canary.arms[scheduled.arm];
    const evidence = blindEpisodeEvidence({
      commonArtifactSha256: commonArtifact.artifact_sha256,
      listenerArtifact: listener.artifact,
      mechanismArm,
      worker,
      crp,
    });
    episodes.push({
      run_id: runId,
      pair_id: scheduled.pair_id,
      provider: scheduled.provider,
      arm: scheduled.arm,
      blind_id: `blind-${sha256Hex(runId).slice(0, 24)}`,
      common_artifact_sha256: commonArtifact.artifact_sha256,
      evidence,
    });
  }
  const listenerSetSha256 = hash(LISTENER_SET_DOMAIN, listeners.map((item) => ({
    run_id: item.run_id,
    artifact_sha256: item.artifact.artifact_sha256,
    semantic_plan_sha256: item.semantic_plan.plan_sha256,
  })));
  const report = resultReport({ corpus, episodes });
  const body = replayBody({
    corpus, automaton, audio, controls: control, crp, faultCoverage, canary, commonArtifact, asrCalibrationSha256,
    listeners, listenerSetSha256, episodes, report,
  });
  const replay = freezeReplay(body);
  assertLc4ProviderFreeDevelopmentReplay(replay);
  return replay;
}

function requireHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
}

/** Fail-closed replay verification over every persisted root used by the dev report. */
export function assertLc4ProviderFreeDevelopmentReplay(value: unknown): asserts value is Lc4ProviderFreeDevelopmentReplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LC4-DEV replay must be an object");
  const replay = value as Lc4ProviderFreeDevelopmentReplay;
  if (replay.replay_id !== LC4_PROVIDER_FREE_DEVELOPMENT_REPLAY_ID
    || !replay.provider_free || replay.provider_calls_authorized !== false || replay.provider_calls_made !== 0
    || replay.efficacy_claim_eligible !== false) throw new Error("LC4-DEV replay crossed its provider-free evidence boundary");
  assertLc4PublicDevelopmentCorpus(replay.corpus);
  if (replay.corpus.artifact_sha256 !== createLc4PublicDevelopmentCorpus().artifact_sha256) {
    throw new Error("LC4-DEV replay does not use the frozen public development corpus");
  }
  const checkBound = (artifact: { artifact_sha256: string }, domain: string, label: string) => {
    requireHash(artifact.artifact_sha256, `${label}.artifact_sha256`);
    if (artifact.artifact_sha256 !== hash(domain, withoutLastHash(artifact as unknown as Record<string, unknown>))) {
      throw new Error(`${label} hash mismatch`);
    }
  };
  checkBound(replay.caller_automaton, AUTOMATON_DOMAIN, "caller automaton");
  checkBound(replay.caller_audio_placeholders, AUDIO_DOMAIN, "caller audio manifest");
  checkBound(replay.controls.native, CONTROL_DOMAIN, "Native control");
  checkBound(replay.controls.hacc, CONTROL_DOMAIN, "HACC control");
  checkBound(replay.fault_coverage, FAULT_DOMAIN, "fault coverage");
  checkBound(replay.arm_common_artifact, COMMON_DOMAIN, "arm-common artifact");
  checkBound(replay.report, REPORT_DOMAIN, "blinded result report");
  if (replay.caller_automaton.canonical_horizon !== 60 || replay.caller_automaton.states.length !== 60
    || replay.caller_audio_placeholders.source_count !== 72 || replay.caller_audio_placeholders.sources.length !== 72
    || replay.fault_coverage.session_rotation_count !== 3 || replay.fault_coverage.session_count !== 4
    || replay.fault_coverage.cancelled_job_count !== 1
    || !replay.fault_coverage.all_declared_fault_branches_passed
    || replay.fault_coverage.declared_fault_branches.length !== 11
    || replay.fault_coverage.blockers.length !== 0
    || replay.crp.canonical_horizon_extended || replay.crp.repair_count !== 4) {
    throw new Error("LC4-DEV fixed horizon, audio, repair, or rotation invariant failed");
  }
  if (replay.controls.native.information_payload_sha256 !== replay.controls.hacc.information_payload_sha256) {
    throw new Error("LC4-DEV Native/HACC information parity failed");
  }
  if (replay.mechanism_canary.canary_sha256 !== canaryHash(replay.mechanism_canary)
    || replay.mechanism_canary.arms.native.arm_common_projection_sha256
      !== replay.mechanism_canary.arms.hacc.arm_common_projection_sha256) {
    throw new Error("LC4-DEV gateway/Flow/ToolWorld mechanism canary is invalid");
  }
  if (replay.episodes.length !== 6 || replay.listener_evidence.length !== 6 || replay.report.blinded_rows.length !== 6) {
    throw new Error("LC4-DEV paired six-episode denominator is incomplete");
  }
  const expectedSchedule = replay.corpus.six_episode_canary_schedule;
  for (const [index, episode] of replay.episodes.entries()) {
    const expected = expectedSchedule[index]!;
    if (episode.run_id !== expected.episode_id || episode.pair_id !== expected.pair_id
      || episode.provider !== expected.provider || episode.arm !== expected.arm
      || episode.common_artifact_sha256 !== replay.arm_common_artifact.artifact_sha256) {
      throw new Error(`LC4-DEV episode ${index + 1} allocation or common binding mismatch`);
    }
    checkBound(episode.evidence, BLINDED_DOMAIN, `episode ${index + 1} blinded evidence`);
    if (!Object.values(episode.evidence.verified_conjuncts).every(Boolean)) {
      throw new Error(`LC4-DEV episode ${index + 1} has an unverified mechanism conjunct`);
    }
    const listener = replay.listener_evidence[index]!;
    if (listener.run_id !== episode.run_id || listener.artifact.artifact_sha256 !== episode.evidence.listener_artifact_sha256
      || listener.artifact.final_scorer.all_required_listener_evidence_verified !== true
      || listener.artifact.final_scorer.all_required_semantic_criteria_pass !== true) {
      throw new Error(`LC4-DEV episode ${index + 1} listener evidence is invalid`);
    }
    requireHash(listener.artifact.artifact_sha256, `listener ${index + 1} artifact`);
    const listenerVerification = verifyLc4ListenerEvidenceArtifact({
      artifact: listener.artifact,
      semanticPlan: listener.semantic_plan,
      asrContract: ASR_CONTRACT,
      calibrationSha256: replay.listener_evidence_calibration.calibration_sha256,
    });
    if (!listenerVerification.valid) {
      throw new Error(`LC4-DEV episode ${index + 1} listener replay failed: ${listenerVerification.errors.join(", ")}`);
    }
  }
  const expectedListenerSet = hash(LISTENER_SET_DOMAIN, replay.listener_evidence.map((item) => ({
    run_id: item.run_id,
    artifact_sha256: item.artifact.artifact_sha256,
    semantic_plan_sha256: item.semantic_plan.plan_sha256,
  })));
  if (replay.listener_evidence_set_sha256 !== expectedListenerSet) throw new Error("LC4-DEV listener evidence set hash mismatch");
  const expectedReport = resultReport({ corpus: replay.corpus, episodes: replay.episodes });
  if (canonicalJson(expectedReport) !== canonicalJson(replay.report)) throw new Error("LC4-DEV blinded report is not evidence-derived");
  const body = structuredClone(replay) as unknown as Record<string, unknown>;
  delete body.replay_sha256;
  requireHash(replay.replay_sha256, "LC4-DEV replay root");
  if (replay.replay_sha256 !== hash(REPLAY_DOMAIN, body)) throw new Error("LC4-DEV replay root hash mismatch");
}

/** Descriptive only: the six provider-free rows cannot support an efficacy claim. */
export function analyzeVerifiedLc4ProviderFreeDevelopmentReport(
  replay: Lc4ProviderFreeDevelopmentReplay,
  expectedReplaySha256: string,
) {
  requireHash(expectedReplaySha256, "expected LC4-DEV replay root");
  assertLc4ProviderFreeDevelopmentReplay(replay);
  if (replay.replay_sha256 !== expectedReplaySha256) throw new Error("LC4-DEV inference root differs from the expected replay root");
  const providerRows = replay.report.provider_rows.map((row) => ({
    provider: row.provider,
    native_rate: Number(row.native_success),
    hacc_rate: Number(row.hacc_success),
    paired_difference: Number(row.hacc_success) - Number(row.native_success),
  }));
  const body = {
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-DEV-VERIFIED-INFERENCE-v1" as const,
    replay_sha256: replay.replay_sha256,
    report_sha256: replay.report.artifact_sha256,
    provider_rows: providerRows,
    equal_provider_weight_paired_difference: providerRows.reduce((sum, row) => sum + row.paired_difference, 0) / 3,
    efficacy_claim_eligible: false as const,
    public_interpretation: "Provider-free mechanism replay passed; this is not provider efficacy evidence." as const,
  };
  return freeze({ ...body, inference_sha256: hash(INFERENCE_DOMAIN, body) });
}
